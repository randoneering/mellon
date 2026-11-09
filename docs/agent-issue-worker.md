# Agent issue worker

The issue worker policy loader is implemented as a disabled-by-default foundation for the separately reviewed pilot workflow.
It does not provision Neon resources, make model calls, or start a worker.

## Trusted policy bundle

`automation/policy/manifest.json` records SHA-256 pins for the worker policy, project `AGENTS.md`, three reviewed Superpowers skills, their four referenced companion documents, and original Mellon documentation guidance.
The skills come from `obra/superpowers` at commit `22f0b463e7a5e579904dd6211a520321035526f7` and retain the upstream MIT license in `automation/policy/skills/LICENSE`.
The documentation guidance is original project text, not an upstream skill, and refers to this repository's GNU AGPL version 3 `LICENSE`.

`loadPolicy(manifest, dependencies)` returns a disabled result when the manifest is absent, disabled, or lacks a pilot.
For an enabled manifest, it validates the one pilot identity and the reviewed paths and hashes before reading trusted files.
Missing, changed, forged, duplicate, oversized, or nontext trusted inputs fail closed.
Each skill's referenced companion text is loaded and verified as part of that skill's trusted context.
Issue text does not enter the returned system policy.

The successful result is `status: 'loaded'`, not an activation or approval flag.
It contains trusted prompt material and hashes only; a minimal pilot repository/number is not an approved execution manifest.
Before any side effect, later integration must separately verify the complete approved manifest and current issue authorization.

This loader alone does not authorize deployment or activation.
The [default runtime](agent-worker-runtime.md) is implemented and remains disabled.
A complete maintainer-approved manifest and separate deployment/live-preflight approvals remain required.

## Fresh approval checks

`checkApproval({ manifest, expectedManifestSha256, token, fetch, timeoutMs })` validates the complete manifest before making GitHub reads.
The optional trusted timeout can shorten, but cannot exceed, the five-second total read deadline.
`expectedManifestSha256` must come from trusted runtime configuration independent of the manifest, issue text, model output, and loader result.
`fetch` is an injected fetch-compatible function; tests use synthetic responses and never contact GitHub.
The adapter exposes no model or publication API.

The version 1 manifest requires exactly these fields:

- `version: 1` and `approved: true`.
- `repository: { name: 'randoneering/mellon', id: positive safe integer }`.
- `issue: { id, number, contentSha256 }`, with positive safe-integer IDs and a lowercase SHA-256 content hash.
- `approver: { id, login }`, identifying a positive safe-integer GitHub user ID and a valid login.
- `base: { branch: 'main', revision: 40-character lowercase Git commit SHA }` and `policyRevision`, another 40-character lowercase commit SHA.
- `pilotScope: { kind: 'bounded-public-issue', maxChangedFiles, maxFileBytes, maxTotalBytes }`, with positive limits no greater than 10 files, 64 KiB per file, and 256 KiB total.
- Nonempty unique `allowedPaths` and `acceptanceCriteria` arrays.
- Nonempty unique `requiredChecks` as `{ context, appId, workflowId }` records linked to approved workflow records.
- `requiredWorkflowIdentities` as `{ id, path: '.github/workflows/test.yml', sha256, appId, event: 'push', diagnostics }` records with unique positive workflow IDs and reviewed file hashes.
- Required `diagnostics: { version: 2, sources, reporter, skipPolicy }` binds the ordered six-path producer graph, immutable formatter revision/hash, and reviewed database-skip policy.
- `reporter` contains `{ context: 'test-report', revision, sha256 }`; `requiredChecks` must include that context with the matching workflow and App IDs.
- `skipPolicy` contains `{ version: 1, sha256 }` with the reviewed 62-identity policy hash `bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab`.
- The external manifest pin covers the complete descriptor; missing or legacy diagnostics cannot authorize green or intended-RED evidence.
- See [CI evidence contracts](agent-worker-checks.md) for exact source order, report schema V2, and skip validation.
- `qodoIdentities` as unique `{ userId }` records with positive immutable bot-user IDs, not login strings.
- `model: { id }` and all `limits` keys shown below.
- Optional closed `coordinator: { version: 1, regression }` binds an approved native workflow, allowed test-path index, initial criterion/literal test name, and two literal repair-test names.
  This block is covered by the external manifest pin and required for candidate preparation; foundation manifests without it remain valid.
  See [immutable inputs and candidate selection](agent-worker-candidates.md) for exact fields, index spaces, and the restricted static-test format.

