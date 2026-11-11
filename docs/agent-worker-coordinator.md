# Bounded worker coordinator

`src/automation/worker/coordinator.mjs` exports `createCoordinator(privateDependencies)`.
The returned frozen object exposes only `advanceTick(delivery)`.
Call it only from the configured Function entry after native provenance, activation, role, and kill-switch checks.
This module does not authenticate an HTTP request or enable a schedule.

## Constructor

| Dependency | Contract |
| --- | --- |
| `store` | Existing worker store with `claimTick`, `getCoordinatorSnapshot`, `checkpoint`, `reserveModelCall`, `recordModelCallOutcome`, `beginRepair`, and `finishRun` |
| `manifest` | Approved immutable approval manifest, including the required `coordinator` regression configuration and V2 workflow source graph |
| `expectedManifestSha256` | External reviewed SHA-256 pin of canonical sorted manifest JSON |
| `policyManifest` | Existing policy loader configuration: `enabled:true`, matching `pilot`, and pinned `trustedSources` |
| `triggerId` | Configured native `issueworkertick` trigger ID |
| `readToken` | Explicit private read credential; never supplied by a delivery |
| `fetch?` | Controlled read transport; defaults to `globalThis.fetch` |
| `ownedActor` | Trusted publication actor `{databaseId,login}` for the default immutable repository reader |
| `model` | Existing Agent options: `config`, verified `tokenizer`, and optional injected `sdk` transport |
| `publicationDependencies` | Existing publication transport/context callbacks, including `getPublicationContext` and `getPullRequestContext` with the App issuance record for draft creation |
| `timeoutMs?` | Aggregate tick bound, 1..90,000ms; defaults to 90,000ms |
| `adapters?` | Private server-side test/composition seams described below |

The default recovery also requires store `getRun`, `putIntent`, `fenceIntent`, and `confirmIntent`.
The model ID must match the pinned manifest.
The constructor snapshots and freezes the approval manifest, policy manifest, and model configuration.
It binds claims to that one issue, repository, actor, manifest hash, base, policy revision, and limits.
It provides no default pilot, second-job admission, or terminal requeue.

Defaults use `checkApproval`, `loadPolicy`, `createRepositoryReader`, `createWorkflowDiscovery`, `createCheckReader`, `createReviewReader`, `createAgentWorker`, and `createRecoveryCoordinator`.
Repository guidance reads use the pinned `policyRevision`, while prepared candidate files use the current phase head.
Publication retains the original base revision and the current expected parent.

The optional private test `adapters` fields are `repository`, `discovery`, `checks`, `review`, `reviewRequestPublisher`, `checkApproval`, `loadPolicy`, `createAgentWorker`, and `createRecoveryCoordinator`.
Production composition uses the trusted publisher and lease-bound store; submitted text cannot supply adapters.
Object adapters retain their existing documented method signatures.
Factory overrides receive the same options as their real counterparts.
These are trusted code seams, not capabilities accepted from a request, issue, model result, or database payload.
The coordinator replaces publication approval/check callbacks with fresh real authority and current-head check reads; recovery supplies its durable fence callback.

## Delivery and result

Only the closed Function delivery shape is accepted:

```js
{
  invocationId,
  type: 'schedule',
  trigger: { type: 'schedule', id: configuredTriggerId, name: 'issueworkertick' },
  data: { scheduledAt: isoTimestamp },
}
```

No delivery field carries adapters, credentials, manifests, findings, patches, or publication proofs.
`advanceTick` resolves to `{status, reason?, persisted}` without private text or raw errors.
Statuses are `advanced`, `idle`, `duplicate`, `waiting`, `needs_attention`, `cancelled`, and `ready_for_human`.
A store `busy` receipt maps to `duplicate`; it does not distinguish a repeated invocation from a competing claim or lock contention.
`persisted:true` means this continuation received a durable transition/checkpoint receipt.
`persisted:false` does not imply that a timed-out remote write failed.

Explicit approval withdrawal cancels only through a current-owner durable receipt.
Unavailable or uncertain authority reads stop for human attention instead of claiming withdrawal.
Fixed recovery/journal categories describe other stops.
`coordinator_investigation_human_stop` covers a structured assessment refusal or unavailable accepted assessment.
Only that additive stop category extends `store-validation.mjs` and migration 003; journal methods and constraints otherwise remain unchanged.

