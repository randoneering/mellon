# Disabled worker Function

`src/automation/worker/function.mjs` exposes the HTTP boundary and a wired production default.
`createProductionWorkerFunction()` composes the [private runtime](agent-worker-runtime.md) for each request.
`createWorkerFunction(options)` remains the trusted injection interface for focused boundary tests.
No database, App or model client starts at import time.

## Declaration and environment

- `issueworker` targets `./src/automation/worker/function.mjs`.
- `issueworkertick` targets `POST /tick` every two minutes in UTC.
- The schedule has literal `enabled: false` on every branch.
- The Function has literal `AGENT_WORKER_ENABLED: "false"`, regardless of the deployment process's flag.
- Optional config/hash/App/model bindings are worker-only and empty by default.
- Intake source/env, retained Auth and branch policy remain unchanged.
- No branch-wide Gateway toggle or provisioning credential is added.

The disabled declaration uses the nonsecret sentinel `disabled` when the worker database URL is absent.
It also overrides `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, preventing automatic owner fallback.
`workerRuntimeEnvironment(env, databaseRole)` returns only those three worker database keys.
It requires a matching dedicated role, exactly one `sslmode=verify-full`, and no host/TLS/user/password/database/options overrides.
The decoded role cannot match an available intake URL's decoded username, even when equivalent names use different percent-encoding.
Username matching alone is not grant evidence; the [pool attestation](agent-worker-pool.md) checks actual database identity and privileges.
The model/App bindings never enter that pool environment, intake, model messages or CI.

## Handler contracts

Trusted server code may supply these `createWorkerFunction` options; request data cannot:

| Option | Contract |
| --- | --- |
| `env` | Exact enable flag, branch and restricted database settings |
| `trustedConfig` | Reviewed `productionBranch`, `triggerId`, `databaseRole` |
| `verifyNativeRequest` | Defaults to the documented Neon-edge header check |
| `authorizeRuntime` | Requires complete bound configuration and verified capabilities |
| `advanceTick` | One bounded, durably deduplicated coordinator phase |
| `parseDelivery` | Installed Neon trigger parser; test seam only |
| `report` | Fixed categories; sync and async diagnostic failures are suppressed |

The production default supplies real activation and coordinator adapters.
Missing pins, profile, private credentials, preflight evidence or capabilities fail closed.
The operator preflight record is mandatory evidence binding, not a substitute for performing the live checks.
The handler rechecks enablement/branch after awaited authorization; the coordinator also checks runtime authorization before subsequent effects.

Only a frozen normalized native delivery reaches the coordinator:

```js
{
  invocationId: "validated-native-id",
  type: "schedule",
  trigger: { type: "schedule", id: "reviewed-trigger-id", name: "issueworkertick" },
  data: { scheduledAt: "2026-06-01T00:00:00.000Z" },
}
```

The public response contains only `status`: `advanced`, `idle`, `duplicate`, `waiting`, `needs_attention`, `cancelled`, or `ready_for_human`.
No in-memory receipt cache, fallback no-op coordinator, background loop or blind retry is used.

## HTTP and privacy

Only exact `POST /tick` without a query is eligible.
Unknown routes return 404; other methods return 405 with `Allow: POST`.
Denied provenance or malformed native delivery returns 401 before worker clients start.
JSON is limited to 4,096 bytes; invalid schedule type/name/ID/time cannot advance work.
Disabled/nonproduction requests return `disabled`; unavailable configuration/capabilities return 503.
Every response uses `Cache-Control: no-store`.
Diagnostics never include raw exceptions, credentials, URLs, provider bodies, submission text or coordinator payloads.

## Native provenance evidence

Installed versions are `@neon/config` 1.11.3 and `@neon/functions` 0.11.0.
The SDK parser checks header/body correlation and payload consistency, not caller provenance.
[Neon's trigger contract](https://neon.com/docs/compute/functions/triggers/overview) states that native ingress strips caller-supplied `X-Neon-*` headers.
The default recognizes `X-Neon-Trigger-Invocation-Id` only under that platform contract, then verifies parsed trigger identity/type and branch/configuration.
Header presence is not authentication on arbitrary local servers, proxies or non-Neon deployments.
Tests simulate edge stripping; live ingress behavior remains a separate preflight.

## Deployment and kill switch

These source changes authorize no deployment, service provisioning, permission change or activation.
Review the exact schema, restricted grants, policy/source pins, model budget, worker-only secrets and disabled schedule before deployment approval.
A full `neon deploy --env <reviewed-private-env-file>` also applies intake/Auth, so review the complete plan first.
Do not use `--update-existing` or briefly enable the schedule to work around missing preflight.

After separately approved operation, disable the reviewed schedule and worker flag to stop future phases.
A disabled schedule alone does not cancel already queued or remotely accepted work.
Retain metadata and owned branch/PR references for reconciliation; do not delete, reset or requeue them as rollback.
Live one-issue automation remains unverified until the approved pilot is exercised.
