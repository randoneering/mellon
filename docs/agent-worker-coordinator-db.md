# Configured Function coordinator database acceptance

Run the explicit disposable database lane with Node 24 and Docker:

```sh
npm run test:worker:coordinator:db
# Equivalent: node scripts/test-agent-intake-db.mjs --suite coordinator
```

The runner accepts only the static `intake`, `worker`, `journal`, and `coordinator` file map.
It starts the existing digest-pinned Postgres image with loopback-only publishing, memory-backed storage, resource limits, marker probes, bounded child execution, credential scrubbing, and container teardown.
The helper verifies the fresh-container marker before migrations 001/002/003 or grants.
It never falls back to `DATABASE_URL` or accepts an external database.

## Evidence boundaries

| Component | Exercised behavior |
| --- | --- |
| Configured Function | Actual `createWorkerFunction(...).fetch(request)`, SDK delivery parsing, route/method/header checks, activation gates, closed delivery and status-only HTTP responses |
| Coordinator | Actual `createCoordinator(...).advanceTick`, one phase per tick, original claim deadlines, persistent claims, budgets, waits, repairs, human stops, recovery |
| Database | Actual `pg` driver, migrations 001/002/003, transactions, constraints, model receipts, immutable candidate descriptors and run/event metadata |
| Runtime role | Separate password-authenticated connection as `coordinator_test_runtime`; matching `session_user` and `current_user`; wrong password rejection; least-privilege grants and denied writes |
| Default components | Actual approval, policy, immutable repository, discovery, check reader, current unsupported review reader, Agent, candidate, recovery and publisher implementations |
| Instrumentation | Store wrappers forward every call to the real driver-backed store; Agent wrapper records the actual loaded context; optional reader wrappers delay only delivery of real authenticated results |
| GitHub/model | Synthetic fixed API responses, signed-proof fixtures, App issuance records, SDK responses, tokenizer counts and usage; no live provider or App |
| Future review completion | Explicitly synthetic private future Qodo adapter; not an observed Qodo completion contract |

The Function's strict `sslmode=verify-full` environment check uses a synthetic URL while the injected local PostgreSQL pool uses loopback TCP without TLS.
This proves configuration validation and local role isolation, not a TLS handshake, deployed pool wiring, production grants, native ingress attestation, real App issuance/signing, Gateway tokenization, live Qodo completion, or live queue-to-draft acceptance.
No deployment or activation occurs.

All proposed source comes from fixed trusted fixtures.
The suite never executes generated/model source to manufacture native evidence.
Synthetic GitHub V2 reports retain all six producer hashes, immutable formatter pin, current run/head/App/event/job bindings, and the reviewed skip policy.
Those synthetic reports do not prove real GitHub test execution.

## Coverage

Six stable top-level groups contain all actual-database cases.
Ordinary discovery sees six guarded skips when disposable-database credentials are absent.
No suite is hidden from `npm test`.

- Initial claim, journal initialization, one regression model/commit, authenticated exact RED, implementation model/commit, green checks, one draft and review.
- Durable invocation deduplication, overlapping claims, one pilot, model reservations, actual usage receipts, call/input/output budgets, and no-model waits with lease release.
- Confirmed wait parent versus current child, new model-phase child binding, database-authored wait retention and expiry, criterion/native association, complete immutable prepared files with ancestors, and distinct prepared/allowed-path indices.
- Shared CI and explicitly synthetic future Qodo repair reservations, same-phase investigation/candidate binding, two regression-first repairs, six total commits, repeated checks/review on the same draft, and third-repair stop.
- Structured false-positive, scope-change and insufficient-evidence human stops; unassociated assertions; unsupported real review completion; provider uncertainty without fallback.
- Real transaction acknowledgment faults before/after model reservation/outcome, candidate intent, branch/commit/draft fence, confirmation and checkpoint boundaries.
- New Function/coordinator/store instances reconcile exact durable pending operations before any model; absent candidates and recorded-success-without-candidate stop for humans without blind replay.
- Lost synthetic branch/commit/draft HTTP acknowledgments, stale owners, SQL-server deadline expiry after an entered await, and separately labeled controlled-local-clock expiry after model entry.
- Approval revocation before model and immediately before each branch/commit/draft write, with no later model or write.
- Ten-second configured waits expire only after the real check/review reader returns, a synthetic future review returns, or final fresh authority returns.
  Controlled local-clock advances cross the durable wait deadline without crossing the original 90-second claim deadline.
  Late CI/Qodo findings never reach repair reservation.
- Separate owner-only SQL fault setup expires waits after actual evidence reads while the application clock stays cached.
  PostgreSQL rejects phase, repair and readiness writes without changing references, counters, terminal events or lease ownership.
- Exact head/workflow/run/check/digest references persist with RED-to-implementation, green-to-draft/review, CI/Qodo repair reservation and both third-repair stops.
  An independent oracle derives IDs and check-set digests from controlled API packets, never database rows or the production evidence builder.
  These hashes bind complete safe run/check metadata; they do not authenticate evidence independently or store raw reports.
- Synthetic future readiness performs one evidence-bearing terminal UPDATE and lease clear with no preceding checkpoint.
  A separate connection sees the old state/references before COMMIT.
  Lost acknowledgments before/after actual COMMIT prove rollback or complete terminal/reference persistence; restart produces one terminal event and no duplicate effects.
