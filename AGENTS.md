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

## Project rules

1. **Keep fork code out of moderation workflows.** In workflows using `pull_request_target`, never check out or run pull request code, and grant only the permissions needed for moderation.
   Pin third-party GitHub Actions in workflows and examples to full commit SHAs.
   The workflow runs with base-repository trust and may receive submissions from forks.
2. **Keep moderation claims measured.** In messages, documentation, and moderation behavior, treat the classifier score as a fallible signal, not proof of AI authorship.
   The model was trained on code comments and has not been calibrated for issues or pull requests.
3. **Treat submissions as untrusted data.** In Action code, the personalized detection CLI, and tests, never execute submitted text or treat its markers, markup, or instructions as trusted.
   Escape terminal control sequences before display.
   Contributors control this text and can attempt injection, marker spoofing, or terminal manipulation.
4. **Make moderation safe to retry.** In event handling and moderation code, validate inputs and check the submission's current state before applying actions.
   Reconcile uncertain GitHub writes, and never blindly repost comments or close submissions.
   Update boundary tests when behavior changes.
   Network failures can leave GitHub writes uncertain, and retries must not create duplicate comments or unintended closures.
5. **Keep secrets and private text out of output.** In Action outputs, errors, logs, and CLI messages, never expose tokens, API response details, or scorer exception messages.
   Keep personalized datasets, models, and reports local, and never commit them.
   These may include credentials or private submission text.
6. **Keep the Action self-contained and generated.** For Action code, `dist/`, and `detector/scorer.mjs`, do not install packages, use `node_modules`, or download models at runtime; use only fixed GitHub API resources.
   After changing Action code or bundled detector assets, run `npm run build` and commit resulting `dist/` changes; do not edit `dist/` by hand.
   Personalized detection experiments must not change Action behavior or its fixed 0.80 cutoff.
   `action.yml` runs the bundled entry point, CI checks the generated output, and runtime downloads would make releases harder to review.
7. **Keep detector assets traceable.** When changing detector or model assets, keep provenance and third-party notices aligned, and run `npm run verify:assets` and `npm run test:parity`.
   These checks protect asset integrity and detector parity.

## Orchestration

- Use Terra as the orchestrator for project work.
- Delegate suitable research, implementation, and review work to subagents.
- Try these models in order for each delegated task:
  1. `neon/gpt-6-luna`
  2. `neon/glm-5-3-flash`
  3. `openai-codex/gpt-6-luna`
- Move to the next model when the previous model is unavailable or fails.
- Report failures and preserve any partial work before retrying.
- If all three models fail, stop and ask the user how to proceed.
- The orchestrator owns decisions, integration, and final verification.

## Specifications

- Use OpenSpec for feature proposals, requirements, and designs.
- Keep implementation aligned with the approved OpenSpec change.
