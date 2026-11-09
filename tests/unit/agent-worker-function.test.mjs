import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseTriggerDelivery } from '@neon/functions/triggers';

let worker;
try {
  worker = await import('../../src/automation/worker/function.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const databaseUrl = 'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full';
const trustedConfig = Object.freeze({
  productionBranch: 'production',
  triggerId: 'trg-worker-synthetic',
  databaseRole: 'worker_synthetic',
});
const environment = {
  AGENT_WORKER_ENABLED: 'true',
  AGENT_WORKER_DATABASE_URL: databaseUrl,
  NEON_BRANCH: 'production',
};
const invocationId = 'invocation-synthetic-001';
const scheduledAt = '2026-06-01T00:00:00.000Z';

function payload(overrides = {}) {
  return {
    version: 1,
    invocation_id: invocationId,
    trigger: { type: 'schedule', id: 'trg-worker-synthetic', name: 'issueworkertick' },
    data: { scheduled_at: scheduledAt },
    ...overrides,
  };
}

function request({ path = '/tick', method = 'POST', body = payload(), headers = {} } = {}) {
  return new Request(`https://worker.invalid${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-neon-trigger-invocation-id': invocationId,
      ...headers,
    },
    ...(!['GET', 'HEAD'].includes(method) ? {
      body: typeof body === 'string' ? body : JSON.stringify(body),
    } : {}),
  });
}

function fixture(overrides = {}) {
  assert.equal(typeof worker?.createWorkerFunction, 'function', 'worker boundary is missing');
  const calls = [];
  const reports = [];
  const handle = worker.createWorkerFunction({
    env: { ...environment },
    trustedConfig,
    // Models attested runtime provenance, never a check of caller-controlled headers.
    verifyNativeRequest: async () => true,
    authorizeRuntime: async () => true,
    advanceTick: async delivery => {
      calls.push(delivery);
      return { status: 'advanced' };
    },
    report: line => reports.push(line),
    ...overrides,
  });
  return { handle, calls, reports };
}

async function responseBody(response, status, body) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), body);
}

function configResult(extraEnv = {}) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import config from './neon.ts';
    import { resolveConfig } from '@neon/config/v1';
    const targets = [
      {name:'production',exists:true,isDefault:true},
      {name:'preview/new',exists:false,isDefault:false},
      {name:'preview/inherited',exists:true,isDefault:false},
    ];
    console.log(JSON.stringify({config, branches: targets.map(branch => resolveConfig(config, branch))}));
  `], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AGENT_INTAKE_DATABASE_URL: 'postgresql://intake:synthetic@db.invalid/intake?sslmode=verify-full',
      GITHUB_WEBHOOK_SECRET: 'synthetic-webhook',
      GITHUB_READ_TOKEN: 'synthetic-read-token',
      GITHUB_REPOSITORY_ID: '123',
      ...extraEnv,
    },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('the Neon SDK resolves a disabled worker and schedule without new secrets', () => {
  const { config, branches } = configResult({ AGENT_WORKER_ENABLED: 'true' });
  assert.ok(config.functions.issueworker, 'disabled worker declaration is missing');
  assert.deepEqual(config.functions.issueworker, {
    name: 'Agent issue worker',
    source: './src/automation/worker/function.mjs',
    env: {
      AGENT_WORKER_ENABLED: 'false',
      AGENT_WORKER_CONFIG_JSON: '', AGENT_WORKER_CONFIG_SHA256: '',
      AGENT_WORKER_APP_PRIVATE_KEY: '', WORKER_MODEL_BASE_URL: '', WORKER_MODEL_TOKEN: '',
      AGENT_WORKER_DATABASE_URL: 'disabled',
      DATABASE_URL: 'disabled',
      DATABASE_URL_UNPOOLED: 'disabled',
    },
  });
  assert.deepEqual(config.triggers.issueworkertick, {
    type: 'schedule', function: 'issueworker', cron: '*/2 * * * *',
    functionPath: '/tick', enabled: false,
  });
  for (const branch of branches) {
    assert.equal(branch.authEnabled, true);
    assert.equal(branch.preview.aiGatewayEnabled, false);
    assert.equal(branch.triggers.find(trigger => trigger.name === 'issueworkertick').enabled, false);
    assert.equal(branch.preview.functions.find(fn => fn.slug === 'issueworker').env.AGENT_WORKER_ENABLED, 'false');
  }
  assert.equal(branches[1].ttlSeconds, 604800);
  assert.equal(branches[2].ttlSeconds, undefined);
});

test('bootstrap, App and model bindings are worker-only and stay inert in resolved branches', () => {
  const bindings = {
    AGENT_WORKER_CONFIG_JSON: '{"synthetic":"operator-config"}',
    AGENT_WORKER_CONFIG_SHA256: 'a'.repeat(64),
    AGENT_WORKER_APP_PRIVATE_KEY: 'synthetic-app-key',
    WORKER_MODEL_BASE_URL: 'https://br-test-api.ai.c-3.us-east-2.aws.neon.tech',
    WORKER_MODEL_TOKEN: 'synthetic-worker-token',
  };
  const { config, branches } = configResult(bindings);
  for (const [name, value] of Object.entries(bindings)) {
    assert.equal(config.functions.issueworker.env[name], value);
    assert.equal(config.functions.githubintake.env[name], undefined);
    for (const branch of branches) {
      assert.equal(branch.preview.functions.find(fn => fn.slug === 'issueworker').env[name], value);
      assert.equal(branch.triggers.find(trigger => trigger.name === 'issueworkertick').enabled, false);
    }
  }
});

test('worker-only env overrides both owner URLs without changing intake or Auth', () => {
  const { config } = configResult({
    AGENT_WORKER_DATABASE_URL: databaseUrl,
    DATABASE_URL: 'postgresql://owner:synthetic@db.invalid/owner',
    DATABASE_URL_UNPOOLED: 'postgresql://owner:synthetic@db.invalid/owner',
    WORKER_MODEL_TOKEN: 'synthetic-model-secret',
    WORKER_MODEL_BASE_URL: 'https://gateway.invalid/v1',
  });
  assert.equal(config.auth, true);
  assert.deepEqual(config.functions.githubintake, {
    name: 'Agent issue intake', source: './src/automation/function.mjs',
    env: {
      GITHUB_WEBHOOK_SECRET: 'synthetic-webhook',
      GITHUB_READ_TOKEN: 'synthetic-read-token',
      GITHUB_REPOSITORY_ID: '123',
      GITHUB_REPOSITORY_FULL_NAME: 'randoneering/mellon',
      AGENT_INTAKE_DATABASE_URL: 'postgresql://intake:synthetic@db.invalid/intake?sslmode=verify-full',
      DATABASE_URL: 'postgresql://intake:synthetic@db.invalid/intake?sslmode=verify-full',
      DATABASE_URL_UNPOOLED: 'postgresql://intake:synthetic@db.invalid/intake?sslmode=verify-full',
    },
  });
  assert.deepEqual(config.functions.issueworker.env, {
    AGENT_WORKER_ENABLED: 'false', AGENT_WORKER_DATABASE_URL: databaseUrl,
    AGENT_WORKER_CONFIG_JSON: '', AGENT_WORKER_CONFIG_SHA256: '', AGENT_WORKER_APP_PRIVATE_KEY: '',
    WORKER_MODEL_BASE_URL: 'https://gateway.invalid/v1', WORKER_MODEL_TOKEN: 'synthetic-model-secret',
    DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl,
  });
  const source = readFileSync(new URL('../../neon.ts', import.meta.url), 'utf8');
  const baseline = spawnSync('git', ['show', 'HEAD:neon.ts'], { encoding: 'utf8' });
  assert.equal(baseline.status, 0);
  const intakeBlock = text => text.slice(text.indexOf('    githubintake: {'), text.indexOf('\n    },', text.indexOf('    githubintake: {')) + 7);
  assert.equal(intakeBlock(source), intakeBlock(baseline.stdout));
  assert.equal(source.slice(source.indexOf('  // Branch policy:')), baseline.stdout.slice(baseline.stdout.indexOf('  // Branch policy:')));
});

for (const path of ['/', '/tick/', '/tick?enabled=true', '/other', '/%74ick']) {
  test(`rejects route ${path} before native parser or coordinator`, async () => {
    let touched = false;
    const { handle, calls } = fixture({
      verifyNativeRequest: () => { touched = true; throw new Error('must not run'); },
    });
    await responseBody(await handle.fetch(request({ path })), 404, { status: 'not_found' });
    assert.equal(touched, false);
    assert.equal(calls.length, 0);
  });
}

for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
  test(`rejects ${method} before native parser or coordinator`, async () => {
    let touched = false;
    const { handle, calls } = fixture({
      verifyNativeRequest: () => { touched = true; return true; },
    });
    const response = await handle.fetch(request({ method }));
    assert.equal(response.headers.get('allow'), 'POST');
    await responseBody(response, 405, { status: 'method_not_allowed' });
    assert.equal(touched, false);
    assert.equal(calls.length, 0);
  });
}

test('the default Neon ingress provenance check requires the edge-stripped invocation header', async () => {
  const handle = worker.createWorkerFunction({ env: { ...environment }, trustedConfig });
  await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
  await responseBody(await handle.fetch(request({ headers: { 'x-neon-trigger-invocation-id': '' } })), 401,
    { status: 'unauthorized' });
});

test('a denied runtime provenance check stops before parsing or activation', async () => {
  let touched = false;
  const { handle, calls } = fixture({
    verifyNativeRequest: async () => false,
    parseDelivery: () => { touched = true; throw new Error('must not run'); },
    authorizeRuntime: () => { touched = true; return true; },
  });
  await responseBody(await handle.fetch(request()), 401, { status: 'unauthorized' });
  assert.equal(touched, false);
  assert.equal(calls.length, 0);
});

for (const [name, options] of [
  ['missing native header', { headers: { 'x-neon-trigger-invocation-id': '' } }],
  ['mismatched invocation ID', { headers: { 'x-neon-trigger-invocation-id': 'different' } }],
  ['invalid JSON', { body: '{' }],
  ['wrong body version', { body: payload({ version: 2 }) }],
  ['wrong trigger ID', { body: payload({ trigger: { type: 'schedule', id: 'other', name: 'issueworkertick' } }) }],
  ['wrong trigger name', { body: payload({ trigger: { type: 'schedule', id: 'trg-worker-synthetic', name: 'other' } }) }],
  ['wrong trigger type', { body: payload({ trigger: { type: 'storage_object_created', id: 'trg-worker-synthetic', name: 'issueworkertick' }, data: { bucket_name: 'bucket', object_key: 'key' } }) }],
  ['unsafe invocation ID', { body: payload({ invocation_id: 'bad\u001b[31m' }), headers: { 'x-neon-trigger-invocation-id': 'bad\u001b[31m' } }],
  ['invalid schedule time', { body: payload({ data: { scheduled_at: 'not-a-date' } }) }],
  ['oversized payload', { body: JSON.stringify(payload({ untrusted: 'x'.repeat(4096) })) }],
]) {
  test(`rejects ${name} before activation or coordinator`, async () => {
    let authorized = false;
    const { handle, calls } = fixture({
      authorizeRuntime: () => { authorized = true; return true; },
    });
    await responseBody(await handle.fetch(request(options)), 401, { status: 'unauthorized' });
    assert.equal(authorized, false);
    assert.equal(calls.length, 0);
  });
}

for (const enabled of [undefined, '', 'false', 'TRUE', '1']) {
  test(`worker flag ${JSON.stringify(enabled)} keeps all runtime dependencies inert`, async () => {
    let authorized = false;
    const { handle, calls } = fixture({
      env: { AGENT_WORKER_ENABLED: enabled },
      authorizeRuntime: () => { authorized = true; return true; },
    });
    await responseBody(await handle.fetch(request()), 200, { status: 'disabled' });
    assert.equal(authorized, false);
    assert.equal(calls.length, 0);
  });
}

for (const branch of [undefined, '', 'preview/worker', 'Production']) {
  test(`branch ${JSON.stringify(branch)} cannot enable an inherited production schedule`, async () => {
    const { handle, calls } = fixture({ env: { ...environment, NEON_BRANCH: branch } });
    await responseBody(await handle.fetch(request()), 200, { status: 'disabled' });
    assert.equal(calls.length, 0);
  });
}

for (const [name, overrides] of [
  ['missing trust config', { trustedConfig: undefined }],
  ['missing trigger identity', { trustedConfig: { ...trustedConfig, triggerId: '' } }],
  ['missing database role', { trustedConfig: { ...trustedConfig, databaseRole: '' } }],
  ['missing authorizer', { authorizeRuntime: undefined }],
  ['denied authorizer', { authorizeRuntime: async () => false }],
  ['nonboolean authorization', { authorizeRuntime: async () => ({ approved: true }) }],
]) {
  test(`an unavailable trusted activation contract stays closed: ${name}`, async () => {
    const { handle, calls } = fixture(overrides);
    await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
    assert.equal(calls.length, 0);
  });
}

for (const field of ['AGENT_WORKER_ENABLED', 'NEON_BRANCH']) {
  test(`a changed ${field} kill switch stops the tick after activation waits`, async () => {
    const env = { ...environment };
    const { handle, calls } = fixture({
      env,
      authorizeRuntime: async () => {
        env[field] = field === 'AGENT_WORKER_ENABLED' ? 'false' : 'preview/changed';
        return true;
      },
    });
    await responseBody(await handle.fetch(request()), 200, { status: 'disabled' });
    assert.equal(calls.length, 0);
  });
}

test('a truthy provenance result never authenticates a caller', async () => {
  const { handle, calls } = fixture({ verifyNativeRequest: async () => ({ native: true }) });
  await responseBody(await handle.fetch(request()), 401, { status: 'unauthorized' });
  assert.equal(calls.length, 0);
});

test('oversized chunked native bodies are cancelled before coordinator activity', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(4097))); },
    cancel() { cancelled = true; },
  });
  const streamed = new Request('https://worker.invalid/tick', {
    method: 'POST', body, duplex: 'half',
    headers: { 'x-neon-trigger-invocation-id': invocationId },
  });
  const { handle, calls } = fixture();
  await responseBody(await handle.fetch(streamed), 401, { status: 'unauthorized' });
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
});