- Missing/partial evidence, stale real ownership, mismatched heads, unsafe IDs and uppercase hashes deny readiness without partial references or lease clearing.
  Real SQL constraints reject partial evidence and invalid readiness; catalog checks confirm the four nullable typed evidence columns and unchanged table inventory.
- `getRun` and snapshot projections expose only safe metadata and complete six-field evidence.
  Review IDs appear only when the stored review head matches the check head.
  Real PostgreSQL bigint-string references survive same-phase polling and restart through both repair rounds without resetting wait start.

Timeouts do not prove cancellation of already-issued SQL or HTTP.
Owner-only fault setup and teardown target only known fixture job/run identities.
No table reset, broad deletion, descriptor mutation grant or intake write grant is used by the runtime role.
Shared diagnostic assertions compare booleans and omit connection URLs, passwords, markers, lease tokens, App/model credentials and private contexts.

## Current verification and blockers

All 81 baseline tests remain, with 32 added nested acceptance cases and six unchanged top-level group names.
The first expanded run is RED: 101/110 pass and 9 fail, plus 3/3 marker guards.
Five nested failures and four aggregate group failures identify an overbroad test privacy regex that mistakes token-budget counters for credentials.
Replacing that regex with an exact safe-field allowlist produces 110/110 GREEN; the final additions produce 113/113 GREEN.
No production fix or relaxed behavior assertion is needed.

| Final command | Observed result |
| --- | --- |
| `npm run test:worker:coordinator:db` | 113/113 pass, plus 3/3 marker guards |
| `node scripts/test-agent-intake-db.mjs --suite journal` | 96/96 pass, plus 3/3 marker guards |
| `node scripts/test-agent-intake-db.mjs --suite worker` | 130/130 pass, plus 3/3 marker guards |
| `node --test scripts/tests/agent-worker-db.test.mjs` | 4/4 registration/command guards pass |
| `npm test` | Final release pass: 1,125 tests, 1,063 pass, 62 skip, 0 fail |

No local acceptance case remains RED.
The parent independently reruns 113 tests plus 3 guards, inspects the frozen source, and confirms its six native identity hashes before explicitly extending the policy to 62 entries.
The current policy digest is `bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab`.
Release checks, independent review, deployed credentials/TLS, native trigger attestation, live model/GitHub behavior and live Qodo completion remain outside this local proof.
The actual default Qodo reader still cannot authorize readiness.
OpenSpec checkboxes remain open; the parent owns final release and acceptance.

## Source review status

**FROZEN after 113/113 actual-database tests pass.**
The test source SHA-256 is `94e2765707bfbcaeb601ae1ce96104c8a10f45cd0fbcaf0cd74762ef7d86b89e`.
The helper SHA-256 is `fc44cabedde85469f367894f5836e21817d776913b3ef2945b6c35de48181409`.
The controlled transport SHA-256 is `83cfd6ec21abf95830e8fc5aa9fdce2093297567239a936e2c3973f6f7d93c4e`.
The parent corrects its synthetic report totals from 56 to 62 skips during the explicit policy migration; the frozen test source and production validators remain unchanged.
The affected actual-database suite passes 113 tests plus 3 guards after that correction.
Do not edit the frozen source or update the policy without parent review.

The actual Node 24 native reporter confirms all six identities below.
Each has entry file `tests/integration/agent-worker-coordinator.test.mjs`, column `1`, nesting `0`, and type `test`.

| Line | Full literal name | Native identity SHA-256 |
| --- | --- | --- |
| 127 | coordinator DB: authenticated restricted role and configured Function ingress guards | `09d72ef105de01bfaf403c942a714a28bc82bc304e57019e8af60c22cfb29c0e` |
| 193 | coordinator DB: initial regression lifecycle, durable claims and no-model waits | `de02bcac3413af36f31b898cb4b37fa479053ed0cabe5b9ce8e760fb219ffcf0` |
| 318 | coordinator DB: authenticated CI gates and actual unsupported review never authorize readiness | `b0aaf0ddd3b557c44782ff485a1e836430e404a1c62d5183e603ab37c591093b` |
| 504 | coordinator DB: shared CI and synthetic future Qodo repairs retain phase and single draft identity | `194abf4587f35bbf8c037012ed12c1eaf3dd0ef55d1cf5fada8b4263c094bbe3` |
| 574 | coordinator DB: real transaction acknowledgment loss and restart never blindly replay effects | `d62fca6fcda07658e44eb3ae4ac26d731deb7e6a0f02c5e1a7abda74fc9d3a17` |
| 737 | coordinator DB: stale ownership, revocation and human stops prevent later model or publication | `054c8cebc9f59c0f5b3df8645b83269d4869f288e4773579ff095bfcc8711916` |

Before the explicit parent extension, the 56-entry policy rejects this complete six-skip native report, as intended.
The reviewed 62-entry policy now accepts only these exact additional identities; future changes still require review.
A separately labeled synthetic comparison using already-reviewed identities remains a boundary control.
The combined raw skip count is 62, below the reporter's 64-identity limit.

The frozen journal source remains SHA-256 `1f766fa870fce783d739242bace954427e6081b2d5d1b97ce1db239a75a2d71a`.
The frozen legacy worker source remains SHA-256 `fed4a38c547aa52f7aa891f79ad79ac323fb2db2dd67b4412428238479f996bb`.
The reviewed policy digest is `bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab`.
