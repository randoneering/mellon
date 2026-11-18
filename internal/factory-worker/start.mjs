import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

process.umask(0o077);
const report = (category, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ stage: 'worker_start', category, ...extra })}\n`);
};

if (process.getuid?.() !== 10001
    || process.env.HOME !== '/home/worker'
    || process.env.PI_CODING_AGENT_DIR !== '/worker-state/pi-agent'
    || process.env.T3CODE_HOME !== '/worker-state/t3'
    || Object.keys(process.env).some(key => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH_SOCK|GPG_AGENT/i.test(key))) {
  report('boundary_rejected');
  process.exitCode = 1;
} else {
  try {
    await mkdir('/worker-state/pi-agent', { recursive: true, mode: 0o700 });
    await mkdir('/worker-state/t3', { recursive: true, mode: 0o700 });
    const child = spawn('/opt/t3/t3', [
      'start', '--mode', 'web', '--host', '127.0.0.1', '--port', '3773',
      '--base-dir', '/worker-state/t3', '--no-browser',
    ], {
      cwd: '/workspace/mellon', env: process.env,
      // T3 startup can print pairing material; raw output never enters Docker logs.
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    report('starting');
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('error', () => {
      report('spawn_failed');
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      report(signal ? 'stopped' : code === 0 ? 'exited' : 'server_failed', { exit_code: code });
      process.exitCode = signal || code === 0 ? 0 : 1;
    });
  } catch {
    report('state_setup_failed');
    process.exitCode = 1;
  }
}
