'use strict';

const express = require('express');
const client  = require('prom-client');
const axios   = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// System Log Interceptor
// Captures the last 100 log/error lines to pass as raw context to Gemini AI
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const LOG_FILE = './system.log';

function logToBuffer(level, ...args) {
  const line = `[${level}] ${new Date().toISOString()} - ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  fs.appendFile(LOG_FILE, line + '\n', () => {}); // Fast async file write
}

const originalError = console.error;
console.error = function(...args) { logToBuffer('ERROR', ...args); originalError.apply(console, args); };
const originalWarn = console.warn;
console.warn = function(...args) { logToBuffer('WARN', ...args); originalWarn.apply(console, args); };
const originalLog = console.log;
console.log = function(...args) { logToBuffer('INFO', ...args); originalLog.apply(console, args); };

// 1-Hour Log Retention (Runs every 10 minutes)
setInterval(() => {
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n');
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    // Keep only lines from the last 1 hour
    const recentLines = lines.filter(line => {
      if (!line.trim()) return false;
      const match = line.match(/^\[.*?\] (.*?) -/);
      return match && match[1] ? (new Date(match[1]).getTime() > oneHourAgo) : false;
    });
    
    fs.writeFileSync(LOG_FILE, recentLines.join('\n') + (recentLines.length ? '\n' : ''));
  }
}, 10 * 60 * 1000);

// Helper to query logs by time range
function getHistoricalLogs(startUnix, endUnix) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n');
  const valid = lines.filter(line => {
    if (!line.trim()) return false;
    const match = line.match(/^\[.*?\] (.*?) -/);
    if (match && match[1]) {
      const ts = Math.floor(new Date(match[1]).getTime() / 1000);
      if (startUnix && ts < startUnix) return false;
      if (endUnix && ts > endUnix) return false;
      return true;
    }
    return false;
  });
  return valid.slice(-200); // Return up to 200 matching lines
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Gemini AI Initialization
// ─────────────────────────────────────────────────────────────────────────────
let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus Registry & Metrics
// ─────────────────────────────────────────────────────────────────────────────
const registry = new client.Registry();
registry.setDefaultLabels({ app: 'anomaly-detection' });
client.collectDefaultMetrics({ register: registry });

const ordersCreated = new client.Counter({
  name: 'orders_created_total',
  help: 'Total number of orders successfully created',
  registers: [registry],
});

const paymentFailed = new client.Counter({
  name: 'payment_failed_total',
  help: 'Total number of failed payment attempts',
  registers: [registry],
});

const paymentSuccess = new client.Counter({
  name: 'payment_success_total',
  help: 'Total number of successful payment attempts',
  registers: [registry],
});

const checkoutStarted = new client.Counter({
  name: 'checkout_started_total',
  help: 'Total number of checkout sessions initiated',
  registers: [registry],
});

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests received, labeled by route and status code',
  labelNames: ['route', 'status'],
  registers: [registry],
});

const requestDuration = new client.Histogram({
  name: 'request_duration_seconds',
  help: 'HTTP request duration in seconds',
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection State
// ─────────────────────────────────────────────────────────────────────────────
const injection = {
  paymentFailure: false,   // drives 90% fail rate when true
  latency: {
    enabled: false,
    delay_ms: 0,
  },
  slowReviews: false,      // payment returns 502 status
  subTraffic: false,       // enables high-volume internal traffic loop
  memoryLeak: {
    enabled: false,
    mb_per_second: 0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Real Memory Leak Simulator
// ─────────────────────────────────────────────────────────────────────────────
let memoryLeakInterval = null;
const leakedData = [];


// ─────────────────────────────────────────────────────────────────────────────
// Background Traffic Simulator
// Generates realistic e-commerce event traffic every 200ms.
// When subTraffic is enabled, rate multiplies ~25x to simulate a burst.
// ─────────────────────────────────────────────────────────────────────────────
function simulateTraffic() {
  setInterval(() => {
    // Normal baseline: ~1 event tick = ~5 req/s
    // Sub-traffic mode: ~25 event ticks = ~125 req/s
    const ticks = injection.subTraffic ? 5 : 1;

    for (let i = 0; i < ticks; i++) {
      // Each tick: a user starts checkout
      checkoutStarted.inc();
      httpRequests.labels('/checkout', '200').inc();

      // Determine if payment succeeds or fails
      const failRate = injection.paymentFailure ? 0.9 : 0.05;
      const failed   = Math.random() < failRate;

      if (failed) {
        paymentFailed.inc();
        const statusCode = injection.slowReviews ? '502' : '500';
        httpRequests.labels('/payment', statusCode).inc();
      } else {
        paymentSuccess.inc();
        ordersCreated.inc();
        httpRequests.labels('/order', '200').inc();
      }

      // Observe request duration (inject latency if enabled)
      const baseDuration = failed ? Math.random() * 0.5 + 0.1 : Math.random() * 0.2 + 0.05;
      const injectedMs   = injection.latency.enabled ? injection.latency.delay_ms : 0;
      const totalSeconds = baseDuration + injectedMs / 1000;
      requestDuration.observe(totalSeconds);
    }
  }, 200);
}

simulateTraffic();

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Metrics
// ─────────────────────────────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Health
// ─────────────────────────────────────────────────────────────────────────────
// Root — status overview page
app.get('/', (req, res) => {
  res.json({
    service: 'Business-Aware Anomaly Detection System',
    status: 'running',
    uptime_seconds: Math.round(process.uptime()),
    endpoints: {
      metrics:               'GET  /metrics',
      health:                'GET  /health',
      anomalies:             'GET  /anomalies',
      injection_status:      'GET  /inject/status',
      inject_payment_fail:   'POST /inject/payment-failure  body: { "enabled": true|false }',
      inject_latency:        'POST /inject/latency          body: { "enabled": true|false, "delay_ms": 3000 }',
      inject_slow_reviews:   'POST /inject/slow-reviews     body: { "enabled": true|false }',
      inject_sub_traffic:    'POST /inject/sub-traffic      body: { "enabled": true|false }',
      inject_memory_leak:    'POST /inject/memory-leak      body: { "enabled": true|false, "mb_per_second": 10 }',
    },
    dashboards: {
      prometheus: 'http://<VM_IP>:9090',
      grafana:    'http://<VM_IP>:4000  (admin / admin)',
    },
    active_injections: injection,
    memory_leaked_mb: Math.floor(leakedData.length * (injection.memoryLeak.mb_per_second || 0)),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes — Anomaly Injection Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// POST /inject/payment-failure   body: { "enabled": true|false }
// Sets payment failure rate to 90% and immediately bumps the failed counter
// so the change is detectable in Prometheus metrics without waiting for ticks.
app.post('/inject/payment-failure', (req, res) => {
  const { enabled } = req.body;
  injection.paymentFailure = Boolean(enabled);

  if (injection.paymentFailure) {
    // Spike the counter immediately so Prometheus sees it right away
    for (let i = 0; i < 20; i++) paymentFailed.inc();
    console.error("Error: ETIMEOUT at PaymentGateway.charge (/app/services/payment.js:42) - Connection refused by upstream origin");
  }

  res.json({
    status: 'ok',
    injection: 'payment-failure',
    enabled: injection.paymentFailure,
    message: injection.paymentFailure
      ? 'Payment failure rate set to 90%. Counters spiked immediately.'
      : 'Payment failure injection disabled. Rate restored to ~5%.',
  });
});

// POST /inject/latency   body: { "enabled": true|false, "delay_ms": 3000 }
// Adds artificial latency to every simulated request.
app.post('/inject/latency', (req, res) => {
  const { enabled, delay_ms = 3000 } = req.body;
  injection.latency = { enabled: Boolean(enabled), delay_ms: Number(delay_ms) };

  res.json({
    status: 'ok',
    injection: 'latency',
    enabled: injection.latency.enabled,
    delay_ms: injection.latency.delay_ms,
    message: injection.latency.enabled
      ? `Adding ${delay_ms}ms artificial latency to all simulated requests.`
      : 'Latency injection disabled.',
  });
  if (injection.latency.enabled) {
      console.warn(`MongoTimeoutError: Server selection timed out after ${delay_ms} ms at cluster (/app/db/mongodb.js)`);
  }
});

// POST /inject/slow-reviews   body: { "enabled": true|false }
// Simulates a slow/broken review service — payments return 502 status
// and immediately bumps the payment_failed_total counter.
app.post('/inject/slow-reviews', (req, res) => {
  const { enabled } = req.body;
  injection.slowReviews = Boolean(enabled);

  if (injection.slowReviews) {
    for (let i = 0; i < 10; i++) {
      paymentFailed.inc();
      httpRequests.labels('/payment', '502').inc();
    }
    console.warn("WARN: Proxy to review-service returned 502 Bad Gateway at downstream resolution");
  }

  res.json({
    status: 'ok',
    injection: 'slow-reviews',
    enabled: injection.slowReviews,
    message: injection.slowReviews
      ? 'Review service degraded: payments returning 502. Counters spiked.'
      : 'slow-reviews injection disabled.',
  });
});

// POST /inject/sub-traffic   body: { "enabled": true|false }
// Multiplies internal traffic generation ~25x, simulating a bot flood
// or viral event (50+ req/s internal to /order and /checkout).
app.post('/inject/sub-traffic', (req, res) => {
  const { enabled } = req.body;
  injection.subTraffic = Boolean(enabled);

  if (injection.subTraffic) {
     console.error("error: WAF rate limiting active, dropping incoming HTTP socket connections from unknown origin IPs targeting /checkout");
  }

  res.json({
    status: 'ok',
    injection: 'sub-traffic',
    enabled: injection.subTraffic,
    message: injection.subTraffic
      ? 'Sub-traffic injection enabled: generating ~50+ req/s to /order and /checkout.'
      : 'Sub-traffic injection disabled. Traffic returning to baseline.',
  });
});

// POST /inject/memory-leak   body: { "enabled": true|false, "mb_per_second": 10 }
// Simulates a real memory leak by continuously allocating arrays of strings.
app.post('/inject/memory-leak', (req, res) => {
  const { enabled, mb_per_second = 10 } = req.body;
  injection.memoryLeak = { enabled: Boolean(enabled), mb_per_second: Number(mb_per_second) };

  if (injection.memoryLeak.enabled) {
    if (!memoryLeakInterval) {
      memoryLeakInterval = setInterval(() => {
        // Bypass V8 string intern optimizations by allocating floats
        const mb = injection.memoryLeak.mb_per_second;
        const arr = new Array(Math.floor((mb * 1024 * 1024) / 8));
        for(let i=0; i < arr.length; i++) {
          arr[i] = Math.random();
        }
        leakedData.push(arr);
        if (Math.random() < 0.2) {
          console.error("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory \n 1: 0x1012f2c95 node::Abort() \n 2: 0x1011f0a10 node::FatalError() \n 4: V8::FatalProcessOutOfMemory() \n 5: Array.push (<anonymous>) (/app/index.js:255)");
        }
      }, 1000);
    }
  } else {
    if (memoryLeakInterval) {
      clearInterval(memoryLeakInterval);
      memoryLeakInterval = null;
    }
    leakedData.length = 0; // Clear the memory
  }

  res.json({
    status: 'ok',
    injection: 'memory-leak',
    enabled: injection.memoryLeak.enabled,
    mb_per_second: injection.memoryLeak.mb_per_second,
    message: injection.memoryLeak.enabled
      ? `Memory leak started: allocating ${mb_per_second} MB per second.`
      : 'Memory leak disabled and memory freed.'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Business Correlation API — GET /anomalies
// Queries Prometheus HTTP API, evaluates business heuristics, returns JSON.
// ─────────────────────────────────────────────────────────────────────────────
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';

async function queryPrometheus(promql) {
  try {
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
      params: { query: promql },
      timeout: 5000,
    });
    const results = response.data?.data?.result;
    if (results && results.length > 0) {
      return parseFloat(results[0].value[1]);
    }
    return 0;
  } catch {
    return 0;
  }
}

async function detectAnomalies(startUnix, endUnix) {
  // Run all Prometheus queries in parallel for speed
  const [
    failRate2m,
    successRate2m,
    orderRate1m,
    orderRate5m,
    trafficRate1m,
    trafficRate5m,
    latencyP95,
    checkoutRate2m,
    orderRate2m,
    memoryUsed,
  ] = await Promise.all([
    queryPrometheus('rate(payment_failed_total[2m])'),
    queryPrometheus('rate(payment_success_total[2m])'),
    queryPrometheus('rate(orders_created_total[1m])'),
    queryPrometheus('rate(orders_created_total[5m])'),
    queryPrometheus('rate(http_requests_total[1m])'),
    queryPrometheus('rate(http_requests_total[5m])'),
    queryPrometheus('histogram_quantile(0.95, rate(request_duration_seconds_bucket[5m]))'),
    queryPrometheus('rate(checkout_started_total[2m])'),
    queryPrometheus('rate(orders_created_total[2m])'),
    queryPrometheus('nodejs_heap_size_used_bytes'),
  ]);

  // Derived metrics
  const totalPaymentRate = failRate2m + successRate2m;
  const paymentErrorPct  = totalPaymentRate > 0
    ? (failRate2m / totalPaymentRate) * 100
    : 0;

  const orderDropPct     = orderRate5m > 0
    ? ((orderRate5m - orderRate1m) / orderRate5m) * 100
    : 0;

  const trafficMultiplier = trafficRate5m > 0
    ? trafficRate1m / trafficRate5m
    : 1;

  const checkoutConversion = checkoutRate2m > 0
    ? orderRate2m / checkoutRate2m
    : 1;

  // Build anomaly report with business context
  const baseAnomalies = [
    {
      metric:          'payment_failed_total',
      status:          paymentErrorPct > 20 ? 'FIRING' : 'normal',
      change_pct:      Math.round(paymentErrorPct * 10) / 10,
      business_impact: 'Revenue loss — payment success rate dropped, direct GMV impact',
      severity:        paymentErrorPct > 50 ? 'critical' : paymentErrorPct > 20 ? 'warning' : 'info',
    },
    {
      metric:          'orders_created_total',
      status:          orderDropPct > 50 ? 'FIRING' : 'normal',
      change_pct:      Math.round(-orderDropPct * 10) / 10,
      business_impact: 'GMV decline — order volume significantly below 5-minute average',
      severity:        orderDropPct > 50 ? 'critical' : orderDropPct > 20 ? 'warning' : 'info',
    },
    {
      metric:          'http_requests_total',
      status:          trafficMultiplier > 2 ? 'FIRING' : 'normal',
      change_pct:      Math.round((trafficMultiplier - 1) * 100),
      business_impact: 'Infrastructure overload risk — abnormal traffic surge detected',
      severity:        trafficMultiplier > 5 ? 'critical' : trafficMultiplier > 2 ? 'warning' : 'info',
    },
    {
      metric:          'request_duration_seconds_p95',
      status:          latencyP95 > 2 ? 'FIRING' : 'normal',
      change_pct:      Math.round(latencyP95 * 1000), // represented as ms for readability
      business_impact: 'User experience degradation — high latency causing checkout abandonment',
      severity:        latencyP95 > 2 ? 'critical' : latencyP95 > 1 ? 'warning' : 'info',
    },
    {
      metric:          'checkout_to_order_ratio',
      status:          checkoutConversion < 0.3 ? 'FIRING' : 'normal',
      change_pct:      Math.round(checkoutConversion * 100),
      business_impact: 'Conversion funnel collapse — users abandoning after checkout start',
      severity:        checkoutConversion < 0.3 ? 'critical' : checkoutConversion < 0.6 ? 'warning' : 'info',
    },
    {
      metric:          'nodejs_heap_size_used_bytes',
      status:          memoryUsed > 100 * 1024 * 1024 ? 'FIRING' : 'normal',
      change_pct:      Math.round(memoryUsed / (1024 * 1024)), // Return megabytes used
      business_impact: 'System instability — High memory usage leading to latency (Garbage Collection thrashing) and OOM crash risk',
      severity:        memoryUsed > 150 * 1024 * 1024 ? 'critical' : memoryUsed > 100 * 1024 * 1024 ? 'warning' : 'info',
    }
  ];

  // ─────────────────────────────────────────────────────────────────────────────
  // Dynamic AI Root Cause Analysis
  // ─────────────────────────────────────────────────────────────────────────────
  const firingAnomalies = baseAnomalies.filter((a) => a.status === 'FIRING');
  let aiAnalysis = null;

  if (firingAnomalies.length > 0 && ai) {
    try {
      const prompt = `You are a DevOps Site Reliability Engineer monitoring a Node.js e-commerce platform.
The following anomalies have just triggered synchronously:
${JSON.stringify(firingAnomalies, null, 2)}

Below is a snapshot of the raw stdout/stderr logs from the application leading up to the failure:
<raw_logs>
${getHistoricalLogs(Math.floor(Date.now()/1000)-300, Math.floor(Date.now()/1000)).join("\n")}
</raw_logs>

Provide a concise, highly technical Root Cause Analysis (max 2 paragraphs).
1. Read the logs and correlate them explicitly with the numerical anomalies to declare the exact Root Cause of the incident.
2. Provide a direct, actionable remediation step for the on-call engineer based directly on what you found in the stack trace logs.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });
      aiAnalysis = response.text;
    } catch (err) {
      console.error('AI Analysis failed:', err.message);
      aiAnalysis = 'AI analysis failed: ' + err.message;
    }
  } else if (firingAnomalies.length > 0) {
    aiAnalysis = 'GEMINI_API_KEY not configured. Add it to .env to enable AI Root Cause Analysis.';
  }

  return {
    timestamp: new Date().toISOString(),
    firing_count: firingAnomalies.length,
    ai_root_cause_analysis: aiAnalysis || 'System healthy. No analysis needed.',
    anomalies: baseAnomalies
  };
}