test('the approved role cannot reuse the intake database identity', async () => {
  const { handle, calls, reports } = fixture({ env: {
    ...environment, AGENT_INTAKE_DATABASE_URL: databaseUrl,
  } });
  await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
  assert.equal(calls.length, 0);
  assert.deepEqual(reports, ['[agent_worker] configuration_invalid']);
});

test('missing coordinator wiring fails closed instead of reporting a successful no-op', async () => {
  const { handle, reports } = fixture({ advanceTick: undefined });
  await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
  assert.deepEqual(reports, ['[agent_worker] coordinator_unavailable']);
});

test('valid injected tick advances once with no credentials or untrusted fields', async () => {
  const { handle, calls } = fixture();
  await responseBody(await handle.fetch(request({ body: payload({
    issue: 'private body', authorization: 'synthetic-token',
  }) })), 200, { status: 'advanced' });
  assert.deepEqual(calls, [{
    invocationId, type: 'schedule',
    trigger: { type: 'schedule', id: 'trg-worker-synthetic', name: 'issueworkertick' },
    data: { scheduledAt },
  }]);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.isFrozen(calls[0].trigger), true);
  assert.equal(Object.isFrozen(calls[0].data), true);
});

test('duplicate deliveries preserve the same durable identity across handler restarts', async () => {
  const claimed = new Set();
  let phases = 0;
  const advanceTick = async delivery => {
    if (claimed.has(delivery.invocationId)) return { status: 'duplicate' };
    claimed.add(delivery.invocationId);
    phases += 1;
    return { status: 'advanced' };
  };
  const first = fixture({ advanceTick });
  const restarted = fixture({ advanceTick });
  const results = await Promise.all([
    first.handle.fetch(request()), restarted.handle.fetch(request()),
  ]);
  assert.deepEqual(await Promise.all(results.map(response => response.json())), [
    { status: 'advanced' }, { status: 'duplicate' },
  ]);
  assert.equal(phases, 1);
  assert.deepEqual(await (await restarted.handle.fetch(request())).json(), { status: 'duplicate' });
});

