# Coordinator journal database checks

Run the actual Postgres suite with Node 24 and Docker:

```sh
npm run test:worker:journal:db
```

The runner accepts only the static `intake`, `worker`, and `journal` suites.
`journal` selects `tests/integration/agent-worker-journal.test.mjs`; callers cannot supply paths or commands.
The existing pinned image, fresh loopback-only memory-backed container, marker probes, credential scrubbing, and container cleanup stay unchanged.
Each test child has a 120000ms timeout; each Docker command has a 60000ms timeout.
No external database, deployment, provider, or GitHub service is required.

## Database boundary

`tests/support/agent-worker-journal-database.mjs` calls the existing marker-verifying `openDisposablePool` before migrations or grants.
The first group rejects a wrong marker and checks that neither application schema nor the journal runtime role exists yet.
Only the verified owner fixture applies intake 001 and worker 001/002/003.
These are test-fixture grants, not evidence of deployed grants.

The actual `pg` driver authenticates as `journal_test_runtime`, using an ephemeral password.
Both `current_user` and `session_user` equal that restricted role.
It has no administrative flags, role memberships, table ownership, schema ownership, or schema/database CREATE permission.

| Table | Runtime privileges |
| --- | --- |
| `agent_intake.jobs` | SELECT |
| `agent_worker.runs`, `agent_worker.operations` | SELECT, INSERT, UPDATE |
| `agent_worker.events`, `agent_worker.candidate_descriptors` | SELECT, INSERT |

The fixture grants worker sequence USAGE and SELECT for event identities.
Tests check every listed table for denied DELETE, TRUNCATE, REFERENCES, and TRIGGER privileges, plus the applicable denied UPDATE/INSERT privileges.
Actual forbidden descriptor and intake writes fail with `42501`.
Owner-level descriptor updates/deletes also fail through immutable triggers.
Cleanup cancels only run IDs created by that fixture; the existing runner discards the container.
No table reset, shared-data cleanup, or destructive unbounded SQL is used.
Driver diagnostics expose only fixed messages, SQLSTATEs, and constraint names.

## What runs against Postgres

- Legacy snapshots after 003, legal initialization, canonical phase identity, and rejected forged purposes, transitions, versions, parents, regression metadata, criteria, rounds, and caller timestamps.
- Atomic model reservation/counters/events, recorded success, candidate intent/descriptors/pending reference, same-run/model-phase/parent/round/purpose ownership, and immutable identity/outcome/descriptor triggers.
- One and ten descriptors, 65536-byte files, 262144-byte aggregates, duplicate approved indexes, malformed descriptors, partial regression tuples, and missing regression criteria.
- Commit-time rejection of absent/forged descriptor counts, excess aggregate bytes, wrong model purpose/round, unresolved or recorded-uncertain model outcomes, and descriptors attached to model or legacy operations.
  Deferred cases first execute the transaction body successfully, then assert that actual COMMIT fails and no candidate remains.
- Exact 003 unique-index rejection, with legacy generation/parent index keys changed so an older index cannot supply the asserted failure.
- Regression, implementation, and draft confirmation select `waiting_red_ci`, `waiting_ci`, and `waiting_review` from persisted purpose.
  Repeated confirmation and same-phase polling retain the database wait start and phase start across lease generations; a new-head phase resets its wait start.
- Acknowledgment loss before and after real COMMIT for checkpoint, model reservation, model outcome, candidate intent, effect fence, confirmation, and repair reservation.
  Reloads distinguish rollback from committed state; retries retain identity, block rekeying, and reconcile attempted effects without a new execute decision.
- Pending-effect model blocking, lost-successful-candidate human stops, unresolved-model stops, stale generations, expired leases/ticks/runs, and rejected expired effect fences.
  An exact immutable outcome replay returns `existing` without writing, including for an expired owner.
- CI/Qodo repair deduplication, finding rekey rejection, shared counter 1/2, lease release, third-repair stop, repaired regression/implementation waits, and reuse of the existing draft.

The recovery case uses the real store, recovery coordinator, publisher, and Postgres role.
Only GitHub responses and local approval/signing context are synthetic; GitHub write acknowledgments are lost in that transport fixture.
Database acknowledgment injection wraps real driver transactions and changes only acknowledgment delivery.
No scripted SQL response fixture substitutes for Postgres.
Model success is recorded through the store API; no model provider is called.

## Observed verification

