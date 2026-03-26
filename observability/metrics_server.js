// Lightweight Prometheus metrics server for polymarket-trading skill
// Requires: prom-client (very small)

const http = require('http');
const client = require('prom-client');

// Default metrics
client.collectDefaultMetrics({ prefix: 'polymarket_' });

// Custom metrics
const signalsProcessed = new client.Counter({
  name: 'polymarket_signals_processed_total',
  help: 'Total number of signals processed'
});

const ordersPlaced = new client.Counter({
  name: 'polymarket_orders_placed_total',
  help: 'Total number of orders placed'
});

const fillsReceived = new client.Counter({
  name: 'polymarket_fills_received_total',
  help: 'Total number of fills received'
});

const currentExposure = new client.Gauge({
  name: 'polymarket_current_exposure',
  help: 'Current net exposure (USD)'
});

const consecutiveLosses = new client.Gauge({
  name: 'polymarket_consecutive_losses',
  help: 'Current number of consecutive losing trades'
});

const walLagBytes = new client.Gauge({
  name: 'polymarket_wal_lag_bytes',
  help: 'WAL lag in bytes behind tail'
});

const agentUptimeSeconds = new client.Gauge({
  name: 'polymarket_agent_uptime_seconds',
  help: 'Agent uptime in seconds'
});

const agentErrorsTotal = new client.Counter({
  name: 'polymarket_agent_errors_total',
  help: 'Total number of agent errors'
});

// Expose a simple HTTP endpoint that other agents/sidecars can push/update
const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    res.setHeader('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
    return;
  }

  // Simple API to increment/set metrics from agents
  if (req.url === '/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        // Allowed fields: signals, orders, fills, exposure, losses, wal_lag, errors
        if (payload.signals) signalsProcessed.inc(payload.signals);
        if (payload.orders) ordersPlaced.inc(payload.orders);
        if (payload.fills) fillsReceived.inc(payload.fills);
        if (typeof payload.exposure === 'number') currentExposure.set(payload.exposure);
        if (typeof payload.losses === 'number') consecutiveLosses.set(payload.losses);
        if (typeof payload.wal_lag === 'number') walLagBytes.set(payload.wal_lag);
        if (payload.errors) agentErrorsTotal.inc(payload.errors);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/healthz') {
    res.writeHead(200, {'Content-Type':'text/plain'});
    res.end('ok');
    return;
  }

  res.writeHead(404);
  res.end();
});

const PORT = process.env.METRICS_PORT || 9464;
server.listen(PORT, () => {
  console.log(`polymarket metrics server listening on ${PORT}`);
});

// Update uptime gauge periodically
const start = Date.now();
setInterval(() => {
  agentUptimeSeconds.set((Date.now() - start) / 1000);
}, 5000);

module.exports = {
  signalsProcessed,
  ordersPlaced,
  fillsReceived,
  currentExposure,
  consecutiveLosses,
  walLagBytes,
  agentUptimeSeconds,
  agentErrorsTotal
};
