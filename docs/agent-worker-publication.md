# Agent worker publication

The publisher creates a deterministic branch, structured commits, and one run-owned draft PR.
It never writes issues, labels, comments, readiness, merges, deployments, or deletions.

## API

`publish(input, dependencies)` executes the branch and commit phases.
`probePublication(input, dependencies)` performs read-only reconciliation for a recovery owner.

The input contains a trusted run projection, a durable intent ID, the private approved manifest, and raw proposed file changes.
The run binds the UUID, immutable repository and issue IDs, approver ID, manifest SHA-256, approved base SHA, expected current head SHA, and lease generation.
The intent ID is a stable SHA-256 reference supplied by the trusted coordinator.
The publisher revalidates proposals with `validateChanges` against the complete Git tree at the exact expected head.

Both functions require these injected dependencies:

- `fetch(url, init)` supplies HTTP transport; the publisher constructs fixed `https://api.github.com` URLs and static GraphQL documents.
- `getPublicationContext({repositoryId, repositoryName, runId, branch, signal, deadline})` returns the trusted token and signing preflight context.
- `checkApproval({run, approvedManifest, manifestSha256, signal, deadline})` performs a fresh approval check.
- `checkFence({runId, generation, intentId, operationHash, expectedHeadSha, phase, signal, deadline})` checks lease ownership, generation, deadline, and the durable intent.

The approval callback returns the existing approval contract with `authorized: true`, `reason: 'approved'`, and matching repository, issue, approver, manifest, base, and policy evidence.
The fence callback returns the exact request identity and `decision: 'execute'` or `decision: 'reconcile_only'`.
A reconciliation-only decision never authorizes a write.
The publisher calls approval and fence gates before each mutation and applies one aggregate deadline to callbacks, token acquisition, fetch, and response reads.

`getPublicationContext` must return a repository-scoped GitHub App installation token, its expiry, the fixed repository identity, App and installation IDs, and the expected App bot actor identity.
It must verify the App, installation, and repository from trusted runtime configuration rather than accepting a PAT, environment fallback, or caller-supplied token.
The signing preflight must come from an actual GitHub commit created with that App installation in an explicitly approved test branch.
It must bind the same repository, App, installation, and author bot actor, and require GitHub's `web-flow` committer (`GitHub`, `noreply@github.com`) with `signature.isValid: true`, `signature.state: 'VALID'`, and `signature.wasSignedByGitHub: true`. GitHub signs API-created commits as `web-flow`.
The context expires within five minutes, and the publisher rejects missing or expired preflight evidence before writing.
Synthetic test context does not prove a live App token or signing capability.

## GitHub operations

The adapter reads repository identity, the owned branch ref, the expected commit, and a complete recursive Git tree.
The REST Git commits endpoint supplies a top-level `tree.sha`; it does not use the repository-commit endpoint's nested shape.
GraphQL ref responses supply a short `name` and separate `prefix`; both must match the owned branch before normalization.
It rejects malformed or truncated trees and bounds response bytes, request time, and the aggregate operation time.

The only branch name is `agent-work/<run UUID>`.
Owned ancestry is bounded to six commits: two initial test/implementation commits and two regression/implementation repair pairs.
The publisher refuses a seventh new commit before dispatch; a six-commit branch can still reconcile and open its draft PR.
Every ancestor still requires the expected repository, single parent, App actor, and signing proof.
The ref creation request targets the approved base SHA and never updates or force-pushes an existing ref.
The only commit mutation is the static `createCommitOnBranch` GraphQL document with `expectedHeadOid`, base64 file additions, a fixed commit headline, and no caller-controlled author, committer, query, URL, shell command, or deletion.
The publisher accepts only `100644` output files because the documented structured file-change input does not expose a file-mode argument.
It rejects executable-mode edits before writing rather than assuming that GitHub preserves the mode.

After a commit, the publisher checks the exact repository, commit OID, single expected parent, complete tree, changed paths, blob SHA-1 values, modes, author App actor ID, `web-flow` committer identity, and GitHub signature state.
The opaque operation SHA-256 binds the run, manifest, approved base, expected head, paths, content, current blob and mode, and resulting mode.
Git blob SHA-1 values are separate from the operation SHA-256.

