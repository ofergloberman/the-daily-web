# User maintenance and shared CSRF contract

Implemented on `codex/user-maintenance-csrf`, 2026-10-11. This document records
the behavior, implementation, verification, and remaining team review for
Tasks 1–3. The course requirements in `docs/PROJECT_REQUIREMENTS.md`, especially
sections 6.4, 13–16, remain authoritative. No dependencies were added.

## Review status and ownership

The implementation adopts the requested conservative proposal: reject user
deletion while references exist. **D2/D4 agreement has not been recorded.**
The code and tests are ready for their review; this document must not be read
as their approval. Task 1's team-review completion criterion remains open.

| Owner | Specific review required |
| --- | --- |
| D1 | Local CLI, safe projections, credentials, sessions, shared middleware |
| D2 | Confirm `Article.author` blocks deletion in every article state; confirm the offline deletion procedure and report any new User references |
| D4 | Confirm `Comment.author` and `PublicationEvent.editor` block deletion; retain attribution/history; confirm deployment origin and future Editor mutation routes |
| D2/D4 | Keep mutations below the shared middleware; retain server-side role, ownership and workflow checks; use the same origin for forms and AJAX |

The current `routes/editor.js` contains GET routes only. This change does not
invent missing Editor publication endpoints. Existing Editor-only comment
PATCH/DELETE routes are protected. Future Editor article mutations mounted in
the application inherit protection and still need their own workflow tests.

## Task 1: account rules

Only trusted operators with local shell and database access maintain accounts.
There is no public registration or administrative account-management screen,
and no User CRUD HTTP API. Shell/database access is the CLI's trust boundary.

| Operation | Rules |
| --- | --- |
| Create | Required username, display name, role, private password; only `reporter` or `editor` |
| Read | Exactly one lookup key: 24-character hexadecimal ID or normalized username |
| List/search | Default 20 rows, maximum 100; literal, case-normalized username **prefix** search; username ordering and `after` cursor |
| Update | Only username, display name, and role; at least one field; unknown fields rejected |
| Reset password | Existing `User.setPassword` scrypt implementation; atomic password/version update and session deletion |
| Delete | Offline maintenance only; reject if any article, authenticated comment, or publication event references the account; otherwise atomically remove account and sessions |

Guests are anonymous browser identities, not stored User accounts. The User
schema now requires an explicit Reporter/Editor role, with no Guest default.
Existing stored Guest rows are not migrated or deleted; inspect them separately
if an older database contains any. Seed code must supply an explicit role.

Usernames are trimmed, lowercased, nonblank, at most 50 characters, and cannot
contain control characters. Display names are trimmed, nonblank, at most 100
characters, and cannot contain control characters. Passwords are 8–128
characters and are not trimmed. Role values are lowercase and exact. MongoDB's
unique username index resolves concurrent duplicates; both create and rename
report `DUPLICATE_USERNAME`. Search metacharacters are escaped as literal text.
Pagination is bounded and does not promise a snapshot while accounts are renamed.

### References and deletion

The reference inventory in the current repository is:

| Collection field | Deletion behavior |
| --- | --- |
| `Article.author` | Blocks deletion, including drafts, pending/returned articles, and published articles |
| `Comment.author` | Blocks deletion; Guest comments have `null` and do not reference a User |
| `PublicationEvent.editor` | Blocks deletion, preserving approval attribution and analytics history |
| `Session.user` | Does not block deletion; all matching sessions are removed atomically |

No cascade, reassignment, anonymization, or automatic content deletion is
performed. A rejected deletion lists the blocking reference categories and
leaves account, content and sessions unchanged. `Comment.author` and
`PublicationEvent.editor` receive lookup indexes; Article already has an
author-prefixed index. Future User references must be added to this check.

**Deletion maintenance procedure:** stop and drain every application instance
(including watch-mode processes), seed job, and other database writer. Run only
one maintenance operator at a time. Then run deletion with `--offline`. Resume
the application after completion. The flag is an operator acknowledgment, not
an automatic lock or process detector. Both the CLI and model helper require it.

