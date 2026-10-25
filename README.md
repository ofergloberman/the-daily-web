# The Daily Web

The Daily Web is a news website built for the Web Application Development course with Node.js, Express, MongoDB/Mongoose, EJS, and Vanilla JavaScript. It uses an MVC structure: routes map URLs to controllers, controllers validate input and call models, and EJS views render the pages.

## Features

- **Roles:** Guests read and comment. Reporters write and submit their own articles. Editors review everything, publish, return, edit, delete, and view analytics. Every permission is checked on the server.
- **Article states:** `Draft` → `Pending Editor Approval` → `Published` or `Returned for Corrections`. A Reporter resubmits a returned article, and the Editor must give a note when returning one. Any other transition is rejected with HTTP 409 by `models/articleWorkflow.js`, the single place that implements the workflow.
- **Editing published articles:** The approved version stays public while a Reporter's revision waits for approval. The Editor's review page shows the published and the proposed content side by side, and approval replaces the public version and records an update marker.
- **Autosave:** The Reporter editor saves changes to the server automatically while typing, so work survives closing the browser or switching computers.
- **Public feed:** The homepage loads 20 articles at a time with infinite scroll (AJAX). It supports title search, category and viewed/not-viewed filters, and date or popularity sorting. Without JavaScript the same controls work as normal links.
- **Comments:** A new comment is inserted into the page without a reload. Guests are limited to three comments per minute per device, enforced on the server.
- **Article pages:** Rendered on the server with the full article in the first HTML response for search engines.
- **Weather:** A sidebar widget uses Open-Meteo, cached on the server so data is at most 15 minutes old.
- **Impact analytics:** Editors see article views over time on an HTML canvas, with markers at each approved update.
- **Demo data:** `npm run seed:demo` creates 520 articles, Reporters, an Editor, comments, and weeks of view history.

## Installation and startup

Node.js 22 or later and a transaction-capable MongoDB replica set or compatible MongoDB Atlas deployment are required for the comments API and atomic guest limiter. A standalone MongoDB server is insufficient. The server checks transaction support at startup, and you can run the same check on its own with `node --env-file=.env scripts/verifyTransactions.js`. A local single-node replica set works: start `mongod --replSet rs0 --port 27018 --dbpath <folder>` and run `rs.initiate()` once in `mongosh --port 27018`.

```powershell
npm install
Copy-Item .env.example .env
```

Set `MONGODB_URI` in `.env` to your transaction-capable database connection string. The example file uses a local replica set on port 27018. The personal `.env` file is excluded from Git. Never share passwords or a connection string that contains credentials.

Set `APP_ORIGIN` to the browser's exact origin, by default `http://localhost:3000`. Production requires an explicit HTTPS origin. All mutations require matching Origin or Referer, and a `Sec-Fetch-Site: cross-site` request is rejected even when Origin matches; requests missing both Origin and Referer are rejected. Forms and AJAX calls from the app's own pages send the Origin header automatically; behind a proxy, `APP_ORIGIN` must be the public origin the browser sees (`middleware/csrf.js`).

```powershell
npm run dev
# Or run without watching for file changes:
npm start
```

After the database connection and transaction check succeed, the server listens on `http://localhost:3000`. A different `PORT` can be configured in `.env`. If the initial database connection or transaction check fails, the process exits with an error instead of appearing healthy. `GET /health` returns HTTP 200 when the database is connected and HTTP 503 when it is unavailable.

### Create the first account

Stop application and seed writers, then run this in an interactive terminal after configuring MongoDB. The CLI privately prompts for the password and confirmation.

```powershell
npm run create-user -- reporter1 'Reporter One' reporter --offline
```

Use `editor` as the final argument for an Editor account. Choose a unique username. Sign in at `http://localhost:3000/auth`. Form login redirects Reporters to `/reporter`, where they can create and edit drafts, and Editors to `/editor`, where they browse all articles, review submissions, and open `/analytics`. The current account creation script is for local setup, so do not put real passwords in commands, source files, or `.env`.

