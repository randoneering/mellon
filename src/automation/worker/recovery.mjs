import { ensureDraftPr, publish, probePublication } from './publisher.mjs';
import { snapshotDraftPrRequest, snapshotPublicationRequest } from './publication-validation.mjs';
import {
  DEFAULT_RECOVERY_TIMEOUT_MS, createWaitDeadline, validateWaitTimeout,
  validateIntent, validateLease, validatePublicationProof,
} from './store-validation.mjs';

const DATABASE_UNCERTAIN = 'recovery_database_uncertain';
const LEASE_LOST = 'recovery_lease_lost';
const PUBLICATION_FAILURES = new Set(['approval_denied', 'approval_unavailable',
  'branch_absent', 'branch_head_mismatch', 'branch_history_limit', 'branch_history_untrusted',
  'branch_identity_mismatch', 'branch_moved', 'branch_read_failed', 'branch_write_not_observed',
  'commit_metadata_invalid', 'commit_write_not_observed', 'commit_write_unconfirmed',
  'fence_denied', 'fence_unavailable', 'invalid_input', 'patch_rejected',
  'publication_context_invalid', 'publication_context_unavailable',
  'pr_context_unavailable', 'pr_template_unverified', 'pr_evidence_invalid',
  'pr_evidence_incomplete', 'pr_identity_ambiguous', 'pr_identity_mismatch',
  'pr_write_not_observed', 'pr_write_unconfirmed', 'pr_publication_failed',
  'repository_identity_mismatch', 'repository_read_failed', 'signing_preflight_expired',
  'tree_incomplete', 'unsupported_file_mode']);

