import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContainerArgs, verifyContainerInspection, verifyRuntime } from './policy.mjs';

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, '../..');
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{64}$/;

function safeInnerFailure(value) {
  const stages = ['inner_boundary', 'server_readiness', 'local_test_session', 'authenticated_socket',
    'authenticated_probe', 'provider_configuration', 'pi_refresh', 'pi_inventory'];
  const reasons = ['provider_shape', 'unexpected_enabled_provider', 'pi_disabled', 'pi_installation',
    'pi_inventory', 'pi_configuration', 'disabled_provider_configuration'];
  const diagnostic = value?.providerDiagnostics;
  const checkNames = ['driverMatches', 'envelopeEnabled', 'configEnabled', 'binaryMatches',
    'argumentsMatch', 'otherProvidersDisabled', 'otherSettingsDisabled'];
  return {
    stage: stages.includes(value?.stage) ? value.stage : 'unclassified',
    serverAuthenticated: value?.serverAuthenticated === true,
    innerBoundaryVerified: value?.innerBoundaryVerified === true,
    providerDiagnostics: diagnostic ? {
      rejection: reasons.includes(diagnostic.rejection) ? diagnostic.rejection : 'unclassified',
      piEnabled: diagnostic.piEnabled === true, piInstalled: diagnostic.piInstalled === true,
      piVersion: diagnostic.piVersion === '1.5.2' ? '1.5.2' : null,
      piStatus: ['ready', 'warning', 'error', 'disabled'].includes(diagnostic.piStatus) ? diagnostic.piStatus : 'unknown',
      piAuth: ['authenticated', 'unauthenticated', 'unknown'].includes(diagnostic.piAuth) ? diagnostic.piAuth : 'unknown',
      configurationChecks: Object.fromEntries(checkNames.map(name => [name, diagnostic.configurationChecks?.[name] === true])),
    } : null,
  };
}

