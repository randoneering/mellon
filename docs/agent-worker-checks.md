# Agent worker check evidence

`createCheckReader({ token, repository, fetch, timeoutMs, pageLimit, responseLimit })` exposes `readChecks(input)` and `readFailure(input)`.
The reader returns `success`, `waiting`, `intended_red`, or `needs_attention` with fixed reasons and bounded identifiers only.
It does not authorize model calls, repository writes, approval, or publication.

## Inputs and workflow mapping

The `manifest` input contains only `repository`, `requiredChecks`, and `requiredWorkflowIdentities` from private verified configuration.
The caller must bind this projection to the approved manifest and must not derive it from issue text or model output.
A single-workflow call uses `run: { headSha, branch, runId, runAttempt }`.
A manifest with multiple workflow identities requires `runs`, with one `{ workflowId, headSha, branch, runId, runAttempt }` record for each identity.
The caller maps each workflow ID to its distinct Actions run ID from trusted run metadata.
The reader rejects missing, duplicate, mismatched, or shared run mappings instead of reusing one run for several workflows.
Every mapped run must name the same full head SHA and owned `agent-work/<run UUID>` branch.
The reader verifies each run's repository, head repository, workflow ID and path, event, head, branch, run ID, attempt, and check-suite ID through GitHub's API.
The trusted caller supplies `expectedRegression: { workflowId, testIdentitySha256, proposalSha256 }` only for a previously approved test-only proposal at the exact expected head.
The caller derives the test identity and proposal digest from that trusted proposal, not from a model assertion or reporter output.
An `intended_red` result is bounded execution evidence and grants no approval or write permission.

## Fixed GitHub reads

All requests use `https://api.github.com`, `GET`, `redirect: manual`, the API version header, one aggregate deadline, strict UTF-8 JSON, and bounded bodies.
The adapter reads these fixed resources:

- `/repos/OWNER/REPO/actions/runs/RUN_ID`
- `/repos/OWNER/REPO/contents/.github/workflows/test.yml?ref=HEAD`
- `/repos/OWNER/REPO/contents/automation/ci/guard-command.mjs?ref=HEAD`
- `/repos/OWNER/REPO/contents/automation/ci/run-tests.mjs?ref=HEAD`
- `/repos/OWNER/REPO/contents/automation/ci/test-reporter.mjs?ref=HEAD`
- `/repos/OWNER/REPO/contents/automation/ci/report-annotations.mjs?ref=HEAD`
- `/repos/OWNER/REPO/contents/scripts/lib/output-guard.mjs?ref=HEAD`
- `/repos/OWNER/REPO/contents/package.json?ref=HEAD`
- `/repos/OWNER/REPO/contents/automation/ci/report-annotations.mjs?ref=REVIEWED_FORMATTER_SHA`
- `/repos/OWNER/REPO/check-suites/SUITE_ID/check-runs?filter=all&per_page=100&page=N`
- `/repos/OWNER/REPO/actions/runs/RUN_ID/attempts/ATTEMPT/jobs?per_page=100&page=N`
- `/repos/OWNER/REPO/check-runs/CHECK_RUN_ID/annotations?per_page=100&page=N`

The check-run and job lists require consistent numeric pagination totals, unique IDs, and complete pages.
The annotations resource returns pages as arrays, so the reader uses numeric page numbers and requires a short final page.
It reads at most 3 annotation pages of 100 records and fails closed when all 3 pages are full.
Each response is capped at 256 KiB, the total read deadline defaults to 10 seconds and cannot exceed 30 seconds, and numeric list pages cap at 10.
Workflow and producer contents must be regular files with the exact path, `base64` encoding, matching byte size, valid wrapped base64, fatal UTF-8, and the approved SHA-256.
The reader never follows check-run links, log redirects, or archive URLs.

Before accepting annotations, it binds the workflow run, immutable repository and App IDs, head SHA, attempt, check suite, exact required check, and its unique linked job.
Job linkage uses the documented `check_run_url`, `run_id`, `run_attempt`, and `head_sha` fields.
The reader does not assume `job.check_run_id` or `check_suite.head_sha` exists.

## Diagnostic producer pin

