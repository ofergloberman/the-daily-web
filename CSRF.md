# Shared CSRF contract

Status: implemented proposed D1 contract; D2/D4 review is pending. Use this contract for every new mutation route. It complements the server's session, role, ownership and article-state checks.

`middleware/csrf.js` runs globally before body parsing, cookies, authentication and routes. Every method other than GET, HEAD and OPTIONS requires same-origin evidence, including login/logout, guest and authenticated comments, Reporter create/autosave/submit, Editor comment edit/delete, and reserved/future article mutations. Rejected requests cannot reach a database writer or create cookies. Public reads remain accessible. GET/HEAD/OPTIONS must never create, edit or delete user content; existing visit statistics and device identity on public reads remain intentional read-side bookkeeping.

## Origin and fallback

- Configure `APP_ORIGIN` to the exact public browser origin, for example `http://localhost:3000` or `https://news.example.org`. It contains scheme, host and optional port, with no credentials, path, query or fragment. Production requires an explicit HTTPS origin; startup rejects missing/invalid configuration. A running app with invalid configuration fails mutations closed with HTTP 503 `CSRF_UNAVAILABLE`.
- Development defaults to `http://localhost:${PORT || 3000}`. `localhost` and `127.0.0.1` are different origins: choose one URL and set APP_ORIGIN accordingly. Changing ports requires updating APP_ORIGIN. No request Host, X-Forwarded-Host or X-Forwarded-Proto value is trusted to select the expected origin. Behind a reverse proxy, configure the external HTTPS origin directly.
- If `Origin` exists, it must be a single canonical HTTP(S) origin matching the configured origin exactly. Reject `null`, malformed, multiple or foreign values. An invalid/present Origin never falls back to Referer.
- Only when Origin is absent, parse the absolute HTTP(S) `Referer` and require the same origin. Reject credentials in Referer. If both are absent, reject; there is no cookie-free, guest, login, test or local-development exemption. `Sec-Fetch-Site: cross-site` also rejects a mutation.
- Fail with HTTP 403 JSON `{ "error": "CSRF_REJECTED", "message": "Open this site directly and retry your request." }`. No state changes. Do not retry by disabling the check. Privacy tools stripping both headers must permit one or the request cannot proceed.

## Forms and AJAX integration for D2/D4

Use relative same-origin form actions and fetch URLs. Normal browser forms and same-origin AJAX send Origin or Referer automatically, so no token, hidden field, custom browser header or new dependency is needed. Keep default referrer behavior; do not set a no-referrer policy for mutation requests. Browser JavaScript cannot set Origin. Native HTTP clients and integration tests must explicitly supply the configured Origin header. Header validation protects browser requests; it is not authentication for non-browser clients.

Do not mount mutation routes before `csrfProtection`, add mutations to GET/HEAD/OPTIONS, enable cross-origin credentialed APIs or remove role/ownership/state validation. SameSite=Lax cookies remain defense in depth. Future Editor article handlers inherit protection automatically. Operators using the local user CLI connect to MongoDB and do not use HTTP; see USER_MAINTENANCE.md.

The browser semantics used here are documented by MDN: [Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin) and [Referer](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer).

## Verification

`node --test test/csrf.test.js` covers accepted forms/AJAX, Origin precedence, Referer fallback, missing/null/malformed/foreign evidence, port/scheme mismatches, hostile Host/proxy headers, unavailable configuration, and every mutation route rejecting before model access. Existing route tests send a legitimate Origin and continue to verify authorization, ownership and state transitions. Real database verification in `test/csrf.integration.test.js` additionally proves rejection leaves users, sessions, articles and comments unchanged. Run it with `CSRF_TEST_MONGODB_URI` naming a fresh `the_daily_web_csrf_test_<hex>` replica-set database (the suite drops only that empty disposable database). Run `npm test` for regression coverage.
