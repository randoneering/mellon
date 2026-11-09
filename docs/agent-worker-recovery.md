# Worker publication recovery

`src/automation/worker/recovery.mjs` adapts the durable worker store to the fixed publication adapter.
It does not call a model or accept caller-provided remote proofs.
It delegates branch/commit publication and draft-PR reconciliation to the fixed publisher.

## Contract

Create a coordinator with `{ store, publicationDependencies, timeoutMs? }`, then call `perform({ lease, deadline, intent, publication })`.
Carry `lease` and the numeric epoch-millisecond `deadline` directly from the successful `claimTick` result.
The store computes this deadline from the database tick start, run start, configured limits, and lease expiry.
Do not reconstruct it from invocation time or reuse a fresh deadline with an old lease.
Missing, invalid, or expired deadlines stop before any database read or write.
`publication` uses the fixed publisher request contract.
The intent uses `{ key, kind, inputHash, expectedHeadSha }`.
Its key matches `publication.intent.id`; its input hash matches the publisher's operation hash.
The lease, stored approval revisions, publication identity, and expected parent must agree.

- `putIntent` commits before publication starts.
- A new `commit_create` intent permits the fixed adapter's combined branch and commit operation.
- A `pr_create` intent uses `ensureDraftPr`, with its exact run-bound draft identity and current initial checks.
- An existing commit intent uses only `probePublication`; an existing PR intent forces every fence to `reconcile_only`.
- Neither path repeats an uncertain mutation when the remote effect appears absent.
- `fenceIntent` checks current database ownership, tick/run deadlines, unresolved model calls, and typed intent identity.
- Each branch/commit/PR phase gets at most one durable execution decision.
- `confirmIntent` atomically records the verified reference and updates the run's branch and head.
- Legacy commits enter `waiting_ci`; coordinator test commits enter `waiting_red_ci`, implementations enter `waiting_ci`, and draft PRs retain the PR number and enter `waiting_review`.
- Reconfirming the same effect preserves later checkpoints.

The publisher refreshes approval immediately before each mutation and then requests its database fence.
Commit probing verifies the exact repository, branch, parent, complete changed tree, App actor, and GitHub signature.
PR reconciliation verifies one open draft with the expected repository, branch, base, head, App actor, run marker, title, and body.
A duplicate or foreign candidate stops recovery.
Local leases cannot revoke an HTTP request already sent to GitHub.
Deterministic branch identity, expected-head comparison, and read-only reconciliation protect that uncertainty window.

## Bounded waits

- Recovery defaults to a 90,000ms aggregate bound; `timeoutMs` accepts integers from 1 through 90,000.
- Recovery uses the earliest invocation bound, claimed deadline, validated lease expiry, and deadlines returned by `getRun`.
- Every recovery store await receives the remaining absolute deadline, including the first read, reservation, fences, confirmation, and terminal writes.
- The fixed publisher keeps its 20,000ms default and 30,000ms maximum, clamped to recovery's remaining time.
- Store operations default to 5,000ms total, including acquisition, BEGIN, configuration, body, COMMIT, and rollback.
  `createWorkerStore(pool, { timeoutMs })` accepts integers from 1 through 5,000.
- Each store method accepts an optional final `{ deadline }` argument; `finishRun` takes this as its fourth argument after terminal options.
  Tick callers must pass the claimed deadline rather than starting a new per-call tick budget.
  Lease-bearing operations also clamp to validated lease expiry.
- `getRun` acquires its own bounded client; it never relies on `pool.query` to bound a queued acquisition.
- Startup configures a lock timeout of at most 2,000ms and a statement timeout of at most 10,000ms, each capped by remaining operation time.
  JavaScript bounds BEGIN and configuration before the transaction body can start.
- Publication fences, confirmation, and terminal writes retain database-authoritative lease checks; confirmation and terminal writes also reject expired tick/run deadlines.

