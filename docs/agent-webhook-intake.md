# Agent webhook intake

This separate Neon Function records maintainer-approved issues for future agent work.
It does not run an agent, execute issue text, comment, open PRs, or merge changes.
Mellon's Action, detector, and 0.80 cutoff remain unchanged.

## Eligible issues and maintainers

Any open issue number in `randoneering/mellon` can qualify, including feature requests and bugs.
There is no issue-number or template allowlist.
The signed event must identify the configured repository name and immutable numeric ID.
A human with current write, maintain, or admin access must add `agent: ready`.
Label comparisons ignore capitalization and preserve the original GitHub label.
Bot/ghost senders and insufficient permissions cannot approve jobs.

The intake reads the sender's effective permission from GitHub, not `author_association`.
GitHub may represent maintain access as the legacy `write` permission.
The permission response must identify the same human sender.
The intake then rereads the issue and checks its identity, repository, open state, current label, and absence of a PR marker.
Moved issues and API redirects are not followed.
An unavailable or malformed read fails closed with 503; a confirmed ineligible issue returns `ignored`.

Give the Function a credential limited to this repository with **Metadata: read** and **Issues: read**.
The runtime calls only these fixed resources on `https://api.github.com`:

- `GET /repos/randoneering/mellon/collaborators/USERNAME/permission`
- `GET /repos/randoneering/mellon/issues/NUMBER`

No GitHub write permission is needed by the Function.
Each API read has a 10-second deadline and a 256 KiB response limit.

Queueing records approval at intake time; it does not freeze issue content or permissions.
A future worker must reread the issue and reauthorize before executing any work.
Existing labeled issues are not scanned automatically.

## Stored data and database setup

The additive migration is `migrations/agent-intake/001-initial.sql`.
It creates only the `agent_intake.jobs` and `agent_intake.deliveries` tables in a new schema.
Review it before applying it to a selected database with a migration credential.
It fails on an existing schema rather than overwriting unknown objects and uses 2-second lock and 10-second statement limits.
Do not run database tests against production.

Jobs contain IDs for the repository, issue, approving actor, and initial delivery, plus the repository name, queued status, and creation time.
Receipts contain a delivery ID, SHA-256 body digest, job ID, and receipt time.
No issue title, body, comment, raw payload, signature, or credential is stored.
The digest detects conflicting delivery IDs without retaining prose.

The database enforces one job per repository/issue identity and one receipt per delivery ID.
Concurrent deliveries and redeliveries converge on those records.
The current version only creates `queued` jobs; it has no processing, cancellation, deletion, or requeue endpoint.
A later worker must define lifecycle and reapproval behavior before consuming jobs.

Create a dedicated runtime database login separately from the migration identity.
Grant it only CONNECT to the selected database, USAGE on `agent_intake`, and SELECT and INSERT on its two tables.
It must not receive table ownership, schema creation, or UPDATE, DELETE, and TRUNCATE privileges.
Use that login's connection string as `AGENT_INTAKE_DATABASE_URL`, not an owner connection.
Do not upload migration credentials or the Neon administration API key to the Function.

### Isolated database tests

With Docker available, run:

```sh
node scripts/test-agent-intake-db.mjs
```

The runner starts a digest-pinned Postgres container with temporary memory-backed data and a random test password.
It binds only to loopback and creates a random per-run marker inside the fresh database before authorizing the integration tests.
Three negative guard probes first confirm that missing or mismatched authorization creates no intake schema or runtime role.
Each integration test checks both the runner token and its stored marker before running a migration or granting privileges.
A loopback URL and test database name alone do not authorize changes.
The runner then runs seven store/integration checks and stops its own disposable container afterward.
It rejects remote URLs and query-string host overrides.
Without the runner URL and token, the ordinary Node suite skips real database checks; skipped checks are not live database evidence.
A wrong or missing database marker fails closed.

## Configure and deploy

Use Node 24 and the installed Neon CLI.
If the global command is missing from this shell, run `export PATH="$(npm prefix -g)/bin:$PATH"`.
A Neon API key can authenticate the provisioning CLI without a browser callback, but it must not enter Function env.
Use secure secret entry or a private CLI profile; do not put keys in command arguments, shell history, committed files, or shared output.

The checkout links to project `long-silence-33474510`, branch `production`, in `aws-us-east-2`.
Inspect existing services and review the deployment plan before changing that branch.
The production project already has Auth enabled; `neon.ts` preserves it rather than disabling it.
The intake itself needs Postgres only; do not add AI Gateway, Object Storage, or a schedule.

### Credentials and schema

1. Review `migrations/agent-intake/001-initial.sql` and apply it with the selected database owner after approval.
   With `psql` installed and the owner connection provided privately as `PGDATABASE`, run `psql --set ON_ERROR_STOP=1 --file migrations/agent-intake/001-initial.sql`.
   Do not put the owner URL in command arguments or the Function's env file.
2. Create a dedicated runtime login with no admin membership or schema ownership.
   Neon's role-creation default is admin: do not accept that default.
   A schema-scoped `--access read_only --schema agent_intake` role is a starting point; grant INSERT only on the two intake tables and inspect its effective privileges.
   Never use `--access read_write`, which grants unnecessary UPDATE and DELETE access.
3. Retrieve the restricted runtime connection privately and confirm it has only the grants described above.
   Use explicit `sslmode=verify-full`; when retrieving it through Neon CLI, select `--ssl verify-full`.
   This preserves certificate and hostname verification without relying on `pg`'s current aliases for `require`.
   The Function rejects missing or duplicate SSL modes, any mode other than `verify-full`, and conflicting TLS, compatibility, or host override options before creating a pool.
   Do not disable certificate verification or enable weaker libpq compatibility to silence the warning.
   Do not paste role-creation output, passwords, or connection strings into issues or logs.
