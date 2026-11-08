import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { validatePublicationContext } from './publication-validation.mjs';

const ORIGIN = 'https://api.github.com';
const VERSION = '2022-11-28';
const MAX_BYTES = 256 * 1024;
const MIN_TOKEN_LIFE_MS = 2 * 60_000;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const READER_PERMISSIONS = Object.freeze({
  metadata: 'read', contents: 'read', issues: 'read',
  pull_requests: 'read', actions: 'read', checks: 'read',
});
const PUBLICATION_PERMISSIONS = Object.freeze({ metadata: 'read', contents: 'write' });
const PR_PERMISSIONS = Object.freeze({
  metadata: 'read', contents: 'read', pull_requests: 'write',
});
const REQUIRED_PERMISSIONS = Object.freeze({
  ...READER_PERMISSIONS, ...PR_PERMISSIONS, ...PUBLICATION_PERMISSIONS,
});
const ERRORS = new Set([
  'github_app_unavailable', 'github_app_config_invalid',
  'github_app_request_invalid', 'github_app_deadline_exceeded',
  'github_app_redirect_rejected', 'github_app_response_invalid',
  'github_app_identity_mismatch', 'github_app_capability_unconfirmed',
  'github_app_repository_mismatch', 'github_app_actor_mismatch',
  'github_app_preflight_invalid',
]);
const PROOF_QUERY = `query AgentWorkerSigningPreflight($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){databaseId nameWithOwner object(oid:$oid){... on Commit{oid tree{oid} parents(first:2){nodes{oid}} author{user{databaseId login}} committer{user{databaseId login}} signature{isValid state wasSignedByGitHub}}}}}`;