This restriction is intentional: a MongoDB transaction alone cannot prevent
another process inserting a new reference after the reference query's snapshot.
The current article/comment/publication writers do not coordinate on a shared
User lock. Online account deletion is therefore unsupported. Ignoring the
offline prerequisite can create dangling references. Supporting online deletion
later requires D2/D4 changes to every referencing writer and concurrency tests.

### Session behavior

Username/display-name changes retain sessions; subsequent requests load the
current account values from MongoDB. Actual role changes and password resets
increment `User.authVersion` and remove all sessions in the same transaction.
Setting a role to its current value does not revoke sessions. Setting the same
password again still revokes them. Failed transactions preserve prior credentials,
roles, and sessions. Deletion removes sessions together with the account.

Login copies the version it authenticated into `Session.authVersion`.
`loadUser` compares this against the database-loaded User on every request.
This also rejects a session inserted by a login that started before a reset or
role change but finished afterward. Legacy missing versions are treated as zero,
so this schema extension does not force existing valid accounts to log out.
Version fields are internal and cannot be changed through maintenance options.
In-flight requests already authorized before revocation may finish; revocation
applies to subsequent authentication checks. Process restarts do not revoke sessions.

### Safe output and errors

Maintenance output uses an explicit projection: `id`, `username`, `displayName`,
`role`, `createdAt`, `updatedAt`. List adds `users` and `nextAfter`; deletion wraps
the safe record in `deleted`. Passwords, password hashes, authentication versions,
session tokens, and token digests are excluded. The CLI logs only safe results
and the completed operation name. Database exception text and connection strings
are not printed. Exit status is 0 for success/help, 1 for errors/cancellation.

Errors have stable codes: `INVALID_INPUT`, `NOT_FOUND`, `DUPLICATE_USERNAME`,
`USER_REFERENCED`, `DATABASE_FAILURE`, and `CANCELLED`. Database failures give
configuration/transaction guidance without exposing driver error details.

## Task 2: maintenance commands

Configure `MONGODB_URI` as for the application. A transaction-capable replica set
is required. Run password operations in an interactive terminal: input is hidden,
confirmed, and never accepted as a CLI argument, environment variable, or pipe.
Ctrl+C/Ctrl+D cancels and restores terminal mode. Password characters are not
echoed, including masking characters. Do not include real credentials in commands.

```powershell
npm run users -- --help
npm run users -- create --username reporter1 --display-name 'Reporter One' --role reporter
npm run users -- create --username editor1 --display-name 'Editor One' --role editor
npm run users -- read --username reporter1
npm run users -- read --id 0123456789abcdef01234567
npm run users -- list
npm run users -- list --search report --limit 10
npm run users -- list --search report --limit 10 --after reporter1
npm run users -- update --username reporter1 --display-name 'Updated Name' --new-username reporter2
npm run users -- update --username reporter2 --role editor
npm run users -- reset-password --username reporter2
# Only after all app instances, seed jobs and other writers are stopped:
npm run users -- delete --username unused_account --offline
```

ID and username are alternatives; do not supply both. When updating, `--username`
identifies the existing account and `--new-username` supplies the replacement.
The old command `npm run create-user -- reporter1 'Reporter One' reporter`
still works, but now prompts privately; `NEW_USER_PASSWORD` is no longer read.

Reusable database logic lives in `models/userMaintenance.js`. The CLI owns
argument parsing, private terminal input, connection lifecycle, and presentation.
The model helper owns validation, projections, bounded queries, reference checks
and transactions. `setPassword` remains the only hashing implementation.

## Task 3: shared CSRF contract

`middleware/csrf.js` is mounted before body parsing, cookies, authentication,
and all routes. Every method except GET/HEAD/OPTIONS must prove its source origin.
This covers login, logout, Guest/authenticated comments, Reporter mutations,
Editor comment mutations, and future Editor routes. Rejections happen before
controllers and before database/session reads or writes.

1. If `Origin` exists, require one valid HTTP(S) origin exactly matching the
   configured origin. Reject `null`, malformed values, paths, lists, and mismatches.
2. Only if Origin is absent, parse `Referer` and require its full origin to match.
3. If neither establishes a trusted source, respond HTTP 403 with
   `{ "error": "CSRF_REJECTED", "message": "..." }`. An invalid Origin never falls
   back to a valid Referer. Missing headers are not an exemption.