app.get('/anomalies', async (req, res) => {
  try {
    const startUnix = req.query.start ? parseInt(req.query.start) : Math.floor(Date.now()/1000) - 3600;
    const endUnix   = req.query.end   ? parseInt(req.query.end)   : Math.floor(Date.now()/1000);
    const anomalies = await detectAnomalies(startUnix, endUnix);
    res.json(anomalies);
  } catch (err) {
    res.status(500).json({ error: 'Failed to query Prometheus', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection Status
// ─────────────────────────────────────────────────────────────────────────────
app.get('/inject/status', (req, res) => {
  res.json(injection);
});

// ─────────────────────────────────────────────────────────────────────────────
// Stdout Anomaly Reporter — prints formatted report every 30 seconds
// ─────────────────────────────────────────────────────────────────────────────
function printReport(report) {
  const SEVERITY_ICON = { critical: '🔴', warning: '🟡', info: '🟢' };
  const line          = '─'.repeat(72);
  const ts            = report.timestamp;

  console.log('\n' + line);
  console.log(`  🔍  ANOMALY DETECTION REPORT  ·  ${ts}`);
  console.log(line);

  for (const a of report.anomalies) {
    const icon = SEVERITY_ICON[a.severity] || '⚪';
    const flag = a.status === 'FIRING' ? ' ◀ FIRING' : '';
    console.log(`\n  ${icon}  [${a.severity.toUpperCase()}]  ${a.metric}${flag}`);
    console.log(`       Status         : ${a.status}`);
    console.log(`       Change         : ${a.change_pct}%`);
  }

  console.log('\n' + line);
  if (report.firing_count > 0) {
    console.log('  🤖 AI ROOT CAUSE ANALYSIS:');
    console.log(`\n${report.ai_root_cause_analysis.replace(/^/gm, '    ')}`);
  } else {
    console.log('  ✅ System Healthy.');
  }

  console.log('\n' + line);
  console.log(
    `  Summary: ${report.firing_count} FIRING  ·  ${report.anomalies.length - report.firing_count} normal` +
    `  ·  Active injections: ${Object.entries(injection)
      .filter(([, v]) => v === true || (typeof v === 'object' && v.enabled))
      .map(([k]) => k)
      .join(', ') || 'none'}`
  );
  console.log(line + '\n');
}

// Wait 15s for Prometheus to scrape at least once before first report
setTimeout(async () => {
  console.log('  ⏳  Running initial anomaly scan after Prometheus warm-up...');
  const anomalies = await detectAnomalies();
  printReport(anomalies);
}, 15_000);

// Subsequent reports every 30 seconds
setInterval(async () => {
  const anomalies = await detectAnomalies();
  printReport(anomalies);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║   Business-Aware Anomaly Detection Service               ║');
  console.log('  ║   Listening on port 3000                                 ║');
  console.log('  ╠══════════════════════════════════════════════════════════╣');
  console.log('  ║  GET  /metrics                  Prometheus metrics       ║');
  console.log('  ║  GET  /anomalies                Business anomaly report  ║');
  console.log('  ║  GET  /health                   Health check             ║');
  console.log('  ║  GET  /inject/status            Active injection states  ║');
  console.log('  ║  POST /inject/payment-failure   Enable/disable failures  ║');
  console.log('  ║  POST /inject/latency           Enable/disable latency   ║');
  console.log('  ║  POST /inject/slow-reviews      Enable/disable 502s      ║');
  console.log('  ║  POST /inject/sub-traffic       Enable/disable burst     ║');
  console.log('  ║  POST /inject/memory-leak       Enable/disable real leak ║');
  if (!ai) {
    console.log('  ⚠️   GEMINI_API_KEY missing. Dynamic AI Root Cause Analysis is DISABLED.');
  } else {
    console.log('  🤖  Google Gemini AI Engine initialized for Root Cause Analysis.');
  }
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
