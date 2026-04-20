'use strict';

const express = require('express');
const client  = require('prom-client');
const axios   = require('axios');

const app = express();
app.use(express.json());

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
};

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

  res.json({
    status: 'ok',
    injection: 'sub-traffic',
    enabled: injection.subTraffic,
    message: injection.subTraffic
      ? 'Sub-traffic injection enabled: generating ~50+ req/s to /order and /checkout.'
      : 'Sub-traffic injection disabled. Traffic returning to baseline.',
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

async function detectAnomalies() {
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
  return [
    {
      metric:          'payment_failed_total',
      status:          paymentErrorPct > 20 ? 'FIRING' : 'normal',
      change_pct:      Math.round(paymentErrorPct * 10) / 10,
      business_impact: 'Revenue loss — payment success rate dropped, direct GMV impact',
      likely_cause:    'payment-failure injection active or upstream payment gateway timeout',
      severity:        paymentErrorPct > 50 ? 'critical' : paymentErrorPct > 20 ? 'warning' : 'info',
    },
    {
      metric:          'orders_created_total',
      status:          orderDropPct > 50 ? 'FIRING' : 'normal',
      change_pct:      Math.round(-orderDropPct * 10) / 10,
      business_impact: 'GMV decline — order volume significantly below 5-minute average',
      likely_cause:    'payment failures blocking order completion or traffic drop event',
      severity:        orderDropPct > 50 ? 'critical' : orderDropPct > 20 ? 'warning' : 'info',
    },
    {
      metric:          'http_requests_total',
      status:          trafficMultiplier > 2 ? 'FIRING' : 'normal',
      change_pct:      Math.round((trafficMultiplier - 1) * 100),
      business_impact: 'Infrastructure overload risk — abnormal traffic surge detected',
      likely_cause:    'sub-traffic injection active, bot flood, or viral external event',
      severity:        trafficMultiplier > 5 ? 'critical' : trafficMultiplier > 2 ? 'warning' : 'info',
    },
    {
      metric:          'request_duration_seconds_p95',
      status:          latencyP95 > 2 ? 'FIRING' : 'normal',
      change_pct:      Math.round(latencyP95 * 1000), // represented as ms for readability
      business_impact: 'User experience degradation — high latency causing checkout abandonment',
      likely_cause:    'latency injection active or downstream service/DB degradation',
      severity:        latencyP95 > 2 ? 'critical' : latencyP95 > 1 ? 'warning' : 'info',
    },
    {
      metric:          'checkout_to_order_ratio',
      status:          checkoutConversion < 0.3 ? 'FIRING' : 'normal',
      change_pct:      Math.round(checkoutConversion * 100),
      business_impact: 'Conversion funnel collapse — users abandoning after checkout start',
      likely_cause:    'payment failures or high latency at payment step causing drop-off',
      severity:        checkoutConversion < 0.3 ? 'critical' : checkoutConversion < 0.6 ? 'warning' : 'info',
    },
  ];
}

app.get('/anomalies', async (req, res) => {
  try {
    const anomalies = await detectAnomalies();
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
function printReport(anomalies) {
  const SEVERITY_ICON = { critical: '🔴', warning: '🟡', info: '🟢' };
  const line          = '─'.repeat(72);
  const ts            = new Date().toISOString();

  console.log('\n' + line);
  console.log(`  🔍  ANOMALY DETECTION REPORT  ·  ${ts}`);
  console.log(line);

  for (const a of anomalies) {
    const icon = SEVERITY_ICON[a.severity] || '⚪';
    const flag = a.status === 'FIRING' ? ' ◀ FIRING' : '';
    console.log(`\n  ${icon}  [${a.severity.toUpperCase()}]  ${a.metric}${flag}`);
    console.log(`       Status         : ${a.status}`);
    console.log(`       Change         : ${a.change_pct}%`);
    console.log(`       Business Impact: ${a.business_impact}`);
    console.log(`       Likely Cause   : ${a.likely_cause}`);
  }

  const firing = anomalies.filter((a) => a.status === 'FIRING').length;
  console.log('\n' + line);
  console.log(
    `  Summary: ${firing} FIRING  ·  ${anomalies.length - firing} normal` +
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
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
