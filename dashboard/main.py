from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from pathlib import Path
from datetime import datetime, timezone
import asyncio
import json
import time

app = FastAPI(title="Polymarket Paper Trading Dashboard")

POLY_DIR = Path(__file__).parent.parent
PAPER_DIR = POLY_DIR / "memory" / "paper"
ACCOUNT_PATH = PAPER_DIR / "account.json"
DECISIONS_PATH = PAPER_DIR / "decisions.jsonl"
TRADES_PATH = PAPER_DIR / "trades.jsonl"
REGIME_PATH = PAPER_DIR / "regime_states.jsonl"
TRANSITION_PATH = PAPER_DIR / "transition_model.json"
POLYGLOBE_PATH = PAPER_DIR / "polyglobe_intel_cache.json"
WATCHDOG_PATH = PAPER_DIR / "qwen_watchdog_latest.json"
WATCHDOG_LOG_PATH = PAPER_DIR / "qwen_watchdog.jsonl"
CONTEXT_CACHE_PATH = PAPER_DIR / "qwen_context_cache.json"
AMBIGUITY_PATH = PAPER_DIR / "ambiguity_judge_latest.json"
BATCH_LABELS_PATH = PAPER_DIR / "batch_labels_latest.json"
DEX_REVIEW_PATH = PAPER_DIR / "dex_review.json"
DEX_CALL_PATH = PAPER_DIR / "dex_call.json"
HF_EXPORT_PATH = PAPER_DIR.parent.parent / "references" / "hf_exports" / "paper_training_data.jsonl"
ROUTING_PATH = PAPER_DIR.parent.parent / "config" / "model_routing.json"
CHILL_MODE_PATH = PAPER_DIR / "chill_mode.json"
ATOMIC_FACTS_PATH = PAPER_DIR / "atomic_facts.jsonl"
FORESIGHTS_PATH = PAPER_DIR / "foresights.jsonl"
PROFILES_PATH = PAPER_DIR / "agent_profiles.json"
NEURAL_HTML_PATH = Path(__file__).parent / "neural.html"
THREE_JS_PATH = Path(__file__).parent / "three.module.js"
ORBIT_JS_PATH = Path(__file__).parent / "OrbitControls.js"


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        return {"error": f"Failed to read {path.name}: {exc}"}


def load_jsonl(path: Path, limit: int | None = None):
    if not path.exists():
        return []
    items = []
    try:
        with path.open("r") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    items.append(json.loads(line))
                except Exception:
                    items.append({"error": "invalid_jsonl_line", "raw": line[:500]})
        return items[-limit:] if limit is not None else items
    except Exception as exc:
        return [{"error": f"Failed to read {path.name}: {exc}"}]


def load_text(path: Path, default: str = ""):
    if not path.exists():
        return default
    try:
        return path.read_text()
    except Exception as exc:
        return f"{{\"error\": \"Failed to read {path.name}: {exc}\"}}\n"


def env_has(key: str) -> bool:
    import os
    if os.environ.get(key):
        return True
    env_path = Path("/root/.openclaw/workspace/.env")
    if env_path.exists():
        prefix = f"{key}="
        try:
            return any(line.startswith(prefix) and line.strip() != prefix for line in env_path.read_text().splitlines())
        except Exception:
            return False
    return False