## One phase per tick

| Durable phase/state | Tick work |
| --- | --- |
| `claimed` | Recheck authority; initialize `initial_tests` without a model call |
| Initial/repair tests | One Agent `run({})`, static regression selection, typed intent, bounded publication |
| `waiting_red_ci` | Bounded exact native assertion read; checkpoint implementation or release the same wait |
| Initial/repair implementation | One Agent call; preserve selected regression; publish a typed candidate |
| `waiting_ci` | Read current checks; enter draft/re-review, reserve repair, or release the same wait |
| `opening_pr` | Recheck green evidence; submit one deterministic durable draft intent |
| `waiting_review` | Bounded review read; release wait, reserve repair, stop, or finish for humans |
| `repair_investigation` | Transition to `repair_tests` without reserving a model |

A pending operation takes the exclusive recovery path before any model decision.
Commit recovery reconstructs descriptor-exact immutable owned blobs, recomputes identity, and uses only the original intent.
An absent observed candidate stops for humans and never authorizes execute replay.
Pending drafts rebuild only the original typed publication envelope with its stored key/hash; no model or body rewrite runs.

Successful model output without a pending candidate in an unfinished model phase stops as `coordinator_candidate_lost`.
Other previous reservations stop as `coordinator_model_uncertain`.
A successful model operation with no pending effect in a confirmed wait is normal.
Model-operation IDs come only from the bound successful reservation callback.
Accepted-change records are validated and explicitly projected back to proposal fields before real candidate preparation.

Checkpoint inputs project only the six required phase fields and supported optional hashes/references.
They never include snapshot timestamps, pending IDs, or transient `investigation`.
After commit confirmation, the run head advances to the child while the confirmed wait retains its original parent phase head/key and database-authored wait start.
New model phases use the child head.
Every wait releases its lease without model work, polling loops, sleeps, or `waitUntil`.

## Repairs and review

CI repairs require current-head authenticated `readFailure` assertion facts.
The coordinator associates native identity hashes with literal top-level tests in immutable approved files without executing source.
Missing, ambiguous, unsupported, or out-of-scope associations stop before investigation.
`beginRepair` reserves the shared CI/Qodo budget and releases the lease before the next tick transitions to `repair_tests`.
The investigated regression and its model reservation share that tests-purpose key.
Investigation indexes refer to the entire prepared-file array, including ancestors, never `allowedPaths` indexes.
Only a confirmed structured assessment associated with approved criteria and verified source references can reach real static candidate preparation.
All canonical skill sources and references remain verified.
Initial expected-RED phases send complete TDD and verification guidance; repair phases additionally send complete debugging guidance for the unexpected finding.
No mandatory project/system rules or selected-skill content is truncated.
This keeps both initial conservative reservations within the unchanged run budget; reservations are never refunded from smaller reported usage.
A new repair test selects its criterion from those approved bindings instead of inheriting the previous test's criterion hash.
That omission applies only to transient candidate selection; checkpoints preserve prior metadata until the new typed intent installs its selection atomically.

Repairs publish reserved-name tests, require exact RED, then publish implementation and require green CI.
An existing draft re-enters review without another PR intent or body rewrite.
Legacy manifests also post no comments.
The optional `worker-command-maintainer-fallback-v1` policy dispatches one fixed worker command per confirmed owned head through the separate durable review-request journal, before waiting for proof.
It retains Qodo-finding precedence and may use authenticated exact-head maintainer approval with source-distinct evidence; see [review policy](agent-worker-review.md).
Both sources share two durable repair cycles; the third stops.

