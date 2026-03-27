# Polymarket Trading Skill Audit Findings

## Findings

1. **File:** `scripts/agents/execution_agent.js:4-9,59-62,181-184`
   **Severity:** critical
   **Description:** The execution agent is written in CommonJS (`require`, `module.exports` style) inside a package with `"type": "module"`. It also tries to `require('../../lib/wal')` and `require('../../lib/place_order')`, but `lib/wal.js` is an ES module and `lib/place_order` does not exist. In practice, the agent fails before processing any signals.
   **Suggested fix:** Convert `scripts/agents/execution_agent.js` to ESM imports, import the actual exported symbols from `lib/wal.js` and the real order-placement module, and add a startup smoke test that imports and boots the agent.

2. **File:** `scripts/agents/execution_agent.js:156-178`, `lib/wal.js:89-105`
   **Severity:** critical
   **Description:** The agent calls `wal.replay({ gt: lastSeq, filter: ... })` and `wal.tail({ after: lastSeq, filter: ... })` as if they were filtered async streams. The WAL implementation instead exposes `replay(fromSeq, toSeq)` and `tail(limit)` returning arrays. This means checkpointing and source filtering are ignored, old records are replayed again, and the tail path does not provide live streaming.
   **Suggested fix:** Make both sides agree on one API. Either implement filtered async iterators in `lib/wal.js`, or change the agent to call `replay(lastSeq + 1)` and apply filtering locally with an explicit polling loop.

3. **File:** `lib/wal.js:55-61`
   **Severity:** high
   **Description:** Sequence allocation is a read-modify-write on `counters.json` with no locking. Two concurrent appenders can read the same counter, assign the same `seq`, and then overwrite each other. That breaks replay ordering and checkpoint correctness.
   **Suggested fix:** Serialize appends through a single writer, or use a file lock / transactional store so counter increments are atomic across processes.

4. **File:** `lib/wal.js:60-76`
   **Severity:** high
   **Description:** The counter is persisted before the JSONL append. If the process crashes or append fails after `writeCounters`, the sequence number is burned without a matching log entry. Consumers that checkpoint by sequence can then skip events permanently.
   **Suggested fix:** Commit the log record first and only advance durable counters after the append succeeds, or store sequence state in the same atomic record/journal as the event.

5. **File:** `lib/wal.js:65-76`
   **Severity:** medium
   **Description:** The code opens `LOG_PATH` with `fs.open` but never uses or closes the returned file descriptor. Every append leaks an FD until process exit.
   **Suggested fix:** Remove the unused open entirely and call `fs.appendFile` directly, or keep the descriptor and close it in a `finally`.

6. **File:** `lib/memory.js:25-36`
   **Severity:** high
   **Description:** `saveOpenOrder` and `removeOpenOrder` rewrite the full `open_orders.jsonl` file with no locking or atomic rename. Concurrent writers can lose each other’s updates and leave the open-order set inconsistent.
   **Suggested fix:** Use append-only state changes plus compaction, or write to a temp file and rename under a lock.

7. **File:** `lib/memory.js:19-22,39-40`
   **Severity:** medium
   **Description:** `readLines` blindly `JSON.parse`s every line. One truncated or corrupted line crashes `getOpenOrders`, `getFills`, and other callers instead of degrading safely.
   **Suggested fix:** Parse each line in a `try/catch`, skip bad records, and surface corruption metrics separately.

8. **File:** `scripts/paper_trade.js:102-139`
   **Severity:** high
   **Description:** The simulator reuses the same market fill liquidity for every paper order. `m.size` is never decremented after one order consumes it, so multiple signals can all fill against the same historical trade. Paper results will materially overstate fill rate and PnL.
   **Suggested fix:** Track remaining size per market event and consume each fill only once across all simulated orders.

9. **File:** `scripts/strategy_cex_momentum.js:51-56,135-148`
   **Severity:** high
   **Description:** Trade side is inferred from regexes over the market question (`up|higher|above` => YES, `down|lower|below` => NO, else YES). That is brittle and can buy the wrong token when wording is ambiguous or when the market metadata already defines YES/NO semantics explicitly.
   **Suggested fix:** Use normalized market token metadata and outcome labels from discovery instead of natural-language heuristics.

10. **File:** `lib/l2_simulator.js:125-129`
    **Severity:** high
    **Description:** When slippage exceeds the limit, the simulator returns `status: 'rejected_slippage'` but keeps non-zero `filled_usd`, `fill_ratio`, and `avg_fill_price` from the simulated walk. Downstream code can treat rejected trades as executed trades.
    **Suggested fix:** Return zero fill metrics on rejection, or separate “preview” from “accepted execution” into distinct result types.