export function createRecoveryCoordinator({ store, publicationDependencies,
  timeoutMs = DEFAULT_RECOVERY_TIMEOUT_MS, finalizationDeadline }) {
  validateWaitTimeout(timeoutMs, DEFAULT_RECOVERY_TIMEOUT_MS);
  if (!store || !['getRun', 'putIntent', 'fenceIntent', 'confirmIntent', 'finishRun']
    .every(method => typeof store[method] === 'function')) {
    throw new Error('Worker recovery dependencies are invalid.');
  }

  async function recover(input, budget) {
    let ledgerDeadline = Math.min(finalizationDeadline ?? budget.deadline, budget.deadline);
    let lease;
    let intent;
    let publication;
    let fenceReason;
    let databaseUncertain = false;
    let activeDatabase = 0;
    async function database(operation) {
      activeDatabase += 1;
      try {
        return await budget.wait(() => operation({ deadline: budget.deadline }));
      } catch {
        databaseUncertain = true;
        throw new Error(DATABASE_UNCERTAIN);
      } finally {
        activeDatabase -= 1;
      }
    }

    async function attention(reason, effectCategory) {
      let persisted = false;
      if (databaseUncertain || activeDatabase > 0) reason = DATABASE_UNCERTAIN;
      if (budget.isExpired()) {
        if (reason === LEASE_LOST) return Object.freeze({ status: 'needs_attention', reason, persisted });
        if (reason !== DATABASE_UNCERTAIN) reason = 'recovery_deadline';
        // Only this recovery knows whether its database work settled before expiry.
        if (lease && reason !== DATABASE_UNCERTAIN && activeDatabase === 0
          && Number.isSafeInteger(finalizationDeadline) && Number.isSafeInteger(ledgerDeadline)
          && ledgerDeadline > Date.now()) {
          const finalization = createWaitDeadline(ledgerDeadline - Date.now(), ledgerDeadline);
          try {
            persisted = await finalization.wait(() => store.finishRun(lease, 'needs_attention',
              { blockerCode: reason }, { deadline: finalization.deadline }));
          } catch { reason = DATABASE_UNCERTAIN; }
          finally { finalization.close(); }
        }
        return Object.freeze({ status: 'needs_attention', reason, persisted });
      }
      // An uncertain transaction is not permission to issue another write.
      if (lease && reason !== DATABASE_UNCERTAIN && reason !== LEASE_LOST) {
        try {
          persisted = await database(options => store.finishRun(lease, 'needs_attention',
            { blockerCode: reason }, options));
        } catch {
          return Object.freeze({ status: 'needs_attention', reason: DATABASE_UNCERTAIN,
            persisted: false });
        }
      }
      return Object.freeze({ status: 'needs_attention', reason, persisted,
        ...(PUBLICATION_FAILURES.has(effectCategory) ? { effectCategory } : {}) });
    }

    try {
      budget.clamp(input?.deadline);
      lease = validateLease(input?.lease);
      budget.clamp(Date.parse(lease.expiresAt));
      ledgerDeadline = Math.min(ledgerDeadline, Date.parse(lease.expiresAt));
      intent = validateIntent(input?.intent);
      if (!['commit_create', 'pr_create'].includes(intent.kind)) {
        return attention('recovery_unsupported_effect');
      }
      publication = (intent.kind === 'pr_create' ? snapshotDraftPrRequest : snapshotPublicationRequest)(
        input?.publication,
      );
      const { run } = publication;
      if (run.id !== lease.runId || run.generation !== lease.generation
          || run.repositoryId !== lease.repositoryId
          || lease.repositoryFullName !== publication.approvedManifest.repository.name
          || run.issueId !== lease.issueId || run.issueNumber !== lease.issueNumber
          || run.approverId !== lease.actorId || publication.intent.id !== intent.key
          || run.expectedHeadSha !== intent.expectedHeadSha) {
        return attention('recovery_invalid_input');
      }
    } catch {
      return attention('recovery_invalid_input');
    }

    let reserved;
    try {
      const run = await database(options => store.getRun(lease.runId, options));
      for (const deadline of [run?.tickDeadlineAt, run?.runDeadlineAt, run?.leaseExpiresAt]) {
        if (deadline !== null && deadline !== undefined) {
          budget.clamp(Date.parse(deadline));
          ledgerDeadline = Math.min(ledgerDeadline, Date.parse(deadline));
        }
      }
      if (!run || run.manifestHash !== publication.run.manifestSha256
          || run.baseRevision !== publication.run.baseSha
          || run.policyRevision !== publication.approvedManifest.policyRevision) {
        return attention('recovery_invalid_input');
      }
      if (intent.coordinator) {
        if (typeof store.getCoordinatorSnapshot !== 'function') {
          return attention('coordinator_journal_conflict');
        }
        const snapshot = await database(options => store.getCoordinatorSnapshot(lease, options));
        if (snapshot.status === 'stale') return attention(LEASE_LOST);
        const c = intent.coordinator;
        if (snapshot.status !== 'owned' || snapshot.phase?.key !== c.phaseKey
            || snapshot.phase.purpose !== c.purpose || snapshot.phase.repairCycle !== c.repairCycle
            || (snapshot.pendingOperation && (snapshot.pendingOperation.key !== intent.key
              || snapshot.pendingOperation.inputHash !== intent.inputHash
              || snapshot.pendingOperation.expectedHeadSha !== intent.expectedHeadSha))) {
          return attention('coordinator_journal_conflict');
        }
        if (c.modelOperationId !== null && (snapshot.modelOperation?.operationId !== c.modelOperationId
            || snapshot.modelOperation.outcome !== 'success')) {
          return attention('coordinator_model_uncertain');
        }
      }
      reserved = await database(options => store.putIntent(lease, intent, options));
    } catch {
      return attention(DATABASE_UNCERTAIN);
    }
    if (reserved.status === 'stale') return attention(LEASE_LOST);
    if (!['created', 'existing'].includes(reserved.status)) return attention('recovery_conflict');

    const dependencies = {
      ...publicationDependencies,
      timeoutMs: Math.max(1, Math.min(publicationDependencies?.timeoutMs ?? 20000,
        budget.deadline - Date.now())),
      deadline: budget.deadline,
      fetch: (url, options) => budget.wait(() => publicationDependencies.fetch(url, {
        ...options, signal: AbortSignal.any([budget.signal, options.signal]),
      })),
      getPublicationContext: request => budget.wait(() =>
        publicationDependencies.getPublicationContext(request)),
      checkApproval: request => budget.wait(() => publicationDependencies.checkApproval(request)),
      async checkFence(request) {
        if (request.runId !== lease.runId || request.generation !== lease.generation
            || request.intentId !== intent.key || request.operationHash !== intent.inputHash
            || request.expectedHeadSha !== intent.expectedHeadSha
            || intent.kind === 'pr_create' && request.kind !== intent.kind) {
          fenceReason = 'recovery_conflict';
          return { decision: 'deny' };
        }
        try {
          budget.clamp(request.deadline);
          const result = await database(options =>
            store.fenceIntent(lease, intent, request.phase, options));
          if (result.status !== 'owned') {
            fenceReason = result.status === 'stale' ? LEASE_LOST
              : result.status === 'blocked' ? result.blockerCode : 'recovery_conflict';
            return { decision: 'deny' };
          }
          return {
            runId: lease.runId, generation: lease.generation, intentId: intent.key,
            operationHash: intent.inputHash, expectedHeadSha: intent.expectedHeadSha,
            phase: request.phase,
            ...(intent.kind === 'pr_create' ? { kind: intent.kind } : {}),
            decision: reserved.status === 'created' ? result.decision : 'reconcile_only',
          };
        } catch {
          databaseUncertain = true;
          return { decision: 'deny' };
        }
      },
    };

    // Only the fixed adapter may establish remote ownership and exact patch proof.
    const execute = intent.kind === 'pr_create' ? ensureDraftPr
      : reserved.status === 'created' ? publish : probePublication;
    let result;
    try {
      result = await budget.wait(() => execute(publication, dependencies));
    } catch {
      return attention(databaseUncertain || activeDatabase > 0
        ? DATABASE_UNCERTAIN : 'recovery_deadline');
    }
    if (databaseUncertain || activeDatabase > 0) return attention(DATABASE_UNCERTAIN);
    if (budget.isExpired()) return attention('recovery_deadline');
    if (fenceReason) return attention(fenceReason);
    if (result.status !== 'confirmed') {
      return attention(result.reason?.startsWith('approval_')
        ? 'recovery_approval_denied' : 'recovery_effect_unconfirmed', result.reason);
    }
    try {
      const proof = validatePublicationProof(result, lease, intent);
      if (!await database(options => store.confirmIntent(lease, intent, proof, options))) {
        return attention(LEASE_LOST);
      }
      return Object.freeze({ ...proof, persisted: true });
    } catch {
      return attention(DATABASE_UNCERTAIN);
    }
  }

  async function perform(input) {
    const budget = createWaitDeadline(timeoutMs);
    try {
      return await recover(input, budget);
    } finally {
      budget.close();
    }
  }

  return Object.freeze({ perform });
}
