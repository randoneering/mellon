import { createEligibleContinuation } from './inputs.mjs';
import { OUTCOME_LABELS } from './github.mjs';
import { prepareSubmission } from './prepare.mjs';

export const CUTOFF = 0.8;
const REVIEW_LABEL = 'mellon: review';
export const DEFAULT_RESPONSE = "AI-assisted code is welcome. Please describe your work in your own words. This automated review can make mistakes. If this submission does not meet the repository's contribution policy, maintainers may close it. Contact a maintainer if you need help.";
const PROTOCOL = 'mellon-submission-moderation-v1';

function safeFailure(message, state = {}) {
  const { commentPosted, uncertain, ...metadata } = state;
  return { outcome: 'error', cutoff: CUTOFF, partial: commentPosted === true, uncertainty: uncertain === true, ...metadata, error: message };
}

function validClassification(result) {
  return result && result.protocol_version === 1 && result.outcome === 'classified' && Number.isFinite(result.robot_score) &&
    result.robot_score >= 0 && result.robot_score <= 1 && typeof result.detector_revision === 'string' &&
    /^[a-f0-9]{40}$/.test(result.detector_revision) && /^[a-f0-9]{64}$/.test(result.model_sha256) &&
    /^[a-f0-9]{64}$/.test(result.input_sha256);
}

function markerFor(context, result) {
  return `<!-- ${PROTOCOL} repo=${context.repository} item=${context.number} input=${result.input_sha256} detector=${result.detector_revision} model=${result.model_sha256} -->`;
}

function genuine(comment, marker) {
  return Number.isSafeInteger(comment.id) && comment.id > 0 && comment.user?.login === 'github-actions[bot]' && comment.user?.type === 'Bot' && comment.body.includes(marker);
}

async function currentItem(api, context) {
  const current = await api.getItem(context);
  if (!current || typeof current !== 'object' || !['open', 'closed'].includes(current.state) ||
      typeof current.title !== 'string' || current.body !== null && typeof current.body !== 'string' ||
      current.merged !== undefined && typeof current.merged !== 'boolean' ||
      current.labels !== undefined && (!Array.isArray(current.labels) || current.labels.some(label =>
        !label || typeof label !== 'object' || typeof label.name !== 'string'))) throw new Error('Current item response is invalid.');
  return current;
}

async function currentMatches(api, context) {
  const current = await currentItem(api, context);
  return current.state === 'open' && current.merged !== true && current.title === context.title && current.body === context.body;
}

async function hasReviewLabel(api, context) {
  const labels = await api.getItemLabels(context);
  if (!Array.isArray(labels) || labels.some(label => !label || typeof label !== 'object' || typeof label.name !== 'string')) {
    throw new Error('Current label response is invalid.');
  }
  return labels.some(label => label.name === REVIEW_LABEL);
}

async function hasOutcomeLabel(api, context) {
  const labels = await api.getItemLabels(context);
  if (!Array.isArray(labels) || labels.some(label => !label || typeof label !== 'object' || typeof label.name !== 'string')) {
    throw new Error('Current label response is invalid.');
  }
  const outcomeNames = new Set(OUTCOME_LABELS.map(({ name }) => name));
  return labels.some(label => outcomeNames.has(label.name.toLowerCase()));
}

async function checkBeforeLabelWrite(api, context) {
  if (!await currentMatches(api, context)) return { stale: true };
  if (await hasOutcomeLabel(api, context)) return { completed: true };
  return { stale: false };
}

const LABEL_WRITE_ATTEMPTS = 3;
const LABEL_RETRY_DELAY_MS = 25;

function retryableLabelFailure(error) {
  return !Number.isInteger(error?.status) || error.status >= 500;
}

function labelRetryDelay() {
  return new Promise(resolve => setTimeout(resolve, LABEL_RETRY_DELAY_MS));
}

async function ensureReviewLabel(api, context, checkCurrent) {
  let label = await api.getReviewLabel(context);
  if (!label || typeof label !== 'object' || typeof label.exists !== 'boolean') throw new Error('Label lookup response is invalid.');
  if (label.exists) return { stale: false };
  for (let attempt = 0; attempt < LABEL_WRITE_ATTEMPTS; attempt++) {
    const check = await checkCurrent();
    if (check.stale || check.completed) return check;
    try {
      const created = await api.createReviewLabel(context);
      if (created?.confirmed === true) return { stale: false };
      throw new Error('Label creation was not confirmed.');
    } catch (error) {
      label = await api.getReviewLabel(context);
      if (!label || typeof label !== 'object' || typeof label.exists !== 'boolean') throw new Error('Label lookup response is invalid.');
      if (label.exists) return { stale: false };
      if (!retryableLabelFailure(error) || attempt === LABEL_WRITE_ATTEMPTS - 1) throw new Error('Label creation could not be confirmed.');
      await labelRetryDelay();
    }
  }
}