for (const value of [
  undefined, 'disabled',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=require',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&sslmode=disable',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&sslmode=verify-full',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&sslcert=synthetic',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&sslrootcert=synthetic',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&rejectUnauthorized=false',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&uselibpqcompat=true',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&host=other.invalid',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&hostaddr=127.0.0.1',
  'postgresql://worker_synthetic:synthetic@db.invalid/worker?sslmode=verify-full&servername=other.invalid',
  'postgresql://owner:synthetic@db.invalid/worker?sslmode=verify-full',
  'postgresql://intake:synthetic@db.invalid/worker?sslmode=verify-full',
]) {
  test(`rejects unsafe or unapproved worker database URL ${value?.replace('synthetic', 'test')}`, async () => {
    const { handle, calls, reports } = fixture({ env: { ...environment, AGENT_WORKER_DATABASE_URL: value } });
    await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
    assert.equal(calls.length, 0);
    assert.deepEqual(reports, ['[agent_worker] configuration_invalid']);
  });
}

test('runtime environment ignores intake secrets and platform owner URLs', () => {
  assert.equal(typeof worker?.workerRuntimeEnvironment, 'function', 'worker env boundary is missing');
  const runtime = worker.workerRuntimeEnvironment({
    ...environment,
    DATABASE_URL: 'postgresql://owner:synthetic@db.invalid/owner',
    DATABASE_URL_UNPOOLED: 'postgresql://owner:synthetic@db.invalid/owner',
    AGENT_INTAKE_DATABASE_URL: 'postgresql://intake:synthetic@db.invalid/intake',
    GITHUB_WEBHOOK_SECRET: 'synthetic-webhook', GITHUB_READ_TOKEN: 'synthetic-intake-token',
    NEON_API_KEY: 'synthetic-provisioning-key',
    WORKER_MODEL_TOKEN: 'synthetic-model-secret',
  }, trustedConfig.databaseRole);
  assert.deepEqual(runtime, {
    AGENT_WORKER_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl,
  });
  assert.equal(Object.isFrozen(runtime), true);
});

