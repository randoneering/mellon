import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { verifyJobInspection, verifyPrivateNetwork, verifyWorkerVolume, workerModelConfiguration } from './job-policy.mjs';

import { liveSetupProgram } from './live-setup.mjs';
import { modelConfigMatches, readinessWithGrant, verifyRelayInspection, verifyProxyNetworks } from './relay-setup.mjs';
import { safeReadiness } from './provision-live.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, '../..');
const file = join(ROOT, '.pi/artifacts/factory-live/deployment.json');
const result = JSON.parse(await readFile(file, 'utf8'));
let stage = 'owned_resource_verification';
const attemptedStarts = [];
const docker = (args, input, timeout = 30000) => {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('Private worker operation failed.');
  return r.stdout.trim();
};
try {
  const { config, imageId, resources } = result;
  verifyPrivateNetwork(JSON.parse(docker(['network', 'inspect', config.networkId]))[0], config);
  for (const name of [config.stateVolume, config.workspaceVolume]) verifyWorkerVolume(JSON.parse(docker(['volume', 'inspect', name]))[0], name);
  const worker = JSON.parse(docker(['inspect', resources.workerId]))[0];
  verifyJobInspection(worker, imageId, config);
  if (worker.State.Running !== false) throw new Error('Worker is not idle/stopped.');
  const proxy = JSON.parse(docker(['inspect', resources.proxyId]))[0];
  const outboundId = docker(['network', 'inspect', '--format', '{{.Id}}', 'n8n_default']);
  verifyProxyNetworks(proxy, config, outboundId);
  if (proxy.Name !== `/${config.proxyName}` || proxy.Image !== (resources.proxyImageId ?? imageId)
      || proxy.Config.User !== '10001:10001' || proxy.HostConfig.Privileged !== false
      || proxy.HostConfig.ReadonlyRootfs !== true || proxy.Mounts.length
      || proxy.Config.Labels?.['org.mellon.factory.live'] !== 'true') throw new Error('Proxy ownership mismatch.');
  const suffix = /^mellon-factory-worker-([a-f0-9]{12})$/.exec(config.name)[1];
  const relay = JSON.parse(docker(['inspect', resources.relayId]))[0];
  verifyRelayInspection(relay, imageId, config);
  if (relay.State.Running !== false) throw new Error('Relay is not idle/stopped.');
  stage = 'nonsecret_model_metadata';
  // This cache is catalog data, not auth.json or a host extension/configuration.
  const catalog = JSON.parse(await readFile(join(homedir(), '.pi/agent/models-store.json'), 'utf8'));
  const model = catalog['openai-codex']?.models?.find(m => m.id === 'gpt-6.1-sol');
  const modelConfig = workerModelConfiguration(model);
  result.modelMetadata = {
    provider: 'openai-codex', id: 'gpt-6.1-sol', source: 'Existing public model catalog cache; whitelisted fields only',
    sha256: createHash('sha256').update(JSON.stringify(modelConfig)).digest('hex'),
  };
  for (const id of [resources.proxyId, resources.relayId, resources.workerId]) {
    attemptedStarts.push(id);
    docker(['start', id]);
  }
  stage = 'worker_model_metadata';
  const program = `import fs from 'node:fs';
if(process.getuid()!==10001||process.env.PI_CODING_AGENT_DIR!=='/worker-state/pi-agent')throw new Error('Wrong worker.');
let input='';for await(const c of process.stdin)input+=c;
const config=JSON.parse(input),path='/worker-state/pi-agent/models.json';
if(fs.existsSync(path))console.log(JSON.stringify({existing:JSON.parse(fs.readFileSync(path,'utf8'))}));
else{fs.writeFileSync(path,JSON.stringify(config),{flag:'wx',mode:0o600});console.log('{"installed":true}');}`;
  const written = JSON.parse(docker(['exec', '-i', resources.workerId, 'node', '--input-type=module', '-e', program], JSON.stringify(modelConfig)));
  // An existing file may carry a revoked job capability; compare everything else.
  if (written.existing && !modelConfigMatches(written.existing, modelConfig, suffix)) throw new Error('Unexpected model config.');
  if (!written.existing && written.installed !== true) throw new Error('Model config install failed.');
  stage = 'model_readiness';
  const setup = await readFile(join(DIR, 'live-setup.mjs'), 'utf8');
  // The worker holds no login, so readiness runs under a short grant that is always revoked.
  result.modelReadiness = await readinessWithGrant({ docker, relayId: resources.relayId, workerId: resources.workerId, suffix }, async () => {
    const r = spawnSync('docker', ['exec', '-i', resources.workerId, 'node', '--input-type=module', '-'], { input: liveSetupProgram(setup), encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    let value;
    try { value = r.status === 0 ? JSON.parse(r.stdout) : null; } catch {}
    const readiness = safeReadiness(value);
    if (readiness?.ok !== true) throw new Error('Requested model unavailable.');
    return readiness;
  });
  verifyJobInspection(JSON.parse(docker(['inspect', resources.workerId]))[0], imageId, config);
  Object.assign(result, { ok: true, stage: 'complete', category: 'private_worker_ready' });
} catch {
  Object.assign(result, { ok: false, stage, category: 'private_worker_verification_failed' });
  for (const id of attemptedStarts.reverse()) {
    try { docker(['stop', '--time', '15', id]); } catch { result.stopFailure = true; }
  }
}
await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
