# Polymarket Trading Skill — Mass Audit Report

**Date:** 2026-03-26
**Auditors:** ACP Codex (bugs), ACP Codex (financial), manual surface scan
**Scope:** 73 JS files, ~12,114 lines across lib/, scripts/, strategies/

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 12 |
| Medium | 17 |
| Low | 1 |
| **Total** | **32** |

---

## CRITICAL

### C1. Execution Agent is Dead on Arrival
**File:** `scripts/agents/execution_agent.js:4-9,59-62`
**Description:** Written in CommonJS (`require`/`module.exports`) inside a package with `"type": "module"`. Also imports nonexistent modules. The agent crashes on startup.
**Fix:** Convert to ESM, fix imports, add startup smoke test.

### C2. WAL API Mismatch Breaks Checkpointing
**File:** `scripts/agents/execution_agent.js:156-178`, `lib/wal.js:89-105`
**Description:** Agent calls `wal.replay({ gt, filter })` and `wal.tail({ after, filter })` as async streams. WAL exposes `replay(fromSeq, toSeq)` and `tail(limit)` returning arrays. Checkpointing and replay are non-functional.
**Fix:** Agree on one API — either add filtered async iterators to WAL or fix the agent.

---

## HIGH

### H1. WAL Race Condition — No Locking on Counter
**File:** `lib/wal.js:55-61`
**Description:** Sequence allocation is read-modify-write on `counters.json` with no locking. Concurrent appender = duplicate seq = broken replay ordering.

### H2. WAL Counter Committed Before Log Entry
**File:** `lib/wal.js:60-76`
**Description:** Counter persisted before JSONL append. Crash after counter write = burned sequence number = permanent event skip.

### H3. WAL File Descriptor Leak
**File:** `lib/wal.js:65-76`
**Description:** Opens `LOG_PATH` with `fs.open` but never closes the FD. Every append leaks one FD.

### H4. Open Orders File — No Locking
**File:** `lib/memory.js:25-36`
**Description:** `saveOpenOrder`/`removeOpenOrder` rewrite full `open_orders.jsonl` with no lock. Concurrent writes lose updates.

### H5. Paper Trade — Same Fill Reused Across Orders
**File:** `scripts/paper_trade.js:102-139`
**Description:** Market fill liquidity reused for every order. `m.size` never decremented. Paper results overstate fill rate and PnL.

### H6. Trade Side Inferred from Regex on Question Text
**File:** `scripts/strategy_cex_momentum.js:51-56,135-148`
**Description:** Side determined by regex matching `up|higher|above` → YES, `down|lower|below` → NO. Brittle — can buy wrong token on ambiguous wording.

### H7. L2 Simulator Returns Fill Data on Rejection
**File:** `lib/l2_simulator.js:125-129`
**Description:** On slippage rejection, still returns non-zero `filled_usd`, `fill_ratio`, `avg_fill_price`. Downstream treats rejected as executed.

### H8. Order Quantization Uses Fixed toFixed(2)
**File:** `lib/order_manager.js:30-37`, `scripts/place_order.js:49-52`
**Description:** Price and size both quantized with `toFixed(2)` regardless of market tick size. Wrong precision = invalid orders or worse fills.

### H9. Position Monitor — Double Close Race
**File:** `lib/position_monitor.js:45-80`
**Description:** Iterates positions and awaits close handler without marking in-flight. Re-entrant call closes same position twice.

### H10. Credential File Permissions Not Enforced
**File:** `scripts/setup_auth.js:27-29`
**Description:** Claims `0600` permissions but `writeFileSync` called without `mode`. Permissions depend on umask.

### H11. Paper Autotrader — Arbitrary Script Execution
**File:** `scripts/paper_autotrader.js:823`
**Description:** Executes whatever path `TRADING_AGENTS_LLM_SCRIPT` points to via `execFileSync` with full environment including live creds. Paper-to-live bridge.

### H12. LLM Prompt Injection via Market/Social Content
**Files:** `lib/prompt_templates.js:3`, `lib/evidence_bundle.js:35`, `lib/cloud_judge.js:169`
**Description:** Raw tweets, Truth posts, market descriptions embedded directly in LLM prompts via `JSON.stringify`. No sanitization, no trust boundary. Adversarial content can inject instructions.

---

## MEDIUM

