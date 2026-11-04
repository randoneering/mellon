# Workflow configuration

Mellon reads policy from trusted GitHub Actions workflow inputs. Node 24 is provided by GitHub; consumers do not install packages or run a CLI. The example release SHA is intentionally unusable until a maintainer publishes and reviews a release and substitutes its actual immutable commit SHA.

```yaml
name: Submission moderation
on:
  issues:
    types: [opened]
  pull_request_target:
    types: [opened]
permissions:
  issues: write
  pull-requests: write
concurrency:
  group: submission-moderation-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  moderate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: OWNER/mellon@REPLACE_WITH_REVIEWED_40_CHARACTER_RELEASE_SHA
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          allowlist: '["trusted-account", "dependabot[bot]"]'
          # Omit response to use the packaged human-voice message.
          # Add mode: observe to label without commenting or closing.
          review-label: 'true'
```

The supported events are only `issues.opened` and `pull_request_target.opened`. Ordinary `pull_request` and all other event actions skip without requiring a token or starting inference. The Action binds the event repository to `GITHUB_REPOSITORY`, uses only the positive item number and author login from a supported payload, and does not address APIs using payload URLs. A malformed supported event fails before moderation. Event JSON is limited to 4 MiB of valid UTF-8. The current runtime uses Node 24 on maintained Linux runners and rejects UID 0 before inference or API operations.

## Inputs

Metadata exposes `token`, `allowlist`, `response`, `mode`, `auto-close`, and `review-label`; it reports safe `outcome` and optional finite `robot-score` outputs. The cutoff is intentionally not an input.

| Input | Default | Validation and use |
|---|---|---|
| `token` | None | Pass `${{ secrets.GITHUB_TOKEN }}` explicitly for GitHub API calls; keep it secret and never print it. |
| `allowlist` | Empty JSON array `[]` | JSON array of exact account logins. Case-insensitive equality only, including explicitly named bot accounts; no wildcards or implicit role exemptions. |
| `response` | Packaged human-voice message | Literal, nonempty UTF-8 text, at most 32 KiB. No interpolation or template evaluation. Used only in enforce mode. |
| `mode` | `enforce` | Exact value `enforce` or `observe`. The input is trusted Action configuration, never submission content. |
| `auto-close` | `'true'` | Exact string `'true'` or `'false'`. In `enforce`, `'false'` posts the response without closing the item; observe mode does not comment or close either way. |
| `review-label` | `'true'` | Exact string `'true'` or `'false'`. Shared across modes; `'false'` disables automatic labels. |

For GitHub Actions, an empty allowlist input uses the default empty list, and an empty response input uses the packaged response. Malformed nonempty policy values fail before inference or writes. Do not supply a cutoff, API host, model path, executable path, or configuration-file input. The cutoff remains fixed at inclusive unrounded `0.80`. In `enforce`, Mellon confirms its response, applies `mellon: review` by default, then follows the existing `auto-close` setting. Setting `auto-close: 'false'` keeps the response but skips closure; a confirmed response-only result has outcome `commented`. If pending review-label creation or application cannot be confirmed, Mellon reports the confirmed response as partial work and does not close the item. Retries reconcile GitHub's current label state before further writes and reuse a matching confirmed response rather than blindly reposting it. `observe` applies only the fixed `mellon: review` label at or above cutoff by default, with no comment or closure. Set `review-label: 'false'` to disable automatic labeling in either mode; observe mode still reports flagged submissions without GitHub reads or writes. Labels can be publicly visible; Mellon creates the pending label on demand and attempts to create the three manual outcome labels, preserving existing metadata.
Outcome-label provisioning failures do not block moderation.
An existing outcome label prevents renewed pending labeling and closure, including when automatic labeling is disabled; unreadable outcome labels stop those writes safely.
See [label workflow and metrics](moderation.md#label-workflow) for manual review and retry limits. The Action does not scan or alter past items. Submission text, workspace files, and `.mellon.json` cannot set policy.

The default response welcomes AI-assisted code while asking contributors to describe the work in their own words, explains that automated classification can be mistaken, and points contributors to maintainers. The score is not proof of authorship, understanding, or contribution quality. Issue and PR calibration is unvalidated; the cutoff is a repository policy threshold, not a calibrated authorship probability. Historical dataset evaluation and calibration remain separate follow-up work.

Changing `auto-close` only affects a later run. Setting it to `'false'` does not reopen items already closed. Setting it to `'true'` can close an eligible open item without an outcome label after Mellon reuses its matching bot response. Mellon does not duplicate a confirmed matching response on reruns.

## Permissions and trust

Grant only `issues: write` and `pull-requests: write` for comment/close operations and labels (GitHub's labels API applies to issues, including pull requests). `contents: read` is not needed. The `pull_request_target` workflow runs trusted workflow code for fork contributions: never check out or execute PR code, artifacts, or submission-controlled configuration. The private source Action repository must be accessible to the target repository's workflow runner at the pinned owner/name and commit SHA. The Action and dependencies share one Node process and token trust boundary; they are not sandboxed from credentials. Pin a reviewed release to its actual immutable commit SHA after publication; do not use the placeholder as an installable revision. Upgrade by reviewing and pinning a new release SHA. Roll back by restoring a previous reviewed SHA or disabling the workflow; rollback does not delete responses or automatically reopen items.
