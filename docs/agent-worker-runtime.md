# Worker production composition

The default `function.mjs` export uses `createProductionWorkerFunction()`.
Each authenticated, enabled tick composes the actual restricted pg pool, worker store, GitHub App broker, approval reader, Sol/high model admission and coordinator.
No injected placeholder is required by the production path.
The source worker flag and schedule remain disabled.

## Private worker bindings

| Binding | Purpose |
| --- | --- |
| `AGENT_WORKER_CONFIG_JSON` | Reviewed private plan and live-preflight record |
| `AGENT_WORKER_CONFIG_SHA256` | Externally approved SHA-256 of the canonical complete config |
| `AGENT_WORKER_DATABASE_URL` | Dedicated worker-role URL with verified TLS |
| `AGENT_WORKER_APP_PRIVATE_KEY` | App signing key, never model or CI data |
| `WORKER_MODEL_BASE_URL` / `WORKER_MODEL_TOKEN` | Worker-only Neon Gateway origin and token |

No intake, provisioning, platform model-token or owner-database fallback is used.
The declaration leaves these values empty while disabled.
Configure them only through a separately reviewed deployment; do not paste credentials into chat or commit private config files.

## Configuration shape

This structural example uses reviewed objects and hashes, not ready-to-run values:

```js
{
  version: 1,
  productionBranch, triggerId, databaseRole,
  manifest, manifestSha256, policyManifest,
  github: { appId, installationId, actor, preflightCommitSha },
  preflight: {
    version: 1,
    planSha256, databaseBindingSha256, gatewayBindingSha256,
    checkedAt, expiresAt, evidenceSha256,
    checks: [
      'native_ingress', 'worker_credential_isolation',
      'gateway_model_tools_usage', 'gateway_spend_limits',
      'github_app_signing', 'qodo_draft_review', 'qodo_updated_head_review',
    ],
  },
}
```

Canonical JSON recursively sorts object keys, preserves array order and encodes JSON as UTF-8.
The worker compares supplied pins; it never calculates its own expected approval hash.

- `manifestSha256` binds the complete externally approved pilot manifest.
- `planSha256` binds the config excluding `preflight`.
- `databaseBindingSha256` hashes canonical `{connectionString: AGENT_WORKER_DATABASE_URL, role: databaseRole}`.
- `gatewayBindingSha256` hashes canonical `{baseURL: WORKER_MODEL_BASE_URL, tokenSha256: sha256(WORKER_MODEL_TOKEN), model: manifest.model}`.
- The complete config pin also binds the preflight record and its evidence hash.

The model receives the approved patch paths and validated `pilotScope` as trusted structured system context.
Byte limits apply to complete resulting UTF-8 file contents, not diff size or character count.
Issue, file and tool data cannot alter them; the trusted patch validator still rejects oversize or out-of-scope changes.
Generic adapters that omit `pilotScope` retain their existing path-only contract; they receive no invented numeric approval.
Runtime worker contexts always supply the approved scope.

The default supports the explicitly approved Sol/high `conservative-bytes-v1` model profile and opt-in GitHub submitted-review Qodo profile.
The Gateway must be an HTTPS Neon AI host origin, without credentials, port, query, fragment or API suffix.
Preflight timestamps must be valid and expire within four hours of the recorded check.

The preflight record is an operator attestation.
Startup readiness does not satisfy command dispatch, exact-head review, fresh CI, or human fallback requirements, and never makes a run ready for human review by itself.
Hash checks verify its binding, not the truth of checks that have never run.
Never create production evidence from mocked tests or credential presence.
Live generation, App publication, draft/re-review and spend/isolation checks still need their separate approvals.

## Optional review-policy preflight

A manifest may opt into `reviewPolicy: { version: 1, profile: 'worker-command-maintainer-fallback-v1' }`.
It then requires preflight version `2` with `reviewProfile: 'worker-command-maintainer-fallback-v1'`.
The first five existing checks stay required; replace `qodo_draft_review` and `qodo_updated_head_review` with `worker_review_command` and `maintainer_exact_head_review`.
Old version-1 preflight cannot authorize this profile, even with refreshed hashes.
Unknown fields/profiles fail closed, and maintainer evidence never satisfies Qodo-named checks.
All attestations still need separate live approval and observed evidence.

A version-3 preflight is a separate first-run-startup attestation, available only with that pinned review policy and valid coordinator/full Qodo App identities.
It requires exactly `purpose: 'first-run-startup'` and the five infrastructure checks: `native_ingress`, `worker_credential_isolation`, `gateway_model_tools_usage`, `gateway_spend_limits`, and `github_app_signing`.
Review acceptance remains unobserved, not passed; review checks, completion fields and any additional stage field are rejected.
Startup checks remain bound to the full plan, manifest, database/Gateway credentials, evidence hash, and expiry.
The attestation covers ticks of one bound issue/run lifecycle, with existing job/run uniqueness and fresh approval controls; it grants no authority for unrelated jobs or additional runs.
Version 1 and version 2 retain their existing meanings and accepted check sets.

Opt-in role attestation additionally requires the migrated `agent_worker.review_requests` table with SELECT, INSERT and UPDATE only.
DELETE, TRUNCATE, REFERENCES and TRIGGER privileges remain forbidden.
Migration `004-review-requests.sql` contains no deployment-role grant because the role comes from separately approved configuration.
Review that migration and the three table privileges before any production application.
Policy-source, manifest, config and preflight pins must be regenerated and approved after this change; no existing live pin is updated by local tests.

## Tick lifecycle

1. Validate route, method, documented Neon-edge provenance and native delivery shape.
2. Reject disabled/nonproduction processing before any client is constructed.
3. Verify private pins, model profile, credential bindings and current preflight evidence.
4. Verify actual database identity/grants/schema limits, App capabilities/signing proof and fresh GitHub approval.
5. Construct the actual store/model/coordinator and execute one durably guarded tick.
6. Close request-owned resources through bounded cleanup, without replacing the confirmed outcome if diagnostics fail.

Startup and advancement share the configured tick deadline, at most 90 seconds.
Current enablement, branch, config pins, credentials and preflight expiry are checked again before subsequent effects.
Already accepted remote SQL/HTTP/model work may finish after local cancellation.
No automatic provider retry, arbitrary module loader, in-memory dedupe or phase loop is added.

## Local evidence

Unit composition uses actual constructors with controlled HTTP/database receipts.
The manual `npm run test:worker:runtime:db` suite executes actual catalog/grant/limit and reservation SQL in a fresh marker-guarded container.
Its plaintext test transport is deliberately rejected by production TLS attestation; it does not establish live Neon TLS or service isolation.
The new manual file is outside ordinary test discovery, so it adds no default database skips.
