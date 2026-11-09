import { createHash } from 'node:crypto';
import { createTrustedReviewRequestPublisher } from '../../src/automation/worker/review-request-publisher.mjs';

export function reviewRequestFixture() {
  const now = Date.now(), actor = { databaseId: 19, login: 'worker[bot]' };
  const runId = '00000000-0000-4000-8000-000000000001', sha = 'a'.repeat(40);
  const repo = { id: 7, full_name: 'randoneering/mellon' };
  const run = { runId, repositoryId: 7, repositoryFullName: repo.full_name,
    pullRequestNumber: 12, expectedHeadSha: sha, baseRevision: 'b'.repeat(40), branchName: `agent-work/${runId}` };
  const context = { token: 'synthetic-review-token', tokenExpiresAt: new Date(now + 3600000).toISOString(),
    contextExpiresAt: new Date(now + 240000).toISOString(), repositoryId: 7,
    repositoryName: repo.full_name, appId: 23, installationId: 29, actor,
    signingPreflight: { repositoryId: 7, repositoryName: repo.full_name, appId: 23, installationId: 29,
      expiresAt: new Date(now + 180000).toISOString(), commit: { oid: 'c'.repeat(40), author: actor,
        committer: { name: 'GitHub', email: 'noreply@github.com' },
        signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true } } } };
  const state = { posts: 0, stored: null, calls: [], sequence: [], postFailure: false,
    permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' },
    pr: { number: 12, base: { repo, ref: 'main', sha: run.baseRevision },
      head: { repo, ref: run.branchName, sha, label: `randoneering:${run.branchName}` },
      user: { id: actor.databaseId, login: actor.login, type: 'Bot' }, state: 'open', draft: true },
    commit: { sha, author: { id: actor.databaseId, login: actor.login, type: 'Bot' },
      commit: { committer: { name: 'GitHub', email: 'noreply@github.com' }, verification: { verified: true, reason: 'valid' } } },
    comment: { id: 99, body: '/agentic_review', issue_url: `https://api.github.com/repos/${repo.full_name}/issues/12`,
      user: { id: actor.databaseId, login: actor.login, type: 'Bot' }, performed_via_github_app: { id: 23 } } };
  const store = {
    async getReviewRequest() { return state.stored; },
    async reserveReviewRequest(_lease, input) { state.sequence.push('intent');
      state.stored ??= { ...input, attempted: false }; return state.stored; },
    async attemptReviewRequest(_lease, input) { state.sequence.push('attempt');
      if (state.stored.attempted) return { ...state.stored, canExecute: false };
      state.stored = { ...input, attempted: true }; return { ...state.stored, canExecute: true }; },
    async confirmReviewRequest(_lease, input) { state.sequence.push('confirm'); state.stored = { ...state.stored, ...input }; return state.stored; },
  };
  const fetch = async (url, options = {}) => {
    state.calls.push(String(url));
    if (String(url).endsWith('/pulls/12')) return Response.json(state.pr);
    if (String(url).endsWith(`/commits/${sha}`)) return Response.json(state.commit);
    if (String(url).endsWith('/issues/comments/99')) return Response.json(state.comment);
    if (String(url).endsWith('/issues/12/comments') && options.method === 'POST') {
      state.posts++; state.sequence.push('post');
      if (state.postFailure) throw new Error('private synthetic transport response');
      if (state.onPost) return state.onPost(options);
      return Response.json(state.comment, { status: 201 });
    }
    throw new Error('Unexpected fixed resource');
  };
  const publisher = createTrustedReviewRequestPublisher({ fetch, getPullRequestContext: async () => ({
    publicationContext: context, installationToken: { repositoryId: 7, repositoryName: repo.full_name,
      appId: 23, installationId: 29, tokenExpiresAt: context.tokenExpiresAt,
      tokenSha256: createHash('sha256').update(context.token).digest('hex'),
      permissions: state.permissions },
  }) });
  const input = { reviewPolicy: { version: 1, profile: 'worker-command-maintainer-fallback-v1' },
    run, lease: {}, workerActor: actor, expectedWorkerActor: actor, deadline: now + 10000,
    store, database: operation => operation({}), checkApproval: async () => {}, checkFence: async () => {} };
  return { state, context, input, store, publisher };
}