Full local account CRUD is available through `npm run users -- <command>` (`create`, `read`, `list`, `update`, `reset-password`, `delete`; run it without a command to see the usage text). Every command except `read`/`list` requires `--offline` and must be run with the application and seed scripts stopped. Deleting an account is refused while it still owns articles, comments, or publication events; `reset-password`, `delete` and a role change revoke the user's existing sessions. Passwords are prompted for privately and never logged. `NEW_USER_PASSWORD` is no longer read.

## Project structure

```text
app.js                                  Express setup, middleware order, database connection, server startup
config/constants.js                     Role names and article statuses
config/database.js                      MongoDB connection
config/transactions.js                  MongoDB transaction capability check

routes/                                 URL and HTTP verb to controller mapping only
  auth.js, reporter.js, editor.js, analytics.js, articles.js, comments.js, weather.js

controllers/                            Validate requests, call models/services, send responses
  authController.js                     Login, logout, current user
  reporterController.js                 Reporter dashboard, draft creation, autosave, submit
  editorController.js                   Editor article list, status filter, published-versus-proposed review
  editorActionsController.js            Editor approve, return, edit and delete (use the article workflow)
  publicArticleController.js            Homepage, feed JSON, server-rendered article page, visit recording
  commentsController.js                 Comment validation and responses
  analyticsController.js                Analytics article search and view-series responses
  weatherController.js                  Weather JSON response

models/                                 Schemas, queries, and the article workflow
  User.js, Session.js                   Accounts (scrypt password hash) and expiring login sessions
  Article.js, Comment.js                Articles with draft and published versions, and their comments
  GuestCommentLimit.js                  Guest comment timestamps per device
  ViewStatistic.js                      View counts per article, minute and publication
  ViewedArticle.js                      Which articles each device has opened (viewed filter)
  PublicationEvent.js                   Initial publication and approved update markers
  articleWorkflow.js                    Approve, return, edit and delete: the only place that changes article state
  publicArticleQueries.js               Public feed, search, categories, article lookup
  editorArticleQueries.js               Article reads used only by Editor routes
  analyticsOperations.js                Atomic view recording and view series queries
  userMaintenance.js                    Account create, read, update and delete for the CLI

services/                               Logic that spans several models
  comments.js                           Comment creation with the transaction-backed guest limit
  visits.js                             Records a visit against the publication a reader received
  weather.js                            Open-Meteo client with a shared server-side cache

middleware/
  auth.js                               Cookie session loading and role checks
  csrf.js                               Origin/Referer check for all mutations
  deviceIdentity.js                     Anonymous device cookie (viewed history, guest comment limit)

helpers/                                dates.js, escapeRegExp.js, pagination.js, sendError.js, workflowResponse.js

views/                                  EJS templates
  index.ejs, login.ejs, error.ejs, notFound.ejs
  articles/show.ejs                     Server-rendered article page
  editor/, analytics/                   Editor desk, review comparison, analytics page
  reporterDashboard.ejs, reporterEditor.ejs
  partials/                             Header, footer, sidebar, weather, article card, comments

public/                                 Browser files served as-is
  feed.js                               Infinite scroll, search, filters and sorting with fetch
  article-comments.js                   AJAX comment form
  reporter-autosave.js                  Reporter autosave
  editor-desk.js, editor-actions.js     Editor list filtering and review actions
  analytics.js                          Article search and canvas views graph
  weather.js                            Weather widget
  *.css                                 Flexbox stylesheets

scripts/                                Command-line tools
  createUser.js, maintainUsers.js       Local account creation and maintenance
  seedDemoFixtures.js                   Demo dataset (database name must end in _demo)
  seedDev3Fixtures.js, seedDev3Load.js, explainDev3Feed.js   Feed fixtures and query-plan checks (_dev3 only)
  verifyTransactions.js                 Verify a real transaction write and commit

test/                                   node:test files, run with npm test
```

## Shared model contract

Mongoose creates `_id`, `createdAt`, and `updatedAt` for every model. The following fields and values form the team's shared starting point.

