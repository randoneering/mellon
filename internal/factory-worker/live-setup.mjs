import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { effectRequest, providerPatch } from './smoke-client.mjs';

const MODEL = 'openai-codex/gpt-6.1-sol';

export function requestedModelAvailable(provider) {
  return provider?.instanceId === 'pi' && provider.driver === 'pi'
    && Array.isArray(provider.models) && provider.models.some(model => model.slug === MODEL);
}

export async function configureLiveModel() {
  let stage = 'readiness';
  let socket;
  const report = { ok: false, stage, category: 'verification_failed', requestedModel: MODEL };
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch('http://127.0.0.1:3773/.well-known/t3/environment', { signal: AbortSignal.timeout(1000) });
        ready = r.ok;
        await r.body?.cancel();
        if (ready) break;
      } catch {}
      await delay(500);
    }
    if (!ready) throw new Error('Not ready.');
    stage = 'local_authorization';
    const r = spawnSync('/opt/t3/t3', ['auth', 'session', 'issue', '--base-dir', '/worker-state/t3',
      '--scope', 'orchestration:read', '--scope', 'providers:manage', '--ttl', '5m', '--token-only'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 32768 });
    const token = r.stdout?.trim();
    if (r.status !== 0 || !token || /\s/.test(token)) throw new Error('Auth unavailable.');
    const WebSocket = createRequire('/opt/pi/package.json')('ws');
    socket = new WebSocket('ws://127.0.0.1:3773/ws?orchestrationProtocol=2', { headers: { Authorization: `Bearer ${token}` } });
    socket.on('error', () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket deadline.')), 10000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Socket unavailable.')); });
    });
    await effectRequest(socket, 'server.probe', {});
    report.serverAuthenticated = true;
    stage = 'provider_configuration';
    const initial = await effectRequest(socket, 'server.getConfig', {});
    const configured = initial.settings?.providerInstances;
    if (configured && Object.keys(configured).length) {
      const pi = configured.pi;
      if (pi?.driver !== 'pi' || pi.enabled !== true
          || pi.config?.binaryPath !== '/opt/pi/node_modules/.bin/pi'
          || pi.config?.launchArgs !== '--no-approve --no-mcp --no-extensions'
          || Object.entries(configured).some(([id, entry]) => id !== 'pi' && entry.enabled !== false)) throw new Error('Unexpected existing provider state.');
    } else await effectRequest(socket, 'server.updateSettings', providerPatch(initial));
    stage = 'model_inventory';
    await effectRequest(socket, 'server.refreshProviders', {
      instanceId: 'pi', fresh: true, refreshModels: true, workspaceSnapshotsOnDemand: true, usageLimitsCommand: false,
    }, 90000);
    for (let i = 0; i < 30; i++) {
      const config = await effectRequest(socket, 'server.getConfig', {});
      const pi = config.providers?.find(p => p.instanceId === 'pi');
      report.piEnabled = pi?.enabled === true;
      report.piInstalled = pi?.installed === true;
      report.piVersion = pi?.version === '1.5.2' ? pi.version : null;
      report.modelAuth = ['authenticated', 'unauthenticated', 'unknown'].includes(pi?.auth?.status) ? pi.auth.status : 'unknown';
      report.modelAvailable = requestedModelAvailable(pi);
      report.modelCount = Array.isArray(pi?.models) ? pi.models.length : 0;
      report.otherProvidersDisabled = config.providers?.every(p => p.instanceId === 'pi' || p.enabled === false) === true;
      if (report.modelAvailable && report.piEnabled && report.piInstalled && report.modelAuth === 'authenticated' && report.otherProvidersDisabled) {
        report.ok = true;
        break;
      }
      await delay(500);
    }
    report.stage = report.ok ? 'complete' : stage;
    report.category = report.ok ? 'verified' : 'model_not_ready';
  } catch {
    report.stage = stage;
  } finally {
    socket?.terminate();
  }
  return report;
}

export function liveSetupProgram(source) {
  if (typeof source !== 'string' || !source.includes("from './smoke-client.mjs'")) throw new Error('Factory setup source rejected.');
  return source.replace("from './smoke-client.mjs'", "from '/opt/bootstrap/smoke-client.mjs'")
    + '\nconst result=await configureLiveModel();process.stdout.write(JSON.stringify(result)+"\\n");process.exitCode=result.ok?0:1;\n';
}