async function ensureOutcomeLabel(api, context, name) {
  let label;
  try { label = await api.getOutcomeLabel({ repository: context.repository, name }); }
  catch { return false; }
  if (!label || typeof label !== 'object' || typeof label.exists !== 'boolean') return false;
  if (label.exists) return true;

  for (let attempt = 0; attempt < LABEL_WRITE_ATTEMPTS; attempt++) {
    let error;
    try {
      const created = await api.createOutcomeLabel({ repository: context.repository, name });
      if (created?.confirmed === true) return true;
      error = new Error('Outcome label creation was not confirmed.');
    } catch (creationError) {
      error = creationError;
    }

    try { label = await api.getOutcomeLabel({ repository: context.repository, name }); }
    catch { return false; }
    if (!label || typeof label !== 'object' || typeof label.exists !== 'boolean') return false;
    if (label.exists) return true;
    if (!retryableLabelFailure(error) || attempt === LABEL_WRITE_ATTEMPTS - 1) return false;
    await labelRetryDelay();
  }
  return false;
}

async function provisionOutcomeLabels(api, context) {
  let complete = true;
  for (const { name } of OUTCOME_LABELS) {
    try {
      if (!await ensureOutcomeLabel(api, context, name)) complete = false;
    } catch {
      complete = false;
    }
  }
  return complete;
}

async function applyReviewLabel(api, context, checkCurrent) {
  for (let attempt = 0; attempt < LABEL_WRITE_ATTEMPTS; attempt++) {
    const check = await checkCurrent();
    if (check.stale || check.completed) return check;
    try {
      const applied = await api.addLabel(context);
      if (applied?.confirmed === true) return { stale: false };
      throw new Error('Label application was not confirmed.');
    } catch (error) {
      if (await hasReviewLabel(api, context)) return { stale: false };
      if (!retryableLabelFailure(error) || attempt === LABEL_WRITE_ATTEMPTS - 1) throw new Error('Label application could not be confirmed.');
      await labelRetryDelay();
    }
  }
  throw new Error('Label application could not be confirmed.');
}

