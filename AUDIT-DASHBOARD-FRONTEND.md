# Polymarket Dashboard Frontend Audit

Audited on 2026-03-26 against:
- `/tmp/polymarket-audit/dashboard/services/index.html`
- `/tmp/polymarket-audit/dashboard/services/mobile.html`
- `/tmp/polymarket-audit/dashboard/app/neural.html`

## Scope Summary
- No API keys, bearer tokens, secrets, or credentials were found in the audited frontend files.
- No `localStorage`/`sessionStorage` token persistence was found.
- No state-changing frontend requests were found in these files, so there is no direct CSRF exposure in the audited code paths.
- No `eval()`, `new Function()`, or `document.write()` usage was found.
- Desktop and mobile dashboards are largely static and have materially lower XSS/CSRF risk than `app/neural.html`.

## Findings

### 1. P1 - Third-party script supply-chain risk from runtime Tailwind CDN without integrity pinning
- File: `/tmp/polymarket-audit/dashboard/services/index.html:6`
- File: `/tmp/polymarket-audit/dashboard/services/mobile.html:6`
- Severity: `P1`
- Type: `Third-party scripts / supply-chain risk`
- Description: Both dashboards load executable JavaScript from `https://cdn.tailwindcss.com` at runtime. This gives a third-party CDN control over code execution in the dashboard origin. There is no Subresource Integrity hash, no self-hosted bundle, and no visible CSP restriction in these files. If the CDN, DNS path, or upstream account is compromised, an attacker gets full DOM access.
- Fix: Remove the runtime CDN script in production. Build Tailwind ahead of time and serve a pinned local CSS artifact. If any remote script remains, pin it with SRI and enforce a strict `Content-Security-Policy`.

### 2. P2 - Unbounded SSE message parsing can be abused for client-side DoS
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:529`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:531`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:532`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:533`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:534`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:535`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:536`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:537`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:538`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:539`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:540`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:541`
- Severity: `P2`
- Type: `WebSocket/SSE security`
- Description: The neural view accepts every SSE event and immediately runs `JSON.parse(e.data)` with no schema validation, size limit, or rate limiting. A malicious or compromised backend, reverse proxy, or same-origin response injection could send oversized payloads or event floods that freeze the tab, exhaust memory, or trigger repeated expensive graph updates.
- Fix: Reject events above a strict byte limit before parsing, validate event schemas per event type, cap array sizes before rendering, and debounce or batch graph mutations. Server-side should also enforce event size and rate limits.

### 3. P2 - SSE reconnect strategy can amplify outages and create client reconnection storms
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:527`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:543`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:624`
- Severity: `P2`
- Type: `WebSocket/SSE security / availability`
- Description: On every SSE error, the page closes the stream and reconnects after a fixed 5-second delay. In parallel, `setInterval(loadAll, 30000)` continues polling all backend datasets. Across many clients, a backend outage will synchronize reconnect and reload traffic, which increases recovery pressure and can turn a transient failure into a prolonged one.
- Fix: Use exponential backoff with jitter, suspend full refreshes while the stream is unhealthy, and gate reconnects behind a max retry window or health check.

### 4. P3 - Production console warnings leak internal API surface and backend failure details
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:229`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:232`
- Severity: `P3`
- Type: `Information leakage`
- Description: Fetch failures log the exact internal API path plus the thrown error object to the browser console. In production this exposes backend routes such as `/api/memory/evolver`, response status details, and failure behavior to any user with devtools access. This is low severity, but it gives attackers and curious users unnecessary reconnaissance data.
- Fix: Replace raw `console.warn(url, err)` with sanitized telemetry behind a debug flag, and show only generic user-facing status messages in production.

### 5. P3 - External image/font dependencies leak client metadata and weaken asset trust boundaries
- File: `/tmp/polymarket-audit/dashboard/services/index.html:7`
- File: `/tmp/polymarket-audit/dashboard/services/index.html:8`
- File: `/tmp/polymarket-audit/dashboard/services/index.html:100`
- File: `/tmp/polymarket-audit/dashboard/services/index.html:533`
- File: `/tmp/polymarket-audit/dashboard/services/mobile.html:7`
- File: `/tmp/polymarket-audit/dashboard/services/mobile.html:8`
- File: `/tmp/polymarket-audit/dashboard/services/mobile.html:113`
- Severity: `P3`
- Type: `Sensitive data exposure / third-party dependency`
- Description: The static dashboards fetch fonts from Google Fonts and images from `googleusercontent.com`. That leaks user IP addresses and request metadata to third parties whenever the dashboard loads. On an internal trading console, that may be an avoidable privacy and operational exposure.
- Fix: Self-host fonts and image assets, or at minimum apply `referrerpolicy="no-referrer"` where external fetches are unavoidable and document the third-party data flow.

### 6. P3 - HTML sink remains in use in the neural tooltip; currently escaped but fragile
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:226`
- File: `/tmp/polymarket-audit/dashboard/app/neural.html:604`
- Severity: `P3`
- Type: `XSS hardening`
- Description: The tooltip renderer uses `innerHTML` with server-fed node fields. The current code does call `htmlEscape(...)`, so I do not see an immediately exploitable XSS in this sink. The risk is that this remains a high-value sink that can become exploitable if future fields are added without escaping or if the escaping helper is bypassed during refactors.
- Fix: Replace `innerHTML` with explicit DOM node creation plus `textContent`, or centralize sanitization behind a tested helper and add regression tests for hostile payloads.

## Category Notes
- XSS: No direct exploitable XSS was found in the audited files. The only HTML sink in scope is escaped today, but should still be removed or hardened.
- Sensitive data exposure: No secrets, tokens, or credentials were found in frontend code. Main exposure is third-party asset loading.
- CSRF: No write requests were present in these frontend files. If write APIs exist elsewhere in the app, CSRF posture needs to be verified there.
- Mobile consistency: `services/mobile.html` has the same third-party CDN/script trust issues as the desktop page, but fewer dynamic behaviors and no extra mobile-only DOM sinks.
- Input handling: No URL parameter parsing, search boxes, or user-editable form handling were found in the audited files.
