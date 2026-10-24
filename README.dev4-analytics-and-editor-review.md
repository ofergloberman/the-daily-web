# Developer 4: analytics and Editor review

Developer 4's part of The Web Daily: view recording, Impact analytics (requirements §11 and §12), the Editor desk and review page, the demo seed, and Phase E hardening. The Editor actions call Developer 2's shared workflow (`models/articleWorkflow.js`), which also creates the publication events. Phase E hardening (error pages, 503 handling, safe logs) is included. The `explain:dev4` performance script from the `dev4/defense-readiness` branch is not part of this version.

## What was built

| Area | Result |
| --- | --- |
| View recording | `services/visits.js` records each public article visit through `recordVisit` in `models/analyticsOperations.js` |
| Analytics queries | `getViewSeries` returns views per time bucket, zero-filled, plus every publication with its views in the range |
| Analytics page | `/analytics` (Editor only): title search, time-range selector, Canvas graph with publication markers, versions table |
| Editor desk | `/editor`: all articles, title search, status filter, pagination (search also over AJAX at `GET /editor/articles`) |
| Review page | `/editor/articles/:id`: published snapshot beside the working draft, with "Changed" badges and the correction note |

## How it works

### Recording a visit

1. The public article page calls `visits.recordVisit(article)` without waiting for it. A failure is logged and never breaks the page.
2. The service passes `Article.currentPublication`, the version actually served. `analyticsOperations.recordVisit` first increments `Article.totalViews`; an article with no `currentPublication` (or one that was just deleted) gets no time bucket.
3. Otherwise it runs one `updateOne` with `$inc: { count: 1 }` and `upsert: true` on the bucket `(article, minute, publication)`.
4. If two first visits race on the unique index, the duplicate-key error (code 11000) triggers one retry. Any other error is rethrown.

Real-database check: 200 concurrent visits to a new bucket were all counted.

### Reading a graph

`GET /analytics/articles/:id/views?from=&to=` (ISO 8601 times, default last 7 days, maximum 366 days):

| Range | Bucket | Points at most |
| --- | --- | --- |
| up to 6 hours | minute | 360 |
| up to 31 days | hour | 744 |
| up to 366 days | day (UTC) | 367 |

Response shape: `{ data: { article, unit, from, to, points, splits, publications } }`. `points` are the zero-filled views per bucket; `splits` lists, for each bucket that contains an approval, the views per publication, so the graph line can step at the marker; `publications` are the approved versions with the views each received in the range. Errors are `{ error, message }` with 400 (`INVALID_ARTICLE_ID`, `INVALID_RANGE`, `INVALID_QUERY`) or 404 (`ARTICLE_NOT_FOUND`).

The page shows views per hour while each version was live (inside the range), so the Editor can compare behaviour before and after an update. Markers on the graph are numbered like the rows of the versions table.

### Editor desk

- `GET /editor?q=&status=&page=` accepts `draft`, `pending`, `published` or `returned` as `status`. Invalid values return 400.
- A pending or returned article that has a published version is labelled "Update to a published article".
- Server-side authorization: both routers are mounted behind `requireEditor` in `app.js`. A guest gets 401 and a reporter gets 403.

### Editor desk search (Phase F)

The search box sits above the status chips. It matches the title, case-insensitively and as a substring, in both `draft.title` (what waits for approval) and `published.title` (the live title), so an article is found by either name. Search, status filter and pagination combine, every link keeps the other two values, and a new search returns to page 1.

