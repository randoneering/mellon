import { readBytes } from '../http.mjs';
import { createWaitDeadline } from './store-validation.mjs';
import { SUBMITTED_REVIEW_PROFILE, validQodoIdentity } from './review-contract.mjs';

const API_ROOT = 'https://api.github.com';
const REPOSITORY = 'randoneering/mellon';
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const FULL_SHA = /^[a-f0-9]{40}$/;
const REVIEW_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);
const MAINTAINER_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED']);
const COMMENT_LIMIT = 2000;
class ReviewDeadline extends Error {}

function attention(reason) {
  return { status: 'needs_attention', reason };
}

function unsupported(run) {
  return Date.now() >= run.deadline
    ? attention('review_deadline') : { status: 'waiting', reason: 'unsupported_report' };
}

function validRun(run, repositoryId) {
  return run !== null && typeof run === 'object' && !Array.isArray(run)
    && run.repository === REPOSITORY
    && run.repositoryId === repositoryId
    && Number.isSafeInteger(run.pullNumber) && run.pullNumber > 0
    && typeof run.headSha === 'string' && FULL_SHA.test(run.headSha)
    && Array.isArray(run.qodoIdentities) && run.qodoIdentities.length > 0
    && run.qodoIdentities.length <= 16
    && run.qodoIdentities.every(validQodoIdentity)
    && new Set(run.qodoIdentities.map(identity => identity.userId)).size === run.qodoIdentities.length
    && (run.requireDraft === undefined || typeof run.requireDraft === 'boolean')
    && Number.isSafeInteger(run.deadline);
}

async function requestJson(fetch, token, url, deadline) {
  const budget = createWaitDeadline(REQUEST_TIMEOUT_MS, deadline);
  try {
    const response = await budget.wait(async () => {
      const value = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error', signal: budget.signal,
      });
      if (budget.signal.aborted) {
        try { Promise.resolve(value?.body?.cancel()).catch(() => {}); } catch {}
        throw new Error('deadline');
      }
      return value;
    });
    if (!response.ok || response.redirected || (response.url && response.url !== url)
      || response.headers.get('link')?.includes('rel="next"')) throw new Error('request');
    const bytes = await budget.wait(() => readBytes(response.body, RESPONSE_LIMIT,
      Math.max(1, budget.deadline - Date.now())));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    budget.check();
    return value;
  } catch (error) {
    // A timer may abort just before the wall clock reaches its absolute deadline.
    if (budget.deadline === deadline && budget.isExpired()) throw new ReviewDeadline();
    throw error;
  } finally { budget.close(); }
}

