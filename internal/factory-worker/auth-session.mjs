import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ERROR = 'Worker authorization input rejected.';
const CALLBACK = 'http://localhost:1455/auth/callback';
const PROVIDER = 'openai-codex';

function rejected() { throw new Error(ERROR); }
function one(url, key) {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]) rejected();
  return values[0];
}

export function validateAuthorizationUrl(input) {
  try {
    if (typeof input !== 'string' || input.length > 16384 || /[\r\n]/.test(input)) rejected();
    const url = new URL(input);
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize'
        || url.username || url.password || url.hash
        || one(url, 'redirect_uri') !== CALLBACK
        || one(url, 'code_challenge_method') !== 'S256'
        || one(url, 'state').length < 16 || !one(url, 'code_challenge')) rejected();
    return input;
  } catch { rejected(); }
}

export function validateRedirectUrl(input, authorizationUrl) {
  try {
    validateAuthorizationUrl(authorizationUrl);
    if (typeof input !== 'string' || input.length > 16384 || /[\r\n]/.test(input)) rejected();
    const url = new URL(input);
    const expected = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== CALLBACK || url.username || url.password || url.hash
        || url.searchParams.has('error') || one(url, 'state') !== one(expected, 'state')
        || one(url, 'code').length > 8192) rejected();
    return input;
  } catch { rejected(); }
}

export function waitForRedirect(signal, promptSignal, register) {
  return new Promise((resolveInput, rejectInput) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancelled);
      promptSignal?.removeEventListener('abort', cancelled);
      register(undefined);
      callback(value);
    };
    const cancelled = () => finish(rejectInput, new Error('Worker authorization input cancelled.'));
    if (signal.aborted || promptSignal?.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    promptSignal?.addEventListener('abort', cancelled, { once: true });
    register({
      resolve: value => finish(resolveInput, value),
      reject: () => finish(rejectInput, new Error(ERROR)),
    });
  });
}

async function main(packageRoot, sessionDir) {
  let server;
  let stage = 'session_setup';
  let request;
  let pending;
  let ownedDirectory;
  let loginSignal;
  const sockets = new Set();
  const result = { status: 'failed', provider: PROVIDER, stage, category: 'authorization_failed' };
  try {
    const directory = resolve(sessionDir ?? '');
    if (!/^mellon-factory-auth-[a-f0-9]{12}$/.test(basename(directory))
        || resolve(directory, '..') !== resolve(tmpdir())) rejected();
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== '1.5.2') rejected();
    mkdirSync(directory, { mode: 0o700 });
    ownedDirectory = directory;
    const agent = join(directory, 'pi-agent');
    mkdirSync(agent, { mode: 0o700 });
    const authPath = join(agent, 'auth.json');
    const metadata = join(directory, 'request.json');
    const socketPath = join(directory, 'redirect.sock');
    server = createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      let text = '';
      socket.setTimeout(15000, () => socket.destroy());
      socket.on('data', data => {
        text += data.toString();
        if (text.length > 16384) socket.destroy();
      });
      socket.on('end', () => {
        try {
          if (!request || !pending) rejected();
          const input = validateRedirectUrl(text.trim(), request);
          const resolveInput = pending.resolve;
          pending = undefined;
          resolveInput(input);
          socket.end('{"accepted":true}');
        } catch {
          pending?.reject(new Error(ERROR));
          pending = undefined;
          socket.end('{"accepted":false}');
        }
      });
      socket.on('error', () => {});
    });
    await new Promise((resolveReady, rejectReady) => {
      server.once('error', rejectReady);
      server.listen(socketPath, resolveReady);
    });
    chmodSync(socketPath, 0o600);
    stage = 'provider_login';
    // Only this fresh store is passed to the SDK; the host agent store is never opened.
    const aiRoot = resolve(packageRoot, '../pi-ai');
    const { createModels } = await import(pathToFileURL(join(aiRoot, 'dist/models.js')).href);
    const { openaiCodexProvider } = await import(pathToFileURL(join(aiRoot, 'dist/providers/openai-codex.js')).href);
    const { AuthStorage } = await import(pathToFileURL(join(packageRoot, 'dist/core/auth-storage.js')).href);
    const store = AuthStorage.create(authPath);
    const models = createModels({ credentials: store });
    models.setProvider(openaiCodexProvider());
    process.env.PI_OAUTH_CALLBACK_HOST = '127.0.0.1';
    loginSignal = AbortSignal.timeout(8 * 60 * 1000);
    await models.login(PROVIDER, 'oauth', {
      signal: loginSignal,
      prompt: prompt => {
        if (prompt.type === 'select') return Promise.resolve('browser');
        if (prompt.type !== 'manual_code') return Promise.reject(new Error(ERROR));
        return waitForRedirect(loginSignal, prompt.signal, value => { pending = value; });
      },
      notify: event => {
        if (event.type !== 'auth_url') return;
        request = validateAuthorizationUrl(event.url);
        writeFileSync(metadata, JSON.stringify({ status: 'awaiting_authorization', provider: PROVIDER, url: request }), { flag: 'wx', mode: 0o600 });
      },
    }, { agentName: 'mellon-factory-worker' });
    stage = 'credential_persistence';
    const info = await store.list();
    if (info.length !== 1 || info[0].providerId !== PROVIDER || info[0].type !== 'oauth'
        || statSync(authPath).size < 1) rejected();
    chmodSync(authPath, 0o600);
    Object.assign(result, { status: 'authenticated', stage: 'complete', category: 'authorized' });
  } catch {
    result.stage = stage;
    if (loginSignal?.aborted) result.category = 'authorization_timeout';
  } finally {
    for (const socket of sockets) socket.destroy();
    server?.close();
    if (ownedDirectory) {
      try { writeFileSync(join(ownedDirectory, 'result.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 }); } catch {}
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'authenticated' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) {
    process.stdout.write('{"status":"failed","stage":"session_setup","category":"invalid_arguments"}\n');
    process.exitCode = 1;
  } else await main(process.argv[2], process.argv[3]);
}
