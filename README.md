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
```

Replace the example allowlist with the exact GitHub logins you want to skip, or omit it to review every author.
For forked pull requests, `pull_request_target` runs the trusted base-repository workflow.
Do not check out or run pull request code in this job.
mellon runs on Node 24 and requires a non-root runner.

### Modes and inputs

| Input | Default | What it does |
| --- | --- | --- |
| `token` | None | GitHub token with issue and pull request write permissions. |
| `mode` | `enforce` | `observe` labels flagged submissions; `enforce` comments and closes them. |
| `allowlist` | `[]` | JSON array of exact account logins to skip. |
| `response` | Packaged message | Literal comment text used in enforcement mode. |
| `auto-close` | `'true'` | `'false'` posts the enforcement response without closing the issue or pull request. |

Observation mode creates `mellon: review` if needed and applies it to submissions at or above the cutoff.
The label is visible to anyone who can see the issue or PR.
Observation mode does not comment or close submissions.
Existing labels keep their color and description.

For a manual review workflow, maintainers can use these optional labels:

| Label | Meaning |
| --- | --- |
| `mellon: review` | Waiting for maintainer review. |
| `mellon: checked` | Reviewed; no follow-up needed. |
| `mellon: follow-up` | Reviewed; clarification or more detail needed. |

After review, remove `mellon: review` and apply the appropriate outcome label.
Maintainers create and apply the outcome labels themselves.
Labels are public, so use them to describe next steps rather than assert authorship.

Enforcement mode posts the response and then closes a flagged submission by default.
Set `auto-close: 'false'` to post the response without closing it.
The Action reports `commented` when it confirms the response but does not close the submission.
It reuses a matching bot response on reruns rather than posting a duplicate.
Changing `auto-close` affects later runs: turning it off does not reopen a closed item, and turning it on can close an eligible open item after reusing its response.
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

The build produces the bundled Action, scorer, detector assets, metadata, and third-party notices in `dist/`.
Include those files in a release commit; the Action does not install packages or download models at runtime.

## Security and operations

The Action and its dependencies share a process and can access its token.
Use only the permissions the workflow needs, and review the source and release files before updating the pinned SHA.
See [dependency trust](docs/dependencies.md) and [classification limits](docs/classification.md) for details.

Concurrent runs serialize per repository and item, but they do not guarantee exactly-once execution.
A comment can remain if a later closure fails.
Reopening an item does not exempt it from a rerun of its original event.
To roll back, pin a previously reviewed commit or disable the workflow; existing comments and closures remain.