Scheme, host and port must match. Sibling subdomains and suffix tricks do not
match. Target origin is configured by the server, never inferred from request
`Host`, `X-Forwarded-Host`, or other proxy headers. This follows the source/target
origin verification approach in the
[OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

Set `.env` to the address users actually open:

```dotenv
PORT=3000
APP_ORIGIN=http://localhost:3000
```

Development defaults to `http://localhost:${PORT || 3000}` when APP_ORIGIN is
absent. If browsing through `127.0.0.1`, another port, or a LAN name, explicitly
configure that origin instead. One canonical origin is supported. In production,
APP_ORIGIN is mandatory and must use HTTPS; set it to the public browser origin
even when a reverse proxy forwards internally over HTTP. Invalid configuration
fails startup. No production missing-header bypass is provided.

Existing forms and Vanilla JS fetch calls use same-origin URLs, so browsers
supply protection headers automatically; no hidden form token or new JavaScript
dependency is needed. Browser scripts must not attempt to set Origin manually.
Command-line HTTP clients and tests must explicitly send a matching Origin or
Referer. A client outside the browser can forge these headers: this is CSRF
protection, not authentication. Authorization remains enforced separately.

Public GET/HEAD reads stay accessible without protection headers. The existing
article-visit analytics write associated with a public GET remains unchanged.
Do not put account/content mutations on GET routes. Forms rejected with 403 see
the JSON explanation; AJAX retains its current error handling and input. Reload
from the canonical site address, or correct deployment configuration. Do not
retry rejected mutations without addressing the origin problem.

## Verification and implementation record

Verified on 2026-10-11: **101 tests passed, 0 failed, 0 skipped** with both
integration URI variables enabled against an isolated MongoDB 8.0.15 replica set
on loopback port 27130. The application database was not used. `git diff --check`
also passed. The normal suite initially required execution outside the workspace
sandbox because its loopback HTTP connections were blocked; the final run used
the permitted local connections. No browser-based manual QA or D2/D4 sign-off
is claimed by these automated results.

- `test/user-maintenance.test.js`: invalid fields/selectors/roles/bounds,
  sanitized driver failures and duplicates, forbidden password arguments,
  private input without echo, cancellation and terminal restoration.
- `test/user-maintenance.integration.test.js`: actual MongoDB create/read/search/
  pagination/update/reset/delete; duplicate create/rename; literal search;
  safe output; old session rejection; delayed stale login; transaction rollback;
  each reference type independently blocking deletion; legitimate login/comments/
  Editor comment edits; forged mutations preserving database state.
- `test/csrf.test.js`: legitimate form/AJAX headers and Referer fallback;
  all unsafe methods; missing/null/malformed/foreign origins, different schemes,
  suffixes, spoofed proxy headers; unchanged handler state on rejection; all
  application mutation prefixes rejected before database access; public reads.
- Existing auth, Reporter, comments integration, foundation and device tests now
  send browser-equivalent origin headers. Guest-account schema expectations were
  updated to the agreed stored-account types. No frontend design changes.

Run the normal suite with `npm test`. Integration tests skip explicitly when
their dedicated URI variables are absent. To run the lifecycle test against a
disposable replica-set database (replace port/set name for your local instance):

```powershell
$env:USERS_TEST_MONGODB_URI = 'mongodb://127.0.0.1:27130/the_daily_web_users_test_a11ce?replicaSet=usersTest'
try { node --test test/user-maintenance.integration.test.js }
finally { Remove-Item Env:USERS_TEST_MONGODB_URI }
```

The test accepts only names matching `the_daily_web_users_test_[a-f0-9]+`, checks
the URI before connecting, and drops that dedicated database afterward. Never
point it at an application database. Use a fresh suffix for concurrent runs.
The existing comments integration suite uses `COMMENTS_TEST_MONGODB_URI` with
its own `the_daily_web_comments_test_[a-f0-9]+` naming contract.

The isolated fixture server may remain listening during lifecycle tests because
the tests are serial and no independent writer runs. Production deletion still
requires stopping all application writers. These tests do not establish safe
online deletion or constitute D2/D4 review.
