const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(__dirname, '../docs/verification');
const logs = fs.readdirSync(directory).filter(name => /^acceptance-\d+\.txt$/.test(name)).sort();
const fullLog = logs.findLast(name => /# tests 120\r?\n/.test(fs.readFileSync(path.join(directory, name), 'utf8')));
const focusedLog = logs.at(-1);
for (const name of [fullLog, focusedLog]) {
  if (!name || !/# fail 0\r?\n/.test(fs.readFileSync(path.join(directory, name), 'utf8'))) {
    throw new Error('A completed passing full run and focused rerun are required before rebuilding this acceptance report.');
  }
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const file = name => `<a href="../../${escape(name)}"><code>${escape(name)}</code></a>`;
const files = names => names.map(file).join('<br>');
const rows = data => data.map(([feature, evidence, names]) => `<tr><th scope="row">${feature}</th><td class="pass">Passed</td><td>${evidence}</td><td>${files(names)}</td></tr>`).join('\n');
const authRows = [
  ['Existing comments integration', 'Real Atlas transactions; validation, public visibility, pagination, editor permissions, exact 60-second boundary and rollback all passed.', ['test/comments.integration.test.js', 'controllers/commentsController.js', 'services/comments.js']],
  ['Login across a real process restart', 'Logged in through HTTP, stopped Node, started a new PID, replayed the original session cookie: /auth/me returned 200 and the same user. Full-run PIDs: 18512 → 20572.', ['test/persistence.integration.test.js', 'app.js', 'controllers/authController.js', 'middleware/auth.js', 'models/Session.js']],
  ['Expired session still stored', 'Disabled TTL cleanup only in the disposable test database. Inserted an expired session: /auth/me returned 401 while its database record still existed.', ['test/persistence.integration.test.js', 'middleware/auth.js', 'models/Session.js']],
  ['Logout and cookie replay', 'Logout returned 204, cleared the session cookie and removed the session record; replay returned 401.', ['test/persistence.integration.test.js', 'controllers/authController.js']],
  ['Task 2 session revocation', 'Password reset revoked multiple original cookies across another process restart; old password failed and the new password succeeded. Existing maintenance suite also verified account deletion revocation and transactional rollback.', ['test/persistence.integration.test.js', 'test/user-maintenance.integration.test.js', 'models/userMaintenance.js', 'docs/USER_MAINTENANCE.md']],
  ['Role changes remove old privileges', 'Editor → Reporter maintenance revoked the old session: /editor returned 401. A fresh login reported Reporter and received 403 on /editor. Maintenance suite verified an unchanged role preserves sessions.', ['test/persistence.integration.test.js', 'test/user-maintenance.integration.test.js', 'models/userMaintenance.js', 'middleware/auth.js']],
  ['Comments and Guest limits survive restart', 'Saved comments remained readable from HTTP and MongoDB. Three successful Guest posts across two articles before restart caused the fourth post after restart to return 429 with Retry-After.', ['test/persistence.integration.test.js', 'models/Comment.js', 'models/GuestCommentLimit.js', 'services/comments.js']],
  ['Device isolation and simultaneous requests', 'A second device received its own three-post quota. Ten simultaneous requests across two articles produced exactly 3 × 201, 7 × 429 and exactly three new comment records.', ['test/persistence.integration.test.js', 'test/comments.integration.test.js', 'middleware/deviceIdentity.js', 'services/comments.js']]
];
const weatherRows = [
  ['Current provider conditions', 'Checked 12 October 2026. Open-Meteo offers non-commercial access without a key, signup or credit card. Free limits: 600/minute, 5,000/hour, 10,000/day and 300,000/month. Attribution is present. See primary sources below.', ['README.md', 'views/partials/weather.ejs']],
  ['Configured-location live integration', 'Tel Aviv (32.0853, 34.7818) returned available conditions from the real provider. The live check asserts configured location, ordered timestamps and expiry within 15 minutes.', ['test/weather-live.integration.test.js', 'services/weather.js', '.env.example']],
  ['Cache and one in-flight refresh', 'Fifty concurrent live callers shared exactly one successful provider request; subsequent warm-cache access made no request. Mocked tests also exercised 100 callers on cold and expired caches.', ['test/weather-live.integration.test.js', 'test/weather.test.js', 'services/weather.js']],
  ['Unavailable states and recovery', 'Controlled outage returned unavailable; 50 callers during retry backoff caused no extra provider calls. Recovery used the real provider. Mocked checks cover HTTP/network/JSON failures, timeout, invalid configuration and old/future data.', ['test/weather-live.integration.test.js', 'test/weather.test.js', 'services/weather.js']],
  ['Endpoint timestamps and caching headers', 'Available/unavailable HTTP contracts passed; Cache-Control is no-store, X-Weather-Server-Time is valid, and weather bypasses session lookup.', ['test/weather.test.js', 'routes/weather.js', 'controllers/weatherController.js']],
  ['Desktop, tablet and mobile with merged D3 layout', 'Browser checked actual index/sidebar templates and base.css at 1440 × 1000, 768 × 1024 and 390 × 844. Desktop sidebar sits beside content; tablet/mobile stack below it. No horizontal overflow. Live available and unavailable states were visible.', ['scripts/acceptancePreview.js', 'views/index.ejs', 'views/partials/sidebar.ejs', 'views/partials/weather.ejs', 'public/base.css']],
  ['Long-open page expiry', 'Browser loaded a controlled fixed five-second expiry through the real weather client. Without reload, conditions disappeared and the unavailable message became visible. Controlled-clock tests also cover stalled refreshes and suspended timers.', ['scripts/acceptancePreview.js', 'public/weather.js', 'test/weather-client.test.js']],
  ['Background tabs and navigation', 'Controlled browser-environment tests pass for visibilitychange, pagehide/pageshow, focus after suspension and a request finishing after backgrounding. This automated evidence is distinct from the real-browser expiry and layout checks.', ['public/weather.js', 'test/weather-client.test.js']]
];
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Daily Web — Tasks 5 &amp; 6 verification</title>
<style>
:root{color-scheme:light;--ink:#172d42;--muted:#53677a;--line:#d8e1e8;--paper:#f7f9fa;--pass:#25603d;--amber:#85520c}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 'Segoe UI',sans-serif}main{max-width:1200px;margin:auto;padding:48px 28px 80px}header{border-top:5px solid var(--ink);border-bottom:1px solid var(--line);padding:24px 0}h1,h2,h3{font-family:Georgia,serif;line-height:1.2}h1{font-size:clamp(2rem,4vw,3.4rem);max-width:850px;margin:12px 0 20px}h2{font-size:1.8rem;margin:44px 0 14px}h3{font-size:1.15rem}p{max-width:920px}a{color:#104c79;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #155e96;outline-offset:4px}.eyebrow{font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}.lead{font-size:1.15rem}.pass{color:var(--pass);font-weight:650}.note{padding:14px 18px;background:#eaf3f9;border-left:4px solid #155e96}.warning{border-left-color:var(--amber);background:#fff4df}nav{display:flex;flex-wrap:wrap;gap:12px 24px;margin:24px 0}table{border-collapse:collapse;width:100%;background:white;font-size:.92rem}caption{text-align:left;color:var(--muted);margin:12px 0}th,td{text-align:left;vertical-align:top;padding:16px 13px;border-bottom:1px solid var(--line)}thead{background:#eaf0f5}thead th:nth-child(1){width:20%}thead th:nth-child(2){width:8%}thead th:nth-child(3){width:43%}tbody th{font-weight:650}code{font: .85rem/1.5 Consolas,monospace;overflow-wrap:anywhere}td a{display:inline-block;margin-bottom:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#172d42;color:#f7f9fa;padding:20px;border-radius:3px}details{border-block:1px solid var(--line);padding:15px 0;margin-top:20px}summary{cursor:pointer;font-weight:600}footer{border-top:1px solid var(--line);margin-top:44px;padding-top:18px;color:var(--muted);font-size:.85rem}
@media(max-width:700px){main{padding:24px 16px 48px}table,tbody,tr,td,tbody th{display:block}thead{display:none}tr{border:1px solid var(--line);margin:16px 0;padding:8px}th,td{padding:8px;border:0}tbody th{font-size:1.08rem}td:last-child{border-top:1px solid var(--line);margin-top:8px}caption{display:block}h2{font-size:1.6rem}}
@media print{body{background:white}main{padding:0}nav{display:none}tr{break-inside:avoid}a{color:inherit}}
</style></head><body><main>
<header><div class="eyebrow">The Daily Web · Acceptance evidence · 12 October 2026 · Asia/Jerusalem</div>
<h1>Authentication, comments &amp; weather verification</h1>
<p class="lead"><strong class="pass">Task 5 scenarios passed.</strong> <strong class="pass">Task 6 live integration, layout and expiry checks passed.</strong></p>
<p>Full regression: <strong>118 passed, 0 failed, 2 skipped</strong> (120 checks; 47.74 seconds). Skipped checks are the optional real-database CSRF and feed suites, outside these two tasks. Final focused rerun is recorded separately after test-harness improvements.</p>
<p>Tests used fresh disposable databases on the supplied Atlas cluster. The supplied <code>the_daily_web_dev3</code> database was not used for test fixtures or destructive cleanup. Credentials are omitted.</p></header>
<nav aria-label="Report sections"><a href="#task5">Task 5</a><a href="#task6">Task 6</a><a href="#failures">Failures &amp; fixes</a><a href="#repeat">Repeat the checks</a><a href="#evidence">Evidence &amp; limits</a></nav>
<section id="task5"><h2>Task 5 — Authentication and comment persistence</h2><p>Goal: demonstrate that database-backed behavior survives real process restarts. Acceptance depends on the merged Tasks 2–4 behavior; this run exercises their existing account-maintenance, session and comments implementations.</p>
<table><caption>Every requested Task 5 scenario, with implementation and repeatable test files.</caption><thead><tr><th>Feature tested</th><th>Result</th><th>Observed evidence</th><th>Relevant files</th></tr></thead><tbody>${rows(authRows)}</tbody></table></section>
<section id="task6"><h2>Task 6 — Weather acceptance</h2><p>Goal: verify the merged implementation in realistic conditions. Browser layout checks use D3’s merged templates and styles with an empty feed, without database writes. This is verification of the merged code, not a separate team-member signoff.</p>
<table><caption>Live-provider, real-browser and controlled failure checks are identified separately.</caption><thead><tr><th>Feature tested</th><th>Result</th><th>Observed evidence</th><th>Relevant files</th></tr></thead><tbody>${rows(weatherRows)}</tbody></table>
<p>Provider sources checked during this run: <a href="https://open-meteo.com/">no signup / no credit card</a>, <a href="https://open-meteo.com/en/terms">non-commercial terms and request limits</a>, <a href="https://open-meteo.com/en/pricing">free-tier capacity</a>. Educational use is listed in the terms. Weather is model-based current-condition data; freshness is measured using its condition timestamp.</p>
<p class="note"><strong>Preserved limitation:</strong> weather caching and the in-flight refresh are shared within one server process. Multiple Node processes each have their own cache. These checks do not claim distributed-cache behavior or a thousands-of-readers load test.</p></section>
<section id="failures"><h2>What failed, and what changed</h2>
<table><caption>Failures encountered during verification; none remains an observed application failure.</caption><thead><tr><th>Failure</th><th>Classification</th><th>Resolution</th><th>Relevant files</th></tr></thead><tbody>
<tr><th scope="row">MongoDB DNS timeout; local fetch denied</th><td>Environment</td><td>Sandbox restrictions caused ETIMEOUT / EACCES. Network-authorized reruns passed.</td><td>${file('scripts/runAcceptance.js')}</td></tr>
<tr><th scope="row">Test database names exceeded 38 bytes</th><td>Harness, resolved</td><td>This Atlas tier rejected long random suffixes. Shortened generated names and retained disposable-name guards.</td><td>${file('scripts/runAcceptance.js')}</td></tr>
<tr><th scope="row">Login test selected the device cookie</th><td>Harness, resolved</td><td>Selected wd_session from getSetCookie() instead of assuming the first Set-Cookie header was the session.</td><td>${file('test/persistence.integration.test.js')}</td></tr>
<tr><th scope="row">Comments cleanup guard ran after connection</th><td>Test safety improved</td><td>Validate the disposable name before connecting; disable automatic collection creation; require an empty database before enabling cleanup. This guards against dropping existing data.</td><td>${file('test/comments.integration.test.js')}</td></tr>
<tr><th scope="row">Browser loopback preview timed out</th><td>Environment, resolved</td><td>Started the preview with approved network access and opened localhost in a fresh tab; browser checks then passed.</td><td>${file('scripts/acceptancePreview.js')}</td></tr>
</tbody></table><p>No production authentication, comments or weather defect was found in the exercised scenarios. Changes add repeatable verification and improve integration-test isolation; no production dependency was added.</p></section>
<section id="repeat"><h2>Repeat the checks</h2><p>Supply <code>ACCEPTANCE_MONGODB_URI</code> securely in the shell environment. Do not commit it. The runner replaces only the database name, creates fresh test databases, and each successful integration run drops its own disposable database. The cluster must permit transactions and disposable-database creation.</p>
<pre>node scripts/runAcceptance.js test/comments.integration.test.js test/user-maintenance.integration.test.js test/persistence.integration.test.js test/weather.test.js test/weather-client.test.js</pre>
<p>For live weather, set <code>WEATHER_LIVE_TEST=1</code> and configure <code>WEATHER_LOCATION</code>, <code>WEATHER_LATITUDE</code>, and <code>WEATHER_LONGITUDE</code> through the environment or untracked <code>.env</code>. Then run:</p>
<pre>node --env-file-if-exists=.env scripts/runAcceptance.js</pre>
<p>For browser checks, run the loopback-only preview. It renders the actual public templates and assets with an empty feed. The preview’s short-expiry fixture is test-only.</p>
<pre>node --env-file-if-exists=.env scripts/acceptancePreview.js
http://localhost:3407/
http://localhost:3407/preview-mode/expiry
http://localhost:3407/preview-mode/unavailable
http://localhost:3407/preview-mode/live</pre>
<p>Check 1440 × 1000, 768 × 1024 and 390 × 844. Open the expiry fixture and follow “Open homepage” promptly; conditions must hide after the fixed deadline without a reload. Return to live mode for recovery.</p></section>
<section id="evidence"><h2>Recorded evidence and acceptance limits</h2><ul>
<li><a href="${escape(fullLog)}">Full regression output: 118 passed / 0 failed / 2 skipped</a></li>
<li><a href="${escape(focusedLog)}">Final focused rerun: database safety and live-provider checks</a></li>
<li><a href="acceptance-1791785032751.txt">Focused restart output: 9 passed / 0 failed, including eight acceptance scenarios</a></li>
<li>${file('docs/PROJECT_REQUIREMENTS.md')} — source of truth, sections 6.3, 15 and 17.</li>
</ul><p>Background/suspension cases use controlled browser-environment tests; the real-browser long-open check uses a short fixed expiry rather than waiting 15 minutes. Layout observations apply to the merged homepage/sidebar with an empty feed. Account deletion and rollback are covered by the existing real-database maintenance suite. Cookie-based device isolation assumes the device cookie is retained.</p>
<details><summary>Earlier diagnostic logs</summary><ul>${logs.filter(name => name !== fullLog && name !== focusedLog).map(name => `<li><a href="${escape(name)}">${escape(name)}</a></li>`).join('')}</ul></details>
</section><footer>Self-contained HTML report created with the html-plan skill. Structure follows Tasks 5 and 6, followed by failures, repeatable commands and evidence. Essential styling is inline; source and evidence links require the accompanying repository files. The verification folder is retained; other documentation keeps its existing ignore behavior.</footer>
</main></body></html>`;
fs.writeFileSync(path.join(directory, 'report.html'), html);
console.log(path.join(directory, 'report.html'));
