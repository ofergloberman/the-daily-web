# The Daily Web

This repository contains an Express and Mongoose MVC foundation and the first authentication step. Reporters and Editors can sign in with a username and password, stay signed in across server restarts, and access role-protected starter areas. News and article CRUD features are still in development.

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

Use `editor` as the final argument for an Editor account. Choose a unique username. Sign in at `http://localhost:3000/auth`. Form login redirects Reporters to `/reporter` and Editors to `/editor`; those pages are protected starter areas for future article tools. The current account creation script is for local setup, so do not put real passwords in commands, source files, or `.env`.

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
middleware/auth.js                 Cookie session loading and role checks
controllers/authController.js      Login, logout, account, and starter area flow
controllers/scaffoldController.js  Temporary response for unimplemented endpoints
views/index.ejs                    Basic server-rendered landing page
views/login.ejs                    Login form
views/workArea.ejs                 Protected starter areas
scripts/createUser.js              Local account creation
public/                            CSS, client-side JavaScript, and image files
test/foundation.test.js            Foundation tests that do not require a running database
test/auth.test.js                  Password and session flow tests with a simulated database
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

## Analytics storage contract

These schemas provide the Stage 0 storage foundation for requirements 12 and 14. Collection and approval controllers, analytics endpoints, and graphs remain future work.

Store a separate PublicationEvent for the initial publication and every approved update. Its `publishedAt` must be the server-recorded publication time, not the time a draft was edited. The article/time index supports fetching all graph markers without growing an array inside Article. Article's `publishedAt` and `lastPublishedAt` remain convenient first/latest timestamps; they do not replace the event history. Events store publication metadata, not archived article content.

Store view counts in one-minute buckets rather than one document per visit. Compute `minute` from the server visit time with `new Date(Math.floor(visitTime.getTime() / 60000) * 60000)`. Each bucket references the publication that the reader actually received, so updates within a minute have separate counts. The unique index on article, minute, and publication prevents duplicate buckets and supports article/time-range queries. Summing their counts gives views over time.

Future view recording must use an atomic `$inc` with an upsert, rather than reading and saving a counter, and handle duplicate-key races when concurrently creating a bucket. Future approval logic must keep the public snapshot, article timestamps, and publication event consistent and avoid duplicate events on retries. Controllers must validate referenced records, verify that the publication belongs to the article, enforce Editor authorization for publication, and clean up associated statistics/events when deleting an article. Schema validation does not enforce these rules or automatically record visits. Anonymous viewed/not-viewed tracking is a separate future concern; these aggregate counts contain no device identifiers.

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
| `/reporter`, `/editor` | Protected starter areas for the matching role |
| `/articles` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` |
| `/comments` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` |

Login accepts a form or JSON body with `username` and `password`. JSON login responds with `{ user, redirectTo }`; form login redirects to the matching area. `GET /auth/me` requires a valid session and returns a public user profile. JSON logout returns HTTP 204. The article and comment endpoints still return HTTP 501 with `NOT_IMPLEMENTED`. An unknown route returns HTTP 404, and malformed JSON returns HTTP 400. This contract does not yet define the complete article review workflow API.

## Tests

```powershell
npm test
```

The tests cover schema validation, password hashing, authentication and role checks, analytics buckets and publication markers, separation of draft and published content, page rendering, foundation routes, and malformed JSON handling. They do not test a real database connection, database index enforcement, or concurrent view recording. To test the complete startup path, run `npm start` with MongoDB available, create a Reporter and Editor, and confirm each can log in, survives a server restart, and loses access after logout.

## Git and teamwork

The local project has not yet been connected to the team's existing GitHub repository. The repository is public, and every team member should be added as a collaborator. `.gitignore` is ready to exclude secrets, dependencies, and temporary files. After cloning the existing repository and transferring this foundation into it, each team member should work on a separate branch and merge changes through Pull Requests.

## Remaining work

The remaining project requirements include view collection and analytics graphs, article and comment CRUD, the editorial approval workflow, automatic saving, comment rate limiting, the public news interface, and weather integration. View statistics and publication history schemas are ready for those future implementations.
