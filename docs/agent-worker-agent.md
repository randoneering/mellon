# Agent worker model adapter

`src/automation/worker/agent.mjs` exports `createAgentWorker(options)`.
Create one adapter for each trusted coordinator tick and call `run({})` once.
Repeated or concurrent calls on that adapter stop without another model request.
Only lease-bound durable authorization can prevent reissue across adapter instances or process restarts.

## Trusted inputs

- Supply `config.gateway.baseURL`, `config.gateway.apiKey`, and `config.modelId` explicitly.
  Sol additionally requires `config.reasoningEffort: 'high'`; omitted or different effort is rejected.
  The URL is the Gateway host/prefix, without the chat endpoint's `/v1` suffix.
  The adapter uses the installed Neon provider's `.chat(modelId)` endpoint and never changes providers or reads credentials from the environment.
- `loadContext()` returns reviewed `policy.system`, optional `policy.projectRules`, selected `skills` strings, untrusted `issue`, repository identity/base revision, approved manifest, and prepared Git-tree files.
  The loader must check source approval and revision provenance before returning them.
- The manifest supplies `repository`, `baseSha`, `hash`, bounded `files` paths, and the patch validator's `patchManifest`.
  `patchManifest.allowedPaths` must match those paths exactly.
- Existing text-file entries supply `path`, regular-file `mode`, Git `blobSha`, SHA-256 `sha256`, and `text`.
  Both hashes must match the supplied content.
  Include explicit ancestor metadata and absent targets required by `validateChanges`; directory or absent entries have `blobSha: null` and no `text`.
- The adapter clones and freezes context, reservation, tool arguments, and returned patches.
  Its `inputHash` binds the model ID, renderer, complete context, rendered guidance/data, and tool declarations.
  Returned guidance hashes identify the exact reviewed system guidance and selected skills.

Reviewed policy, project rules, and selected skills enter the system message.
Issue text, repository metadata, and file contents enter delimiter-escaped JSON data blocks in the user message.
Submitted markers cannot end their data block.
Gateway credentials never enter either message or tool schemas.
The trusted HTTP authorization header does contain the Gateway credential.

## Optional trusted repair investigation

Only the trusted `loadContext()` callback may add this closed `investigation` object.
It is separate from the private Gateway/model configuration and never comes from `run({})`, issue text, or a model finding.
The coordinator must authenticate the finding at the current head, reserve the durable shared repair budget with `beginRepair`, and derive criterion/test hashes from approved inputs before constructing it.

```js
investigation: {
  version: 1,
  findingSha256, headSha,
  criteria: [{ criterionIndex, criterionSha256 }],
  references: [{ fileIndex, blobSha, testIdentitySha256 }],
  regressionFileIndex,
}
```

`criterionSha256` hashes the exact approved UTF-8 criterion without normalization.
Criteria contain 1..32 unique zero-based indexes, each 0..31.
References contain 1..16 unique triples; `fileIndex` is a zero-based index into the complete prepared `context.files` array, not the text-only prompt list.
Each reference must identify an approved existing regular file with its actual Git blob SHA.
`testIdentitySha256` is a trusted native test-identity hash or explicit `null` for a file-only reference.
The loader owns the test identity's source association; this adapter does not parse candidate tests.
`regressionFileIndex` selects one approved absent or `100644` `.test.mjs` target.
`headSha` must equal the prepared repository/base revision.
The adapter renders numeric/hash investigation bindings as trusted guidance and an escaped prepared-file index as untrusted data.
Complete bindings, file-index data, and investigation schemas enter tokenizer accounting and `inputHash`.

For Qodo source findings, the loader also supplies a separate closed `findingReport` with `version`, `source: 'qodo'`, `findingSha256`, `headSha`, `reviewId`, `commentId`, `fileIndex`, `line`, and `body`.
The adapter verifies its source-file reference and recomputes the finding digest, including the body.
Its escaped text stays within 4,000 UTF-8 bytes and enters only an untrusted user-message block, never trusted investigation guidance.
The report enters token accounting and the input hash but never the returned result or durable journal.

In investigation mode only, `proposeChanges` requires this closed `assessment` field alongside the existing base/manifest/changes fields:

```js
assessment: {
  disposition, // confirmed | suspected_false_positive | scope_change | insufficient_evidence
  findingSha256,
  criterionIndex, criterionSha256,
  references: [{ fileIndex, blobSha, testIdentitySha256 }],
}
```