The pool contract requires `connect()` to return a query-capable client with `release(error)` semantics matching `pg.Pool`.
On a nonempty error, release must synchronously remove the connection from reuse and initiate destruction, even when SQL remains active.
Wrappers must preserve this behavior; their optional cleanup promises are observed but do not extend the deadline.
The store does not inspect or invent `pool.options`, and injected wrappers need no `query()` method on the pool itself.
A native `connectionTimeoutMillis` remains useful for driver resource cleanup, but correctness does not rely on it.
A queued acquisition may remain inside the driver after local expiry; when it resolves, the store destroys the late client exactly once without starting SQL.

Database expiry returns the fixed storage error and recovery reports `recovery_database_uncertain` with `persisted: false`.
Recovery issues no follow-up terminal write after database uncertainty.
Other aggregate expiry reports `recovery_deadline` without a terminal write.
Late results cannot resume coordinator publication or start confirmation; started promises retain rejection observers.
An expired active transaction is destroyed instead of being returned for reuse or receiving a late rollback/COMMIT.
An uncertain BEGIN also destroys the connection.
Ordinary rollback remains bounded; uncertain COMMIT always discards the connection, even after a successful rollback, and requires reconciliation of the original durable identity.

These bounds stop local continuations, not SQL or HTTP already accepted remotely.
An issued statement, COMMIT, or request can complete after the local deadline, and a destroyed backend may remain visible until PostgreSQL notices the disconnect.
A custom store or callback that ignores its deadline can still finish work it already started; it must not hide additional unbounded work behind these interfaces.
Recovery never interprets timeout or socket destruction as proof that the remote effect did not occur.
No transaction stays open around publication network calls.

## Migration

Apply `migrations/agent-worker/002-recovery.sql` after `001-initial.sql` through the existing reviewed migration process.
It adds fixed effect columns and unique branch/PR identities per run and commit identity per parent.
It widens the run blocker constraint while preserving every existing budget category.
No raw payload, proof object, credentials, or exception text enters these columns.
Existing conflicting intent identities make migration fail rather than silently choosing an execution slot.

## Typed coordinator journal

`003-coordinator.sql` follows `002-recovery.sql`.
Its nullable version marker keeps existing rows and the legacy APIs valid, including databases that have only migrations 001 and 002.
Coordinator methods require migration 003; there is no automatic migration or activation.
All new methods use the same 5,000ms total database bound and final optional `{ deadline: number }` argument.
Keep passing the original claimed deadline.

### Snapshot

`getCoordinatorSnapshot(lease, waitOptions?)` returns either `{ status: 'stale' }` or:

```ts
{
  status: 'owned';
  run: WorkerRun; // Existing getRun projection, including original deadlines.
  phase: Phase | null;
  modelOperation: (StoredOperation & { outcome: ModelOutcome | null }) | null;
  pendingOperation: StoredOperation | null;
}
```

An uninitialized legacy run has three null journal fields.
`StoredOperation` contains `operationId: UUID`, `key: SHA256`, `kind`, `inputHash: SHA256`, `expectedHeadSha: SHA1 | null`, and optional `coordinator: IntentCoordinator`.
`ModelOutcome` uses the existing closed operation outcomes, including `success`, `uncertain`, and `deadline`.
Snapshots expose no token reservations, driver details, or fresh execution permission.
The model operation's coordinator projection has no candidate descriptors and is read-only; do not submit it as a publication intent.

```ts
type Purpose = 'initial_tests' | 'initial_implementation'
  | 'repair_investigation' | 'repair_tests' | 'repair_implementation' | 'draft_pr';
type ExpectedRegression = {
  workflowId: number; testIdentitySha256: SHA256; proposalSha256: SHA256;
};
type Phase = {
  version: 1; purpose: Purpose; key: SHA256; repairCycle: 0 | 1 | 2;
  headSha: SHA1; startedAt: ISODate; waitStartedAt: ISODate | null;
  pendingOperationId: UUID | null; expectedRegression: ExpectedRegression | null;
  criterionSha256: SHA256 | null; findingSha256: SHA256 | null;
  findingSource: 'ci' | 'qodo' | null; findingHeadSha: SHA1 | null;
  priorCheckRunId: number | null; priorReviewId: number | null;
};
```