## Reconciliation and permissions

The publisher never blindly repeats an uncertain write.
All budgeted callbacks and transport operations dispatch lazily after deadline and abort checks, including after a successful mutation fence.
A resumed expired owner cannot start a new request; every started promise has rejection observers.
A request already sent before expiry still requires remote reconciliation.
It probes the deterministic branch and confirms a commit only when the branch head, commit parent, complete tree diff, file versions, modes, App actor, and signing evidence match the intent.
A missing branch after an uncertain create, an unchanged head after an uncertain commit, or any foreign, moved, unsigned, or ambiguous state returns a fixed `needs_attention` result with only confirmed references.
The adapter does not claim distributed exactly-once behavior.

The GitHub App needs Metadata read and Contents read/write for repository identity, Git tree reads, ref creation, and structured commits.
Branch and commit publication does not require pull-request permissions.
Draft PR creation additionally requires confirmed Pull requests write permission.
The adapter does not request or change any live App permissions.
App creation, private-key handling, token issuance, and live signing preflight remain separate activation gates in tasks 6.2 and 8.2.

## Draft PR API
`ensureDraftPr({run, intent, approvedManifest}, dependencies)` preserves the existing `publish` and `probePublication` schemas.
Its separate strict input accepts the same run projection, `intent: {id, kind: 'pr_create'}`, and the approved manifest with `requiredChecks` and `requiredWorkflowIdentities`.
The expected head must differ from the approved base.
Extra request fields, including checks, PR text, tokens, branches, and API URLs, are rejected.

The PR path uses `fetch`, `checkApproval`, `checkFence`, and two additional trusted callbacks:
- `getPullRequestContext({repositoryId, repositoryName, runId, branch, signal, deadline})` returns `{publicationContext, installationToken}`.
- `checkInitialChecks({run, approvedManifest, repositoryId, headSha, branch, signal, deadline})` invokes `createCheckReader(...).readChecks(...)` with workflow-run IDs and attempts from trusted coordinator configuration.

`publicationContext` retains its existing exact schema, including the signing preflight.
`installationToken` has exactly `repositoryId`, `repositoryName`, `appId`, `installationId`, `tokenExpiresAt`, `tokenSha256`, and `permissions`.
Its identities and expiry must match the context, and `tokenSha256` must hash the exact context token.
`permissions.pull_requests` must equal `'write'` from the trusted issuance response.
Supported optional permission entries are Metadata read, Contents read/write, Actions read, Checks read, and Issues read; unknown entries or values stop publication.
The broker must independently verify App/installation identity and single-repository restriction when issuing the token.
Neither callback result can come from an issue, model output, or request field.

The initial-check callback returns the existing check-reader result, not a new evidence schema.
Creation requires `status: 'success'`, matching repository/head/branch, `event: 'push'`, one distinct run per approved workflow, and complete successful check counts with the approved App IDs.
Check IDs must be distinct; each check binds its suite, completed status, success conclusion, and exact head.
The flattened checks must match the workflow evidence.
The check reader remains responsible for context-name matching, workflow provenance, diagnostics, and trusted run/attempt selection.
Waiting, intended-red, stale, duplicate, incomplete, or malformed evidence never authorizes creation.

The PR operation hash binds `pr_create`, run/issue/repository identity, manifest, approved base, expected head, deterministic branch, intent ID, and supported template digest.
It excludes lease generation so recovery can reconcile the same durable operation under a new owner.
PR fence calls additionally pass and require `kind: 'pr_create'`, using `phase: 'probe'` for reads and `phase: 'pr'` before creation.
The coordinator must store that exact hash/kind/head and return `reconcile_only` for an already attempted or uncertain write.
An unchanged or missing remote effect never grants permission to repost.

