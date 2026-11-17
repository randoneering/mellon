import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

// The real model credential lives only here. The coding worker holds a
// revocable job grant, so anything it encodes into candidate data is useless
// once the controller revokes the grant before export.
export const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ROUTE = '/backend-api/codex/responses';
const MODEL = 'gpt-6.1-sol';
const CLAIM = 'https://api.openai.com/auth';
const GRANT = /^[a-f0-9]{32}$/;
const JOB = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORWARDED = ['accept', 'content-type', 'content-encoding', 'openai-beta', 'originator',
  'session-id', 'x-client-request-id', 'user-agent', 'version'];

export async function issueGrant(grantsDir, { jobId, ttlMs, maxRequests }) {
  if (!JOB.test(jobId ?? '') || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000
      || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 2000) {
    throw new Error('Relay grant input rejected.');
  }
  await mkdir(grantsDir, { recursive: true, mode: 0o700 });
  const grantId = randomBytes(16).toString('hex');
  const record = { grantId, jobId, model: MODEL, expiresAt: Date.now() + ttlMs, maxRequests };
  const temporary = join(grantsDir, `${grantId}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, join(grantsDir, `${grantId}.json`));
  // JWT-shaped only because the unchanged Pi Codex client parses an account
  // claim locally; it carries no real account data and no signature value.
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const capability = [encode({ alg: 'none', typ: 'mellon-grant' }),
    encode({ mellon_grant: grantId, [CLAIM]: { chatgpt_account_id: 'mellon-relay' } }), 'grant'].join('.');
  return { grantId, capability, expiresAt: record.expiresAt };
}

export async function revokeGrant(grantsDir, grantId) {
  if (!GRANT.test(grantId ?? '')) throw new Error('Relay grant input rejected.');
  try { await unlink(join(grantsDir, `${grantId}.json`)); return true; }
  catch (error) { if (error.code === 'ENOENT') return true; throw new Error('Relay grant revocation failed.'); }
}

function accountId(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  const id = payload?.[CLAIM]?.chatgpt_account_id;
  if (typeof id !== 'string' || !id) throw new Error('No account claim.');
  return id;
}

export function createRelay(config) {
  const maxRequestBytes = config.maxRequestBytes ?? 8 * 1024 * 1024;
  const maxDecodedBytes = config.maxDecodedBytes ?? 32 * 1024 * 1024;
  const maxResponseBytes = config.maxResponseBytes ?? 64 * 1024 * 1024;
  const requestMs = config.requestMs ?? 15 * 60 * 1000;
  const upstream = config.fetch ?? globalThis.fetch;
  const counts = new Map();

  const grantFor = async header => {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header ?? '');
    if (!match) return null;
    let grantId;
    try { grantId = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8'))?.mellon_grant; }
    catch { return null; }
    if (!GRANT.test(grantId ?? '')) return null;
    let record;
    // Re-read on every request so a revocation is effective immediately.
    try { record = JSON.parse(await readFile(join(config.grantsDir, `${grantId}.json`), 'utf8')); }
    catch { return null; }
    if (record.grantId !== grantId || record.model !== MODEL || !JOB.test(record.jobId ?? '')
        || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now()) return null;
    return record;
  };

  const server = createServer(async (req, res) => {
    const fail = (status, error) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error }));
    };
    try {
      if (new URL(req.url, 'http://relay').pathname !== ROUTE) { fail(404, 'not_found'); return; }
      if (req.method !== 'POST') { fail(405, 'method_not_allowed'); return; }
      const grant = await grantFor(req.headers.authorization);
      if (!grant) { fail(401, 'grant_rejected'); req.resume(); return; }
      const encoding = req.headers['content-encoding'] ?? 'identity';
      if (!['identity', 'zstd'].includes(encoding)) { fail(415, 'encoding_rejected'); req.resume(); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxRequestBytes) { fail(413, 'request_too_large'); req.destroy(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let decoded;
      try { decoded = encoding === 'zstd' ? zstdDecompressSync(raw, { maxOutputLength: maxDecodedBytes }) : raw; }
      catch { fail(413, 'request_too_large'); return; }
      if (decoded.length > maxDecodedBytes) { fail(413, 'request_too_large'); return; }
      let body;
      try { body = JSON.parse(decoded.toString('utf8')); } catch { fail(400, 'invalid_request'); return; }
      if (body?.model !== MODEL) { fail(403, 'model_rejected'); return; }
      const used = counts.get(grant.grantId) ?? 0;
      if (used >= grant.maxRequests) { fail(429, 'request_budget_exhausted'); return; }
      counts.set(grant.grantId, used + 1);
      let token;
      let account;
      try { token = await config.getAccessToken(); account = accountId(token); }
      catch { fail(503, 'model_credential_unavailable'); return; }
      const headers = new Headers();
      for (const name of FORWARDED) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      headers.set('authorization', `Bearer ${token}`);
      headers.set('chatgpt-account-id', account);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), requestMs);
      res.once('close', () => abort.abort());
      try {
        let response;
        try {
          response = await upstream(UPSTREAM_URL, { method: 'POST', headers, body: raw, signal: abort.signal, redirect: 'error' });
        } catch { fail(502, 'upstream_unavailable'); return; }
        const type = response.headers.get('content-type');
        res.writeHead(response.status, { 'cache-control': 'no-store', ...(type ? { 'content-type': type } : {}) });
        if (!response.body) { res.end(); return; }
        let sent = 0;
        for await (const chunk of Readable.fromWeb(response.body)) {
          sent += chunk.length;
          if (sent > maxResponseBytes) { res.destroy(); return; }
          if (!res.write(chunk)) await new Promise(next => res.once('drain', next));
        }
        res.end();
      } catch { fail(502, 'upstream_interrupted'); }
      finally { clearTimeout(timer); }
    } catch { fail(500, 'relay_failed'); }
  });
  // The Codex client falls back to SSE when the WebSocket attempt fails.
  server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.requestTimeout = requestMs;
  return server;
}

async function sdkAccessToken(authPath) {
  const root = '/opt/pi/node_modules/@earendil-works';
  const { createModels } = await import(pathToFileURL(`${root}/pi-ai/dist/models.js`).href);
  const { openaiCodexProvider } = await import(pathToFileURL(`${root}/pi-ai/dist/providers/openai-codex.js`).href);
  const { AuthStorage } = await import(pathToFileURL(`${root}/pi-coding-agent/dist/core/auth-storage.js`).href);
  const models = createModels({ credentials: AuthStorage.create(authPath) });
  models.setProvider(openaiCodexProvider());
  return async () => {
    const result = await models.getAuth('openai-codex');
    if (typeof result?.auth?.apiKey !== 'string') throw new Error('No model credential.');
    return result.auth.apiKey;
  };
}

async function main(argv) {
  const state = '/relay-state';
  const grantsDir = join(state, 'grants');
  if (process.getuid?.() !== 10001) throw new Error('Wrong relay user.');
  const [command, ...rest] = argv;
  if (command === 'serve' && rest.length === 0) {
    const server = createRelay({ grantsDir, getAccessToken: await sdkAccessToken(join(state, 'auth.json')) });
    await mkdir(grantsDir, { recursive: true, mode: 0o700 });
    server.listen(8790, '0.0.0.0');
    process.stdout.write('{"stage":"relay_listening"}\n');
  } else if (command === 'issue' && rest.length === 3) {
    const grant = await issueGrant(grantsDir, { jobId: rest[0], ttlMs: Number(rest[1]), maxRequests: Number(rest[2]) });
    process.stdout.write(`${JSON.stringify(grant)}\n`);
  } else if (command === 'revoke' && rest.length === 1) {
    process.stdout.write(`${JSON.stringify({ revoked: await revokeGrant(grantsDir, rest[0]) })}\n`);
  } else throw new Error('Relay command rejected.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write('{"stage":"relay","category":"rejected"}\n');
    process.exitCode = 1;
  });
}
