# Submission moderation

Mellon processes only supported issue and `pull_request_target` opening events.
It prepares the opening title and body, then lazily runs the bundled local classifier for eligible, nonempty submissions.
A score below the fixed `0.80` cutoff leaves GitHub unchanged.
The default `enforce` mode confirms a moderation response, applies `mellon: review` by default, then follows `auto-close`.
Explicit `observe` mode applies only the pending label and never comments or closes.

The default response welcomes AI-assisted code while asking contributors to describe the work in their own words.
The score is fallible and is not proof of authorship, code quality, or understanding.
The model was trained on code comments and has not been calibrated for issues or pull requests.
The `0.80` cutoff is a repository policy threshold, not a calibrated authorship probability.

## Label workflow

| Label | Applied by | Meaning |
| --- | --- | --- |
| `mellon: review` | Mellon, in either mode | Flagged and waiting for maintainer review. |
| `mellon: reviewed-human` | Maintainer | Assesses the description as human-like. |
| `mellon: reviewed-ai` | Maintainer | Assesses the description as AI-like. |
| `mellon: reviewed-unsure` | Maintainer | Cannot confidently assess the description. |

When automatic labeling is enabled and an eligible item is flagged, Mellon attempts to create missing outcome labels with distinct colors and short descriptions.
Existing repository labels keep their metadata.
Creation races and uncertain writes are reconciled with at most three create attempts per outcome label.
Outcome-label setup failures do not block comments, pending labeling, or closure.
When setup cannot be confirmed, the run result records incomplete setup and the job summary asks maintainers to create missing review outcome labels manually.
This notice contains no API response details, credentials, or submission text.
It does not change the moderation outcome or published Action outputs.
Mellon never applies an outcome label.

After review, remove `mellon: review` and apply exactly one outcome label.
Labels describe a maintainer's fallible assessment of the text, not the contributor or verified authorship.
Labels are visible to anyone who can see the item.
Mellon handles only opening events, so the review-to-outcome swap is manual.
It does not react to label changes, enforce exclusivity, or change historical items.
Retired labels remain untouched; maintainers can replace them manually after review.

| Pending search | Typical use |
| --- | --- |
| `is:open label:"mellon: review"` | Observe or enforce with `auto-close: 'false'`. |
| `is:closed label:"mellon: review"` | Default enforce mode. |
| `label:"mellon: review"` | Both states, after removing the default `is:open` filter. |

Manual closes and reopens can move pending items between states, so check both queues.

## Review metrics

Count items across open and closed states using the labels alone.
Let `P` count `mellon: review`, `H` count `mellon: reviewed-human`, `A` count `mellon: reviewed-ai`, and `U` count `mellon: reviewed-unsure`.

| Metric | Formula |
| --- | --- |
| Pending | `P` |
| Total flagged | `P + H + A + U` |
| Reviewer-assessed precision | `A / (A + H)` |
| Unsure-inclusive lower bound | `A / (A + H + U)` |

Report `U` separately rather than including unsure assessments in the usual precision denominator.
The lower-bound calculation counts every unsure as a miss, relative to the maintainer assessments.
If a denominator is zero, report the corresponding metric as unavailable rather than zero.
For example, `P = 4`, `H = 2`, `A = 6`, and `U = 2` gives 14 flagged items, 4 pending, 75% assessed precision, and a 60% unsure-inclusive lower bound.

These counts assume every flagged item retains exactly one pending or outcome label.
Leaving `review` alongside an outcome, applying multiple outcomes, removing labels without replacement, or labeling unflagged items distorts the counts.
Manual labels cannot enforce this invariant.

Metrics describe maintainer assessments of reviewed flagged text, not verified authorship or guaranteed classifier accuracy.
Reviewer error and selection bias can affect them; pending items are excluded from both precision calculations.
Only items at or above the fixed `0.80` cutoff are automatically labeled, so these labels cannot measure recall or missed detections below the cutoff.
Labels do not record the score or mode, so counts alone cannot split results by `observe` and `enforce` or compare score ranges.
Setting `review-label: 'false'` stops automatic label-based metrics for subsequent runs; existing labels remain.

## Inputs

| Input | Default | Effect |
| --- | --- | --- |
| `token` | None | Token with issue and pull request write permissions for API operations. |
| `mode` | `enforce` | `observe` labels only; `enforce` confirms a response and follows `auto-close`. |
| `allowlist` | `[]` | JSON array of exact account logins to skip. |
| `response` | Packaged message | Literal enforcement comment text; empty selects the packaged message. |
| `auto-close` | `'true'` | `'false'` keeps the enforcement response without closing. |
| `review-label` | `'true'` | `'false'` disables automatic label creation and application in both modes. |

Disabling automatic labels also disables automatic label-based metrics.
Observe mode with labeling disabled reports flagged submissions without GitHub reads or writes.
Enforce mode still checks existing outcome labels before closure even when automatic labeling is disabled.
See [workflow configuration](configuration.md) for validation and limits.

## Writes and reruns

A response must exist before Mellon requests closure.
When automatic labeling is enabled, Mellon must confirm the pending review label before closure.
If pending-label creation or application fails or remains uncertain after reconciliation, Mellon reports the confirmed response as partial work and does not close the item.
Optional outcome-label creation does not gate closure.

Mellon checks current state and content before item writes, and checks current outcome labels before pending-label writes, their retries, and closure.
Any outcome label marks the review complete and prevents renewed pending labeling or closure, even if the pending label is also present or automatic labeling is disabled.
These checks ignore capitalization, matching GitHub's label identity rules without renaming existing labels.
Unreadable or malformed outcome-label state stops the affected pending-label or closure action safely.
Outcome labels do not suppress an enforcement response when no matching bot response exists.

Mellon binds a response marker to repository, item, prepared-input hash, detector revision, and model hash.
On reruns it reuses a matching response only when GitHub reports a positive comment ID and server-authored `github-actions[bot]` identity with type `Bot`.
A contributor-written matching marker never suppresses the response.
If comment creation fails ambiguously, Mellon lists comments once to reconcile it.
If no matching response can be confirmed, Mellon stops without reposting or closing.
Label writes are also reconciled against current GitHub state before retries.
A failed close or a stale state after posting leaves the response in place and reports partial work rather than claiming closure.
API errors never include raw response bodies or submitted text.

Serialized workflow runs reduce ordinary duplicate writes, but concurrent runs and human edits cannot be made atomic with GitHub's separate reads and writes.
A maintainer can change labels after a check; exactly-once behavior is not guaranteed.
A manual reopen alone is not an exemption: rerunning the original event can close an unchanged item without an outcome label when `auto-close` is `'true'`.
Setting `auto-close: 'false'` does not reopen closed items.
Enabling closure on a later run can close an eligible open item without an outcome label after reusing its response.
Mellon does not automatically process edits, reopenings, or later discussion.

The API client uses only `https://api.github.com` with trusted runner repository and item identity.
It bounds request duration and response sizes, rejects redirects, validates same-resource pagination, and uses bounded label-write retries.
Labels use GitHub's issues-labels endpoint for both issues and pull requests.
The configured permissions remain `issues: write` and `pull-requests: write`.
The Action and its packaged dependencies share a process and credential trust boundary; they are not sandboxed from its token.
