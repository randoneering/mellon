import { spawn } from 'node:child_process';

// A deadline always means failure: a child that handles SIGTERM and exits zero
// must not look like a successful Docker, Git or Qodo command.
export function runBoundedProcess(command, args, options = {}) {
  const timeout = options.timeout ?? 60000;
  const graceMs = options.graceMs ?? 5000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  return new Promise(resolveResult => {
    let settled = false;
    const chunks = [];
    let bytes = 0;
    let bounded = true;
    let timedOut = false;
    const timers = [];
    const finish = result => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolveResult(result);
    };
    let child;
    try {
      // A separate process group lets the deadline stop grandchildren too.
      child = spawn(command, args, {
        cwd: options.cwd, env: options.env ?? process.env, detached: true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      });
    } catch { finish({ status: 1, stdout: '', timedOut: false }); return; }
    const signal = name => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch {} } };
    const stopChild = () => {
      signal('SIGTERM');
      timers.push(setTimeout(() => signal('SIGKILL'), graceMs));
      // Settle even if exit never arrives, so controller timers and HTTP stay live.
      timers.push(setTimeout(() => finish({ status: 124, stdout: '', timedOut: true }), graceMs + 1000));
    };
    timers.push(setTimeout(() => { timedOut = true; stopChild(); }, timeout));
    child.stdout.on('data', data => {
      if (!bounded) return;
      bytes += data.length;
      if (bytes <= maxBytes) chunks.push(data);
      else { bounded = false; chunks.length = 0; stopChild(); }
    });
    child.once('error', () => finish({ status: 1, stdout: '', timedOut }));
    child.once('exit', code => {
      if (timedOut) finish({ status: 124, stdout: '', timedOut: true });
      else finish({ status: bounded ? code : 1, stdout: bounded ? Buffer.concat(chunks).toString('utf8') : '', timedOut: false });
    });
    if (options.input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
  });
}
