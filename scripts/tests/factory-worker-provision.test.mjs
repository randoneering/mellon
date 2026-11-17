import test from 'node:test';
import assert from 'node:assert/strict';
import * as provisioning from '../../internal/factory-worker/provision-live.mjs';
import { workerInspection } from './fixtures/factory-worker-inspection.mjs';

const { provision } = provisioning;
const IMAGE = `sha256:${'a'.repeat(64)}`;
const SUFFIX = '012345abcdef';
const NET = 'c'.repeat(64);
const WORKER = 'b'.repeat(64);
const RELAY = 'e'.repeat(64);
const PROXY = '9'.repeat(64);
const AUTH = { 'openai-codex': { type: 'oauth', access: 'synthetic-access-canary', refresh: 'synthetic-refresh-canary', expires: 1, accountId: 'synthetic-account' } };
const MODEL = { id: 'gpt-6.1-sol', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', name: 'GPT', input: ['text'], contextWindow: 1000, maxTokens: 100 };
const CONFIG = {
  name: `mellon-factory-worker-${SUFFIX}`, network: `mellon-factory-net-${SUFFIX}`, networkId: NET,
  stateVolume: `mellon-factory-state-${SUFFIX}`, workspaceVolume: `mellon-factory-workspace-${SUFFIX}`, proxyName: `mellon-factory-egress-${SUFFIX}`,
};

function jobInspection() {
  const x = workerInspection(IMAGE, CONFIG.name, WORKER);
  x.Config.Labels = { 'org.mellon.factory.live': 'true' };
  x.Config.Env.push(`HTTPS_PROXY=http://${CONFIG.proxyName}:8788`, `HTTP_PROXY=http://${CONFIG.proxyName}:8788`, `NO_PROXY=localhost,127.0.0.1,mellon-factory-relay-${SUFFIX}`, 'NODE_USE_ENV_PROXY=1');
  x.HostConfig.NetworkMode = NET;
  delete x.HostConfig.Tmpfs['/worker-state'];
  delete x.HostConfig.Tmpfs['/workspace/mellon'];
  x.HostConfig.Mounts = [{ Type: 'volume', Source: CONFIG.stateVolume, Target: '/worker-state' }, { Type: 'volume', Source: CONFIG.workspaceVolume, Target: '/workspace/mellon' }];
  x.Mounts = [{ Type: 'volume', Name: CONFIG.stateVolume, Destination: '/worker-state', RW: true }, { Type: 'volume', Name: CONFIG.workspaceVolume, Destination: '/workspace/mellon', RW: true }];
  x.NetworkSettings.Networks = { [CONFIG.network]: { NetworkID: NET } };
  return x;
}
const relayInspection = () => ({
  Id: RELAY, Name: `/mellon-factory-relay-${SUFFIX}`, Image: IMAGE,
  Config: { User: '10001:10001', Labels: { 'org.mellon.factory.live': 'true' } },
  HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, PortBindings: {}, Binds: null },
  Mounts: [{ Type: 'volume', Name: `mellon-factory-relay-state-${SUFFIX}`, Destination: '/relay-state', RW: true }],
  NetworkSettings: { Networks: { [CONFIG.network]: {}, n8n_default: {} } },
});