SHA1 and SHA256 mean lowercase hex strings of exactly 40 and 64 characters.
IDs and byte/index counts must be safe integers; evidence IDs must be positive.
Timestamps use UTC ISO strings.
The phase key hashes canonical sorted JSON of `{version:1,runId,manifestSha256,purpose,repairCycle,headSha,findingSha256}` using exact strings.
`buildCoordinatorPhaseKey` in `store-validation.mjs` provides that calculation.
Generation and delivery IDs do not participate.

### Checkpoint

`checkpoint(lease, change, waitOptions?)` still returns a boolean receipt and supports its existing typed update fields.
The optional closed `change.coordinator` requires `version`, `purpose`, `key`, `repairCycle`, `headSha`, and `findingSha256`.
It optionally accepts `expectedRegression`, `criterionSha256`, `findingSource`, `findingHeadSha`, `priorCheckRunId`, and `priorReviewId`.
No caller supplies phase/wait timestamps or pending references.

Initialize only a claimed run with `initial_tests` at round zero.
Confirmed RED permits the corresponding implementation phase; confirmed implementation permits `draft_pr`.
Repair investigation permits `repair_tests` after the reserved round is installed.
A checkpoint cannot manufacture an initial wait or leave a pending effect.
After green repair CI, an existing draft may enter a new `draft_pr`/`waiting_review` phase without creating another PR intent.
Selected regression/criterion and finding references remain unchanged through checkpoints; publication intents select new regression hashes, and `beginRepair` installs new findings.
Prior evidence IDs may advance at a phase transition but cannot change during same-phase polling.
Legacy-shaped checkpoints and intents cannot bypass an initialized coordinator journal.

Checkpoint the same wait with its original phase key and parent head, even after confirmation advances `run.expectedHeadSha` to the published child.
This retains both `startedAt` and `waitStartedAt` and releases the lease.
New phases reset the wait start.
Effect confirmation authors a non-null wait start; the existing-draft re-review transition also authors one for its new phase/head.
The caller checks the configured CI/review wait limit against that durable timestamp and stops for humans when it expires.

### Head-bound check and review references

Coordinator progress may include this closed transient `evidence` object:

```ts
{
  headSha: SHA1; workflowId: number; workflowRunId: number;
  checkRunId: number; checksSha256: SHA256; reviewId: number | null;
}
```

IDs are positive safe integers.
The digest binds the complete safe check/run result metadata; it is not a report body or independent authentication proof.
CI evidence uses `reviewId: null`; verified review evidence includes its positive review ID.

- `checkpoint` accepts `change.evidence` alongside matching `lastCheckRunId` and coordinator `priorCheckRunId`.
  A positive review ID also requires matching `reviewHeadSha` and coordinator `priorReviewId`.
  The phase transition, references, and lease release share one UPDATE.
- `beginRepair` accepts optional `request.evidence`, bound to `request.headSha` and source.
  Reservation and references commit together; repair-limit stops retain the supplied causal references too.
  Existing primitive requests without evidence remain valid, while the coordinator supplies evidence on its actual forward decisions.
- `finishRun(lease, 'ready_for_human', {evidence}, waitOptions)` requires a positive review ID for coordinator readiness.
  One UPDATE writes terminal state, clears the lease, and stores the head-bound check/workflow/review references.
  It never checkpoints first and then attempts to finish with a released lease.
  Legacy unversioned readiness retains its old contract.
- `getRun` and snapshot runs expose optional `checkEvidence` with the same six fields.
  Its head identifies the checked revision even if later publication advances the run head.
  A review ID appears only when the stored review head matches the evidence head.