Each pilot workflow identity requires a closed `diagnostics` descriptor with `version: 2`, `sources`, `reporter`, and `skipPolicy`.
Five-field workflow identities and version 1 descriptors fail before any GitHub reads, for both green and intended RED.
The six ordered source records pin `automation/ci/guard-command.mjs`, `automation/ci/run-tests.mjs`, `automation/ci/test-reporter.mjs`, `automation/ci/report-annotations.mjs`, `scripts/lib/output-guard.mjs`, and `package.json` by distinct lowercase SHA-256 values.
The external approval hash covers the whole descriptor.
The reader fetches and hashes every candidate source at the expected head and separately verifies the formatter source at the reviewed immutable `reporter.revision`.
`reporter` requires exactly `context: 'test-report'`, the lowercase full commit `revision`, and `sha256`.
Exactly one required check must bind that reporting context to the same workflow and App.
No candidate-revision fallback or execution-job annotation can satisfy this requirement.
The separate workflow identity pins `.github/workflows/test.yml` at the candidate head.
`skipPolicy` requires exactly `version: 1` and the approved `sha256` documented in [the CI boundary](agent-worker-ci.md#reviewed-database-skip-policy).
Approval and the check reader independently reject missing, unknown, or changed policy descriptors.

## Reporter schema

The protected Node 24 reporter consumes native `node:test` events and returns one `MELLON_CI_RAW_V2:<base64url JSON>` record to the runner.
The runner's job outputs remain only the encoded report and exit code.
The separate reviewed formatter emits either one legacy `MELLON_CI_REPORT_V2:<base64url JSON>` notice or bounded chunk notices for larger payloads.
Chunk messages use `MELLON_CI_REPORT_V2_CHUNK:<sha256>:<index>:<count>:<part>`, with 2..10 parts and at most 3,500 base64url characters per part.
The reader accepts API order differences but requires every unique index from the same check's annotation set, consistent count/digest, the full-payload hash and all original V2 validation.
Missing, duplicated, mixed legacy/chunk, malformed or truncated evidence cannot advance work.
Human-readable failure locations travel through a separately validated local pipe and are not part of this machine schema or accepted readiness evidence.
The closed version 2 annotation has exactly these fields: `schemaVersion`, `complete`, `truncated`, `reason`, `context`, `producerSha256`, `counts`, `failures`, `rootFailures`, `skipPolicySha256`, `skippedTestIdentitySha256s`, `processExitCode`, and `formatterRevision`.
The raw report omits the last two fields.
Version 1 reports are unsupported.
`context` binds `repository`, full `headSha`, exact string `runId`, and numeric `runAttempt` to the GitHub environment.
`producerSha256` hashes canonical JSON for the ordered approved source path and digest records.
`counts` contains `testCount`, `passedTestCount`, `failedTestCount`, `aggregateFailureCount`, `assertionFailureCount`, `setupFailureCount`, `syntaxFailureCount`, `otherFailureCount`, `skippedTestCount`, `todoTestCount`, `cancelledTestCount`, and `rootFailureCount` as bounded nonnegative integers.
`failures` contains only `{ testIdentitySha256, category }` records, and `rootFailures` contains only `{ category }` records.
`skippedTestIdentitySha256s` contains at most 64 unique lowercase SHA-256 values in raw reports, and at most the 62 approved identities at the formatter and reader boundaries.
Its length must equal `skippedTestCount`; skipped and failed identities cannot overlap.
The formatter and reader independently enforce policy membership, the fixed policy digest, complete category/count consistency, and no todo or cancelled tests.
Native skip/todo flags accept booleans and bounded safe strings; false means inactive.
Control bytes, workflow-command markers, conflicting active flags, ambiguous identities, and malformed flags invalidate evidence.
Test identities hash canonical JSON fields for repository-relative entry file, test name, nesting, source line, source column, and native test type.
The report never includes names, paths, assertion messages, actual or expected values, stacks, logs, secrets, or API payloads.

The reporter accepts at most 20,000 native events, 4,096 completed tests, 64 direct failures, 64 root failures, a 1,024-character test name, and a 512-character normalized path.
Its JSON report is at most 24 KiB and captured runner output at most 64 KiB.
The original logical annotation bound remains 32 KiB; chunk headers add only bounded transport overhead.
Each chunk message stays below GitHub's observed 4 KiB API cap.
Small legacy notices remain supported, including earlier controlled V2 fixtures.
The ordinary-command guard captures at most 256 KiB per stdout or stderr stream and applies a 12-minute command deadline.
Overflow, malformed context, malformed events, ambiguous identities, incomplete event streams, and reporter failures cannot produce complete evidence.
The runner passes the native test child process exit code as a bounded output and preserves a nonzero status.
The trusted formatter attaches that code and its reviewed checkout revision to the annotation.
Assertion, hook, and JavaScript syntax classifications come from native Node error fields; a file-level load failure without a structured error type remains `other` and cannot establish intended RED.

## Accepted outcomes

Green requires a complete version 2 report with exit code zero, positive test count, matching producer/formatter identities and GitHub context, and no failed, aggregate, todo, or cancelled tests.
Only explicitly reviewed DB identities may skip, and passed plus approved skipped tests must equal the full test count.
Intended RED requires one completed failed `Run JavaScript tests` step after successful setup, the exact required `test` check from the approved App, the exact successful linked reporting check, one complete report, exactly one selected native assertion failure, and process exit code 1.
Approved DB skips may coexist with that assertion failure, but the intended regression itself must never appear among skipped identities, even if allowlisted.
Setup, syntax, root, unrelated, todo, cancelled, and unapproved skipped tests block acceptance.
Returned summaries distinguish skipped tests from passed tests and preserve the policy digest and skipped identity enumeration.
Generic failures, stale or ambiguous annotations, missing reports, unsupported schemas, source mismatches, and truncated reports return `needs_attention`.
The result classifies bounded execution evidence only; a trusted caller must still compare the selected assertion with the approved acceptance criteria.

## Investigation-only assertion failures

`readFailure({manifest, run})` or `readFailure({manifest, runs})` accepts the same closed three-field manifest projection and run mapping described above.
It rejects `expectedRegression` and caller-supplied findings or criteria.
`readChecks` keeps its existing green and intended-RED behavior; a generic failed run remains insufficient there.

The failure path reuses every V2 workflow, source-byte, immutable formatter, repository/head/branch/run/attempt/App/event, exact linked-job, pagination, and report validation gate.
A failed workflow must have exactly one required `test` context whose unique linked execution job fails only at `Run JavaScript tests` after successful setup.
The reporting job must succeed.
The authenticated complete report must exit 1, contain 1..64 direct assertion failures, and contain no setup, syntax, other, root, todo, or cancelled failures.
Only the 62 explicitly reviewed skip identities may coexist; failed and skipped identities cannot overlap.
The fixed skip digest is `bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab`.
Successful companion workflows must pass their own complete green diagnostics.
The aggregate result contains at most 64 assertions across all workflows.

An authenticated failure returns this transient shape:

```js
{
  status: 'failure', repositoryId, headSha, branch, event: 'push',
  runs: [{ workflowId, runId, runAttempt, headSha, checks, diagnostic? }],
  checks: [{ checkRunId, checkSuiteId, appId, status, conclusion, headSha }],
  evidence: { assertions: [{
    workflowId, runId, runAttempt, testIdentitySha256, category: 'assertion',
    producerSha256, formatterRevision, reportSha256,
  }] },
  findingSha256,
}
```

`diagnostic` appears only on successful companion workflows and uses the existing bounded green summary.
`reportSha256` hashes canonical JSON of the fully validated report.
`findingSha256` hashes canonical JSON of the complete returned facts before adding `findingSha256` itself.
Canonical JSON sorts object keys recursively and preserves array order.
The same single-workflow facts produce the same finding hash through `run` or `runs` input.
The result contains no report bodies, logs, assertion text, raw API objects, or credentials.

A wholly green call returns the existing `success` shape, pending runs return `waiting`, and rejected evidence returns `needs_attention` with existing fixed reasons.
No result grants repair authority or asserts relevance to approved acceptance criteria.
The coordinator must associate native identity hashes with immutable prepared files and approved criteria, then call durable `beginRepair` before any investigation request.
The model can assess that association but cannot supply authentication or bypass the shared two-repair limit.
Tests use synthetic V2 reports and controlled GitHub-shaped transport; they do not establish live native provenance or a Qodo success contract.

## Ordinary output guard

Every repository-code command outside the protected `npm test` step uses a fixed tuple in `automation/ci/guard-command.mjs`.
That includes both dependency installs, asset verification, `test:build`, parity, build, distribution comparison, and release validation.
The wrapper uses `shell: false`, fixed arguments, a fixed working directory, bounded UTF-8 output, and isolated process-group termination on the workflow's Linux runner when a command times out or exceeds the output limit.
It escapes control characters and neutralizes both `::` and legacy `##[` markers before it writes any child output to the workflow log.
The protected `npm test` runner writes only encoded job outputs and bounded human-only failure coordinates.
Raw child streams, test names, assertions and stacks stay suppressed; location text never supplies machine readiness evidence.
Only the separate immutable `test-report` formatter publishes positive evidence annotations.

Focused synthetic tests cover the earlier native Node test output, both marker forms, chunked UTF-8, carriage returns, output limits, timeout with an ignored `SIGTERM`, and exit-code preservation.
These tests do not verify a live Actions annotation response or prove host isolation.
GitHub's check-run annotations endpoint still does not identify the producing step, so evidence remains dependent on the exact pinned workflow and complete approved producer graph.

## Limits and sources

The adapter has no log-download, archive-host, model, or publication path.
Synthetic tests use documented GitHub REST resource shapes and never make live GitHub calls.
Official references include [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [check runs and annotations](https://docs.github.com/en/rest/checks/runs), [repository contents](https://docs.github.com/en/rest/repos/contents), and the [GitHub REST API schema](https://github.com/github/rest-api-description).
Run the focused tests with `node --test tests/unit/agent-worker-checks.test.mjs`.
