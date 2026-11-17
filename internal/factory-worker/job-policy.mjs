import { isDeepStrictEqual } from 'node:util';
import { createContainerArgs, verifyContainerInspection, TMPFS } from './policy.mjs';

const ERROR = 'Factory job boundary rejected.';
const LABEL = 'org.mellon.factory.live';
const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'];
const JOB_TMPFS = Object.fromEntries(Object.entries(TMPFS).filter(([p]) => p === '/tmp' || p === '/home/worker'));
function reject() { throw new Error(ERROR); }

function checked(config) {
  const suffix = /^mellon-factory-worker-([a-f0-9]{12})$/.exec(config?.name ?? '')?.[1];
  if (!suffix || !/^[a-f0-9]{64}$/.test(config.networkId ?? '')
      || config.network !== `mellon-factory-net-${suffix}`
      || config.stateVolume !== `mellon-factory-state-${suffix}`
      || config.workspaceVolume !== `mellon-factory-workspace-${suffix}`
      || config.proxyName !== `mellon-factory-egress-${suffix}`
      || Object.keys(config).some(key => !['name', 'networkId', 'network', 'stateVolume', 'workspaceVolume', 'proxyName'].includes(key))) reject();
  return suffix;
}

export function createJobArgs(imageId, config) {
  const suffix = checked(config);
  let base;
  try { base = createContainerArgs(imageId, `mellon-factory-bootstrap-${suffix}`); } catch { reject(); }
  const args = [];
  for (let i = 0; i < base.length - 1; i++) {
    const value = base[i];
    if (value === '--name') { args.push(value, config.name); i++; }
    else if (value === '--network') { args.push(value, config.networkId); i++; }
    else if (value === '--label') { args.push(value, `${LABEL}=true`); i++; }
    else if (value === '--tmpfs') {
      const mount = base[++i];
      if (!mount.startsWith('/worker-state:') && !mount.startsWith('/workspace/mellon:')) args.push(value, mount);
    } else args.push(value);
  }
  const proxy = `http://${config.proxyName}:8788`;
  return [...args,
    '--mount', `type=volume,src=${config.stateVolume},dst=/worker-state`,
    '--mount', `type=volume,src=${config.workspaceVolume},dst=/workspace/mellon`,
    '--env', `HTTPS_PROXY=${proxy}`, '--env', `HTTP_PROXY=${proxy}`,
    '--env', `NO_PROXY=localhost,127.0.0.1,mellon-factory-relay-${suffix}`, '--env', 'NODE_USE_ENV_PROXY=1', imageId];
}

// The relay alone holds the model credential, in its own volume. It joins the
// worker's private network so the worker can reach it without the CONNECT proxy.
export function createRelayArgs(imageId, config) {
  const suffix = checked(config);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')) reject();
  return ['create', '--name', `mellon-factory-relay-${suffix}`, '--label', `${LABEL}=true`,
    '--pull', 'never', '--user', '10001:10001', '--network', config.networkId,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--cpus', '0.5', '--memory', '256m', '--memory-swap', '256m',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
    '--mount', `type=volume,src=mellon-factory-relay-state-${suffix},dst=/relay-state`,
    '--entrypoint', 'node', imageId, '/opt/bootstrap/relay.mjs', 'serve'];
}

export function verifyPrivateNetwork(value, config) {
  checked(config);
  if (value?.Id !== config.networkId || value.Name !== config.network
      || value.Driver !== 'bridge' || value.Internal !== true || value.EnableIPv6 === true
      || value.Labels?.[LABEL] !== 'true'
      || value.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') reject();
  return { verified: true, networkId: value.Id };
}

export function verifyWorkerVolume(value, name) {
  if (!/^mellon-factory-(state|workspace)-[a-f0-9]{12}$/.test(name)
      || value?.Name !== name || value.Driver !== 'local' || value.Scope !== 'local'
      || value.Labels?.[LABEL] !== 'true'
      || (value.Options !== null && value.Options !== undefined && Object.keys(value.Options).length)) reject();
  return { verified: true, name };
}

export function verifyWorkerAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'openai-codex')) reject();
  const credential = value['openai-codex'];
  if (!credential || credential.type !== 'oauth'
      || typeof credential.access !== 'string' || credential.access.length < 1
      || typeof credential.refresh !== 'string' || credential.refresh.length < 1
      || !Number.isSafeInteger(credential.expires) || credential.expires < 1
      || typeof credential.accountId !== 'string' || !credential.accountId.length
      || Object.keys(credential).some(key => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(key))) reject();
  return { provider: 'openai-codex', type: 'oauth', verified: true };
}

