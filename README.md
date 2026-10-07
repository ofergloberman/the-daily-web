# The Daily Web

This repository contains an Express and Mongoose MVC foundation, login sessions, and a Reporter draft workspace. Reporters can sign in, create and edit their own drafts, and save changes to MongoDB while writing. Editorial review and public article pages are still in development.

## Installation and startup

Node.js 22 or later and either a running local MongoDB database or a MongoDB Atlas connection are required.

```powershell
npm install
Copy-Item .env.example .env
```

Set `MONGODB_URI` in `.env` to your database connection string. The example file uses `mongodb://127.0.0.1:27017/the_daily_web`. The personal `.env` file is excluded from Git. Never share passwords or a connection string that contains credentials.

```powershell
npm run dev
# Or run without watching for file changes:
npm start
```

After the database connection succeeds, the server listens on `http://localhost:3000`. A different `PORT` can be configured in `.env`. If the initial database connection fails, the process exits with an error instead of appearing healthy. `GET /health` returns HTTP 200 when the database is connected and HTTP 503 when it is unavailable.

### Create the first account

Run this in PowerShell after configuring MongoDB. The password is read privately and passed to the local process through a temporary environment variable; it is never written to the repository.

```powershell
$secret = Read-Host 'New password (8-128 characters)' -AsSecureString
$env:NEW_USER_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password
try { npm run create-user -- reporter1 'Reporter One' reporter }
finally { Remove-Item Env:NEW_USER_PASSWORD }
```

Use `editor` as the final argument for an Editor account. Choose a unique username. Sign in at `http://localhost:3000/auth`. Form login redirects Reporters to `/reporter`, where they can create and edit drafts, and Editors to `/editor`, where they browse all articles, review submissions, and open `/analytics`. The current account creation script is for local setup, so do not put real passwords in commands, source files, or `.env`.

## Project structure

```text
app.js                             Express setup, database connection, and server startup
config/database.js                 MongoDB connection
config/constants.js                Role names and article statuses
models/User.js                     User schema
models/Session.js                  Persistent, expiring login sessions
models/Article.js                  Article schema
models/Comment.js                  Comment schema
models/ViewStatistic.js            View counts per article, minute, and publication
models/PublicationEvent.js         Initial publication and approved update markers
routes/                            Authentication, article, and comment routes
routes/reporter.js                  Reporter dashboard and draft routes
routes/editor.js                    Editor desk and article review routes
routes/analytics.js                 Editor-only analytics page and data routes
middleware/auth.js                 Cookie session loading and role checks
controllers/authController.js      Login, logout, and account flow
controllers/reporterController.js  Reporter draft creation, listing, and autosave
controllers/editorController.js    Editor article list, status filter, and published-versus-draft review
controllers/analyticsController.js Analytics article search and view-series responses
controllers/scaffoldController.js  Temporary response for unimplemented endpoints
models/analyticsOperations.js      Atomic view recording, view series queries, publication events, cleanup
models/editorArticleQueries.js     Article reads used only by Editor routes
services/visits.js                 Records a visit against the publication a reader received
helpers/pagination.js              Page number validation
views/index.ejs                    Basic server-rendered landing page
views/login.ejs                    Login form
views/editor/                      Editor desk list and review comparison
views/analytics/                   Impact analytics page
views/reporterDashboard.ejs        Reporter article list
views/reporterEditor.ejs           Draft editor
public/reporter-autosave.js        Browser-side AJAX autosave
public/reporter.css                Reporter workspace styles
public/editor.css                  Editor desk and review styles
public/analytics.js                Article search and Canvas views graph
public/analytics.css               Analytics page styles
scripts/createUser.js              Local account creation
public/                            CSS, client-side JavaScript, and image files
test/foundation.test.js            Foundation tests that do not require a running database
test/auth.test.js                  Password and session flow tests with a simulated database
test/reporter.test.js              Reporter draft route and authorization tests
```

## Shared model contract

Mongoose creates `_id`, `createdAt`, and `updatedAt` for every model. The following fields and values form the team's shared starting point.