function escapedText(value) {
  let output = '';
  let bytes = 0;
  let characters = 0;
  for (const char of value) {
    if (characters++ >= COMMENT_LIMIT) break;
    const escaped = /[<>&\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(char)
      ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char;
    const length = Buffer.byteLength(escaped);
    if (bytes + length > 4000) break;
    output += escaped;
    bytes += length;
  }
  return output;
}

function trustedActor(user, identities) {
  return user?.type === 'Bot' && identities.some(identity => identity.userId === user.id);
}

function sourceFinding(comment, review, headSha, pullUrl) {
  if (!Number.isSafeInteger(comment?.id) || comment.id < 1
      || comment.pull_request_review_id !== review.id
      || comment.user?.id !== review.user.id || comment.user?.type !== 'Bot'
      || comment.commit_id !== headSha || !FULL_SHA.test(comment.commit_id ?? '')
      || (pullUrl !== undefined && comment.pull_request_url !== pullUrl)) {
    throw new Error(comment?.commit_id !== headSha ? 'stale' : 'invalid');
  }
  const line = comment.line;
  if (typeof comment.path !== 'string' || comment.path.length < 1 || comment.path.length > 512
      || comment.path.startsWith('/') || comment.path.split('/').includes('..')
      || !Number.isSafeInteger(line) || line < 1 || comment.side !== 'RIGHT'
      || typeof comment.body !== 'string' || !comment.body.length) throw new Error('invalid');
  return { reviewId: review.id, commentId: comment.id, commitSha: headSha,
    path: comment.path, line, body: escapedText(comment.body) };
}

export function createReviewReader({ token, repositoryId, fetch = globalThis.fetch }) {
  return {
    async readMaintainerReview(run) {
      try { run = structuredClone(run); } catch { return attention('invalid_binding'); }
      if (typeof token !== 'string' || !token || typeof fetch !== 'function'
          || !Number.isSafeInteger(repositoryId) || repositoryId < 1
          || run?.repository !== REPOSITORY || run.repositoryId !== repositoryId
          || !Number.isSafeInteger(run.pullNumber) || run.pullNumber < 1
          || !FULL_SHA.test(run.headSha ?? '') || !Number.isSafeInteger(run.deadline)
          || !Number.isSafeInteger(run.approver?.id) || run.approver.id < 1
          || typeof run.approver.login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(run.approver.login)
          || !Number.isSafeInteger(run.workerActor?.databaseId) || run.workerActor.databaseId < 1
          || typeof run.workerActor.login !== 'string' || !run.workerActor.login.length
          || run.approver.id === run.workerActor.databaseId) return attention('invalid_binding');
      const root = `${API_ROOT}/repos/${REPOSITORY}/pulls/${run.pullNumber}`;
      const permissionUrl = `${API_ROOT}/repos/${REPOSITORY}/collaborators/${encodeURIComponent(run.approver.login)}/permission`;
      try {
        const first = await requestJson(fetch, token, root, run.deadline);
        if (first.number !== run.pullNumber || first.base?.repo?.id !== repositoryId
            || first.head?.sha !== run.headSha || first.state !== 'open' || first.draft !== true
            || first.user?.id !== run.workerActor.databaseId
            || first.user?.id === run.approver.id || first.user?.type !== 'Bot'
            || first.user?.login?.toLowerCase() !== run.workerActor.login.toLowerCase()) return attention('pull_request_binding_mismatch');
        const [permission, reviews] = await Promise.all([
          requestJson(fetch, token, permissionUrl, run.deadline),
          requestJson(fetch, token, `${root}/reviews?per_page=100&page=1`, run.deadline),
        ]);
        if (!permission?.user || permission.user.id !== run.approver.id
            || permission.user.type !== 'User'
            || permission.user.login?.toLowerCase() !== run.approver.login.toLowerCase()
            || !['write', 'maintain', 'admin'].includes(permission.permission)) return attention('maintainer_permission_invalid');
        if (!Array.isArray(reviews) || reviews.length >= 100) return attention('review_report_incomplete');
        const relevant = reviews.filter(item => item?.user?.id === run.approver.id);
        if (relevant.some(item => item.user.type !== 'User'
            || item.user.login?.toLowerCase() !== run.approver.login.toLowerCase()
            || !Number.isSafeInteger(item.id) || item.id < 1
            || !MAINTAINER_REVIEW_STATES.has(item.state)
            || !FULL_SHA.test(item.commit_id ?? '')
            || item.pull_request_url !== root
            || typeof item.submitted_at !== 'string' || !Number.isFinite(Date.parse(item.submitted_at))
            || Date.parse(item.submitted_at) > Date.now() + 60000)
            || new Set(relevant.map(item => item.id)).size !== relevant.length) {
          return attention('maintainer_review_invalid');
        }
        const current = relevant.filter(item => item.commit_id === run.headSha && item.state !== 'COMMENTED')
          .sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at));
        const last = current.at(-1);
        // Neutral comments do not change a decision; ambiguous concurrent decisions block.
        const latest = last ? current.filter(item => Date.parse(item.submitted_at) === Date.parse(last.submitted_at)) : [];
        const second = await requestJson(fetch, token, root, run.deadline);
        if (second.number !== run.pullNumber || second.base?.repo?.id !== repositoryId
            || second.head?.sha !== run.headSha || second.state !== 'open' || second.draft !== true
            || second.user?.id !== first.user.id || second.user?.type !== 'Bot'
            || second.user?.login?.toLowerCase() !== first.user.login.toLowerCase()) {
          return attention('pull_request_binding_changed');
        }
        if (!last || latest.some(item => item.state !== 'APPROVED')) return { status: 'waiting', reason: 'maintainer_review_absent' };
        return { status: 'approved', reviewId: last.id, headSha: last.commit_id,
          reviewerId: run.approver.id, reviewerLogin: run.approver.login };
      } catch (error) {
        return error instanceof ReviewDeadline || Date.now() >= run.deadline
          ? attention('review_deadline') : attention('github_read_failed');
      }
    },
    async readReview(run) {
      try { run = structuredClone(run); } catch { return attention('invalid_binding'); }
      if (typeof token !== 'string' || token.length === 0 || typeof fetch !== 'function'
          || !Number.isSafeInteger(repositoryId) || repositoryId < 1
          || !validRun(run, repositoryId)) return attention('invalid_binding');

      const pullUrl = `${API_ROOT}/repos/${REPOSITORY}/pulls/${run.pullNumber}`;
      const reviewsUrl = `${pullUrl}/reviews?per_page=100&page=1`;
      const commentsUrl = `${pullUrl}/comments?per_page=100&page=1`;
      const profiles = run.qodoIdentities.filter(identity => identity.completion === SUBMITTED_REVIEW_PROFILE);
      let pull;
      let reviews;
      let comments;
      try {
        pull = await requestJson(fetch, token, pullUrl, run.deadline);
        if (pull.number !== run.pullNumber || pull.base?.repo?.id !== repositoryId
            || !FULL_SHA.test(pull.head?.sha ?? '') || pull.head.sha !== run.headSha) {
          return attention('head_mismatch');
        }
        if (typeof pull.draft !== 'boolean') return unsupported(run);
        if (run.requireDraft === true && pull.draft !== true) return attention('draft_state_changed');
        if (pull.state !== 'open') return attention('pull_request_not_open');
        [reviews, comments] = await Promise.all([
          requestJson(fetch, token, reviewsUrl, run.deadline),
          requestJson(fetch, token, commentsUrl, run.deadline),
        ]);
      } catch (error) {
        return error instanceof ReviewDeadline || Date.now() >= run.deadline
          ? attention('review_deadline')
          : attention('github_read_failed');
      }

      if (!Array.isArray(reviews) || reviews.length >= 100 || !Array.isArray(comments)
          || comments.length >= 100) return unsupported(run);
      const trusted = reviews.filter(review => trustedActor(review?.user, run.qodoIdentities));
      const spoofedLogin = reviews.some(review => {
        const configuredId = run.qodoIdentities.some(identity => identity.userId === review?.user?.id);
        const qodoLogin = typeof review?.user?.login === 'string'
          && /qodo.*\[bot\]$/i.test(review.user.login);
        return (qodoLogin && !configuredId) || (configuredId && review?.user?.type !== 'Bot');
      });
      if (spoofedLogin) return attention('bot_identity_mismatch');
      if (trusted.length === 0) return { status: 'waiting',
        reason: pull.draft ? 'draft_review_absent' : 'review_absent' };
      if (trusted.some(review => !FULL_SHA.test(review.commit_id ?? ''))) return unsupported(run);
      const current = trusted.filter(review => review.commit_id === run.headSha);
      if (current.length === 0) return Date.now() >= run.deadline
        ? attention('review_deadline') : { status: 'waiting', reason: 'stale_review' };
      if (current.some(review => !Number.isSafeInteger(review.id) || review.id < 1
          || !REVIEW_STATES.has(review.state))
          || new Set(current.map(review => review.id)).size !== current.length) return unsupported(run);

      const verifiedUsers = new Set();
      if (profiles.length) {
        try {
          for (const identity of profiles) {
            const [app, bot] = await Promise.all([
              requestJson(fetch, token, `${API_ROOT}/apps/${identity.appSlug}`, run.deadline),
              requestJson(fetch, token, `${API_ROOT}/users/${encodeURIComponent(`${identity.appSlug}[bot]`)}`, run.deadline),
            ]);
            if (app?.id !== identity.appId || app.slug !== identity.appSlug
              || bot?.id !== identity.userId || bot.type !== 'Bot'
              || typeof bot.login !== 'string'
              || bot.login.toLowerCase() !== `${identity.appSlug}[bot]`) {
              return attention('bot_identity_mismatch');
            }
            verifiedUsers.add(identity.userId);
          }
        } catch (error) {
          return error instanceof ReviewDeadline || Date.now() >= run.deadline
            ? attention('review_deadline') : attention('github_read_failed');
        }
        if (current.some(review => !verifiedUsers.has(review.user.id)
          || review.pull_request_url !== pullUrl || typeof review.body !== 'string'
          || review.body.trim() !== '' || typeof review.submitted_at !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(review.submitted_at)
          || !Number.isFinite(Date.parse(review.submitted_at))
          || Date.parse(review.submitted_at) > Date.now() + 60000)) return unsupported(run);
      }
      const trustedIds = new Map(current.map(review => [review.id, review]));
      if (profiles.length && comments.some(comment => verifiedUsers.has(comment?.user?.id)
        && comment.commit_id === run.headSha && !trustedIds.has(comment.pull_request_review_id))) {
        return unsupported(run);
      }
      const relevantComments = comments.filter(comment => trustedIds.has(comment?.pull_request_review_id));
      const findings = [];
      try {
        for (const comment of relevantComments) {
          const review = trustedIds.get(comment.pull_request_review_id);
          if (!trustedActor(comment.user, run.qodoIdentities)) return attention('bot_identity_mismatch');
          findings.push(sourceFinding(comment, review, run.headSha, profiles.length ? pullUrl : undefined));
        }
      } catch (error) {
        return error.message === 'stale' ? attention('stale_review') : unsupported(run);
      }
      if (Date.now() >= run.deadline) return attention('review_deadline');
      if (profiles.length) {
        if (findings.length > 64 || (findings.length === 0
          && current.some(review => review.state === 'CHANGES_REQUESTED'))) return unsupported(run);
        // This is the approved GitHub publication boundary, not vendor-wide completion.
        return { status: 'complete', authenticated: true, repository: run.repository,
          repositoryId: run.repositoryId, pullNumber: run.pullNumber, headSha: run.headSha,
          draft: pull.draft, state: pull.state, reviewId: Math.max(...current.map(review => review.id)), findings };
      }
      if (findings.length) return { status: 'findings', authenticated: true, repository: run.repository,
        repositoryId: run.repositoryId, pullNumber: run.pullNumber, headSha: run.headSha,
        draft: pull.draft, state: pull.state, findings };
      return unsupported(run);
    },
  };
}
