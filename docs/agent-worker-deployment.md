# Worker operational approval checklist

Local implementation and tests do not authorize production changes.
Keep the worker flag and schedule false until the corresponding approvals below are explicit.
No live queue-to-PR pilot is claimed from mocks, historical API metadata or local PostgreSQL.

## Review packet

Before any execution, present the exact reviewed source snapshot, production branch identity, resource IDs and private configuration hashes.
Exclude unrelated files and all ignored OpenSpec/private artifacts from the PR.
Commits must be signed; commits, pushes and GitHub writes need their own approval.

The packet includes:

- `migrations/agent-worker/001-initial.sql`, `002-recovery.sql`, `003-coordinator.sql` and their exact hashes.
- The dedicated login role and minimum schema/table/sequence grants; no ownership, intake writes, delete/truncate, schema creation, memberships or administration.
- Private config/manifest/policy/source pins and the exact worker-only database, App and model bindings.
- App reader, commit and PR scopes from the [broker contract](agent-worker-github-app.md).
- Sol/high `conservative-bytes-v1`, 60 KiB rendered input, at most 65,536 input reservation per call, 100,000 input reservation per run, 2,000 output per call, 20 calls and two repairs.
- An explicit provider-level spend ceiling and available balance; input allowances do not promise exact token or dollar cost.
- The existing GitHub Qodo integration and the approved submitted-review boundary.
- Complete deploy effects on retained intake/Auth and a disabled schedule.

## Ordered gates

| Gate | Required approval/evidence |
| --- | --- |
| Reviewed release | Exact source/PR snapshot and final test counts; signed commit/push only when authorized |
| Deployment plan | Schema, production grants, worker secret changes and full-config effects reviewed explicitly |
| Disabled deployment | Apply only the approved schema/role/Function changes; verify intake/Auth and worker isolation |
| Live preflight | Separately authorize generation, App signing/publication and a controlled draft/review check; verify actual model/tools/usage/spend, TLS, native ingress and updated-head review |
| Pilot selection | Approve one issue, content hash, criteria, paths, checks, identity/profile pins, budget and private manifest; never silently consume the previously queued issue |
| One-run activation | Explicitly enable only the approved production worker/schedule and observe one run or a fixed blocker |
| Shutdown record | Disable further processing; record exact confirmed references, checks, interventions, usage and blockers without private text |

Use the [runtime contract](agent-worker-runtime.md) to bind the real preflight evidence to its plan and credentials.
Version-3 first-run startup evidence covers infrastructure only; production acceptance still requires the separately gated command, exact-head review, current CI and human authorization path.
Do not fill any record from unit-test fixtures or mark checks true merely because credentials exist.
The existing Gateway count-route probe did not generate text and does not replace model/tool/spend preflight.

## Safe stop

Disable both future scheduling and worker enablement.
Already accepted remote work may still complete; reconcile uncertain operations before any recovery decision.
Retain metadata and the owned branch/PR.
Do not drop schema objects, delete branches, reset user work, widen permissions, merge or requeue automatically.
