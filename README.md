Polymarket Trading Skill — Quickstart Guide

Overview

This skill is a multi-agent trading toolkit built on the OpenClaw DEX framework. It combines several cooperating agents and services to automate market data collection, strategy execution, and observability. Core concepts you'll see throughout the repo:

- Multi-agent: The system uses small specialized agents (data collectors, strategists, execution agents, watchers) that communicate via the WAL (Write-Ahead Log) and an ontology-backed memory store. This lets agents be independently developed and restarted without losing coordination.
- WAL (Write-Ahead Log): A persistent event log used for reliable inter-agent messaging and orchestration. When an agent publishes an event (new price tick, signal, order attempt), the WAL records it; other agents read and react. WAL ensures replayability, crash recovery, and auditability.
- Ontology: A typed knowledge graph used as the system's structured memory (entities like Market, Position, Order, Strategy, Agent). The ontology enables consistent reads/writes and simple queries across agents.

What this guide covers

- Install and run the skill locally
- Setup required environment variables
- Run initial auth/setup scripts
- Start agents (docker-compose or direct node run)
- Overview of key scripts and agents in the repo
- Config reference and common troubleshooting tips
- Links to full docs for advanced topics

Quick start (minimal)

1) Clone / prepare workspace
   - Put this skill under your OpenClaw workspace at ~/ .openclaw/workspace/skills/polymarket-trading.skill
   - Working dir used in examples: /root/.openclaw/workspace

2) Install dependencies
   - Node-based services: run
     npm ci
     or
     yarn install
   from the skill directory if package.json is present.
   - Python helpers (if any): create a venv and pip install -r requirements.txt

3) Create .env
   - Copy the template (if present): cp .env.example .env
   - At minimum set:
     - WAL_URL=http://localhost:9000       # URL for WAL service (or local file path)
     - ONTOLOGY_URL=http://localhost:8001  # Ontology API endpoint
     - POLY_API_KEY=your_polymarket_api_key  # (if interacting with Polymarket or data provider)
     - NODE_ENV=development
     - LOG_LEVEL=info
     - AGENT_ID=polymarket-trader.local
   - See Configuration reference below for full list.

4) Run setup_auth
   - If the repo provides a setup_auth script, run it to register agent identities, create API keys, or seed the ontology:
     node scripts/setup_auth.js
   - Some repos use bash: ./scripts/setup_auth.sh
   - Review the script before running; it may require interactive input or to write to .env.

5) Start services / agents

Option A — docker-compose (recommended for isolated run)
   - If docker-compose.yml exists in the repo:
     docker compose up --build
   - This starts WAL, ontology API, and all registered agents as containers.
   - Use docker compose logs -f to tail logs.

Option B — Run agents directly (development)
   - Start WAL and ontology services first (or point .env to hosted services)
   - Run agents from the skill dir:
     # one-off
     NODE_ENV=development node src/agent-data.js
     # or run a process manager (foreman, pm2)
     npm run start:all
   - Use nodemon during development for auto-restart:
     npx nodemon --watch src --exec "node src/agent-xxx.js"

6) Verify
   - Tail logs (docker or local) and confirm agents connect to WAL and ontology.
   - Look for startup messages: "Connected to WAL", "Ontology ready", "Agent registered: <AGENT_ID>".

Core scripts & agents

- scripts/setup_auth.js (or .sh)
  Registers agent identities, writes API keys to .env, and may seed the ontology with initial Markets/Strategies.

- src/agent-data.js
  Market data collector — fetches prices/ticks from Polymarket or configured feed and writes events to WAL.

- src/agent-strategy.js
  Strategy evaluator — subscribes to WAL events, computes signals, and writes trade intents back to WAL or the Orders API.

- src/agent-executor.js
  Execution agent — turns intents into concrete orders, submits to an exchange or mock executor, and records order lifecycle updates.

- src/agent-watcher.js
  Observability & safety — watches positions, risk limits, and may cancel or pause trading under defined conditions.

- scripts/health_check.js
  Simple script to confirm WAL and Ontology endpoints are reachable and basic entity queries succeed.

Configuration reference

Environment variables (common)
- WAL_URL — Required. WAL service URL (http://host:port) or storage path.
- ONTOLOGY_URL — Required. Ontology API endpoint used for typed entity reads/writes.
- POLY_API_KEY — Optional but required if using Polymarket API or another data provider.
- AGENT_ID — Identifier for this agent instance. Use a unique value per process.
- NODE_ENV — development|production
- LOG_LEVEL — debug|info|warn|error
- EXECUTOR_MODE — mock|live (controls whether orders are sent to a real/external execution system)
- RISK_MAX_POSITION — numeric; maximum allowed position size
- DB_URL — optional DB connection string for persistent state if used

Files and locations
- .env — local environment variables (gitignored)
- docker-compose.yml — compose orchestration (if present)
- scripts/ — helper scripts (setup_auth, migrations, health checks)
- src/ — agent source files
- config/default.json or config/*.json — static config read by agents

Troubleshooting common issues

- Agents not connecting to WAL
  - Confirm WAL_URL in .env is correct and reachable.
  - If using docker-compose, ensure the WAL service has fully started before agents (docker compose logs). The WAL often binds to a port; check with ss or netstat.
  - Check network mode: containers in different networks won't see each other unless compose sets networks correctly.

- Ontology connection errors
  - Ensure ONTOLOGY_URL is correct and the ontology service is running.
  - Check CORS or auth requirements if the ontology is hosted separately.

- setup_auth prompts for approval or errors
  - Read the script; it may output commands you need to copy into an external console (API provider). If the setup asks for admin credentials, provide those or run as a user with permissions.

- Orders not executing / stuck in "intent"
  - Check EXECUTOR_MODE; in mock mode orders are only simulated.
  - Check logs for execution agent and any rate-limiting or auth failures with the exchange API.

- High CPU / memory in local dev
  - Use NODE_ENV=development and reduce polling intervals.
  - Run only the agents you need for testing; avoid spinning up the full suite.

- WAL replay & duplicate processing
  - Agents should idempotently handle WAL events. If you see duplicates after a restart, ensure each agent persists its last-read WAL index (or uses the ontology to store last-processed event id).

Observability & logs

- Logs: By default agents log to stdout. Use a process manager or docker-compose to aggregate logs. Set LOG_LEVEL=debug for deeper traces.
- Metrics: If configured, agents may expose /metrics (Prometheus). Check OBSERVABILITY.md for details on metrics, traces, and dashboards.

Advanced: running with process managers

- pm2: pm2 start ecosystem.config.js
- foreman (Procfile): nf start

Security & secrets

- Keep .env out of git. Use secrets manager or environment injection for production deployments.
- Rotate API keys and avoid storing long-lived secrets in code.

Where to go next

- DEPLOY.md — production deployment, systemd, and orchestration notes
- OBSERVABILITY.md — metrics, tracing, dashboards, and alerting
- SKILL.md — skill metadata, intents, and OpenClaw integration details

If something's missing

If you follow this guide and still can't get the skill running, open an issue or attach logs from the agent that failed. Helpful logs include the agent's startup log (first 200 lines) and any stack traces.

License & contrib

Follow the repository's LICENSE and CONTRIBUTING guidelines. If you add a new agent, include a short README and add it to docker-compose.yml and start scripts.

Contact

For questions about the skill internals, ask in the main OpenClaw conversation or the project owner listed in SKILL.md.
