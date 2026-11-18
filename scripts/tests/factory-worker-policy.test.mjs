import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createContainerArgs,
  verifyContainerInspection,
  fingerprintRuntime,
  verifyRuntime,
} from '../../internal/factory-worker/policy.mjs';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const NAME = 'mellon-factory-bootstrap-012345abcdef';
const TMPFS = {
  '/tmp': 'rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001,mode=1777',
  '/home/worker': 'rw,nosuid,nodev,noexec,size=64m,uid=10001,gid=10001,mode=0700',
  '/worker-state': 'rw,nosuid,nodev,noexec,size=256m,uid=10001,gid=10001,mode=0700',
  '/workspace/mellon': 'rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001,mode=0700',
};

function inspection() {
  return {
    Id: 'b'.repeat(64),
    Image: IMAGE,
    Name: `/${NAME}`,
    Config: {
      User: '10001:10001',
      WorkingDir: '/workspace/mellon',
      Entrypoint: ['node', '/opt/bootstrap/start.mjs'],
      Cmd: null,
      Labels: { 'org.mellon.factory.bootstrap': 'true' },
      Env: [
        'HOME=/home/worker',
        'PI_CODING_AGENT_DIR=/worker-state/pi-agent',
        'T3CODE_HOME=/worker-state/t3',
        'NODE_ENV=production',
        'NODE_VERSION=24.22.2',
        'YARN_VERSION=1.22.22',
        'LD_LIBRARY_PATH=/opt/t3/lib',
        'PATH=/opt/pi/node_modules/.bin:/opt/t3:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ],
    },
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
      UsernsMode: '', PidMode: '', IpcMode: 'private', UTSMode: '',
      CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'],
      Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 2000000000,
      PidsLimit: 128, Init: true, Binds: null, Mounts: [], Devices: [],
      DeviceRequests: null, PortBindings: {}, PublishAllPorts: false,
      Tmpfs: { ...TMPFS }, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    },
    Mounts: [],
    NetworkSettings: { Ports: {}, Networks: {} },
  };
}

for (const [flag, want] of [
  ['--network', 'none'], ['--user', '10001:10001'],
  ['--memory', '4g'], ['--memory-swap', '4g'], ['--cpus', '2'],
  ['--pids-limit', '128'], ['--cap-drop', 'ALL'],
  ['--security-opt', 'no-new-privileges'], ['--pull', 'never'],
]) {
  test(`container launch enforces ${flag}`, () => {
    const args = createContainerArgs(IMAGE, NAME);
    assert.equal(args[0], 'create');
    assert.equal(args[args.indexOf(flag) + 1], want);
    assert.equal(args.at(-1), IMAGE);
  });
}

test('container launch adds no host mounts, ports, inherited env or cleanup', () => {
  const args = createContainerArgs(IMAGE, NAME);
  for (const forbidden of ['--volume', '-v', '--mount', '--publish', '-p', '--env', '-e', '--env-file', '--privileged', '--rm']) {
    assert.equal(args.includes(forbidden), false);
  }
  assert.equal(args.includes('--read-only'), true);
  assert.equal(args.includes('--init'), true);
  for (const [path, flags] of Object.entries(TMPFS)) assert.ok(args.includes(`${path}:${flags}`));
});

for (const [image, name] of [
  ['node:latest', NAME], [`${IMAGE} --privileged`, NAME],
  [IMAGE, 'unrelated-service'], [IMAGE, `${NAME};touch /tmp/unsafe`],
]) {
  test(`rejects an unpinned image or out-of-scope container name ${name}`, () => {
    assert.throws(() => createContainerArgs(image, name), /Offline worker configuration rejected/);
  });
}

test('inspection accepts the constrained container and emits only safe evidence', () => {
  const report = verifyContainerInspection(inspection(), IMAGE, NAME);
  assert.equal(report.imageId, IMAGE);
  assert.equal(report.containerId, 'b'.repeat(64));
  assert.equal(report.boundaryVerified, true);
  assert.equal(JSON.stringify(report).includes('PATH='), false);
});

