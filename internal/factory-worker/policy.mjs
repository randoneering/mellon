import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const SAFE_ERROR = 'Offline worker configuration rejected.';
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const NAME = /^mellon-factory-bootstrap-[a-f0-9]{12}$/;
export const TMPFS = Object.freeze({
  '/tmp': 'rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001,mode=1777',
  '/home/worker': 'rw,nosuid,nodev,noexec,size=64m,uid=10001,gid=10001,mode=0700',
  '/worker-state': 'rw,nosuid,nodev,noexec,size=256m,uid=10001,gid=10001,mode=0700',
  '/workspace/mellon': 'rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001,mode=0700',
});
const REQUIRED_ENV = Object.freeze({
  HOME: '/home/worker',
  PI_CODING_AGENT_DIR: '/worker-state/pi-agent',
  T3CODE_HOME: '/worker-state/t3',
  NODE_ENV: 'production',
  LD_LIBRARY_PATH: '/opt/t3/lib',
  PATH: '/opt/pi/node_modules/.bin:/opt/t3:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  NODE_VERSION: '24.22.2',
});

function reject() {
  throw new Error(SAFE_ERROR);
}

function empty(value) {
  return value === null || (Array.isArray(value) && value.length === 0);
}

function emptyMap(value) {
  return value === null || (value && !Array.isArray(value) && Object.keys(value).length === 0);
}

export function createContainerArgs(imageId, name) {
  if (typeof imageId !== 'string' || !IMAGE_ID.test(imageId)
      || typeof name !== 'string' || !NAME.test(name)) reject();
  return [
    'create', '--name', name, '--label', 'org.mellon.factory.bootstrap=true',
    '--pull', 'never', '--user', '10001:10001', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--cpus', '2', '--memory', '4g', '--memory-swap', '4g',
    '--init', '--restart', 'no',
    ...Object.entries(TMPFS).flatMap(([path, flags]) => ['--tmpfs', `${path}:${flags}`]),
    imageId,
  ];
}

export function verifyContainerInspection(value, imageId, name) {
  createContainerArgs(imageId, name);
  const config = value?.Config;
  const host = value?.HostConfig;
  if (!config || !host || value.Image !== imageId || value.Name !== `/${name}`
      || !/^[a-f0-9]{64}$/.test(value.Id ?? '')
      || config.User !== '10001:10001' || config.WorkingDir !== '/workspace/mellon'
      || !isDeepStrictEqual(config.Entrypoint, ['node', '/opt/bootstrap/start.mjs'])
      || !empty(config.Cmd) || config.Labels?.['org.mellon.factory.bootstrap'] !== 'true'
      || host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true
      || host.Privileged !== false || host.Init !== true
      || host.UsernsMode !== '' || host.PidMode !== '' || host.UTSMode !== ''
      || host.IpcMode !== 'private' || !isDeepStrictEqual(host.CapDrop, ['ALL'])
      || !empty(host.CapAdd) || !isDeepStrictEqual(host.SecurityOpt, ['no-new-privileges'])
      || host.Memory !== 4294967296 || host.MemorySwap !== 4294967296
      || host.NanoCpus !== 2000000000 || host.PidsLimit !== 128
      || !empty(host.Binds) || !(host.Mounts === undefined || empty(host.Mounts)) || !empty(host.Devices)
      || !empty(host.DeviceRequests) || !emptyMap(host.PortBindings)
      || host.PublishAllPorts !== false || !isDeepStrictEqual(host.Tmpfs, TMPFS)
      || host.RestartPolicy?.Name !== 'no' || host.RestartPolicy.MaximumRetryCount !== 0
      || !Array.isArray(value.Mounts) || !emptyMap(value.NetworkSettings?.Ports)) reject();
  for (const mount of value.Mounts) {
    if (mount.Type !== 'tmpfs' || !Object.hasOwn(TMPFS, mount.Destination)
        || (mount.Source !== '' && mount.Source !== undefined)) reject();
  }
  const networks = value.NetworkSettings?.Networks;
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)
      || Object.keys(networks).some(key => key !== 'none')) reject();
  if (!Array.isArray(config.Env)) reject();
  const environment = Object.create(null);
  for (const field of config.Env) {
    if (typeof field !== 'string' || !field.includes('=')) reject();
    const index = field.indexOf('=');
    const key = field.slice(0, index);
    if (Object.hasOwn(environment, key)) reject();
    environment[key] = field.slice(index + 1);
  }
  for (const [key, expected] of Object.entries(REQUIRED_ENV)) {
    if (environment[key] !== expected) reject();
  }
  for (const key of Object.keys(environment)) {
    if (!Object.hasOwn(REQUIRED_ENV, key)
        && !(key === 'YARN_VERSION' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(environment[key]))) reject();
  }
  return { boundaryVerified: true, containerId: value.Id, imageId };
}

export async function fingerprintRuntime(root) {
  try {
    if ((await lstat(root)).isSymbolicLink()) reject();
    const base = await realpath(root);
    const rows = [];
    let totalBytes = 0;
    const pending = [base];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) reject();
        const actual = await realpath(path);
        if (!actual.startsWith(`${base}${sep}`)) reject();
        if (info.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!info.isFile() || info.size > 512 * 1024 * 1024) reject();
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes;
        try {
          const before = await handle.stat();
          if (!before.isFile()) reject();
          bytes = await handle.readFile();
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
              || bytes.length !== before.size || after.ino !== info.ino) reject();
        } finally {
          await handle.close();
        }
        totalBytes += bytes.length;
        if (totalBytes > 512 * 1024 * 1024 || rows.length >= 5000) reject();
        rows.push([
          relative(base, path).split(sep).join('/'), (info.mode & 0o111) !== 0,
          bytes.length, createHash('sha256').update(bytes).digest('hex'),
        ]);
      }
    }
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return {
      treeSha256: createHash('sha256').update(`${JSON.stringify(rows)}\n`).digest('hex'),
      fileCount: rows.length,
      totalBytes,
    };
  } catch {
    reject();
  }
}

export async function verifyRuntime(root, expected) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.treeSha256 ?? '')
      || !Number.isSafeInteger(expected.fileCount) || expected.fileCount < 1
      || !Number.isSafeInteger(expected.totalBytes) || expected.totalBytes < 1) reject();
  const actual = await fingerprintRuntime(root);
  if (!isDeepStrictEqual(actual, expected)) reject();
  return actual;
}