def parse_ts(value):
    if not value:
        return None
    try:
        from datetime import datetime, timezone
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def seconds_since(value):
    from datetime import datetime, timezone
    dt = parse_ts(value)
    if not dt:
        return None
    return (datetime.now(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds()


AGENT_CALL_WINDOW_SEC = 18
AGENT_ONLINE_WINDOW_SEC = 300


def recently_called(value, window_sec=AGENT_CALL_WINDOW_SEC):
    age = seconds_since(value)
    return age is not None and age <= window_sec


def is_online(value, window_sec=AGENT_ONLINE_WINDOW_SEC):
    age = seconds_since(value)
    return age is not None and age <= window_sec


def file_mtime_iso(path: Path):
    from datetime import datetime, timezone
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def get_state():
    return build_payload()


def parse_any_ts(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except Exception:
            return None
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            return float(value)
        except Exception:
            pass
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None
    return None


def extract_event_ts(row):
    if not isinstance(row, dict):
        return None
    candidates = [
        row.get('ts'), row.get('timestamp'), row.get('createdAt'), row.get('generatedAt'),
        row.get('closedAt'), row.get('openedAt'), row.get('lastUpdated'), row.get('updatedAt'),
        row.get('time')
    ]
    for candidate in candidates:
        parsed = parse_any_ts(candidate)
        if parsed is not None:
            return parsed
    return None


def iter_recent_jsonl(path: Path, last_check: float, limit: int = 300):
    rows = load_jsonl(path, limit=limit)
    recent = []
    for row in rows:
        row_ts = extract_event_ts(row)
        if row_ts is not None:
            if row_ts > last_check:
                recent.append(row)
        elif path.exists() and path.stat().st_mtime > last_check:
            recent.append(row)
    return recent


def sse(event_type: str, data):
    return f"event: {event_type}\ndata: {json.dumps(data, default=str)}\n\n"


def build_agent_graph(account, polyglobe, context_cache, watchdog, ambiguity, batch_labels, provider):
    availability = provider.get("availability", {}) if isinstance(provider, dict) else {}
    watch_ts = watchdog.get("ts") if isinstance(watchdog, dict) else None
    ambiguity_ts = ambiguity.get("ts") if isinstance(ambiguity, dict) else None
    batch_ts = (batch_labels.get("generatedAt") or batch_labels.get("ts")) if isinstance(batch_labels, dict) else None
    trader_ts = account.get("lastCycleAt") if isinstance(account, dict) else None
    collector_ts = polyglobe.get("fetchedAt") if isinstance(polyglobe, dict) else None
    context_ts = context_cache.get("generatedAt") if isinstance(context_cache, dict) else None
    hf_ts = file_mtime_iso(HF_EXPORT_PATH)
    qwen_model = str(watchdog.get("model", "")) if isinstance(watchdog, dict) else ""
    qwen_is_4b = "4b" in qwen_model.lower()
    watchdog_chill = watchdog.get("chillMode", False) if isinstance(watchdog, dict) else False
    chill_mode_on = load_json(CHILL_MODE_PATH, {}).get("enabled", False)

    dex_review = load_json(DEX_REVIEW_PATH, {})
    dex_review_ts = dex_review.get("ts") if isinstance(dex_review, dict) else None
    dex_verdict = dex_review.get("verdict") if isinstance(dex_review, dict) else None

    nodes = [
        {"id": "dex", "label": "Dex", "color": "rainbow", "called": recently_called(dex_review_ts, 1800), "online": is_online(dex_review_ts, 1800), "meta": dex_verdict or "waiting", "king": True},
        {"id": "collector", "label": "Collector", "color": "#22d3ee", "called": recently_called(collector_ts), "online": is_online(collector_ts), "meta": polyglobe.get("fetchedAt")},
        {"id": "retriever", "label": "Retriever", "color": "#60a5fa", "called": recently_called(context_ts), "online": is_online(context_ts), "meta": context_cache.get("methodUsed")},
        {"id": "trader", "label": "Trader", "color": "#22c55e", "called": recently_called(trader_ts), "online": is_online(trader_ts), "meta": account.get("lastCycleAt")},
        {"id": "watchman", "label": "Watchman", "color": "#f59e0b", "called": recently_called(watch_ts), "online": is_online(watch_ts), "meta": watchdog.get("overallVerdict")},
        {"id": "qwenSub", "label": "Qwen 0.8B", "color": "#a78bfa", "called": recently_called(watch_ts) and not qwen_is_4b and not chill_mode_on, "online": is_online(watch_ts), "meta": "🎮 chill" if chill_mode_on else (qwen_model or "idle")},
        {"id": "qwen4b", "label": "Qwen 4B", "color": "#f472b6", "called": recently_called(watch_ts) and qwen_is_4b and not chill_mode_on, "online": is_online(watch_ts), "meta": "🎮 chill" if chill_mode_on else (qwen_model or "idle")},
        {"id": "ambiguity", "label": "Judge", "color": "#ef4444", "called": recently_called(ambiguity_ts), "online": is_online(ambiguity_ts), "meta": ambiguity.get("verdict")},
        {"id": "cerebras", "label": "Cerebras", "color": "#fb7185", "called": recently_called(ambiguity_ts) and str(ambiguity.get("provider", "")).lower() == "cerebras", "online": is_online(ambiguity_ts), "meta": "on" if availability.get("cerebras") else "off"},
        {"id": "sambanova", "label": "Samba", "color": "#38bdf8", "called": recently_called(batch_ts), "online": is_online(batch_ts), "meta": "on" if availability.get("sambanova") else "off"},
        {"id": "hf", "label": "HF Burst", "color": "#f97316", "called": recently_called(hf_ts), "online": is_online(hf_ts), "meta": "on" if availability.get("huggingface") else "off"},
    ]
    edges = [
        ["dex", "trader"],
        ["dex", "watchman"],
        ["dex", "ambiguity"],
        ["collector", "retriever"],
        ["retriever", "watchman"],
        ["trader", "collector"],
        ["trader", "watchman"],
        ["watchman", "qwenSub"],
        ["watchman", "qwen4b"],
        ["trader", "ambiguity"],
        ["ambiguity", "cerebras"],
        ["trader", "sambanova"],
        ["trader", "hf"],
    ]
    return {"nodes": nodes, "edges": edges, "callWindowSec": AGENT_CALL_WINDOW_SEC}


def build_provider_summary():
    availability = {
        "deepinfra": env_has("DEEPINFRA_API_KEY"),
        "cerebras": env_has("CEREBRAS_API_KEY") or env_has("CEREBRAS_KEY"),
        "sambanova": env_has("SAMBANOVA_API_KEY") or env_has("SAMBANOVA_KEY"),
        "huggingface": env_has("HF_TOKEN") or env_has("HUGGINGFACE_TOKEN"),
    }
    routing = load_json(ROUTING_PATH, {})
    return {"routing": routing, "availability": availability}


def build_payload():
    account = load_json(ACCOUNT_PATH, {})
    decisions = load_jsonl(DECISIONS_PATH, limit=40)
    trades = load_jsonl(TRADES_PATH, limit=40)
    regime_states = load_jsonl(REGIME_PATH, limit=40)
    transition_model = load_json(TRANSITION_PATH, {})
    polyglobe = load_json(POLYGLOBE_PATH, {})
    watchdog = load_json(WATCHDOG_PATH, {})
    watchdog_log = load_jsonl(WATCHDOG_LOG_PATH, limit=25)
    context_cache = load_json(CONTEXT_CACHE_PATH, {})
    ambiguity = load_json(AMBIGUITY_PATH, {})
    batch_labels = load_json(BATCH_LABELS_PATH, {})
    provider = build_provider_summary()
    chill_mode = load_json(CHILL_MODE_PATH, {"enabled": False})

    open_positions = account.get("openPositions", []) if isinstance(account, dict) else []
    top_breaking = polyglobe.get("breakingMarkets", [])[:12] if isinstance(polyglobe, dict) else []
    state_counts = transition_model.get("stateCounts", {}) if isinstance(transition_model, dict) else {}
    top_states = sorted(state_counts.items(), key=lambda item: item[1], reverse=True)[:10]

    return {
        "account": account,
        "openPositions": open_positions,
        "recentDecisions": decisions,
        "recentTrades": trades,
        "recentRegimeStates": regime_states,
        "transitionModel": transition_model,
        "watchdog": watchdog,
        "recentWatchdog": watchdog_log,
        "dashboardSummary": {
            "topStates": [{"label": label, "count": count} for label, count in top_states],
        },
        "polyglobe": {
            "fetchedAt": polyglobe.get("fetchedAt") if isinstance(polyglobe, dict) else None,
            "cacheHit": polyglobe.get("cacheHit") if isinstance(polyglobe, dict) else None,
            "stale": polyglobe.get("stale") if isinstance(polyglobe, dict) else None,
            "error": polyglobe.get("error") if isinstance(polyglobe, dict) else None,
            "freshnessMinutes": polyglobe.get("freshnessMinutes", {}) if isinstance(polyglobe, dict) else {},
            "breakingCount": len(polyglobe.get("breakingMarkets", [])) if isinstance(polyglobe, dict) else 0,
            "topBreaking": top_breaking,
            "matchedOpenPositions": [
                {
                    "question": pos.get("question"),
                    "outcome": pos.get("outcome"),
                    "entryPrice": pos.get("entryPrice"),
                    "lastMarkPrice": pos.get("lastMarkPrice"),
                    "costUsd": pos.get("costUsd"),
                }
                for pos in open_positions
            ],
        },
        "agentGraph": build_agent_graph(account, polyglobe, context_cache, watchdog, ambiguity, batch_labels, provider),
        "contextCache": context_cache,
        "ambiguityJudge": ambiguity,
        "providerRouting": provider.get("routing", {}),
        "strategy": account.get("strategy", {}),
        "chillMode": chill_mode,
    }


DASHBOARD_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dex • Polymarket Paper Trader</title>
  <style>
    :root {
      --bg: #08101f;
      --panel: rgba(14, 23, 42, 0.78);
      --panel-2: rgba(17, 24, 39, 0.95);
      --border: rgba(148, 163, 184, 0.16);
      --text: #e5eefc;
      --muted: #94a3b8;
      --green: #22c55e;
      --yellow: #f59e0b;
      --red: #ef4444;
      --blue: #60a5fa;
      --purple: #a78bfa;
      --cyan: #22d3ee;
      --shadow: 0 12px 40px rgba(0, 0, 0, 0.32);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top right, rgba(34, 211, 238, 0.16), transparent 22%),
        radial-gradient(circle at top left, rgba(167, 139, 250, 0.14), transparent 26%),
        linear-gradient(180deg, #07101e 0%, #08101f 42%, #050b16 100%);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1600px;
      margin: 0 auto;
      padding: 28px 20px 60px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 18px;
      margin-bottom: 18px;
    }
    .hero-card, .card {
      background: var(--panel);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: var(--shadow);
    }
    .hero-card {
      padding: 22px;
      position: relative;
      overflow: hidden;
    }
    .hero-card::after {
      content: "";
      position: absolute;
      inset: auto -20% -35% auto;
      width: 280px;
      height: 280px;
      background: radial-gradient(circle, rgba(96, 165, 250, 0.22), transparent 65%);
      pointer-events: none;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--cyan);
      margin-bottom: 14px;
    }
    h1 {
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.04;
      margin: 0 0 12px;
      letter-spacing: -0.04em;
    }
    .sub {
      color: var(--muted);
      margin: 0;
      max-width: 70ch;
      line-height: 1.55;
      font-size: 15px;
    }
    .top-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border);
      color: var(--text);
    }
    .badge.good { color: #86efac; border-color: rgba(34, 197, 94, 0.25); }
    .badge.warn { color: #fcd34d; border-color: rgba(245, 158, 11, 0.3); }
    .badge.bad { color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 22px;
    }
    .metric {
      background: rgba(2, 6, 23, 0.55);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
    }
    .metric-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 8px;
    }
    .metric-value {
      font-size: 28px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .metric-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 8px;
    }
    .section-grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 18px;
      margin-top: 18px;
    }
    .card {
      padding: 18px;
      min-height: 120px;
    }
    .col-4 { grid-column: span 4; }
    .col-5 { grid-column: span 5; }
    .col-6 { grid-column: span 6; }
    .col-7 { grid-column: span 7; }
    .col-8 { grid-column: span 8; }
    .col-12 { grid-column: span 12; }
    .card h2 {
      margin: 0 0 14px;
      font-size: 16px;
      letter-spacing: -0.02em;
    }
    .muted { color: var(--muted); }
    .tiny { font-size: 12px; }
    .list {
      display: grid;
      gap: 10px;
    }
    .item {
      background: rgba(2, 6, 23, 0.5);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
    }
    .item-title {
      font-weight: 700;
      margin-bottom: 6px;
      line-height: 1.35;
    }
    .item-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      position: sticky;
      top: 0;
      background: rgba(8, 16, 31, 0.98);
    }
    .scroll {
      max-height: 430px;
      overflow: auto;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.08);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(30, 41, 59, 0.95);
      border: 1px solid rgba(148, 163, 184, 0.14);
      font-size: 11px;
      font-weight: 700;
      color: var(--text);
    }
    .pill.green { color: #86efac; }
    .pill.yellow { color: #fcd34d; }
    .pill.red { color: #fca5a5; }
    .pill.blue { color: #93c5fd; }
    .pill.purple { color: #c4b5fd; }
    .empty {
      padding: 18px;
      text-align: center;
      color: var(--muted);
      border: 1px dashed rgba(148, 163, 184, 0.22);
      border-radius: 14px;
    }
    .footer-links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .footer-links a {
      color: var(--blue);
      text-decoration: none;
      background: rgba(15, 23, 42, 0.72);
      border: 1px solid var(--border);
      padding: 8px 10px;
      border-radius: 10px;
    }
    .agent-map{position:relative;min-height:380px;background:linear-gradient(180deg, rgba(2,6,23,.62), rgba(7,10,18,.72));border:1px solid rgba(148,163,184,.08);border-radius:16px;overflow:hidden}
    .agent-map svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.agent-edge{stroke:rgba(148,163,184,.22);stroke-width:2}.agent-edge.called{stroke:#fef08a;filter:drop-shadow(0 0 6px rgba(250,204,21,.6))}.agent-edge.king-edge{stroke:rgba(168,85,247,.4);stroke-width:1.5;stroke-dasharray:5 3}.agent-edge.chill-edge{stroke:rgba(168,85,247,.9);stroke-width:2.25;stroke-dasharray:7 4;filter:drop-shadow(0 0 6px rgba(168,85,247,.45))}
    .agent-node{position:absolute;width:76px;transform:translate(-50%,-50%);text-align:center}.agent-sprite{position:relative;margin:0 auto 4px;width:22px;height:22px;background:color-mix(in srgb, var(--agent-color) 55%, #111827);box-shadow:0 0 0 3px rgba(15,23,42,.9);opacity:.72}
    .agent-sprite:before,.agent-sprite:after{content:'';position:absolute;top:5px;width:4px;height:4px;background:#08101f}.agent-sprite:before{left:4px}.agent-sprite:after{right:4px}.agent-sprite i{position:absolute;left:4px;right:4px;bottom:4px;height:3px;background:#08101f;display:block}
    .agent-node.online .agent-sprite{opacity:.85}.agent-node:not(.online) .agent-sprite{opacity:.25;filter:grayscale(.8)}
    .agent-node.called .agent-sprite{opacity:1;filter:brightness(1.2) drop-shadow(0 0 8px color-mix(in srgb, var(--agent-color) 65%, white));animation:pulse 1.05s infinite}
    .agent-node.chill .agent-sprite{opacity:.45;filter:saturate(.7) brightness(.9)}.agent-node.chill.called .agent-sprite{opacity:1;filter:brightness(1.18) drop-shadow(0 0 10px rgba(168,85,247,.75));animation:pulse 1.05s infinite}
    .agent-node.king .agent-sprite{background:linear-gradient(135deg,#ff0000,#ff7700,#ffff00,#00ff00,#0077ff,#8800ff,#ff00ff);background-size:400% 400%;animation:rainbow 3s linear infinite;box-shadow:0 0 0 3px rgba(15,23,42,.9),0 0 12px rgba(255,255,255,.12)}
    .agent-node.king .agent-crown{position:absolute;top:-10px;left:50%;transform:translateX(-50%);width:14px;height:8px;background:#facc15;clip-path:polygon(0% 100%,10% 30%,25% 70%,40% 0%,55% 50%,70% 0%,85% 70%,95% 30%,100% 100%);filter:drop-shadow(0 0 3px rgba(255,215,0,.7));animation:crown-bob 1.5s ease-in-out infinite}
    @keyframes rainbow{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    @keyframes crown-bob{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-2px)}}
    .agent-node .agent-label{font-size:9px;font-weight:800}.agent-node .agent-meta{font-size:8px;color:var(--muted);margin-top:2px}.agent-node .agent-status{font-size:7px;text-transform:uppercase;letter-spacing:.08em;margin-top:2px;color:var(--muted)}
    @media (max-width: 1100px) {
      .hero { grid-template-columns: 1fr; }
      .col-4, .col-5, .col-6, .col-7, .col-8, .col-12 { grid-column: span 12; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="hero-card">
        <div class="eyebrow">⚡ Dex operator cockpit</div>
        <h1>Polymarket paper trader + Polyglobe intel</h1>
        <p class="sub">Real-time-ish paper trading view with bankroll safety, recent decisions, transition-state modeling, and external Polyglobe/PizzINT context layered in without turning the bot into a degenerate.</p>
        <div class="top-meta" id="hero-meta"></div>
      </div>
      <div class="hero-card">
        <div class="stat-grid" id="stat-grid"></div>
      </div>
    </section>

    <section class="section-grid">
      <div class="card col-7">
        <h2>Open positions</h2>
        <div id="positions"></div>
      </div>
      <div class="card col-5">
        <h2>Breaking markets</h2>
        <div class="list" id="breaking"></div>
      </div>

      <div class="card col-6">
        <h2>Recent decisions</h2>
        <div class="scroll"><table>
          <thead><tr><th>Time</th><th>Type</th><th>Question</th><th>Note</th></tr></thead>
          <tbody id="decisions-table"></tbody>
        </table></div>
      </div>
      <div class="card col-6">
        <h2>Recent trades</h2>
        <div class="scroll"><table>
          <thead><tr><th>Time</th><th>Type</th><th>Question</th><th>Details</th></tr></thead>
          <tbody id="trades-table"></tbody>
        </table></div>
      </div>

      <div class="card col-4">
        <h2>Transition model</h2>
        <div id="transition-summary"></div>
      </div>
      <div class="card col-4">
        <h2>Top state buckets</h2>
        <div class="list" id="top-states"></div>
      </div>
      <div class="card col-4">
        <h2>Polyglobe freshness</h2>
        <div id="freshness"></div>
      </div>

      <div class="card col-12">
        <h2>Agent network</h2>
        <div class="agent-map" id="agent-map"></div>
      </div>

      <div class="card col-12">
        <h2>Recent regime states</h2>
        <div class="scroll"><table>
          <thead><tr><th>Cycle</th><th>Question</th><th>Status</th><th>State</th><th>Price</th><th>Spread</th><th>Imbalance</th><th>Polyglobe</th></tr></thead>
          <tbody id="regime-table"></tbody>
        </table></div>
      </div>

      <div class="card col-12">
        <h2>JSON endpoints</h2>
        <div class="footer-links">
          <a href="/api/state">/api/state</a>
          <a href="/api/intel">/api/intel</a>
          <a href="/api/account">/api/account</a>
          <a href="/api/decisions?limit=20">/api/decisions?limit=20</a>
          <a href="/api/trades?limit=20">/api/trades?limit=20</a>
          <a href="/api/regime?limit=20">/api/regime?limit=20</a>
          <a href="/api/transition">/api/transition</a>
          <a href="/api/watchdog">/api/watchdog</a>
        </div>
      </div>
    </section>
  </div>

  <script>
    const money = (value) => {
      const num = Number(value ?? 0);
      if (!Number.isFinite(num)) return '—';
      return `$${num.toFixed(2)}`;
    };
    const pct = (value) => {
      const num = Number(value ?? 0);
      if (!Number.isFinite(num)) return '—';
      return `${(num * 100).toFixed(1)}%`;
    };
    const fmt = (value, digits = 2) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      return num.toFixed(digits);
    };
    const esc = (value) => String(value ?? '—')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    const ts = (value) => value ? new Date(value).toLocaleString() : '—';
    const pill = (label, tone = 'blue') => `<span class="pill ${tone}">${esc(label)}</span>`;

    function statusTone(paused, pnl) {
      if (paused) return 'red';
      if (Number(pnl) > 0) return 'green';
      if (Number(pnl) < 0) return 'yellow';
      return 'blue';
    }

    function renderHeroMeta(account, polyglobe) {
      const risk = account.risk || {};
      const tone = risk.paused ? 'bad' : 'good';
      document.getElementById('hero-meta').innerHTML = [
        `<span class="badge ${tone}">Risk: ${esc(risk.paused ? `PAUSED • ${risk.pauseReason || 'UNKNOWN'}` : 'ACTIVE')}</span>`,
        `<span class="badge">Last cycle: ${esc(ts(account.lastCycleAt))}</span>`,
        `<span class="badge">Polyglobe fetched: ${esc(ts(polyglobe.fetchedAt))}</span>`,
        `<span class="badge">Breaking markets: ${esc(polyglobe.breakingCount)}</span>`,
        `<span id="chill-badge"></span>`,
      ].join('');
      // Fetch chill mode state
      fetch('/api/chill-mode', { cache: 'no-store' }).then(r => r.json()).then(d => {
        const el = document.getElementById('chill-badge');
        if (el) {
          const on = d.enabled;
          el.innerHTML = `<span class="badge" style="cursor:pointer;${on ? 'background:#7c3aed;color:#fff;' : ''}" onclick="toggleChill()">${on ? '🎮 CHILL MODE ON' : '🟢 LIVE'}</span>`;
        }
      }).catch(() => {});
    }

    async function toggleChill() {
      try {
        const res = await fetch('/api/chill-mode/toggle', { method: 'POST' });
        const d = await res.json();
        const el = document.getElementById('chill-badge');
        if (el) {
          const on = d.enabled;
          el.innerHTML = `<span class="badge" style="cursor:pointer;${on ? 'background:#7c3aed;color:#fff;' : ''}" onclick="toggleChill()">${on ? '🎮 CHILL MODE ON' : '🟢 LIVE'}</span>`;
        }
        // Also update agent map if rendered
        refresh();
      } catch (err) { console.error(err); }
    }

    function renderStatGrid(account) {
      const risk = account.risk || {};
      const totalPnl = Number(risk.equityUsd || 0) - Number(account.initialUsd || 0);
      const tone = statusTone(risk.paused, totalPnl);
      const stats = [
        ['Cash', money(account.cashUsd), `Reserve ${money(risk.reserveUsd)}`],
        ['Equity', money(risk.equityUsd), `Drawdown ${money(risk.drawdownUsd)}`],
        ['Realized PnL', money(account.realizedPnlUsd), `Total ${money(totalPnl)}`],
        ['Open Positions', String((account.openPositions || []).length), `Consecutive losses ${risk.consecutiveLosses ?? 0}`],
      ];
      document.getElementById('stat-grid').innerHTML = stats.map(([label, value, sub]) => `
        <div class="metric">
          <div class="metric-label">${esc(label)}</div>
          <div class="metric-value" style="color:${tone === 'red' ? '#fca5a5' : tone === 'yellow' ? '#fcd34d' : '#bfdbfe'}">${esc(value)}</div>
          <div class="metric-sub">${esc(sub)}</div>
        </div>
      `).join('');
    }

    function renderPositions(positions) {
      const node = document.getElementById('positions');
      if (!positions.length) {
        node.innerHTML = '<div class="empty">No open positions right now.</div>';
        return;
      }
      node.innerHTML = `<div class="list">${positions.map((pos) => {
        const entry = Number(pos.entryPrice || 0);
        const mark = Number(pos.lastMarkPrice || 0);
        const delta = entry ? ((mark - entry) / entry) : 0;
        const pnl = Number(pos.shares || 0) * mark - Number(pos.costUsd || 0);
        const tone = pnl > 0 ? 'green' : pnl < 0 ? 'red' : 'blue';
        return `
          <div class="item">
            <div class="item-title">${esc(pos.question)}</div>
            <div class="item-meta">
              ${pill(`Outcome ${pos.outcome || '—'}`, 'purple')}
              ${pill(`Entry ${fmt(entry)}`, 'blue')}
              ${pill(`Mark ${fmt(mark)}`, tone)}
              ${pill(`PnL ${money(pnl)}`, tone)}
              ${pill(`Δ ${pct(delta)}`, tone)}
            </div>
          </div>`;
      }).join('')}</div>`;
    }

    function renderBreaking(polyglobe) {
      const node = document.getElementById('breaking');
      const items = polyglobe.topBreaking || [];
      if (!items.length) {
        node.innerHTML = '<div class="empty">No breaking-market intel cached yet.</div>';
        return;
      }
      node.innerHTML = items.map((item) => `
        <div class="item">
          <div class="item-title">${esc(item.title)}</div>
          <div class="item-meta">
            ${pill(`Price ${fmt(item.latestPrice, 3)}`, 'blue')}
            ${pill(`24h move ${fmt(item.priceMovement24h, 3)}`, item.priceMovement24h > 0 ? 'green' : 'yellow')}
            ${pill(`Vol ${money(item.volume24h)}`, 'purple')}
            ${pill(`Geo ${item.locationCount ?? 0}`, 'blue')}
          </div>
        </div>
      `).join('');
    }

    function renderRows(targetId, rows, mapFn, emptyText) {
      const node = document.getElementById(targetId);
      if (!rows.length) {
        node.innerHTML = `<tr><td colspan="8"><div class="empty">${esc(emptyText)}</div></td></tr>`;
        return;
      }
      node.innerHTML = rows.map(mapFn).join('');
    }

    function renderTransition(transition) {
      const node = document.getElementById('transition-summary');
      const matrix = transition.transitionMatrix || {};
      const top = Object.entries(matrix).slice(0, 4);
      node.innerHTML = `
        <div class="list">
          <div class="item"><div class="item-title">Episode count</div><div class="item-meta">${pill(transition.episodeCount ?? 0)} ${pill(`Usable ${transition.usableSequences ?? 0}`, 'purple')}</div></div>
          <div class="item"><div class="item-title">Observation count</div><div class="item-meta">${pill(transition.observationCount ?? 0)} ${pill(`State key ${transition.stateKey || '—'}`, 'blue')}</div></div>
          ${top.map(([label, nexts]) => {
            const best = Object.entries(nexts || {}).sort((a, b) => (b[1].probability || 0) - (a[1].probability || 0))[0];
            return `<div class="item"><div class="item-title">${esc(label)}</div><div class="item-meta">${best ? pill(`→ ${best[0]} ${(best[1].probability || 0).toFixed(2)}`, 'green') : pill('No transition')}</div></div>`;
          }).join('')}
        </div>`;
    }

    function renderTopStates(summary) {
      const node = document.getElementById('top-states');
      const items = summary.topStates || [];
      if (!items.length) {
        node.innerHTML = '<div class="empty">Need more regime samples.</div>';
        return;
      }
      node.innerHTML = items.map((item) => `
        <div class="item">
          <div class="item-title">${esc(item.label)}</div>
          <div class="item-meta">${pill(`Count ${item.count}`, 'purple')}</div>
        </div>
      `).join('');
    }

    function renderFreshness(polyglobe) {
      const fresh = polyglobe.freshnessMinutes || {};
      const node = document.getElementById('freshness');
      node.innerHTML = `
        <div class="list">
          <div class="item"><div class="item-title">Matched tweet freshness</div><div class="item-meta">${pill(`${fmt(fresh.latestMatchedTweet, 2)} min`, 'blue')}</div></div>
          <div class="item"><div class="item-title">Geotag freshness</div><div class="item-meta">${pill(`${fmt(fresh.latestGeotag, 2)} min`, 'blue')}</div></div>
          <div class="item"><div class="item-title">Truth freshness</div><div class="item-meta">${pill(`${fmt(fresh.latestTruth, 2)} min`, 'purple')}</div></div>
          <div class="item"><div class="item-title">Cache state</div><div class="item-meta">${pill(`cacheHit ${polyglobe.cacheHit}`, polyglobe.cacheHit ? 'green' : 'yellow')} ${pill(`stale ${polyglobe.stale}`, polyglobe.stale ? 'red' : 'green')}</div></div>
        </div>`;
    }

    function renderAgentMap(graph, chillMode) {
      const root = document.getElementById('agent-map');
      const positions = {dex:[50,68],collector:[16,26],retriever:[32,40],trader:[52,20],watchman:[50,52],qwenSub:[72,46],qwen4b:[86,62],chillMode:[73,66],ambiguity:[24,82],cerebras:[10,92],sambanova:[78,22],hf:[90,92]};
      const chillOn = !!(chillMode && chillMode.enabled);
      const graphNodes = [...(graph.nodes || [])];
      const graphEdges = [...(graph.edges || [])];
      if (chillOn || !graphNodes.find(n => n.id === 'chillMode')) {
        graphNodes.push({id:'chillMode', label:'🎮 Chill Mode', color:'#8b5cf6', called:chillOn, online:true, meta:chillOn ? (chillMode.reason || 'bypassing qwen') : 'standby', chill:true});
      }
      if (chillOn) {
        graphEdges.push(['chillMode', 'qwenSub', 'chill-edge']);
        graphEdges.push(['chillMode', 'qwen4b', 'chill-edge']);
        graphEdges.push(['watchman', 'cerebras', 'chill-edge']);
      }
      const byId = {};
      graphNodes.forEach(n => byId[n.id] = n);
      const lines = graphEdges.map((edge) => {
        const [a, b, variant] = edge;
        const pa = positions[a], pb = positions[b];
        if (!pa || !pb) return '';
        const called = (byId[a]?.called || byId[b]?.called);
        const isKing = a === 'dex' || b === 'dex';
        return `<line class="agent-edge ${called ? 'called' : ''} ${isKing ? 'king-edge' : ''} ${variant || ''}" x1="${pa[0]}%" y1="${pa[1]}%" x2="${pb[0]}%" y2="${pb[1]}%" />`;
      }).join('');
      const nodes = graphNodes.map(node => {
        const pos = positions[node.id] || [50, 50];
        const isKing = node.king;
        const colorVar = isKing ? '' : `--agent-color:${node.color}`;
        const crown = isKing ? '<div class="agent-crown"></div>' : '';
        return `<div class="agent-node ${node.called ? 'called' : ''} ${node.online ? 'online' : ''} ${isKing ? 'king' : ''} ${node.chill ? 'chill' : ''}" style="left:${pos[0]}%;top:${pos[1]}%;${colorVar}">${crown}<div class="agent-sprite"><i></i></div><div class="agent-label">${esc(node.label)}</div><div class="agent-status">${node.called ? 'called' : node.online ? 'online' : 'offline'}</div><div class="agent-meta">${esc(node.meta || '')}</div></div>`;
      }).join('');
      root.innerHTML = `<svg viewBox="0 0 1000 500" preserveAspectRatio="none">${lines}</svg>${nodes}`;
    }

    function update(payload) {
      const account = payload.account || {};
      const polyglobe = payload.polyglobe || {};
      renderHeroMeta(account, polyglobe);
      renderStatGrid(account);
      renderPositions(payload.openPositions || []);
      renderBreaking(polyglobe);
      renderTransition(payload.transitionModel || {});
      renderTopStates(payload.dashboardSummary || { topStates: [] });
      renderFreshness(polyglobe);
      renderAgentMap(payload.agentGraph || {nodes: [], edges: []}, payload.chillMode || {});

      renderRows('decisions-table', payload.recentDecisions || [], (row) => {
        const type = row.type || '—';
        const colorMap = { BUY: 'green', ENTRY: 'green', EXIT: 'yellow', REJECT: 'red', SKIP: 'red', PAUSE: 'red', NO_TRADE: 'orange', '—': 'blue' };
        const label = { NO_TRADE: 'NO TRADE', REJECT: 'REJECT', SKIP: 'SKIP' }[type] || type;
        // Build note from available fields
        let note = row.note || row.rationale || row.reason || '';
        if (!note && row.validation?.violations?.length) {
          note = row.validation.violations.join('; ');
        }
        if (!note && row.features?.score != null) {
          note = `score ${row.features.score} spread ${row.features.spread_bps || '?'}bps`;
        }
        return `<tr>
          <td>${esc(ts(row.ts))}</td>
          <td>${pill(label, colorMap[type] || 'blue')}</td>
          <td>${esc(row.question || '—')}</td>
          <td>${esc(note || '—')}</td>
        </tr>`;
      }, 'No decisions yet.');

      renderRows('trades-table', payload.recentTrades || [], (row) => `
        <tr>
          <td>${esc(ts(row.ts))}</td>
          <td>${pill(row.type || '—', row.type === 'EXIT' ? 'yellow' : 'green')}</td>
          <td>${esc(row.question || '—')}</td>
          <td>${esc(`entry ${row.entryPrice ?? '—'} • exit ${row.exitPrice ?? '—'} • pnl ${row.pnlUsd ?? '—'}`)}</td>
        </tr>
      `, 'No trades yet.');

      renderRows('regime-table', payload.recentRegimeStates || [], (row) => `
        <tr>
          <td>${esc(row.cycle ?? '—')}</td>
          <td>${esc(row.question || '—')}</td>
          <td>${pill(row.status || '—', row.status === 'closed' ? 'yellow' : row.status === 'opened' ? 'green' : 'blue')}</td>
          <td>${esc(row.coarseStateLabel || row.stateLabel || '—')}</td>
          <td>${esc(fmt(row.price))}</td>
          <td>${esc(fmt(row.spread))}</td>
          <td>${esc(fmt(row.imbalance, 4))}</td>
          <td>${row.polyglobeBreaking ? pill(`breaking • move ${fmt(row.polyglobePriceMovement24h, 4)}`, 'red') : pill('no match')}</td>
        </tr>
      `, 'No regime states yet.');

      renderRows('watchdog-table', payload.recentWatchdog || [], (row) => `
        <tr>
          <td>${esc(ts(row.ts))}</td>
          <td>${pill(row.overallVerdict || 'OBSERVE', row.overallVerdict === 'ALLOW' ? 'green' : row.overallVerdict === 'VETO' ? 'red' : 'yellow')}</td>
          <td>${esc(row.summary || '—')}</td>
          <td>${esc((row.riskFlags || []).join(', ') || 'none')}</td>
        </tr>
      `, 'No watchman checks yet.');
    }

    async function refresh() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        const payload = await res.json();
        update(payload);
      } catch (err) {
        console.error(err);
      }
    }

    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return HTMLResponse(content=DASHBOARD_HTML)


@app.get("/neural", response_class=HTMLResponse)
async def neural_page():
    return Path(NEURAL_HTML_PATH).read_text()

@app.get("/three.module.js")
async def three_js():
    from fastapi.responses import FileResponse
    return FileResponse(THREE_JS_PATH, media_type="application/javascript")

@app.get("/OrbitControls.js")
async def orbit_js():
    from fastapi.responses import FileResponse
    return FileResponse(ORBIT_JS_PATH, media_type="application/javascript")


@app.get("/api/state")
async def api_state():
    return JSONResponse(get_state())


@app.get("/api/intel")
async def api_intel():
    return JSONResponse(load_json(POLYGLOBE_PATH, {"error": "Cache file not found."}))


@app.get("/api/account")
async def api_account():
    return JSONResponse(load_json(ACCOUNT_PATH, {"error": "Account file not found."}))


@app.get("/api/transition")
async def api_transition():
    return JSONResponse(load_json(TRANSITION_PATH, {"error": "Transition model not found."}))


@app.get("/api/decisions")
async def api_decisions(limit: int = Query(default=50, ge=1, le=500)):
    raw = load_jsonl(DECISIONS_PATH, limit=limit * 5)  # overfetch to account for filtering
    # Filter noise and normalize
    NOISE_TYPES = {'HOLD', 'MARK', 'TA_ERROR'}
    filtered = []
    for row in raw:
        # Normalize: use 'action' as fallback for 'type'
        if not row.get('type') and row.get('action'):
            row['type'] = row['action']
        # Skip noise entries
        if row.get('type') in NOISE_TYPES:
            continue
        # Add question fallback from market_question
        if not row.get('question') and row.get('market_question'):
            row['question'] = row['market_question']
        # Default label for NO_TRADE
        if row.get('type') == 'NO_TRADE' and not row.get('question'):
            row['question'] = 'No qualifying candidate this cycle'
        filtered.append(row)
        if len(filtered) >= limit:
            break
    return JSONResponse(filtered)


@app.get("/api/trades")
async def api_trades(limit: int = Query(default=50, ge=1, le=500)):
    return JSONResponse(load_jsonl(TRADES_PATH, limit=limit))


@app.get("/api/regime")
async def api_regime(limit: int = Query(default=50, ge=1, le=500)):
    return JSONResponse(load_jsonl(REGIME_PATH, limit=limit))


@app.get("/api/watchdog")
async def api_watchdog(limit: int = Query(default=25, ge=1, le=200)):
    latest = load_json(WATCHDOG_PATH, {})
    recent = load_jsonl(WATCHDOG_LOG_PATH, limit=limit)
    return JSONResponse({"latest": latest, "recent": recent})


@app.get("/api/memory/atomic-facts")
async def api_memory_atomic_facts():
    return PlainTextResponse(load_text(ATOMIC_FACTS_PATH, default=""))


@app.get("/api/memory/foresights")
async def api_memory_foresights():
    return PlainTextResponse(load_text(FORESIGHTS_PATH, default=""))


@app.get("/api/memory/profiles")
async def api_memory_profiles():
    return JSONResponse(load_json(PROFILES_PATH, {}))


@app.get("/api/memory/learnings")
async def api_learnings():
    learnings_dir = POLY_DIR / ".learnings"
    if not learnings_dir.exists():
        return JSONResponse([])
    results = []
    for f in sorted(learnings_dir.glob("*.md")):
        try:
            content = f.read_text()[:2000]
            results.append({"file": f.name, "content": content, "mtime": f.stat().st_mtime})
        except Exception:
            pass
    return JSONResponse(results)


@app.get("/api/memory/daily")
async def api_daily_memory():
    memory_dir = Path("/root/.openclaw/workspace/memory")
    if not memory_dir.exists():
        return JSONResponse([])
    results = []
    for f in sorted(memory_dir.glob("2026-03-*.md"), reverse=True)[:7]:
        try:
            content = f.read_text()[:3000]
            results.append({"file": f.name, "content": content, "mtime": f.stat().st_mtime})
        except Exception:
            pass
    return JSONResponse(results)


@app.get("/api/memory/evolver")
async def api_evolver():
    log_path = POLY_DIR / "memory" / "paper" / "evolution_log.jsonl"
    if not log_path.exists():
        return JSONResponse([])
    return JSONResponse(load_jsonl(log_path, limit=100))


@app.get("/api/neural/activity")
async def neural_activity():
    state = get_state()
    return JSONResponse(state.get("agentGraph", {}))


@app.get("/api/neural/events")
async def neural_events():
    from fastapi.responses import StreamingResponse

    async def event_stream():
        last_check = time.time()
        last_heartbeat = 0.0
        previous_active = set()

        while True:
            emitted = False
            try:
                event_specs = [
                    (DECISIONS_PATH, 'new_decision'),
                    (TRADES_PATH, 'new_trade'),
                    (ATOMIC_FACTS_PATH, 'new_fact'),
                    (FORESIGHTS_PATH, 'new_foresight'),
                    (POLY_DIR / 'memory' / 'paper' / 'evolution_log.jsonl', 'evolver_finding'),
                ]
                now = time.time()

                for path, event_name in event_specs:
                    for row in iter_recent_jsonl(path, last_check):
                        payload = row if isinstance(row, dict) else {'value': row}
                        if event_name == 'evolver_finding' and payload.get('severity') in {'high', 'critical'}:
                            payload = {**payload, 'severity': payload.get('severity', 'high')}
                        yield sse(event_name, payload)
                        emitted = True

                learnings_dir = POLY_DIR / '.learnings'
                if learnings_dir.exists():
                    for f in sorted(learnings_dir.glob('*.md')):
                        try:
                            stat = f.stat()
                            if stat.st_mtime > last_check:
                                yield sse('new_learning', {'file': f.name, 'content': f.read_text()[:2000], 'mtime': stat.st_mtime})
                                emitted = True
                        except Exception:
                            pass

                memory_dir = Path('/root/.openclaw/workspace/memory')
                if memory_dir.exists():
                    for f in sorted(memory_dir.glob('2026-03-*.md'), reverse=True)[:7]:
                        try:
                            stat = f.stat()
                            if stat.st_mtime > last_check:
                                yield sse('new_learning', {'file': f.name, 'content': f.read_text()[:2000], 'mtime': stat.st_mtime, 'kind': 'daily_memory'})
                                emitted = True
                        except Exception:
                            pass

                state = get_state()
                agent_graph = state.get('agentGraph', {}) if isinstance(state, dict) else {}
                nodes = agent_graph.get('nodes', []) if isinstance(agent_graph, dict) else []
                active = {str(n.get('label') or n.get('id')) for n in nodes if isinstance(n, dict) and n.get('called')}
                for agent in sorted(active - previous_active):
                    yield sse('thinking_start', {'agent': agent, 'ts': now})
                    emitted = True
                for agent in sorted(previous_active - active):
                    yield sse('thinking_end', {'agent': agent, 'ts': now})
                    emitted = True

                if active:
                    ordered = [n for n in nodes if isinstance(n, dict) and str(n.get('label') or n.get('id')) in active]
                    if len(ordered) >= 2:
                        source = str(ordered[0].get('label') or ordered[0].get('id'))
                        target = str(ordered[-1].get('label') or ordered[-1].get('id'))
                        if source != target:
                            yield sse('data_packet', {'source': source, 'target': target, 'ts': now})
                            emitted = True
                    if any('retriever' in str((n.get('id') or n.get('label') or '')).lower() for n in ordered):
                        yield sse('memory_retrieval', {'agent': 'Retriever', 'ts': now})
                        emitted = True

                previous_active = active
                if (not emitted) or (now - last_heartbeat >= 5):
                    yield sse('heartbeat', {'ts': now})
                    last_heartbeat = now
            except Exception as exc:
                yield sse('error', {'message': str(exc), 'ts': time.time()})
            await asyncio.sleep(3)
            last_check = time.time()

    return StreamingResponse(event_stream(), media_type='text/event-stream')


@app.get("/api/chill-mode")
async def api_chill_mode():
    return JSONResponse(load_json(CHILL_MODE_PATH, {"enabled": False}))


@app.post("/api/chill-mode/toggle")
async def api_chill_mode_toggle():
    from datetime import datetime, timezone
    current = load_json(CHILL_MODE_PATH, {"enabled": False})
    new_state = not current.get("enabled", False)
    record = {
        "enabled": new_state,
        "reason": "manual toggle from dashboard",
        "toggledAt": datetime.now(timezone.utc).isoformat(),
        "fallbackProvider": "cerebras",
    }
    CHILL_MODE_PATH.write_text(json.dumps(record, indent=2))
    return JSONResponse(record)