## Draft PR reconciliation
The adapter reads the template at the approved base SHA through a fixed Contents API path.
It accepts only the current supported repository template bytes and Git blob hash; a template change requires a reviewed adapter update.
The title and body use fixed summaries, bounded IDs/counts, issue and commit-check links, and a run/operation marker.
They contain no issue text, model output, logs, or automatic issue-closing directives.
The template content cannot supply instructions or executable code.

A fixed REST list request uses `state=all` and the exact owner/branch filter, without a base filter that could hide a conflicting PR.
At most three pages of 100 entries are read, without following server-provided URLs.
Incomplete pagination, multiple candidates, or any mismatched identity stops publication.
One candidate must match repository/owner, base branch and approved base SHA, head branch/SHA, App bot ID/login, deterministic title/body, open state, and draft state.
A closed, merged, or ready PR is never reopened or changed.
A base branch that has advanced beyond the approved base also requires human attention.

With no existing PR, the adapter requires current-head green checks, then rereads the branch and rechecks approval, the durable fence, and token/preflight freshness immediately before its sole possible `POST /repos/randoneering/mellon/pulls` with `draft: true`.
Every response, including a successful or lost response, is reconciled by listing exact remote state again.
A response alone cannot confirm creation.
Existing exact PRs can reconcile without rerunning initial checks and without another write.
All callbacks, transport, and response streaming share one deadline of at most 30 seconds and bounded response sizes.

Success returns only `status: 'confirmed'`, `branch`, `inputHash`, `branchHeadSha`, `prId`, `prNumber`, `prCount: 1`, `headSha`, `baseSha`, and `draft: true`.
Failures return `needs_attention`, a fixed category, and safe known refs/hash only.
Tokens, permission records, exception messages, API bodies, and generated PR text are not returned or persisted by this adapter.
The trusted coordinator persists the safe result through its durable operation protocol.

## Verification limits
Controlled-transport unit tests cover uncertain creation, exact existing reconciliation, mismatched identities, count ambiguity, initial-check gates, token-record validation, deadlines, and forbidden writes.
They use synthetic installation contexts and do not prove token issuance, repository restriction, live App scopes, signing, workflow-run selection, or live GitHub behavior.
Live activation still requires separate approval and verified App issuance, Pull requests write access, current trusted push checks, signing preflight, and draft-PR capability.
No live writes, permission changes, or workflow settings are part of these tests.
REST PR creation has no expected-head compare-and-swap, so another actor can still race the final read; post-write reconciliation detects disagreement but does not claim distributed exactly-once behavior.

Observed local verification for task 4.4:

| Command | Result |
| --- | --- |
| `node --test tests/unit/agent-worker-publisher.test.mjs` before implementation | 90 tests: 24 passed, 66 failed on the missing PR adapter |
| Same command after implementation and added boundaries | 104 passed, 0 failed, 0 skipped |
| `node --test tests/unit/agent-worker-*.test.mjs` | 366 passed, 0 failed, 0 skipped |
| `npm test` | 674 tests: 636 passed, 0 failed, 38 existing database integration skips |

No publication test is skipped or excluded.
The marker-authorized Postgres integration prerequisites were not supplied, so those 38 database cases remain unverified in this run.
Syntax checks and an exact comparison against `.github/PULL_REQUEST_TEMPLATE.md` also passed.

## Contract sources

Context7 was unavailable in the configured tools, so this implementation used the official GitHub documentation directly:

- [GraphQL commits](https://docs.github.com/en/graphql/reference/commits)
- [GraphQL Git types and signatures](https://docs.github.com/en/graphql/reference/git)
- [REST Git references](https://docs.github.com/en/rest/git/refs)
- [REST Git commits](https://docs.github.com/en/rest/git/commits)
- [REST Git trees](https://docs.github.com/en/rest/git/trees)
- [REST pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub App permission requirements](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [REST repository contents](https://docs.github.com/en/rest/repos/contents)

Context7 discovery was retried for task 4.4 and remained unavailable.
The official REST pull-request and App-permission pages were inspected directly; live capability remains unverified.

Run focused tests with `node --test tests/unit/agent-worker-publisher.test.mjs`.
