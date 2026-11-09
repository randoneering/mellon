import { createHash } from 'node:crypto';
import { createPublicationClient } from './publication-client.mjs';
import {
  buildOperationHash, deriveBranchName, gitBlobSha, parseGitTree,
  snapshotPublicationRequest, validationBaseFromTree, verifyOwnedCommitProof,
  verifyTreeMatchesChanges,
} from './publication-validation.mjs';
import { validateChanges } from './patch.mjs';
import { validateIntent } from './store-validation.mjs';

const REPOSITORY = 'randoneering/mellon';
const ROOT = `/repos/${REPOSITORY}`;
const API = 'https://api.github.com';
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TRUSTED_PATHS = new Set([
  'AGENTS.md', 'automation/policy/system.md', 'automation/policy/documentation.md',
  'automation/policy/skills/test-driven-development/SKILL.md',
  'automation/policy/skills/test-driven-development/writing-good-tests.md',
  'automation/policy/skills/systematic-debugging/SKILL.md',
  'automation/policy/skills/systematic-debugging/root-cause-tracing.md',
  'automation/policy/skills/systematic-debugging/defense-in-depth.md',
  'automation/policy/skills/systematic-debugging/condition-based-waiting.md',
  'automation/policy/skills/verification-before-completion/SKILL.md',
]);
const SCOPE = { kind: 'bounded-public-issue', maxChangedFiles: 10, maxFileBytes: 65536, maxTotalBytes: 262144 };
const fail = () => { throw new TypeError('Repository read rejected.'); };
const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Shared only by the fixed-resource discovery reader, never exposed to model tools.
export function createRepositoryReadSession(config, { deadline, signal } = {}) {
  const { token, repository, repositoryId, fetch = globalThis.fetch,
    timeoutMs = 5000, responseLimit = 4 * 1024 * 1024, aggregateLimit = 8 * 1024 * 1024 } = config;
  if (repository !== REPOSITORY || !positive(repositoryId) || typeof token !== 'string'
    || !token || token.length > 4096 || typeof fetch !== 'function'
    || !positive(timeoutMs) || timeoutMs > 20000 || !positive(responseLimit)
    || responseLimit > 4 * 1024 * 1024 || !positive(aggregateLimit)
    || aggregateLimit > 16 * 1024 * 1024 || !Number.isFinite(deadline)
    || deadline <= Date.now() || signal && typeof signal.addEventListener !== 'function') fail();
  const controller = new AbortController();
  const end = Math.min(deadline, Date.now() + timeoutMs);
  let expired = false, bytesRead = 0, timer, rejectExpired;
  const expiration = new Promise((_, reject) => { rejectExpired = reject; });
  expiration.catch(() => {});
  const abort = () => { expired = true; controller.abort(); rejectExpired(new TypeError('Repository read rejected.')); };
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, Math.max(1, end - Date.now()));
  if (signal?.aborted) abort();
  const budget = {
    signal: controller.signal,
    isExpired: () => expired || Date.now() >= end,
    async wait(operation) {
      if (expired || Date.now() >= end) fail();
      const result = await Promise.race([Promise.resolve().then(operation), expiration]);
      if (expired || Date.now() >= end) fail();
      return result;
    },
  };
  async function boundedFetch(url, options) {
    const target = new URL(url, API);
    if (target.origin !== API || target.username || target.password || target.hash
      || !(target.pathname.startsWith(`${ROOT}/`) || target.pathname === ROOT || target.pathname === '/graphql')
      || !['GET', 'POST'].includes(options.method)
      || options.method === 'POST' && target.pathname !== '/graphql') fail();
    const response = await budget.wait(() => fetch(target.href, { ...options,
      headers: { ...options.headers, 'accept-encoding': 'identity' },
      redirect: 'manual', signal: controller.signal }));
    const cancel = () => { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} };
    if (!response || response.status !== 200 || response.redirected === true || !response.body
      || response.url && response.url !== target.href) { cancel(); fail(); }
    const length = response.headers?.get?.('content-length');
    if (length != null && (!/^\d+$/.test(length) || Number(length) > responseLimit)) { cancel(); fail(); }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await budget.wait(() => reader.read());
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) fail();
        size += part.value.byteLength; bytesRead += part.value.byteLength;
        if (size > responseLimit || bytesRead > aggregateLimit) fail();
        chunks.push(Buffer.from(part.value));
      }
      if (length != null && Number(length) !== size) fail();
      const bytes = Buffer.concat(chunks, size);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return new Response(bytes, { status: 200, headers: response.headers });
    } catch {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      fail();
    }
  }
  async function get(path) {
    const response = await boundedFetch(`${API}${path}`, { method: 'GET', headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
    } });
    return { data: await budget.wait(() => response.json()), hasNext: /rel\s*=\s*"?next"?/i.test(response.headers.get('link') ?? '') };
  }
  return {
    get, fetch: boundedFetch, budget,
    async verifyRepository() {
      const { data } = await get(ROOT);
      if (data?.id !== repositoryId || data?.full_name !== REPOSITORY || data?.private !== false) fail();
    },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); },
  };
}