### M1. Memory — No Error Handling on JSONL Parse
**File:** `lib/memory.js:19-22,39-40`
**Description:** `readLines` blindly `JSON.parse`s every line. One corrupted line crashes all callers.

### M2. Order Manager — Silent Error Swallowing
**File:** `lib/order_manager.js:47-50`
**Description:** All API failures caught, logged, returned as `null`. Can't distinguish auth failure from server error.

### M3. Position Monitor — Silent Stale Marking
**File:** `lib/position_monitor.js:22-28`
**Description:** Midpoint API failures silently fall back to stale prices. Persistent outage = frozen exits.

### M4. Execution Agent — Credential Path from CWD
**File:** `scripts/agents/execution_agent.js:13,17-25`
**Description:** Credentials resolved from `process.cwd()` instead of shared helper. Different CWD = different creds.

### M5. Agent Memory — Unbounded Growth
**File:** `lib/agent_memory.js:122-140,212-263`
**Description:** Reflections appended forever. Every retrieval loads entire JSONL into memory. Unbounded memory/latency.

### M6. Context Retrieval — Data Exfiltration via Embeddings
**File:** `lib/context_retrieval.js:177-198,256-316`
**Description:** When `DEEPINFRA_API_KEY` present, sends positions/rationales/OSINT to DeepInfra for embedding. No redaction, no opt-in.

### M7. Schema Validation — Weak Proposal Checks
**File:** `lib/schema.js:141-146`
**Description:** Only validates `token_id`. Accepts invalid action, negative size, out-of-range prices, inverted entry bands.

### M8. Dry Run Check — Incomplete Safeguard
**File:** `scripts/dry_run_check.js:15`
**Description:** Only checks one credential path and one env var. Doesn't verify actual runtime credential loading.

### M9. LLM Caller — No Provider Allowlist
**File:** `scripts/llm_caller.js:33`
**Description:** Takes arbitrary messages, forwards to any provider. No response schema enforcement.

### M10. WebSocket Market — No Reconnect
**File:** `scripts/ws_market.js:17`
**Description:** No reconnect loop, no heartbeat, no state resync. Network drop = silent stale data.

### M11. WebSocket User — Same Issue
**File:** `scripts/ws_user.js:17`
**Description:** No reconnect, no replay, no sequence tracking. Missed fills = inconsistent state.

### M12. WS Market Connector — Gap Detection Missing
**File:** `scripts/agents/ws_market_connector.js:35`
**Description:** Reconnects but doesn't detect gaps, deduplicate, or reload snapshot. Message ordering untrustworthy.

### M13. Evidence Bundle — Stale Memory Injection
**File:** `lib/evidence_bundle.js:151`
**Description:** Historical trades/foresights injected without freshness/expiry/regime filter. Old data biases current decisions.

### M14. Foresight Extractor — No Invalidation
**File:** `lib/foresight_extractor.js:432`
**Description:** Foresights persisted append-only with no expiry. Old catalysts remain retrievable.

### M15. Atomic Facts — Non-Atomic Rebuild
**File:** `lib/atomic_facts.js:384`
**Description:** Full rebuild truncates before rewrite. Readers can observe empty/partial store. Stale corrections never replaced.

### M16. Transition Model — No Time Decay
**File:** `scripts/paper_transition_model.js:213`
**Description:** Trains on entire history with no decay. Old regime observations remain fully influential.

### M17. Cloud Judge — Trusts Cached Context
**File:** `lib/cloud_judge.js:169`
**Description:** Cached context from `qwen_context_cache.json` treated as trusted. Adversarial context can override risk flags.

---

## LOW

### L1. Paper Trade — Nondeterministic Sort
**File:** `scripts/paper_trade.js:73-75`
**Description:** Comparator never returns `0`, compares nullable timestamps as strings. Equal timestamps reorder nondeterministically.

---

## Surface Scan Findings (Manual)

- **No WAL locking** at all across the codebase
- **Multiple TOCTOU races:** `existsSync` → read without lock (agent_memory, agent_profiles, atomic_facts, context_retrieval)
- **Unhandled fetch calls:** API failures throw unhandled rejections (lib/context_retrieval.js, lib/atomic_facts.js, lib/foresight_extractor.js, lib/provider_routing.js)
- **process.exit without cleanup:** 10+ instances — WAL locks and file handles abandoned
- **No retry logic** except WebSocket connector (exponential backoff — good)
