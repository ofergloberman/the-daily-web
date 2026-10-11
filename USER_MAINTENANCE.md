# User maintenance contract

Status: proposed policy implemented on `dev1/user-maintenance-csrf`; D2/D4 human review and agreement are pending. This document records implementation decisions, not an assertion that teammates have approved them. Based on PROJECT_REQUIREMENTS sections 6.4, 14, 15 and 16.

Accounts are maintained only by a trusted local operator with database access, through a CLI. There is no public registration or administration route. Guests stay anonymous. Creation and role changes accept only `reporter` or `editor`.

Supported operations: create; read by exact ID or normalized username; list/search by username with default limit 20, maximum 100 and offset at most 10000; update username, displayName or role; reset password; delete. Reject unknown fields and ambiguous selectors. Usernames are trimmed and lowercased, nonempty, at most 50 characters without whitespace/control characters. Display names are trimmed, nonempty, at most 100 characters without control characters. Passwords are 8–128 characters, use existing `User.setPassword`, and are privately prompted twice on a terminal. Passwords are never command arguments, environment variables, logs or output.

Read/list/write output is an explicit allowlist: id, username, displayName, role, createdAt and updatedAt. Never return password hashes, raw passwords, sessions or tokens. Errors identify invalid input, duplicate usernames, missing users, reference blockers and database failure without printing database details or supplied secrets.

Password resets, actual role changes and successful deletion revoke **all** sessions of the user. Account change and session deletion commit in one MongoDB transaction or both roll back. Name/username edits preserve sessions; future requests load the current user. Ordinary restarts preserve sessions. Already-running requests cannot be recalled.

Deletion rejects any reference in `Article.author` (any status and either version), `Comment.author`, or `PublicationEvent.editor`. The error lists blocking reference categories. Guest comments have null authors and do not block. Do not cascade, anonymize, reassign authors, erase publication history or alter snapshots. Existing comment display names are historical snapshots and do not change with account name edits. Role changes preserve all references, content and publication events; a Reporter changed to Editor loses Reporter routes, so coordinate ownership/work before changing roles. No special last-Editor exception is required: a local operator can create an Editor.

**Offline write precondition:** stop every application process, other maintenance command and seed/import writer before create/update/reset/delete; restart after completion. The CLI requires `--offline` to acknowledge this. Read/list can run online. Transactions alone do not prevent concurrent inserts of references or login sessions because MongoDB has no foreign-key locking. D2/D4 must preserve this precondition or add shared locking to every reference writer before enabling online account maintenance. New User reference fields must be added to deletion blockers and lifecycle tests before use.

Review checklist for D2/D4: confirm the three reference fields and reject-deletion policy, historical display-name behavior, offline write precondition, role-change effects, and the CSRF contract in CSRF.md. No teammate messaging or approval is assumed.

## Commands

Configure `MONGODB_URI` in the ignored `.env`. Stop all writers for write commands; `--offline` acknowledges this requirement, it does not stop processes automatically. Run passwords in an interactive terminal; piped input is rejected. Exit status 1 indicates failure. Output contains only safe profile fields (deletion returns the deleted profile).

```powershell
npm run users -- create --username reporter1 --display-name 'Reporter One' --role reporter --offline
npm run users -- read --username reporter1
npm run users -- read --id 0123456789abcdef01234567
npm run users -- list --search rep --limit 20 --offset 0
npm run users -- update --username reporter1 --new-username reporter2 --display-name 'Reporter Two' --offline
npm run users -- update --username reporter2 --role editor --offline
npm run users -- reset-password --username reporter2 --offline
npm run users -- delete --username reporter2 --offline
```

Search is a literal normalized username prefix; `--id` and `--username` are mutually exclusive selectors. Update accepts one or more of `--new-username`, `--display-name`, `--role`. Unknown/repeated flags, password flags and extra arguments are rejected. The legacy `npm run create-user -- reporter1 'Reporter One' reporter --offline` delegates to the same implementation.

## Verification

`node --test test/user-maintenance.test.js` covers validation, CLI parsing, private password entry and safe failure output without MongoDB. Real lifecycle verification uses a dedicated disposable replica-set database:

```powershell
$env:USERS_TEST_MONGODB_URI = 'mongodb://127.0.0.1:27018/the_daily_web_users_test_012345abcdef?replicaSet=rs0'
node --test test/user-maintenance.integration.test.js
Remove-Item Env:USERS_TEST_MONGODB_URI
```

The integration suite requires a database named `the_daily_web_users_test_<hex>`; it requires the database to be empty and drops it after testing. Never point it at application data. It tests every operation, duplicates, revocation, reference blockers and transaction rollback. Without the variable the database suite is explicitly skipped.
