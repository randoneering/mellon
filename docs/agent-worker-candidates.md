# Immutable inputs and candidate selection

These adapters read repository facts and parse proposed changes without executing them.
They do not admit an issue, authorize a model call, or grant publication permission.
The coordinator must still obtain fresh approval, authenticated findings, and a durable operation reservation.

## Repository reader

`createRepositoryReader(config)` exports these methods:

| Method | Result |
| --- | --- |
| `readIssue({manifest, deadline, signal})` | `{title, body}`, retaining a nullable body |
| `readPreparedFiles({revision, allowedPaths, deadline, signal})` | Ordered array of prepared file entries |
| `readTrustedFile({revision, path, deadline, signal})` | Verified source text |
| `reconstructCandidate({publication, metadata, deadline, signal})` | `{publication, changes, observedHeadSha, operationHash, intent, metadata}` |

Required configuration: `token`, `repository: 'randoneering/mellon'`, numeric `repositoryId`, immutable `policyRevision`, and `trustedPaths: [{path, sha256}]`.
Populate `trustedPaths[].sha256` from the reviewed policy manifest's source descriptor `hash`; the reader restricts paths to the existing policy/skill/AGENTS set.
`loadPolicy` independently checks its existing source pins.
`readTrustedFile` returns a string, so the existing policy loader binds it with `path => reader.readTrustedFile({revision: policyRevision, path, deadline, signal})`.
Candidate-head guidance never enters that binding.

Inject `fetch` for tests.
Defaults: 5 seconds per public operation, 4 MiB per response, 8 MiB total response bytes.
`timeoutMs` may be at most 20 seconds; `responseLimit` at most 4 MiB; `aggregateLimit` at most 16 MiB.
The absolute millisecond `deadline` is mandatory and further reduces the operation budget.
Every request and stream read races that budget and the optional abort signal, even if injected transport ignores cancellation.
Requests refuse redirects, request identity encoding, and use fixed GitHub resources.
No issue URL, workflow link, blob URL, or model URL chooses an endpoint.
Errors expose only `Repository read rejected.`

Prepared entries use the existing agent shape:

- Regular file: `{path, mode:'100644', blobSha, text, sha256}`.
- Directory or absent entry: `{path, mode:'040000'|null, blobSha:null}`.
- Ancestors and absent targets remain in the returned array, capped at the agent's 128-entry capacity.
- Blob SHA-1 includes the Git blob header; SHA-256 covers the exact UTF-8 text, including a byte-order mark.
- Files are limited to 64 KiB each and 256 KiB together.
- Symlinks, executable targets, submodules, invalid UTF-8, binary controls, incomplete trees, and malformed blobs stop the read.

Issue hashing uses `JSON.stringify([title, body])`, matching approval exactly, including `null`.
The reader snapshots caller inputs before asynchronous work and checks the configured repository ID on every public operation.
The coordinator selects the immutable revision from its trusted run state.

## Workflow discovery

`createWorkflowDiscovery(config).discoverWorkflowRuns({manifest, headSha, branch, deadline, signal})` uses the same transport configuration.
`pageLimit` defaults to 10 and cannot exceed 10.

Results are one of:

- `{status:'discovered', runs:[{workflowId, headSha, branch, runId, runAttempt:1}]}`.
- `{status:'waiting', reason:'workflow_runs_pending'}`.
- `{status:'needs_attention', reason:'workflow_discovery_rejected'}`.

Pass the returned array directly as `createCheckReader(...).readChecks({manifest, runs, expectedRegression})` or to its failure-read counterpart.
Discovery verifies both repository identities, push event, workflow ID/path, branch, head, complete counts, and unique run IDs.
Multiple matching runs or any rerun stop selection.
It never chooses the newest run or follows a pagination URL from a response.
The check reader remains responsible for workflow source, jobs, App identity, and authenticated reports.

## Candidate preparation

Approval accepts an optional closed `coordinator` block with `version:1` and `regression`.
The regression fields are `workflowId`, `testPathIndex`, `initial:{criterionIndex,testName}`, and exactly two `repairTestNames`.
It requires an approved unprotected `.test.mjs` path, the approved native `test` check and mandatory reporter, valid zero-based indexes, and three distinct control-free names of 1..500 characters.
The existing external manifest hash covers this block.
Foundation manifests without it still pass approval; candidate preparation requires it.

`prepareCandidate({publicationRun, phase, approvedManifest, modelOperationId, changes, baseFiles, assessment})` is synchronous.
It returns `{publication, changes, intent, metadata, expectedRegression}`.
Failures throw `Candidate validation rejected.`

Bindings:

