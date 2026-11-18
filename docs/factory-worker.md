# Offline T3 Code worker bootstrap

This experimental bootstrap prepares a separate T3 Code environment with Pi as its provider.
It does not connect the issue factory, run coding jobs or prove publication works.
The existing host T3 Code/Pi setup stays unchanged.

## Runtime inputs

- Node 24.22.2 on an immutable Debian Bookworm image.
- T3 Code 0.1.5 from an explicitly supplied installed runtime directory.
- Pi 1.5.2 from the checked-in runtime package lock.
- `internal/factory-worker/runtime-lock.json` records the image digest, package integrity and installed T3 tree/binary hashes.

The T3 hash attests the selected local runtime.
It does not independently verify the upstream release asset signature or prove its build source.
Do not copy a user profile, authentication file or T3 state into the image.

## Run the bounded check

```sh
node internal/factory-worker/bootstrap.mjs /absolute/path/to/reviewed/t3/runtime
```

The supplied runtime must match the checked-in fingerprint.
The command checks disk headroom, prepares a private build context, builds the pinned image and runs an offline container-local smoke check.
It stops only the container it creates and preserves the image, container metadata and sanitized evidence under `.pi/artifacts/factory-worker-bootstrap/`.
It does not prune caches or delete existing resources.
Building may download the locked public dependencies; the running container has no external network or published port.

## Container boundary

The launch policy requires a non-root UID, read-only image, bounded tmpfs storage, dropped capabilities, no-new-privileges and explicit CPU/memory/PID limits.
It uses no external network, host port, bind mount, Docker socket, host agent socket or inherited credential environment.
The image has separate HOME, T3 state and Pi agent paths.

The starter discards raw T3 output because startup can print pairing material.
Only fixed stages, categories and exit codes appear in bootstrap output.
The later smoke check must use authenticated T3 procedures; a help command returning zero is not a health check.
Unauthenticated Pi status is expected while model credentials are absent.
The smoke uses T3's supported `server.updateSettings` API to enable only Pi, then checks the actual provider inventory.
T3 normalizes legacy `config.enabled` flags into the provider-instance `enabled` field; the verifier accepts that documented shape and still rejects conflicting or unexpectedly enabled providers.

## Verification scope

The policy tests exercise Docker arguments, inspect rejection and runtime tamper detection.
They do not start Docker or demonstrate T3/Pi deployment compatibility.
The live offline smoke verifies the actual container configuration, authenticated server response and Pi RPC inventory.
That inventory does not send a coding prompt or prove model authentication works.
Keep local, mocked and live-container results separate.

No model credentials, inference calls, coding threads, issue data, repository scripts, n8n activation or GitHub writes belong in this stage.
Do not reuse the GET credential-refresh pattern for uncertain mutating GitHub requests.
The production handoff still needs a private authenticated connection, worker model access, Qodo evidence and a controlled draft-PR pilot.
[Worker-only Pi model sign-in](factory-worker-auth.md) describes the separate authorization stage and its credential retention.

## Job controller

`internal/factory-worker/control.mjs` is the private, authenticated controller that n8n calls for one approved issue.
It runs only fixed T3 CLI and relay commands in its own worker and relay; it has no generic shell or Docker endpoint.

- Each job binds to the exact run ID that `t3 thread start --json` returns.
  A later or different run on the same thread blocks the job.
- The controller issues a relay grant before each model session and revokes it before any export.
- It exports only planned paths, then reviews them with Qodo outside the worker, in a fresh clone on a named local branch.
  At a detached HEAD Qodo cannot build a finding inventory, and an incomplete inventory blocks the job.
- When the review reports findings that Qodo classifies Medium, High or Critical, the controller sends those to the same T3 thread as one follow-up run.
  Low and unclassified findings never go back automatically: the gate leaves Low unchanged and forbids guessing a severity.
  It re-fences the job to the new run ID, then exports and reviews again.
  `maxFixRounds` caps this loop (default 2, at most 3), and one round carries at most 10 findings.
- A fix run that leaves the candidate unchanged, or findings left after the last round, pause the job in `awaiting_assessment`.
- An uncertain launch or send is never repeated; the job blocks for a person to reconcile.

### Scheduled builds

- Each job names its own issue, base commit and allowed paths.
  Paths must need no dist rebuild: `tests/unit|integration/*.test.mjs`, `docs/**/*.md`, `README.md` or `src/personalized/*.mjs`.
  Anything else is refused before launch.
- One job runs at a time; `blocked` and `published` jobs free the slot.
- Before launch, the controller starts the worker if a deadline stopped it, stashes any leftovers in the worker checkout, including ignored files (kept, not deleted), fetches the base commit and checks it out detached.
- A job past its deadline holds the slot in `stopping` until its grant is revoked and the worker has stopped.
- T3 may write `.factory-proposal.json` with a PR `title` and `summary`.
  It never becomes candidate content; an off-shape title or summary falls back to `chore(factory): address issue #<n>`.
- `GET /jobs/active` returns the active job, or a blocked one the scheduler has not recorded yet (`POST /jobs/<id>/acknowledge`).
- `POST /jobs/<id>/claim` takes an assessment once per review run, or publication once per job.
  A publication claim that never reaches `POST /jobs/<id>/published` blocks further publication until the owner reconciles GitHub state.

### Owner assessment

A paused job waits for its owner's decision on the remaining findings in the implementation.
The plan was already approved through the `n8n: build` label.

- `POST /jobs/<id>/assessment` uses its own `assessmentSecret`.
  The job credential cannot reach it, and the assessment credential cannot read or start jobs.
- The body names the reviewed `reviewRunId` and `candidateDigest`, then rates every open finding exactly once: `low`, `medium`, `high`, `critical` or `invalid`, with an optional note.
- `approve` publishes only when every finding is `low`, or `invalid` with a reason.
  The proposal then carries those ratings for the PR body; Qodo's reported metadata stays unchanged.
- `fix` sends only the findings marked `fix: true` back to the same T3 thread with the owner's rating and note, and asks T3 to fix each one or explain a conflict with the plan.
  It renews the coding lease, runs the usual review afterwards, and is capped by `maxOwnerFixRounds` (default 2).
- A paused job ignores the coding deadline and expires after `assessmentWindowMs` (default 24 hours).
- An assessment claim covers one pause; if a send-back leaves the candidate unchanged, the job pauses again and accepts a new form.
- `POST /jobs/<id>/publication-failed` releases a claimed publication: `policy` when nothing was written, `uncertain` only after the claim is older than `publicationClaimMs` (default 15 minutes).
  Both block the job; for `uncertain`, check the issue branch and any PR before relabeling the issue.
- Before granting model access, the controller probes T3's server inside the worker up to 45 times, 2 seconds apart (longer if probes time out); if it never answers, the job blocks as `worker_not_ready`.
