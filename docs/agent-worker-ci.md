# Agent worker CI boundary

Generated code and tests run in the existing GitHub-hosted `test` job.
The job keeps the `push` and `pull_request` events, read-only repository permissions, pinned Actions, Ubuntu runner, Node 24, 15-minute timeout, and existing command/test sequence.
Checkout keeps `persist-credentials: false`.
No repository secret, provider credential, model token, or write permission is added.

`npm test` selects top-level test files through `automation/ci/run-tests.mjs`.
The runner pins 42 required test paths in its reviewed source and stops before starting tests if any required file is missing, renamed, or not a regular file.
It also runs new top-level `*.test.mjs` files from the four existing test directories.
Changes to required paths need a reviewed runner update and new approved producer hashes.
The path check does not freeze test content or prove test semantics.
The runner accepts no test paths or shell commands from issues or model output.
Local runs preserve native Node test output and exit status.

## Guarded command output

Workflow commands that execute repository code use fixed command tuples in `automation/ci/guard-command.mjs`.
The wrapper uses `shell: false`, fixed arguments, bounded timeouts, and output caps.
It validates complete UTF-8, escapes control bytes, and neutralizes `::` and legacy `##[` markers.
It discards partial output after overflow, timeout, spawn error, or invalid UTF-8.
It strips GitHub command-file handles and shell/Node startup hooks from child environments.
On Linux, it terminates the command's isolated process group with `SIGTERM`, then `SIGKILL` after a bounded grace period.

## Privacy-safe failure locations

GitHub test logs show bounded source locations and failure categories, not raw test output.
The reporter sends coordinates and opaque identities through a private controller pipe, separate from stdout/stderr and the unchanged V2 machine report.
The runner checks the packet's run context and producer hash, matches known failure identities/categories, and accepts only selected regular test files and valid source coordinates.
Root failures use a file-level location when an exact test location is unavailable.
Invalid, incomplete or oversized location data produces a fixed unavailable message.

The private packet is limited to 24 KiB; visible diagnostics stay within 16 KiB.
No test names, assertion text, stacks, source snippets or arbitrary child streams enter these messages.
The controller removes its private channel setting before starting test subprocesses.
Location messages are human diagnostics only and never positive worker evidence or workflow commands.
The machine report, child exit status and trusted formatter boundary remain unchanged.

## Separate trusted reporting job

The `test` job runs the native reporter and publishes only two bounded, base64url-safe step outputs: the encoded report and the test exit code.
The test child receives no `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`, `GITHUB_STATE`, `BASH_ENV`, `ENV`, or `NODE_OPTIONS` handle.
The test job emits no positive annotation.

A separate `test-report` job runs on a fresh GitHub-hosted runner with `contents: read`.
It receives only the two declared untrusted outputs and fixed run identity fields.
It does not check out or execute candidate code, install dependencies, download artifacts, or receive secrets.
Before checkout it requires `MELLON_CI_REPORTER_REVISION` to be a lowercase 40-character SHA.
There is no candidate or default-ref fallback.
The job checks out the reporter at that revision and runs only its builtin-only formatter.
Missing or malformed configuration fails closed.

The formatter accepts bounded encoded data and checks the closed version 2 schema, reviewed skip policy, complete counts and exact repository/head/run/attempt context.
Small payloads keep one `MELLON_CI_REPORT_V2` notice.
Larger payloads use two to ten `MELLON_CI_REPORT_V2_CHUNK` notices so GitHub's annotation API cannot clip a long report at 4,096 bytes.
Each chunk carries a whole-payload SHA-256, one-based index, total count and at most 3,500 base64url characters.
The decoded V2 JSON and its original logical size limit remain unchanged.
The report carries the formatter revision.
The maintainer approves formatter revision `cc44c0fd57fa6dc26f1431e9a7436ac45e097cb1` for the foundation PR.
Both full GitHub workflow reruns pass with that pin.
The source-location fix is published at `f8ec7ee8df117c428bafc4d645c9d36d04b963e8`, with both test/report workflows green.
Actual annotation readback exposes the 4,096-byte truncation that this chunked transport addresses.
Publishing the formatter change requires a reviewed signed revision and separate approval to advance the trusted pin, followed by full workflow reruns and complete API readback.
Do not substitute the PR head automatically.

## Worker evidence boundary