The externally pinned pilot scope records the maintainer's qualification; it is not an automated proof that a ticket is small.

Limits must be safe integers and cannot exceed the design values: one nonterminal pilot run; one model call per tick and 20 per run; 8,000 input and 2,000 output tokens per call; 100,000 input and 20,000 output tokens per run; 90-second tick and 45-second model-call deadlines; a 180-second lease and two expired-lease recoveries; 1,800-second CI and review waits; a 7,200-second run lifetime; and two repair cycles.

Recovery and repair counters may be zero; other limits must be positive.
The model-call deadline must fit the tick, the lease must outlast the tick, and the lease and wait deadlines must fit the run lifetime.
Per-call token/call limits cannot exceed the corresponding run limits.

Manifest pins use SHA-256 over UTF-8 canonical JSON: recursively sort object keys lexicographically, preserve array order, emit compact JSON with `JSON.stringify` string and number rules, and hash the resulting bytes as lowercase hexadecimal.
The hash covers every manifest field, including `approved`; the external pin is the approval boundary, not `approved: true` by itself.
The adapter privately snapshots the manifest before validation and pin verification, then uses only that snapshot across asynchronous reads and evidence construction.
Changing the caller's manifest while a read is pending cannot change the approved content or IDs.
The approved issue content hash uses SHA-256 over UTF-8 `JSON.stringify([title, body])`, without normalization.

All reads use HTTPS `api.github.com`, redirects disabled, a five-second overall deadline, and a 64-KiB response cap per page.
The adapter bounds stalled fetch and body reads even when an injected dependency ignores abort, without waiting for nonsettling stream cancellation.
It reads repository, issue, labels, the approver's GitHub user identity and effective permission, and the fixed `main` branch head.
Label pages use fixed numeric GitHub URLs, 100 labels per page, and at most 10 pages; an incomplete read fails closed rather than proving absence.
It requires a currently public repository, matching repository and issue IDs/numbers and repository URL, an open non-PR issue, the `agent: ready` label (case-insensitive), unchanged title/body hash, a matching human approver and permission-response user with write/maintain/admin rights, and the pinned `main` head.
The issue author need not be human; human approval is the gate.
A null issue body is valid and hashes as `[title, null]`; malformed or missing body values are denied.

The result is either `{ authorized: true, reason: 'approved', evidence }` with only bounded IDs, login, approved hashes, and revisions, or `{ authorized: false, reason }` with a fixed reason code.
GitHub payloads, issue text, credentials, exception messages, and API error details are never returned.
Callers must deny work for every non-authorized result and repeat this check before each later effect.
The approval manifest and policy-loader request are distinct contracts.
After approval, integration must bind trusted file reads to `evidence.policyRevision`, which comes from the same verified snapshot, and derive the policy loader's pilot identity from the approved identity evidence, never from untrusted issue text.
Other approved configuration, such as path and budget limits, must stay in a private immutable configuration snapshot whose hash matches the approval evidence; do not reconsume a caller-mutated object.
The coordinator must also match the approval evidence IDs to its leased intake job before using it.

Run the synthetic boundary tests with `node --test tests/unit/agent-worker-approval.test.mjs`.

## Patch validation

`validateChanges(baseFiles, proposed, manifest)` accepts only explicitly allowlisted text creates and edits.
Pass an exact `{ allowedPaths, pilotScope }` projection from the private approved configuration, not the full approval manifest or untrusted model metadata.
`pilotScope` is `{ kind: 'bounded-public-issue', maxChangedFiles, maxFileBytes, maxTotalBytes }`.
The validator caps these at 10 changed files, 65,536 UTF-8 bytes per file, and 262,144 total UTF-8 bytes, even if the supplied scope is broader.