| Model | Fields |
| --- | --- |
| User | `username` is required, unique, and stored in lowercase; `displayName` is required; `passwordHash` is required and excluded from normal queries and JSON output; `role` defaults to `guest` |
| Session | A SHA-256 hash of a random cookie token, a User reference, and an expiry time; MongoDB removes expired sessions with a TTL index |
| Article | `author` references User; `draft` contains work in progress; `published` contains the approved snapshot or null; `status`; `editorNote`; `publishedAt` records the first publication; `lastPublishedAt` records the most recent approval |
| Comment | `article` references Article; `author` optionally references User and is null for a guest; `displayName` is required; `body` is required and limited to 2,000 characters |
| GuestCommentLimit | Hashed device identity, up to three recent successful comment timestamps, and expiry time |
| ViewStatistic | Required `article` and `publication` references; `minute` is a UTC minute boundary; `count` is a nonnegative safe integer, defaulting to zero |
| PublicationEvent | Required `article` and `editor` references; required `publishedAt` event time; `kind` is `initial` or `update` |

Both `draft` and `published` contain `title`, `summary`, `body`, `category`, and `imageUrl`. A draft may be incomplete to support automatic saving, but submitting for approval requires all required content to be complete. Public readers receive only the `published` snapshot, so editing a draft does not change approved content.

Article statuses are `draft`, `pending`, `published`, and `returned`. The schema restricts values to these statuses, and `models/articleWorkflow.js` enforces permissions and valid status transitions. Editing a published article keeps the approved snapshot available while opening a new review cycle for the draft.

Mongoose does not verify that referenced documents exist, so the workflow and controllers validate references, content completeness, status transitions, and the copy of an approved draft into the published snapshot. The unique username index means account creation handles duplicate-key errors.

## Shared device identity contract

`middleware/deviceIdentity.js` runs before authentication and application routes, including the public homepage, articles, and comments. Static files and the health check do not create device cookies.

- Cookie name: `wd_device`. Its value is 32 cryptographically random bytes encoded as exactly 64 lowercase hexadecimal characters.
- Controllers receive `req.deviceId`: the validated cookie value or a newly generated replacement for a missing or malformed value. `req.deviceIsNew` is `true` when that replacement was just issued, so the request did not carry a valid cookie. Read these properties rather than parsing cookies separately.
- New cookies use `HttpOnly`, `SameSite=Lax`, `Path=/`, and a persistent lifetime of 365 days. `Secure` is enabled when `NODE_ENV=production`; production must use HTTPS.
- Valid cookies are reused without renewal. Login, session rotation, and logout preserve the device identity; `wd_session` remains separate.
- Clearing cookies resets viewed-history identity and the guest comment-limit identity. A browser profile is the identity boundary, not a physical device or account. This cookie is not an authentication or authorization credential.

The feed's viewed/not-viewed filter is stored per `req.deviceId`, and only requests that already carried the cookie are recorded as viewed. The guest comment limiter hashes this identity before storing its successful timestamps. A guest `POST /comments` with `req.deviceIsNew` is rejected with HTTP 400 `DEVICE_REQUIRED` before any database work: a client that sends no cookie would otherwise receive a fresh identity on every request and bypass the three-per-minute limit. Browsers are unaffected because the page that shows the comment form already set the cookie; logged-in users are not subject to the guest limit. Cookie-based tracking cannot preserve identity when users clear or replace their cookies.

Validation: `node --test test/device-identity.test.js test/auth.test.js` covers creation, reuse, malformed input, cookie attributes, route mounting, and login/logout continuity. `npm test` runs the full regression suite.

## Analytics storage contract

These schemas provide the storage foundation for requirements 12 and 14. `models/analyticsOperations.js` implements the operations on them; publication events are created by the approval workflow in `models/articleWorkflow.js`.

Store a separate PublicationEvent for the initial publication and every approved update. Its `publishedAt` must be the server-recorded publication time, not the time a draft was edited. The article/time index supports fetching all graph markers without growing an array inside Article. Article's `publishedAt` and `lastPublishedAt` remain convenient first/latest timestamps; they do not replace the event history. Events store publication metadata, not archived article content.

Store view counts in one-minute buckets rather than one document per visit. Compute `minute` from the server visit time with `new Date(Math.floor(visitTime.getTime() / 60000) * 60000)`. Each bucket references the publication that the reader actually received, so updates within a minute have separate counts. The unique index on article, minute, and publication prevents duplicate buckets and supports article/time-range queries. Summing their counts gives views over time.

