import assert from 'node:assert/strict';
import test from 'node:test';
import { blob, hash, manifest, HEAD, POLICY, PATH, SOURCE, fakeApi, repositoryConfig } from '../fixtures/worker-candidates/inputs.mjs';
import { createRepositoryReader } from '../../src/automation/worker/repository.mjs';
const root = '/repos/randoneering/mellon';
const treeSha = 'c'.repeat(40);
function treeRoutes(text = SOURCE, path = PATH, revision = HEAD) {
  const parts = path.split('/');
  return {
    [`${root}/git/commits/${revision}`]: { sha: revision, tree: { sha: treeSha }, parents: [] },
    [`${root}/git/trees/${treeSha}?recursive=1`]: { sha: treeSha, truncated: false, tree: [...parts.slice(0, -1).map((_, i) => ({ path: parts.slice(0, i + 1).join('/'), mode: '040000', type: 'tree', sha: 'd'.repeat(40) })), { path, mode: '100644', type: 'blob', sha: blob(text), size: Buffer.byteLength(text) }] },
    [`${root}/git/blobs/${blob(text)}`]: { sha: blob(text), size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text).toString('base64') },
  };
}
const options = () => ({ deadline: Date.now() + 1000 });

test('repository verifies approved issue content using fixed identity resources', async () => {
  const approved = manifest();
  const api = fakeApi({ [`${root}/issues/22`]: { id: 9001, number: 22, state: 'open', repository_url: 'https://api.github.com' + root, title: 'approved title', body: 'approved body' } });
  const issue = await createRepositoryReader(repositoryConfig(api)).readIssue({ manifest: approved, ...options() });
  assert.deepEqual(issue, { title: 'approved title', body: 'approved body' });
});
for (const [name, value] of Object.entries({ 'changed issue text': { title: 'changed' }, 'foreign issue id': { id: 1 }, 'pull request': { pull_request: {} }, 'submitted repository URL': { repository_url: 'https://attacker.invalid' } })) test(`repository rejects ${name}`, async () => {
  const api = fakeApi({ [`${root}/issues/22`]: { id: 9001, number: 22, state: 'open', repository_url: 'https://api.github.com' + root, title: 'approved title', body: 'approved body', ...value } });
  await assert.rejects(createRepositoryReader(repositoryConfig(api)).readIssue({ manifest: manifest(), ...options() }), /Repository/);
});

test('repository supplies agent text and patch ancestors including explicit absence', async () => {
  const api = fakeApi(treeRoutes());
  const files = await createRepositoryReader(repositoryConfig(api)).readPreparedFiles({ revision: HEAD, allowedPaths: [PATH, 'src/new.mjs'], ...options() });
  assert.deepEqual(files.find(file => file.path === PATH), { path: PATH, mode: '100644', blobSha: blob(SOURCE), text: SOURCE, sha256: hash(SOURCE) });
  assert.deepEqual(files.find(file => file.path === 'src'), { path: 'src', mode: null, blobSha: null });
  assert.deepEqual(files.find(file => file.path === 'src/new.mjs'), { path: 'src/new.mjs', mode: null, blobSha: null });
});
for (const [name, mutate] of Object.entries({
  'truncated tree': (key, value) => key.includes('/trees/') ? { ...value, truncated: true } : value,
  'wrong head response': (key, value) => key.includes('/commits/') ? { ...value, sha: POLICY } : value,
  'foreign repository id': (key, value) => key === root ? { ...value, id: 9 } : value,
  'blob SHA mismatch': (key, value) => key.includes('/blobs/') ? { ...value, sha: 'f'.repeat(40) } : value,
  'blob size mismatch': (key, value) => key.includes('/blobs/') ? { ...value, size: 1 } : value,
  'blob truncation': (key, value) => key.includes('/blobs/') ? { ...value, content: value.content.slice(0, -4) } : value,
  'invalid encoding': (key, value) => key.includes('/blobs/') ? { ...value, encoding: 'utf-8' } : value,
  'symlink target': (key, value) => key.includes('/trees/') ? { ...value, tree: value.tree.map(entry => entry.path === PATH ? { ...entry, mode: '120000' } : entry) } : value,
  'manual redirect': (key, value) => key.includes('/trees/') ? new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } }) : value,
  'declared truncated response': (key, value) => key.includes('/trees/') ? new Response(JSON.stringify(value), { headers: { 'content-length': '1' } }) : value,
})) test(`repository rejects ${name}`, async () => {
  const api = fakeApi(treeRoutes(), mutate);
  await assert.rejects(createRepositoryReader(repositoryConfig(api)).readPreparedFiles({ revision: HEAD, allowedPaths: [PATH], ...options() }), /Repository/);
});

test('repository rejects binary and invalid UTF8 verified blob bytes', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0])]) {
    const digest = blob(bytes); const routes = treeRoutes();
    routes[`${root}/git/trees/${treeSha}?recursive=1`].tree.at(-1).sha = digest;
    routes[`${root}/git/blobs/${digest}`] = { sha: digest, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    await assert.rejects(createRepositoryReader(repositoryConfig(fakeApi(routes))).readPreparedFiles({ revision: HEAD, allowedPaths: [PATH], ...options() }), /Repository/);
  }
});

