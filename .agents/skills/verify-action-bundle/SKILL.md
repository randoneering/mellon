---
name: verify-action-bundle
description: Verify that Mellon's committed dist/ can be reproduced from a specific trusted revision. Use after changing Action source or detector assets, or when review flags a stale generated bundle.
---

# Verify the packaged Action

Use the revision that will ship, including any separate generated-file commit. Ask for the intended revision if it is ambiguous or unavailable locally. Use Node 24, npm, Git and GNU diffutils on Linux. Run reviewed project build code in an ordinary development environment. Keep fork code out of privileged moderation workflows.

1. From the Mellon repository root, resolve the supplied revision to a commit. Record the task or PR, the SHA and the Node version. If checking a CI complaint on an earlier revision, check that revision separately and label its evidence with its own SHA.
2. Run the following in Bash with `revision` set to the supplied Git revision. Use the same shell for the whole block. It creates a disposable checkout and starts the build with an empty output path so an obsolete committed file cannot survive unnoticed.

   ```bash
   (
     set -eu
     sha=$(git rev-parse --verify --end-of-options "${revision:?supply a revision}^{commit}")
     node -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1)'
     run=$(mktemp -d)
     echo "Evidence directory: $run"
     echo "Revision: $sha"
     node --version
     git worktree add --quiet --detach "$run/checkout" "$sha"
     cd "$run/checkout"
     mv dist "$run/committed-dist"
     npm ci --ignore-scripts
     npm ci --prefix detector --ignore-scripts
     npm run build
     test -f dist/index.mjs
     sha256sum "$run/committed-dist/index.mjs" dist/index.mjs
     diff -qr --no-dereference "$run/committed-dist" dist > "$run/dist.diff" || {
       result=$?
       cat "$run/dist.diff"
       exit "$result"
     }
     echo "PASS: rebuilt dist matches committed dist"
   )
   ```

3. Save the command transcript, exit status and `dist.diff` with the task evidence. A passing run has a successful build, identical entrypoint hashes and an empty whole-directory diff. A diff exit of 1 means a changed, missing or extra file; record its path. Other errors (including an install or build failure) leave verification incomplete. If the commit is source-only, ask which generated-file revision is intended for publication before proposing a fix.
4. Remove only the disposable checkout you just created with `git worktree remove --force "$run/checkout"`, substituting the printed evidence directory for `$run` in the calling shell. Keep the transcript and diff for the report. Report Qodo review separately from this byte comparison.