View recording uses an atomic `$inc` with an upsert, rather than reading and saving a counter, and handles duplicate-key races when concurrently creating a bucket. Approval keeps the public snapshot, article timestamps, and publication event consistent and avoids duplicate events on retries. Deleting an article also removes its statistics and events. Schema validation alone does not enforce these rules; `models/articleWorkflow.js` and `models/analyticsOperations.js` do. These aggregate counts contain no device identifiers.

### Analytics operations (D4)

- `recordVisit(articleId, publicationId, visitTime)` makes two atomic increments, not a transaction, so visits to a popular article never conflict. First it adds one to `Article.totalViews` (the homepage "Most popular" sort) without changing `updatedAt`. Then, if the article exists and a publication was served, it increments the minute bucket with one `$inc` upsert, retrying once if a concurrent first visit wins the unique-index race. `services/visits.js` passes the article's `currentPublication`, the version the reader was served, which the public page reads together with the snapshot. Articles without a publication still count toward popularity but have no bucket. If a failure falls between the two writes, the counters differ by one visit. Only GET page views are counted; HEAD requests (crawlers, link previews) are not.
- `getViewSeries(articleId, from, to)` returns views per bucket and every publication with its views in the range. Ranges are at most 366 days. The bucket is a minute up to 6 hours, an hour up to 31 days, and a day (UTC) beyond that, so a graph never exceeds about 750 points. Empty buckets are returned as zero. `splits` lists the per-version views (`{ time, byPublication }`) of each bucket with views that contains a publication marker; buckets without views are drawn as zero by the client. Inside such a bucket the graph steps vertically at each marker and each earlier version stays flat until the next marker; the last version's line then continues to the next bucket's point.
## Agreed roles

| Role | Permissions to implement |
| --- | --- |
| `guest` | Read published content and post comments subject to rate limiting |
| `reporter` | Create articles, edit owned articles, and submit them for approval |
| `editor` | Manage all articles, approve publication, and return articles for corrections |

An anonymous guest does not require a User document in the database. Passwords are hashed with Node's built-in scrypt and a random salt. The browser receives an HttpOnly, SameSite=Lax cookie containing a random session token; MongoDB stores only its hash. Sessions expire after seven days, and logout deletes the saved session. Role checks use the User loaded from MongoDB, never a browser-provided role. Comment update and delete require the Editor role on the server.

## Route contract

| Route | Operations |
| --- | --- |
| `/` | Homepage with the first 20 articles; `?q=&category=&sort=&viewed=&cursor=` work as plain links without JavaScript |
| `/auth` | `GET /` login page, `POST /login`, `POST /logout`, `GET /me` |
| `/reporter` | `GET /` Reporter workspace (own articles only) |
| `/editor` | `GET /?status=&page=` all articles with optional status filter, `GET /articles/:id` review page comparing the published snapshot with the working draft. Editor-only actions return `{ data: { id, status } }` or `{ error, message }`: `POST /articles/:id/approve` (pending to published), `POST /articles/:id/return` with `{ note }` (pending to returned), `PATCH /articles/:id` with content fields (edits the working copy), `DELETE /articles/:id` (removes the article with its comments, events and statistics). Errors: 401 guest, 403 Reporter, 404 unknown id, 409 invalid state, 400 missing note or invalid content |
| `/analytics` | Editor only: `GET /` page, `GET /articles?q=&sort=` search published titles (`sort` is `default`, newest first or best match, or `popular`, most `totalViews` first; each result includes `totalViews`; any other value returns 400), `GET /articles/:id/views?from=&to=` views per time bucket, publication markers, and `splits` (per-version views for each bucket with views that contains a publication marker; buckets without views are drawn as zero by the client) |
| `/reporter/articles` | `GET` paginated own articles, `POST` create a private draft |
| `/reporter/articles/:id/edit` | `GET` edit an owned article |
| `/reporter/articles/:id/draft` | `PATCH` autosave the five working content fields with `baseVersion` (rejected with 409 while the article is pending approval or if the version is stale) |
| `/reporter/articles/:id/submit` | `POST` submit an owned Draft, Returned or Published article (a revision) for approval |
| `/articles` | `GET /?q=&category=&sort=date\|popular&viewed=all\|viewed\|unviewed&cursor=` feed JSON `{ data, pagination }` with 20 articles per page; `GET /:id` server-rendered article page. There are no public article write endpoints: articles are created and changed only through `/reporter` and `/editor` |
| `/comments` | `GET /?articleId=`, `POST /`, `GET /:id`, `PATCH /:id` (Editor), `DELETE /:id` (Editor) |
| `/weather` | `GET /` cached weather JSON |

