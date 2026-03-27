# Polymarket Trading Skill Audit

Date: 2026-03-26
Scope: financial safety, LLM integration, websocket handling, data integrity.

## Overall

I did not find a direct real-order submission path inside `scripts/paper_autotrader.js` or `scripts/paper_transition_model.js`. `paper_autotrader` uses `buildReadonlyClient()` and simulates fills locally. The main risks are softer boundaries around helper scripts, prompt/data trust, websocket freshness, and stale memory/cached outputs influencing paper decisions.

## Findings

1. File: `scripts/paper_autotrader.js`
Line: `823`
Severity: High
Description: `callTradingAgentsLlm()` executes whatever path is set in `TRADING_AGENTS_LLM_SCRIPT` via `execFileSync('node', [scriptPath], ...)` and passes the full process environment through unchanged. In a "paper" run, a bad path or accidental env misconfiguration can run an arbitrary Node script with live credentials in scope. That creates a real paper-to-live bridge even though the main autotrader itself only uses `buildReadonlyClient()`.
Fix: Resolve the script to a strict allowlist under the skill repo, refuse absolute or external paths, and scrub trading secrets like `PRIVATE_KEY` and credential-related env vars before spawning the child process.

2. File: `scripts/dry_run_check.js`
Line: `15`
Severity: Medium
Description: The dry-run safeguard is easy to bypass because it only checks `cwd/.polymarket-credentials.json` and `process.env.PRIVATE_KEY`. It does not verify the actual runtime credential-loading paths used elsewhere, does not inspect alternate auth env vars, and does not gate execution helpers or authenticated websocket scripts. A user can get a false sense of safety while other parts of the skill remain live-capable.
Fix: Make the check fail closed. Reuse the real credential discovery logic from runtime/execution paths, inspect all supported secret env vars, and classify the environment as unsafe whenever any authenticated execution path is available.

3. File: `lib/prompt_templates.js`
Line: `3`
Severity: High
Description: The LLM prompts embed the full evidence bundle with `JSON.stringify(data)` directly into the user message. That bundle can include raw market descriptions, tweets, Truth posts, and cached contexts. There is no trust-boundary labeling, no stripping of instruction-like text, and no isolation of untrusted snippets. Adversarial market content can therefore inject instructions such as “ignore previous rules” into the analyst, researcher, or risk prompts.
Fix: Treat all market/news/social text as untrusted. Quote it in a clearly delimited section, strip or escape control-like strings, summarize to structured fields before prompt inclusion, and add a second validation pass that rejects outputs grounded in prompt-side instructions rather than evidence.

4. File: `lib/evidence_bundle.js`
Line: `35`
Severity: High
Description: `normalizePolyglobe()` copies raw tweet/truth text into `external.polyglobe.tweets`, and `buildEvidenceBundle()` forwards that material unchanged into downstream prompts. The only filter is token overlap with the market question, which does nothing against adversarial prompt content. This gives untrusted social text a first-class path into LLM trade analysis.
Fix: Exclude raw post bodies from the primary decision prompt by default. Pass only metadata plus a separately summarized, sanitized excerpt set, and require explicit source attribution if raw text is ever shown to a model.

5. File: `lib/cloud_judge.js`
Line: `169`
Severity: High
Description: The ambiguity judge packages `candidate`, `riskFlags`, and cached `contexts` into a single JSON user message and accepts any parsed `ALLOW|OBSERVE|VETO` enum in response. Cached context text from `qwen_context_cache.json` is untrusted, but the judge gives it no lower-trust handling. If adversarial context says to approve or downplay ambiguity, the model can comply and `sanitizeModelResult()` will still accept the output.
Fix: Remove raw context text from the judge prompt or pre-summarize it with a sanitizer, use strict structured output enforcement, and add deterministic checks that can veto `ALLOW` when ambiguity/risk flags are present regardless of model output.