| Command | Observed result | Child duration |
| --- | --- | --- |
| `node scripts/test-agent-intake-db.mjs --suite journal` | 96/96 tests, plus 3/3 marker guards; exit 0 | 11691.474ms + 214.561ms guards |
| `node scripts/test-agent-intake-db.mjs --suite worker` | 130/130 legacy tests, plus 3/3 marker guards; exit 0 | 11526.021ms + 218.768ms guards |
| `node scripts/test-agent-intake-db.mjs --suite intake` | 7/7 legacy tests, plus 3/3 marker guards; exit 0 | 642.136ms + 217.128ms guards |
| `node --test scripts/tests/agent-worker-db.test.mjs` | 4/4 runner checks; exit 0 | 363.135ms |
| `node --test tests/unit/agent-worker-journal*.test.mjs` | 71/71 unit tests; exit 0; scripted SQL/mocked transport only | 268.188ms |
| `node --test tests/integration/agent-worker-journal.test.mjs` | 8 visible guarded skips without DB variables; exit 0 | 148.773ms |
| `npm test` | 1068 tests: 1012 pass, 56 skip, 0 fail; exit 0 | 49905.684ms |
| Synthetic GitHub-mode `npm test` | 1072 tests: 1016 pass, 56 skip, 0 fail; producer exit 0 | No timeout |

Counts for ordinary discovery reflect separate shared-tree snapshots.
No listed command times out.
The runner registration checks reject the old enum/usage before the additive selection is added, then pass.
Initial database runs expose fixture expectation errors: anchored Error matching, immutable replay status, the `reconcile_only` decision name, and older indexes masking new-index assertions.
Those corrections do not change production code or relax constraints/grants.
No 003 production defect is observed in the final actual-database cases.
The legacy 130 cases still apply only migrations 001/002 and do not prove 003 behavior.

Before parent review, the 48-entry policy rejects the eight new identities at the trusted report consumer, as intended.
The parent independently reruns 96 journal tests plus 3 guards, inspects the frozen source, and confirms all eight hashes from actual native events.
The journal review expands the policy to 56 identities; the later configured-coordinator review adds six more.
The current 62-identity digest is `bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab`.
The earlier 48-entry rejection is a recorded migration check, not the current acceptance state.
No tests are hidden from ordinary discovery and no policy is automatically extended.

Configured Function/coordinator DB acceptance (OpenSpec 6.3), deployed migrations/grants/TLS, live model/Qodo/signing, and queue-to-draft behavior remain unverified.
OpenSpec checkboxes stay open.

## Frozen source and review identities

Freeze: `tests/integration/agent-worker-journal.test.mjs` SHA-256:

```text
1f766fa870fce783d739242bace954427e6081b2d5d1b97ce1db239a75a2d71a
```

There are eight top-level groups and 88 subtests, for 96 tests with a database.
Without database variables, exactly the eight top-level groups skip.
All identities below use `entryFile: tests/integration/agent-worker-journal.test.mjs`, column 1, nesting 0, and type `test`.
Their SHA-256s match the native reporter's observed identities, using its canonical identity encoding.
Do not append, rename, or move cases after this freeze without explicit parent correction and a new review.

| Line | Exact top-level name | Identity SHA-256 |
| --- | --- | --- |
| 60 | journal DB: marker authorization, migrations and restricted runtime grants | `3aa113afae75d8a35ff9e73a050439891f263604112cc7cee95c6e24ce96dd17` |
| 132 | journal DB: phase initialization, legacy compatibility and forged transitions | `163fa9b39f0587f0d3af8cf3210a4268f3eee4a9aad0a7199084a52e626826f3` |
| 192 | journal DB: atomic model and candidate intents with typed ownership | `392e42a4eb60f95fdb429cb23b34a549f903b1482887948d6cdb7ac318b1ede7` |
| 297 | journal DB: descriptor bounds, deferred validation and immutable identities | `d50be9b0b1afcdff68c30009b314428422d59ed3037e6db457c94a8bf962af97` |
| 419 | journal DB: purpose-aware confirmation and database-authored wait persistence | `6943c432a17e2dfd6b47f398926bd05bba64d3347dfe666be90fcd57ad205282` |
| 462 | journal DB: acknowledgment loss reconciles durable boundaries without replay | `b3a8ae769e55b89259d4a23cc495d8cfde6900b1f75496ac3238dd4e73f60edd` |
| 591 | journal DB: CI and Qodo share two idempotent repair reservations | `7a0b5d45ba181d03eabf7b6859d6cdf0b284f5a3fd868cb99072673fcd41060b` |
| 660 | journal DB: stale owners, expired phases and lost candidate human stops | `ed5d204b0eadbb7c629110a62d52f6789497376b3a76ec80edf827211fe625dd` |

The frozen legacy source remains byte-identical:
`tests/integration/agent-worker-store.test.mjs` SHA-256 `fed4a38c547aa52f7aa891f79ad79ac323fb2db2dd67b4412428238479f996bb`.
