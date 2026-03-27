# Polymarket Dashboard Backend Audit

Scope reviewed:
- `/tmp/polymarket-audit/dashboard/app/main.py`
- `/tmp/polymarket-audit/dashboard/services/api_server.py`
- `/tmp/polymarket-audit/dashboard/app/requirements.txt`

## Executive Summary

The highest-risk issues are in `services/api_server.py`. It exposes unauthenticated endpoints that can submit orders, stop/reset risk controls, start/stop agents, and overwrite on-disk configuration. Several of those write/control paths also accept unsanitized path fragments, which enables directory traversal and, in practice, arbitrary file write plus arbitrary process control under the service account.

`app/main.py` is mostly read-only, but it still exposes sensitive operational data without authentication and includes an unauthenticated state-changing endpoint (`/api/chill-mode/toggle`) that can alter trading behavior. The frontend rendering in `app/main.py` consistently escapes user-controlled values, so no direct reflected/stored XSS was identified in the reviewed code.

## Findings

### 1. Unauthenticated order and control plane endpoints allow remote trading and process control
- File: `services/api_server.py`
- Lines: 129-178, 205-212, 234-265
- Severity: P0
- Type: Auth bypass / business logic abuse
- Description: The API exposes state-changing endpoints with no authentication or authorization:
  - `POST /order` appends a WAL entry intended for execution.
  - `POST /risk/stop` and `POST /risk/reset` alter risk state.
  - `PUT /config/{name}` overwrites runtime config files.
  - `POST /agents/{name}/start` and `POST /agents/{name}/stop` control background agents.
  Any network client that can reach this service can issue trades, disable protections, change configuration, or stop execution components.
- Fix: Require strong authentication on all non-read-only endpoints. Add per-endpoint authorization checks so only an operator/admin role can trade, change config, or manage agents. If the dashboard is intended for localhost only, bind to loopback and place it behind an authenticated reverse proxy.

### 2. Arbitrary file write via path traversal in `PUT /config/{name}`
- File: `services/api_server.py`
- Lines: 205-212
- Severity: P1
- Type: Path traversal / arbitrary file write
- Description: `dest = CONFIG_DIR / name` uses untrusted `name` directly. Path segments like `../` are not rejected or normalized against `CONFIG_DIR`, so an attacker can write outside the config directory anywhere the service account can write. Because the code also creates parent directories, traversal is not naturally blocked by missing directories.
- Impact: An attacker can overwrite service data, PID files, static assets, or other JSON/config files reachable by the process. This also compounds with the agent stop endpoint to enable arbitrary process termination by planting crafted `.pid` files.
- Fix: Restrict `name` to a safe filename allowlist such as `^[A-Za-z0-9._-]+\.json$`, resolve the candidate path with `.resolve()`, and reject any path whose resolved parent is outside `CONFIG_DIR.resolve()`.

### 3. Arbitrary file read via path traversal in `GET /logs`
- File: `services/api_server.py`
- Lines: 181-192
- Severity: P1
- Type: Path traversal / sensitive file exposure
- Description: `log_file = log_dir / f'{file}.log'` uses attacker-controlled `file` without validation. Traversal sequences such as `../../some/other/path` can escape `log_dir` and read arbitrary `.log` files accessible to the process.
- Fix: Accept only a fixed allowlist of known log names, or validate `file` against a strict basename regex and confirm the resolved path stays under `log_dir.resolve()`.

### 4. Agent start endpoint can execute unintended scripts via path traversal
- File: `services/api_server.py`
- Lines: 234-253
- Severity: P1
- Type: Path traversal / arbitrary code execution surface
- Description: `script = SCRIPTS_DIR / 'agents' / f'{name}_agent.js'` trusts `name`. Traversal strings can escape the intended `agents/` directory and cause the service to execute any existing `*_agent.js` file the Node runtime can read. Because this endpoint is also unauthenticated, it creates a remote process-execution primitive against the local codebase.
- Fix: Replace the path construction with an allowlist of supported agent names, e.g. `{'signal', 'execution', 'risk', 'scheduler', 'ws_market_connector'}`. Resolve and verify the final path remains inside the intended agents directory before execution.

