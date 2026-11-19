# Release, security, and rollback

## Release checklist

1. Use Node 24 and the repository lockfile. Install dependencies only in the build job.
2. Run the README checks, including asset verification, tests, parity, `npm run build`, and release validation.
3. Commit `dist/index.mjs`, `dist/scorer.mjs`, `dist/detector/` provenance/assets, `dist/build-meta.json`, and `dist/THIRD_PARTY_NOTICES.txt` with the reviewed source.
4. Confirm workflow and bundle checks passed on the exact release commit.
5. Review the Release Drafter notes and suggested version.
6. Review the target commit, passing CI run, and generated files before publishing.
7. If publishing to Marketplace, follow the publication steps below and review metadata warnings.
8. Pin consumers to the actual reviewed release commit, not a mutable branch, tag, or unrelated SHA.

## Prepare a release

Use Node 24 and the repository lockfile. Install dependencies only in the build job, run the checks in the README, and build with `npm run build`. Commit the generated `dist/index.mjs`, `dist/scorer.mjs`, `dist/detector/` provenance/assets, `dist/build-meta.json`, and `dist/THIRD_PARTY_NOTICES.txt` with the reviewed source. Do not publish a release until the exact commit has passed workflow and bundle checks. The consumer action runs packaged files and does not install npm dependencies, fetch a model, or require Go or Docker.

CI rebuilds `dist/` and fails if tracked or untracked distribution files differ from the checkout.
Release Drafter updates a draft on pushes to `main`; it does not publish releases.
Its suggested version depends on PR labels and previous releases, so check it before publishing.
Review the notes, the target commit, the passing CI run, and the generated files first.

To list mellon in GitHub Marketplace, open `action.yml` on GitHub and choose **Draft a release**.
Select **Publish this Action to the GitHub Marketplace**, accept the Marketplace Developer Agreement if prompted, and choose a category.
Review any metadata warnings before publishing.
GitHub requires two-factor authentication for publication.
See [GitHub's publishing guide](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).
Creating a draft alone does not publish the Action to Marketplace.

A consumer workflow must pin the actual reviewed release commit, not a mutable branch, tag, or a SHA copied from an unrelated commit.
The example deliberately uses `REPLACE_WITH_REVIEWED_40_CHARACTER_RELEASE_SHA`; it is not an installable revision.
Never claim a release exists before publication.

## Security boundary

The supported runtime is Node 24 on maintained Linux runners. UID zero causes a safe failure before classification or GitHub operations; do not add sudo, root bootstraps, or privilege changes. The Action, Markdown parser, inference code, and runtime dependencies share one process and the token's trust boundary. Dependencies are not isolated from the credential. The `pull_request_target` workflow must not check out the consumer repository or execute PR-controlled source, artifacts, or policy files.

The default response welcomes AI-assisted code and asks contributors to describe work in their own words. The score is a fallible signal, not proof of authorship, understanding, or quality. Issue and PR calibration has not been validated; `0.80` is a fixed moderation policy cutoff, not a calibrated authorship probability. Historical evaluation and training are separate follow-up work.

## Upgrade and rollback

To upgrade, review the source and dependency lock changes, run asset verification, all tests, parity and release validation, build the bundle, then publish and pin the resulting commit. Keep the prior reviewed immutable commit available for rollback. To roll back, update the workflow to the prior reviewed SHA or disable the workflow. Rollback does not remove an existing response or reopen a closed issue or pull request. An operator must review and reopen manually if needed.

Serialized retries help avoid duplicate responses, but GitHub writes are separate and are not exactly-once. If a response is confirmed but closure fails, the response remains and the workflow fails safely. Rerunning an unchanged opening event after a manual reopen can close it again; Mellon does not persist manual reopen as a bypass.