export function executeDocker(args) {
  const timeout = args[0] === 'build' ? 240000 : args[0] === 'exec' ? 180000 : 30000;
  const result = spawnSync('docker', args, {
    encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

export async function runContainer(imageId, name, execute = executeDocker) {
  const report = {
    ok: false, stage: 'container_create', category: 'command_failed',
    imageId: IMAGE.test(imageId) ? imageId : null,
    containerId: null, containerStopped: false,
  };
  const command = async args => {
    const result = await execute(args);
    if (result.status !== 0) {
      report.exit_code = Number.isInteger(result.status) ? result.status : null;
      throw new Error('Command failed.');
    }
    return result.stdout.trim();
  };
  try {
    const id = await command(createContainerArgs(imageId, name));
    if (!ID.test(id)) throw new Error('Missing container identity.');
    report.containerId = id;
    report.stage = 'container_inspect';
    const inspected = JSON.parse(await command(['inspect', id]));
    if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('Missing inspection.');
    report.boundary = verifyContainerInspection(inspected[0], imageId, name);
    report.stage = 'container_start';
    await command(['start', id]);
    report.stage = 'container_smoke';
    const smokeResult = await execute(['exec', id, 'node', '/opt/bootstrap/smoke.mjs']);
    let smoke;
    try { smoke = JSON.parse(smokeResult.stdout); } catch {}
    if (smokeResult.status !== 0 || smoke?.ok !== true) {
      report.innerFailure = safeInnerFailure(smoke);
      report.exit_code = Number.isInteger(smokeResult.status) ? smokeResult.status : null;
      throw new Error('Inner smoke failed.');
    }
    if (smoke?.ok !== true || smoke.serverAuthenticated !== true
        || smoke.rpcInventoryVerified !== true || smoke.piInstalled !== true
        || smoke.piVersion !== '1.5.2' || smoke.piAuth !== 'unauthenticated'
        || smoke.innerBoundaryVerified !== true) throw new Error('Smoke incomplete.');
    report.smoke = {
      serverAuthenticated: true, rpcInventoryVerified: true,
      piInstalled: true, piVersion: smoke.piVersion, piAuth: smoke.piAuth,
      piStatus: smoke.piStatus, innerBoundaryVerified: true,
      codingJobsRequested: 0, modelRequestsRequested: 0,
    };
    report.stage = 'running_boundary';
    const running = JSON.parse(await command(['inspect', id]));
    if (!Array.isArray(running) || running.length !== 1) throw new Error('Missing running inspection.');
    verifyContainerInspection(running[0], imageId, name);
    report.ok = true;
    report.stage = 'complete';
    report.category = 'verified';
  } catch {
    report.ok = false;
    report.category = 'verification_failed';
  } finally {
    if (report.containerId) {
      try {
        const stopped = await execute(['stop', '--time', '15', report.containerId]);
        report.containerStopped = stopped.status === 0;
      } catch { report.containerStopped = false; }
      if (!report.containerStopped) {
        report.ok = false;
        report.stopFailure = { stage: 'container_stop', category: 'command_failed' };
      }
    }
  }
  return report;
}

async function main(runtimeRoot) {
  let stage = 'input_provenance';
  const report = { ok: false, stage, category: 'verification_failed' };
  let evidencePath;
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64' || !runtimeRoot) throw new Error('Unsupported host/input.');
    const lock = JSON.parse(await readFile(join(DIRECTORY, 'runtime-lock.json'), 'utf8'));
    await verifyRuntime(runtimeRoot, lock.t3.tree);
    const packageBytes = await readFile(join(DIRECTORY, 'package-lock.json'));
    if (createHash('sha256').update(packageBytes).digest('hex') !== lock.pi.packageLockSha256) throw new Error('Lock mismatch.');
    const recipe = await readFile(join(DIRECTORY, 'Dockerfile'), 'utf8');
    if (!recipe.startsWith(`FROM ${lock.baseImage}\n`)) throw new Error('Base mismatch.');
    const artifacts = join(ROOT, '.pi/artifacts/factory-worker-bootstrap');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const disk = await statfs(artifacts);
    if (disk.bavail * disk.bsize < 3 * 1024 ** 3) throw new Error('Insufficient disk.');
    stage = 'build_context';
    const context = await mkdtemp(join(artifacts, 'context-'));
    evidencePath = join(context, 'bootstrap-evidence.json');
    await cp(runtimeRoot, join(context, 't3-runtime'), { recursive: true, errorOnExist: true, force: false });
    await verifyRuntime(join(context, 't3-runtime'), lock.t3.tree);
    for (const file of ['Dockerfile', 'package.json', 'package-lock.json', 'start.mjs', 'smoke.mjs', 'smoke-client.mjs', 'egress.mjs', 'relay.mjs', 'T3-LICENSE']) {
      await cp(join(DIRECTORY, file), join(context, file), { errorOnExist: true, force: false });
    }
    const suffix = randomBytes(6).toString('hex');
    const name = `mellon-factory-bootstrap-${suffix}`;
    const tag = `mellon-factory-bootstrap:${suffix}`;
    stage = 'image_build';
    const build = executeDocker(['build', '--quiet', '--platform', lock.platform, '--tag', tag, context]);
    if (build.status !== 0) {
      report.exit_code = Number.isInteger(build.status) ? build.status : null;
      throw new Error('Build failed.');
    }
    stage = 'image_identity';
    const image = executeDocker(['image', 'inspect', '--format', '{{.Id}}', tag]);
    const imageId = image.stdout.trim();
    if (image.status !== 0 || !IMAGE.test(imageId)) throw new Error('Image identity unavailable.');
    Object.assign(report, await runContainer(imageId, name), {
      imageTag: tag, containerName: name,
      runtimeTreeSha256: lock.t3.tree.treeSha256,
      runtimeBinarySha256: lock.t3.binarySha256,
      baseImage: lock.baseImage,
      piIntegrity: lock.pi.integrity,
    });
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    report.ok = false;
    report.stage = stage;
    report.category = 'verification_failed';
    if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => {});
  }
  process.stdout.write(`${JSON.stringify({ ...report, evidencePath })}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    process.stdout.write(`${JSON.stringify({ ok: false, stage: 'input_provenance', category: 'invalid_arguments' })}\n`);
    process.exitCode = 1;
  } else await main(process.argv[2]);
}
