import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { effectRequest, providerPatch, providerEvidence, providerDiagnostics } from './smoke-client.mjs';

let stage = 'inner_boundary';
let socket;
const result = { ok: false, stage, category: 'verification_failed' };
try {
  if (process.getuid?.() !== 10001 || process.env.HOME !== '/home/worker'
      || process.env.PI_CODING_AGENT_DIR !== '/worker-state/pi-agent'
      || process.env.T3CODE_HOME !== '/worker-state/t3'
      || Object.keys(networkInterfaces()).some(name => name !== 'lo')
      || Object.keys(process.env).some(name => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH_SOCK|GPG_AGENT/i.test(name))) {
    throw new Error('Inner boundary rejected.');
  }
  for (const path of ['/host', '/var/run/docker.sock', '/run/host-services/ssh-auth.sock', '/root/.ssh', '/root/.gnupg', '/workspace/mellon/.git']) {
    let reachable = false;
    try { await access(path); reachable = true; } catch {}
    if (reachable) throw new Error('Host path reachable.');
  }
  result.innerBoundaryVerified = true;
  stage = 'server_readiness';
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch('http://127.0.0.1:3773/.well-known/t3/environment', {
        redirect: 'error', signal: AbortSignal.timeout(1000),
      });
      ready = response.ok;
      await response.body?.cancel();
      if (ready) break;
    } catch {}
    await delay(500);
  }
  if (!ready) throw new Error('Local server unavailable.');
  stage = 'local_test_session';
  const session = spawnSync('/opt/t3/t3', [
    'auth', 'session', 'issue', '--base-dir', '/worker-state/t3',
    '--scope', 'orchestration:read', '--scope', 'providers:manage',
    '--ttl', '5m', '--token-only',
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 32768 });
  const token = session.stdout?.trim();
  if (session.status !== 0 || typeof token !== 'string' || token.length < 20
      || token.length > 16384 || /\s/.test(token)) throw new Error('Local session unavailable.');
  stage = 'authenticated_socket';
  const WebSocket = createRequire('/opt/pi/package.json')('ws');
  socket = new WebSocket('ws://127.0.0.1:3773/ws?orchestrationProtocol=2', {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: 2 * 1024 * 1024,
  });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error('Socket deadline.')), 10000);
    socket.once('open', () => { globalThis.clearTimeout(timeout); resolve(); });
    socket.once('error', () => { globalThis.clearTimeout(timeout); reject(new Error('Socket unavailable.')); });
  });
  stage = 'authenticated_probe';
  const probe = await effectRequest(socket, 'server.probe', {});
  if (!probe || typeof probe !== 'object' || Object.keys(probe).length) throw new Error('Invalid probe.');
  result.serverAuthenticated = true;
  stage = 'provider_configuration';
  const initial = await effectRequest(socket, 'server.getConfig', {});
  await effectRequest(socket, 'server.updateSettings', providerPatch(initial));
  stage = 'pi_refresh';
  await effectRequest(socket, 'server.refreshProviders', {
    instanceId: 'pi', refreshModels: false,
    workspaceSnapshotsOnDemand: true, usageLimitsCommand: false,
  }, 60000);
  stage = 'pi_inventory';
  let evidence;
  for (let i = 0; i < 20; i++) {
    const config = await effectRequest(socket, 'server.getConfig', {});
    result.providerDiagnostics = providerDiagnostics(config);
    try { evidence = providerEvidence(config); break; } catch {}
    await delay(500);
  }
  if (!evidence) throw new Error('Pi inventory unavailable.');
  Object.assign(result, evidence, {
    ok: true, stage: 'complete', category: 'verified',
    codingJobsRequested: 0, modelRequestsRequested: 0,
  });
} catch {
  result.stage = stage;
  result.category = 'verification_failed';
} finally {
  socket?.terminate();
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
