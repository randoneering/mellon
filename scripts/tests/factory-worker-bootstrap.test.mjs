import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { effectRequest, providerPatch, providerEvidence, providerDiagnostics } from '../../internal/factory-worker/smoke-client.mjs';
import { runContainer } from '../../internal/factory-worker/bootstrap.mjs';
import { workerInspection } from './fixtures/factory-worker-inspection.mjs';

class Socket extends EventEmitter {
  constructor(answer) { super(); this.answer = answer; this.sent = []; }
  send(frame) {
    const request = JSON.parse(frame);
    this.sent.push(request);
    if (request._tag === 'Request') this.answer?.(request, this);
  }
}
const reply = (socket, id, value) => socket.emit('message', Buffer.from(JSON.stringify({
  _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value },
})));

function initialConfig() {
  return { settings: { providerInstances: {} }, providers: [
    { instanceId: 'pi', driver: 'pi', enabled: false, installed: false, version: null, status: 'disabled', auth: { status: 'unknown' } },
    { instanceId: 'codex', driver: 'codex', enabled: true, installed: false, version: null, status: 'error', auth: { status: 'unknown' } },
  ] };
}
function finalConfig() {
  const c = initialConfig();
  c.settings = providerPatch(c).patch;
  Object.assign(c.providers[0], { enabled: true, installed: true, version: '1.5.2', status: 'warning', auth: { status: 'unauthenticated' } });
  c.providers[1].enabled = false;
  return c;
}

test('Effect client sends the real unary wire envelope and matches terminal request identity', async () => {
  const socket = new Socket((request, s) => {
    reply(s, 'unrelated', { unsafe: true });
    reply(s, request.id, { healthy: true });
  });
  assert.deepEqual(await effectRequest(socket, 'server.probe', {}, 100), { healthy: true });
  assert.deepEqual(Object.keys(socket.sent[0]).sort(), ['_tag', 'headers', 'id', 'payload', 'tag']);
  assert.equal(socket.sent[0]._tag, 'Request');
  assert.equal(socket.sent[0].tag, 'server.probe');
  assert.deepEqual(socket.sent[0].headers, []);
  assert.equal(socket.listenerCount('message'), 0);
});

for (const [label, answer] of [
  ['remote failure', (r, s) => s.emit('message', JSON.stringify({ _tag: 'Exit', requestId: r.id, exit: { _tag: 'Failure', cause: 'private-rpc-canary' } }))],
  ['malformed JSON', (r, s) => s.emit('message', 'private-rpc-canary')],
  ['connection close', (r, s) => s.emit('close')],
  ['timeout', () => {}],
]) {
  test(`Effect client refuses ${label} without leaking the response`, async () => {
    const s = new Socket(answer);
    await assert.rejects(effectRequest(s, 'server.probe', {}, 20), error => {
      assert.equal(error.message, 'Offline worker RPC failed.');
      return true;
    });
    assert.equal(s.listenerCount('message'), 0);
  });
}

test('provider patch explicitly disables synthesized defaults and enables only Pi', () => {
  const map = providerPatch(initialConfig()).patch.providerInstances;
  assert.equal(map.codex.enabled, false);
  assert.equal(map.codex.config.enabled, false);
  assert.equal(map.pi.driver, 'pi');
  assert.equal(map.pi.enabled, true);
  assert.equal(map.pi.config.enabled, true);
  assert.equal(map.pi.config.binaryPath, '/opt/pi/node_modules/.bin/pi');
  assert.deepEqual(map.pi.environment, [{ name: 'PI_CODING_AGENT_DIR', value: '/worker-state/pi-agent', sensitive: false }]);
});

for (const change of [
  c => { c.settings.providerInstances.existing = { driver: 'pi' }; },
  c => { c.providers.push({ instanceId: 'custom', driver: 'pi' }); },
  c => { c.providers = []; },
]) {
  test('provider patch refuses non-fresh or unexpected provider state', () => {
    const c = initialConfig(); change(c);
    assert.throws(() => providerPatch(c), /Offline worker provider state rejected/);
  });
}

test('offline provider evidence accepts unauthenticated successful Pi inventory without claiming inference', () => {
  const c = finalConfig();
  c.providers[0].message = 'private-status-canary';
  const report = providerEvidence(c);
  assert.equal(report.piVersion, '1.5.2');
  assert.equal(report.piAuth, 'unauthenticated');
  assert.equal(report.rpcInventoryVerified, true);
  assert.equal(JSON.stringify(report).includes('private-status-canary'), false);
});
for (const change of [
  c => { c.providers[0].auth.status = 'unknown'; },
  c => { c.providers[0].installed = false; },
  c => { c.providers[1].enabled = true; },
  c => { c.providers[0].version = '1.0.0'; },
]) {
  test('provider evidence rejects fallback discovery, missing runtime or unintended provider enablement', () => {
    const c = finalConfig(); change(c);
    assert.throws(() => providerEvidence(c), /Offline worker provider state rejected/);
  });
}