Login accepts a form or JSON body with `username` and `password`. JSON login responds with `{ user, redirectTo }`; form login redirects to the matching area. `GET /auth/me` requires a valid session and returns a public user profile. JSON logout returns HTTP 204. Reporter routes require the Reporter role; draft reads and updates require ownership, and updates are refused while the article is awaiting approval. `GET /comments?articleId=...` returns up to 20 comments by default, with a maximum `limit` of 50 and a `nextCursor` for the following page. `POST /comments` returns HTTP 201 with `{ comment }`; guests can post three successful comments per rolling minute per device across articles. The fourth returns HTTP 429 with `Retry-After`. A guest request that arrives without its device cookie returns HTTP 400 `DEVICE_REQUIRED` (see the device identity section). Read routes only expose comments on articles with an approved `published` snapshot; PATCH and DELETE require an Editor. An unknown route returns HTTP 404, and malformed JSON returns HTTP 400.

## Tests

```powershell
npm test
```

The standard tests cover schema validation, password hashing, authentication and role checks, analytics buckets and publication markers, separation of draft and published content, page rendering, foundation routes, and malformed JSON handling. The comments integration test uses real MongoDB and runs when `COMMENTS_TEST_MONGODB_URI` names a fresh database starting with `the_daily_web_comments_test_`. It verifies validation, visibility, spoofing, authentication, pagination, Editor permissions, exact minute boundaries, rollback after a failed save, cross-article limits, and concurrent submissions. The test drops that temporary database after completion. To run it, point the variable at a fresh database on your replica set, for example `$env:COMMENTS_TEST_MONGODB_URI='mongodb://127.0.0.1:27018/the_daily_web_comments_test_1?replicaSet=rs0'; npm test`.

### Public feed checks

These write only to a database whose name ends in `_dev3`, checked from `MONGODB_URI` before connecting.

```powershell
npm run seed:dev3                 # 45 articles for manual checks
npm run seed:dev3:load            # 5000 articles, 12.5k viewed records (optional count: -- 2000)
npm run explain:dev3              # indexes, documents read and time for every sort/filter/viewed combination
npm run explain:dev3 -- --walk    # pages through every feed: each article exactly once, in order
$env:FEED_INTEGRATION=1; node --env-file=.env --test test/feed.integration.test.js
```

On 5000 articles every feed page reads 21 documents through an index, with no collection scan. A title search reads every matching article, because a text index cannot return results by date or popularity. The feed indexes now end in `_id`. Mongoose creates new indexes but never drops old ones, so on the shared database drop the three replaced ones once: `publishedAt_-1`, `totalViews_-1` and `published.category_1_publishedAt_-1` (not `syncIndexes()`, which also drops any index another branch created).

## Git and submitting

The project is hosted on the team's public GitHub repository (github.com/ofergloberman/the-daily-web), with every team member added as a collaborator. `.gitignore` excludes `.env`, `node_modules`, and temporary files, so secrets are never committed. Each team member works on a separate `devN/feature-name` branch and merges changes into `dev` through Pull Requests.

To create the submission archive from the committed files only (no `.env`, no `node_modules`):

```powershell
git archive -o submission.zip HEAD
```

## Weather service and sidebar

The homepage and article sidebar load weather through same-origin `GET /weather` using Vanilla JavaScript. Configure `WEATHER_LOCATION` (display name), `WEATHER_LATITUDE` (-90 to 90), and `WEATHER_LONGITUDE` (-180 to 180) in `.env`, then restart the server. `.env.example` provides Tel Aviv coordinates; missing or invalid configuration shows the unavailable message without contacting the provider.

