import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayArgs, createJobArgs, verifyJobInspection, verifyPrivateNetwork, verifyWorkerVolume, verifyWorkerAuth, workerModelConfiguration } from '../../internal/factory-worker/job-policy.mjs';
import { workerInspection } from './fixtures/factory-worker-inspection.mjs';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const SUFFIX = '012345abcdef';
const CONFIG = {
  name: `mellon-factory-worker-${SUFFIX}`,
  network: `mellon-factory-net-${SUFFIX}`,
  networkId: 'c'.repeat(64),
  stateVolume: `mellon-factory-state-${SUFFIX}`,
  workspaceVolume: `mellon-factory-workspace-${SUFFIX}`,
  proxyName: `mellon-factory-egress-${SUFFIX}`,
};

function jobInspection() {
  const x = workerInspection(IMAGE, CONFIG.name, 'b'.repeat(64));
  x.Config.Labels = { 'org.mellon.factory.live': 'true' };
  x.Config.Env.push(`HTTPS_PROXY=http://${CONFIG.proxyName}:8788`, `HTTP_PROXY=http://${CONFIG.proxyName}:8788`, `NO_PROXY=localhost,127.0.0.1,mellon-factory-relay-${SUFFIX}`, 'NODE_USE_ENV_PROXY=1');
  x.HostConfig.NetworkMode = CONFIG.networkId;
  delete x.HostConfig.Tmpfs['/worker-state'];
  delete x.HostConfig.Tmpfs['/workspace/mellon'];
  x.HostConfig.Mounts = [
    { Type: 'volume', Source: CONFIG.stateVolume, Target: '/worker-state' },
    { Type: 'volume', Source: CONFIG.workspaceVolume, Target: '/workspace/mellon' },
  ];
  x.Mounts = [
    { Type: 'volume', Name: CONFIG.stateVolume, Destination: '/worker-state', RW: true },
    { Type: 'volume', Name: CONFIG.workspaceVolume, Destination: '/workspace/mellon', RW: true },
  ];
  x.NetworkSettings.Networks = { [CONFIG.network]: { NetworkID: CONFIG.networkId } };
  return x;
}

test('job launch uses only the pinned private network and worker-specific volumes', () => {
  const args = createJobArgs(IMAGE, CONFIG);
  assert.equal(args[args.indexOf('--network') + 1], CONFIG.networkId);
  assert.equal(args.includes('--publish'), false);
  assert.ok(args.includes(`type=volume,src=${CONFIG.stateVolume},dst=/worker-state`));
  assert.ok(args.includes(`type=volume,src=${CONFIG.workspaceVolume},dst=/workspace/mellon`));
  assert.equal(args.includes('--privileged'), false);
  assert.equal(args.at(-1), IMAGE);
});

test('actual job inspection keeps all offline safeguards except validated private-network/state changes', () => {
  assert.equal(verifyJobInspection(jobInspection(), IMAGE, CONFIG).boundaryVerified, true);
});
for (const change of [
  x => { x.HostConfig.NetworkMode = 'host'; },
  x => { x.NetworkSettings.Networks.host = {}; },
  x => { x.HostConfig.Mounts[0].Source = 'unrelated-volume'; },
  x => { x.Mounts[0].Name = 'unrelated-volume'; },
  x => { x.Config.Env.push('GITHUB_TOKEN=private-canary'); },
  x => { x.Config.Env = x.Config.Env.map(e => e.startsWith('HTTPS_PROXY=') ? 'HTTPS_PROXY=http://attacker:8788' : e); },
  x => { x.HostConfig.Privileged = true; },
  x => { x.HostConfig.PortBindings = { '3773/tcp': [{ HostPort: '3773' }] }; },
]) {
  test('job inspection rejects unapproved authority or a changed kernel boundary', () => {
    const value = jobInspection(); change(value);
    assert.throws(() => verifyJobInspection(value, IMAGE, CONFIG), /Factory job boundary rejected/);
  });
}

test('the network must be internal with an isolated gateway and the correct owner', () => {
  const value = { Id: CONFIG.networkId, Name: CONFIG.network, Driver: 'bridge', Internal: true,
    Labels: { 'org.mellon.factory.live': 'true' }, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } };
  assert.equal(verifyPrivateNetwork(value, CONFIG).verified, true);
  value.Internal = false;
  assert.throws(() => verifyPrivateNetwork(value, CONFIG), /Factory job boundary rejected/);
  value.Internal = true;
  value.EnableIPv6 = true;
  assert.throws(() => verifyPrivateNetwork(value, CONFIG), /Factory job boundary rejected/);
});

