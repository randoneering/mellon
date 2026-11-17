import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  relayPrepArgs, relayCredentialArgs, workerStateArgs, modelConfigMatches, verifyRelayInspection, readinessWithGrant,
} from '../../internal/factory-worker/relay-setup.mjs';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const SUFFIX = '012345abcdef';
const CONFIG = {
  name: `mellon-factory-worker-${SUFFIX}`, network: `mellon-factory-net-${SUFFIX}`, networkId: 'c'.repeat(64),
  stateVolume: `mellon-factory-state-${SUFFIX}`, workspaceVolume: `mellon-factory-workspace-${SUFFIX}`,
  proxyName: `mellon-factory-egress-${SUFFIX}`,
};
const flag = (args, name) => args.filter((v, i) => args[i - 1] === name);

test('relay helpers are offline, locked down and mount only the relay volume', () => {
  for (const args of [relayPrepArgs(IMAGE, CONFIG), relayCredentialArgs(IMAGE, CONFIG)]) {
    assert.deepEqual(flag(args, '--network'), ['none']);
    assert.deepEqual(flag(args, '--cap-drop'), ['ALL']);
    assert.deepEqual(flag(args, '--mount'), [`type=volume,src=mellon-factory-relay-state-${SUFFIX},dst=/dst`]);
    assert.ok(args.includes('--read-only'));
    for (const bad of ['--privileged', '--volume', '-v', '--publish', '--env']) assert.equal(args.includes(bad), false);
  }
  assert.deepEqual(flag(relayPrepArgs(IMAGE, CONFIG), '--cap-add'), ['CHOWN']);
  const credential = relayCredentialArgs(IMAGE, CONFIG);
  assert.deepEqual(flag(credential, '--user'), ['10001:10001']);
  assert.ok(credential.includes('--interactive'));
  assert.equal(flag(credential, '--cap-add').length, 0);
  assert.throws(() => relayCredentialArgs('latest', CONFIG), /rejected/);
});