This academic, non-commercial project uses [Open-Meteo](https://open-meteo.com/) with no API key, signup, or credit card. The widget attributes Open-Meteo and its CC BY 4.0 data license. [Current conditions](https://open-meteo.com/en/docs) use 15-minute model data (interpolated in some regions), rather than live station observations. Freshness is measured from the provider's current-condition timestamp, not its model-run initialization time.

`services/weather.js` shares one cache and one in-flight refresh across visitors in the existing single process. Native server-side `fetch` has a five-second deadline covering headers and body. Requests refresh on demand after five minutes, or sooner if conditions expire; failed refreshes back off for one minute. During a failure, a cached result is returned only while still fresh. There is no background provider polling. Multiple server processes would each have their own cache.

`routes/weather.js` and `controllers/weatherController.js` expose a public, database-independent endpoint before session/device middleware. Both available and unavailable results return HTTP 200 with `Cache-Control: no-store`. Available JSON contains `status`, `location`, `temperatureC`, `weatherCode`, `dataTime`, `fetchedAt`, and `expiresAt`; all times are ISO-8601 UTC strings. Unavailable JSON is `{ "status": "unavailable", "message": "Weather is temporarily unavailable." }`. Query parameters cannot override the configured location.

Expiry is the earlier of provider time plus 15 minutes and fetch time plus 15 minutes. Old, future-dated, or malformed provider responses are rejected. The browser uses `X-Weather-Server-Time` to avoid relying on the device clock, subtracts request duration, and hides expired data even during a pending refresh. It polls at most every five minutes while visible (one minute after failures), clears conditions on backgrounding/navigation, and refreshes on return. The partial is `views/partials/weather.ejs`; behavior lives in `public/weather.js`.

Run `node --test test/weather.test.js test/weather-client.test.js` for mocked-provider, controlled-clock tests covering cache reuse, concurrent visitors, timeouts, malformed responses, outages, retry backoff, freshness boundaries, public routing, and long-open page expiry. These tests do not call Open-Meteo or require MongoDB. `npm test` runs the regression suite.

## Demo dataset

`scripts/seedDemoFixtures.js` fills a database with submission-ready demo data. Run it with:

```powershell
npm run seed:demo
```

**Required environment** (set in your untracked `.env` or the shell; never commit them):

- `MONGODB_URI` must name a database ending in `_demo`, for example
  `mongodb://127.0.0.1:27018/the_daily_web_demo?replicaSet=rs0`. The name is checked from the URI
  before anything connects (connecting already writes), so any other database, or a missing name,
  is refused with a non-zero exit.
- `DEMO_REPORTER_PASSWORD` is shared by the six Reporter accounts and `DEMO_EDITOR_PASSWORD` is the
  Editor's. Each must be 8 to 128 characters, otherwise the script exits before connecting. The
  passwords are hashed with `User.setPassword` and are never printed.

**Accounts:** `demo-editor` and `demo-reporter-1` to `demo-reporter-6`.

**Content (same counts every run):** 520 articles: 70 drafts, 50 returned (each with an editor
note), 70 pending and 330 published, across 8 categories and the 6 Reporters. Of the published
articles, 255 were published once, 50 have one update and 25 have three updates (four publications).
The first 20 returned and first 20 pending articles also have a published version with a different
draft waiting for review. Published articles carry guest and registered comments in a fixed pattern.
Each published article has view history from its first publication (between 1 hour and 45 days ago)
up to now, hourly for the last 31 days and daily before, whose
rate steps at every publication marker, and `totalViews` equals the sum of its buckets. About 11% of
all articles are Manchester United / Premier League stories (match reports, transfers, manager,
injury news and fixtures) filed under `Sport`, including some of the multi-update articles; every
Reporter writes some of them. The rest is general news. Each article's base view rate is fixed by its
position in the seed; only the publication dates and the per-bucket view-count jitter are random.

**Re-running:** the script first removes only data owned by `demo-*` accounts (their articles, and
the comments, publication events, view statistics, viewed-article rows and sessions that belong to
them), updates the `demo-*` accounts in place with the current env passwords, and recreates the
content. Other users and articles are never touched.
