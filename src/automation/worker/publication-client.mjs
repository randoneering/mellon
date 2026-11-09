import {
  BASE_BRANCH,
  MAX_TREE_BYTES,
  REPOSITORY_FULL_NAME,
  REPOSITORY_NAME,
  REPOSITORY_OWNER,
  validSha1,
  validSha256,
} from './publication-validation.mjs';

export const PUBLICATION_API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const MAX_RESPONSE_BYTES = MAX_TREE_BYTES;
const MAX_REQUEST_BYTES = 1024 * 1024;
const CREATE_COMMIT_QUERY = `mutation AgentWorkerCreateCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid }
    ref { name prefix target { ... on Commit { oid } } }
  }
}`;
const COMMIT_PROOF_QUERY = `query AgentWorkerCommitProof($owner: String!, $name: String!, $oid: GitObjectID!, $qualifiedRefName: String!) {
  repository(owner: $owner, name: $name) {
    databaseId
    nameWithOwner
    object(oid: $oid) {
      ... on Commit {
        oid
        tree { oid }
        parents(first: 2) { nodes { oid } }
        author { user { databaseId login } }
        committer { user { databaseId login } }
        signature { isValid state wasSignedByGitHub signer { databaseId login } }
      }
    }
    ref(qualifiedName: $qualifiedRefName) {
      name
      prefix
      target { ... on Commit { oid } }
    }
  }
}`;

class PublicationClientError extends Error {
  constructor(reason = 'transport_failed') {
    super(reason);
    this.name = 'PublicationClientError';
    this.reason = reason;
  }
}

function fail(reason) {
  throw new PublicationClientError(reason);
}

function validBranch(branch) {
  return typeof branch === 'string'
    && /^agent-work\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(branch);
}

function qualifiedHeadRef(ref, branch) {
  if (!ref || ref.prefix !== 'refs/heads/' || ref.name !== branch) {
    fail('graphql_response_invalid');
  }
  return `${ref.prefix}${ref.name}`;
}

function apiUrl(path) {
  let url;
  try {
    url = new URL(path, PUBLICATION_API_ORIGIN);
  } catch {
    fail('transport_failed');
  }
  if (url.protocol !== 'https:' || url.origin !== PUBLICATION_API_ORIGIN
    || url.username || url.password || url.hash) fail('transport_failed');
  return url;
}

async function readResponseBody(response, budget) {
  if (!response.body || typeof response.body.getReader !== 'function') fail('response_invalid');
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    void response.body.cancel().catch(() => {});
    fail('response_too_large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const result = await budget.wait(() => reader.read());
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        fail('response_too_large');
      }
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('response_invalid');
  }
}