test('worker data volumes cannot be bind-backed or use another driver', () => {
  const value = { Name: CONFIG.stateVolume, Driver: 'local', Scope: 'local', Options: null, Labels: { 'org.mellon.factory.live': 'true' } };
  assert.equal(verifyWorkerVolume(value, CONFIG.stateVolume).verified, true);
  value.Options = { type: 'none', device: '/home', o: 'bind' };
  assert.throws(() => verifyWorkerVolume(value, CONFIG.stateVolume), /Factory job boundary rejected/);
});

test('worker authorization accepts only its dedicated model credential without echoing keys', () => {
  const data = { 'openai-codex': { type: 'oauth', access: 'private-access-canary', refresh: 'private-refresh-canary', expires: 9999999999999, accountId: 'worker-account' } };
  assert.deepEqual(verifyWorkerAuth(data), { provider: 'openai-codex', type: 'oauth', verified: true });
  assert.equal(JSON.stringify(verifyWorkerAuth(data)).includes('private-access-canary'), false);
  data.github = { type: 'api_key', key: 'forbidden-key' };
  assert.throws(() => verifyWorkerAuth(data), /Factory job boundary rejected/);
});

test('model metadata preserves the selected model without host auth, headers or extension code', () => {
  const model = { id: 'gpt-6.1-sol', provider: 'openai-codex', api: 'openai-codex-responses',
    name: 'Selected model', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true,
    input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
  const config = workerModelConfiguration(model);
  assert.equal(config.providers['openai-codex'].models[0].id, 'gpt-6.1-sol');
  assert.equal(config.providers['openai-codex'].models[0].provider, undefined);
  assert.equal(config.providers['openai-codex'].apiKey, undefined);
  assert.throws(() => workerModelConfiguration({ ...model, baseUrl: 'https://attacker.example' }), /Factory job boundary rejected/);
  assert.throws(() => workerModelConfiguration({ ...model, headers: { Authorization: 'private-model-canary' } }), /Factory job boundary rejected/);
  assert.throws(() => workerModelConfiguration({ ...model, id: 'different-model' }), /Factory job boundary rejected/);
});

test('resource options cannot inject an unrelated service or host namespace', () => {
  assert.throws(() => createJobArgs(IMAGE, { ...CONFIG, network: 'n8n_default' }), /Factory job boundary rejected/);
  assert.throws(() => createJobArgs(IMAGE, { ...CONFIG, workspaceVolume: '/home' }), /Factory job boundary rejected/);
});

test('the worker bypasses the CONNECT proxy only for its own same-suffix relay', () => {
  const args = createJobArgs(IMAGE, CONFIG);
  const value = args.filter((v, i) => args[i - 1] === '--env' && v.startsWith('NO_PROXY='));
  assert.deepEqual(value, [`NO_PROXY=localhost,127.0.0.1,mellon-factory-relay-${SUFFIX}`]);
  const inspected = jobInspection();
  inspected.Config.Env = inspected.Config.Env.map(e => e.startsWith('NO_PROXY=') ? 'NO_PROXY=localhost,127.0.0.1,chatgpt.com' : e);
  assert.throws(() => verifyJobInspection(inspected, IMAGE, CONFIG), /rejected/);
});

test('the relay runs as a separate locked-down container with only its own credential volume', () => {
  const args = createRelayArgs(IMAGE, CONFIG);
  const value = flag => args.filter((v, i) => args[i - 1] === flag);
  assert.deepEqual(value('--name'), [`mellon-factory-relay-${SUFFIX}`]);
  assert.deepEqual(value('--network'), [CONFIG.networkId]);
  assert.deepEqual(value('--user'), ['10001:10001']);
  assert.deepEqual(value('--cap-drop'), ['ALL']);
  assert.deepEqual(value('--security-opt'), ['no-new-privileges']);
  assert.deepEqual(value('--mount'), [`type=volume,src=mellon-factory-relay-state-${SUFFIX},dst=/relay-state`]);
  assert.ok(args.includes('--read-only'));
  for (const flag of ['--publish', '--privileged', '--volume', '-v', '--env']) assert.equal(args.includes(flag), false);
  assert.equal(args.some(v => String(v).includes('docker.sock') || String(v).includes(CONFIG.stateVolume)), false);
  assert.deepEqual(args.slice(-3), [IMAGE, '/opt/bootstrap/relay.mjs', 'serve']);
  assert.throws(() => createRelayArgs('latest', CONFIG), /rejected/);
});
