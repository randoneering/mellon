import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeOutput, runGuardedProcess, safeChildEnvironment } from '../../scripts/lib/output-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COMMAND_TIMEOUT_MS = 12 * 60 * 1000;

function command(executable, args, cwd = ROOT, timeoutMs = COMMAND_TIMEOUT_MS, kind = 'command') {
  return Object.freeze({
    executable,
    args: Object.freeze(args),
    cwd,
    timeoutMs,
    kind,
  });
}

const COMMANDS = Object.freeze({
  'install-root': command('npm', ['ci', '--ignore-scripts']),
  'install-detector': command('npm', ['ci', '--ignore-scripts'], join(ROOT, 'detector')),
  'verify-assets': command('npm', ['run', 'verify:assets']),
  'test-build': command('npm', ['run', 'test:build']),
  'test-parity': command('npm', ['run', 'test:parity']),
  build: command('npm', ['run', 'build']),
  'check-dist': command('git', [
    'status', '--porcelain', '--untracked-files=all', '--', 'dist',
  ], ROOT, COMMAND_TIMEOUT_MS, 'dist-check'),
  'validate-release': command(process.execPath, ['scripts/validate-release.mjs']),
});

export function commandFor(name) {
  if (typeof name !== 'string' || !Object.hasOwn(COMMANDS, name)) return null;
  const selected = COMMANDS[name];
  return Object.freeze({ ...selected, args: Object.freeze([...selected.args]) });
}

export { safeChildEnvironment };
function reportFailure(reason) {
  const messages = {
    output_limit: 'CI command output exceeded 256 KiB per stream; the child process group was stopped.\n',
    spawn: 'Unable to start the approved CI command.\n',
    timeout: 'CI command timed out; the child process group was stopped.\n',
  };
  process.stderr.write(messages[reason] ?? 'CI command failed safely.\n');
}

async function runCommand(selected) {
  const result = await runGuardedProcess(selected);
  if (result.failure) {
    reportFailure(result.failure);
    return 1;
  }

  let stdout;
  let stderr;
  try {
    stdout = decodeOutput(result.stdout);
    stderr = decodeOutput(result.stderr);
  } catch {
    process.stderr.write('CI command output was not valid UTF-8; the command failed safely.\n');
    return 1;
  }
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (selected.kind === 'dist-check' && result.stdout.length > 0) {
    process.stderr.write('Built distribution differs from committed files. Run npm run build and commit dist/.\n');
    return 1;
  }
  return result.status;
}

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: node automation/ci/guard-command.mjs <approved-command>\n');
    process.exitCode = 1;
    return;
  }
  const name = process.argv[2];
  const selected = commandFor(name);
  if (!selected) {
    process.stderr.write('Unknown approved CI command.\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runCommand(selected);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('Approved CI command failed safely.\n');
    process.exitCode = 1;
  });
}