function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 32) fail();
  const needed = new Set();
  for (const path of paths) {
    if (typeof path !== 'string') fail();
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i += 1) needed.add(parts.slice(0, i).join('/'));
  }
  validateChanges([...needed].map(path => ({ path, mode: null, blobSha: null })),
    [{ operation: 'create', path: paths[0], content: '' }], { allowedPaths: paths, pilotScope: SCOPE });
}
async function treeAt(session, revision, expectedTreeSha, expectedParentSha) {
  if (!SHA1.test(revision ?? '')) fail();
  const { data: commit } = await session.get(`${ROOT}/git/commits/${revision}`);
  if (commit?.sha !== revision || !SHA1.test(commit.tree?.sha ?? '')
    || !Array.isArray(commit.parents) || commit.parents.length > 64
    || commit.parents.some(parent => !SHA1.test(parent?.sha ?? ''))
    || expectedTreeSha !== undefined && commit.tree.sha !== expectedTreeSha
    || expectedParentSha !== undefined && (commit.parents.length !== 1 || commit.parents[0].sha !== expectedParentSha)) fail();
  const { data } = await session.get(`${ROOT}/git/trees/${commit.tree.sha}?recursive=1`);
  return parseGitTree(data, commit.tree.sha);
}
async function textBlob(session, sha, limit = 65536) {
  if (!SHA1.test(sha ?? '')) fail();
  const { data } = await session.get(`${ROOT}/git/blobs/${sha}`);
  if (data?.sha !== sha || data.encoding !== 'base64' || !Number.isSafeInteger(data.size)
    || data.size < 0 || data.size > limit || typeof data.content !== 'string'
    || data.content.length > Math.ceil(limit / 3) * 4 + 4096
    || !/^[A-Za-z0-9+/=\r\n]*$/.test(data.content)) fail();
  const encoded = data.content.replace(/[\r\n]/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length !== data.size || gitBlobSha(bytes) !== sha) fail();
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) fail();
  return text;
}
async function prepared(session, revision, allowedPaths, expectedTreeSha, expectedParentSha) {
  validatePaths(allowedPaths);
  const tree = await treeAt(session, revision, expectedTreeSha, expectedParentSha);
  const metadata = validationBaseFromTree(tree, allowedPaths);
  if (metadata.length > 128) fail();
  let total = 0;
  const files = [];
  for (const file of metadata) {
    if (file.mode === null || file.mode === '040000') { files.push(file); continue; }
    if (!allowedPaths.includes(file.path) || file.mode !== '100644') fail();
    const text = await textBlob(session, file.blobSha);
    total += Buffer.byteLength(text);
    if (total > 262144) fail();
    files.push({ ...file, text, sha256: hash(text) });
  }
  return { files, tree };
}