### 5. Agent stop endpoint can terminate arbitrary processes when combined with crafted PID paths
- File: `services/api_server.py`
- Lines: 255-265
- Severity: P1
- Type: Path traversal / arbitrary process kill
- Description: `pid_file = SKILL_ROOT / 'var' / 'pids' / f'{name}.pid'` trusts `name`. Traversal can escape the PID directory and target arbitrary `.pid` files. Since the handler reads the integer and passes it to `os.kill`, an attacker who can plant or reference such a file can terminate unintended processes. The `PUT /config/{name}` traversal bug makes this easier by allowing attacker-controlled file creation.
- Fix: Use the same allowlist as the start endpoint, store PID metadata in a directory not writable by unrelated endpoints, and verify the resolved PID path remains under the PID directory.

### 6. CORS policy is dangerously over-permissive for an administrative API
- File: `services/api_server.py`
- Lines: 18-25
- Severity: P1
- Type: CORS misconfiguration
- Description: The server enables `allow_origins=["*"]`, `allow_methods=["*"]`, `allow_headers=["*"]`, and `allow_credentials=True`. For a dashboard API that includes write endpoints, this is an unsafe default. Even where browsers reject wildcard-plus-credentials combinations, the effective posture is still “any origin may script this API” for non-credentialed requests, which is especially dangerous because the API has no auth at all.
- Fix: Set an explicit allowlist of trusted dashboard origins, disable credentials unless strictly required, and do not expose administrative/write endpoints cross-origin.

### 7. WebSocket endpoint has no auth, no connection limits, and no disconnect/backpressure handling
- File: `services/api_server.py`
- Lines: 79-97
- Severity: P2
- Type: WebSocket DoS / connection management weakness
- Description: `/ws/wal` accepts every connection, opens a file handle per client, and loops forever with no client authentication, connection cap, heartbeat timeout, or handling for disconnect/send failures. An attacker can open many sockets and force the service to hold many long-lived tasks/file descriptors. There is also no per-message filtering, so all WAL entries are broadcast in full.
- Fix: Require authentication before `accept()`, track active connections, enforce per-IP and global connection limits, handle `WebSocketDisconnect` and send failures, and consider using a single producer task with bounded fan-out queues instead of one WAL tailer per client.

### 8. Sensitive operational data is exposed without authentication across both backends
- File: `services/api_server.py`
- Lines: 59-76, 98-125, 181-203, 215-232
- Severity: P1
- Type: Sensitive data exposure
- Description: The API exposes recent WAL entries, positions, market data, logs, full config JSON, and agent PIDs/status to any caller. WAL/log/config data commonly contains strategy details, identifiers, and operational state that materially lowers the cost of attacking or front-running the system.
- Fix: Treat all of these endpoints as authenticated operator APIs. Split public telemetry from administrative data, redact secrets/identifiers from logs and config responses, and avoid returning filesystem paths and PIDs to untrusted clients.

### 9. `app/main.py` exposes internal memory, model routing, and trading telemetry without auth
- File: `app/main.py`
- Lines: 236-244, 247-304, 971-1180
- Severity: P1
- Type: Sensitive data exposure
- Description: `build_provider_summary()` reveals which provider secrets are configured; `build_payload()` returns account state, open positions, strategy details, context cache, ambiguity/watchdog outputs, and routing data; the `/api/memory/*`, `/api/memory/daily`, `/api/memory/learnings`, `/api/memory/evolver`, and `/api/neural/events` endpoints expose local notes, memory files, learnings, and event streams. This is highly sensitive operational data and may include private notes or secrets copied into memory files.
- Fix: Put the dashboard behind authentication, remove or heavily redact memory endpoints in production, and separate private operator diagnostics from the user-facing dashboard API.