test('repository guidance is pinned to reviewed policy revision and exact source hash', async () => {
  const path = 'AGENTS.md', text = '# trusted';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  const reader = createRepositoryReader({ ...repositoryConfig(api), trustedPaths: [{ path, sha256: hash(text) }] });
  assert.equal(await reader.readTrustedFile({ revision: POLICY, path, ...options() }), text);
  await assert.rejects(reader.readTrustedFile({ revision: HEAD, path, ...options() }), /Repository/);
  await assert.rejects(reader.readTrustedFile({ revision: POLICY, path: PATH, ...options() }), /Repository/);
  const forged = createRepositoryReader({ ...repositoryConfig(api), trustedPaths: [{ path, sha256: 'f'.repeat(64) }] });
  await assert.rejects(forged.readTrustedFile({ revision: POLICY, path, ...options() }), /Repository/);
});

test('repository deadline races transport that ignores injected cancellation', async () => {
  const reader = createRepositoryReader({ ...repositoryConfig({ fetch: () => new Promise(() => {}) }), timeoutMs: 50 });
  const start = Date.now();
  await assert.rejects(reader.readIssue({ manifest: manifest(), deadline: start + 20 }), /Repository/);
  assert.ok(Date.now() - start < 500);
});

test('repository abort races a stream reader that ignores cancellation', async () => {
  const controller = new AbortController();
  const fetch = async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
  const reader = createRepositoryReader({ ...repositoryConfig({ fetch }), timeoutMs: 100 });
  const pending = reader.readIssue({ manifest: manifest(), deadline: Date.now() + 500, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /Repository/);
});

test('repository bounds ancestor metadata to the actual agent file-index capacity', async () => {
  const routes = treeRoutes(); routes[`${root}/git/trees/${treeSha}?recursive=1`].tree = [];
  const paths = Array.from({ length: 32 }, (_, index) => `p${index}/a/b/c/d/e/file.mjs`);
  const reader = createRepositoryReader(repositoryConfig(fakeApi(routes)));
  await assert.rejects(reader.readPreparedFiles({ revision: HEAD, allowedPaths: paths, ...options() }), /Repository/);
});

test('repository caps aggregate bytes across individually valid blobs', async () => {
  const api = fakeApi(treeRoutes());
  await assert.rejects(createRepositoryReader({ ...repositoryConfig(api), aggregateLimit: 256 }).readPreparedFiles({ revision: HEAD, allowedPaths: [PATH], ...options() }), /Repository/);
});

test('repository preserves the approved null-body content hash exactly', async () => {
  const approved = manifest(); approved.issue.contentSha256 = hash(JSON.stringify(['approved title', null]));
  const api = fakeApi({ [`${root}/issues/22`]: { id: 9001, number: 22, state: 'open', repository_url: 'https://api.github.com' + root, title: 'approved title', body: null } });
  assert.deepEqual(await createRepositoryReader(repositoryConfig(api)).readIssue({ manifest: approved, ...options() }), { title: 'approved title', body: null });
});

test('repository retains a verified UTF8 byte-order mark in file content', async () => {
  const source = '\ufeff' + SOURCE;
  const reader = createRepositoryReader(repositoryConfig(fakeApi(treeRoutes(source))));
  const files = await reader.readPreparedFiles({ revision: HEAD, allowedPaths: [PATH], ...options() });
  assert.equal(files.find(file => file.path === PATH).text, source);
});

test('repository requests identity encoding for exact response-byte accounting', async () => {
  const api = fakeApi({ [`${root}/issues/22`]: { id: 9001, number: 22, state: 'open', repository_url: 'https://api.github.com' + root, title: 'approved title', body: 'approved body' } });
  const fetch = (url, options) => options.headers['accept-encoding'] === 'identity'
    ? api.fetch(url, options) : new Response('{}', { headers: { 'content-encoding': 'gzip', 'content-length': '1' } });
  assert.deepEqual(await createRepositoryReader(repositoryConfig({ fetch })).readIssue({ manifest: manifest(), ...options() }), { title: 'approved title', body: 'approved body' });
});

test('repository snapshots approved issue identity before an injected async mutation', async () => {
  const approved = manifest();
  const api = fakeApi({ [`${root}/issues/22`]: { id: 9001, number: 22, state: 'open', repository_url: 'https://api.github.com' + root, title: 'changed by attacker', body: 'approved body' } }, (key, value) => {
    if (key === root) approved.issue.contentSha256 = hash(JSON.stringify(['changed by attacker', 'approved body']));
    return value;
  });
  await assert.rejects(createRepositoryReader(repositoryConfig(api)).readIssue({ manifest: approved, ...options() }), /Repository/);
});

test('repository snapshots path scope before an injected async mutation', async () => {
  const paths = [PATH];
  const api = fakeApi(treeRoutes(), (key, value) => { if (key === root) paths.push('unapproved.mjs'); return value; });
  const files = await createRepositoryReader(repositoryConfig(api)).readPreparedFiles({ revision: HEAD, allowedPaths: paths, ...options() });
  assert.equal(files.some(file => file.path === 'unapproved.mjs'), false);
});