test('the credential helper writes stdin to a fresh private relay store and refuses to overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-relay-setup-'));
  const args = relayCredentialArgs(IMAGE, CONFIG);
  const program = args[args.indexOf('-e') + 1].replaceAll("'/dst", `'${dir}`);
  const input = JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'synthetic-a', refresh: 'synthetic-r' } });
  const first = spawnSync(process.execPath, ['-e', program], { input, encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.equal(first.stdout.includes('synthetic'), false);
  assert.deepEqual(JSON.parse(first.stdout), { installed: true, providers: ['openai-codex'] });
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), input);
  assert.equal(spawnSync(process.execPath, ['-e', program], { input, encoding: 'utf8' }).status, 1);
  const other = await mkdtemp(join(tmpdir(), 'mellon-relay-setup-'));
  const bad = spawnSync(process.execPath, ['-e', program.replaceAll(dir, other)], { input: '{"other":{}}', encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('worker state setup writes an empty login and refuses a worker that still holds one', () => {
  const args = workerStateArgs('b'.repeat(64));
  assert.deepEqual(args.slice(0, 5), ['exec', 'b'.repeat(64), 'node', '--input-type=module', '-e']);
  assert.match(args[5], /auth\.json/);
  assert.match(args[5], /'\{\}'/);
  assert.match(args[5], /State not fresh/);
  for (const id of ['name', `${'b'.repeat(64)} --privileged`, undefined]) assert.throws(() => workerStateArgs(id), /rejected/);
});

test('model config comparison ignores only the relay capability fields', () => {
  const expected = { providers: { 'openai-codex': { models: [{ id: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api', name: 'x' }] } } };
  const relay = `http://mellon-factory-relay-${SUFFIX}:8790/backend-api`;
  const installed = structuredClone(expected);
  Object.assign(installed.providers['openai-codex'], { baseUrl: relay, apiKey: 'a.b.c' });
  installed.providers['openai-codex'].models[0].baseUrl = relay;
  assert.equal(modelConfigMatches(installed, expected, SUFFIX), true);
  assert.equal(modelConfigMatches(expected, expected, SUFFIX), true);
  const tampered = structuredClone(installed);
  tampered.providers['openai-codex'].models[0].name = 'changed';
  assert.equal(modelConfigMatches(tampered, expected, SUFFIX), false);
  const elsewhere = structuredClone(installed);
  elsewhere.providers['openai-codex'].baseUrl = 'https://attacker.example/backend-api';
  assert.equal(modelConfigMatches(elsewhere, expected, SUFFIX), false);
  const extra = structuredClone(installed);
  extra.providers.other = {};
  assert.equal(modelConfigMatches(extra, expected, SUFFIX), false);
});

function relayInspection() {
  return {
    Name: `/mellon-factory-relay-${SUFFIX}`, Image: IMAGE,
    Config: { User: '10001:10001', Labels: { 'org.mellon.factory.live': 'true' }, Env: [] },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, PortBindings: {}, Binds: null, NetworkMode: CONFIG.networkId },
    Mounts: [{ Type: 'volume', Name: `mellon-factory-relay-state-${SUFFIX}`, Destination: '/relay-state', RW: true }],
    NetworkSettings: { Networks: { [CONFIG.network]: {}, n8n_default: {} } },
  };
}

test('relay inspection accepts only the locked-down relay with its own volume', () => {
  assert.equal(verifyRelayInspection(relayInspection(), IMAGE, CONFIG).relayVerified, true);
  for (const change of [
    x => { x.Config.User = '0:0'; }, x => { x.HostConfig.Privileged = true; },
    x => { x.HostConfig.CapAdd = ['NET_ADMIN']; }, x => { x.HostConfig.ReadonlyRootfs = false; },
    x => { x.HostConfig.PortBindings = { '8790/tcp': [{}] }; },
    x => { x.Mounts.push({ Type: 'volume', Name: CONFIG.stateVolume, Destination: '/src', RW: true }); },
    x => { x.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/s', RW: true }); },
    x => { x.NetworkSettings.Networks.host = {}; }, x => { x.Image = `sha256:${'f'.repeat(64)}`; },
  ]) {
    const value = relayInspection(); change(value);
    assert.throws(() => verifyRelayInspection(value, IMAGE, CONFIG), /rejected/);
  }
});

test('readiness runs under a short grant that is always revoked, even when readiness fails', async () => {
  for (const ready of [true, false]) {
    const calls = [];
    const docker = (args, input) => {
      calls.push(args.includes('/opt/bootstrap/relay.mjs') ? args[4] : args.includes('-e') ? 'install' : 'other');
      if (args[4] === 'issue') return JSON.stringify({ grantId: 'f'.repeat(32), capability: 'a.b.c' });
      if (args[4] === 'revoke') return '{"revoked":true}';
      return '{"installed":"mellon-capability"}';
    };
    const check = async () => { calls.push('readiness'); if (!ready) throw new Error('not ready'); return { ok: true }; };
    const run = readinessWithGrant({ docker, relayId: 'e'.repeat(64), workerId: 'd'.repeat(64), suffix: SUFFIX }, check);
    if (ready) assert.deepEqual(await run, { ok: true });
    else await assert.rejects(run, /not ready/);
    assert.deepEqual(calls, ['issue', 'install', 'readiness', 'revoke']);
  }
});

test('readiness fails closed when the grant cannot be revoked', async () => {
  const docker = args => {
    if (args[4] === 'issue') return JSON.stringify({ grantId: 'f'.repeat(32), capability: 'a.b.c' });
    if (args[4] === 'revoke') return '{"revoked":false}';
    return '{"installed":"mellon-capability"}';
  };
  await assert.rejects(readinessWithGrant({ docker, relayId: 'e'.repeat(64), workerId: 'd'.repeat(64), suffix: SUFFIX }, async () => ({ ok: true })), /revocation/);
});
