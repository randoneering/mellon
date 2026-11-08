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

The default supports the explicitly approved Sol/high `conservative-bytes-v1` model profile and opt-in GitHub submitted-review Qodo profile.
The Gateway must be an HTTPS Neon AI host origin, without credentials, port, query, fragment or API suffix.
Preflight timestamps must be valid and expire within four hours of the recorded check.

The preflight record is an operator attestation.
Hash checks verify its binding, not the truth of checks that have never run.
Never create production evidence from mocked tests or credential presence.
Live generation, App publication, draft/re-review and spend/isolation checks still need their separate approvals.

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
