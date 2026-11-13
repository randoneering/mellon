# Isolated builds for n8n

n8n owns the coding agent and GitHub App publication credential.
The `n8n isolated build` workflow only tests an approved source commit and exports generated distribution files.
It creates no commits, PRs, labels, or comments.

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
