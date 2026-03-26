OBSERVABILITY.md

Overview
--------
This folder contains a lightweight Prometheus metrics sidecar and a Grafana dashboard JSON for the polymarket-trading skill.

What I added
------------
- metrics_server.js — small Node.js server using prom-client exposing Prometheus metrics at /metrics and a simple update API at POST /update
- package.json — minimal dependency (prom-client)
- grafana_dashboard.json — importable Grafana dashboard (basic panels)

Quick start (sidecar)
---------------------
1. Install deps and run:

   cd skills/polymarket-trading.skill/observability
   npm install
   METRICS_PORT=9464 npm start

2. The server exposes:
   - GET /metrics  — Prometheus scrape endpoint
   - POST /update — JSON payload to increment/set metrics
     Example payloads:
       { "signals": 1 }
       { "orders": 1, "fills": 1 }
       { "exposure": 1250.5, "losses": 2 }
       { "wal_lag": 512345 }

Integration options
-------------------
- Sidecar (recommended): Run metrics_server.js alongside each agent (same host/container). Agents POST updates to http://127.0.0.1:9464/update when events happen.
- In-process: Require the module from your agent code and call the counters/gauges directly. Example:

    const metrics = require('./observability/metrics_server');
    metrics.signalsProcessed.inc();
    metrics.currentExposure.set(123.45);

Prometheus scrape config
------------------------
Add a scrape job to prometheus.yml:

scrape_configs:
  - job_name: 'polymarket_metrics'
    static_configs:
      - targets: ['<HOST>:9464']
    metrics_path: /metrics
    scheme: http

If running multiple agents on same host, use different ports or use service discovery labels.

Grafana dashboard
-----------------
Import grafana_dashboard.json from this folder (Dashboard: Polymarket Trading Overview).

Panels included:
- Signals processed (rate)
- Orders placed (rate)
- Fills received (rate)
- Current exposure (gauge)
- Consecutive losses (gauge + threshold alert visual)
- WAL lag (gauge)
- Agent uptime
- Agent errors (counter)

Notes & best practices
----------------------
- Keep metrics cardinality low — do not label with unbounded IDs (order ids, tx ids).
- Use gauges for current state (exposure, losses, wal_lag), counters for totals (signals, orders, errors).
- For P&L/time series combine order/fills with application-level P&L events and export as gauge or summary from the agent.
- If you prefer Prometheus Pushgateway for short-lived agents, adapt the /update endpoint to forward to pushgateway or push directly from agents.

Security
--------
- If exposed across network, protect the /update endpoint (simple token or mTLS).

Support
-------
If you want, I can:
- Add a Dockerfile to run the sidecar
- Add example instrumentation snippets for the agent codebase
- Wire a basic Prometheus docker-compose + Grafana for local testing