export async function moderate({ getContext, getInputs, api, score, prepare = prepareSubmission } = {}) {
  const eligible = createEligibleContinuation({ getContext, getInputs });
  let outcomeLabelsIncomplete = false;
  try {
    const result = await eligible(async (context, policy) => {
      const prepared = prepare(context.title, context.body);
      if (!prepared.trim()) return { outcome: 'empty_input', cutoff: CUTOFF, score: null, partial: false };
      const classified = await score({ protocol_version: 1, text: prepared });
      if (classified?.protocol_version === 1 && classified?.outcome === 'empty_input' &&
          !Object.hasOwn(classified, 'robot_score') &&
          typeof classified.input_sha256 === 'string' && /^[a-f0-9]{64}$/.test(classified.input_sha256) &&
          typeof classified.detector_revision === 'string' && /^[a-f0-9]{40}$/.test(classified.detector_revision) &&
          /^[a-f0-9]{64}$/.test(classified.model_sha256)) {
        return { outcome: 'empty_input', cutoff: CUTOFF, score: null, partial: false,
          detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
          input_sha256: classified.input_sha256 };
      }
      if (!validClassification(classified)) throw new Error('Classification result is invalid.');
      if (classified.robot_score < CUTOFF) return {
        outcome: 'below_cutoff', cutoff: CUTOFF, score: classified.robot_score,
        detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
        input_sha256: classified.input_sha256, partial: false,
      };
      if (policy.mode === 'observe') {
        if (!policy.reviewLabel) return { outcome: 'flagged', cutoff: CUTOFF, score: classified.robot_score,
          detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
          input_sha256: classified.input_sha256, partial: false };
        let matches;
        try { matches = await currentMatches(api, context); }
        catch { return safeFailure('Current item state could not be checked safely.'); }
        if (!matches) return { outcome: 'skipped', reason: 'stale_before_label', cutoff: CUTOFF,
          score: classified.robot_score, partial: false };
        try {
          if (await hasOutcomeLabel(api, context)) return { outcome: 'skipped', reason: 'review_complete',
            cutoff: CUTOFF, score: classified.robot_score, partial: false };
        } catch { return safeFailure('Current review outcome could not be checked safely.'); }
        outcomeLabelsIncomplete = !await provisionOutcomeLabels(api, context);
        try {
          const checkCurrent = () => checkBeforeLabelWrite(api, context);
          const ensured = await ensureReviewLabel(api, context, checkCurrent);
          const applied = ensured.stale || ensured.completed ? ensured
            : await applyReviewLabel(api, context, checkCurrent);
          if (applied.completed) return { outcome: 'skipped', reason: 'review_complete', cutoff: CUTOFF,
            score: classified.robot_score, partial: false };
          if (applied.stale) return { outcome: 'skipped', reason: 'stale_before_label', cutoff: CUTOFF,
            score: classified.robot_score, partial: false };
        } catch {
          return safeFailure('Observation label could not be applied safely.');
        }
        return { outcome: 'flagged', cutoff: CUTOFF, score: classified.robot_score,
          detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
          input_sha256: classified.input_sha256, label: REVIEW_LABEL, label_applied: true, partial: false };
      }
      const marker = markerFor(context, classified);
      let comments = await api.listComments(context);
      let existing = comments.find((comment) => genuine(comment, marker));
      let posted = Boolean(existing);
      if (!existing) {
        if (!await currentMatches(api, context)) return { outcome: 'skipped', reason: 'stale_before_comment', cutoff: CUTOFF, score: classified.robot_score, partial: false };
        const body = `${policy.response}\n\nAutomated score: ${classified.robot_score} (cutoff ${CUTOFF}). Detector: ${classified.detector_revision}. Model SHA-256: ${classified.model_sha256}.\n\n${marker}`;
        try {
          existing = await api.createComment({ ...context, body });
          if (!genuine(existing, marker)) throw new Error('Created comment identity is invalid.');
          posted = true;
        } catch {
          let reconciled;
          try { reconciled = (await api.listComments(context)).find((comment) => genuine(comment, marker)); }
          catch { return safeFailure('Comment outcome is uncertain; reconciliation failed.', { uncertain: true }); }
          if (!reconciled) return safeFailure('Comment outcome is uncertain; no matching response was confirmed.', { uncertain: true });
          existing = reconciled;
          posted = true;
        }
      }
      const partial = {
        commentPosted: posted, comment_id: existing.id, score: classified.robot_score,
        detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
        input_sha256: classified.input_sha256,
      };
      if (policy.reviewLabel) {
        try {
          if (!await currentMatches(api, context)) return {
            outcome: 'skipped', reason: 'stale_before_label', cutoff: CUTOFF,
            score: classified.robot_score, comment_id: existing.id, partial: posted,
            detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
            input_sha256: classified.input_sha256,
          };
          if (await hasOutcomeLabel(api, context)) return {
            outcome: 'skipped', reason: 'review_complete', cutoff: CUTOFF,
            score: classified.robot_score, comment_id: existing.id, partial: posted,
            detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
            input_sha256: classified.input_sha256,
          };
        } catch {
          return safeFailure('Response is confirmed, but current state could not be checked before labeling.', partial);
        }
        outcomeLabelsIncomplete = !await provisionOutcomeLabels(api, context);
        try {
          const checkCurrent = () => checkBeforeLabelWrite(api, context);
          const ensured = await ensureReviewLabel(api, context, checkCurrent);
          const applied = ensured.stale || ensured.completed ? ensured
            : await applyReviewLabel(api, context, checkCurrent);
          if (applied.completed) return {
            outcome: 'skipped', reason: 'review_complete', cutoff: CUTOFF,
            score: classified.robot_score, comment_id: existing.id, partial: posted,
            detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
            input_sha256: classified.input_sha256,
          };
          if (applied.stale) return {
            outcome: 'skipped', reason: 'stale_before_label', cutoff: CUTOFF,
            score: classified.robot_score, comment_id: existing.id, partial: posted,
            detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
            input_sha256: classified.input_sha256,
          };
        } catch {
          return safeFailure('Response is confirmed, but the review label could not be applied.', partial);
        }
      }
      if (!policy.autoClose) {
        try {
          if (!await currentMatches(api, context)) return {
            outcome: 'skipped', reason: 'stale_after_comment', cutoff: CUTOFF,
            score: classified.robot_score, comment_id: existing.id, partial: posted,
          };
        } catch {
          return safeFailure('Response is confirmed, but current state could not be checked.', partial);
        }
        return {
          outcome: 'commented', cutoff: CUTOFF, score: classified.robot_score,
          detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
          input_sha256: classified.input_sha256, comment_id: existing.id, partial: false,
        };
      }
      try {
        if (!await currentMatches(api, context)) return {
          outcome: 'skipped', reason: 'stale_before_close', cutoff: CUTOFF,
          score: classified.robot_score, comment_id: existing.id, partial: posted,
        };
        if (await hasOutcomeLabel(api, context)) return {
          outcome: 'skipped', reason: 'review_complete', cutoff: CUTOFF,
          score: classified.robot_score, comment_id: existing.id, partial: posted,
          detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
          input_sha256: classified.input_sha256,
        };
      } catch {
        return safeFailure('Response is confirmed, but closure state could not be checked.', partial);
      }
      try {
        await api.closeItem(context);
      } catch {
        return safeFailure('Response is confirmed, but closure failed.', partial);
      }
      return {
        outcome: 'closed', cutoff: CUTOFF, score: classified.robot_score,
        detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
        input_sha256: classified.input_sha256, comment_id: existing.id, partial: false,
      };
    });
    return outcomeLabelsIncomplete ? { ...result, outcome_labels_incomplete: true } : result;
  } catch {
    return safeFailure('Moderation failed safely.',
      outcomeLabelsIncomplete ? { outcome_labels_incomplete: true } : {});
  }
}
