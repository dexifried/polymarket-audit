import asyncio
from datetime import datetime
import os
import json
import re
import subprocess
from pathlib import Path
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse
import uvicorn

SKILL_ROOT = Path(os.getenv('SKILL_ROOT', '/root/.openclaw/workspace/skills/polymarket-trading.skill'))
WAL_PATH = SKILL_ROOT / 'wal' / 'log.jsonl'
MEMORY_DIR = SKILL_ROOT / 'memory'
CONFIG_DIR = SKILL_ROOT / 'config'
SCRIPTS_DIR = SKILL_ROOT / 'scripts'
SERVICES_DIR = SKILL_ROOT / 'services'
STATIC_DIR = SERVICES_DIR / 'static'
LOGS_DIR = SKILL_ROOT / 'logs'
PIDS_DIR = SKILL_ROOT / 'var' / 'pids'
AGENTS_DIR = SCRIPTS_DIR / 'agents'

SAFE_CONFIG_RE = re.compile(r'^[A-Za-z0-9._-]+\.json$')
SUPPORTED_AGENTS = {'signal', 'execution', 'risk', 'scheduler', 'ws_market_connector'}
ALLOWED_LOG_FILES = {'agent', 'metrics', 'signal', 'execution', 'risk', 'scheduler', 'ws_market_connector', 'trading', 'api_server'}
WS_MAX_CONNECTIONS = int(os.getenv('WS_MAX_CONNECTIONS', '10'))
WS_AUTH_TOKEN = os.getenv('API_TOKEN') or os.getenv('DASHBOARD_WS_TOKEN')
ACTIVE_WS_CONNECTIONS = set()
WS_CONNECTIONS_LOCK = asyncio.Lock()

app = FastAPI(title="DEX_POLYGRAPH API")


def resolve_under_dir(base_dir: Path, candidate: Path) -> Path:
    base_resolved = base_dir.resolve(strict=False)
    candidate_resolved = candidate.resolve(strict=False)
    try:
        candidate_resolved.relative_to(base_resolved)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='Invalid path') from exc
    return candidate_resolved


def require_supported_agent(name: str) -> str:
    if name not in SUPPORTED_AGENTS:
        raise HTTPException(status_code=404, detail='Unknown agent')
    return name


def get_ws_token(websocket: WebSocket) -> str | None:
    auth_header = websocket.headers.get('authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:].strip()
    return websocket.query_params.get('token')


async def register_ws_connection(websocket: WebSocket) -> bool:
    async with WS_CONNECTIONS_LOCK:
        if len(ACTIVE_WS_CONNECTIONS) >= WS_MAX_CONNECTIONS:
            return False
        ACTIVE_WS_CONNECTIONS.add(id(websocket))
        return True


async def unregister_ws_connection(websocket: WebSocket) -> None:
    async with WS_CONNECTIONS_LOCK:
        ACTIVE_WS_CONNECTIONS.discard(id(websocket))

# Helper: run node script and capture JSON stdout
def run_node_script(script_name: str, *args):
    cmd = ['node', str(SCRIPTS_DIR / script_name), *args]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr or f'Script {script_name} failed')
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return result.stdout

# --- Static UI ---
@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / 'index.html'))

@app.get("/mobile")
def mobile():
    return FileResponse(str(STATIC_DIR / 'mobile.html'))

# --- Metrics proxy ---
@app.get("/metrics")
def metrics():
    # Assume metrics sidecar runs on localhost:9091/metrics
    import httpx
    try:
        r = httpx.get('http://127.0.0.1:9091/metrics')
        return HTMLResponse(r.text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f'Metrics sidecar unreachable: {e}')

