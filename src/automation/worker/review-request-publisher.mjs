import { createHash } from 'node:crypto';
import { validatePublicationContext } from './publication-validation.mjs';
import { createWaitDeadline } from './store-validation.mjs';
import { readBytes } from '../http.mjs';

const ROOT = 'https://api.github.com';
const BODY = '/agentic_review';
const REPOSITORY = 'randoneering/mellon';
const RESPONSE_LIMIT = 64 * 1024;
const SHA1 = /^[a-f0-9]{40}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

function enabled(policy) {
  return policy?.version === 1 && policy.profile === 'worker-command-maintainer-fallback-v1'
    && Object.keys(policy).length === 2;
}

export function reviewRequestIdentity(run, workerActor, appId) {
  return hash({ version: 1, runId: run.runId, repositoryId: run.repositoryId,
    repositoryFullName: run.repositoryFullName, pullRequestNumber: run.pullRequestNumber,
    headSha: run.expectedHeadSha, workerActor, appId, body: BODY });
}

export function createTrustedReviewRequestPublisher(dependencies = {}) {
  const { getPullRequestContext, fetch = globalThis.fetch } = dependencies;

  async function dispatch(input) {
    if (!enabled(input?.reviewPolicy)) return { status: 'disabled' };
    const { run, lease, workerActor, deadline, store, database, checkApproval,
      checkFence, expectedWorkerActor } = input;
    if (!run || !lease || !store || typeof database !== 'function'
      || typeof checkApproval !== 'function' || typeof checkFence !== 'function'
      || typeof fetch !== 'function' || typeof getPullRequestContext !== 'function'
      || run.repositoryFullName !== REPOSITORY || !positive(run.repositoryId)
      || !positive(run.pullRequestNumber) || !SHA1.test(run.expectedHeadSha ?? '')
      || !/^[a-f0-9-]{36}$/.test(run.runId ?? '') || run.branchName !== `agent-work/${run.runId}`
      || !Number.isSafeInteger(deadline) || deadline <= Date.now()
      || !workerActor || workerActor.databaseId !== expectedWorkerActor?.databaseId
      || workerActor.login?.toLowerCase() !== expectedWorkerActor?.login?.toLowerCase()) {
      return { status: 'needs_attention', category: 'review_binding_invalid' };
    }
    const fixed = (status, category, metadata = {}) => ({ status, category,
      ...(metadata.commentId ? { commentId: metadata.commentId } : {}) });
    const budget = createWaitDeadline(45000, deadline);
    let confirmedCommentId;
    try {
      await budget.wait(checkApproval);
      await budget.wait(checkFence);
      const context = await budget.wait(() => getPullRequestContext({ runId: run.runId,
        repositoryId: run.repositoryId, repositoryName: run.repositoryFullName,
        branch: run.branchName, deadline, signal: budget.signal }));
      if (!context || !context.publicationContext || !context.installationToken) {
        return fixed('needs_attention', 'review_context_unavailable');
      }
      const publication = validatePublicationContext(context.publicationContext, run);
      const capability = context.installationToken;
      if (!positive(publication.appId)) return fixed('needs_attention', 'review_context_invalid');
      const appId = publication.appId;
      const identitySha256 = reviewRequestIdentity(run, workerActor, appId);
      const base = { headSha: run.expectedHeadSha, identitySha256, actorId: workerActor.databaseId,
        actorLogin: workerActor.login, appId, pullRequestNumber: run.pullRequestNumber };
      if (capability.repositoryId !== run.repositoryId || capability.repositoryName !== REPOSITORY
        || capability.appId !== publication.appId || capability.installationId !== publication.installationId
        || capability.tokenSha256 !== createHash('sha256').update(publication.token).digest('hex')
        || capability.tokenExpiresAt !== publication.tokenExpiresAt
        || !capability.permissions || Object.keys(capability.permissions).length !== 3
        || capability.permissions?.pull_requests !== 'write'
        || capability.permissions?.metadata !== 'read'
        || capability.permissions?.contents !== 'read') {
        return fixed('needs_attention', 'review_context_invalid');
      }
      const callApi = async (path, options = {}) => {
        if (Date.now() >= deadline || Date.parse(publication.contextExpiresAt) <= Date.now()) {
          throw new Error('expired');
        }
        const response = await budget.wait(() => fetch(`${ROOT}${path}`, { method: options.method ?? 'GET',
          redirect: 'manual', headers: { accept: 'application/vnd.github+json',
            authorization: `Bearer ${publication.token}`, 'x-github-api-version': '2022-11-28',
            ...(options.body ? { 'content-type': 'application/json' } : {}) },
          signal: budget.signal,
          ...(options.body ? { body: JSON.stringify(options.body) } : {}) }));
        if (!response || response.redirected || response.status >= 300 && response.status < 400) {
          throw new Error('transport');
        }
        if (options.expected && response.status !== options.expected) throw new Error('transport');
        if (!options.expected && !response.ok) throw new Error('transport');
        if (response.status === 204) return null;
        if (response.url && response.url !== `${ROOT}${path}` || response.headers?.get('link')?.includes('rel="next"')) throw new Error('response');
        const bytes = await budget.wait(() => readBytes(response.body, RESPONSE_LIMIT,
          Math.max(1, deadline - Date.now())));
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('response'); }
      };
      const basePath = `/repos/${REPOSITORY}`;
      const pr = await callApi(`${basePath}/pulls/${run.pullRequestNumber}`);
      if (pr?.number !== run.pullRequestNumber || pr.base?.repo?.id !== run.repositoryId
        || pr.base?.ref !== 'main' || pr.base?.repo?.full_name !== REPOSITORY
        || pr.head?.repo?.full_name !== REPOSITORY
        || pr.head?.repo?.id !== run.repositoryId || pr.head?.sha !== run.expectedHeadSha
        || pr.head?.ref !== run.branchName || pr.state !== 'open' || pr.draft !== true
        || pr.user?.id !== workerActor.databaseId || pr.user?.type !== 'Bot'
        || pr.user?.login?.toLowerCase() !== workerActor.login.toLowerCase()
        || publication.actor.databaseId !== workerActor.databaseId
        || publication.actor.login.toLowerCase() !== workerActor.login.toLowerCase()) {
        return fixed('needs_attention', 'review_pull_request_mismatch');
      }
      const commit = await callApi(`${basePath}/commits/${run.expectedHeadSha}`);
      if (commit?.sha !== run.expectedHeadSha || commit.author?.id !== workerActor.databaseId
        || commit.author?.login?.toLowerCase() !== workerActor.login.toLowerCase()
        || commit.commit?.verification?.verified !== true) {
        return fixed('needs_attention', 'review_commit_mismatch');
      }
      const prior = await database(options => store.getReviewRequest(lease, run.expectedHeadSha, options));
      if (prior && (prior.identitySha256 !== identitySha256 || prior.appId !== appId
        || prior.actorId !== workerActor.databaseId || prior.actorLogin !== workerActor.login
        || prior.pullRequestNumber !== run.pullRequestNumber)) return fixed('needs_attention', 'review_binding_invalid');
      if (prior?.commentId) {
        const comment = await callApi(`${basePath}/issues/comments/${prior.commentId}`);
        if (!sameComment(comment, prior, run, workerActor, publication.appId)) {
          return fixed('needs_attention', 'review_confirmation_mismatch', prior);
        }
        confirmedCommentId = prior.commentId;
        await budget.wait(checkApproval);
        await budget.wait(checkFence);
        const after = await callApi(`${basePath}/pulls/${run.pullRequestNumber}`);
        if (!samePull(after, pr)) return fixed('needs_attention', 'review_head_changed', prior);
        return { status: 'confirmed', commentId: prior.commentId, alreadyConfirmed: true,
          identitySha256, appId };
      }
      if (prior?.attempted) return fixed('needs_attention', 'review_write_uncertain');
      const intent = await database(options => store.reserveReviewRequest(lease, base, options));
      if (!intent) return fixed('needs_attention', 'review_lease_lost');
      await budget.wait(checkApproval);
      await budget.wait(checkFence);
      const current = await callApi(`${basePath}/pulls/${run.pullRequestNumber}`);
      if (!samePull(current, pr)) return fixed('needs_attention', 'review_head_changed');
      const attempt = await database(options => store.attemptReviewRequest(lease, base, options));
      if (!attempt?.canExecute) return fixed('needs_attention', 'review_write_uncertain');
      let comment;
      try {
        comment = await callApi(`${basePath}/issues/${run.pullRequestNumber}/comments`,
          { method: 'POST', expected: 201, body: { body: BODY } });
      } catch { return fixed('needs_attention', 'review_write_uncertain'); }
      if (!sameComment(comment, attempt, run, workerActor, publication.appId)) {
        return fixed('needs_attention', 'review_confirmation_mismatch');
      }
      confirmedCommentId = comment.id;
      const confirmed = await database(options => store.confirmReviewRequest(lease,
        { ...base, commentId: comment.id }, options));
      if (!confirmed) return fixed('needs_attention', 'review_lease_lost', { commentId: comment.id });
      await budget.wait(checkApproval);
      await budget.wait(checkFence);
      const after = await callApi(`${basePath}/pulls/${run.pullRequestNumber}`);
      if (!samePull(after, pr)) {
        return fixed('needs_attention', 'review_head_changed', { commentId: comment.id });
      }
      return { status: 'confirmed', commentId: comment.id, alreadyConfirmed: false,
        identitySha256, appId };
    } catch {
      return fixed('needs_attention', budget.isExpired() ? 'review_deadline' : 'review_dispatch_failed',
        { commentId: confirmedCommentId });
    } finally { budget.close(); }
  }
  return Object.freeze({ dispatch });
}

function samePull(candidate, expected) {
  return candidate?.number === expected.number && candidate.state === 'open' && candidate.draft === true
    && candidate.head?.sha === expected.head.sha && candidate.head?.ref === expected.head.ref
    && candidate.head?.repo?.id === expected.head.repo.id && candidate.head.repo.full_name === expected.head.repo.full_name
    && candidate.base?.ref === expected.base.ref && candidate.base?.repo?.id === expected.base.repo.id
    && candidate.base.repo.full_name === expected.base.repo.full_name
    && candidate.user?.type === 'Bot' && candidate.user?.id === expected.user.id
    && candidate.user?.login?.toLowerCase() === expected.user.login.toLowerCase();
}

function sameComment(comment, request, run, actor, appId) {
  return positive(comment?.id) && comment.body === BODY
    && comment.issue_url === `${ROOT}/repos/${run.repositoryFullName}/issues/${run.pullRequestNumber}`
    && comment.user?.id === actor.databaseId && comment.user?.type === 'Bot'
    && comment.user?.login?.toLowerCase() === actor.login.toLowerCase()
    && comment.performed_via_github_app?.id === appId
    && comment.id === (request.commentId ?? comment.id);
}