test('provider diagnostics retain fixed failure categories without raw status text', () => {
  const c = finalConfig();
  c.providers[0].auth.status = 'unknown';
  c.providers[0].message = 'RPC discovery failed: private-provider-canary';
  const report = providerDiagnostics(c);
  assert.equal(report.piInstalled, true);
  assert.equal(report.piAuth, 'unknown');
  assert.equal(report.messageCategory, 'inventory_failed');
  assert.equal(JSON.stringify(report).includes('private-provider-canary'), false);
});

test('provider rejection identifies the precise safe guard without raw configuration', () => {
  const c = finalConfig();
  c.settings.providerInstances.pi.config.binaryPath = '/host/unsafe-pi';
  assert.throws(() => providerEvidence(c), error => {
    assert.equal(error.code, 'pi_configuration');
    assert.equal(error.message, 'Offline worker provider state rejected.');
    return true;
  });
  const diagnostic = providerDiagnostics(c);
  assert.equal(diagnostic.rejection, 'pi_configuration');
  assert.equal(diagnostic.configurationChecks.configEnabled, true);
  assert.equal(diagnostic.configurationChecks.binaryMatches, false);
  assert.equal(diagnostic.configurationChecks.argumentsMatch, true);
});

test('provider evidence accepts T3 folding legacy config flags into instance envelopes', () => {
  const c = finalConfig();
  for (const entry of Object.values(c.settings.providerInstances)) delete entry.config.enabled;
  assert.equal(providerEvidence(c).rpcInventoryVerified, true);
  c.settings.providerInstances.pi.config.enabled = false;
  assert.throws(() => providerEvidence(c), /Offline worker provider state rejected/);
});

const IMAGE = `sha256:${'a'.repeat(64)}`;
const NAME = 'mellon-factory-bootstrap-012345abcdef';
const ID = 'b'.repeat(64);

test('create failure preserves a sanitized stage and never stops an unrelated container', async () => {
  const calls = [];
  const execute = args => { calls.push(args); return { status: 1, stdout: '', stderr: 'private-docker-canary' }; };
  const report = await runContainer(IMAGE, NAME, execute);
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'container_create');
  assert.equal(report.containerId, null);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(report).includes('private-docker-canary'), false);
});

test('failed inner smoke preserves safe stage and confirmed partial work', async () => {
  const calls = [];
  const execute = args => {
    calls.push(args);
    if (args[0] === 'create' || args[0] === 'start' || args[0] === 'stop') return { status: 0, stdout: ID };
    if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify([workerInspection(IMAGE, NAME, ID)]) };
    if (args[0] === 'exec') return { status: 1, stdout: JSON.stringify({
      ok: false, stage: 'pi_inventory', serverAuthenticated: true, innerBoundaryVerified: true,
      providerDiagnostics: { rejection: 'pi_configuration', piInstalled: true,
        piAuth: 'unauthenticated', configurationChecks: { configEnabled: false },
        rawError: 'private-inner-canary' },
    }) };
    throw new Error('Unexpected command');
  };
  const report = await runContainer(IMAGE, NAME, execute);
  assert.equal(report.ok, false);
  assert.equal(report.innerFailure.stage, 'pi_inventory');
  assert.equal(report.innerFailure.serverAuthenticated, true);
  assert.equal(report.innerFailure.providerDiagnostics.rejection, 'pi_configuration');
  assert.equal(report.containerStopped, true);
  assert.equal(JSON.stringify(report).includes('private-inner-canary'), false);
  assert.equal(calls.at(-1)[0], 'stop');
});

test('unsafe inspection prevents start and stops only the newly confirmed container', async () => {
  const calls = [];
  const execute = args => {
    calls.push(args);
    if (args[0] === 'create') return { status: 0, stdout: ID };
    if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify([{ Id: ID, HostConfig: { Privileged: true } }]) };
    if (args[0] === 'stop') return { status: 0, stdout: ID };
    throw new Error('Unexpected command');
  };
  const report = await runContainer(IMAGE, NAME, execute);
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'container_inspect');
  assert.equal(report.containerId, ID);
  assert.equal(report.containerStopped, true);
  assert.equal(calls.some(c => c[0] === 'start'), false);
  assert.deepEqual(calls.at(-1), ['stop', '--time', '15', ID]);
});