- **Page and JSON route.** `GET /editor?q=&status=&page=` renders the page; `GET /editor/articles?q=&status=&page=` returns `200 { data: { articles, page, hasNext } }` for the AJAX script. Both use one `parseDeskQuery`, so they accept the same input. Errors are `400 { error, message }` with `INVALID_PAGE`, `INVALID_STATUS` or `INVALID_SEARCH` (an array `q`, or more than `EDITOR_SEARCH_MAX_LENGTH` = 100 characters). A whitespace-only `q` means no search. Guests get 401 and Reporters 403 from the existing `requireEditor` mount.
- **Row shape.** `toDeskRow` returns `{ id, title, authorName, updatedAt, updatedLabel, status, statusLabel, isPublishedUpdate }` for the EJS page and the JSON route alike. `updatedLabel` is the date as readers see it (`formatDate`, Israel time), so the browser script never formats dates itself.
- **No JavaScript needed.** The search is a plain GET form. `public/editor-desk.js` upgrades it: results update while typing (300 ms pause), status chips and page links load without a reload, a newer request cancels the older one (`AbortController` plus a generation check), the list gets `aria-busy` while loading, failures appear in the status line, and `history.replaceState` keeps the address bar (`/editor?q=...`) in sync, so a refresh shows the same results. Rows are built with `textContent` only.
- **Why a regex and not `$text`.** MongoDB allows one text index per collection and it is on `published.title` for the public search. Adding `draft.title` to it would let public search match words that exist only in unpublished drafts. A regex finds partial words ("Unit" finds "United") and works for Hebrew titles. The term goes through `escapeRegExp` first, so `.`, `*`, `(` and similar characters are literal and cannot build a slow or invalid pattern.
- **Cost.** No new index. A regex cannot use the text index, so MongoDB walks the existing `{ status, updatedAt, _id }` / `{ updatedAt, _id }` index in desk order and stops after 21 matches; a rare term can scan every article. This is acceptable because only Editors use the route and the collection holds a few thousand articles at most.
- The "Clear search" link in the form is always in the page and is hidden while there is no search, so the script can show it as soon as the Editor types.

### Errors, outages and logs (Phase E)