The finding, selected criterion pair, and every unique reference must match the trusted bindings exactly.
No free-form explanation, additional authority field, head override, or fourth tool is accepted.
A `confirmed` assessment requires exactly one patch to the selected regression target, accepted by the existing blob/content/path validator.
The completed result keeps its existing fields and adds `assessment`.
The candidate parser must still validate literal regression selection, criterion/phase association, and candidate identity before publication.
Confirmation remains a fallible model assessment, not proof of a defect or authority to repair it.

The other three dispositions require `changes: []` and return exactly `{status: 'stopped', blockerCode: 'investigation_human_stop', proposal: false, changes: [], assessment}`.
Their tool receipt has `status: 'assessed'`; no validator or publication runs.
A valid provider response without an accepted assessment returns `{status: 'stopped', blockerCode: 'investigation_assessment_unavailable'}` after validating and durably recording provider usage.
Malformed returned tool-call schemas instead stop at the existing `model_contract_unknown` boundary.
Usage, contract, or persistence failures withhold both patches and assessments.
The coordinator maps adapter stops to its typed journal categories; never persist the whole transient agent result.
Without `investigation`, the original proposal schema and result fields remain unchanged.

## Authorization callbacks

The coordinator supplies three callbacks bound to its current lease, approval evidence, and stable operation key.
Do not expose them as model tools or derive their authority from issue text.

| Callback | Contract |
| --- | --- |
| `recheck()` | Return exactly `true` only after fresh approval, policy, lease, and deadline checks. |
| `reserveModelCall(request)` | Bind `{inputHash, expectedHeadSha, inputTokens, outputTokens}` to the coordinator's stable key and lease; forward to the durable store. |
| `recordModelCallOutcome(reservation, outcome)` | Forward `{operationId: reservation.operationId, ...outcome}` under that same lease and return the store receipt unchanged. |

A fresh reservation requires `status: 'reserved'`, `canExecute: true`, an opaque nonempty `operationId`, bounded integer token allowances, and the store's ISO `deadlineAt`.
Existing, conflicting, stale, missing, or malformed reservations never start a model request.
Approval is checked again after reservation.
Store receipts must confirm `recorded/success` or a recognized `needs_attention` outcome.
Database deadline downgrades remain authoritative.
A failed, stale, malformed, or timed-out persistence receipt returns `model_outcome_uncertain` and withholds patches.
The unresolved durable reservation must prevent later ticks from issuing a replacement call.

## Tools and limits

The model receives only `readFile`, `listFiles`, and `proposeChanges`.
Each tool validates its strict schema again at execution, including calls that bypass SDK validation.
No tool runs shell commands, arbitrary URLs, SQL, package installation, publication, or deployment.

- Reads require an approved regular-file path and the prepared revision.
  The injected reader receives `{path, revision, expectedBlobSha, abortSignal}` and must honor cancellation.
  Responses must match path, revision, Git blob hash, content SHA-256, and the file byte limit.
  Terminal control bytes are escaped before returning text.
- Listing returns only the frozen approved paths.
- One proposal attempt passes frozen base metadata, changes, and patch manifest to the real `validateChanges` validator.
  Only accepted patches set `proposal: true`.
  Rejected proposals never become publishable work.
- At most 16 tool invocations execute during one model request.
  Calls after completion or cancellation reject, including late results from a hanging reader or validator.

| Limit | Maximum |
| --- | --- |
| Context plus rendered messages and tool declarations | 512 KiB each admission check |
| Approved paths / prepared metadata entries / selected skills | 32 / 128 / 16 |
| Input reservation / requested output | 8,000 strict counter; up to 65,536 approved MVP allowance / 2,000 output tokens |
| Text file / serialized model text and tool-call output | 64 KiB / 64 KiB |
| Proposed files / total changed content | 10 / 256 KiB, further restricted by the manifest |
| SDK model requests / steps / retries | 1 / 1 / 0 |
| Model wall time | 45 seconds or the smaller configured/reserved deadline |
| Outcome persistence wait | 5 seconds or the smaller configured timeout |

The SDK and tool-await deadline uses an abort signal and an independent timer.
An SDK or reader that ignores cancellation cannot extend the adapter's result deadline or retain tool authority.
The adapter cannot forcibly terminate code inside a misbehaving trusted callback.

## Explicit MVP input admission

The operator approves Sol/high `inputAdmission: 'conservative-bytes-v1'` in both the private config and externally pinned model manifest.
`input-budget.mjs` serializes the complete rendered system message, prompt and tool declarations, requires at most 60 KiB, and reserves their UTF-8 bytes plus a 4,096-token safety allowance.
The allowance cannot exceed 65,536 per call; the run input reservation stays at 100,000.
This is a conservative budgeting policy, not an accurate tokenizer, known framing count, exact pre-call token ceiling or billing guarantee.
It keeps all reviewed guidance and makes no counting request to the provider.
Actual reported usage must fit the reservation; excess or uncertain usage stops the run for human reconciliation without another automatic call.
Output, call, deadline, repair and provider-spend activation guards stay unchanged.
Approval rejects the raised ceiling for profiles that do not explicitly select this mode.

