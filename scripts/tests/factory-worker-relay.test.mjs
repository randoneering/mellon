import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createRelay, issueGrant, revokeGrant, UPSTREAM_URL } from '../../internal/factory-worker/relay.mjs';

const JOB = '12345678-1234-4234-8234-123456789abc';
const REAL = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'real-account' } })).toString('base64url')}.s`;
const PATH = '/backend-api/codex/responses';

async function relay(t, options = {}) {
  const grantsDir = options.grantsDir ?? await mkdtemp(join(tmpdir(), 'mellon-relay-'));
  const calls = [];
  const upstream = options.upstream ?? (async (url, init) => {
    calls.push({ url, headers: Object.fromEntries(init.headers), body: Buffer.from(init.body) });
    return new Response('data: {"type":"response.completed"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'upstream-cookie' } });
  });
  const server = createRelay({ grantsDir, getAccessToken: async () => REAL, fetch: upstream, ...options.config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, grantsDir, calls };
}
const send = (url, capability, body = { model: 'gpt-6.1-sol', input: [] }, headers = {}) => fetch(url + PATH, {
  method: 'POST',
  headers: { authorization: `Bearer ${capability}`, 'chatgpt-account-id': 'worker-claimed', cookie: 'worker-cookie', 'content-type': 'application/json', ...headers },
  body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
});

test('a valid job grant reaches only the fixed upstream with trusted credentials replacing worker values', async t => {
  const r = await relay(t);
  const grant = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 5 });
  const response = await send(r.url, grant.capability);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /response\.completed/);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, UPSTREAM_URL);
  assert.equal(r.calls[0].headers.authorization, `Bearer ${REAL}`);
  assert.equal(r.calls[0].headers['chatgpt-account-id'], 'real-account');
  assert.equal(r.calls[0].headers.cookie, undefined);
  assert.equal(JSON.stringify(r.calls[0].headers).includes(grant.capability), false);
});

test('the worker capability satisfies the unchanged Pi account-claim parser without real account data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-relay-claim-'));
  const { capability } = await issueGrant(dir, { jobId: JOB, ttlMs: 60000, maxRequests: 1 });
  const payload = JSON.parse(atob(capability.split('.')[1]));
  assert.equal(capability.split('.').length, 3);
  assert.equal(typeof payload['https://api.openai.com/auth'].chatgpt_account_id, 'string');
  assert.equal(capability.includes('real-account'), false);
});

test('grant files are private and revocation takes effect on the next request', async t => {
  const r = await relay(t);
  const grant = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 5 });
  const file = grant.grantId + '.json';
  assert.equal((await stat(join(r.grantsDir, file))).mode & 0o777, 0o600);
  assert.equal((await send(r.url, grant.capability)).status, 200);
  assert.equal(await revokeGrant(r.grantsDir, grant.grantId), true);
  assert.equal((await send(r.url, grant.capability)).status, 401);
  assert.equal(r.calls.length, 1);
});

test('missing, malformed, unknown and expired grants never reach upstream', async t => {
  const r = await relay(t);
  const expired = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 1, maxRequests: 5 });
  await new Promise(resolve => setTimeout(resolve, 10));
  for (const capability of ['', 'not-a-jwt', `a.${Buffer.from('{"mellon_grant":"' + 'f'.repeat(32) + '"}').toString('base64url')}.b`, expired.capability, REAL]) {
    assert.equal((await send(r.url, capability)).status, 401);
  }
  assert.equal(r.calls.length, 0);
});

test('only the exact model, method and route are accepted, including inside zstd bodies', async t => {
  const r = await relay(t);
  const { capability } = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 20 });
  assert.equal((await send(r.url, capability, { model: 'gpt-other', input: [] })).status, 403);
  const other = zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-other' })));
  assert.equal((await send(r.url, capability, other, { 'content-encoding': 'zstd' })).status, 403);
  assert.equal((await send(r.url, capability, Buffer.from('{bad'))).status, 400);
  assert.equal((await send(r.url, capability, Buffer.from('x'), { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await fetch(r.url + '/backend-api/other', { method: 'POST', headers: { authorization: `Bearer ${capability}` }, body: '{}' })).status, 404);
  assert.equal((await fetch(r.url + PATH, { headers: { authorization: `Bearer ${capability}` } })).status, 405);
  const good = zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', input: [] })));
  assert.equal((await send(r.url, capability, good, { 'content-encoding': 'zstd' })).status, 200);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].headers['content-encoding'], 'zstd');
  assert.deepEqual(r.calls[0].body, good);
});

test('request count, body size and decompression budgets fail closed', async t => {
  const r = await relay(t, { config: { maxRequestBytes: 4096, maxDecodedBytes: 8192 } });
  const { capability } = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 2 });
  assert.equal((await send(r.url, capability, { model: 'gpt-6.1-sol', pad: 'x'.repeat(5000) })).status, 413);
  const bomb = zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', pad: 'x'.repeat(20000) })));
  assert.ok(bomb.length < 4096);
  assert.equal((await send(r.url, capability, bomb, { 'content-encoding': 'zstd' })).status, 413);
  assert.equal((await send(r.url, capability)).status, 200);
  assert.equal((await send(r.url, capability)).status, 200);
  assert.equal((await send(r.url, capability)).status, 429);
  assert.equal(r.calls.length, 2);
});

test('websocket upgrades are refused so the worker uses SSE only', async t => {
  const r = await relay(t);
  const { capability } = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 5 });
  const port = new URL(r.url).port;
  const net = await import('node:net');
  const reply = await new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer ${capability}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let data = '';
    socket.on('data', d => { data += d; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
  assert.equal(reply.includes('101'), false);
  assert.equal(r.calls.length, 0);
});

test('upstream and credential failures return fixed errors without raw details', async t => {
  const r = await relay(t, { upstream: async () => { throw new Error('upstream-secret-canary'); } });
  const { capability } = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 5 });
  const response = await send(r.url, capability);
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('canary'), false);
  const failing = await relay(t, { config: { getAccessToken: async () => { throw new Error('refresh-secret-canary'); } } });
  const second = await issueGrant(failing.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 5 });
  const denied = await send(failing.url, second.capability);
  assert.equal(denied.status, 503);
  assert.equal((await denied.text()).includes('canary'), false);
});

test('a replacement relay shares the persisted request budget', async t => {
  const first = await relay(t);
  const { capability } = await issueGrant(first.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 1 });
  assert.equal((await send(first.url, capability)).status, 200);
  const second = await relay(t, { grantsDir: first.grantsDir });
  assert.equal((await send(second.url, capability)).status, 429);
  assert.equal(second.calls.length, 0);
});

test('concurrent relay processes admit exactly the remaining allowance', async t => {
  const first = await relay(t);
  const second = await relay(t, { grantsDir: first.grantsDir });
  const { capability } = await issueGrant(first.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 1 });
  const responses = await Promise.all([send(first.url, capability), send(second.url, capability)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 429]);
  assert.equal(first.calls.length + second.calls.length, 1);
});

test('revocation waits for an admitted upstream request to abort', async t => {
  const started = Promise.withResolvers();
  const r = await relay(t, { upstream: async (_url, { signal }) => {
    started.resolve(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  const grant = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 1 });
  const pending = send(r.url, grant.capability);
  const signal = await started.promise;
  await revokeGrant(r.grantsDir, grant.grantId);
  assert.equal(signal.aborted, true);
  assert.equal((await pending).status, 502);
});

test('revocation during credential lookup prevents dispatch', async t => {
  const started = Promise.withResolvers();
  const credential = Promise.withResolvers();
  const r = await relay(t, { config: { getAccessToken: () => { started.resolve(); return credential.promise; } } });
  const grant = await issueGrant(r.grantsDir, { jobId: JOB, ttlMs: 60000, maxRequests: 1 });
  const pending = send(r.url, grant.capability);
  await started.promise;
  await revokeGrant(r.grantsDir, grant.grantId);
  credential.resolve(REAL);
  assert.equal((await pending).status, 401);
  assert.equal(r.calls.length, 0);
});