The required version 2 diagnostics descriptor pins six ordered candidate sources and a separate reporter identity: the `test-report` check context, immutable formatter revision, and formatter source hash.
The six paths are `automation/ci/guard-command.mjs`, `automation/ci/run-tests.mjs`, `automation/ci/test-reporter.mjs`, `automation/ci/report-annotations.mjs`, `scripts/lib/output-guard.mjs`, and `package.json`.
It also requires the closed `skipPolicy: { version: 1, sha256 }` descriptor below.
Approval and check reading reject omitted diagnostics, missing reporter checks, legacy descriptors, and unknown skip policies before GitHub reads.
The worker fetches candidate producer bytes at the candidate head and the formatter bytes at the trusted revision.
It accepts annotations only from the exact `test-report` Check Run linked to the matching workflow run, attempt, head, App, and job.
It also requires the report's formatter revision and run context to match the manifest and current run.
Execution-job annotations, generic failures, stale checks, and skipped jobs do not prove intended test regressions.
Diagnostics remain untrusted data and cannot authorize progress by themselves.
The trusted caller must compare a verified assertion regression with approved acceptance criteria.

Focused tests exercise native test events, forged child output, bounded output handling, child environment filtering, formatter payload validation, and workflow structure.
Controlled tests do not prove live behavior by themselves.
The configured foundation runs independently verify the existing V2 reporting job; future worker head/manifest/annotation binding still needs its own approved live preflight.
GitHub-hosted CI remains an execution boundary, not network isolation.

## Reviewed database skip policy

The maintainer first approved the original 38 DB-guard tests, then explicitly approved 7 added DB-bounds tests.
The parent subsequently reviewed and authorized exactly 48 final native identities: the broad row-lock case becomes three separate method cases, and an actual stalled-COMMIT case is added.
That legacy review requires worker DB test source SHA-256 `fed4a38c547aa52f7aa891f79ad79ac323fb2db2dd67b4412428238479f996bb`.
The parent also reviews eight journal groups after independently passing their 96 actual-Postgres tests and 3 marker guards.
Their frozen source SHA-256 is `1f766fa870fce783d739242bace954427e6081b2d5d1b97ce1db239a75a2d71a`.
The parent also verifies 113 configured Function/Postgres tests and reviews the six frozen coordinator groups at source SHA-256 `94e2765707bfbcaeb601ae1ce96104c8a10f45cd0fbcaf0cd74762ef7d86b89e`.
The current 62-identity allowlist contains 3 marker probes, 7 intake tests, 38 worker tests, 8 journal groups, and 6 configured-coordinator groups.
All original test coverage remains, with row-lock coverage split across `putIntent`, `confirmIntent`, and `finishRun`.
There is no directory, glob, count-only, environment-selected, or runtime-discovered exemption.
All 42 required paths and every newly discovered test file still execute through the protected runner.
No CI database service is added.

The policy SHA-256 is `bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab`.
It hashes canonical JSON `{ version: 1, testIdentitySha256s: [...] }` with sorted object keys and the 62 lexicographically sorted identity hashes.
The exact allowlist lives in the already-pinned `report-annotations.mjs` source and independently in the trusted worker's `checks.mjs`.
Both boundaries verify their local list digest and require every enumerated skip to belong to it.
The approval adapter independently pins the expected policy digest.
The untrusted execution job carries the digest and skip enumeration but cannot replace the policy.
A changed native name, file, line, column, nesting, or type needs a separately reviewed policy update, updated manifest pins, and a reviewed immutable formatter revision.
Updating a formatter or collector changes producer source hashes; regenerate every affected manifest source pin and its external approval hash.

### Public provenance

Captured with installed Node `v24.22.2` from real `test:complete` events, without DB configuration.
Every recorded skip is native `skip: true` at an existing conditional `test.skip` guard.
The marker probes require `AGENT_INTAKE_GUARD_PROBE === '1'`; intake, worker, and journal DB tests require both disposable DB URL and run-marker configuration.
The added worker cases exercise real PostgreSQL acquisition, transaction startup, row-lock expiry, database deadlines, and uncertain COMMIT acknowledgment; they use that same DB guard.
Before pinning, the final capture checks the frozen worker source digest and compares exact names, files, nesting, and types against the explicitly reviewed set.
Source-coordinate changes are reviewed before hashing, not automatically accepted by CI.
No submitted text or model claim supplies these identities.

