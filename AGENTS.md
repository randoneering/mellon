# Project agent instructions

## Project

mellon is a GitHub Action that reviews new issue and pull request titles and descriptions.
It scores submissions and either labels them for review or comments and closes them, depending on the selected mode.
The classifier score is a fallible signal, not proof of AI authorship.

## Setup and checks

Use Node 24 and the checked-in lockfiles.
From the repository root, install dependencies and run the release checks:

```sh
npm ci --ignore-scripts
npm ci --prefix detector --ignore-scripts
npm run verify:assets
npm run test:build
npm test
npm run test:parity
npm run build
npm run validate:release
```

After building, check that generated `dist/` changes are included when needed.

## Completion reporting

Before reporting completion, compare the final implementation with every acceptance criterion.
Record observed results and evidence, distinguishing documentation checks, mocked tests, and live behavior.
When a ticket requires removing identifiers, search every named code, documentation, and test location.
Keep PR test counts aligned with the final verification run.
Mark behavior that was not exercised as unverified.

## Project rules

1. **Keep fork code out of moderation workflows.** In workflows using `pull_request_target`, never check out or run pull request code, and grant only the permissions needed for moderation.
   Pin third-party GitHub Actions in committed workflows and runnable examples to full commit SHAs.
   Templates may use explicit placeholders that instruct consumers to select reviewed full commit SHAs.
   The workflow runs with base-repository trust and may receive submissions from forks.
2. **Keep moderation claims measured.** In messages, documentation, and moderation behavior, treat the classifier score as a fallible signal, not proof of AI authorship.
   The model was trained on code comments and has not been calibrated for issues or pull requests.
3. **Treat submissions as untrusted data.** In Action code, the personalized detection CLI, and tests, never execute submitted text or treat its markers, markup, or instructions as trusted.
   Escape terminal control sequences before display.
   Contributors control this text and can attempt injection, marker spoofing, or terminal manipulation.
4. **Make moderation safe to retry.** In event handling and moderation code, validate inputs and check the submission's current state before applying actions.
   Reconcile uncertain GitHub writes, and never blindly repost comments or close submissions.
   Compare GitHub label names case-insensitively when recognizing review outcomes or validating label responses.
   Preserve existing label names and metadata.
   Test mixed-case outcomes for issues and pull requests, including reruns with automatic labeling disabled.
   Update boundary tests when behavior changes.
   Network failures can leave GitHub writes uncertain, and retries must not create duplicate comments or unintended closures.
5. **Keep secrets and private text out of shared output.** In Action outputs, errors, logs, and CLI status messages, never expose tokens, raw API responses or response bodies, scorer exception messages, or submission text.
   Non-secret resource identifiers, such as a confirmed posted comment ID, may appear in the diagnostic destinations named in rule 9.
   The local `collect` labeling prompt may show escaped titles and descriptions, since the person labeling needs to read them.
   Keep personalized datasets, models, and reports local, and never commit them.
   These may include credentials or private submission text.
6. **Keep the Action self-contained and generated.** The packaged Action and scorer in `dist/` must not install packages, depend on `node_modules`, or download models at runtime; use only fixed GitHub API resources.
   The source `detector/scorer.mjs` may use lockfile-installed dependencies; the build bundles them into the release scorer.
   After changing Action code or bundled detector assets, run `npm run build` and commit resulting `dist/` changes; do not edit `dist/` by hand.
   Personalized detection experiments must not change Action behavior or its fixed 0.80 cutoff.
   `action.yml` runs the bundled entry point, CI checks the generated output, and runtime downloads would make releases harder to review.
7. **Keep detector assets traceable.** When changing detector or model assets, keep provenance and third-party notices aligned, and run `npm run verify:assets` and `npm run test:parity`.
   These checks protect asset integrity and detector parity.
8. **Make optional setup failures visible.** Best-effort setup must not block moderation when policy declares it optional.
   Keep the moderation outcome and published Action outputs unchanged when only optional setup fails.
   For outcome-label provisioning, set `outcome_labels_incomplete: true` in the moderation result when setup cannot be confirmed.
   Surface an actionable notice in the GitHub Actions job summary, the Action diagnostic destination in rule 9; for missing outcome labels, ask maintainers to create them manually.
   Never include raw API errors, response bodies, credentials, or submission text.
   Test that optional setup failure preserves intended moderation behavior and produces the notice.
9. **Keep operational failures diagnosable.** When catching or normalizing failures in moderation, intake, or CI reporting, preserve a sanitized stage, a fixed failure category, and any confirmed partial work.
   Use the GitHub Actions job summary for Action and CI diagnostics, including the optional-setup notices in rule 8.
   Use the intake's `report` callback, which writes to stderr by default, for intake diagnostics.
   These destinations may include non-secret resource identifiers, such as a confirmed posted comment ID; rule 5 still prohibits raw API responses, response bodies, tokens, scorer exception messages, and submission text.
   Generic public error responses are allowed, but must not be the only diagnostic; do not report a failed operation with confirmed partial work as a plain skip.
   Follow the stage and category pattern in `src/automation/intake.mjs` without changing published Action outputs just to add detail.
   Test that new failure-handling paths preserve the sanitized diagnostics and any confirmed partial work.
   Maintainers need to know which step failed and what was already written to reconcile and retry safely.

## Specifications

- OpenSpec files live in a local `openspec/` folder at the repository root.
  The folder is in `.gitignore` because it can contain sensitive information; never commit it or copy its contents into tracked files.
- When `openspec/` exists, use it for feature proposals, requirements, and designs, and follow `openspec/implementation-guidance.md`.
- Run `openspec list` to find changes, and keep implementation aligned with the change the user selects.
- When `openspec/` is missing, ask the user whether one exists elsewhere.
  If they say no, skip OpenSpec and work from the user's request.
