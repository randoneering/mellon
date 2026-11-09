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
