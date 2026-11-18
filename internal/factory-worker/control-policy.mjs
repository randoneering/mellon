import { timingSafeEqual } from 'node:crypto';

const ERROR = 'Factory controller input rejected.';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATUSES = new Set(['idle', 'queued', 'starting', 'running', 'working', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
function reject() { throw new Error(ERROR); }

export function authorizedControlRequest(header, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256
      || typeof header !== 'string' || header.length !== secret.length + 7) return false;
  const supplied = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Changes that never reach the bundled Action, so no dist rebuild is needed.
// src/personalized/ is a separate CLI and is not imported by src/action.mjs.
export const NO_REBUILD_PATH = /^(?:tests\/(?:unit|integration)\/[A-Za-z0-9_-]+\.test\.mjs|docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md|README\.md|src\/personalized\/[A-Za-z0-9_-]+\.mjs)$/;

// Action runtime source and its test fixtures: these change the bundled dist/ and
// go through the isolated runner. Tooling, detector code and generated files never do.
export const REBUILD_PATH = /^(?:action\.yml|src\/[A-Za-z0-9_-]+\.mjs|tests\/fixtures\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:mjs|json|txt))$/;
export const requiresRebuild = paths => paths.some(path => REBUILD_PATH.test(path));

export function validateControlJob(value, config) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['jobId', 'issueNumber', 'baseSha', 'planSha256', 'task', 'allowedPaths', 'requiresRebuild'].includes(k))
      || !UUID.test(value.jobId ?? '') || !Number.isSafeInteger(value.issueNumber) || value.issueNumber < 1
      || (config.issueNumber !== undefined && value.issueNumber !== config.issueNumber)
      || !/^[a-f0-9]{40}$/.test(value.baseSha ?? '') || (config.baseSha !== undefined && value.baseSha !== config.baseSha)
      || !Array.isArray(value.allowedPaths) || !value.allowedPaths.length || value.allowedPaths.length > 10
      || new Set(value.allowedPaths).size !== value.allowedPaths.length
      || value.allowedPaths.some(path => typeof path !== 'string' || !(NO_REBUILD_PATH.test(path) || REBUILD_PATH.test(path)))
      // The declared flag must match the paths, so a rebuild job cannot skip the runner.
      || (value.requiresRebuild !== undefined && typeof value.requiresRebuild !== 'boolean')
      || (value.requiresRebuild === true) !== requiresRebuild(value.allowedPaths)
      || !/^[a-f0-9]{64}$/.test(value.planSha256 ?? '')
      || typeof value.task !== 'string' || !value.task.trim() || value.task.includes('\0')
      || Buffer.byteLength(value.task, 'utf8') > 32768) reject();
  return {
    jobId: value.jobId, issueNumber: value.issueNumber, baseSha: value.baseSha,
    planSha256: value.planSha256, task: value.task, allowedPaths: [...value.allowedPaths],
    // Emitted only when true, so existing no-rebuild journal digests stay valid.
    ...(value.requiresRebuild === true ? { requiresRebuild: true } : {}),
  };
}

export function safeThreadState(value, threadId, config) {
  const thread = value?.thread;
  if (!thread || thread.threadId !== threadId || thread.projectId !== config.projectId
      || thread.providerInstanceId !== 'pi' || thread.model !== config.model
      || !STATUSES.has(thread.status)) reject();
  const run = Array.isArray(value.recentRuns)
    ? value.recentRuns.find(r => r.runId === thread.latestRunId) : undefined;
  return {
    threadId, status: thread.status, provider: 'pi', model: config.model,
    activeRunId: typeof thread.activeRunId === 'string' ? thread.activeRunId : null,
    latestRunId: typeof thread.latestRunId === 'string' ? thread.latestRunId : null,
    pendingRequests: Number.isSafeInteger(thread.pendingRequestCount) ? thread.pendingRequestCount : null,
    runCount: Number.isSafeInteger(thread.runCount) ? thread.runCount : null,
    // T3 0.1.5's CLI show omits recentRuns; then the thread's own state decides.
    // The controller separately requires latestRunId to equal the bound run.
    complete: thread.status === 'completed' && thread.activeRunId === null
      && thread.pendingRequestCount === 0 && typeof thread.latestRunId === 'string'
      && (value.recentRuns === undefined ? true : run?.status === 'completed'),
    terminalFailure: ['failed', 'cancelled', 'interrupted', 'rolled_back'].includes(thread.status),
    link: typeof thread.link === 'string' && /^https?:\/\//.test(thread.link) ? thread.link : null,
  };
}

const RATINGS = new Set(['low', 'medium', 'high', 'critical', 'invalid']);

// An owner assessment must rate every open finding exactly once. Approval follows
// the review gate: every finding Low, or Invalid with a reason. A send-back names
// at least one finding to return to the worker.
export function validateAssessment(value, job, nowIso) {
  const open = (job.review?.findings ?? []).map(f => f.id);
  if (!value || typeof value !== 'object' || !['approve', 'fix'].includes(value.decision)
      || !Array.isArray(value.findings) || value.findings.length !== open.length || !open.length) {
    return { error: 'assessment_incomplete' };
  }
  const seen = new Set();
  const findings = [];
  for (const entry of value.findings) {
    const id = entry?.id;
    const note = typeof entry?.note === 'string' ? entry.note.trim().slice(0, 1000) : '';
    if (!open.includes(id) || seen.has(id) || !RATINGS.has(entry.rating)
        || (entry.fix !== undefined && typeof entry.fix !== 'boolean')
        || (entry.note !== undefined && typeof entry.note !== 'string')) return { error: 'assessment_incomplete' };
    seen.add(id);
    findings.push({ id, rating: entry.rating, note, fix: entry.fix === true });
  }
  if (value.decision === 'approve' && findings.some(f => f.fix || !(f.rating === 'low' || (f.rating === 'invalid' && f.note)))) {
    return { error: 'assessment_blocks_publication' };
  }
  if (value.decision === 'fix' && !findings.some(f => f.fix && f.rating !== 'invalid')) return { error: 'assessment_names_no_fix' };
  return { assessment: { decision: value.decision, reviewRunId: job.review.reviewRunId, candidateDigest: job.candidate.digest, assessedAt: nowIso, findings } };
}

const SECRET_TEXT = /-----BEGIN[^\r\n]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;

// PR title and summary written by the worker are untrusted; anything off-shape
// falls back to a fixed title so a good candidate is not lost over metadata.
export function proposalMetadata(meta, issueNumber) {
  const title = meta?.title;
  const summary = meta?.summary;
  if (typeof title === 'string' && /^(?:feat|fix|test|docs|refactor|perf|chore)\([a-z0-9-]{1,30}\): [^\x00-\x1f\x7f]{3,90}$/.test(title)
      && typeof summary === 'string' && summary.trim() && summary.length <= 4000 && !/[\x00\x1b]/.test(summary)
      && !SECRET_TEXT.test(title) && !SECRET_TEXT.test(summary)) return { title, summary: summary.trim(), source: 'worker' };
  return { title: `chore(factory): address issue #${issueNumber}`, summary: `Changes for issue #${issueNumber}. See the linked issue and its saved plan.`, source: 'fallback' };
}