class BrokerError extends Error {}
function fail(reason = 'github_app_unavailable') { throw new BrokerError(reason); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stamp(ms) { return new Date(ms).toISOString(); }

function validRequest(request, config) {
  if (!record(request) || request.repositoryId !== config.repositoryId
    || request.repositoryName !== config.repositoryName
    || !UUID.test(request.runId ?? '')
    || request.branch !== `agent-work/${request.runId}`) {
    fail('github_app_request_invalid');
  }
}

function budgetFor(control, clock) {
  if (!record(control) || (control.signal !== undefined
    && !(control.signal instanceof AbortSignal))) fail('github_app_request_invalid');
  const start = clock();
  const deadline = control.deadline ?? start + 20_000;
  if (!Number.isSafeInteger(deadline)) fail('github_app_request_invalid');
  const remaining = Math.max(0, Math.min(30_000, deadline - start));
  const wallDeadline = performance.now() + remaining;
  const controller = new AbortController();
  let rejectWait;
  let stopped = false;
  let closed = false;
  const expired = new Promise((_, reject) => { rejectWait = reject; });
  const stop = () => {
    if (stopped || closed) return;
    stopped = true;
    controller.abort();
    rejectWait(new BrokerError('github_app_deadline_exceeded'));
  };
  const timer = setTimeout(stop, remaining);
  control.signal?.addEventListener('abort', stop, { once: true });
  function check() {
    if (stopped || closed || control.signal?.aborted || clock() >= deadline
      || performance.now() >= wallDeadline) fail('github_app_deadline_exceeded');
  }
  return {
    signal: controller.signal,
    check,
    async wait(operation) {
      check();
      const value = await Promise.race([
        Promise.resolve().then(() => { check(); return operation(); }), expired,
      ]);
      check();
      return value;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      control.signal?.removeEventListener('abort', stop);
      controller.abort();
    },
  };
}

function cancelQuietly(stream) {
  try { Promise.resolve(stream?.cancel()).catch(() => {}); } catch {}
}

export function createGitHubAppBroker(input, dependencies = {}) {
  let config;
  let key;
  try {
    if (!record(input) || !positive(input.appId) || !positive(input.installationId)
      || !positive(input.repositoryId) || input.repositoryName !== 'randoneering/mellon'
      || typeof input.privateKey !== 'string' || !record(input.actor)
      || Object.keys(input.actor).length !== 2 || !positive(input.actor.databaseId)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\[bot\]$/.test(input.actor.login ?? '')
      || !/^[a-f0-9]{40}$/.test(input.preflightCommitSha ?? '')) {
      fail('github_app_config_invalid');
    }
    key = createPrivateKey(input.privateKey);
    if (key.asymmetricKeyType !== 'rsa'
      || key.asymmetricKeyDetails?.modulusLength < 2048) fail('github_app_config_invalid');
    config = Object.freeze({
      appId: input.appId, installationId: input.installationId,
      repositoryId: input.repositoryId, repositoryName: input.repositoryName,
      actor: Object.freeze({ databaseId: input.actor.databaseId, login: input.actor.login }),
      preflightCommitSha: input.preflightCommitSha,
    });
  } catch { fail('github_app_config_invalid'); }
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const nowImpl = dependencies.now ?? Date.now;
  if (typeof fetchImpl !== 'function' || typeof nowImpl !== 'function') {
    fail('github_app_config_invalid');
  }
  function clock() {
    const value = nowImpl();
    if (!Number.isSafeInteger(value) || value < 0) fail('github_app_config_invalid');
    return value;
  }
  const cached = new Map();

  function appJwt() {
    const now = Math.floor(clock() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const payload = encode({ iat: now - 60, exp: now + 8 * 60, iss: String(config.appId) });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${signer.sign(key).toString('base64url')}`;
  }

  async function operation(control, action) {
    let budget;
    try {
      budget = budgetFor(control, clock);
      return await budget.wait(() => action(budget));
    } catch (error) {
      if (error instanceof BrokerError && ERRORS.has(error.message)) throw error;
      fail();
    } finally { budget?.close(); }
  }

  async function request(path, token, options, budget) {
    const url = new URL(path, ORIGIN);
    const response = await budget.wait(async () => {
      const result = await fetchImpl(url, {
        ...options, redirect: 'manual', signal: budget.signal,
        headers: {
          accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
          'x-github-api-version': VERSION,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
      });
      if (budget.signal.aborted) {
        cancelQuietly(result?.body);
        fail('github_app_deadline_exceeded');
      }
      return result;
    });
    let reader;
    let complete = false;
    try {
      if (!response || response.redirected
        || (response.status >= 300 && response.status < 400)) {
        fail('github_app_redirect_rejected');
      }
      if (response.status < 200 || response.status >= 300
        || typeof response.body?.getReader !== 'function'
        || (response.url && response.url !== url.href)) fail('github_app_response_invalid');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
        fail('github_app_response_invalid');
      }
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const part = await budget.wait(() => reader.read());
        if (part.done) { complete = true; break; }
        if (!(part.value instanceof Uint8Array)) fail('github_app_response_invalid');
        size += part.value.byteLength;
        if (size > MAX_BYTES) fail('github_app_response_invalid');
        chunks.push(part.value);
      }
      let result;
      try {
        result = JSON.parse(new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.concat(chunks, size)));
      } catch { fail('github_app_response_invalid'); }
      budget.check();
      if (!record(result)) fail('github_app_response_invalid');
      return result;
    } finally {
      if (!complete) cancelQuietly(reader ?? response?.body);
      try { reader?.releaseLock(); } catch {}
    }
  }

  async function verifyIdentity(budget, permissions) {
    const jwt = appJwt();
    const app = await request('/app', jwt, {}, budget);
    if (app.id !== config.appId || typeof app.slug !== 'string'
      || `${app.slug}[bot]`.toLowerCase() !== config.actor.login.toLowerCase()) {
      fail('github_app_identity_mismatch');
    }
    const installation = await request(`/app/installations/${config.installationId}`,
      jwt, {}, budget);
    if (installation.id !== config.installationId || installation.app_id !== config.appId
      || !['selected', 'all'].includes(installation.repository_selection)
      || installation.suspended_at !== null) fail('github_app_identity_mismatch');
    if (!record(installation.permissions)
      || !Object.entries(permissions).every(([name, expected]) => {
        const actual = installation.permissions[name];
        return actual === expected || (name !== 'metadata' && expected === 'read'
          && actual === 'write');
      })) fail('github_app_capability_unconfirmed');
  }

  function sameRepository(repo) {
    return record(repo) && repo.id === config.repositoryId
      && repo.full_name === config.repositoryName;
  }

  async function mint(permissions, budget) {
    await verifyIdentity(budget, permissions);
    const issued = await request(`/app/installations/${config.installationId}/access_tokens`,
      appJwt(), { method: 'POST', body: JSON.stringify({
        repository_ids: [config.repositoryId], permissions,
      }) }, budget);
    const expiresAt = typeof issued.expires_at === 'string'
      ? Date.parse(issued.expires_at) : NaN;
    if (typeof issued.token !== 'string' || !/^[!-~]{1,4096}$/.test(issued.token)
      || !Number.isFinite(expiresAt) || expiresAt <= clock() + MIN_TOKEN_LIFE_MS
      || expiresAt > clock() + 65 * 60_000 || !record(issued.permissions)
      || Object.keys(issued.permissions).length !== Object.keys(permissions).length
      || !Object.entries(permissions).every(([name, value]) => issued.permissions[name] === value)
      || (Object.hasOwn(issued, 'repositories') && (!Array.isArray(issued.repositories)
        || issued.repositories.length !== 1 || !sameRepository(issued.repositories[0])))) {
      fail('github_app_capability_unconfirmed');
    }
    const listed = await request('/installation/repositories', issued.token, {}, budget);
    if (listed.total_count !== 1 || !Array.isArray(listed.repositories)
      || listed.repositories.length !== 1 || !sameRepository(listed.repositories[0])) {
      fail('github_app_capability_unconfirmed');
    }
    const repo = await request(`/repositories/${config.repositoryId}`, issued.token, {}, budget);
    if (!sameRepository(repo)) fail('github_app_repository_mismatch');
    const actor = await request(`/users/${encodeURIComponent(config.actor.login)}`,
      issued.token, {}, budget);
    if (actor.id !== config.actor.databaseId || typeof actor.login !== 'string'
      || actor.login.toLowerCase() !== config.actor.login.toLowerCase()
      || actor.type !== 'Bot') fail('github_app_actor_mismatch');
    if (expiresAt <= clock() + MIN_TOKEN_LIFE_MS) fail('github_app_capability_unconfirmed');
    return Object.freeze({
      token: issued.token, expiresAt,
      permissions: Object.freeze({ ...issued.permissions }),
    });
  }

  async function capability(kind, permissions, budget) {
    const existing = cached.get(kind);
    if (existing && existing.expiresAt > clock() + MIN_TOKEN_LIFE_MS
      && existing.expiresAt <= clock() + 65 * 60_000) return existing;
    cached.delete(kind);
    const cap = await mint(permissions, budget);
    budget.check();
    cached.set(kind, cap);
    return cap;
  }

  async function preflight(cap, budget) {
    const [owner, name] = config.repositoryName.split('/');
    const payload = await request('/graphql', cap.token, {
      method: 'POST', body: JSON.stringify({
        query: PROOF_QUERY, variables: { owner, name, oid: config.preflightCommitSha },
      }),
    }, budget);
    const repo = payload.data?.repository;
    const commit = repo?.object;
    if ((Object.hasOwn(payload, 'errors') && (!Array.isArray(payload.errors)
      || payload.errors.length !== 0)) || repo?.databaseId !== config.repositoryId
      || repo.nameWithOwner !== config.repositoryName || commit?.oid !== config.preflightCommitSha
      || !/^[a-f0-9]{40}$/.test(commit.tree?.oid ?? '')
      || !Array.isArray(commit.parents?.nodes) || commit.parents.nodes.length !== 1
      || !/^[a-f0-9]{40}$/.test(commit.parents.nodes[0]?.oid ?? '')
      || commit.author?.user?.databaseId !== config.actor.databaseId
      || commit.committer?.user?.databaseId !== config.actor.databaseId
      || commit.author.user.login?.toLowerCase() !== config.actor.login.toLowerCase()
      || commit.committer.user.login?.toLowerCase() !== config.actor.login.toLowerCase()
      || commit.signature?.isValid !== true || commit.signature.state !== 'VALID'
      || commit.signature.wasSignedByGitHub !== true
      || cap.expiresAt <= clock() + MIN_TOKEN_LIFE_MS) fail('github_app_preflight_invalid');
    return {
      repositoryId: config.repositoryId, repositoryName: config.repositoryName,
      appId: config.appId, installationId: config.installationId,
      expiresAt: stamp(Math.min(cap.expiresAt, clock() + 4 * 60_000)),
      commit: {
        oid: commit.oid, author: { ...config.actor }, committer: { ...config.actor },
        signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true },
      },
    };
  }

  async function contextFor(kind, permissions, budget) {
    const cap = await capability(kind, permissions, budget);
    const proof = await preflight(cap, budget);
    const context = {
      token: cap.token, tokenExpiresAt: stamp(cap.expiresAt),
      contextExpiresAt: stamp(Math.min(cap.expiresAt, clock() + 5 * 60_000)),
      repositoryId: config.repositoryId, repositoryName: config.repositoryName,
      appId: config.appId, installationId: config.installationId,
      actor: { ...config.actor }, signingPreflight: proof,
    };
    try {
      return { cap, context: validatePublicationContext(context,
        { repositoryId: config.repositoryId }, clock()) };
    } catch { fail('github_app_preflight_invalid'); }
  }

  return Object.freeze({
    async getReadToken(control = {}) {
      return operation(control, async budget =>
        (await capability('reader', READER_PERMISSIONS, budget)).token);
    },
    async getPublicationContext(requestInfo) {
      validRequest(requestInfo, config);
      return operation(requestInfo, async budget =>
        (await contextFor('publication', PUBLICATION_PERMISSIONS, budget)).context);
    },
    async getPullRequestContext(requestInfo) {
      validRequest(requestInfo, config);
      return operation(requestInfo, async budget => {
        const { context, cap } = await contextFor('pullRequest', PR_PERMISSIONS, budget);
        return Object.freeze({
          publicationContext: context,
          installationToken: Object.freeze({
            repositoryId: config.repositoryId, repositoryName: config.repositoryName,
            appId: config.appId, installationId: config.installationId,
            tokenExpiresAt: context.tokenExpiresAt,
            tokenSha256: createHash('sha256').update(cap.token).digest('hex'),
            permissions: cap.permissions,
          }),
        });
      });
    },
    async verifyRuntime(control = {}) {
      return operation(control, async budget => {
        await verifyIdentity(budget, REQUIRED_PERMISSIONS);
        await capability('reader', READER_PERMISSIONS, budget);
        await contextFor('publication', PUBLICATION_PERMISSIONS, budget);
        await capability('pullRequest', PR_PERMISSIONS, budget);
        return true;
      });
    },
  });
}