function fakeDocker(calls) {
  return async (args, input) => {
    calls.push({ args, input });
    const has = value => args.includes(value);
    if (args[0] === 'network' && args[1] === 'create') return NET;
    if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify([{ Id: NET, Name: CONFIG.network, Driver: 'bridge', Internal: true, Labels: { 'org.mellon.factory.live': 'true' }, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } }]);
    if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify([{ Name: args[2], Driver: 'local', Scope: 'local', Options: null, Labels: { 'org.mellon.factory.live': 'true' } }]);
    if (args[0] === 'create' && args.some(a => String(a).startsWith('mellon-factory-relay-prep-'))) return '1'.repeat(64);
    if (args[0] === 'create' && args.some(a => String(a).startsWith('mellon-factory-relay-credential-'))) return '2'.repeat(64);
    if (args[0] === 'start' && has('--interactive')) return JSON.stringify({ installed: true, providers: Object.keys(JSON.parse(input)) });
    if (args[0] === 'create' && has('/opt/bootstrap/egress.mjs')) return PROXY;
    if (args[0] === 'create' && has('/opt/bootstrap/relay.mjs')) return RELAY;
    if (args[0] === 'create') return WORKER;
    if (args[0] === 'inspect' && args[1] === RELAY) return JSON.stringify([relayInspection()]);
    if (args[0] === 'inspect' && args[1] === WORKER) return JSON.stringify([jobInspection()]);
    if (has('/opt/bootstrap/relay.mjs') && args[4] === 'issue') return JSON.stringify({ grantId: 'f'.repeat(32), capability: 'a.b.c' });
    if (has('/opt/bootstrap/relay.mjs') && args[4] === 'revoke') return '{"revoked":true}';
    if (args[0] === 'exec' && String(args.at(-1)).includes('mellon-capability')) return '{"installed":"mellon-capability"}';
    if (args[0] === 'exec' && String(args.at(-1)).includes('workerAuthEntries')) return '{"installed":true,"workerAuthEntries":0}';
    return '{"installed":true}';
  };
}
const ready = { ok: true, stage: 'complete', serverAuthenticated: true, piEnabled: true, piInstalled: true, piVersion: '1.5.2', modelAuth: 'authenticated', modelAvailable: true, modelCount: 1, otherProvidersDisabled: true };
const io = (calls, readiness = async () => ready) => ({ docker: fakeDocker(calls), readAuth: async () => AUTH, readModel: async () => MODEL, readiness, persist: async () => {}, suffix: SUFFIX });

test('fresh provisioning puts the model login only in the relay and records the relay', async () => {
  const calls = [];
  const result = await provision(IMAGE, io(calls));
  assert.equal(result.ok, true);
  assert.equal(result.resources.relayId, RELAY);
  assert.equal(result.relayHost, `mellon-factory-relay-${SUFFIX}`);
  assert.equal(result.relayBoundary.relayVerified, true);
  const carrying = calls.filter(c => JSON.stringify(c).includes('synthetic-access-canary'));
  assert.equal(carrying.length, 1);
  assert.deepEqual(carrying[0].args, ['start', '--attach', '--interactive', '2'.repeat(64)]);
  assert.equal(calls.some(c => c.args.includes(WORKER) && JSON.stringify(c).includes('synthetic')), false);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});

test('provisioning order gives the worker an empty login, then checks readiness under a revoked grant', async () => {
  const calls = [];
  await provision(IMAGE, io(calls));
  const index = test => calls.findIndex(test);
  const relayStart = index(c => c.args[0] === 'start' && c.args[1] === RELAY);
  const workerState = index(c => String(c.args.at(-1)).includes('workerAuthEntries'));
  const issue = index(c => c.args[4] === 'issue');
  const revoke = index(c => c.args[4] === 'revoke');
  assert.ok(relayStart >= 0 && workerState > relayStart && issue > workerState && revoke > issue);
  assert.equal(provisioning.credentialInstallArgs, undefined);
});

test('a failed readiness check still revokes its grant and stops every created container', async () => {
  const calls = [];
  const result = await provision(IMAGE, io(calls, async () => ({ ...ready, ok: false })));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'model_readiness');
  assert.ok(calls.some(c => c.args[4] === 'revoke'));
  for (const id of [WORKER, RELAY, PROXY]) assert.ok(calls.some(c => c.args[0] === 'stop' && c.args.at(-1) === id));
});

test('provisioning takes the sign-in session directory explicitly and checks its shape', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const good = join(tmpdir(), 'mellon-factory-auth-0123456789ab');
  assert.equal(provisioning.sessionAuthPath(good), join(good, 'pi-agent', 'auth.json'));
  for (const bad of [undefined, '', '/tmp/other', join(tmpdir(), 'mellon-factory-auth-xyz'), '/var/mellon-factory-auth-0123456789ab', join(tmpdir(), 'nested', 'mellon-factory-auth-0123456789ab')]) {
    assert.throws(() => provisioning.sessionAuthPath(bad), /rejected/);
  }
});