11. **File:** `lib/order_manager.js:30-37`, `scripts/place_order.js:49-52`
    **Severity:** high
    **Description:** Orders are quantized with `toFixed(2)` for both price and size regardless of the market’s actual tick size and contract precision. This can round prices to invalid levels, shrink order size, or submit at a meaningfully worse level on finer-tick markets.
    **Suggested fix:** Quantize price by the supplied `tickSize`, validate against market rules, and use the correct precision for share size separately from price precision.

12. **File:** `lib/order_manager.js:47-50`
    **Severity:** medium
    **Description:** `placeMaker` catches all API failures, logs them, and returns `null`. That collapses distinct failure modes like auth failure, insufficient balance, bad tick size, and server errors into one silent-ish path and makes retry logic impossible.
    **Suggested fix:** Return a structured error object or rethrow with status/code details so callers can distinguish permanent from retryable failures.

13. **File:** `lib/position_monitor.js:45-80`
    **Severity:** high
    **Description:** The monitor iterates open positions and awaits `closePositionHandler` without marking the position as in-flight. If `checkPositions` is called again before the first close finishes, the same position can be closed twice.
    **Suggested fix:** Set a per-position `closing` flag before awaiting the close, or serialize monitor cycles so only one run can act on a position at a time.

14. **File:** `lib/position_monitor.js:22-28`
    **Severity:** medium
    **Description:** Midpoint API failures are silently converted into stale marks by falling back to `lastMarkPrice`/`entryPrice`. A persistent Polymarket pricing outage can freeze exits while the strategy appears healthy.
    **Suggested fix:** Track consecutive quote failures, emit alerts, and optionally force a safety mode after repeated midpoint errors.

15. **File:** `scripts/setup_auth.js:27-29`
    **Severity:** high
    **Description:** The script says credentials are saved with mode `0600`, but `writeFileSync` is called without `mode` or `chmod`. File permissions therefore depend on the process umask and may be broader than intended.
    **Suggested fix:** Write with `{ mode: 0o600 }` or immediately `chmod` the credential file to `0o600`, then verify permissions.

16. **File:** `scripts/agents/execution_agent.js:13,17-25,53-57`
    **Severity:** medium
    **Description:** Credential loading is tied to `process.cwd()` rather than the shared runtime helper path. Running the agent from a different directory changes which credential file is used and encourages secrets to live in arbitrary working directories.
    **Suggested fix:** Reuse `getCredentialsPath()` / `readApiCreds()` from `lib/runtime.js` so every trading entrypoint resolves credentials consistently.

17. **File:** `lib/agent_memory.js:122-140,212-263`
    **Severity:** medium
    **Description:** Reflections are appended forever and every retrieval/performance call loads the entire JSONL file into memory. Over time this becomes an unbounded memory and latency problem.
    **Suggested fix:** Add retention/compaction, index recent records, and stream or paginate analysis instead of loading the full file on each call.

18. **File:** `lib/context_retrieval.js:177-198,256-316`
    **Severity:** medium
    **Description:** When `DEEPINFRA_API_KEY` is present, the module sends open-position context, rationales, and OSINT snippets to DeepInfra for embeddings. That is a data-exfiltration path with no redaction or explicit opt-in.
    **Suggested fix:** Gate external embedding calls behind an explicit config flag, redact sensitive fields, and document the third-party data flow.

19. **File:** `lib/schema.js:141-146`
    **Severity:** medium
    **Description:** `validateTraderProposal` only enforces `token_id`. It accepts malformed proposals with invalid `action`, negative size, out-of-range price bands, or `entry_band.min > entry_band.max`.
    **Suggested fix:** Validate `action` against an enum, require non-negative sizes, enforce price bounds in `[0,1]`, and ensure `entry_band.min <= entry_band.max`.

20. **File:** `scripts/paper_trade.js:73-75`
    **Severity:** low
    **Description:** Market events are sorted with a comparator that never returns `0` and compares nullable timestamps as strings. Equal timestamps and invalid timestamps can reorder nondeterministically.
    **Suggested fix:** Parse timestamps to numbers, handle invalid values explicitly, and return `0` when records compare equal.

## Notes

- I validated the most severe execution-path issue directly: importing `scripts/agents/execution_agent.js` fails immediately because its dependency loading does not match the module layout.
- I did not run live Polymarket or Binance API calls in this audit. Error-handling findings are based on the code paths present in the repository.
