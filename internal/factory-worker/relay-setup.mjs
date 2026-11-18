import { CAPABILITY_PROGRAM } from './control.mjs';

const LABEL = 'org.mellon.factory.live=true';
const ERROR = 'Factory relay setup rejected.';
function reject() { throw new Error(ERROR); }

function suffixOf(config) {
  const suffix = /^mellon-factory-worker-([a-f0-9]{12})$/.exec(config?.name ?? '')?.[1];
  if (!suffix || !/^[a-f0-9]{64}$/.test(config.networkId ?? '') || config.network !== `mellon-factory-net-${suffix}`) reject();
  return suffix;
}
function image(imageId) { if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')) reject(); return imageId; }
const relayVolume = suffix => `mellon-factory-relay-state-${suffix}`;
export const relayUrl = suffix => `http://mellon-factory-relay-${suffix}:8790/backend-api`;

function helper(imageId, config, role, extra, program) {
  const suffix = suffixOf(config);
  return ['create', ...extra, '--name', `mellon-factory-relay-${role}-${suffix}`, '--label', LABEL,
    '--pull', 'never', '--network', 'none', '--read-only', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${relayVolume(suffix)},dst=/dst`, '--entrypoint', 'node', image(imageId), '-e', program];
}

// A new volume's root is owned by root; this helper only hands it to UID 10001.
export function relayPrepArgs(imageId, config) {
  return helper(imageId, config, 'prep', ['--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN'],
    "const fs=require('fs');fs.chmodSync('/dst',0o700);fs.chownSync('/dst',10001,10001);");
}

// The model login reaches the relay volume only over stdin, never argv or output.
export function relayCredentialArgs(imageId, config) {
  const program = `const fs=require('fs');let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{input+=c;});process.stdin.on('end',()=>{
const auth=JSON.parse(input),keys=Object.keys(auth);
if(keys.join()!=='openai-codex'||auth['openai-codex']?.type!=='oauth')process.exit(1);
fs.mkdirSync('/dst/grants',{recursive:true,mode:0o700});
const fd=fs.openSync('/dst/auth.json','wx',0o600);try{fs.writeSync(fd,input);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
const dir=fs.openSync('/dst','r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
console.log(JSON.stringify({installed:true,providers:keys}));});`;
  return helper(imageId, config, 'credential', ['--interactive', '--user', '10001:10001', '--cap-drop', 'ALL'], program);
}

// The coding worker gets an empty login; model access comes only from job grants.
export function workerStateArgs(worker) {
  if (typeof worker !== 'string' || !/^[a-f0-9]{64}$/.test(worker)) reject();
  const program = `import fs from 'node:fs';
if(process.getuid()!==10001||process.env.PI_CODING_AGENT_DIR!=='/worker-state/pi-agent')throw new Error('Wrong worker.');
const dir='/worker-state/pi-agent';fs.mkdirSync(dir,{recursive:true,mode:0o700});
const file=dir+'/auth.json';
if(fs.existsSync(file)&&Object.keys(JSON.parse(fs.readFileSync(file,'utf8'))).length)throw new Error('State not fresh.');
fs.writeFileSync(file,'{}',{mode:0o600});fs.chmodSync(file,0o600);
fs.writeFileSync(dir+'/settings.json',JSON.stringify({transport:'sse',defaultProvider:'openai-codex',defaultModel:'gpt-6.1-sol',defaultThinkingLevel:'high',defaultProjectTrust:'never'}),{mode:0o600});
console.log(JSON.stringify({installed:true,workerAuthEntries:0}));`;
  return ['exec', worker, 'node', '--input-type=module', '-e', program];
}

const canonical = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

// models.json may carry a job capability; ignore exactly those relay fields.
export function modelConfigMatches(actual, expected, suffix) {
  const value = structuredClone(actual);
  const provider = value?.providers?.['openai-codex'];
  const want = expected?.providers?.['openai-codex']?.models?.[0];
  if (!provider || !want || !Array.isArray(provider.models) || provider.models.length !== 1) return false;
  const relay = relayUrl(suffix);
  if (provider.baseUrl !== undefined && provider.baseUrl !== relay) return false;
  if (provider.apiKey !== undefined && typeof provider.apiKey !== 'string') return false;
  delete provider.baseUrl;
  delete provider.apiKey;
  if (provider.models[0].baseUrl === relay) provider.models[0].baseUrl = want.baseUrl;
  return canonical(value) === canonical(expected);
}

export function verifyProxyNetworks(proxy, config, outboundId) {
  const networks = proxy?.NetworkSettings?.Networks ?? {};
  if (Object.keys(networks).length !== 2 || !/^[a-f0-9]{64}$/.test(outboundId)
      || networks[config.network]?.NetworkID !== config.networkId
      || networks.n8n_default?.NetworkID !== outboundId) throw new Error('Proxy network mismatch.');
}

export function verifyRelayInspection(value, imageId, config) {
  const suffix = suffixOf(config);
  const mounts = (value?.Mounts ?? []).filter(m => m.Type !== 'tmpfs');
  const networks = Object.keys(value?.NetworkSettings?.Networks ?? {}).sort();
  if (value?.Name !== `/mellon-factory-relay-${suffix}` || value.Image !== image(imageId)
      || value.Config?.User !== '10001:10001' || value.Config.Labels?.['org.mellon.factory.live'] !== 'true'
      || value.HostConfig?.ReadonlyRootfs !== true || value.HostConfig.Privileged !== false
      || JSON.stringify(value.HostConfig.CapDrop) !== '["ALL"]' || (value.HostConfig.CapAdd ?? []).length
      || Object.keys(value.HostConfig.PortBindings ?? {}).length || (value.HostConfig.Binds ?? []).length
      || mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== relayVolume(suffix)
      || mounts[0].Destination !== '/relay-state'
      || JSON.stringify(networks) !== JSON.stringify([config.network, 'n8n_default'].sort())) reject();
  return { relayVerified: true, containerId: value.Id ?? null, volume: relayVolume(suffix), networks };
}

// A fresh worker has no capability, so T3 would report the model unauthenticated.
// Readiness runs under a short grant that is always revoked afterwards. T3 checks
// that auth is configured, not that it still works; live access needs a real request.
export async function readinessWithGrant({ docker, relayId, workerId, suffix }, check) {
  if (!/^[a-f0-9]{64}$/.test(relayId ?? '') || !/^[a-f0-9]{64}$/.test(workerId ?? '') || !/^[a-f0-9]{12}$/.test(suffix ?? '')) reject();
  const jobId = crypto.randomUUID();
  const grant = JSON.parse(await docker(['exec', relayId, 'node', '/opt/bootstrap/relay.mjs', 'issue', jobId, '300000', '2']));
  if (!/^[a-f0-9]{32}$/.test(grant.grantId ?? '') || typeof grant.capability !== 'string') reject();
  let outcome;
  let failure;
  try {
    const installed = JSON.parse(await docker(['exec', '-i', workerId, 'node', '--input-type=module', '-e', CAPABILITY_PROGRAM],
      JSON.stringify({ baseUrl: relayUrl(suffix), apiKey: grant.capability })));
    if (installed.installed !== 'mellon-capability') reject();
    outcome = await check();
  } catch (error) { failure = error; }
  const revoked = JSON.parse(await docker(['exec', relayId, 'node', '/opt/bootstrap/relay.mjs', 'revoke', grant.grantId]));
  if (revoked.revoked !== true) throw new Error('Relay revocation unconfirmed.');
  if (failure) throw failure;
  return outcome;
}
