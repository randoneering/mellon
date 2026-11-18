# Isolated builds for n8n

n8n owns the coding agent and GitHub App publication credential.
The `n8n isolated build` workflow only tests an approved source commit and exports generated distribution files.
It creates no commits, PRs, labels, or comments.

## Coding-task review gate

The saved completion policy is [`mellon-review-gate-v1` in AGENTS.md](../AGENTS.md#review-quality-gate-mellon-review-gate-v1).
The `mellon-triage` agent also keeps this policy in its own instructions so its published version receives the gate directly.
Fix valid High and Medium findings across Bugs, Rule violations, and Requirement gaps; leave Low findings unchanged and report them for human attention.
Missing classification, unresolved blockers, incomplete checks or review, stale coverage, and stalled loops mean `NOT_DONE`.

This is an agent instruction gate, not a new CI or branch-protection rule.
The read-only n8n agent cannot run Qodo or tests; it must identify missing evidence rather than invent results.
A ready source proposal does not prove the task passed the gate.
The external coding session or runner supplies verification, and the final report accounts for findings and Low items.
The isolated build runner checks below remain unchanged.

## Publication transport diagnostics

`scripts/n8n-transport-probe.mjs` builds an inactive, manual-only diagnostic for an explicitly approved investigation.
It reads one pinned public Git blob and compares at most six sequential GraphQL request sizes using the existing App credential.
The GraphQL operation stays a fixed read-only quota query; file-change data appears only in unused variables.
Requests use a nonexistent diagnostic branch in those variables, refuse redirects, and retain a 20-second timeout.
GraphQL probe requests never retry automatically.
The idempotent preparatory GET propagates HTTP errors so a cached-token 401 can reach n8n's native credential-refresh handler; sanitized continuation still journals a final failure.
The native helper may refresh its token and resend that GET. This does not edit the static App ID, installation ID, private key, permissions, or domains.
Do not copy this GET error-handling pattern onto mutating publisher calls; reconcile uncertain writes before any explicit resend.
The helper validates the blob hash, canonical base64, sizes, query identity, and output metadata.
Each request and measurement must match independently supplied trusted pins; the final report rejects mixed-pin measurements.
An HTTP success is `ok` only when it contains a valid GraphQL quota response; empty, malformed, or unusable success bodies are `invalid_response`.

Install the checked-in `internal/n8n/MellonTransport.node.js` in the n8n custom nodes directory on each execution host and restart n8n before importing the generated workflow. It uses the authenticated HTTP helper in n8n 2.44.7 with a 16 MiB response limit for the blob and 64 KiB for GraphQL. Both limits apply during receipt. This changes the measured transport from the stock HTTP Request node to the bounded helper.

The two blob-validation Code nodes use the Node.js `crypto` built-in. Include `crypto` in `NODE_FUNCTION_ALLOW_BUILTIN` for the JavaScript task runner executing this workflow. When the runner cannot load it, the blob journal records `blob_validation_unavailable` on an HTTP 200 and payload preparation stops.

Supply the existing App credential reference and a dedicated report table ID to `createProbeWorkflow({ credential, reportTableId })`.
The diagnostic stores sanitized `started`, `blob_response`, `request_prepared`, `measurement`, and `complete` records in that table, keyed by execution ID.
It disables success, error, manual, and progress execution-data retention so raw source payloads and response bodies are not saved with the run.
Reports contain only fixed phase/pin metadata, request sizes, confirmed HTTP status, a separately labeled n8n node error code, elapsed time, fixed categories, validated GitHub request IDs, and numeric rate-limit/retry headers.
A prepared-request record is intent, not proof that GitHub received the request.
Elapsed time includes journaling and node overhead; a node error code is not a confirmed upstream HTTP status.
Rate-limited measurements are recorded before the workflow stops; it does not continue the remaining cases or retry automatically.
Do not add credentials, submission text, arbitrary headers, raw bodies, or exception messages to the report.
Validate and review the generated configuration before the approved manual run.
For a live MCP run, use `method: direct`, `executionMode: manual`, and the explicit `Manual transport diagnostic` trigger; manual triggers take no inputs.
For simulations, use pinned HTTP data and set the manual trigger's `synthetic: true` marker so stored records cannot be mistaken for live measurements.
The marker only labels records; it does not itself mock HTTP or prevent other node side effects.
A complete real result requires a matching execution ID, a `complete` record, and `synthetic: false`.
A completed diagnostic is not evidence of a repaired publisher, a completed build, or factory readiness.
It makes no repository writes and does not activate the production builder.

## Dispatch

After this workflow is reviewed and merged, n8n can dispatch `.github/workflows/n8n-build.yml` on `main`.
The builder App needs Actions read/write for dispatch and result access; it does not need Workflows write.

| Input | Required value |
| --- | --- |
| `branch` | Existing `n8n/issue-<positive number>` branch |
| `source_sha` | Exact 40-character lowercase SHA currently at that branch |
| `request_id` | Unique `n8n-<execution number>` recorded by n8n before dispatch |

The workflow validates the branch head before checking out source.
Its helper comes from the reviewed workflow revision, separately from the requested source.
It runs on a fresh GitHub-hosted Ubuntu runner with Node 24, `contents: read`, no persisted checkout credentials, and a 20-minute deadline.
Only the validation step receives the read-only GitHub token.
No App key, publication token, or other repository secret is passed to source commands.

## Checks and result

The runner executes the repository's locked dependency installs, asset checks, build-safety tests, JavaScript tests, parity checks, build, and release validation.
It intentionally does not require the rebuilt distribution to match the incoming source commit: n8n publishes those generated changes afterward.
Existing PR CI still enforces a committed distribution.

Successful runs upload `n8n-build-<request_id>-attempt-<run_attempt>` containing one `result.json`, with compression disabled and one-day retention.
The helper supplies the artifact name to the upload step and records it as `artifact_name` in the manifest.
Each rerun gets a distinct name without overwriting an earlier attempt's artifact.
Manifest version 1 contains repository, branch, source SHA, request ID, run ID/attempt, workflow SHA, artifact name, and all 19 packaged files as base64 content with SHA-256 hashes:

- `dist/index.mjs`
- `dist/scorer.mjs`
- `dist/build-meta.json`
- `dist/THIRD_PARTY_NOTICES.txt`
- `dist/detector/provenance.json`
- `dist/detector/vendor/aicomment/LICENSE`
- `dist/detector/vendor/aicomment/classifier.mjs`
- `dist/detector/vendor/aicomment/model.json`
- `dist/detector/vendor/aicomment/preprocess.mjs`
- `dist/detector/vendor/aicomment/pychars.mjs`
- `dist/detector/vendor/aicomment/langs/c_family.mjs`
- `dist/detector/vendor/aicomment/langs/elisp.mjs`
- `dist/detector/vendor/aicomment/langs/haskell.mjs`
- `dist/detector/vendor/aicomment/langs/index.mjs`
- `dist/detector/vendor/aicomment/langs/perl.mjs`
- `dist/detector/vendor/aicomment/langs/php.mjs`
- `dist/detector/vendor/aicomment/langs/python.mjs`
- `dist/detector/vendor/aicomment/langs/registry.mjs`
- `dist/detector/vendor/aicomment/langs/shell.mjs`

This is an explicit allowlist, not a recursive export of arbitrary files.
When the packaged distribution gains a file, update the producer and consumer contracts together; a regression test checks coverage against the tracked `dist/` tree.
Each file is at most 8 MiB; total decoded content is at most 16 MiB.
Missing files, symlinks, non-UTF-8 content, and oversized results fail export.
Raw check output remains in ephemeral runner-local logs.
Failures report a fixed stage and category in the job summary without replaying command output.

## n8n publication boundary

Treat artifacts as untrusted data.
Before publishing, n8n must independently check the recorded request, repository, reviewed workflow/run identity, successful conclusion, expected run attempt, artifact name/digest, source SHA, allowed files, decoded sizes, and content hashes.
Derive the expected artifact name from the recorded request ID and the expected run attempt; do not select a different attempt merely because its artifact exists.
Reject an expired, ambiguous, already-consumed, or mismatched result.
The source branch must still point at the exact tested source commit; bind any generated-file commit to that expected head.
Never execute downloaded artifacts or accept additional file paths or commands from them.
The coding agent must not receive the App credential.

## Rollout and rollback

This workflow is a bootstrap prerequisite, not a complete n8n consumer.
Keep the source-only n8n build workflow unpublished until dispatch, bounded result validation, and generated-file publication are wired and tested.
An approved live pilot is still needed to verify hosted execution and the full source-to-PR path.
Disable this workflow to stop new runner executions.
Do not reset or delete a source branch automatically after a failed or uncertain dispatch.
