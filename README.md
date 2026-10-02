# The Daily Web - Stage 0

This repository contains the shared foundation for the project before development is divided among the team: an Express server, a MongoDB connection through Mongoose, an MVC structure, five models, and the initial routes. A complete news system, user authentication, and CRUD operations have not been implemented yet.

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

## Project structure

```text
app.js                             Express setup, database connection, and server startup
config/database.js                 MongoDB connection
config/constants.js                Role names and article statuses
models/User.js                     User schema
models/Article.js                  Article schema
models/Comment.js                  Comment schema
models/ViewStatistic.js            View counts per article, minute, and publication
models/PublicationEvent.js         Initial publication and approved update markers
routes/                            Authentication, article, and comment routes
controllers/scaffoldController.js  Temporary response for unimplemented endpoints
views/index.ejs                    Basic server-rendered landing page
public/                            CSS, client-side JavaScript, and image files
test/foundation.test.js            Foundation tests that do not require a running database
```

## Shared model contract

Mongoose creates `_id`, `createdAt`, and `updatedAt` for every model. The following fields and values form the team's shared starting point.

| Model | Fields |
| --- | --- |
| User | `username` is required, unique, and stored in lowercase; `displayName` is required; `passwordHash` is required and excluded from normal queries and JSON output; `role` defaults to `guest` |
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

An anonymous guest does not require a User document in the database. Authentication and authorization enforcement have not been implemented yet, and the routes do not currently modify data. The future authentication implementation must derive the role from the authenticated server-side user, hash passwords, and persist sessions across server restarts. Never copy `role` from a request body or HTTP header, and never store a plaintext password in `passwordHash`.

## Route contract

| Route | Reserved operations |
| --- | --- |
| `/auth` | `GET /`, `POST /login`, `POST /logout`, `GET /me` |
| `/articles` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` |
| `/comments` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` |

The reserved endpoints currently return HTTP 501 with `NOT_IMPLEMENTED`. An unknown route returns HTTP 404, and malformed JSON returns HTTP 400. This contract does not yet define the complete article review workflow API.

## Tests

```powershell
npm test
```

The tests cover schema validation, analytics buckets and publication markers, separation of draft and published content, omission of the password field from JSON, page rendering, foundation routes, and malformed JSON handling. They do not test a real database connection, database index enforcement, or concurrent view recording. To test the complete startup path, run `npm start` with MongoDB available and confirm that `/health` returns HTTP 200.

## Git and teamwork

The local project has not yet been connected to the team's existing GitHub repository. The repository is public, and every team member should be added as a collaborator. `.gitignore` is ready to exclude secrets, dependencies, and temporary files. After cloning the existing repository and transferring this foundation into it, each team member should work on a separate branch and merge changes through Pull Requests.

## Work after Stage 0

The complete project requirements also include view collection and analytics graphs, persistent authentication, authorization, CRUD operations, the editorial approval workflow, automatic saving, comment rate limiting, a user interface, and a weather service integration. These behaviors are not part of the current stage. View statistics and publication history schemas are ready for those future implementations.