- **Pages for browsers, JSON for `fetch`.** `helpers/sendError.js` has one function, `sendError(req, res, status, code, message)`. A `GET` whose `Accept` prefers HTML gets `views/error.ejs` (heading, message, a link back); every other request gets `{ error, message }`. `fetch` sends `Accept: */*` or `application/json`, so the AJAX code keeps getting JSON. Error codes did not change; `message` was added.
- **Logged-out browsers go to the login page.** `requireRole` answers a guest's HTML `GET` with `303 /auth`. A guest's `fetch` or unsafe request still gets `401 { error: 'AUTH_REQUIRED', message }`. A Reporter gets `403` (an error page for an HTML `GET`, JSON otherwise).
- **Invalid input never crashes.** `/editor?page=abc` renders a 400 page with a link back to `/editor`; `/editor/articles?page=abc` stays a JSON 400. Malformed JSON is `400 INVALID_JSON`, a body over 100 kb is `413 PAYLOAD_TOO_LARGE`, and an address Express cannot decode (`%zz`) is `400 BAD_REQUEST`.
- **Database down.** If a request fails while `mongoose.connection.readyState` is not connected, the global handler answers `503 DATABASE_UNAVAILABLE`. `bufferTimeoutMS` and `serverSelectionTimeoutMS` are both 5000 ms (named constants in `config/database.js`), so the request fails in seconds. `MongoDB disconnected` and `MongoDB reconnected` are logged on every outage and recovery; the connection recovers by itself.
- **Logs.** A failed request logs `Request failed: <METHOD> <path> <status> <error name>`: no query string, body, cookie, token, password, error object, stack or database URI. An Editor action logs `Editor <verb> article: editor <user id>, article <article id>`. A visit that cannot be recorded logs `Visit not recorded: <error name>`. Scripts print failures through `redactConnectionStrings`.
- **Browser failure paths.** `editor-desk.js`, `editor-actions.js` and `analytics.js` send `Accept: application/json`, and a rejected `fetch`, a non-JSON answer (a proxy's HTML 502), a JSON answer without `data`, a 401 and a 403 each show a message in the page's status line. A 401 also shows a "Sign in again" link. Buttons are enabled again, and the Editor's note and edits stay in the form.

### Query performance (Phase E)

The `explain:dev4` script is not part of this version, so no timing table is kept here. The queries use these indexes, which were checked with `explain('executionStats')` and showed no collection scans:

| Query | Index |
| --- | --- |
| Desk list, all statuses | `{ updatedAt, _id }` |
| Desk list, one status | `{ status, updatedAt, _id }` |
| Analytics title search | `published.title` text index, or `{ publishedAt, _id }` / `{ totalViews, _id }` with no term |
| `getViewSeries` | `{ article, minute, publication }` on `ViewStatistic` |
| Publication markers | `{ article, publishedAt }` on `PublicationEvent` |
| `recordVisit` | `_id` on Article and `{ article, minute, publication }` on `ViewStatistic` |

The public feed has its own explain tool: `npm run explain:dev3` (see `README.md`). To check visit counting under load by hand, send many concurrent `GET` requests to one published article and confirm that `Article.totalViews` and the sum of that article's view buckets grew by the same amount, and that a `HEAD` request adds nothing. Real-database tests confirmed that 200 concurrent first visits were all counted.

## Files

New:

- `models/analyticsOperations.js`, `models/editorArticleQueries.js`
- `controllers/editorController.js`, `controllers/analyticsController.js`
- `routes/editor.js`, `routes/analytics.js`
- `helpers/pagination.js`, `helpers/escapeRegExp.js`
- `views/editor/` (dashboard, review, reviewValue), `views/analytics/index.ejs`
- `public/editor.css`, `public/analytics.css`, `public/analytics.js`, `public/editor-desk.js`
- `test/analytics-operations.test.js`, `test/editor-analytics.test.js`, `test/editor-search.test.js`, `test/editor-desk-client.test.js`
- Phase E: `helpers/sendError.js`, `views/error.ejs`, `test/dev4-hardening.test.js`, `test/css-policy.test.js`, `test/connectionState.js`

Changed:

- `services/visits.js` (placeholder replaced)
- `app.js` (mounts `/editor` and `/analytics`; the starter `editorArea` route is gone; Phase E: 404 and error handler)
- `controllers/authController.js` (`editorArea` removed), `views/workArea.ejs` (deleted)
- `test/auth.test.js`, `test/public-article.test.js` (mocks adjusted for the new queries)
- `README.md` (structure, routes, analytics operations)
- Phase E, shared files (agree with the owners): `middleware/auth.js`, `app.js`, `config/database.js`, `scripts/demoGuard.js`, `scripts/seedDemoFixtures.js`
- Phase E, Developer 4 files: the three controllers, `models/analyticsOperations.js`, `models/editorArticleQueries.js`, `public/editor-desk.js`, `public/editor-actions.js`, `public/analytics.js`, `public/editor.css`, `public/analytics.css`, the editor and analytics views

## Tests

```powershell
npm test
```

The suite currently runs 288 tests: 282 pass and 6 are skipped (they need a real MongoDB or network). They use Mongoose mocks and need no database. The aggregation, upsert race, text search and index use were also verified once against a real in-memory MongoDB with a throwaway script that is not committed. `test/dev4-hardening.test.js` covers the error pages, the authorization and invalid-input matrices for every Developer 4 route, the 500 and 503 answers, the log contents and the browser failure paths; `test/css-policy.test.js` guards the Flexbox-only and no-cross-origin rules.

## Running locally

1. In `the-daily-web`, copy `.env.example` to `.env` and set `MONGODB_URI` to the Atlas connection string with a database user. Never commit it or paste it in chat.
2. Add your IP to Atlas Network Access.
3. Create accounts: `npm run create-user -- editor1 'Editor One' editor`, reading the password privately as in `README.md`.
4. `npm run dev`, then sign in at `http://localhost:3000/auth`.
5. For sample articles with analytics, set `DEMO_REPORTER_PASSWORD` and `DEMO_EDITOR_PASSWORD` in `.env`, point `MONGODB_URI` at a database name ending in `_demo` and run `npm run seed:demo` (520 articles, six Reporters, one Editor, publication events and view history from each article's first publication (1 hour to 45 days ago) up to now; see "Demo dataset" in `README.md`). The older `npm run seed:dev3` fixtures (`_dev3` database) have no publication events, so their views are not counted and the graph stays empty.

## Not done yet

| Item | State |
| --- | --- |
| Phase E: hardening and defense readiness | Code, tests and documentation done. Still to do by hand: the responsive check in a browser (360 / 768 / 1024 / 1440 px), the outage check, and one full run of the demo script |
| `explain:dev4` performance script and visit load test | Not implemented in this version (it exists only on the `dev4/defense-readiness` branch) |

**Done:** the Editor actions (approve, return with note, edit, delete; `routes/editor.js` and `controllers/editorActionsController.js`, calling the shared workflow in `models/articleWorkflow.js`), `Article.currentPublication`, the `totalViews` increment in `recordVisit`, the `{ status, updatedAt, _id }` index on Article, and the Phase D seed runner (`scripts/seedDemoFixtures.js`, guarded by `scripts/demoGuard.js`). All are finished and tested.

## Decisions to confirm with the team

- Page parsing (`helpers/pagination.js`), workflow error replies (`helpers/workflowResponse.js`) and regex escaping are shared by the Reporter, Editor and seed code instead of being copied.
- Status labels live in `editorController.js` and in `reporterDashboard.ejs`. They could move to a shared place later.
- `/editor` and `/analytics` were mounted in `app.js`, a file the plan assigns to Developer 1.
- Phase E touches shared files: `middleware/auth.js` (Developer 1: error answers and the login redirect) and `app.js` and `config/database.js` (shared foundation: error handler, 503, timeouts, connection logs). Every existing error code is unchanged and only `message` was added; the one new code is `BAD_REQUEST`, for a request the server cannot understand (an undecodable address such as `%zz`, or an unsupported charset or encoding, which is answered with its own 4xx status such as 415). Confirm with the owners before the pull request.
- The 503 check in the error handler runs after the client-mistake answers (bad JSON, body too large, undecodable address), so those stay 4xx during an outage.

## Demo script (requirements §11, §12, §15, §16, §18)

Prepare: `npm run seed:demo` against a `_demo` database, `npm run dev`, sign in at `/auth` as `demo-editor` (password from `DEMO_EDITOR_PASSWORD`). Demo Reporters are `demo-reporter-1` to `demo-reporter-6` (password from `DEMO_REPORTER_PASSWORD`). Sign out first (header "Sign out") before switching role, because `/auth` redirects a signed-in user to their own area.

1. **View all and filter (§11).** Open `/editor`. Click each status chip (All, Draft, Pending approval, Published, Returned). Go to page 2 and check the chip stays selected and the address keeps `status`. *Expected:* each chip shows only that status; page 2 keeps the filter.
2. **Search on a large database (§18).** Type `united`. *Expected:* rows update without a reload and the address shows `?q=united`. Click "Pending approval". *Expected:* only pending matches remain and both values stay in the pager links.
3. **Published vs. proposed (§10, §11).** Open a row marked "Update to a published article". *Expected:* "Currently published" and the waiting draft side by side, with "Changed" badges on edited fields.
4. **Return with a note.** On a pending article click "Return for corrections" with an empty note. *Expected:* an error message and nothing changes. Type a note and click again. *Expected:* the status changes without a reload. Sign in as that article's `demo-` Reporter and open the article. *Expected:* the correction note is shown.
5. **Edit and approve.** Open a pending article, edit the title under "Edit the working copy", save, then click "Approve and publish". *Expected:* the public page `/articles/<id>` shows the new content only now, and `/analytics?article=<id>` shows a new marker at the approval time.
6. **Delete.** Open an article, click "Delete article" and confirm in the browser. *Expected:* back on the desk, the row is gone, and `/articles/<id>` shows the "Article not found" page.
7. **Impact analytics (§12).** Open the multi-update article the seed prints, at `/analytics?article=<id>` (it is not necessarily a Manchester United story). To show a United story instead, search `united`, sort by "Most viewed" and pick results until one shows several numbered markers; if none does, use the seed's article. *Expected:* a time axis, numbered markers for every approved version, and the versions table with views and views per hour for each version; change the range and resize the window to see the graph redraw.
8. **Authorization (§15).** Signed in as a Reporter, open `/editor`. *Expected:* a 403 "Access denied" page. Signed out, open `/analytics`. *Expected:* a redirect to the login page. As a Reporter, run in the browser console `fetch('/editor/articles/<id>/approve', { method: 'POST', headers: { Accept: 'application/json' } }).then(r => r.status)`. *Expected:* `403` (the JSON body is `{ error: 'FORBIDDEN', message }`).
9. **Restart (§15, §18).** Signed in as the Editor, stop `npm run dev`, start it again, refresh `/editor`. *Expected:* still signed in.
10. **Invalid input (§16).** Open `/editor?page=abc`. *Expected:* a 400 page with a link back to the desk. Open `/analytics/articles/abc/views`. *Expected:* `400 { error: 'INVALID_ARTICLE_ID', message }`. Ask for a range longer than 366 days (`?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`). *Expected:* `400 INVALID_RANGE` with a message. *Expected after all three:* the server keeps working.
11. **Visit counting under load (§12).** Open the same published article in a script loop (for example 200 `fetch` calls from the browser console) and compare `Article.totalViews` with the sum of that article's view buckets. *Expected:* both grew by the same amount; one `HEAD` request adds 0.

## Code walkthrough (Developer 4)

| File | Responsibility | Called by |
| --- | --- | --- |
| `routes/editor.js`, `routes/analytics.js` | Map URLs and verbs to controllers; mounted behind `requireEditor` in `app.js` | `app.js` |
| `controllers/editorController.js` | Validates desk query and ids; builds the desk rows (`toDeskRow`) and the review comparison; renders the pages and the JSON list | `routes/editor.js` |
| `controllers/editorActionsController.js` | Approve, return, edit and delete: only calls `models/articleWorkflow.js`, maps its result or `WorkflowError`, logs the Editor id and article id | `routes/editor.js` |
| `controllers/analyticsController.js` | Validates search, sort, id and range; calls `analyticsOperations` and `editorArticleQueries` | `routes/analytics.js` |
| `models/editorArticleQueries.js` | Desk filter and list query, review lookup, analytics article lookup and title search | the three controllers |
| `models/analyticsOperations.js` | `recordVisit` (two atomic `$inc`), view-series pipeline, unit choice, zero-filled series, publication events query | `services/visits.js`, `analyticsController.js` |
| `services/visits.js` | Passes `currentPublication` to `recordVisit` | `controllers/publicArticleController.js` |
| `helpers/sendError.js`, `views/error.ejs` | One answer for every failure: page for browsers, JSON for `fetch` | `app.js`, `middleware/auth.js`, `editorController.js` |
| `helpers/pagination.js`, `helpers/escapeRegExp.js`, `helpers/workflowResponse.js` | Page number parsing, literal regex text, workflow error to JSON | controllers |
| `views/editor/*`, `views/analytics/index.ejs` | Server-rendered desk, review and analytics pages | controllers |
| `public/editor-desk.js`, `public/editor-actions.js`, `public/analytics.js` | AJAX search and paging; approve, return, edit, delete without a reload; search, Canvas graph and versions table | the views |
| `scripts/demoGuard.js`, `scripts/seedDemoFixtures.js` | Refuse non-`_demo` databases and weak passwords before connecting; seed 520 articles with history | `npm run seed:demo` |

**Likely questions and short answers**

- *Why minute buckets per publication and not one document per visit?* A document per visit grows with every reader and every graph has to read them all. A bucket per (article, minute, publication) grows with time, not traffic: one document per minute that had at least one visit, however many visits it had. The graph output is at most about 750 points, but the query reads every bucket document in the range, so the read grows with the number of active minutes (up to 1,440 per day per version), not with the number of visits. Keeping the publication in the key keeps the before and after counts apart when an update is approved inside one minute.
- *Why two atomic `$inc` and not a transaction?* A transaction on every visit would make visits to a popular article conflict and retry. Each `$inc` is atomic on its own, and the unique index plus one retry handles the first-visit race. If the process fails between them, `totalViews` is one visit ahead of the bucket sum; it is only a popularity number.
- *Why are HEAD requests not counted?* Express sends HEAD to the GET handler, and crawlers and link previews use HEAD. `isPageView` in `publicArticleController.js` counts only `GET`.
- *Where do graph markers come from, and why `currentPublication`?* `approve` in the workflow creates one `PublicationEvent` and points `Article.currentPublication` at it. The markers are those events. A visit is recorded against `currentPublication`, the version that was actually served, so views are attributed to the right version.
- *Why a regex for the desk search and not `$text`?* The only text index is on `published.title` for the public search; adding draft titles would leak unpublished words into public search. A regex finds partial words and Hebrew, at the cost of walking the desk index until 21 matches are found (see "Cost" above).
- *Why skip pagination on the desk but a keyset cursor on the public feed?* The desk is for few Editors and needs page numbers, so `skip` is acceptable. The public feed is read by thousands of readers who scroll deep; `skip` gets slower with depth, a keyset cursor does not.
- *Where is authorization enforced, and why are hidden buttons not enough?* On the server: `requireEditor` is mounted in `app.js` before the editor and analytics routers, and the workflow checks the actor's role again. Anyone can call a URL from the console, so only the server check counts. `test/dev4-hardening.test.js` proves 401 for guests and 403 for Reporters on every route.
- *How is the Canvas graph drawn?* `analytics.js` sizes the canvas by `devicePixelRatio`, maps time to x and views to y inside a margin box (`niceStep` gives round y ticks), draws evenly spaced x ticks, the views line with its fill, and a dashed line with a numbered circle for every publication. `ResizeObserver` redraws it when the box changes.
- *How does the seed protect real data?* `assertDemoUri` reads the database name from the URI and refuses anything not ending in `_demo` before connecting; passwords come from the environment (8 to 128 characters) and are hashed by the User model; cleanup deletes only what belongs to `demo-` accounts.
- *How does an error become a 4xx or 5xx without crashing the server?* Controllers validate input and answer 4xx. Workflow errors carry a status and code. Anything else goes to `next(error)` and the global handler in `app.js`, which logs the method, path, status and error name and answers 500, or 503 when MongoDB is disconnected. The process keeps running and the next request works.

## Pre-defense checklist (requirements §5.5)

On every teammate's computer:

1. Fresh clone, then `npm ci` in `the-daily-web`.
2. Copy `.env.example` to `.env`; set `MONGODB_URI` (database name ending in `_demo`), `APP_ORIGIN`, `DEMO_REPORTER_PASSWORD`, `DEMO_EDITOR_PASSWORD`.
3. `npm run seed:demo`.
4. `npm test` (all green; the skipped tests need a real database or network).
5. `npm run dev`, then run the demo script above once as `demo-editor` and once as a `demo-` Reporter.
6. Responsive check at 360, 768, 1024 and 1440 px for `/editor`, `/editor/articles/<pending update id>` and `/analytics?article=<multi-update id>`: no horizontal scroll, controls wrap, desk rows and compare columns stack on mobile, long titles and URLs wrap, the versions table scrolls inside its box, the graph redraws sharp after a resize, tap targets are about 44 px.
7. Outage check: cut MongoDB access while `npm run dev` runs. `/health` gives 503, `/editor` shows the 503 page within a few seconds and the log shows `MongoDB disconnected`. Restore access: `MongoDB reconnected` is logged and the pages work without restarting Node.
8. `git status` shows no secrets, `.env` stays ignored, and the server log of the session contains no passwords, cookies, tokens or connection strings.