Migration 003 adds only typed nullable check-head, workflow/workflow-run ID, and digest columns for these references.
Constraints reject partial evidence and coordinator readiness without matching current-head check/review references.
Phase, repair, and readiness writes also check the durable wait limit against database time.
The coordinator independently rechecks that limit after asynchronous reads and before dispatching progress.
Already-issued SQL can still complete after local timeout; none of this proves cancellation.
No raw reports, assessments, source text, or arbitrary JSON enter these columns, and no new table privilege is required.

### Publication intent

The existing four intent fields remain unchanged.
A coordinator publication intent adds this closed object:

```ts
type IntentCoordinator = {
  version: 1; purpose: Purpose; phaseKey: SHA256; repairCycle: 0 | 1 | 2;
  modelOperationId: UUID | null;
  expectedRegression: ExpectedRegression | null;
  criterionSha256: SHA256 | null;
  candidateDescriptors: Array<{
    approvedPathIndex: number; operation: 'create' | 'modify';
    beforeBlobSha: SHA1 | null; afterBlobSha: SHA1;
    contentSha256: SHA256; bytes: number; mode: '100644';
  }>;
};
```

Commit intents require 1 through 10 unique path indexes, at most 65,536 bytes per file and 262,144 bytes total.
Create descriptors require a null before-blob; modify descriptors require a before-blob SHA.
Draft intents require `purpose: 'draft_pr'`, a null model reference, and an empty descriptor array.
Test purposes require regression and criterion hashes, with `proposalSha256 === intent.inputHash`.
Implementation and draft intents preserve the previously selected regression and criterion.
The candidate adapter must also check indexes against the pinned manifest and recompute blob/content identities; the journal does not read paths or content.

`putIntent` returns the existing `{status:'created'|'existing',operation}`, `{status:'conflict',operation?}`, or `{status:'stale'}` shapes.
Coordinator operations include their normalized coordinator object.
When resubmitting a snapshot operation, pass only `key`, `kind`, `inputHash`, `expectedHeadSha`, and `coordinator`; `operationId` is read-only.
Intent purpose, model reference, descriptors, and pending reference commit together.
The model reference must identify a successful reservation in the same run, phase, purpose, round, and parent.
Changing a stored purpose, parent, model binding, or descriptor set conflicts instead of opening another effect slot.
Confirmation uses persisted purpose even when its caller supplies the legacy four-field identity.
It clears the pending reference and sets the wait start atomically with the verified effect reference and run head.
Reconfirmation does not reset the wait or a later phase.

Recovery still takes `perform({lease,deadline,intent,publication})`.
Coordinator intents require `store.getCoordinatorSnapshot` and a matching current phase/model/pending identity before reservation.
No journal fields enter the fixed publisher request.
Existing effects remain reconciliation-only; durable metadata never grants a second execute decision.

### Repair and restart

`beginRepair(lease, {key:SHA256,source:'ci'|'qodo',headSha:SHA1,findingSha256:SHA256}, waitOptions?)` returns:

- `{status:'reserved',canRepair:true,repairCycleCount:1|2,phaseKey:SHA256}`.
- `{status:'existing'|'conflict'|'stale',canRepair:false}`.
- `{status:'needs_attention',canRepair:false,blockerCode:'repair_cycle_limit'}`.

It accepts CI findings from `waiting_ci` and Qodo findings from `waiting_review` at the current head.
One transaction increments the existing shared counter, installs `repair_investigation`, records the finding identity, and releases the lease.
The same key/finding replay returns `existing` without another reservation; changing a key for the same source/head/finding conflicts.
Both sources share the configured limit, never more than two.
Coordinator runs use this API instead of legacy `reserveRepairCycle`.
Transition investigation to `repair_tests` before reserving the investigated regression request, so its model operation and candidate share a phase.
Do not reserve a separate investigation model call and then try to attach its result to a different tests phase.
If a recorded investigation result already exists without a candidate, the transition persists a fixed human stop and returns `false` rather than opening a fresh model opportunity.