/** Read immutable repository facts; no caller-provided URL is ever followed. */
export function createRepositoryReader(configuration = {}) {
  const config = { ...configuration, trustedPaths: structuredClone(configuration.trustedPaths ?? []),
    ownedActor: structuredClone(configuration.ownedActor) };
  if (!SHA1.test(config.policyRevision ?? '') || !Array.isArray(config.trustedPaths)
    || config.trustedPaths.length > TRUSTED_PATHS.size
    || new Set(config.trustedPaths.map(source => source.path)).size !== config.trustedPaths.length
    || config.trustedPaths.some(source => !exact(source, ['path', 'sha256'])
      || !TRUSTED_PATHS.has(source.path) || !SHA256.test(source.sha256 ?? ''))) fail();
  const trusted = new Map(config.trustedPaths.map(source => [source.path, source.sha256]));
  async function read(options, operation) {
    let session;
    try {
      session = createRepositoryReadSession(config, options);
      await session.verifyRepository();
      return await operation(session);
    } catch { fail(); } finally { session?.close(); }
  }
  return Object.freeze({
    async readIssue({ manifest, deadline, signal }) {
      try { manifest = structuredClone(manifest); } catch { fail(); }
      if (manifest?.repository?.name !== REPOSITORY || manifest.repository.id !== config.repositoryId
        || !positive(manifest.issue?.id) || !positive(manifest.issue.number)
        || !SHA256.test(manifest.issue.contentSha256 ?? '')) fail();
      return read({ deadline, signal }, async session => {
        const { data: issue } = await session.get(`${ROOT}/issues/${manifest.issue.number}`);
        if (issue?.id !== manifest.issue.id || issue.number !== manifest.issue.number || issue.state !== 'open'
          || Object.hasOwn(issue, 'pull_request') || issue.repository_url !== `${API}${ROOT}`
          || typeof issue.title !== 'string' || issue.body !== null && typeof issue.body !== 'string'
          || hash(JSON.stringify([issue.title, issue.body])) !== manifest.issue.contentSha256) fail();
        return Object.freeze({ title: issue.title, body: issue.body });
      });
    },
    async readPreparedFiles({ revision, allowedPaths, deadline, signal }) {
      try { allowedPaths = structuredClone(allowedPaths); } catch { fail(); }
      return read({ deadline, signal }, async session => (await prepared(session, revision, allowedPaths)).files);
    },
    async readTrustedFile({ revision, path, deadline, signal }) {
      if (revision !== config.policyRevision || !trusted.has(path)) fail();
      return read({ deadline, signal }, async session => {
        const tree = await treeAt(session, revision);
        const entry = tree.get(path);
        if (entry?.mode !== '100644') fail();
        const text = await textBlob(session, entry.sha, 128 * 1024);
        if (hash(text) !== trusted.get(path)) fail();
        return text;
      });
    },
    async reconstructCandidate({ publication, metadata, deadline, signal }) {
      try { publication = structuredClone(publication); metadata = structuredClone(metadata); } catch { fail(); }
      return read({ deadline, signal }, async session => {
        const run = publication?.run;
        const manifest = publication?.approvedManifest;
        const actor = config.ownedActor;
        if (!run || !manifest || run.repositoryId !== config.repositoryId || !actor
          || !positive(actor.databaseId) || typeof actor.login !== 'string'
          || !Array.isArray(metadata?.candidateDescriptors)
          || metadata.candidateDescriptors.length < 1 || metadata.candidateDescriptors.length > 10) fail();
        const branch = deriveBranchName(run.id);
        const client = createPublicationClient({ fetch: session.fetch, token: config.token, budget: session.budget });
        const ref = await client.getRef(branch);
        const head = ref?.object?.sha;
        if (ref?.ref !== `refs/heads/${branch}` || ref.object.type !== 'commit'
          || !SHA1.test(head ?? '') || head === run.expectedHeadSha) fail();
        const proof = await client.getCommitProof(head, branch);
        const owned = verifyOwnedCommitProof(proof, { repositoryId: run.repositoryId, oid: head, actor });
        if (!owned || owned.parentSha !== run.expectedHeadSha || proof.ref.targetSha !== head
          || proof.ref.name !== `refs/heads/${branch}`) fail();
        let cursor = run.expectedHeadSha, expectedParent;
        for (let depth = 0; cursor !== run.baseSha; depth += 1) {
          if (depth >= 5) fail();
          const parentProof = await client.getCommitProof(cursor, branch);
          const parent = verifyOwnedCommitProof(parentProof, { repositoryId: run.repositoryId, oid: cursor, actor });
          if (!parent || parentProof.ref.targetSha !== head || parentProof.ref.name !== `refs/heads/${branch}`) fail();
          if (cursor === run.expectedHeadSha) expectedParent = parent;
          cursor = parent.parentSha;
        }
        const before = await prepared(session, run.expectedHeadSha, manifest.allowedPaths,
          expectedParent?.treeSha, expectedParent?.parentSha);
        const after = await treeAt(session, head, owned.treeSha, run.expectedHeadSha);
        const proposedChanges = [];
        const seen = new Set();
        for (const descriptor of metadata.candidateDescriptors) {
          if (!exact(descriptor, ['approvedPathIndex', 'operation', 'beforeBlobSha', 'afterBlobSha', 'contentSha256', 'bytes', 'mode'])
            || !Number.isSafeInteger(descriptor.approvedPathIndex) || descriptor.approvedPathIndex < 0
            || descriptor.approvedPathIndex >= manifest.allowedPaths.length || seen.has(descriptor.approvedPathIndex)
            || !['create', 'modify'].includes(descriptor.operation) || descriptor.mode !== '100644'
            || !SHA1.test(descriptor.afterBlobSha ?? '') || !SHA256.test(descriptor.contentSha256 ?? '')
            || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > 65536) fail();
          seen.add(descriptor.approvedPathIndex);
          const path = manifest.allowedPaths[descriptor.approvedPathIndex];
          const old = before.tree.get(path);
          if (descriptor.operation === 'create' ? old || descriptor.beforeBlobSha !== null
            : old?.mode !== '100644' || old.sha !== descriptor.beforeBlobSha) fail();
          const entry = after.get(path);
          if (entry?.mode !== '100644' || entry.sha !== descriptor.afterBlobSha) fail();
          const content = await textBlob(session, entry.sha);
          if (hash(content) !== descriptor.contentSha256 || Buffer.byteLength(content) !== descriptor.bytes) fail();
          proposedChanges.push({ operation: descriptor.operation, path, content,
            ...(descriptor.operation === 'modify' ? { expectedBlobSha: descriptor.beforeBlobSha } : {}) });
        }
        const request = snapshotPublicationRequest({ ...publication, proposedChanges });
        const accepted = validateChanges(before.files.map(({ path, mode, blobSha }) => ({ path, mode, blobSha })), proposedChanges,
          { allowedPaths: manifest.allowedPaths, pilotScope: manifest.pilotScope });
        const operationHash = buildOperationHash(request, accepted);
        const key = hash(canonical({ version: 1, phaseKey: metadata.phaseKey, modelOperationId: metadata.modelOperationId, operationHash }));
        if (!verifyTreeMatchesChanges(before.tree, after, accepted) || request.intent.id !== key) fail();
        const intent = validateIntent({ key, kind: 'commit_create', inputHash: operationHash,
          expectedHeadSha: run.expectedHeadSha, coordinator: metadata });
        return Object.freeze({ publication: request, changes: accepted, observedHeadSha: head, operationHash, intent, metadata: intent.coordinator });
      });
    },
  });
}
