import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createJobArgs, createRelayArgs, verifyJobInspection, verifyPrivateNetwork, verifyWorkerVolume,
  verifyWorkerAuth, workerModelConfiguration,
} from './job-policy.mjs';
import { relayPrepArgs, relayCredentialArgs, workerStateArgs, verifyRelayInspection, readinessWithGrant } from './relay-setup.mjs';
import { liveSetupProgram } from './live-setup.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, '../..');
const LABEL = 'org.mellon.factory.live=true';

export const MODEL_CONFIG_PROGRAM = `import fs from 'node:fs';
if(process.getuid()!==10001||process.env.PI_CODING_AGENT_DIR!=='/worker-state/pi-agent')throw new Error('Wrong worker.');
let input='';for await(const c of process.stdin)input+=c;
const path='/worker-state/pi-agent/models.json';
fs.writeFileSync(path,JSON.stringify(JSON.parse(input)),{flag:'wx',mode:0o600});
console.log('{"installed":true}');`;

// The sign-in helper's session directory is passed explicitly; no hidden reference file.
export function sessionAuthPath(sessionDir) {
  const directory = resolve(sessionDir ?? '');
  if (!sessionDir || !/^mellon-factory-auth-[a-f0-9]{12}$/.test(basename(directory))
      || resolve(directory, '..') !== resolve(tmpdir())) throw new Error('Factory sign-in session rejected.');
  return join(directory, 'pi-agent', 'auth.json');
}

export function safeReadiness(value) {
  return value ? {
    ok: value.ok === true,
    stage: ['complete', 'readiness', 'local_authorization', 'provider_configuration', 'model_inventory'].includes(value.stage) ? value.stage : 'unclassified',
    serverAuthenticated: value.serverAuthenticated === true,
    piEnabled: value.piEnabled === true, piInstalled: value.piInstalled === true,
    piVersion: value.piVersion === '1.5.2' ? value.piVersion : null,
    modelAuth: ['authenticated', 'unauthenticated', 'unknown'].includes(value.modelAuth) ? value.modelAuth : 'unknown',
    modelAvailable: value.modelAvailable === true,
    modelCount: Number.isSafeInteger(value.modelCount) ? value.modelCount : null,
    requestedModel: 'openai-codex/gpt-6.1-sol', otherProvidersDisabled: value.otherProvidersDisabled === true,
  } : null;
}