for (const stage of ['provenance', 'parser', 'activation', 'coordinator']) {
  test(`${stage} exceptions publish only a fixed category without raw data`, async () => {
    const privateError = new Error('synthetic-token private-issue db.invalid raw-response \u001b[31m');
    const overrides = {
      provenance: { verifyNativeRequest: () => { throw privateError; } },
      parser: { parseDelivery: () => { throw privateError; } },
      activation: { authorizeRuntime: () => { throw privateError; } },
      coordinator: { advanceTick: () => { throw privateError; } },
    }[stage];
    const { handle, reports } = fixture(overrides);
    await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
    assert.deepEqual(reports, [`[agent_worker] ${stage}_unavailable`]);
  });
}

test('a coordinator returning no outcome cannot report successful advancement', async () => {
  const { handle, reports } = fixture({ advanceTick: async () => undefined });
  await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
  assert.deepEqual(reports, ['[agent_worker] coordinator_unavailable']);
});

test('extra coordinator fields never become an HTTP response or log', async () => {
  const { handle, reports } = fixture({ advanceTick: async () => ({ status: 'waiting', token: 'synthetic-token' }) });
  await responseBody(await handle.fetch(request()), 200, { status: 'waiting' });
  assert.deepEqual(reports, []);
});

test('proposal diagnostics reach the report callback through a closed metadata projection', async () => {
  const { handle, reports } = fixture({ advanceTick: async () => ({
    status: 'needs_attention', reason: 'private reason', diagnostics: {
      proposalCategory: 'rejected_proposal', proposalRejection: 'binding',
      toolCounts: { proposeChanges: 1, readFile: 17, listFiles: 2, secret: 1 },
      text: 'private issue',
    },
  }) });
  await responseBody(await handle.fetch(request()), 200, { status: 'needs_attention' });
  assert.deepEqual(reports, [
    '[agent_worker] stage=model category=rejected_proposal rejection=binding listFiles=2 proposeChanges=1',
  ]);
});