- `publicationRun` is the exact existing publisher `run` shape: `id`, repository/issue/approver IDs, `manifestSha256`, `baseSha`, `expectedHeadSha`, and `generation`.
- `baseFiles` is the complete, ordered result of `readPreparedFiles` used as `context.files` by the agent.
  Preserve that order throughout investigation and selection.
  Preparation independently requires coverage of every approved path, valid complete ancestor/absent metadata, and no out-of-scope regular files.
  Every regular file must contain text plus matching Git blob and content SHA-256 hashes; missing fields, invalid UTF-8/controls, extra fields, and excess aggregate content reject the candidate.
- `changes` uses the existing agent proposal shape, before `validateChanges` adds accepted-change fields.
- `modelOperationId` comes from the successful same-run durable model reservation, never model output.
  The pure preparer checks its type; the journal enforces ownership and outcome.
- `phase` accepts the journal's checkpoint phase or snapshot phase.
  Snapshot timestamps are not identity inputs; a non-null pending operation blocks new preparation.
- Initial tests use the pinned initial criterion/name.
  Repair tests use the reserved cycle's pinned name.
- Implementation phases require `phase.expectedRegression` and cannot change the selected regression path.
  Repair implementation also requires the journal's approved `criterionSha256`.

For repair tests only, add the existing trusted agent `context.investigation` as transient `phase.investigation`.
Do not pass that extension back to the journal checkpoint validator.
Its fields are `version`, `findingSha256`, `headSha`, `criteria`, `references`, and `regressionFileIndex`.
The assessment is the agent's unchanged structured assessment.
Only `confirmed` passes this gate.
The finding/head, exact approved criterion hash, and every assessment reference must match the trusted investigation and verified files.
This structural association remains fallible; model confirmation does not authenticate a finding.

`fileIndex` and `regressionFileIndex` index **all prepared entries**, including ancestor and absent metadata.
They never index `allowedPaths`.
Each reference has `{fileIndex, blobSha, testIdentitySha256}` with an explicitly nullable test hash.
Descriptor creation separately maps each validated change's path through `approvedManifest.allowedPaths.indexOf(path)`.
Do not substitute one index space for the other.

The accepted selection subset is deliberately small:

- One default `test` import or unaliased named `{test}` import from `node:test`.
- Top-level direct `test('literal name', callback)` registrations only; parenthesized callees or registrations are unsupported rather than assigned guessed native locations.
- Exactly one selected pinned literal name and no duplicate literal names.
- Block-bodied arrow/function callbacks with plain identifier parameters; no options, skip/todo calls, aliases, nested binding uses, dynamic import, eval, require, or unsupported syntax.
- Callback context may use direct noncomputed ordinary members such as `t.assert` or `t.signal`.
  Context skip/todo/subtest/selection operations, destructuring, computed access, escaping aliases, and arguments/caller/callee reflection are unsupported.

Acorn 8.19.0 parses with module mode, ECMAScript 2024 syntax, and source locations.
It never imports or executes candidate code.
The identity hashes canonical `{column, entryFile, line, name, nesting:0, type:'test'}` using one-based locations.
Two hardcoded trusted Node24 fixtures exercise the actual native reporter and match these hashes.
This subset does not prove test semantics or production safety.

`publication` is accepted by `snapshotPublicationRequest`; `intent` is accepted by `validateIntent`.
`metadata` is exactly `intent.coordinator`:

```js
{
  version: 1, purpose, phaseKey, repairCycle, modelOperationId,
  expectedRegression, criterionSha256, candidateDescriptors,
}
```

Descriptors contain `approvedPathIndex`, `operation`, `beforeBlobSha`, `afterBlobSha`, `contentSha256`, `bytes`, and `mode:'100644'`.
The journal stores those typed fields, not paths, patches, issue text, or assessments.
The real patch validator enforces the approved scope and the 10-file/64-KiB/256-KiB ceilings.
Criterion hashing uses exact UTF-8 bytes without normalization.
`expectedRegression.proposalSha256` is the publisher's validated operation hash for a test proposal, not a model marker.
Implementation retains the accepted test proposal association.
Intent keys bind phase, model-operation reference, and operation hash; lease-generation changes do not rekey them.

## Reconstruction and remaining gates

Pass the original `{run, intent:{id}, approvedManifest}` publication envelope and the pending operation's `coordinator` metadata to `reconstructCandidate`.
Configure `ownedActor:{databaseId, login}` from trusted publication configuration.
The reader requires an observed branch candidate, GitHub-signed owned proof, its exact expected parent, owned ancestry back to the pinned base, matching REST/proof trees and parents, descriptor-exact blobs, and no extra tree changes.
The ancestry ceiling is six owned commits including the observed candidate.
It recomputes the original operation hash and stable intent key before returning transient publication data.
No observed candidate means a stop, not permission to manufacture or replay a write.
Feed successful reconstruction into existing same-intent recovery, not a fresh execution path.

These tests use controlled no-network transport and trusted local native fixtures.
Live GitHub ingress, signing, model calls, Qodo evidence, database recovery, and end-to-end coordinator publication remain separate acceptance gates.
No automatic manifest creation or issue admission is added here.