| Reviewed source | Identities | Source SHA-256 at capture |
| --- | ---: | --- |
| `tests/integration/agent-intake-database-guard.test.mjs` | 3 | `4ff7ebfabbd0853221b4cdc20a4b6b667d70b7f319a148d6a30fa4ea7e1cb17a` |
| `tests/integration/agent-intake-store.test.mjs` | 7 | `28369a001b2a6c9fc63cf3f331a444faa7ad0c641a041b5584094421ad0cbc1a` |
| `tests/integration/agent-worker-store.test.mjs` | 38 | `fed4a38c547aa52f7aa891f79ad79ac323fb2db2dd67b4412428238479f996bb` |
| `tests/integration/agent-worker-journal.test.mjs` | 8 | `1f766fa870fce783d739242bace954427e6081b2d5d1b97ce1db239a75a2d71a` |
| `tests/integration/agent-worker-coordinator.test.mjs` | 6 | `94e2765707bfbcaeb601ae1ce96104c8a10f45cd0fbcaf0cd74762ef7d86b89e` |

The following public source coordinates and names map each native identity to its reviewed guard.
All records use nesting `0` and type `test`.
Source hashes above record provenance, not proof that test assertions are sufficient.

| Source | Line:column | Native test name | Identity SHA-256 |
| --- | --- | --- | --- |
| `tests/integration/agent-intake-database-guard.test.mjs` | 19:1 | a URL and matching database name without a runner token cannot authorize migrations | `bb3582afe4d546be92e5fbb14a32c64ab4d2d56ed1876e11f75ae8f120b9c577` |
| `tests/integration/agent-intake-database-guard.test.mjs` | 23:1 | an unmarked loopback database is rejected before intake schema or roles are created | `a92115413c22249f2459ba60a22daf84273945d96b30aa4d26b7f0102e94f40d` |
| `tests/integration/agent-intake-database-guard.test.mjs` | 35:1 | a wrong database marker is rejected without running intake migrations or granting privileges | `d4c2612bcd51bfcdc0a906197be9247dc6d08b5b58087d0788d25e78f0f1fa05` |
| `tests/integration/agent-intake-store.test.mjs` | 32:1 | migration creates only the intake schema with durable uniqueness and restricted runtime writes | `522d920ab082dae3e5d02f096ba97b00aac86a9621bbe81dcbc333dbb9a86b4f` |
| `tests/integration/agent-intake-store.test.mjs` | 61:1 | store survives restart and reconciles redelivery with one persisted job | `0fad7c720bf4c1fafa0c38d76669ed51f38f7c664ac1b3dccdd7ed421d4f8306` |
| `tests/integration/agent-intake-store.test.mjs` | 77:1 | concurrent real transactions converge on one job and retain every delivery receipt | `5ca8158c655bb17c3273e0f116593a9d658d928b9d651ba12e654bd36d7e9d52` |
| `tests/integration/agent-intake-store.test.mjs` | 92:1 | a conflicting delivery rolls back its new job and preserves the original receipt | `bcdda4a74dfbe9cec3c179e706840854c8e30f33759709d793f5b59339ce6b00` |
| `tests/integration/agent-intake-store.test.mjs` | 105:1 | lost commit acknowledgment returns 503 and redelivery finds the committed job | `2b0b8715261ad60afd4709a279b8d4f2d3a9a2ef201c4dea970b4f9fbf61621b` |
| `tests/integration/agent-intake-store.test.mjs` | 137:1 | full signed HTTP flow with real Postgres uses only the runtime SELECT and INSERT grants | `8e5f94441fa70f8f8e1e8e670edd98d0fdd18225b4a6b60173fb8401ef5705a8` |
| `tests/integration/agent-intake-store.test.mjs` | 167:1 | configured Function joins signed HTTP, bounded GitHub reads, and the real transactional store | `88f5e2edb2cd224859f784fd4a7e3216619192d554fa77de163128b620c7fa8a` |
| `tests/integration/agent-worker-store.test.mjs` | 245:1 | remote-effect intents and proof references persist as fixed typed columns | `536a7f5a95a1f09ab1ad213eeaf4ec002229b33d95511d97a48740a53b7874ec` |
| `tests/integration/agent-worker-store.test.mjs` | 264:1 | durable publication phases cannot execute twice and stale generations cannot confirm | `e2832ccade822e9d01920deae34ef633d2f7940cd63fdaf0705470b6e3d66299` |
| `tests/integration/agent-worker-store.test.mjs` | 312:1 | actual transactions reconcile lost intent, fence, and confirmation acknowledgments without remote replay | `eaac2a86ba645efa1788da064367a2b73c84e08312e4156756bd3e1ba7f3c90d` |
| `tests/integration/agent-worker-store.test.mjs` | 435:1 | a lost claim acknowledgment preserves one invocation and one run identity | `47b077b2c0dd42055a5762137f5a7f223e6d3eb29a6dfb97798547c61f41a5f7` |
| `tests/integration/agent-worker-store.test.mjs` | 457:1 | publication fences retain time limits and unresolved model-call stops | `9e669c1aad933f44c2c856867d37d15e6d6f2191f678944a9bf66b11536ccb9f` |
| `tests/integration/agent-worker-store.test.mjs` | 486:1 | runtime role has effective least privilege and worker tables expose only typed columns | `e9a1ad85b678bfeb22a68ba195f1c93e2e7d5cd16bde070d85bcb5724169c244` |
| `tests/integration/agent-worker-store.test.mjs` | 548:1 | claim denies unknown, private, and incomplete metadata before database access | `b99e8f48d78366cdc488e2ac8e4dfa560a846182e21664968d669b7d34b34c28` |
| `tests/integration/agent-worker-store.test.mjs` | 594:1 | claim binds repository name, issue number, IDs, and original actor to the intake job | `2e23a4afccc05cfaa0de683285bfea57b2424e8f9ab9147b5c1942a8c392c012` |
| `tests/integration/agent-worker-store.test.mjs` | 621:1 | checkpoint accepts only typed nonterminal state and bounded references | `96d460ace5da371943ba558997cf752a74ae70866aa64f3a7febe767f543a19d` |
| `tests/integration/agent-worker-store.test.mjs` | 649:1 | operation intents accept only stable typed hashes and approved effect categories | `1f54d40a00c740e78458e9c95883bbd96937fa9fa4ff51daa380a8ff30f95adc` |
| `tests/integration/agent-worker-store.test.mjs` | 681:1 | operation intents reject arbitrary metadata even when using the legacy proposal kind | `f78af322925bbc9076f0ad31a27a6f59234cd20849ce349df178cfa9d7a05557` |
| `tests/integration/agent-worker-store.test.mjs` | 695:1 | finishRun accepts only the three explicit terminal states | `f0d3fd69420d0be6d7e9b5ada2fabb5c42ac57553fef5e2e6cc11b231f33eee6` |
| `tests/integration/agent-worker-store.test.mjs` | 720:1 | store claim and getRun expose bounded metadata and never return raw checkpoint data | `d79eb01949f75ac5d93ecd2b83bf1bc548d1ddd0763b2a528af62211cd4aae8d` |
| `tests/integration/agent-worker-store.test.mjs` | 735:1 | real store operations run as SELECT-only intake runtime and enforce durable lease recovery | `d1c1e205b8e1c52fecda36df90cf4bf3d8a51257f65bc647e6be13fe53c46f0b` |
| `tests/integration/agent-worker-store.test.mjs` | 958:1 | a separately selected bounded profile honors configured lease duration and zero recoveries | `2cbad49675c7efd17571f47dda52105b53308c984a839bce01557acb4f89223f` |
| `tests/integration/agent-worker-store.test.mjs` | 985:1 | a live owner can retain ready or cancelled terminals without reviving the run | `d6b6542401f6d304e187b41d8d3fda7ca2a400ff2849318087479907342b2fb1` |
| `tests/integration/agent-worker-store.test.mjs` | 1008:1 | model-call budget reservation is atomic and never authorizes a duplicate execution | `dbc78016e62839718446d0279b1f444e51bcc304dc77b65492fad6a6c863d97d` |
| `tests/integration/agent-worker-store.test.mjs` | 1051:1 | reservations clamp outputs to remaining run tokens and enforce strict run limits | `9b01be3a8bd040167f95b1454cf9f956a3bdcf0f32deef9b062c4d16e0d2fd84` |
| `tests/integration/agent-worker-store.test.mjs` | 1162:1 | concurrent distinct reservations cannot exceed one model call per tick generation | `f3fa47ae507f179e29f7da1499ecc50f96bbc9eeea8e6b089359baee22a428fb` |
| `tests/integration/agent-worker-store.test.mjs` | 1189:1 | model-call outcome accounting is closed, idempotent, and retains reservations on failures | `819f41c8a33f9af1bf78efc211a6caace85ca3c72ba9d528616b3cd66407c771` |
| `tests/integration/agent-worker-store.test.mjs` | 1247:1 | successful and invalid model usage is recorded only when numeric and within the reservation | `ca6e548eee2c834dc6406da98fe02623a7f6503bbab9058b52fd07295e236da1` |
| `tests/integration/agent-worker-store.test.mjs` | 1329:1 | time limits use database timestamps for tick, run, and model-call deadlines | `dfdfcec66e375d68afaf56ac7c69c8ecae3ba1c7f3fef5026d0bae93a5bff5c2` |
| `tests/integration/agent-worker-store.test.mjs` | 1419:1 | duplicate delivery and recovery exhaustion retain model reservations without replay | `5689f6b7ce57eed41fa99126c0ba14a839d3b22b7eb11e2295cf5159bb7a933e` |
| `tests/integration/agent-worker-store.test.mjs` | 1478:1 | CI and Qodo repairs share two idempotent reservations and stop without losing references | `073893e4b507150916036e54c92851b867d7d33a73fcb4a67cb9fdb4a9ec21c9` |
| `tests/integration/agent-worker-store.test.mjs` | 1563:1 | stricter per-call input and per-run call limits stop before another reservation | `e1506f889542ae0ce4948e9fd2014ceb021e6f2fea8dfccb80903d7008988c02` |
| `tests/integration/agent-worker-store.test.mjs` | 1622:1 | a lost reservation commit acknowledgment retains the slot and cannot authorize replay | `06f53c57b7875ac7d27e507ab59de75f4601209dc58983b10f69036d4f0ad911` |
| `tests/integration/agent-worker-store.test.mjs` | 1678:1 | an unresolved model reservation stops later generations instead of authorizing another call | `f0d17beef5057213db8a5f71bbf6e574628056be8f4a87f5b8b56ee6a7a6801a` |
| `tests/integration/agent-worker-store.test.mjs` | 1715:1 | budget APIs reject untrusted payload fields before database access | `96978d049fe6694893ed9b2fd4837fb3ccb59fac92705440a76b7c6255140f05` |
| `tests/integration/agent-worker-store.test.mjs` | 1760:1 | queued acquisition without pool timeouts is bounded and destroys the late real connection | `0b9361c3727b0ef8d53bbff3030fd9ba2a100e161c0c256723eccba14cf749b0` |
| `tests/integration/agent-worker-store.test.mjs` | 1803:3 | real PostgreSQL stalled BEGIN cannot continue transaction body after expiry | `bfbf71945ff40f5807727d3e9aa009e1ba5f8763db15e74f8b6e9d115bce89e9` |
| `tests/integration/agent-worker-store.test.mjs` | 1803:3 | real PostgreSQL stalled SET LOCAL lock_timeout cannot continue transaction body after expiry | `f0b06beee82fe7361694cebdd880eb2826e3ab6833f90fc7a1d5a83aa249517c` |
| `tests/integration/agent-worker-store.test.mjs` | 1803:3 | real PostgreSQL stalled SET LOCAL statement_timeout cannot continue transaction body after expiry | `892861a24581f413392210e5a83aa0b3358edcfeeabb984335f42621dd408400` |
| `tests/integration/agent-worker-store.test.mjs` | 1848:3 | row-lock expiry prevents late durable putIntent writes | `4ec67740b10db940f9cb6b68944140680007291734e667dcba496b8b646dacc8` |
| `tests/integration/agent-worker-store.test.mjs` | 1848:3 | row-lock expiry prevents late durable confirmIntent writes | `1683107fd49d173374111c3af2778cde6c7c08736c2fe64aa5785aac69d4975f` |
| `tests/integration/agent-worker-store.test.mjs` | 1848:3 | row-lock expiry prevents late durable finishRun writes | `d8454531b1b70f0746af68a8b210ccf0a8f24c5915a9694a4c8b650c096c197d` |
| `tests/integration/agent-worker-store.test.mjs` | 1890:3 | database-authoritative tick expiry denies confirmation and terminal writes | `38bfb735bd76915a81a33ad9c4be6114cb8c6a69b587057ad2705d9ec85676d5` |
| `tests/integration/agent-worker-store.test.mjs` | 1890:3 | database-authoritative run expiry denies confirmation and terminal writes | `8a08bf1f3962c2a50dd0bcb885f2bc9c30c9c00db43a6b8c790fc1e96a456792` |
| `tests/integration/agent-worker-store.test.mjs` | 1918:1 | a stalled actual COMMIT acknowledgment retains one durable invocation without replay | `2baa5705bbc72d527fc1607d0d64d8173432cae8b34a6dfb13a62fc5a4dd3eda` |
| `tests/integration/agent-worker-journal.test.mjs` | 60:1 | journal DB: marker authorization, migrations and restricted runtime grants | `3aa113afae75d8a35ff9e73a050439891f263604112cc7cee95c6e24ce96dd17` |
| `tests/integration/agent-worker-journal.test.mjs` | 132:1 | journal DB: phase initialization, legacy compatibility and forged transitions | `163fa9b39f0587f0d3af8cf3210a4268f3eee4a9aad0a7199084a52e626826f3` |
| `tests/integration/agent-worker-journal.test.mjs` | 192:1 | journal DB: atomic model and candidate intents with typed ownership | `392e42a4eb60f95fdb429cb23b34a549f903b1482887948d6cdb7ac318b1ede7` |
| `tests/integration/agent-worker-journal.test.mjs` | 297:1 | journal DB: descriptor bounds, deferred validation and immutable identities | `d50be9b0b1afcdff68c30009b314428422d59ed3037e6db457c94a8bf962af97` |
| `tests/integration/agent-worker-journal.test.mjs` | 419:1 | journal DB: purpose-aware confirmation and database-authored wait persistence | `6943c432a17e2dfd6b47f398926bd05bba64d3347dfe666be90fcd57ad205282` |
| `tests/integration/agent-worker-journal.test.mjs` | 462:1 | journal DB: acknowledgment loss reconciles durable boundaries without replay | `b3a8ae769e55b89259d4a23cc495d8cfde6900b1f75496ac3238dd4e73f60edd` |
| `tests/integration/agent-worker-journal.test.mjs` | 591:1 | journal DB: CI and Qodo share two idempotent repair reservations | `7a0b5d45ba181d03eabf7b6859d6cdf0b284f5a3fd868cb99072673fcd41060b` |
| `tests/integration/agent-worker-journal.test.mjs` | 660:1 | journal DB: stale owners, expired phases and lost candidate human stops | `ed5d204b0eadbb7c629110a62d52f6789497376b3a76ec80edf827211fe625dd` |
| `tests/integration/agent-worker-coordinator.test.mjs` | 127:1 | coordinator DB: authenticated restricted role and configured Function ingress guards | `09d72ef105de01bfaf403c942a714a28bc82bc304e57019e8af60c22cfb29c0e` |
| `tests/integration/agent-worker-coordinator.test.mjs` | 193:1 | coordinator DB: initial regression lifecycle, durable claims and no-model waits | `de02bcac3413af36f31b898cb4b37fa479053ed0cabe5b9ce8e760fb219ffcf0` |
| `tests/integration/agent-worker-coordinator.test.mjs` | 318:1 | coordinator DB: authenticated CI gates and actual unsupported review never authorize readiness | `b0aaf0ddd3b557c44782ff485a1e836430e404a1c62d5183e603ab37c591093b` |
| `tests/integration/agent-worker-coordinator.test.mjs` | 504:1 | coordinator DB: shared CI and synthetic future Qodo repairs retain phase and single draft identity | `194abf4587f35bbf8c037012ed12c1eaf3dd0ef55d1cf5fada8b4263c094bbe3` |
| `tests/integration/agent-worker-coordinator.test.mjs` | 574:1 | coordinator DB: real transaction acknowledgment loss and restart never blindly replay effects | `d62fca6fcda07658e44eb3ae4ac26d731deb7e6a0f02c5e1a7abda74fc9d3a17` |
| `tests/integration/agent-worker-coordinator.test.mjs` | 737:1 | coordinator DB: stale ownership, revocation and human stops prevent later model or publication | `054c8cebc9f59c0f5b3df8645b83269d4869f288e4773579ff095bfcc8711916` |

Skipped tests are not passed or exercised DB tests.
Separate marker-guarded intake, worker, journal, and configured-coordinator database suites remain required; this policy does not replace them.
Run `npm run test:worker:coordinator:db` for configured Function/database acceptance.
Native fixtures verify boolean/string skip and todo handling, protected DB-skip collection, and assertion RED alongside the approved skips.
Mocked GitHub responses verify the reader's provenance and acceptance checks; they do not establish live GitHub behavior or semantic correctness.