### 10. Unauthenticated state-changing endpoint can alter trading behavior in `app/main.py`
- File: `app/main.py`
- Lines: 1183-1195
- Severity: P1
- Type: Auth bypass / business logic abuse
- Description: `POST /api/chill-mode/toggle` flips `chill_mode.json` with no authentication, CSRF protection, or origin checks. A remote caller can repeatedly toggle the bot between live and chill behavior, which directly affects execution and provider selection.
- Fix: Require authentication and authorization for the toggle, add CSRF protection if it is browser-driven, and ideally replace “toggle” semantics with an explicit idempotent state-setting API that includes audit logging of the operator identity.

### 11. Internal exception details and stderr are returned to clients
- File: `services/api_server.py`
- Lines: 31-32, 55-56, 151-152, 265-266
- Severity: P3
- Type: Error leakage
- Description: The API returns raw subprocess stderr and Python exception strings to clients. Those messages can expose internal filesystem paths, script names, stack context, and operational details that help an attacker refine follow-on exploits.
- Fix: Log detailed errors server-side, return generic client-facing error messages, and include a correlation ID if operators need to trace failures.

## Category Notes

### Security checks requested
- SQL injection: No SQL usage was identified in the reviewed files.
- Command injection: No shell-based command injection was found; subprocess calls use argument lists rather than `shell=True`. The main command-execution risk is path traversal into unintended scripts, not shell metacharacter injection.
- SSRF: No user-controlled SSRF sink was found. `/metrics` only calls a fixed `http://127.0.0.1:9091/metrics` endpoint.
- Path traversal: Present in `services/api_server.py` as described above.
- Auth bypass: Present on all write/control endpoints and many sensitive read endpoints.
- CSRF: The administrative endpoints have no auth, so they are already directly callable by any network client. If browser auth is added later, CSRF protections will still be required.
- CORS misconfiguration: Present in `services/api_server.py`.

### WebSocket handling
- `services/api_server.py:/ws/wal` is the main concern: no auth, no limits, no disconnect handling, one tailer per client.
- `app/main.py:/api/neural/events` is SSE rather than WebSocket, but it has a similar exposure problem: it streams internal event and memory content to any caller and has no rate limiting or connection caps.

### File serving
- Fixed-file responses for `/`, `/mobile`, `/three.module.js`, `/OrbitControls.js`, and `/neural` do not introduce obvious path traversal because the served paths are hard-coded.
- No directory listing behavior was found in the reviewed code.

### XSS / template injection
- In `app/main.py`, the dashboard HTML uses an `esc()` helper before inserting user-controlled values into `innerHTML`. Based on the reviewed code paths, direct reflected/stored XSS was not identified.
- No server-side template engine or template injection sink was found.

### Credential handling
- `app/main.py` does not return secret values directly, but it does reveal provider-key presence and operational routing state.
- The larger risk is indirect exposure through memory/log/config endpoints, which may contain sensitive tokens or operator notes if those files ever store them.

### Dependency posture
- `app/requirements.txt` contains only unpinned `fastapi` and `uvicorn`. This is not a direct code vulnerability by itself, but it weakens reproducibility and patch hygiene.
- Fix: pin versions and use a dependency management workflow that tracks security updates.

## Recommended Remediation Order
1. Remove network exposure or put both apps behind authentication immediately.
2. Disable or remove `POST /order`, risk-control, config, and agent-management endpoints until authz is in place.
3. Fix path traversal in `/config`, `/logs`, and `/agents/*` using allowlists plus resolved-path containment checks.
4. Lock down CORS to trusted origins only.
5. Add connection limits/auth for `/ws/wal` and `/api/neural/events`.
6. Remove or redact memory/log/config/provider-routing disclosures from production responses.
