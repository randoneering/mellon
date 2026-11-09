import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 256 * 1024;
const TERMINATION_GRACE_MS = 200;
const KILL_WAIT_MS = 1000;
const WORKFLOW_FILE_HANDLES = new Set([
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_STATE',
]);
const STARTUP_HOOKS = new Set(['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']);

export function safeChildEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !WORKFLOW_FILE_HANDLES.has(key) && !STARTUP_HOOKS.has(key)));
}

export function escapeControls(text) {
  let escaped = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === '\n' || character === '\t') {
      escaped += character;
    } else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)
        || code === 0x2028 || code === 0x2029) {
      escaped += code <= 0xff
        ? `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`
        : `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
    } else {
      escaped += character;
    }
  }
  return escaped.replaceAll('::', '\\:\\:').replaceAll('##[', '\\#\\#[');
}

export function decodeOutput(bytes) {
  return escapeControls(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function signalOwnedGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when its process group is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A closed child needs no further signal.
  }
}

export function runGuardedProcess(selected) {
  return new Promise(resolveResult => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let failure = null;
    let settled = false;
    let timeoutTimer;
    let terminateTimer;
    let killWaitTimer;
    let child;
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(terminateTimer);
      clearTimeout(killWaitTimer);
      resolveResult(result);
    }
    function fail(reason) {
      if (failure || settled) return;
      failure = reason;
      signalOwnedGroup(child, 'SIGTERM');
      terminateTimer = setTimeout(() => {
        signalOwnedGroup(child, 'SIGKILL');
        killWaitTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish({ failure });
        }, KILL_WAIT_MS);
      }, TERMINATION_GRACE_MS);
    }
    function capture(chunks, chunk, currentBytes) {
      if (failure || settled) return currentBytes;
      if (currentBytes + chunk.length > MAX_CAPTURE_BYTES) {
        fail('output_limit');
        return currentBytes;
      }
      chunks.push(Buffer.from(chunk));
      return currentBytes + chunk.length;
    }
    try {
      child = spawn(selected.executable, [...selected.args], {
        cwd: selected.cwd,
        detached: process.platform !== 'win32',
        env: safeChildEnvironment(selected.env ?? process.env),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish({ failure: 'spawn' });
      return;
    }
    child.stdout.on('data', chunk => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes);
    });
    child.stderr.on('data', chunk => {
      stderrBytes = capture(stderr, chunk, stderrBytes);
    });
    child.once('error', () => finish({ failure: 'spawn' }));
    child.once('close', (status, signal) => {
      if (failure) return;
      finish({
        status: Number.isSafeInteger(status) && status >= 0 && status <= 255 ? status : 1,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      });
    });
    timeoutTimer = setTimeout(() => fail('timeout'), selected.timeoutMs);
  });
}