| Model | Fields |
| --- | --- |
| User | `username` is required, unique, and stored in lowercase; `displayName` is required; `passwordHash` is required and excluded from normal queries and JSON output; `role` defaults to `guest` |
| Session | A SHA-256 hash of a random cookie token, a User reference, and an expiry time; MongoDB removes expired sessions with a TTL index |
| Article | `author` references User; `draft` contains work in progress; `published` contains the approved snapshot or null; `status`; `editorNote`; `publishedAt` records the first publication; `lastPublishedAt` records the most recent approval |
| Comment | `article` references Article; `author` optionally references User and is null for a guest; `displayName` is required; `body` is required and limited to 2,000 characters |
| ViewStatistic | Required `article` and `publication` references; `minute` is a UTC minute boundary; `count` is a nonnegative safe integer, defaulting to zero |
| PublicationEvent | Required `article` and `editor` references; required `publishedAt` event time; `kind` is `initial` or `update` |

Both `draft` and `published` contain `title`, `summary`, `body`, `category`, and `imageUrl`. A draft may be incomplete to support automatic saving. The future submission controller must verify that all required content is complete. Public readers will receive only the `published` snapshot, so editing a draft does not change approved content.

Article statuses are `draft`, `pending`, `published`, and `returned`. The schema restricts values to these statuses. Controllers will enforce permissions and valid status transitions. Editing a published article keeps the approved snapshot available while opening a new review cycle for the draft.

Mongoose does not verify that referenced documents exist. Future controllers are responsible for validating references, content completeness, status transitions, and copying an approved draft into the published snapshot. The unique username index also requires the controller to handle duplicate-key errors.

## Shared device identity contract (D3 handoff)

`middleware/deviceIdentity.js` runs before authentication and application routes, including the public homepage, articles, and comments. Static files and the health check do not create device cookies.

- Cookie name: `wd_device`. Its value is 32 cryptographically random bytes encoded as exactly 64 lowercase hexadecimal characters.
- Controllers receive `req.deviceId`: the validated cookie value or a newly generated replacement for a missing or malformed value. Read this property rather than parsing cookies separately.
- New cookies use `HttpOnly`, `SameSite=Lax`, `Path=/`, and a persistent lifetime of 365 days. `Secure` is enabled when `NODE_ENV=production`; production must use HTTPS.
- Valid cookies are reused without renewal. Login, session rotation, and logout preserve the device identity; `wd_session` remains separate.
- Clearing cookies resets viewed-history identity and the guest comment-limit identity. A browser profile is the identity boundary, not a physical device or account. This cookie is not an authentication or authorization credential.

D3 owns viewed/not-viewed storage and filtering using `req.deviceId`. The guest comment limiter should use the same identity for its server-side limit of three comments per minute. This change provides the shared identity only; it does not implement either consumer. Cookie-based tracking cannot preserve identity when users clear or replace their cookies.

Validation: `node --test test/device-identity.test.js test/auth.test.js` covers creation, reuse, malformed input, cookie attributes, route mounting, and login/logout continuity. `npm test` runs the full regression suite.

## Analytics storage contract

These schemas provide the storage foundation for requirements 12 and 14. `models/analyticsOperations.js` implements the operations on them; the approval workflow that creates publication events is still future work.

Store a separate PublicationEvent for the initial publication and every approved update. Its `publishedAt` must be the server-recorded publication time, not the time a draft was edited. The article/time index supports fetching all graph markers without growing an array inside Article. Article's `publishedAt` and `lastPublishedAt` remain convenient first/latest timestamps; they do not replace the event history. Events store publication metadata, not archived article content.

Store view counts in one-minute buckets rather than one document per visit. Compute `minute` from the server visit time with `new Date(Math.floor(visitTime.getTime() / 60000) * 60000)`. Each bucket references the publication that the reader actually received, so updates within a minute have separate counts. The unique index on article, minute, and publication prevents duplicate buckets and supports article/time-range queries. Summing their counts gives views over time.

Future view recording must use an atomic `$inc` with an upsert, rather than reading and saving a counter, and handle duplicate-key races when concurrently creating a bucket. Future approval logic must keep the public snapshot, article timestamps, and publication event consistent and avoid duplicate events on retries. Controllers must validate referenced records, verify that the publication belongs to the article, enforce Editor authorization for publication, and clean up associated statistics/events when deleting an article. Schema validation does not enforce these rules or automatically record visits. Anonymous viewed/not-viewed tracking is a separate future concern; these aggregate counts contain no device identifiers.