export function createPublicationClient({ fetch, token, budget }) {
  if (typeof fetch !== 'function' || typeof token !== 'string' || token.length === 0
    || !budget || typeof budget.wait !== 'function' || !budget.signal) fail('transport_failed');

  async function request(path, {
    method = 'GET', body, allowNotFound = false, expectedStatus = 200,
  } = {}) {
    const url = apiUrl(path);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      fail('request_too_large');
    }
    let response;
    try {
      response = await budget.wait(() => fetch(url, {
        method,
        redirect: 'manual',
        signal: budget.signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
          ...(serialized === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
      }));
    } catch (error) {
      if (budget.isExpired?.()) throw error;
      fail('transport_failed');
    }
    if (!response || response.redirected === true
      || response.status >= 300 && response.status < 400) {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      fail('redirect_rejected');
    }
    if (allowNotFound && response.status === 404) {
      if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
      return null;
    }
    if (response.status !== expectedStatus) {
      if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
      fail('transport_failed');
    }
    return { status: response.status, data: await readResponseBody(response, budget),
      hasNext: /rel\s*=\s*"?next"?/i.test(response.headers?.get?.('link') ?? '') };
  }

  async function readGraphql(query, variables) {
    const response = await request('/graphql', {
      method: 'POST',
      body: { query, variables },
    });
    const payload = response?.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.hasOwn(payload, 'errors')
      && (!Array.isArray(payload.errors) || payload.errors.length > 0)
      || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      fail('graphql_response_invalid');
    }
    return payload.data;
  }

  return Object.freeze({
    async getPullRequestTemplate(baseSha) {
      if (!validSha1(baseSha)) fail('transport_failed');
      const response = await request(`/repos/${REPOSITORY_FULL_NAME}/contents/.github/PULL_REQUEST_TEMPLATE.md?ref=${baseSha}`);
      return response.data;
    },
    async listPullRequests(branch, page) {
      if (!validBranch(branch) || !Number.isSafeInteger(page) || page < 1 || page > 3) {
        fail('transport_failed');
      }
      const query = new URLSearchParams({ state: 'all', head: `${REPOSITORY_OWNER}:${branch}`,
        per_page: '100', page: String(page) });
      const response = await request(`/repos/${REPOSITORY_FULL_NAME}/pulls?${query}`);
      return { pulls: response.data, hasNext: response.hasNext };
    },
    async createDraftPullRequest(branch, content) {
      if (!validBranch(branch) || typeof content?.title !== 'string'
        || typeof content.body !== 'string') fail('transport_failed');
      // The response is not acknowledgment proof; the publisher always reads remote state.
      await request(`/repos/${REPOSITORY_FULL_NAME}/pulls`, { method: 'POST', expectedStatus: 201,
        body: { title: content.title, body: content.body, head: `${REPOSITORY_OWNER}:${branch}`,
          base: BASE_BRANCH, draft: true } });
    },
    async getRepository() {
      const response = await request(`/repos/${REPOSITORY_FULL_NAME}`);
      return response.data;
    },
    async getRef(branch) {
      if (!validBranch(branch)) fail('transport_failed');
      const response = await request(
        `/repos/${REPOSITORY_FULL_NAME}/git/ref/heads/${branch}`,
        { allowNotFound: true },
      );
      return response?.data ?? null;
    },
    async createRef(branch, sha) {
      if (!validBranch(branch) || !validSha1(sha) || branch === BASE_BRANCH) fail('transport_failed');
      const response = await request(`/repos/${REPOSITORY_FULL_NAME}/git/refs`, {
        method: 'POST',
        expectedStatus: 201,
        body: { ref: `refs/heads/${branch}`, sha },
      });
      return response.data;
    },
    async getCommit(sha) {
      if (!validSha1(sha)) fail('transport_failed');
      const response = await request(`/repos/${REPOSITORY_FULL_NAME}/git/commits/${sha}`);
      return response.data;
    },
    async getTree(sha) {
      if (!validSha1(sha)) fail('transport_failed');
      const response = await request(`/repos/${REPOSITORY_FULL_NAME}/git/trees/${sha}?recursive=1`);
      return response.data;
    },
    async createCommit(branch, expectedHeadSha, intentId, accepted) {
      if (!validBranch(branch) || !validSha1(expectedHeadSha) || !validSha256(intentId)
        || !Array.isArray(accepted) || accepted.length === 0) fail('transport_failed');
      const additions = accepted.map(change => ({
        path: change.path,
        contents: Buffer.from(change.content, 'utf8').toString('base64'),
      }));
      const input = {
        branch: {
          repositoryNameWithOwner: REPOSITORY_FULL_NAME,
          branchName: branch,
        },
        clientMutationId: intentId,
        expectedHeadOid: expectedHeadSha,
        fileChanges: { additions },
        message: { headline: 'Apply approved agent changes' },
      };
      const data = await readGraphql(CREATE_COMMIT_QUERY, { input });
      const payload = data.createCommitOnBranch;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !payload.commit || !validSha1(payload.commit.oid)
        || !payload.ref || typeof payload.ref.name !== 'string'
        || !payload.ref.target || !validSha1(payload.ref.target.oid)) {
        fail('graphql_response_invalid');
      }
      return {
        commitSha: payload.commit.oid,
        refName: qualifiedHeadRef(payload.ref, branch),
        refSha: payload.ref.target.oid,
      };
    },
    async getCommitProof(sha, branch) {
      if (!validSha1(sha) || !validBranch(branch)) fail('transport_failed');
      const data = await readGraphql(COMMIT_PROOF_QUERY, {
        owner: REPOSITORY_OWNER,
        name: REPOSITORY_NAME,
        oid: sha,
        qualifiedRefName: `refs/heads/${branch}`,
      });
      const repository = data.repository;
      const commit = repository?.object;
      const ref = repository?.ref;
      if (!repository || !commit || !ref) fail('graphql_response_invalid');
      const parents = commit.parents?.nodes;
      const signature = commit.signature;
      return {
        repositoryId: repository.databaseId,
        repositoryName: repository.nameWithOwner,
        ref: {
          name: qualifiedHeadRef(ref, branch),
          targetSha: ref.target?.oid,
        },
        commit: {
          oid: commit.oid,
          tree: { oid: commit.tree?.oid },
          parents: Array.isArray(parents) ? parents.map(parent => parent?.oid) : null,
          author: {
            databaseId: commit.author?.user?.databaseId,
            login: commit.author?.user?.login,
          },
          committer: {
            databaseId: commit.committer?.user?.databaseId,
            login: commit.committer?.user?.login,
          },
          signature: {
            isValid: signature?.isValid,
            state: signature?.state,
            wasSignedByGitHub: signature?.wasSignedByGitHub,
          },
        },
      };
    },
  });
}
