'use strict';

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { GoogleGenAI } = require('@google/genai');

const app  = express();
const PORT = process.env.PORT || 3001;
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Gemini AI Client
// ─────────────────────────────────────────────────────────────────────────────
let ai = null;
if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  console.log('[INFO] Gemini AI initialized.');
} else {
  console.warn('[WARN] GEMINI_API_KEY not set. AI features disabled.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus Helpers
// ─────────────────────────────────────────────────────────────────────────────
const METRICS = [
  { name: 'http_requests_total',          query: 'rate(http_requests_total[5m])',             label: 'HTTP Request Rate (req/s)' },
  { name: 'payment_failed_total',         query: 'rate(payment_failed_total[5m])',             label: 'Payment Failure Rate (failures/s)' },
  { name: 'payment_success_total',        query: 'rate(payment_success_total[5m])',            label: 'Payment Success Rate (successes/s)' },
  { name: 'orders_created_total',         query: 'rate(orders_created_total[5m])',             label: 'Order Creation Rate (orders/s)' },
  { name: 'request_duration_p95',         query: 'histogram_quantile(0.95, rate(request_duration_seconds_bucket[5m]))', label: 'P95 Latency (seconds)' },
  { name: 'nodejs_heap_size_used_bytes',  query: 'nodejs_heap_size_used_bytes / 1024 / 1024', label: 'Node.js Heap Usage (MB)' },
];

async function queryPrometheusRange(promql, startUnix, endUnix, step = '15s') {
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${startUnix}&end=${endUnix}&step=${step}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'success') return [];
    return json.data.result || [];
  } catch (e) {
    console.error('[ERROR] Prometheus query failed:', e.message);
    return [];
  }
}

async function queryPrometheusInstant(promql) {
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'success') return null;
    const result = json.data.result[0];
    return result ? parseFloat(result.value[1]) : null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Parse user intent with Gemini