const unsafe = [
  ['host network', x => { x.HostConfig.NetworkMode = 'host'; }],
  ['writable root', x => { x.HostConfig.ReadonlyRootfs = false; }],
  ['root user', x => { x.Config.User = '0'; }],
  ['privileged mode', x => { x.HostConfig.Privileged = true; }],
  ['host PID namespace', x => { x.HostConfig.PidMode = 'host'; }],
  ['host IPC namespace', x => { x.HostConfig.IpcMode = 'host'; }],
  ['host UTS namespace', x => { x.HostConfig.UTSMode = 'host'; }],
  ['added capability', x => { x.HostConfig.CapAdd = ['SYS_ADMIN']; }],
  ['missing capability drop', x => { x.HostConfig.CapDrop = []; }],
  ['missing privilege guard', x => { x.HostConfig.SecurityOpt = []; }],
  ['host home bind', x => { x.HostConfig.Binds = ['/home:/host']; }],
  ['engine mount request', x => { x.HostConfig.Mounts = [{ Type: 'bind', Source: '/home', Target: '/host' }]; }],
  ['host mounted directory', x => { x.Mounts = [{ Type: 'bind', Destination: '/host' }]; }],
  ['published port', x => { x.HostConfig.PortBindings = { '3773/tcp': [{ HostPort: '3773' }] }; }],
  ['unbounded memory', x => { x.HostConfig.Memory = 0; }],
  ['unbounded swap', x => { x.HostConfig.MemorySwap = -1; }],
  ['unbounded CPUs', x => { x.HostConfig.NanoCpus = 0; }],
  ['unbounded PIDs', x => { x.HostConfig.PidsLimit = 0; }],
  ['wrong namespace label', x => { x.Config.Labels = {}; }],
  ['arbitrary entrypoint', x => { x.Config.Entrypoint = ['sh']; }],
  ['startup command override', x => { x.Config.Cmd = ['unsafe']; }],
  ['host credentials', x => { x.Config.Env.push('GITHUB_TOKEN=private-canary'); }],
  ['missing profile path', x => { x.Config.Env = x.Config.Env.filter(e => !e.startsWith('PI_CODING_AGENT_DIR=')); }],
  ['extra tmpfs location', x => { x.HostConfig.Tmpfs['/host'] = 'rw'; }],
  ['unbounded tmpfs', x => { x.HostConfig.Tmpfs['/tmp'] = 'rw'; }],
  ['device grant', x => { x.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }]; }],
  ['automatic restart', x => { x.HostConfig.RestartPolicy.Name = 'always'; }],
  ['missing inspect boundary', x => { delete x.HostConfig; }],
];
for (const [label, change] of unsafe) {
  test(`inspection refuses ${label} without exposing input`, () => {
    const value = inspection();
    change(value);
    assert.throws(() => verifyContainerInspection(value, IMAGE, NAME), error => {
      assert.equal(error.message, 'Offline worker configuration rejected.');
      return true;
    });
  });
}

test('inspection accepts Docker omitting the unused optional Mounts field', () => {
  const value = inspection();
  delete value.HostConfig.Mounts;
  assert.equal(verifyContainerInspection(value, IMAGE, NAME).boundaryVerified, true);
});

test('startup refuses the interactive host without leaking its environment', () => {
  const result = spawnSync(process.execPath, ['internal/factory-worker/start.mjs'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'private-startup-canary' },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    stage: 'worker_start', category: 'boundary_rejected',
  });
  assert.equal((result.stdout + result.stderr).includes('private-startup-canary'), false);
});

test('inspection rejects a prototype-named environment field', () => {
  const value = inspection();
  value.Config.Env.push('__proto__=private-canary');
  assert.throws(() => verifyContainerInspection(value, IMAGE, NAME), /Offline worker configuration rejected/);
});

test('runtime fingerprint binds real bytes and executable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mellon-worker-runtime-'));
  const file = join(root, 'tool');
  await writeFile(file, 'abc', { mode: 0o600 });
  const descriptor = '[["tool",false,3,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]]\n';
  const expected = {
    treeSha256: createHash('sha256').update(descriptor).digest('hex'),
    fileCount: 1, totalBytes: 3,
  };
  assert.deepEqual(await fingerprintRuntime(root), expected);
  assert.deepEqual(await verifyRuntime(root, expected), expected);
  await writeFile(file, 'abd');
  await assert.rejects(verifyRuntime(root, expected), /Offline worker configuration rejected/);
  await writeFile(file, 'abc');
  await chmod(file, 0o700);
  await assert.rejects(verifyRuntime(root, expected), /Offline worker configuration rejected/);
});

test('runtime attestation rejects extra files and symlinks rather than following them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mellon-worker-tree-'));
  await writeFile(join(root, 'tool'), 'abc');
  const expected = await fingerprintRuntime(root);
  await writeFile(join(root, 'extra'), 'different');
  await assert.rejects(verifyRuntime(root, expected), /Offline worker configuration rejected/);
  await symlink('/etc/passwd', join(root, 'escape'));
  await assert.rejects(fingerprintRuntime(root), /Offline worker configuration rejected/);
});
