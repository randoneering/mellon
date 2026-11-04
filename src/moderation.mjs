import { createEligibleContinuation } from './inputs.mjs';
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

async function currentMatches(api, context) {
  const current = await api.getItem(context);
  return current.state === 'open' && current.merged !== true && current.title === context.title && current.body === context.body;
}

export async function moderate({ getContext, getInputs, api, score, prepare = prepareSubmission } = {}) {
  const eligible = createEligibleContinuation({ getContext, getInputs });
  try {
    return await eligible(async (context, policy) => {
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
        let matches;
        try { matches = await currentMatches(api, context); }
        catch { return safeFailure('Current item state could not be checked safely.'); }
        if (!matches) return { outcome: 'skipped', reason: 'stale_before_label', cutoff: CUTOFF,
          score: classified.robot_score, partial: false };
        try {
          const label = await api.getReviewLabel(context);
          if (!label.exists) await api.createReviewLabel(context);
          if (!await currentMatches(api, context)) return { outcome: 'skipped', reason: 'stale_before_label',
            cutoff: CUTOFF, score: classified.robot_score, partial: false };
          await api.addLabel(context);
        } catch {
          return safeFailure('Observation label could not be applied safely.');
        }
        return { outcome: 'flagged', cutoff: CUTOFF, score: classified.robot_score,
          detector_revision: classified.detector_revision, model_sha256: classified.model_sha256,
          input_sha256: classified.input_sha256, label: REVIEW_LABEL, partial: false };
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
  } catch {
    return safeFailure('Moderation failed safely.');
  }
}