Trusted base metadata uses `{ path, mode, blobSha }` records for each proposed target and every ancestor component at the same pinned branch head.
Regular files use mode `100644` or `100755` with their lowercase Git blob SHA-1.
Directories use `{ mode: '040000', blobSha: null }`; confirmed absent paths use `{ mode: null, blobSha: null }`.
Symlink (`120000`) and gitlink (`160000`) records may describe known base topology, but cannot be edited or traversed.
Missing metadata is not proof of absence: the validator rejects unknown targets or ancestors, non-directory ancestors, inconsistent absence, and file/directory-prefix conflicts.
The trusted reader must inspect Git tree modes without following symlinks and distinguish verified absence from failed reads.
The publisher must repeat target/ancestor checks for creates and use an expected-head write before publication.
An edit proposal uses `{ operation: 'modify', path, content, expectedBlobSha }`; a create uses `{ operation: 'create', path, content }`.
Accepted records are copied and frozen with the content byte count and Git blob ID.
Creates use `100644`; edits preserve the existing regular text mode, including `100755`, without accepting mode-change requests.
The validator has no filesystem, GitHub API, or model effects, and its result is not approval evidence.

Paths must be exact safe relative paths without traversal, encoded-percent, backslash, absolute, drive, duplicate-separator, dot-segment, or control-character forms.
Credential and environment files, policy and skill content, `AGENTS.md`, workflows, package scripts and lockfiles, dependency settings, automation/worker infrastructure, and generated release assets remain protected even when listed in `allowedPaths`.
This includes the Action definition and its local implementation modules, `neon.ts`, `.neon`, local agent configuration, the build/release/asset-check scripts, and intake/worker tests and test runners.
Deletes, moves, mode changes, symlinks, binaries, stale blob IDs, malformed Unicode, sparse proposals, inconsistent scopes, unsupported fields, and out-of-scope changes fail closed.
Errors contain only the fixed `Patch validation failed.` message, never the submitted path or content.

## Durable worker storage

`createWorkerStore(pool)` exposes `claimTick`, `checkpoint`, `putIntent`, `fenceIntent`, `confirmIntent`, `reserveModelCall`, `recordModelCallOutcome`, `reserveRepairCycle`, `finishRun`, and `getRun`.
See [publication recovery](agent-worker-recovery.md) for durable mutation fences, typed confirmation, and uncertain-write handling.
Coordinator journals additionally expose `getCoordinatorSnapshot` and `beginRepair`, plus closed phase/intent extensions, after migration 003.
Legacy databases retain their existing API; no method applies a migration or enables the worker automatically.
The [coordinator contract](agent-worker-coordinator.md) defines one-phase tick composition and its remaining production gates.
Use [journal database checks](agent-worker-journal-db.md) for actual migration-003 and restricted-grant evidence.
The closed manifest projection contains `repositoryId`, `repositoryFullName`, `issueId`, `issueNumber`, `actorId`, `manifestHash`, `baseRevision`, `policyRevision`, and `limits`.
It contains no issue text or acceptance criteria, and it does not grant approval authority.

`limits` contains the exact 15 integer fields from the approval contract, with the same ceilings and cross-field checks. The lease defaults to 180 seconds, must outlast the 90-second tick, and expired-lease recovery is capped at two. Lower configured values remain valid when they satisfy the approval bounds.

`claimTick` returns `idle`, `busy`, or `claimed` with a lease bound to the admitted repository name, repository ID, issue ID and number, and approving actor ID.
A claimed result also supplies `deadline`; pass it unchanged to recovery's `perform({ lease, deadline, intent, publication })`.
The lease carries run/job IDs, a generation, a random token, and a database-computed expiry. Claims use database time, deduplicate successful invocation IDs durably, and never lock or modify intake rows. A terminal run remains stored and the store never selects another queued issue automatically.

`checkpoint` accepts only a known nonterminal phase and typed head, branch, pull-request, check, review, or fixed blocker references.
A branch reference must equal `agent-work/<this run UUID>`; application and database constraints reject another run's branch. A checkpoint releases the tick lease without consuming an expired-lease recovery. Expired claims advance the fence and recovery counter; after the approved recovery limit, the run becomes `needs_attention` with `lease_recovery_limit`. Terminal states are `ready_for_human`, `needs_attention`, and `cancelled`.

