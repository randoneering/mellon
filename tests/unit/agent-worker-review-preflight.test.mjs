import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture } from '../fixtures/worker-runtime.mjs';
import { authorizeRuntimeConfiguration } from '../../src/automation/worker/runtime-config.mjs';
import { createWorkerRuntime } from '../../src/automation/worker/runtime.mjs';

function optIn(f) {
  f.config.manifest.reviewPolicy = { version: 1, profile: 'worker-command-maintainer-fallback-v1' };
  f.config.preflight.version = 2;
  f.config.preflight.reviewProfile = 'worker-command-maintainer-fallback-v1';
  f.config.preflight.checks = f.config.preflight.checks.filter(check => !check.startsWith('qodo_'))
    .concat(['worker_review_command', 'maintainer_exact_head_review']);
  f.pin();
}

test('opt-in preflight records command and human fallback without claiming Qodo checks passed', async () => {
  const f = await runtimeFixture(); optIn(f);
  assert.doesNotThrow(() => authorizeRuntimeConfiguration(f.config, f.env));
  assert.equal(f.config.preflight.checks.some(check => check.startsWith('qodo_')), false);
});

for (const kind of ['legacy proof', 'Qodo substitution', 'wrong profile', 'extra field']) {
  test(`opt-in rejects ${kind} even with refreshed configuration pins`, async () => {
    const f = await runtimeFixture(); optIn(f);
    if (kind === 'legacy proof') { f.config.preflight.version = 1; delete f.config.preflight.reviewProfile; }
    if (kind === 'Qodo substitution') f.config.preflight.checks = f.config.preflight.checks
      .map(check => check === 'maintainer_exact_head_review' ? 'qodo_updated_head_review' : check);
    if (kind === 'wrong profile') f.config.preflight.reviewProfile = 'unknown';
    if (kind === 'extra field') f.config.manifest.reviewPolicy.override = true;
    f.pin();
    assert.throws(() => authorizeRuntimeConfiguration(f.config, f.env), /configuration is invalid/);
  });
}

test('opt-in runtime requests journal-specific grant attestation', async () => {
  const f = await runtimeFixture(); optIn(f);
  let seen;
  const createDatabase = f.factories.createDatabase;
  const runtime = createWorkerRuntime({ env: f.env, report: line => f.reports.push(line), factories: {
    ...f.factories, createDatabase(options) {
      const db = createDatabase(options);
      return { ...db, async verifyRole(options) { seen = options.reviewRequests; return db.verifyRole(options); } };
    },
  } });
  try { assert.equal(await runtime.authorizeRuntime(), true); assert.equal(seen, true); }
  finally { await runtime.close(); }
});

function startupOptIn(f) {
  f.config.manifest.reviewPolicy = { version: 1, profile: 'worker-command-maintainer-fallback-v1' };
  f.config.preflight.version = 3;
  f.config.preflight.purpose = 'first-run-startup';
  f.config.preflight.reviewProfile = 'worker-command-maintainer-fallback-v1';
  f.config.preflight.checks = ['native_ingress', 'worker_credential_isolation',
    'gateway_model_tools_usage', 'gateway_spend_limits', 'github_app_signing'];
  f.pin();
}

test('startup v3 authorizes only pinned infrastructure and makes no review claim', async () => {
  const f = await runtimeFixture(); startupOptIn(f);
  assert.doesNotThrow(() => authorizeRuntimeConfiguration(f.config, f.env));
  assert.deepEqual(f.config.preflight.checks, ['native_ingress', 'worker_credential_isolation',
    'gateway_model_tools_usage', 'gateway_spend_limits', 'github_app_signing']);
});

for (const [name, mutate, repin = true] of [
  ['completion claim', f => { f.config.preflight.checks.push('worker_review_command'); }],
  ['fake review check', f => { f.config.preflight.checks.push('qodo_updated_head_review'); }],
  ['extra check', f => { f.config.preflight.checks.push('invented'); }],
  ['unknown preflight field', f => { f.config.preflight.reviewSucceeded = true; }],
  ['wrong review profile', f => { f.config.preflight.reviewProfile = 'unknown'; }],
  ['legacy version', f => { f.config.preflight.version = 1; }],
  ['legacy policy', f => { delete f.config.manifest.reviewPolicy; }],
  ['unknown policy', f => { f.config.manifest.reviewPolicy.profile = 'unknown'; }],
  ['incomplete Qodo identity', f => { delete f.config.manifest.qodoIdentities[0].appId; }],
  ['wrong plan hash', f => { f.config.preflight.planSha256 = 'f'.repeat(64); }, false],
  ['wrong evidence hash', f => { f.config.preflight.evidenceSha256 = 'not-a-hash'; }],
  ['wrong manifest hash', f => { f.config.manifestSha256 = 'f'.repeat(64); }, false],
  ['wrong issue', f => { f.config.manifest.issue.number += 1; }],
  ['invalid coordinator', f => { f.config.manifest.coordinator.regression.testPathIndex = -1; }],
  ['unknown purpose', f => { f.config.preflight.purpose = 'review-acceptance'; }],
  ['wrong source pin', f => { f.config.manifest.policyRevision = 'f'.repeat(40); }, false],
  ['wrong database credential binding', f => { f.env.AGENT_WORKER_DATABASE_URL += '-changed'; }, false],
  ['wrong credential binding', f => { f.env.WORKER_MODEL_TOKEN += '-changed'; }, false],
  ['expired', f => { f.config.preflight.expiresAt = '2000-01-01T00:00:00Z'; }],
  ['unknown stage', f => { f.config.preflight.stage = 'review_complete'; }],
  ['missing first-run marker', f => { delete f.config.preflight.purpose; }],
  ['unobserved review completion claim', f => { f.config.preflight.reviewAcceptance = 'complete'; }],
  ['missing infrastructure check', f => { f.config.preflight.checks.pop(); }],
]) test(`startup v3 rejects ${name}`, async () => {
  const f = await runtimeFixture(); startupOptIn(f); mutate(f); if (repin) f.pin();
  assert.throws(() => authorizeRuntimeConfiguration(f.config, f.env), /configuration is invalid/);
});
