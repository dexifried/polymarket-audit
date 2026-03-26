---
name: polymarket-trading
description: "Paper-first Polymarket trading, market analysis, Polyglobe/PizzINT intel collection, risk-gated signal evaluation, and operator dashboard. Use when working on Polymarket skills or workflows for: (1) fetching markets/orderbooks/midpoints, (2) paper trading with bankroll protection, (3) evaluating signals with transition-model + watchdog layers, (4) monitoring Polyglobe/PizzINT breaking markets or OSINT, (5) running the FastAPI dashboard, or (6) validating live-readiness without placing real trades."
---

# Polymarket Trading

Prefer **paper mode first**. Keep bankroll protection above all model opinions.

## Core paths
- Skill root: `skills/polymarket-trading.skill`
- Runtime helpers: `lib/runtime.js`
- Polyglobe/PizzINT collector: `lib/polyglobe.js`
- Cleaned context retrieval/rerank: `lib/context_retrieval.js`
- Paper trader: `scripts/paper_autotrader.js`
- Watchdog: `scripts/qwen_watchdog.js`
- Ambiguity judge: `scripts/ambiguity_judge.js`
- Batch labeler: `scripts/batch_labeler.js`
- HF export scaffold: `scripts/export_hf_training_data.js`
- Provider routing config: `config/model_routing.json`
- Dashboard: `app/main.py`

## Default operating modes
- **Public / read-only**: fetch markets, orderbooks, midpoints, Polyglobe intel
- **Paper trading**: safe default for testing strategies
- **Authenticated trading**: only after explicit readiness checks; do not assume funded wallet

## Safety rules
- Keep trading **paper-only** unless the user clearly asks for live trading.
- Treat the risk engine as the boss:
  - reserve cash protected
  - position cap
  - drawdown stop
  - daily-loss stop
  - consecutive-loss pause
- Treat the local Qwen watchdog as **advisory only**. It may veto or summarize, but it does not override risk controls.

## Main workflows

### 1) Verify the skill
Use:
```bash
node scripts/verify.js
node scripts/verify.js --require-live
```

### 2) Run the paper trader
Use:
```bash
node scripts/paper_autotrader.js --capital-cad 20 --interval 300
```
Notes:
- writes logs under `memory/paper/`
- conservative defaults are baked in
- use this for fake-money evaluation before any live deployment

### 3) Build cleaned watchdog context
Use:
```bash
node scripts/build_watchdog_context.js
```
This creates `memory/paper/qwen_context_cache.json` from:
- paper account/open positions
- Polyglobe breaking markets
- OSINT tweets / truth items

If `DEEPINFRA_API_KEY` is available, retrieval uses embeddings/reranking. Otherwise it falls back to deterministic lexical matching.

### 4) Run the local Qwen watchdog
Use:
```bash
node scripts/qwen_watchdog.js --once
node scripts/qwen_watchdog.js --interval 300
```
What it does:
- refreshes cleaned context
- queries `qwen-dex-sub:latest` directly via Ollama-compatible HTTP
- writes:
  - `memory/paper/qwen_watchdog_latest.json`
  - `memory/paper/qwen_watchdog.jsonl`

### 5) Run the cloud ambiguity judge
Use:
```bash
node scripts/ambiguity_judge.js
node scripts/ambiguity_judge.js --local-only
```
What it does:
- reviews the current paper candidate/open position plus cleaned context
- prefers Cerebras when `CEREBRAS_KEY` is present
- falls back to a deterministic local heuristic
- writes:
  - `memory/paper/ambiguity_judge_latest.json`
  - `memory/paper/ambiguity_judge.jsonl`

### 6) Run the offline batch labeler
Use:
```bash
node scripts/batch_labeler.js
node scripts/batch_labeler.js --local-only
```
What it does:
- reads recent paper decisions/trades
- prefers SambaNova for cheap offline labeling/summarization
- falls back to local rule-based labels
- writes `memory/paper/batch_labels_latest.json`

### 7) Export Hugging Face training data scaffold
Use:
```bash
node scripts/export_hf_training_data.js --limit 200
```
This exports paper-only advisory examples for offline dataset work.
See `references/hf-runbook.md` for the intended workflow.

### 8) Run the dashboard
Use:
```bash
./run_dashboard.sh
```
Default bind:
- `0.0.0.0:8787`

Useful endpoints:
- `/api/state`
- `/api/intel`
- `/api/context`
- `/api/watchdog`
- `/api/account`
- `/api/transition`

## What to inspect during evaluation
- `memory/paper/account.json`
- `memory/paper/decisions.jsonl`
- `memory/paper/trades.jsonl`
- `memory/paper/regime_states.jsonl`
- `memory/paper/transition_model.json`
- `memory/paper/polyglobe_intel_cache.json`
- `memory/paper/qwen_context_cache.json`
- `memory/paper/qwen_watchdog_latest.json`

## Strategy stack
Use the layers in this order:
1. risk engine / bankroll controls
2. market microstructure (midpoint, spread, imbalance, orderbook)
3. transition model / state data
4. Polyglobe / OSINT context
5. local Qwen watchdog advisory

If these layers disagree, prefer safety and observation over action.

## Notes on authenticated / live mode
- Auth setup: `node scripts/setup_auth.js`
- Credentials path: `.polymarket-credentials.json`
- Only test real order placement after explicit user approval and funded-wallet confirmation.

## References
Read only as needed:
- `references/api-endpoints.md` for Polymarket/collector endpoint details
- `docs/runbook.md` for operational notes
- `PACKAGING.md` if repackaging the skill