`reserveModelCall` returns `{status:'blocked',canExecute:false,blockerCode:'coordinator_pending_effect'}` while a pending effect exists.
Recover that exact effect before requesting another model.
A previous model reservation in the current phase without a pending candidate stops for humans: `coordinator_candidate_lost` for recorded success, otherwise `coordinator_model_uncertain`.
These stops return the existing `needs_attention` model-reservation shape with `canExecute:false`; they never replay a request.
A snapshot with successful model output but no pending operation is not enough to reconstruct a patch.
The other fixed journal stops are `coordinator_journal_conflict` and `coordinator_wait_expired`.

### Migration invariants and activation plan

Migration 003 adds typed nullable columns, a purpose enum, immutable candidate descriptors, and same-run/phase/parent foreign keys.
Unique indexes bind one model reservation and one publication intent per phase and one repair event per source/head/finding.
A deferred constraint validates the complete descriptor count, file limits, aggregate bytes, and successful model binding at COMMIT.
Immutable operation identity and descriptor triggers reject rewriting or extending a stored candidate set.
Legacy rows do not query the new child table from the validation trigger.
No existing table is deleted, and the migration contains no role grants.

Keep the existing grants for runs, operations, and events unchanged.
For future activation only, the restricted worker role also needs `SELECT, INSERT` on `agent_worker.candidate_descriptors` after owner-applied migration 003.
Do not grant UPDATE/DELETE on that table, broaden the intake role, or enable the schedule as part of journal setup.
The parent owns the reviewed new DB suite, its runner registration, grants, and explicit skip-identity review.
The frozen legacy suite still applies only migrations 001/002; its 130 actual DB cases do not establish migration 003 behavior.
New migration execution, constraints, and runtime grants remain unverified until that separate suite runs.

## Stops and remaining scope

Recovery uses fixed `recovery_*` categories for invalid input, conflicts, approval denial, lease loss, deadlines, unconfirmed effects, unsupported effects, and uncertain database acknowledgments.
An unresolved model reservation retains `model_outcome_uncertain`.
A result with `persisted: false` does not claim a durable terminal transition.
Database uncertainty causes no follow-up write; a stale owner cannot terminalize its successor.
Maintainers must inspect and reconcile before any explicit recovery decision.

Standalone `branch_create` and `model_call` requests fail closed without remote requests.
The publisher combines branch creation with commit publication.
Model calls keep their existing budget reservation/outcome APIs.
A live queue-to-draft-PR run remains unverified and outside this adapter.

## Verification

- `node --test tests/unit/agent-worker-journal*.test.mjs` exercises the real validators, store, and recovery against scripted SQL and mocked GitHub transport; it does not execute the new migration.
- `node --test tests/unit/agent-worker-recovery.test.mjs tests/unit/agent-worker-store.test.mjs tests/unit/agent-worker-budgets.test.mjs tests/unit/agent-worker-publisher.test.mjs` exercises injected faults with the real publisher and mocked GitHub responses.
- `npm run test:worker:db` creates a disposable loopback Postgres container, verifies its runner marker, and runs actual store transactions under the restricted runtime role.
- Unit fault injections cover stalled acquisition, late connection fulfillment/rejection, ignored query cancellation, hung BEGIN/configuration/body/COMMIT/rollback, aggregate recovery deadlines, and late branch/commit/PR/probe fences.
- Database cases use actual queued `pg.Pool` acquisition without driver connection timeouts, server-side `pg_sleep` during BEGIN/configuration and after COMMIT, row-lock waits, and authoritative tick/run expiry.
  They check late client destruction, backend removal, no late transaction-body continuation, retained intent/invocation identity, and no expired confirmation or terminal writes.
- Existing database cases inject faults before and after COMMIT for claims, commit/PR intents, mutation/probe fences, and confirmation; they also exercise stale owners, duplicate identities, unresolved calls, and unchanged budget acceptance.
- GitHub responses remain mocked in database tests; these checks do not establish live GitHub, provider, signing, or deployment behavior.