## Strict tokenizer activation gate

There is no production authoritative tokenizer supplied by this module.
Without the approved MVP mode or a trusted strict counter, the adapter stops at `input_budget_unverified` before reserving tokens or calling the provider.
The injected counter requires the exact configured `modelId`, a protocol-matching renderer, and synchronous `countRendered({system, prompt, toolSchemas})`.
`toolSchemas` contains the complete immutable HTTP function declarations, including names, descriptions, and JSON schemas.
Controlled SDK tests compare these declarations and both messages against the actual serialized request.

For `gpt-6-1-sol`, the renderer identifier is `neon-responses-gpt-6-1-sol-v1` and `.chat('gpt-6-1-sol')` routes to native `/openai/v1/responses`.
The approved manifest pins `{id: 'gpt-6-1-sol', renderer: 'neon-responses-gpt-6-1-sol-v1', reasoningEffort: 'high'}`.
The coordinator requires the model config and counter's `modelId`, renderer and `reasoningEffort` to match that profile before claiming work.
The worker requests `providerOptions.openai.reasoningEffort: 'high'` and `store: false`, and does not set sampling parameters.
No authoritative Sol encoding and complete Responses framing counter has been established; no tokenizer may be treated as accurate by analogy.
Until that contract is verified and injected, Sol stays fail-closed at `input_budget_unverified`.
Strict admission keeps its 8,000-token ceiling; the approved MVP uses the separate reservation policy above.
The 2,000-token output limit remains unchanged; Responses `output_tokens` includes reasoning tokens, so high effort shares the output reservation with visible output.
A stub counter in a unit test proves admission wiring only; it does not establish token accuracy, billing precision, or live model compatibility.
Never drop required guidance to fit the limit or substitute model-supplied counts.

## Stops and operator response

Usage must contain nonnegative safe-integer `inputTokens` and `outputTokens` within the reservation.
For chat models the adapter checks raw `prompt_tokens` and `completion_tokens` fields.
For Sol it requires raw Responses `input_tokens` and `output_tokens`, including reasoning in the output total, to match the SDK counts.
It requests SDK response-body retention for this check but never returns or logs that body.
Absent, partial, or null raw counts remain unreported even if the SDK normalizes them to zero.
Explicitly reported zero counts remain valid; the adapter never invents counts or costs.
Raw model transcripts, provider errors, response bodies, and credentials are not returned or logged.
A successful result contains only validated structured changes, base/manifest bindings, and hashes for the coordinator.
Treat patch content as untrusted data and do not log it.

| Observation | Persisted outcome | Fixed blocker |
| --- | --- | --- |
| HTTP 429, including daily-spend rejection | `spend_limit` | `model_spend_limit` |
| HTTP 401/403 or recognized model restriction | `restricted_model` | `model_restricted` |
| HTTP 402 or recognized payment rejection | `payment_failure` | `model_payment_failure` |
| Missing / invalid / excess usage | `usage_unreported` / `invalid_usage` / `excess_usage` | `model_usage_unreported` / `model_usage_invalid` / `model_usage_exceeded` |
| Expired call or local timeout | `deadline` | `model_call_deadline`, or the store's run/tick deadline blocker |
| Unsupported SDK response | `unknown_contract` | `model_contract_unknown` |
| Network failure or unknown charge | `uncertain` | `model_outcome_uncertain` |

The store moves failed calls to `needs_attention`.
Stop automatic work, inspect the fixed blocker, and reconcile the durable operation and provider charge before approving any new work.
For spend or payment stops, check the worker credential's branch restrictions, allowed model, daily spend ceiling, and available budget.
For restrictions or unknown contracts, validate the approved model's chat/tool/usage support against the installed SDK.
Do not silently switch providers, raise limits, or replay an uncertain call.

## Evidence and remaining prerequisites

Tests use synthetic credentials and controlled HTTP responses with global uncontrolled-fetch rejection.
Installed `ai` 7.0.164 and `@neon/ai-sdk-provider` 1.3.1 exercise real request rendering, tool execution, no-continuation behavior, usage parsing, and failure envelopes.
These are mocked transport observations, not live Gateway contracts.

Live model/tool/usage compatibility, an explicitly approved admission profile, Gateway credential isolation and daily-spend preflight, lease-bound coordinator wiring, and real database restart/reconciliation behavior remain activation prerequisites.
No provider request, database operation, deployment, or live-setting change is part of these tests.
