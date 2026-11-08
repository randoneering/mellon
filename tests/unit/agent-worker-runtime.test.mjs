import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture, runtimeRequest } from '../fixtures/worker-runtime.mjs';

async function factory(options) {
  const module = await import('../../src/automation/worker/function.mjs');
  assert.equal(typeof module.createProductionWorkerFunction, 'function',
    'The default production composition must be exported.');
  return module.createProductionWorkerFunction(options);
}

async function run(f, request = runtimeRequest()) {
  const response = await (await factory({ env: f.env, report: f.report, factories: f.factories })).fetch(request);
  return { status: response.status, value: await response.json() };
}

test('disabled production default requires no credentials and constructs no clients', async () => {
  const f = await runtimeFixture();
  f.env = { AGENT_WORKER_ENABLED: 'false' };
  assert.deepEqual(await run(f), { status: 200, value: { status: 'disabled' } });
  assert.deepEqual(f.events, []);
  assert.equal(f.github.calls.length, 0);
});

test('real runtime composition verifies role, App, approval and preflight before one coordinator tick', async () => {
  const f = await runtimeFixture();
  assert.deepEqual(await run(f), { status: 200, value: { status: 'idle' } });
  assert.equal(f.events.filter(value => value === 'store.claim').length, 1);
  assert.ok(f.events.indexOf('database.release') < f.events.indexOf('store.claim'));
  assert.ok(f.github.calls.some(call => call.path === '/graphql'));
  assert.equal(f.pool().closed, true);
  assert.equal(f.h.state.modelRequests, 0);
  assert.equal(f.h.state.publications.length, 0);
});

test('runtime startup shares the explicitly smaller configured tick deadline', async () => {
  const f = await runtimeFixture();
  f.config.manifest.limits.tickDeadlineSeconds = 2;
  f.config.manifest.limits.modelCallDeadlineSeconds = 1;
  f.pin();
  const module = await import('../../src/automation/worker/github-app.mjs');
  f.factories.createBroker = (config, dependencies) => {
    const broker = module.createGitHubAppBroker(config, dependencies);
    return { ...broker, async getReadToken(control) {
      assert.ok(control.deadline - Date.now() <= 2000);
      return broker.getReadToken(control);
    } };
  };
  assert.deepEqual(await run(f), { status: 200, value: { status: 'idle' } });
});

test('public requests cannot construct runtime clients through forged payload fields', async () => {
  const f = await runtimeFixture();
  const request = runtimeRequest(); request.headers.delete('x-neon-trigger-invocation-id');
  assert.deepEqual(await run(f, request), { status: 401, value: { status: 'unauthorized' } });
  assert.deepEqual(f.events, []);
});

for (const [name, mutate, repin] of [
  ['missing config', f => { delete f.env.AGENT_WORKER_CONFIG_JSON; }, false],
  ['malformed config', f => { f.env.AGENT_WORKER_CONFIG_JSON = '{private data'; }, false],
  ['wrong external pin', f => { f.env.AGENT_WORKER_CONFIG_SHA256 = 'f'.repeat(64); }, false],
  ['missing preflight', f => { delete f.config.preflight; }, true],
  ['expired preflight', f => { f.config.preflight.expiresAt = '2000-01-01T00:00:00Z'; }, true],
  ['unknown evidence', f => { f.config.preflight.evidenceSha256 = ''; }, true],
  ['missing spend proof', f => { f.config.preflight.checks = f.config.preflight.checks.filter(x => x !== 'gateway_spend_limits'); }, true],
  ['missing admission opt-in', f => { delete f.config.manifest.model.inputAdmission; }, true],
  ['legacy Qodo identity', f => { f.config.manifest.qodoIdentities = [{ userId: 151058649 }]; }, true],
]) test(`runtime rejects ${name} before external work`, async () => {
  const f = await runtimeFixture(); mutate(f); if (repin) f.pin();
  const result = await run(f);
  assert.equal(result.status, 503);
  assert.equal(result.value.status, 'unavailable');
  assert.deepEqual(f.events, []);
  assert.equal(f.github.calls.length, 0);
});

test('runtime never inherits platform model credentials when worker credentials are missing', async () => {
  const f = await runtimeFixture();
  delete f.env.WORKER_MODEL_TOKEN;
  f.env.NEON_AI_GATEWAY_TOKEN = 'platform-owner-token';
  const result = await run(f);
  assert.equal(result.status, 503);
  assert.deepEqual(f.events, []);
});

test('preflight cannot be reused against a different database endpoint', async () => {
  const f = await runtimeFixture();
  f.env.AGENT_WORKER_DATABASE_URL = f.env.AGENT_WORKER_DATABASE_URL.replace('db.example', 'other.example');
  assert.equal((await run(f)).status, 503);
  assert.deepEqual(f.events, []);
});

test('gateway credential binding cannot be reused with a rotated token', async () => {
  const f = await runtimeFixture();
  f.env.WORKER_MODEL_TOKEN = 'different-worker-token';
  assert.equal((await run(f)).status, 503);
  assert.deepEqual(f.events, []);
});

test('runtime rejects database privilege or schema mismatch before claiming a job', async t => {
  for (const field of ['rolsuper', 'limits_ok']) await t.test(field, async () => {
    const f = await runtimeFixture(); f.role[field] = field === 'rolsuper';
    assert.equal((await run(f)).status, 503);
    assert.ok(!f.events.includes('store.claim'));
    assert.equal(f.pool().closed, true);
  });
});

test('a kill switch during runtime authorization returns disabled without a claim', async () => {
  const f = await runtimeFixture();
  const fetch = f.factories.fetch;
  f.factories.fetch = async (url, options) => {
    const value = await fetch(url, options);
    if (new URL(url).pathname === '/app') f.env.AGENT_WORKER_ENABLED = 'false';
    return value;
  };
  assert.deepEqual(await run(f), { status: 200, value: { status: 'disabled' } });
  assert.ok(!f.events.includes('store.claim'));
  assert.equal(f.pool().closed, true);
});

test('a kill switch after database claim stops before approval or model effects', async () => {
  const f = await runtimeFixture();
  f.h.store.claimTick = async (...args) => {
    f.env.AGENT_WORKER_ENABLED = 'false';
    return f.claimJob(...args);
  };
  const result = await run(f);
  assert.equal(result.value.status, 'needs_attention');
  assert.equal(f.h.state.stops.at(-1), 'recovery_approval_denied');
  assert.equal(f.h.state.publications.length, 0);
});

test('asynchronous diagnostic failures are observed without changing the safe receipt', async () => {
  const f = await runtimeFixture();
  let observed = 0;
  f.report = () => ({ then(_resolve, reject) {
    observed += 1;
    reject(new Error('private diagnostic failure'));
  } });
  f.factories.createDatabase = () => { throw new Error('private database failure'); };
  assert.equal((await run(f)).status, 503);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(observed > 0);
});

test('runtime receipts and diagnostics never contain configuration or credentials', async () => {
  const f = await runtimeFixture();
  f.factories.createDatabase = () => { throw new Error('private database password'); };
  const result = await run(f);
  assert.equal(result.status, 503);
  const output = JSON.stringify({ result, reports: f.reports });
  for (const secret of ['private database password', f.env.WORKER_MODEL_TOKEN,
    f.env.AGENT_WORKER_APP_PRIVATE_KEY, f.env.AGENT_WORKER_CONFIG_JSON]) {
    assert.equal(output.includes(secret), false);
  }
});