export function workerModelConfiguration(model) {
  if (!model || model.id !== 'gpt-6.1-sol' || model.provider !== 'openai-codex'
      || model.api !== 'openai-codex-responses' || model.headers || model.apiKey) reject();
  let url;
  try { url = new URL(model.baseUrl); } catch { reject(); }
  if (url.origin !== 'https://chatgpt.com' || url.pathname !== '/backend-api'
      || url.username || url.password || url.search || url.hash) reject();
  const fields = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost',
    'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat', 'inputLimits', 'promptCache'];
  const data = Object.fromEntries(fields.filter(key => model[key] !== undefined).map(key => [key, structuredClone(model[key])]));
  if (!Number.isSafeInteger(data.contextWindow) || data.contextWindow < 1
      || !Number.isSafeInteger(data.maxTokens) || data.maxTokens < 1
      || typeof data.name !== 'string' || !Array.isArray(data.input)
      || data.input.some(kind => !['text', 'image'].includes(kind))) reject();
  return { providers: { 'openai-codex': { models: [data] } } };
}

export function verifyJobInspection(value, imageId, config) {
  const suffix = checked(config);
  const host = value?.HostConfig;
  const expected = new Map([['/worker-state', config.stateVolume], ['/workspace/mellon', config.workspaceVolume]]);
  if (!host || value.Config?.Labels?.[LABEL] !== 'true'
      || host.NetworkMode !== config.networkId
      || !isDeepStrictEqual(host.Tmpfs, JOB_TMPFS)
      || !Array.isArray(host.Mounts) || host.Mounts.length !== 2
      || !Array.isArray(value.Mounts)) reject();
  const requested = new Set();
  for (const mount of host.Mounts) {
    if (mount.Type !== 'volume' || expected.get(mount.Target) !== mount.Source
        || requested.has(mount.Target) || mount.ReadOnly === true || mount.VolumeOptions?.Subpath) reject();
    requested.add(mount.Target);
  }
  const actual = new Set();
  for (const mount of value.Mounts) {
    if (mount.Type === 'tmpfs' && Object.hasOwn(JOB_TMPFS, mount.Destination)) continue;
    if (mount.Type !== 'volume' || expected.get(mount.Destination) !== mount.Name
        || actual.has(mount.Destination) || mount.RW !== true) reject();
    actual.add(mount.Destination);
  }
  if (actual.size !== 2) reject();
  const networks = value.NetworkSettings?.Networks;
  if (!networks || Object.keys(networks).length !== 1 || !Object.hasOwn(networks, config.network)
      || (networks[config.network].NetworkID && networks[config.network].NetworkID !== config.networkId)) reject();
  const proxy = `http://${config.proxyName}:8788`;
  const extra = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: `localhost,127.0.0.1,mellon-factory-relay-${suffix}`, NODE_USE_ENV_PROXY: '1' };
  if (!Array.isArray(value.Config.Env)) reject();
  for (const [key, want] of Object.entries(extra)) {
    const fields = value.Config.Env.filter(e => e.startsWith(`${key}=`));
    if (fields.length !== 1 || fields[0] !== `${key}=${want}`) reject();
  }
  const normalized = structuredClone(value);
  normalized.Name = `/mellon-factory-bootstrap-${suffix}`;
  normalized.Config.Labels['org.mellon.factory.bootstrap'] = 'true';
  normalized.Config.Env = normalized.Config.Env.filter(e => !PROXY_KEYS.includes(e.split('=', 1)[0]));
  normalized.HostConfig.NetworkMode = 'none';
  normalized.HostConfig.Mounts = [];
  normalized.HostConfig.Tmpfs = { ...TMPFS };
  normalized.Mounts = [];
  normalized.NetworkSettings.Networks = {};
  try { verifyContainerInspection(normalized, imageId, `mellon-factory-bootstrap-${suffix}`); } catch { reject(); }
  return { boundaryVerified: true, mode: 'isolated_job', imageId, containerId: value.Id, networkId: config.networkId };
}
