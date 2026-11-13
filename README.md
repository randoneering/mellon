<p align="center">
  <img src="media/mellon.png" alt="mellon logo" width="240">
</p>

<h1 align="center">mellon</h1>

> “Speak, friend, and enter.”
>
> J. R. R. Tolkien, *The Fellowship of the Ring*

mellon means “friend” in Sindarin.

mellon is a GitHub Action that reviews new issue and pull request descriptions.
AI-assisted code is welcome, but contributors should describe their work in their own words.
mellon scores the title and description after removing fenced code and blockquotes.

mellon uses [aicomment](https://git.sr.ht/~kqr/aicomment), created by [Christoffer Stjernlöf (kqr)](https://xkqr.org/profile), for its classifier and model.
Thanks to Christoffer for making this work available.
You can try the [aicomment detector](https://xkqr.org/aicomment/) and read his posts on [Claude comment detection](https://entropicthoughts.com/ai-comment-classifier) and the [improved AI code comment detector](https://entropicthoughts.com/better-ai-comment-classifier).

The score is a fallible signal, not proof of AI authorship.
The current model was trained on code comments and has not been calibrated for issues or pull requests.
I plan to train and tune the model using pull requests and comments to better fit the submissions mellon reviews.
The fixed cutoff is **0.80**, including scores equal to 0.80.

## Set up the Action

1. Make sure your repository can access mellon and allows GitHub Actions to run.
2. Add the workflow below as `.github/workflows/mellon.yml` in your repository.
3. Replace `REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT_SHA` with a reviewed mellon commit SHA.
4. Start with `mode: observe` and review the results before enabling enforcement.

```yaml
name: mellon
on:
  issues:
    types: [opened]
  pull_request_target:
    types: [opened]
permissions:
  issues: write
  pull-requests: write
concurrency:
  group: mellon-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  moderate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Review submission
        uses: randoneering/mellon@REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT_SHA
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          mode: observe
          allowlist: '["dependabot[bot]"]'
          review-label: 'true'
```

Replace the example allowlist with the exact GitHub logins you want to skip, or omit it to review every author.
For forked pull requests, `pull_request_target` runs the trusted base-repository workflow.
Do not check out or run pull request code in this job.
mellon runs on Node 24 and requires a non-root runner.

### Modes and inputs

| Input | Default | What it does |
| --- | --- | --- |
| `token` | None | GitHub token with issue and pull request write permissions. |
| `mode` | `enforce` | `observe` labels flagged submissions; `enforce` responds and closes them after confirming each step. |
| `allowlist` | `[]` | JSON array of exact account logins to skip. |
| `response` | Packaged message | Literal comment text used in enforcement mode. |
| `auto-close` | `'true'` | `'false'` posts the enforcement response without closing the issue or pull request. |
| `review-label` | `'true'` | Shared across modes. `'false'` disables automatic review labeling. |

Both modes apply only `mellon: review` to eligible submissions at or above the cutoff by default.
Observation mode does not comment or close submissions.
With automatic labeling enabled, mellon also attempts to create the three outcome labels so they appear in the label picker.
Existing labels keep their color and description; newly created outcome labels have distinct colors and short descriptions.
Outcome-label setup failures do not block moderation.
The job summary reports incomplete setup and asks maintainers to create missing outcome labels manually.

### Review labels

| Label | Applied by | Meaning |
| --- | --- | --- |
| `mellon: review` | mellon | Flagged and waiting for maintainer review. |
| `mellon: reviewed-human` | Maintainer | Assesses the description as human-like. |
| `mellon: reviewed-ai` | Maintainer | Assesses the description as AI-like. |
| `mellon: reviewed-unsure` | Maintainer | Cannot confidently assess the description. |

After review, remove `mellon: review` and add exactly one outcome label.
Labels describe the maintainer's fallible assessment of the text, not the contributor or verified authorship.
They are visible to anyone who can see the issue or PR.
mellon never applies outcome labels, reacts to label changes, or swaps labels automatically.
Any outcome label prevents a rerun from reapplying `mellon: review` or closing the item, including with `review-label: 'false'`.
Outcome-label checks ignore capitalization and preserve existing label names.
It does not suppress an enforcement response if no matching bot response exists.

Find pending reviews in both states:

| Search | Typical use |
| --- | --- |
| `is:open label:"mellon: review"` | Observe mode or enforce with `auto-close: 'false'`. |
| `is:closed label:"mellon: review"` | Default enforce mode. |
| `label:"mellon: review"` | All pending items; remove the default `is:open` filter. |

Manual closes and reopens can change state, so check both queues.
Set `review-label: 'false'` to disable automatic label creation and application in either mode, and therefore automatic label-based metrics.
Observe mode with labeling disabled still reports flagged submissions without GitHub reads or writes.
Existing labels and past items are not migrated.
Maintainers can replace retired labels manually after reviewing each item.

### Review metrics

Count items across open and closed states: `P` = pending `review`, `H` = `reviewed-human`, `A` = `reviewed-ai`, and `U` = `reviewed-unsure`.

| Metric | Formula |
| --- | --- |
| Pending | `P` |
| Total flagged | `P + H + A + U` |
| Reviewer-assessed precision | `A / (A + H)`; report `U` separately. |
| Unsure-inclusive lower bound | `A / (A + H + U)`; counts every unsure as a miss. |

A zero denominator means unavailable, not zero precision.
Counts assume each flagged item has exactly one pending or outcome label; overlapping, removed, or manually added labels distort results.
These estimates cover reviewed flagged submissions, not recall or missed detections below the fixed `0.80` cutoff.
Reviewer error and selection bias limit interpretation; label names record neither mode nor score.
See [metric limits and an example](docs/moderation.md#review-metrics).

### Enforcement and reruns

Enforcement mode confirms a response first, applies `mellon: review` by default, then follows the existing auto-close setting.
Set `review-label: 'false'` to disable automatic labeling in either mode.
If the pending review label cannot be created or applied, the confirmed response remains partial work and mellon does not close the item; a later run reconciles GitHub state before retrying, without blindly reposting the response.
Optional outcome-label provisioning does not gate closure.
Unreadable current outcome labels prevent pending-label writes and closure.
The Action reports `commented` when it confirms the response but does not close the submission.
It reuses a matching bot response on reruns rather than posting a duplicate.
Changing `auto-close` affects later runs: turning it off does not reopen a closed item, and turning it on can close an eligible open item without an outcome label after reusing its response.
mellon appends the score and detector details to the response.
An empty `response` uses the packaged message.
The cutoff is fixed and cannot be configured through an Action input.

mellon only handles opening events; it does not scan existing submissions.
See [workflow configuration](docs/configuration.md) for input limits and [moderation and reruns](docs/moderation.md) for failure and retry behavior.
A separate local experiment workflow can train and evaluate a personalized classifier; it does not change this Action. See [personalized detection experiments](docs/personalized-detection.md).

## Build and test

Use Node 24 and the checked-in lockfiles:

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

The test runners serialize files because build-safety tests rewrite `dist/` while other tests read it.
The build produces the bundled Action, scorer, detector assets, metadata, and third-party notices in `dist/`.
Include those files in a release commit; the Action does not install packages or download models at runtime.
Repository maintainers can use the [isolated n8n build runner](docs/n8n-build-runner.md) to test approved source commits and export generated bundles without giving the runner publication credentials.

## Security and operations

The Action and its dependencies share a process and can access its token.
Use only the permissions the workflow needs, and review the source and release files before updating the pinned SHA.
See [dependency trust](docs/dependencies.md) and [classification limits](docs/classification.md) for details.

Concurrent runs serialize per repository and item, but they do not guarantee exactly-once execution.
A comment can remain if a later closure fails.
Reopening an item alone does not exempt it from a rerun of its original event; an outcome label prevents renewed pending labeling and closure.
To roll back, pin a previously reviewed commit or disable the workflow; existing comments and closures remain.