`putIntent` accepts only `{ key, kind, inputHash, expectedHeadSha }` with `kind` set to `model_call`, `branch_create`, `commit_create`, or `pr_create`.
Keys are opaque lowercase SHA-256 identifiers generated from fixed orchestration context, never task/model text or free-form labels; raw content-shaped keys are rejected before database access.
Input hashes are lowercase SHA-256 values, and GitHub publication intents require a lowercase SHA-1 expected head.
New branch-create intents bind the approved base revision; new commit/PR intents bind the recorded run head, falling back to the approved base before a head is recorded.
Unknown or stale new publication heads conflict without persisting an operation.
An identical key, kind, input hash, and expected head returns the same operation ID; changed intent data conflicts without overwriting the original.
An existing historical intent may be returned after the run head changes for reconciliation only, not as authority for another write.
The publisher must still verify actual remote identity/head, current approval, and lease before effects.
`putIntent` keeps its four effect kinds and does not grant model-call permission; reservations use the separate budget API.

`reserveModelCall(lease, { key, inputHash, expectedHeadSha, inputTokens, outputTokens })` accepts only an opaque SHA-256 key, SHA-256 input hash, nullable known head, and positive token upper bounds. One fenced transaction writes the model intent, reserves the call slot and tokens, and records a database-time deadline. It clamps output to the per-call and remaining run limits without shortening input. A fresh committed reservation returns `status: 'reserved'` and `canExecute: true`; an identical replay returns `status: 'existing'` and `canExecute: false`; changed data conflicts. `getRun` exposes `modelCallCount`, `reservedInputTokens`, `reservedOutputTokens`, and `repairCycleCount`. They count reservations, not confirmed provider charges.

`recordModelCallOutcome(lease, { operationId, outcome, actualInputTokens?, actualOutputTokens? })` accepts only normalized outcome codes: `success`, `usage_unreported`, `uncertain`, `spend_limit`, `payment_failure`, `restricted_model`, `provider_failure`, `deadline`, and `unknown_contract`. Invalid or excess usage normalizes to `invalid_usage` or `excess_usage`. Valid actual token counts are stored only when reported as nonnegative safe integers. Missing or invalid counts never become invented zeroes. Unreported usage, uncertainty, provider failures, limits, and deadlines retain all reserved tokens and stop the run at `needs_attention`. The API stores no provider message or response and does not retry or switch providers.

`reserveRepairCycle(lease, { key, source, headSha })` accepts only an opaque SHA-256 key, source `ci` or `qodo`, and the currently known SHA-1 head. One shared `repairCycleCount` allows at most two reservations. A fresh committed reservation returns `canRepair: true`; a repeated key returns `canRepair: false` without charging again. A third distinct repair records a fixed stop and retains existing branch/PR references. Repair records use typed append-only events, not a fifth `putIntent` effect kind.

The additive `agent_worker.runs`, `operations`, and append-only `events` tables store typed IDs, hashes, counters, references, states, normalized outcomes, and timestamps. The only JSON column is `runs.limits`, which accepts the closed numeric profile and validates its fields and bounds in both application code and PostgreSQL. Unique constraints retain one run per job and manifest, while a partial unique index permits only one nonterminal run. No opaque checkpoint, arbitrary metadata, payload, raw error, prompt, transcript, issue text, or credential is stored.

Strict profiles allow one reserved model call per tick and 20 per run, with up to 8,000 input and 2,000 output tokens per call and 100,000 input and 20,000 output tokens per run.
The explicitly approved Sol MVP instead bounds rendered input to 60 KiB and reserves UTF-8 bytes plus 4,096, up to 65,536 per call, under the same 100,000 input run reservation; this is not an exact tokenizer or pre-call token guarantee. Ticks last at most 90 seconds, each model call at most 45 seconds, the run at most two hours, and expired leases recover at most twice. CI and Qodo share the two-repair limit. Lower approved values apply when the run manifest sets stricter caps. Token reservations do not guarantee an exact dollar cost; activation still requires a separate provider spend ceiling.

Each transaction is short, parameterized, and bounded by lock and statement timeouts; no lock spans model or network work. Errors use a fixed safe message without a raw database cause. The runtime role needs `SELECT` on intake jobs, `SELECT`/`INSERT`/`UPDATE` on worker runs and operations, and only `SELECT`/`INSERT` on events. It receives no intake write, worker delete/truncate, schema-creation, ownership, or administration privileges. Rollback disables the worker and retains rows for investigation rather than deleting them. The coordinator must still recheck current approval before any external effect. These APIs account for reservations only; a later provider adapter owns actual model requests.