The actual review reader reads only fixed GitHub pull, review, and inline-comment REST resources.
It can associate an inline finding with its current full head, review/comment IDs, source path/line, and prepared-file blob without assigning a native CI test identity.
The coordinator passes a `null` test identity for that source-file reference and keeps the bounded escaped comment text transient; durable journal metadata stores only the finding digest and GitHub IDs.
This finding path can consume the existing shared two-repair budget but does not establish that Qodo completed.
The coordinator supplies the text in a separate closed `findingReport`, bound to the finding digest, full head, comment/review IDs, current line and full prepared-file index.
The Agent recomputes that digest and renders the report only as untrusted user-message data.
Neither the report nor its text enters trusted investigation guidance, journal metadata or returned patch results.
Existing current-head draft findings may enter repair; their presence never implies clean completion.
The opt-in [submitted-review profile](agent-worker-review.md) verifies the pinned GitHub App/bot association, exact PR/head, published lifecycle and complete supported inline-comment evidence.
It establishes a published GitHub review, not completion of every Qodo background process.
Empty body, silence, stale evidence, unsupported bodies and unrepresented change requests cannot independently authorize readiness.
Legacy user-ID-only descriptors remain finding-only.
Controlled integration tests exercise the actual submitted-review reader through current checks, readiness and source-finding repair on an owned draft.
Earlier tests also retain a **synthetic future adapter** result with closed fields:
`status:'complete'`, `authenticated:true`, `repository`, `repositoryId`, `pullNumber`, `headSha`, `draft:true`, `state:'open'`, positive `reviewId`, and `findings`.
Synthetic legacy findings use exactly `{findingSha256,assertions}` with the documented authenticated assertion-reference shape.
Actual submitted-review source findings keep their authenticated comment/path/line shape and are hashed before reserving repair.
This is a private fixture/composition contract, not a Qodo report-body parser or evidence of live provider support.
The coordinator stops on multiple/ambiguous findings rather than guessing a selection.
Only a fully bound completed result without unresolved findings plus freshly successful current checks can finish `ready_for_human`.
Forward transitions retain the primary check ID, workflow/workflow-run IDs, checked head, and a digest of the complete safe check result.
Verified reviews add their current-head review ID.
Readiness sends those references in one atomic `finishRun` evidence payload; no preceding lease-releasing checkpoint is used.
It never changes draft status, approves, dismisses, merges, closes, labels, deploys, or switches providers.

## Deadlines and uncertainty

The aggregate budget starts at tick entry and clamps to the database's claimed deadline.
Operations use lazy factories with checks before invocation and after awaited completion.
Every store call, including calls made through recovery, receives a stage `{deadline}` no later than the original `claimTick.deadline`.
Model work ends 33 seconds before the finalization deadline: five seconds fund outcome recording, 10 seconds fund fresh post-model authority, eight seconds fund publication, and 10 seconds fund finalization.
Reservation SQL ends at the earlier model-admission cutoff, leaving 10 seconds for post-reservation authority before the minimum 30-second model window.
Recovery receives the publication cutoff with the original lease, intent, and publication envelope.
The store retains its own five-second total bound and database-authoritative ownership/time checks.
No database transaction spans a network call.

Known read-only failures and deadlines before SQL dispatch permit bounded terminal finalization; they do not imply an uncertain write.
Uncertain database acknowledgment causes no compensating terminal write or later publication in that continuation.
A confirmed terminal result survives later recovery rejection or expiry.
Unrecognized recovery rejection is also treated conservatively without another write.
Late callbacks cannot resume coordinator work or use its store authority after expiry/cancellation.
CI/review wait expiry uses the durable database wait start and never resets it through polling.
The coordinator rechecks it after each awaited evidence or authority read and immediately before progress, repair reservation, or readiness dispatch.
Store phase/repair/readiness writes also enforce that wait limit against database time.

## Verification scope

Run the four new suites with:

```sh
node --test tests/unit/agent-worker-coordinator.test.mjs \
  tests/unit/agent-worker-coordinator-boundaries.test.mjs \
  tests/unit/agent-worker-coordinator-policy.test.mjs \
  tests/unit/agent-worker-coordinator-publication.test.mjs
```

These suites use a clearly labeled scripted journal, controlled GitHub-shaped responses, actual approval/policy/Agent/candidate factories, and injected SDK responses.
Additional cases execute actual repository/discovery/check/review readers, real recovery/publisher with signed-proof fixtures, lost HTTP acknowledgments, and immutable candidate reconstruction.
A scripted opening phase also exercises actual draft creation, repeated fresh check callbacks, and rejection of a missing App issuance record.
They cover one-phase progression, one call per tick, no-model waits, original deadlines, late callbacks, withdrawal, stale ownership, dedupe, lost candidates, pending draft identity, structured refusals, mixed-source repair limits, and one existing draft.
They do not execute PostgreSQL or prove migration 003, configured Function ingress, runtime role grants, live Gateway tokenization/usage, App issuance/signing, or Qodo completion.
The separate journal DB lane and configured Function/database stage remain required.
No deployment, activation, live pilot, or OpenSpec completion is claimed here.
