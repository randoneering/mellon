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

Metadata exposes `token`, `allowlist`, `response`, `mode`, `auto-close`, `review-label`, and `moderation-bot-login`; it reports safe `outcome` and optional finite `robot-score` outputs. The cutoff is intentionally not an input.

| Input | Default | Validation and use |
|---|---|---|
| `token` | None | Pass `${{ secrets.GITHUB_TOKEN }}` or a short-lived moderation App installation token explicitly for GitHub API calls; keep it secret and never print it. |
| `moderation-bot-login` | `github-actions[bot]` | Trusted expected Bot author for the supplied token. Omitted or exactly empty uses the default; otherwise one bounded login with literal `[bot]` suffix, normalized case-insensitively. Does not change authorship or avatar. |
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

## Dedicated moderation App identity

The default workflow above continues to use `GITHUB_TOKEN` and `github-actions[bot]`.
For a branded author and avatar, use a dedicated moderation GitHub App, separate
from the n8n builder App. The token determines who posts, and the App's registered
logo determines its avatar. An input or an image in the canned response cannot
change either. The existing response text and classifier policy remain unchanged.

Maintainer setup, installation, and any live branded-comment pilot require separate
approval. This example does not register or install an App or authorize live writes.

1. Register a dedicated moderation App and upload the approved mellon logo in its
   settings. Determine the actual registered bot login, for example `mellon[bot]`;
   do not assume that example is available or corresponds to your App slug.
2. Grant repository **Issues: read and write**, **Pull requests: read and write**,
   and required **Metadata: read-only** permissions. Install it only on the intended
   consumer repositories. No Contents, Actions, or workflow-write permission is
   needed for moderation.
3. Store its App ID in trusted configuration, such as a repository variable, and
   its private key in a restricted Actions secret. Limit who can edit the workflow,
   variable, and secret. Never place the key in submission text, logs, or tracked files.
4. Generate a short-lived installation token scoped to the current repository.
   Pass it through the existing `token` input together with the App's actual
   `moderation-bot-login`. Review the token-generation Action before pinning it.

The following is an intentionally unusable template. Replace both SHA placeholders
with actual reviewed full 40-character commit SHAs, choose the released Mellon
owner, and replace the example login with the installed App's actual bot login.
Do not substitute a branch or tag, invent a SHA, or execute this template unchanged.
It uses the same event scope, serialized concurrency, and trusted base-workflow
boundary as the default example, with no checkout or execution of PR code,
artifacts, or submission-controlled configuration.

```yaml
name: Branded submission moderation
on:
  issues:
    types: [opened]
  pull_request_target:
    types: [opened]
permissions: {}
concurrency:
  group: submission-moderation-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  moderate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Create repository-scoped moderation token
        id: moderation-token
        uses: actions/create-github-app-token@REPLACE_WITH_REVIEWED_40_CHARACTER_TOKEN_ACTION_SHA
        with:
          app-id: ${{ vars.MELLON_MODERATION_APP_ID }}
          private-key: ${{ secrets.MELLON_MODERATION_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}
      - uses: OWNER/mellon@REPLACE_WITH_REVIEWED_40_CHARACTER_RELEASE_SHA
        with:
          token: ${{ steps.moderation-token.outputs.token }}
          moderation-bot-login: 'mellon[bot]' # Replace with the actual installed App login.
```

Workflow `permissions` limits the workflow's `GITHUB_TOKEN`, not the separate App
installation token. The default-token workflow needs its declared issue and PR
write permissions. The App-token workflow uses the App installation's permissions
and repository scope instead; `permissions: {}` does not remove those App grants.
Keep the private key restricted and use short-lived tokens rather than a long-lived
personal token. The App token and all Actions sharing its process/job remain in
one credential trust boundary.

### Identity validation and safe migration

`moderation-bot-login` is trusted workflow configuration, never submission text,
event-author identity, a marker alone, or a workspace file. Omitted or exactly empty
values use `github-actions[bot]`. Otherwise supply one account-name portion of
1 to 39 alphanumeric or interior-hyphen characters followed by literal `[bot]`.
Matching is complete and case-insensitive, and the API author type must be exactly
`Bot`. Mellon normalizes the configured login to lowercase. Whitespace, control
characters, URLs, wildcards, lists, non-string values, and non-bot logins fail
before inference or API use. This is an expected-author assertion, not permission
to impersonate that author. A token/login mismatch does not confirm the response.

Creation validation, reuse, and ambiguous-write reconciliation share that single
identity policy. Existing comments must retain the current moderation marker;
creation responses must also match the exact posted body and valid positive ID.
After an uncertain POST, Mellon lists once to seek confirmation and does not post
a second time. Missing or failed confirmation stops further moderation writes.
This does not add stronger cross-run concurrency guarantees; keep serialization.

A Bot response with a positive ID, string body, and current marker blocks further moderation writes when its author differs from the configured identity.
Mellon does not trust that response as confirmation, even when a configured-author response also exists.
The check runs before posting, labeling, or closing, and again during uncertain-write reconciliation.
This includes switching from an App back to the default identity and a token paired with the wrong `moderation-bot-login`.
A misconfigured token can leave one unconfirmed response before reconciliation detects the mismatch; later runs stop before posting again.
User-authored comments, invalid IDs, and different markers do not establish an identity conflict.

When switching to an App, a canonical `github-actions[bot]` response reports `moderation_identity_migration_conflict`.
Other unexpected Bot authors report `moderation_identity_mismatch`.
The job summary includes fixed stage/category diagnostics and asks maintainers to check the token/login pairing.
Only an independently confirmed configured-author response retains its ID and provenance as partial work; an unexpected author never becomes confirmation.

Manually review the item and check trusted workflow configuration against the supplied token's actual Bot identity.
Retry with the default identity only when it matches the sole existing response identity and token.
Mixed-identity responses require manual review; changing configuration cannot re-author old comments.
Mellon does not edit responses or post replacements to migrate them.
Another Bot can copy the current marker and cause this manual-review stop, but cannot authorize further writes.
There is no historical scan, automatic migration, or multi-identity trust list.
Live author/avatar behavior must be verified separately with maintainer approval; mocked tests cannot prove it.