// ─────────────────────────────────────────────────────────────────────────────
async function parseIntent(userMessage) {
  if (!ai) {
    return { start: Math.floor(Date.now() / 1000) - 3600, end: Math.floor(Date.now() / 1000), metrics: METRICS.map(m => m.name), summary: 'Last 1 hour (AI unavailable)' };
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const prompt = `
You are a DevOps AI assistant. Given the user's question, extract:
1. The time range they are asking about (as Unix timestamps start and end).
2. Which metrics are most relevant.

Current Unix timestamp: ${nowUnix}
Current time (IST): ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

Available metrics: ${METRICS.map(m => m.name).join(', ')}

User question: "${userMessage}"

Respond ONLY in this exact JSON format (no extra text):
{
  "start": <unix_timestamp>,
  "end": <unix_timestamp>,
  "metrics": ["metric_name1", "metric_name2"],
  "summary": "short human readable description of the query intent"
}

Rules:
- If user says "last hour" → start = now - 3600, end = now
- If user says "12PM" → Calculate today at 12:00:00 UTC. start = 12PM - 1800, end = 12PM + 1800.
- If user says "last 30 minutes" → start = now - 1800, end = now
- If user says "memory" or "heap" → include nodejs_heap_size_used_bytes
- If user says "payment" or "failed" → include payment_failed_total, payment_success_total
- If user says "spike" or "traffic" → include http_requests_total
- If user says "slow" or "latency" → include request_duration_p95
- If user asks generally or says "everything" → include all metrics
`;

  try {
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
    const text = response.text.trim().replace(/```json|```/g, '');
    return JSON.parse(text);
  } catch (e) {
    console.error('[ERROR] Intent parsing failed:', e.message);
    return { start: nowUnix - 3600, end: nowUnix, metrics: METRICS.map(m => m.name), summary: 'Last 1 hour' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Fetch metric data from Prometheus for the time range
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMetricData(metricNames, startUnix, endUnix) {
  const results = {};
  for (const m of METRICS) {
    if (!metricNames.includes(m.name)) continue;
    const data = await queryPrometheusRange(m.query, startUnix, endUnix);
    if (data.length > 0) {
      // Summarize: pick min, max, avg, and the highest point's timestamp
      const values = data[0].values.map(v => parseFloat(v[1])).filter(v => !isNaN(v));
      const timestamps = data[0].values.map(v => parseInt(v[0]));
      if (values.length === 0) continue;
      const max = Math.max(...values);
      const min = Math.min(...values);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const maxIdx = values.indexOf(max);
      const maxAt = new Date(timestamps[maxIdx] * 1000).toISOString();

      results[m.name] = {
        label: m.label,
        min: min.toFixed(4),
        max: max.toFixed(4),
        avg: avg.toFixed(4),
        peak_at: maxAt,
        samples: values.length,
        // Send last 10 data points for AI context (not all 100s of pts)
        recent_values: data[0].values.slice(-10).map(v => ({
          time: new Date(parseInt(v[0]) * 1000).toISOString(),
          value: parseFloat(v[1]).toFixed(4)
        }))
      };
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Fetch live application logs from the anomaly-app via its /metrics
// and from the internal log buffer (we call the anomalies endpoint)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSystemState() {
  try {
    const anomalyAppUrl = process.env.ANOMALY_APP_URL || 'http://app:3000';
    const res = await fetch(`${anomalyAppUrl}/anomalies`);
    const data = await res.json();
    return {
      firing_count: data.firing_count,
      anomalies: data.anomalies,
      active_injections: data.active_injections,
    };
  } catch (e) {
    return { error: 'Could not reach anomaly-app' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Final AI Analysis — combine everything and ask Gemini for RCA
// ─────────────────────────────────────────────────────────────────────────────
async function generateRCA(userQuestion, intent, metricData, systemState) {
  if (!ai) {
    return '⚠️ Gemini AI is not configured. Please check the GEMINI_API_KEY environment variable.';
  }

  const metricSummaryText = Object.entries(metricData).map(([name, d]) =>
    `**${d.label}** (${name}):\n  - Min: ${d.min} | Avg: ${d.avg} | Max: ${d.max}\n  - Peak occurred at: ${d.peak_at}\n  - Last 10 samples: ${JSON.stringify(d.recent_values)}`
  ).join('\n\n');

  const prompt = `
You are an expert DevOps Site Reliability Engineer and AIOps analyst.

A user has asked: "${userQuestion}"

You have retrieved the following real-time data from a production Node.js e-commerce platform to answer this question.

## Query Intent
${intent.summary} (from ${new Date(intent.start * 1000).toISOString()} to ${new Date(intent.end * 1000).toISOString()})

## Prometheus Metric Data
${metricSummaryText}

## Current Live System State (from anomaly engine)
${JSON.stringify(systemState, null, 2)}

## Your Task
Answer the user's question with a precise, expert Root Cause Analysis. Your response should:
1. **Directly answer the question** the user asked.
2. **Cite specific metric numbers** (e.g., "P95 latency peaked at 3.2s at 12:04 PM").
3. **Correlate** metrics to find the cascade: what caused what?
4. **Identify the Root Cause** clearly.
5. **Provide 2-3 remediation steps** the on-call engineer should take right now.

Format your response in clean markdown with headers, bullet points, and bold text. Be direct and technical.
`;

  try {
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
    return response.text;
  } catch (e) {
    return `❌ AI analysis failed: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat — Main endpoint
// ─────────────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  console.log(`[INFO] Chat query: "${message}"`);

  try {
    // Step 1: Parse intent
    const intent = await parseIntent(message);
    console.log('[INFO] Parsed intent:', intent);

    // Step 2: Fetch metric data from Prometheus
    const metricData = await fetchMetricData(intent.metrics || METRICS.map(m => m.name), intent.start, intent.end);

    // Step 3: Fetch live system state
    const systemState = await fetchSystemState();

    // Step 4: Generate RCA with Gemini
    const rca = await generateRCA(message, intent, metricData, systemState);

    res.json({
      question: message,
      intent: intent.summary,
      time_range: {
        from: new Date(intent.start * 1000).toISOString(),
        to: new Date(intent.end * 1000).toISOString(),
      },
      answer: rca,
    });

  } catch (err) {
    console.error('[ERROR] /chat failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /health
app.get('/health', (req, res) => res.json({ status: 'ok', ai: !!ai }));

app.listen(PORT, () => {
  console.log(`[INFO] AIOps Chat Backend running on port ${PORT}`);
  console.log(`[INFO] Prometheus: ${PROMETHEUS_URL}`);
});