### Analytics operations (D4)

- `recordVisit(articleId, publicationId, visitTime)` increments the minute bucket with one atomic `$inc` upsert and retries once if a concurrent first visit wins the unique-index race. `services/visits.js` calls it from the public article page, attributing the view to the article's newest publication event; articles without an event are not counted.
- `createPublicationEvent({ article, editor, kind, publishedAt }, session)` is the only function the approval workflow should use to record a publication. Pass the transaction `session` so the event commits with the new public snapshot.
- `deleteArticleAnalytics(articleId, session)` removes an article's buckets and events; the article deletion workflow must call it.
- `getViewSeries(articleId, from, to)` returns views per bucket and every publication with its views in the range. Ranges are at most 366 days. The bucket is a minute up to 6 hours, an hour up to 31 days, and a day (UTC) beyond that, so a graph never exceeds about 750 points. Empty buckets are returned as zero.

## Agreed roles

| Role | Permissions to implement |
| --- | --- |
| `guest` | Read published content and post comments subject to rate limiting |
| `reporter` | Create articles, edit owned articles, and submit them for approval |
| `editor` | Manage all articles, approve publication, and return articles for corrections |

An anonymous guest does not require a User document in the database. Passwords are hashed with Node's built-in scrypt and a random salt. The browser receives an HttpOnly, SameSite=Lax cookie containing a random session token; MongoDB stores only its hash. Sessions expire after seven days, and logout deletes the saved session. Role checks use the User loaded from MongoDB, never a browser-provided role. Article and comment authorization will be added when those routes are implemented.

## Route contract

| Route | Reserved operations |
| --- | --- |
| `/auth` | `GET /` login page, `POST /login`, `POST /logout`, `GET /me` |
| `/reporter`, `/editor` | Reporter workspace and Editor desk |
| `/editor` | `GET /?status=&page=` all articles with optional status filter, `GET /articles/:id` review page comparing the published snapshot with the working draft |
| `/analytics` | Editor only: `GET /` page, `GET /articles?q=` search published titles, `GET /articles/:id/views?from=&to=` views per time bucket and publication markers |
| `/reporter/articles` | `GET` paginated own articles, `POST` create a private draft |
| `/reporter/articles/:id/edit` | `GET` edit an owned draft |
| `/reporter/articles/:id/draft` | `PATCH` save the five working content fields |
| `/articles` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` |
| `/comments` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` |

Login accepts a form or JSON body with `username` and `password`. JSON login responds with `{ user, redirectTo }`; form login redirects to the matching area. `GET /auth/me` requires a valid session and returns a public user profile. JSON logout returns HTTP 204. Reporter routes require the Reporter role; draft reads and updates require ownership, and updates require Draft status. The article and comment endpoints still return HTTP 501 with `NOT_IMPLEMENTED`. An unknown route returns HTTP 404, and malformed JSON returns HTTP 400. See [README.reporter-draft-foundation.md](README.reporter-draft-foundation.md) for the draft workflow.

## Tests

```powershell
npm test
```

The tests cover schema validation, password hashing, authentication and role checks, analytics buckets and publication markers, separation of draft and published content, page rendering, foundation routes, and malformed JSON handling. They do not test a real database connection, database index enforcement, or concurrent view recording. To test the complete startup path, run `npm start` with MongoDB available, create a Reporter and Editor, and confirm each can log in, survives a server restart, and loses access after logout.

## Git and teamwork

The local project has not yet been connected to the team's existing GitHub repository. The repository is public, and every team member should be added as a collaborator. `.gitignore` is ready to exclude secrets, dependencies, and temporary files. After cloning the existing repository and transferring this foundation into it, each team member should work on a separate branch and merge changes through Pull Requests.

## Remaining work

The remaining project requirements include article submission and editorial approval (including the Editor's approve, return, edit and delete actions), published update versioning, comments, comment rate limiting, the public news feed, weather integration, and the 500-article demo dataset. View statistics, publication history, the Editor article list and review comparison, and the analytics graph are in place.