// Fresh deployment: the model login goes only into the relay volume; the coding
// worker starts with an empty login and gets model access only through grants.
export async function provision(imageId, io) {
  let stage = 'input';
  const result = { ok: false, stage, category: 'provision_failed', resources: {} };
  const { docker } = io;
  try {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')) throw new Error('Unpinned image.');
    const auth = await io.readAuth();
    verifyWorkerAuth(auth);
    const modelConfig = workerModelConfiguration(await io.readModel());
    result.modelMetadata = { provider: 'openai-codex', id: 'gpt-6.1-sol', sha256: createHash('sha256').update(JSON.stringify(modelConfig)).digest('hex') };
    const suffix = io.suffix ?? randomBytes(6).toString('hex');
    const config = {
      name: `mellon-factory-worker-${suffix}`, network: `mellon-factory-net-${suffix}`,
      networkId: '', stateVolume: `mellon-factory-state-${suffix}`,
      workspaceVolume: `mellon-factory-workspace-${suffix}`, proxyName: `mellon-factory-egress-${suffix}`,
    };
    result.config = config;
    result.imageId = imageId;
    result.relayHost = `mellon-factory-relay-${suffix}`;
    stage = 'private_network';
    config.networkId = await docker(['network', 'create', '--internal', '--label', LABEL,
      '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', config.network]);
    result.resources.networkId = config.networkId;
    verifyPrivateNetwork(JSON.parse(await docker(['network', 'inspect', config.networkId]))[0], config);
    for (const name of [config.stateVolume, config.workspaceVolume]) {
      await docker(['volume', 'create', '--label', LABEL, name]);
      verifyWorkerVolume(JSON.parse(await docker(['volume', 'inspect', name]))[0], name);
    }
    const relayVolume = `mellon-factory-relay-state-${suffix}`;
    await docker(['volume', 'create', '--label', LABEL, relayVolume]);
    result.resources.relayVolume = relayVolume;
    await io.persist(result);

    stage = 'relay_credential';
    const prep = await docker(relayPrepArgs(imageId, config));
    result.resources.relayPrepId = prep;
    await docker(['start', '--attach', prep]);
    const writer = await docker(relayCredentialArgs(imageId, config));
    result.resources.relayCredentialHelperId = writer;
    // Credential bytes travel only over stdin, never in arguments, output or image layers.
    const installed = JSON.parse(await docker(['start', '--attach', '--interactive', writer], JSON.stringify(auth)));
    if (installed.installed !== true || JSON.stringify(installed.providers) !== '["openai-codex"]') throw new Error('Relay credential install failed.');
    result.relayCredentialInstalled = true;

    stage = 'egress_gateway';
    const proxy = await docker(['create', '--name', config.proxyName, '--label', LABEL,
      '--pull', 'never', '--user', '10001:10001', '--network', config.networkId,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--cpus', '0.5', '--memory', '128m', '--memory-swap', '128m',
      '--entrypoint', 'node', imageId, '/opt/bootstrap/egress.mjs']);
    if (!/^[a-f0-9]{64}$/.test(proxy)) throw new Error('Missing proxy identity.');
    result.resources.proxyId = proxy;
    result.resources.proxyImageId = imageId;
    await docker(['network', 'connect', 'n8n_default', proxy]);
    await docker(['start', proxy]);

    stage = 'relay';
    const relay = await docker(createRelayArgs(imageId, config));
    if (!/^[a-f0-9]{64}$/.test(relay)) throw new Error('Missing relay identity.');
    result.resources.relayId = relay;
    await docker(['network', 'connect', 'n8n_default', relay]);
    await docker(['start', relay]);
    result.relayBoundary = verifyRelayInspection(JSON.parse(await docker(['inspect', relay]))[0], imageId, config);
    await io.persist(result);

    stage = 'worker_create';
    const worker = await docker(createJobArgs(imageId, config));
    if (!/^[a-f0-9]{64}$/.test(worker)) throw new Error('Missing worker identity.');
    result.resources.workerId = worker;
    result.boundary = verifyJobInspection(JSON.parse(await docker(['inspect', worker]))[0], imageId, config);
    await io.persist(result);
    await docker(['start', worker]);
    stage = 'worker_state';
    const state = JSON.parse(await docker(workerStateArgs(worker)));
    if (state.installed !== true || state.workerAuthEntries !== 0) throw new Error('Worker state setup failed.');
    await docker(['exec', '-i', worker, 'node', '--input-type=module', '-e', MODEL_CONFIG_PROGRAM], JSON.stringify(modelConfig));

    stage = 'model_readiness';
    result.modelReadiness = await readinessWithGrant({ docker, relayId: relay, workerId: worker, suffix }, async () => {
      const readiness = safeReadiness(await io.readiness(worker));
      if (readiness?.ok !== true) throw new Error('Model not ready.');
      return readiness;
    });
    verifyJobInspection(JSON.parse(await docker(['inspect', worker]))[0], imageId, config);
    Object.assign(result, { ok: true, stage: 'complete', category: 'private_worker_ready' });
  } catch {
    result.stage = stage;
    for (const id of [result.resources.workerId, result.resources.relayId, result.resources.proxyId]) {
      if (!id) continue;
      try { await docker(['stop', '--time', '15', id]); } catch { result.stopFailure = true; }
    }
  }
  await io.persist(result);
  return result;
}

async function main(imageId, sessionDir) {
  const authPath = sessionAuthPath(sessionDir);
  const docker = (args, input, timeout = 60000) => {
    const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('Private provisioning command failed.');
    return r.stdout.trim();
  };
  const artifactRoot = join(ROOT, '.pi/artifacts/factory-live');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const receipt = join(artifactRoot, 'deployment.json');
  const setup = await readFile(join(DIR, 'live-setup.mjs'), 'utf8');
  const result = await provision(imageId, {
    docker,
    readAuth: async () => JSON.parse(await readFile(authPath, 'utf8')),
    // This cache is public catalog data, not auth.json or a host extension/configuration.
    readModel: async () => JSON.parse(await readFile(join(homedir(), '.pi/agent/models-store.json'), 'utf8'))['openai-codex']?.models?.find(m => m.id === 'gpt-6.1-sol'),
    readiness: async worker => {
      const r = spawnSync('docker', ['exec', '-i', worker, 'node', '--input-type=module', '-'], {
        input: liveSetupProgram(setup), encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
      });
      try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
    },
    persist: value => writeFile(receipt, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv[2], process.argv[3]); }
  catch { process.stdout.write('{"ok":false,"stage":"input","category":"provision_input_rejected"}\n'); process.exitCode = 1; }
}
