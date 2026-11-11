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

test('trusted repository read session caches pinned Git objects but rechecks repository metadata', async () => {
  const path = 'AGENTS.md';
  const text = '# immutable trusted guidance';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  const reader = createRepositoryReader({ ...repositoryConfig(api),
    trustedPaths: [{ path, sha256: hash(text) }] });
  assert.equal(typeof reader.createTrustedReadSession, 'function');
  const request = { revision: POLICY, path, ...options() };
  const invocation = reader.createTrustedReadSession();
  assert.equal(await invocation.readTrustedFile(request), text);
  assert.equal(await invocation.readTrustedFile(request), text);
  const root = '/repos/randoneering/mellon';
  assert.equal(api.calls.filter(value => value === root).length, 2);
  assert.equal(api.calls.filter(value => value === `${root}/git/commits/${POLICY}`).length, 1);
  assert.equal(api.calls.filter(value => value.startsWith(`${root}/git/trees/`)).length, 1);
  assert.equal(api.calls.filter(value => value.startsWith(`${root}/git/blobs/`)).length, 1);
  const nextInvocation = reader.createTrustedReadSession();
  assert.equal(await nextInvocation.readTrustedFile(request), text);
  assert.equal(api.calls.filter(value => value === root).length, 3);
  assert.equal(api.calls.filter(value => value === `${root}/git/commits/${POLICY}`).length, 2);
  assert.equal(api.calls.filter(value => value.startsWith(`${root}/git/trees/`)).length, 2);
  assert.equal(api.calls.filter(value => value.startsWith(`${root}/git/blobs/`)).length, 2);
});

test('trusted concurrent reads share in-flight Git objects and verify each repository access', async () => {
  const path = 'AGENTS.md', text = '# concurrent trusted guidance';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let commitReads = 0;
  const fetch = async (url, init) => {
    if (new URL(url).pathname === `${root}/git/commits/${POLICY}`) {
      commitReads += 1;
      await gate;
    }
    return api.fetch(url, init);
  };
  const reader = createRepositoryReader({ ...repositoryConfig({ fetch }),
    trustedPaths: [{ path, sha256: hash(text) }] });
  const session = reader.createTrustedReadSession();
  const request = { revision: POLICY, path, ...options() };
  const pending = Promise.all([session.readTrustedFile(request), session.readTrustedFile(request)]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commitReads, 1);
  } finally { release(); await pending; }
  assert.deepEqual(await pending, [text, text]);
  assert.equal(api.calls.filter(value => value === root).length, 2);
  assert.equal(api.calls.filter(value => value.includes('/git/trees/')).length, 1);
  assert.equal(api.calls.filter(value => value.includes('/git/blobs/')).length, 1);
  session.close();
});

test('an earlier caller deadline cannot abort a later independent trusted read', async () => {
  const path = 'AGENTS.md', text = '# independent deadlines';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetch = async (url, init) => {
    if (new URL(url).pathname.includes('/git/commits/')) await gate;
    return api.fetch(url, init);
  };
  const reader = createRepositoryReader({ ...repositoryConfig({ fetch }),
    trustedPaths: [{ path, sha256: hash(text) }] });
  const session = reader.createTrustedReadSession();
  const first = session.readTrustedFile({ revision: POLICY, path, deadline: Date.now() + 50 });
  const rejected = assert.rejects(first, /Repository/);
  await new Promise(resolve => setImmediate(resolve));
  const second = session.readTrustedFile({ revision: POLICY, path, ...options() })
    .then(value => ({ value }), error => ({ error }));
  await rejected;
  release();
  assert.deepEqual(await second, { value: text });
  session.close();
});

test('one caller signal cannot abort another trusted read with its own signal', async () => {
  const path = 'AGENTS.md', text = '# independent signals';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetch = async (url, init) => {
    if (new URL(url).pathname.includes('/git/commits/')) await gate;
    return api.fetch(url, init);
  };
  const reader = createRepositoryReader({ ...repositoryConfig({ fetch }),
    trustedPaths: [{ path, sha256: hash(text) }] });
  const session = reader.createTrustedReadSession();
  const firstSignal = new AbortController(), secondSignal = new AbortController();
  const request = { revision: POLICY, path, ...options() };
  const first = session.readTrustedFile({ ...request, signal: firstSignal.signal });
  const rejected = assert.rejects(first, /Repository/);
  await new Promise(resolve => setImmediate(resolve));
  const second = session.readTrustedFile({ ...request, signal: secondSignal.signal })
    .then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  firstSignal.abort();
  release();
  await rejected;
  assert.deepEqual(await second, { value: text });
  session.close();
});

test('closing a trusted session before dispatch starts no queued transport callback', async () => {
  const path = 'AGENTS.md', text = '# close before dispatch';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  const reader = createRepositoryReader({ ...repositoryConfig(api),
    trustedPaths: [{ path, sha256: hash(text) }] });
  const session = reader.createTrustedReadSession();
  const pending = session.readTrustedFile({ revision: POLICY, path, ...options() });
  const rejected = assert.rejects(pending, /Repository/);
  session.close();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.calls.length, 0);
});

test('closing a shared read aborts its in-flight transport before another Git request', async () => {
  const path = 'AGENTS.md', text = '# closed concurrent guidance';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = [];
  const fetch = async (url, init) => {
    requested.push(new URL(url).pathname);
    if (new URL(url).pathname.includes('/git/commits/')) await gate;
    return api.fetch(url, init);
  };
  const reader = createRepositoryReader({ ...repositoryConfig({ fetch }),
    trustedPaths: [{ path, sha256: hash(text) }] });
  const session = reader.createTrustedReadSession();
  const pending = session.readTrustedFile({ revision: POLICY, path, ...options() });
  const rejected = assert.rejects(pending, /Repository/);
  await new Promise(resolve => setImmediate(resolve));
  session.close();
  release();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested.some(value => value.includes('/git/trees/')), false);
  assert.equal(requested.some(value => value.includes('/git/blobs/')), false);
});

test('a rejected shared Git read does not poison the next verified read', async () => {
  const path = 'AGENTS.md', text = '# retry verified read';
  let commitReads = 0;
  const api = fakeApi(treeRoutes(text, path, POLICY), (key, value) => {
    if (key === `${root}/git/commits/${POLICY}` && ++commitReads === 1) {
      return { ...value, sha: 'f'.repeat(40) };
    }
    return value;
  });
  const reader = createRepositoryReader({ ...repositoryConfig(api),
    trustedPaths: [{ path, sha256: hash(text) }] });
  const session = reader.createTrustedReadSession();
  const request = { revision: POLICY, path, ...options() };
  const results = await Promise.allSettled([session.readTrustedFile(request), session.readTrustedFile(request)]);
  assert.deepEqual(results.map(value => value.status), ['rejected', 'rejected']);
  assert.equal(await session.readTrustedFile(request), text);
  assert.equal(commitReads, 2);
  session.close();
});

test('trusted repository session closes permanently without permitting cached reads', async () => {
  const path = 'AGENTS.md', text = '# trusted';
  const api = fakeApi(treeRoutes(text, path, POLICY));
  const reader = createRepositoryReader({ ...repositoryConfig(api), trustedPaths: [{ path, sha256: hash(text) }] });
  const session = reader.createTrustedReadSession();
  await session.readTrustedFile({ revision: POLICY, path, ...options() });
  assert.equal(typeof session.close, 'function');
  session.close();
  const before = api.calls.length;
  await assert.rejects(session.readTrustedFile({ revision: POLICY, path, ...options() }));
  assert.equal(api.calls.length, before);
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