# --- WAL tail ---
@app.get("/wal/recent")
def wal_recent(source: str = None, limit: int = 50):
    if not WAL_PATH.exists():
        return []
    entries = []
    with open(WAL_PATH, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                if source and e.get('source') != source:
                    continue
                entries.append(e)
            except json.JSONDecodeError:
                continue
    return entries[-limit:]

# --- WAL WebSocket ---
@app.websocket("/ws/wal")
async def ws_wal(websocket: WebSocket):
    if not WS_AUTH_TOKEN or get_ws_token(websocket) != WS_AUTH_TOKEN:
        await websocket.close(code=1008)
        return
    if not await register_ws_connection(websocket):
        await websocket.close(code=1013)
        return
    await websocket.accept()
    try:
        if not WAL_PATH.exists():
            await websocket.close(code=1000)
            return
        with open(WAL_PATH, 'r') as f:
            f.seek(0, os.SEEK_END)
            while True:
                line = f.readline()
                if not line:
                    await asyncio.sleep(1)
                    continue
                try:
                    entry = json.loads(line)
                    await websocket.send_json(entry)
                except json.JSONDecodeError:
                    continue
    except WebSocketDisconnect:
        pass
    finally:
        await unregister_ws_connection(websocket)

# --- Positions ---
@app.get("/positions")
def get_positions():
    # Read last line from memory/position_summary.jsonl if exists
    pos_file = MEMORY_DIR / 'position_summary.jsonl'
    if not pos_file.exists():
        return []
    with open(pos_file, 'r') as f:
        lines = f.readlines()
        if not lines:
            return []
        return json.loads(lines[-1])

# --- Equity curve stub ---
@app.get("/equity")
def equity(range: str = '1h'):
    # Stub: return zeros
    return {"range": range, "equity": []}

# --- Market data via existing scripts ---
@app.get("/market/{tokenId}/orderbook")
def market_orderbook(tokenId: str):
    out = run_node_script('get_orderbook.js', tokenId)
    return out

@app.get("/market/{tokenId}/midpoint")
def market_midpoint(tokenId: str):
    out = run_node_script('get_midpoint.js', tokenId)
    return out

# --- Order submission via WAL (for UI) ---
@app.post("/order")
async def place_order(order: dict):
    # Expected: { tokenId, outcome, price, size }
    # Append to WAL with source='ui' so execution agent picks it up
    payload = {
        'source': 'ui',
        'type': 'signal',  # or a dedicated 'order_request' if you prefer
        'tokenId': order['tokenId'],
        'outcome': order['outcome'],
        'price': order['price'],
        'size': order['size'],
        'timestamp': datetime.utcnow().isoformat() + 'Z'
    }
    # Use Node wrapper to preserve seq
    proc = subprocess.Popen(
        ['node', str(SERVICES_DIR / 'wal_append.js')],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    stdin_data = (json.dumps(payload) + '\n').encode()
    stdout, stderr = proc.communicate(stdin_data)
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=stderr.decode())
    return {"status": "accepted", "entry": payload}

# --- Risk controls ---
@app.post("/risk/stop")
async def risk_stop():
    payload = {'source': 'risk', 'type': 'STOP', 'timestamp': datetime.utcnow().isoformat() + 'Z'}
    proc = subprocess.Popen(
        ['node', str(SERVICES_DIR / 'wal_append.js')],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    proc.communicate((json.dumps(payload) + '\n').encode())
    return {"status": "stopped"}

@app.post("/risk/reset")
async def risk_reset():
    payload = {'source': 'risk', 'type': 'RESET', 'timestamp': datetime.utcnow().isoformat() + 'Z'}
    proc = subprocess.Popen(
        ['node', str(SERVICES_DIR / 'wal_append.js')],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    proc.communicate((json.dumps(payload) + '\n').encode())
    return {"status": "reset"}

# --- Logs tail ---
@app.get("/logs")
def logs(file: str = 'agent', limit: int = 100):
    if file not in ALLOWED_LOG_FILES:
        raise HTTPException(status_code=404, detail='Log file not found')
    log_file = resolve_under_dir(LOGS_DIR, LOGS_DIR / f'{file}.log')
    if not log_file.exists():
        raise HTTPException(status_code=404, detail='Log file not found')
    lines = []
    with open(log_file, 'r') as f:
        all_lines = f.readlines()
        lines = all_lines[-limit:]
    return {"file": str(log_file), "lines": lines}

# --- Config get/put ---
@app.get("/config")
def get_config():
    # Return all JSON files under config/
    cfg = {}
    if CONFIG_DIR.exists():
        for p in CONFIG_DIR.glob('*.json'):
            with open(p) as f:
                cfg[p.name] = json.load(f)
    return cfg

@app.put("/config/{name}")
def put_config(name: str, data: dict):
    if not SAFE_CONFIG_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail='Invalid config name')
    dest = resolve_under_dir(CONFIG_DIR, CONFIG_DIR / name)
    if not dest.parent.exists():
        dest.parent.mkdir(parents=True)
    with open(dest, 'w') as f:
        json.dump(data, f, indent=2)
    return {"status": "saved", "file": name}

# --- Agent status/control ---
@app.get("/agents/status")
def agents_status():
    # Check for PID files in var/pids or use pgrep
    pids_dir = SKILL_ROOT / 'var' / 'pids'
    status = {}
    for agent in ['signal', 'execution', 'risk', 'scheduler', 'ws_market_connector']:
        pid_file = pids_dir / f'{agent}.pid'
        if pid_file.exists():
            try:
                pid = int(pid_file.read_text().strip())
                # Check if process exists
                os.kill(pid, 0)
                status[agent] = {'running': True, 'pid': pid}
            except (OSError, ValueError):
                status[agent] = {'running': False, 'pid': None}
        else:
            status[agent] = {'running': False, 'pid': None}
    return status

@app.post("/agents/{name}/start")
def agent_start(name: str):
    name = require_supported_agent(name)
    script = resolve_under_dir(AGENTS_DIR, AGENTS_DIR / f'{name}_agent.js')
    if not script.exists():
        raise HTTPException(status_code=404, detail='Agent script not found')
    # Start in background, write PID file
    PIDS_DIR.mkdir(parents=True, exist_ok=True)
    pid_file = resolve_under_dir(PIDS_DIR, PIDS_DIR / f'{name}.pid')
    # Use setsid to fully daemonize
    proc = subprocess.Popen(
        ['node', str(script)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True
    )
    pid_file.write_text(str(proc.pid))
    return {"status": "started", "pid": proc.pid}

@app.post("/agents/{name}/stop")
def agent_stop(name: str):
    name = require_supported_agent(name)
    pid_file = resolve_under_dir(PIDS_DIR, PIDS_DIR / f'{name}.pid')
    if not pid_file.exists():
        raise HTTPException(status_code=404, detail='PID file not found')
    pid = int(pid_file.read_text().strip())
    try:
        os.kill(pid, 15)  # SIGTERM
        pid_file.unlink(missing_ok=True)
        return {"status": "stopped", "pid": pid}
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=8000)