4. Create a repository-limited GitHub credential with Metadata: read and Issues: read.
   Keep any credential used to administer repository webhooks separate from this runtime credential.
5. Select a random webhook secret and enter it privately in both the Function configuration and the GitHub webhook.

Create `.env.local` with owner-only permissions, or use an existing ignored `.env`.
Both filenames must be ignored before writing them.
Populate it through private secret handling, not by echoing values into a shared terminal.

| Local variable | Purpose |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for authenticating GitHub deliveries. |
| `GITHUB_READ_TOKEN` | Repository-limited read credential. |
| `GITHUB_REPOSITORY_ID` | Verified numeric GitHub repository ID; not its GraphQL node ID. |
| `AGENT_INTAKE_DATABASE_URL` | Restricted runtime connection, never the migration owner. |

`neon.ts` pins the repository name to `randoneering/mellon`.
It uploads only these runtime inputs and overrides both automatically injected `DATABASE_URL` and `DATABASE_URL_UNPOOLED` with the restricted connection.
The second overridden URL is a defensive alias, not a separate migration connection.
Missing values fail configuration rather than uploading empty strings.
The Function creates one small pool and does not print raw pool errors.

### Review and deployment

After local checks and explicit production approval, use the same ignored env file for both commands:

```sh
neon config plan --env .env.local
neon deploy --env .env.local --no-env-pull
neon functions get githubintake
```

Substitute `.env` only when that is the file you configured.
Do not share raw plan or CLI output if it contains credentials.
The no-env-pull flag avoids pulling owner credentials back into the runtime secret file.
Review any unrelated service change before applying it; do not use automatic override flags to bypass that review.
The only declared Function is `githubintake`; the unused generated `hello.ts` is not deployed.

### GitHub webhook and live check

In the repository's webhook settings, create or reuse a matching webhook with:

- The Function invocation URL followed by `/github`.
- Content type `application/json`, the private shared secret, and SSL verification enabled.
- Only Issues events, with delivery enabled.

Do not replace or change unrelated hooks.
If `agent: ready` does not exist, a maintainer can create it with a description explaining that it approves intake only, not execution or merging.
Have an authorized human add it to a chosen open issue.
Verify GitHub records a 202 response and an operator query finds exactly one queued job for that repository and issue ID.
Redeliver that same event through GitHub's delivery controls and verify 200 `duplicate` with the same job count.
Send an unsigned request to verify 401 without database changes.
Keep a note of safe delivery IDs, response statuses, job counts, and any blocker; do not copy request payloads or secrets.

To stop intake, disable the matching webhook or disable the Function after approval.
Retain the schema and records for inspection; do not drop tables or erase queued jobs automatically.

## HTTP contract

Send GitHub JSON webhooks to `POST /github` on the Function URL.
The intake verifies `X-Hub-Signature-256` against the original bytes before parsing them.
It accepts up to 256 KiB, including streamed requests without a length header, and rejects compressed bodies.
Request reads have a 10-second limit.
Only `issues.labeled` events for `agent: ready` are candidates for queueing.
Other signed events, including GitHub's webhook ping, return `ignored`.

GitHub webhooks use GitHub HMAC authentication.
Neon's `parseTriggerDelivery` authenticates Neon schedule/storage deliveries and is not used by this endpoint.

| HTTP status | Result | Meaning |
| --- | --- | --- |
| 202 | `queued` | A new job and delivery receipt committed. |
| 200 | `duplicate` | This delivery or issue already has a queued job. |
| 200 | `ignored` | The event does not approve eligible work. |
| 400 | `invalid_request` | The supported payload or delivery identity is malformed, or a delivery ID conflicts. |
| 401 | `unauthorized` | The webhook signature is missing or invalid. |
| 404 | `not_found` | The route is not `/github`. |
| 405 | `method_not_allowed` | The method is not POST. |
| 413 | `too_large` | The body exceeds 256 KiB. |
| 415 | `unsupported_media_type` | The content type or encoding is unsupported. |
| 503 | `unavailable` | Required reads or durable persistence could not be confirmed. |

A 503 does not prove that a database transaction rolled back.
Redelivery reconciles through database constraints rather than creating another job blindly.
GitHub does not guarantee automatic failed-delivery retry; maintainers may need to request redelivery.
Responses and application logs must not contain issue text, signatures, credentials, or raw upstream errors.

## Failure diagnostics

Unavailable operations log one JSON line with only fixed `category`, fixed `stage`, and `deliveryId` fields.
Delivery IDs appear only after signature and event-identity checks; configuration and unauthenticated request failures log a null ID.
The 503 HTTP body remains `{ "status": "unavailable" }`.

| Category | Stages | Operator check |
| --- | --- | --- |
| `github_unavailable` | `permission_read`, `issue_read` | Check the repository-limited token, GitHub availability, and current issue access. |
| `persistence_unavailable` | `receipt_read`, `enqueue`, `pool` | Check runtime database connectivity and SELECT/INSERT grants. |
| `request_timeout` | `request_read` | Check webhook transport and request duration. |
| `configuration_invalid` | `configuration` | Check required env values, repository identity, and verified TLS options. |
| `handler_unavailable` | Other fixed handler stages | Investigate the deployed code without dumping raw request or exception data. |

Normal ignores and invalid signatures do not emit operational-failure diagnostics.
Diagnostics never include exception messages, upstream response details, URLs, or private payload fields.
Use the validated delivery ID to locate GitHub's delivery record, and request redelivery after correcting a failure.
