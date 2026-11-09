# GitHub App credential broker

`createGitHubAppBroker(config, { fetch, now })` uses Node's RSA signing and fixed GitHub API routes.
The optional dependencies support controlled tests.
No credentials come from issue text or model output.

## Operator configuration

- `appId`, `installationId`, `repositoryId`: positive GitHub database IDs.
- `repositoryName`: exactly `randoneering/mellon`.
- `privateKey`: an App RSA private key with at least 2,048 bits.
- `actor`: `{ databaseId, login }` for the App bot account.
- `preflightCommitSha`: a pinned existing commit with the required actor and GitHub signature evidence.

The broker snapshots configuration and checks the authenticated App ID, App slug, installation identity, suspension status, grants, repository identity, and bot's immutable user ID.
It reads the bot through `GET /users/{app-slug}[bot]`; installation tokens cannot use `GET /user`.
JWTs expire after eight minutes and backdate `iat` by 60 seconds.

## Scoped capabilities

| Method | Requested permissions |
| --- | --- |
| `getReadToken(control)` | Metadata, contents, issues, pull requests, Actions and checks: read |
| `getPublicationContext(request)` | Metadata: read; contents: write |
| `getPullRequestContext(request)` | Metadata and contents: read; pull requests: write |

Every token request restricts `repository_ids` to the configured repository.
The broker verifies returned permissions and the token's authoritative `/installation/repositories` listing.
An installation covering other repositories is allowed only when its issued token remains restricted to this single repository.
Verified tokens remain cached until fewer than two minutes remain.
PR context hashes, expiry and permissions describe the same token issuance.

`request` contains `{ repositoryId, repositoryName, runId, branch, signal, deadline }`.
The branch must equal `agent-work/{runId}`.
`control` contains optional `signal` and absolute `deadline`.
`verifyRuntime(control)` rechecks installation grants, verifies reader/commit/PR capabilities, and reads the existing signing proof.
It creates no signing-test commit or repository content.

## Bounds and verification

- Fixed `https://api.github.com` origin, no redirects or automatic retries.
- One operation deadline: 20 seconds by default, at most 30 seconds.
- Local waits remain bounded when fetch or body readers ignore abort.
- Streamed JSON stops at 256 KiB; late response bodies receive cancellation requests.
- Errors contain fixed categories, never keys, tokens or raw API messages.

Local tests cover controlled GitHub HTTP responses, actual RSA signatures and existing publication validators.
They do not verify live App grants, GitHub signing compatibility, remote cancellation, or the deployment's pinned preflight commit.
Provisioning and live preflight remain separate approval gates.