6. File: `scripts/llm_caller.js`
Line: `33`
Severity: Medium
Description: The LLM caller takes arbitrary messages from stdin, forwards them to whichever provider/model env selects, and returns raw content. There is no provider allowlist, no response schema enforcement, and no output sanity check before downstream validators consume the text. This weakens the trust boundary around the whole TradingAgents pipeline and makes prompt-injection fallout harder to contain.
Fix: Restrict providers/models to an allowlist, request structured JSON output where the provider supports it, reject non-JSON responses at this boundary, and record/provider-tag outputs so risky providers can be disabled centrally.

7. File: `scripts/ws_market.js`
Line: `17`
Severity: Medium
Description: The market websocket helper requires authenticated credentials and exits on error. It has no reconnect loop, no ping/pong liveness handling, and no state resync after disconnect. A transient network drop silently turns the stream stale, which can leave operators or downstream tooling working from old market data.
Fix: Use a public/read-only websocket path where possible, add reconnect with bounded backoff and heartbeat detection, and fetch a fresh REST snapshot after reconnect before resuming incremental updates.

8. File: `scripts/ws_user.js`
Line: `17`
Severity: Medium
Description: The user websocket helper has the same reliability gap: one disconnect or auth hiccup terminates the process, with no replay, no sequence tracking, and no recovery path. Missed fill/cancel events can leave local state inconsistent with the exchange.
Fix: Add reconnect plus post-reconnect reconciliation against open orders / recent trades from REST, and persist enough event metadata to dedupe and replay safely.

9. File: `scripts/agents/ws_market_connector.js`
Line: `35`
Severity: High
Description: The market connector reconnects, but it only appends raw websocket messages with a local timestamp. It does not preserve exchange sequence/order metadata, detect gaps across reconnects, dedupe duplicates, or reload a clean snapshot after reconnect. That means message ordering is not trustworthy and stale WAL state can be replayed as if it were continuous.
Fix: Persist provider timestamps/sequence IDs, maintain per-token monotonic ordering checks, and on every reconnect fetch a fresh order book snapshot and emit an explicit gap/reset marker into the WAL.

10. File: `lib/evidence_bundle.js`
Line: `151`
Severity: Medium
Description: `enrichWithMemory()` injects historical similar trades and foresights into the active evidence bundle without any freshness, expiry, or regime filter. `getContextForPosition()` pulls keyword matches from all historical atomic facts and foresights, so old catalysts and obsolete trade lessons can be surfaced into current decisions.
Fix: Filter memory by recency, market regime, and event window before prompt inclusion. For foresights, exclude entries whose `end_time` is already in the past or whose source trade belongs to a materially different regime.

11. File: `lib/foresight_extractor.js`
Line: `432`
Severity: Medium
Description: Foresights are persisted append-only, but there is no invalidation lifecycle. `checkForesightOutcomes()` can score them after a trade closes, yet nothing marks expired forecasts as stale for future retrieval. As a result, old date-bound catalysts remain available to memory retrieval and can bias later trades.
Fix: Add a status field such as `active|expired|resolved|invalidated`, update it when `end_time` passes or outcomes are evaluated, and have retrieval ignore non-active foresights by default.

12. File: `lib/atomic_facts.js`
Line: `384`
Severity: Medium
Description: The incremental fact pipeline appends only new exit-derived fact objects and dedupes by `tokenId::time`. If a prior trade record is corrected later, the stale fact entry is never replaced. The full rebuild path at line 380 also truncates the output file non-atomically before rewrite. Both behaviors can leave retrieval consumers with stale or partially rebuilt fact stores.
Fix: Use content-versioned keys or rewrite-on-change semantics, and rebuild via a temp file plus atomic rename so readers never observe an empty or partial fact store.

13. File: `scripts/paper_transition_model.js`
Line: `213`
Severity: Medium
Description: The transition model trains over the entire historical `regime_states.jsonl` with no time decay, no regime cutoff, and `min-count` defaulting to `1`. Old observations therefore remain fully influential even after the market regime changes, which can make stale paper-history statistics look current.
Fix: Add recency windows or exponential decay, raise default minimum counts, and segment models by category/regime so old sparse episodes do not dominate current transition probabilities.
