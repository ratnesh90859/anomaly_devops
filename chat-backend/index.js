'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { GoogleGenAI } = require('@google/genai');

const app  = express();
const PORT = process.env.PORT || 3001;
const PROMETHEUS_URL  = process.env.PROMETHEUS_URL  || 'http://prometheus:9090';
const ANOMALY_APP_URL = process.env.ANOMALY_APP_URL || 'http://app:3000';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Gemini AI Client
// ─────────────────────────────────────────────────────────────────────────────
let ai = null;
if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  console.log('[INFO] Gemini AI initialized for LangGraph workflow.');
} else {
  console.warn('[WARN] GEMINI_API_KEY not set. AI workflow disabled.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Helper — retry on transient 503 errors
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(prompt, maxRetries = 4) {
  const model = 'gemini-2.5-flash';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await ai.models.generateContent({ model, contents: prompt });
      return res.text;
    } catch (e) {
      const isTransient = e.message && (
        e.message.includes('503') || e.message.includes('UNAVAILABLE') ||
        e.message.includes('high demand') || e.message.includes('temporarily')
      );
      if (isTransient && attempt < maxRetries) {
        const delay = attempt * 5000;
        console.warn(`[WARN] Gemini 503, attempt ${attempt}/${maxRetries}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else throw e;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function runInstantQuery(promql) {
  try {
    const url  = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.status !== 'success') return [];
    return json.data.result || [];
  } catch (e) { return []; }
}

async function runRangeQuery(promql, start, end, step = '15s') {
  try {
    const url  = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${start}&end=${end}&step=${step}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.status !== 'success') return [];
    return json.data.result || [];
  } catch (e) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// LANGGRAPH-STYLE WORKFLOW
// Each node is: async (state) => updatedState
// State flows through each node sequentially.
// ─────────────────────────────────────────────────────────────────────────────

// ── NODE 1: Intent Parser ────────────────────────────────────────────────────
// Converts a plain-English question into structured intent:
// what time window, what components, what urgency.
async function nodeIntentParser(state) {
  console.log('[NODE 1] Intent Parser');
  const nowUnix = Math.floor(Date.now() / 1000);

  if (!ai) {
    return {
      ...state,
      intent: {
        timeRange: { start: nowUnix - 3600, end: nowUnix, description: 'Last 1 hour' },
        entities: ['all'], urgency: 'medium',
        summary: 'General health check (AI unavailable)'
      }
    };
  }

  const prompt = `
You are a DevOps observability AI. Parse the user question into structured intent.

Current Unix timestamp: ${nowUnix}
Current time (IST): ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
User question: "${state.question}"

Return ONLY raw JSON (no markdown fences):
{
  "timeRange": {
    "start": <unix_timestamp_number>,
    "end": <unix_timestamp_number>,
    "description": "<e.g. Last 30 minutes>"
  },
  "entities": ["<one or more of: memory, payment, traffic, latency, orders, errors, all>"],
  "urgency": "<low|medium|high|critical>",
  "summary": "<one-sentence intent summary>"
}

TimeRange rules:
- "last hour" → start=now-3600, end=now
- "last 30 minutes" → start=now-1800, end=now
- "12PM" or "noon" → today 12:00 UTC ± 30 min
- "right now" or "current" → start=now-900, end=now
- unspecified → start=now-3600, end=now

Entity rules (pick all that apply):
- memory/heap → memory
- payment/checkout/transaction → payment
- traffic/spike/requests/load → traffic
- slow/latency/response → latency
- order → orders
- error/fail → errors
- health/summary/everything → all
`.trim();

  try {
    const raw = await callGemini(prompt);
    const intent = JSON.parse(raw.trim().replace(/```json|```/g, ''));
    console.log('[NODE 1] Intent:', intent.summary);
    return { ...state, intent };
  } catch (e) {
    console.error('[NODE 1] Parsing failed, using default:', e.message);
    return {
      ...state,
      intent: {
        timeRange: { start: nowUnix - 3600, end: nowUnix, description: 'Last 1 hour' },
        entities: ['all'], urgency: 'medium',
        summary: 'General system health check'
      }
    };
  }
}

// ── NODE 2: PromQL Generator ─────────────────────────────────────────────────
// Gemini generates exact PromQL queries tailored to the intent.
// This replaces the fixed predefined query list from before.
async function nodePromQLGenerator(state) {
  console.log('[NODE 2] PromQL Generator');
  const { intent } = state;

  if (!ai) return { ...state, promqlQueries: defaultQueries() };

  const prompt = `
You are a Prometheus PromQL expert. Generate PromQL queries to investigate this DevOps issue.

User question: "${state.question}"
Intent: ${intent.summary}
Suspected components: ${(intent.entities || ['all']).join(', ')}
Time range: ${intent.timeRange.description}

Available metrics on this Prometheus instance:
- http_requests_total [counter] labels: method, path, status_code
- request_duration_seconds [histogram] — use histogram_quantile()
- payment_success_total [counter]
- payment_failed_total [counter]
- checkout_started_total [counter]
- orders_created_total [counter]
- nodejs_heap_size_used_bytes [gauge]
- nodejs_heap_size_total_bytes [gauge]
- process_cpu_user_seconds_total [counter]

Generate 3-6 PromQL queries that best diagnose the issue.
Return ONLY a raw JSON array (no markdown):
[
  {
    "id": "unique_snake_case_id",
    "description": "What this query tells us",
    "query": "<exact promql>",
    "type": "range"
  }
]

Rules:
- Use rate(metric[5m]) for all counters
- Use histogram_quantile(0.95, rate(request_duration_seconds_bucket[5m])) for latency
- Divide bytes by 1024/1024 to get MB for memory
- type = "range" for time series, "instant" for single current value
- Focus on entities: ${(intent.entities || ['all']).join(', ')}
`.trim();

  try {
    const raw = await callGemini(prompt);
    const queries = JSON.parse(raw.trim().replace(/```json|```/g, ''));
    console.log(`[NODE 2] Generated ${queries.length} queries:`, queries.map(q => q.id).join(', '));
    return { ...state, promqlQueries: queries };
  } catch (e) {
    console.error('[NODE 2] PromQL generation failed, using defaults:', e.message);
    return { ...state, promqlQueries: defaultQueries() };
  }
}

function defaultQueries() {
  return [
    { id: 'http_rate',    description: 'HTTP request rate',    query: 'rate(http_requests_total[5m])',                                                      type: 'range' },
    { id: 'payment_fail', description: 'Payment failure rate', query: 'rate(payment_failed_total[5m])',                                                      type: 'range' },
    { id: 'latency_p95',  description: 'P95 latency (s)',      query: 'histogram_quantile(0.95, rate(request_duration_seconds_bucket[5m]))',                 type: 'range' },
    { id: 'heap_mb',      description: 'Heap memory (MB)',     query: 'nodejs_heap_size_used_bytes / 1024 / 1024',                                           type: 'range' },
    { id: 'orders',       description: 'Order creation rate',  query: 'rate(orders_created_total[5m])',                                                      type: 'range' },
  ];
}

// ── NODE 3: Prometheus Executor ──────────────────────────────────────────────
// Runs all PromQL queries against Prometheus and summarises the results.
// Detects spikes automatically: is the max value > 2x the average?
async function nodePrometheusExecutor(state) {
  console.log('[NODE 3] Prometheus Executor');
  const { promqlQueries, intent } = state;
  const { start, end } = intent.timeRange;

  const metricResults = [];

  for (const q of promqlQueries) {
    const rawData = q.type === 'instant'
      ? await runInstantQuery(q.query)
      : await runRangeQuery(q.query, start, end);

    if (!rawData.length || !rawData[0].values?.length) continue;

    const values     = rawData[0].values.map(v => parseFloat(v[1])).filter(v => !isNaN(v));
    const timestamps = rawData[0].values.map(v => parseInt(v[0]));
    if (!values.length) continue;

    const max    = Math.max(...values);
    const min    = Math.min(...values);
    const avg    = values.reduce((a, b) => a + b, 0) / values.length;
    const maxIdx = values.indexOf(max);

    const spikeRatio  = avg > 0 ? max / avg : 1;
    const hasSpike    = spikeRatio > 2;

    metricResults.push({
      id: q.id,
      description: q.description,
      query: q.query,
      stats: {
        min:            min.toFixed(4),
        max:            max.toFixed(4),
        avg:            avg.toFixed(4),
        peak_at:        new Date(timestamps[maxIdx] * 1000).toISOString(),
        spike_detected: hasSpike,
        spike_ratio:    spikeRatio.toFixed(2),
        total_samples:  values.length,
      },
      // 7-sample window around the peak — for AI correlation
      peak_window: rawData[0].values
        .slice(Math.max(0, maxIdx - 3), maxIdx + 4)
        .map(v => ({ t: new Date(parseInt(v[0]) * 1000).toISOString(), v: parseFloat(v[1]).toFixed(4) })),
      // Last 6 samples — for AI to judge current trend
      recent_trend: rawData[0].values.slice(-6)
        .map(v => ({ t: new Date(parseInt(v[0]) * 1000).toISOString(), v: parseFloat(v[1]).toFixed(4) })),
    });
  }

  const spikes = metricResults.filter(r => r.stats.spike_detected).map(r => r.id);
  console.log(`[NODE 3] Ran ${metricResults.length} queries. Spikes: ${spikes.join(', ') || 'none'}`);
  return { ...state, metricResults };
}

// ── NODE 4: Log Correlator ───────────────────────────────────────────────────
// Fetches live anomaly state from the main app (which holds the log buffer).
// Correlates the spike timestamps with the log entries.
async function nodeLogCorrelator(state) {
  console.log('[NODE 4] Log Correlator');

  let systemState = {};
  try {
    const res  = await fetch(`${ANOMALY_APP_URL}/anomalies`);
    const data = await res.json();
    systemState = {
      firing_count:     data.firing_count,
      firing_anomalies: (data.anomalies || []).filter(a => a.status === 'FIRING'),
      all_anomalies:    data.anomalies,
      active_injections: data.active_injections,
    };
  } catch (e) {
    systemState = { error: 'Could not reach anomaly-app: ' + e.message };
  }

  // Collect spike timestamps for the AI to cross-reference with logs
  const spikeTimestamps = state.metricResults
    .filter(r => r.stats?.spike_detected)
    .map(r => ({ metric: r.id, peak_at: r.stats.peak_at, ratio: r.stats.spike_ratio }));

  console.log(`[NODE 4] Firing anomalies: ${systemState.firing_count ?? 'unknown'}. Spike timestamps: ${spikeTimestamps.length}`);
  return {
    ...state,
    correlatedLogs: { spike_timestamps: spikeTimestamps, system_state: systemState }
  };
}

// ── NODE 5: Root Cause Synthesizer ──────────────────────────────────────────
// The final, most important node. Sends the complete picture to Gemini:
// intent + custom query results + spike correlation + live log state.
// Returns a structured, evidence-backed Root Cause Analysis.
async function nodeRootCauseSynthesizer(state) {
  console.log('[NODE 5] Root Cause Synthesizer');

  if (!ai) {
    return { ...state, rootCauseAnalysis: '⚠️ Gemini AI is not configured.' };
  }

  const { question, intent, metricResults, correlatedLogs } = state;

  const metricSection = metricResults.length
    ? metricResults.map(r => `
**${r.description}** (\`${r.query}\`)
- Range: min=${r.stats.min} avg=${r.stats.avg} max=${r.stats.max}
- Peak at: ${r.stats.peak_at} | Spike: ${r.stats.spike_detected ? `YES (${r.stats.spike_ratio}x avg)` : 'No'}
- Peak window: ${JSON.stringify(r.peak_window)}
- Recent trend: ${JSON.stringify(r.recent_trend)}`).join('\n')
    : 'No significant metric data found in this time window.';

  const prompt = `
You are a senior Site Reliability Engineer performing a Root Cause Analysis.
The following data was collected by a 5-step LangGraph observability workflow.

## User Question
"${question}"

## Investigation Scope
- Time window: ${intent.timeRange.description} (${new Date(intent.timeRange.start * 1000).toISOString()} → ${new Date(intent.timeRange.end * 1000).toISOString()})
- Suspected components: ${(intent.entities || []).join(', ')}

## PromQL Query Results (Real Prometheus Data)
${metricSection}

## Spike Correlation
${JSON.stringify(correlatedLogs.spike_timestamps, null, 2)}

## Live Anomaly Engine State
${JSON.stringify(correlatedLogs.system_state, null, 2)}

## Your Task
Write a structured Root Cause Analysis that directly answers the user's question.
Use markdown. Be precise — cite exact numbers and timestamps from the data above.

### 🎯 Direct Answer
Answer what the user asked in 1-2 sentences.

### 🔍 Evidence
- Key findings from the metric data with exact values and timestamps
- Note which metrics spiked, by how much, and when

### 🌊 Root Cause & Cascade
Explain what was the ROOT cause vs downstream symptoms. How did one thing trigger another?

### 🛠️ Remediation (Priority Order)
1. First action (immediate)
2. Second action (short-term)
3. Third action (prevention)

Do not pad with generic advice. Every point must reference the actual data above.
`.trim();

  try {
    const rca = await callGemini(prompt);
    console.log('[NODE 5] RCA synthesized successfully.');
    return { ...state, rootCauseAnalysis: rca };
  } catch (e) {
    return { ...state, rootCauseAnalysis: `❌ AI synthesis failed: ${e.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Runner — executes all 5 nodes in sequence
// ─────────────────────────────────────────────────────────────────────────────
async function runWorkflow(question) {
  const t0 = Date.now();
  let state = { question, workflowLog: [] };

  const nodes = [
    { name: 'intent_parser',       fn: nodeIntentParser },
    { name: 'promql_generator',    fn: nodePromQLGenerator },
    { name: 'prometheus_executor', fn: nodePrometheusExecutor },
    { name: 'log_correlator',      fn: nodeLogCorrelator },
    { name: 'rca_synthesizer',     fn: nodeRootCauseSynthesizer },
  ];

  for (const node of nodes) {
    const t = Date.now();
    try {
      state = await node.fn(state);
      const ms = Date.now() - t;
      state.workflowLog.push({ node: node.name, status: 'ok', ms });
      console.log(`[WORKFLOW] ✓ ${node.name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - t;
      state.workflowLog.push({ node: node.name, status: 'error', error: err.message, ms });
      console.error(`[WORKFLOW] ✗ ${node.name} error:`, err.message);
      // Graceful degradation — continue to next node
    }
  }

  const totalMs = Date.now() - t0;
  console.log(`[WORKFLOW] Done in ${totalMs}ms\n`);

  return {
    question,
    intent_summary:    state.intent?.summary,
    time_range: {
      from:        state.intent ? new Date(state.intent.timeRange.start * 1000).toISOString() : null,
      to:          state.intent ? new Date(state.intent.timeRange.end   * 1000).toISOString() : null,
      description: state.intent?.timeRange?.description,
    },
    queries_generated: (state.promqlQueries  || []).length,
    metrics_analyzed:  (state.metricResults  || []).length,
    spikes_found:      (state.metricResults  || []).filter(r => r.stats?.spike_detected).map(r => r.id),
    answer:            state.rootCauseAnalysis || '⚠️ No analysis generated.',
    workflow_log:      state.workflowLog,
    total_ms:          totalMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Routes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' });

  console.log(`\n[CHAT] "${message}"`);
  try {
    const result = await runWorkflow(message.trim());
    res.json(result);
  } catch (err) {
    console.error('[CHAT] Workflow crash:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: !!ai,
  workflow_nodes: ['intent_parser', 'promql_generator', 'prometheus_executor', 'log_correlator', 'rca_synthesizer']
}));

app.listen(PORT, () => {
  console.log(`[INFO] AIOps LangGraph Workflow Backend — port ${PORT}`);
  console.log(`[INFO] Prometheus: ${PROMETHEUS_URL} | App: ${ANOMALY_APP_URL}`);
});