test('unknown proposal diagnostic values never reach reports', async () => {
  const { handle, reports } = fixture({ advanceTick: async () => ({
    status: 'needs_attention', diagnostics: { proposalCategory: 'private issue',
      proposalRejection: 'synthetic-token', toolCounts: { readFile: 1 } },
  }) });
  await responseBody(await handle.fetch(request()), 200, { status: 'needs_attention' });
  assert.deepEqual(reports, []);
});

test('proposal diagnostic reporter failures preserve the public response', async () => {
  const { handle } = fixture({ advanceTick: async () => ({ status: 'needs_attention',
    diagnostics: { proposalCategory: 'prose_only', toolCounts: {} } }),
    report: () => { throw new Error('private reporter'); } });
  await responseBody(await handle.fetch(request()), 200, { status: 'needs_attention' });
});

test('review request reports preserve only fixed categories sources and confirmed ids', async () => {
  const { handle, reports } = fixture({ advanceTick: async () => ({ status: 'needs_attention',
    reviewDiagnostics: { category: 'review_write_uncertain', commentId: 99, source: 'maintainer',
      body: 'private issue', token: 'synthetic-token' } }) });
  await responseBody(await handle.fetch(request()), 200, { status: 'needs_attention' });
  assert.deepEqual(reports, ['[agent_worker] stage=review_request category=review_write_uncertain comment_id=99 source=maintainer']);
});

test('unrecognized review diagnostics cannot enter reports', async () => {
  const { handle, reports } = fixture({ advanceTick: async () => ({ status: 'waiting',
    reviewDiagnostics: { category: 'private token', commentId: 'private id', source: 'spoofed' } }) });
  await responseBody(await handle.fetch(request()), 200, { status: 'waiting' });
  assert.deepEqual(reports, []);
});

test('unrecognized coordinator data never becomes an HTTP response or log', async () => {
  const { handle, reports } = fixture({ advanceTick: async () => ({ status: 'private-issue', token: 'synthetic-token' }) });
  await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
  assert.deepEqual(reports, ['[agent_worker] coordinator_unavailable']);
});

test('reporter failures cannot expose exceptions or break the fixed response', async () => {
  const { handle } = fixture({ advanceTick: undefined, report: () => { throw new Error('synthetic-secret'); } });
  await responseBody(await handle.fetch(request()), 503, { status: 'unavailable' });
});

test('default deployed entrypoint accepts native marker but remains disabled without activation', async () => {
  assert.ok(worker?.default, 'worker default entrypoint is missing');
  await responseBody(await worker.default.fetch(request()), 200, { status: 'disabled' });
});
