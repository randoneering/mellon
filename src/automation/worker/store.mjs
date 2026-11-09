import { normalizeModelCallOutcome } from './budgets.mjs';
import { createReviewRequestMethods } from './review-request-store.mjs';
import {
  SAFE_ERROR,
  DEFAULT_DATABASE_TIMEOUT_MS,
  createWaitDeadline,
  validateWaitTimeout,
  canonical,
  buildCoordinatorPhaseKey,
  validateBeginRepairInput,
  fail,
  sameManifest,
  validateCheckpoint,
  validateCheckEvidence,
  validateClaimInput,
  validateFinishInput,
  validateIntent,
  validateLease,
  validateLimitsFromRow,
  validateModelCallInput,
  validateModelCallOutcomeInput,
  validateRepairInput,
  validateRunId,
  validatePublicationPhase,
  validatePublicationProof,
} from './store-validation.mjs';

const CLAIM_LOCK_KEY = '1296387148';
const TERMINAL_STATES = new Set(['ready_for_human', 'needs_attention', 'cancelled']);
function releaseClient(client, error) {
  // Removal must start synchronously; observe any optional wrapper cleanup promise.
  void Promise.resolve(client.release(error)).catch(() => {});
}

function discardClient(client) {
  // Pool wrappers must honor pg's release(error) destruction contract.
  try { releaseClient(client, new Error(SAFE_ERROR)); } catch { /* Never expose driver errors. */ }
}

async function acquireClient(pool, budget) {
  let accepted = false;
  let acquired;
  try {
    const client = await budget.wait(() => {
      acquired = Promise.resolve(pool.connect());
      return acquired;
    });
    accepted = true;
    if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
      if (client) discardClient(client);
      fail();
    }
    return client;
  } catch {
    // A connection may fulfill just before the deadline but lose the race to expiry.
    if (acquired) void acquired.then(client => {
      if (!accepted && client) {
        accepted = true;
        discardClient(client);
      }
    }, () => {});
    fail();
  }
}

async function withTransaction(pool, operation, budget) {
  let client;
  let inTransaction = false;
  let commitAttempted = false;
  let discard = false;
  let failed = false;
  let result;

  try {
    client = await acquireClient(pool, budget);
    const bounded = { query: (...args) => budget.wait(() => client.query(...args)) };
    await bounded.query('BEGIN');
    inTransaction = true;
    await bounded.query(`SET LOCAL lock_timeout = '${Math.max(1,
      Math.min(2000, budget.deadline - Date.now()))}ms'`);
    await bounded.query(`SET LOCAL statement_timeout = '${Math.max(1,
      Math.min(10000, budget.deadline - Date.now()))}ms'`);
    result = await budget.wait(() => operation(bounded));
    budget.check();
    commitAttempted = true;
    await bounded.query('COMMIT');
    inTransaction = false;
  } catch {
    failed = true;
    if (client && inTransaction && !budget.isExpired()) {
      try {
        await budget.wait(() => client.query('ROLLBACK'));
        inTransaction = false;
      } catch {
        discard = true;
      }
    } else if (client) {
      discard = true;
    }
    if (commitAttempted) discard = true;
  } finally {
    if (budget.isExpired()) discard = true;
    budget.close();
    if (client) {
      try {
        releaseClient(client, discard ? new Error(SAFE_ERROR) : undefined);
      } catch {
        failed = true;
      }
    }
  }

  if (failed) fail();
  return result;
}

function numberFromDatabase(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail();
  return number;
}

function timestampFromDatabase(value) {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) fail();
  return timestamp.toISOString();
}

function leaseFromRow(row) {
  return {
    runId: row.run_id,
    jobId: row.job_id,
    repositoryId: numberFromDatabase(row.repository_id),
    repositoryFullName: row.repository_full_name,
    issueId: numberFromDatabase(row.issue_id),
    issueNumber: numberFromDatabase(row.issue_number),
    actorId: numberFromDatabase(row.actor_id),
    generation: numberFromDatabase(row.generation),
    token: row.lease_token,
    expiresAt: timestampFromDatabase(row.lease_expires_at),
  };
}

function regressionFromRow(row) {
  return row.regression_workflow_id == null ? null : {
    workflowId: numberFromDatabase(row.regression_workflow_id),
    testIdentitySha256: row.regression_test_sha256,
    proposalSha256: row.regression_proposal_sha256,
  };
}

function descriptorFromRow(row) {
  return { approvedPathIndex: numberFromDatabase(row.approved_path_index),
    operation: row.change_kind, beforeBlobSha: row.before_blob_sha,
    afterBlobSha: row.after_blob_sha, contentSha256: row.content_sha256,
    bytes: numberFromDatabase(row.byte_count), mode: row.file_mode };
}

function coordinatorFromRow(row, descriptors = []) {
  return { version: 1, purpose: row.phase_purpose, phaseKey: row.phase_key,
    repairCycle: numberFromDatabase(row.phase_round), modelOperationId: row.model_operation_id ?? null,
    expectedRegression: regressionFromRow(row), criterionSha256: row.criterion_sha256 ?? null,
    candidateDescriptors: descriptors.map(descriptorFromRow) };
}

function phaseFromRow(row) {
  if (row.coordinator_version == null) return null;
  return { version: 1, purpose: row.phase_purpose, key: row.phase_key,
    repairCycle: numberFromDatabase(row.phase_round), headSha: row.phase_head_sha,
    startedAt: timestampFromDatabase(row.phase_started_at),
    waitStartedAt: timestampFromDatabase(row.wait_started_at),
    pendingOperationId: row.pending_operation_id, expectedRegression: regressionFromRow(row),
    criterionSha256: row.criterion_sha256, findingSha256: row.finding_sha256,
    findingSource: row.finding_source, findingHeadSha: row.finding_head_sha,
    priorCheckRunId: row.prior_check_run_id == null ? null : numberFromDatabase(row.prior_check_run_id),
    priorReviewId: row.prior_review_id == null ? null : numberFromDatabase(row.prior_review_id) };
}

function liveJournalRun(run) {
  const now = Date.parse(timestampFromDatabase(run.database_now));
  return now < Date.parse(timestampFromDatabase(run.tick_deadline_at))
    && now < Date.parse(timestampFromDatabase(run.run_deadline_at));
}

// Recheck time in each write: a row lock cannot freeze clock_timestamp().
const JOURNAL_LIVE = `terminal_at IS NULL AND lease_expires_at > clock_timestamp()
  AND lease_started_at + ((limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second') > clock_timestamp()
  AND created_at + ((limits ->> 'runLifetimeSeconds')::double precision * interval '1 second') > clock_timestamp()`;

const JOURNAL_WAIT_OPEN = `(state NOT IN ('waiting_red_ci', 'waiting_ci', 'waiting_review')
  OR (wait_started_at IS NOT NULL AND wait_started_at
    + ((limits ->> CASE WHEN state = 'waiting_review' THEN 'reviewWaitSeconds'
      ELSE 'ciWaitSeconds' END)::double precision * interval '1 second') > clock_timestamp()))`;

function checkEvidenceFromRow(row) {
  if (row.check_evidence_sha256 == null) return null;
  return validateCheckEvidence({ headSha: row.last_check_head_sha,
    workflowId: numberFromDatabase(row.last_workflow_id),
    workflowRunId: numberFromDatabase(row.last_workflow_run_id),
    checkRunId: numberFromDatabase(row.last_check_run_id), checksSha256: row.check_evidence_sha256,
    reviewId: row.review_head_sha === row.last_check_head_sha && row.prior_review_id != null
      ? numberFromDatabase(row.prior_review_id) : null });
}

function operationFromRow(row, descriptors = []) {
  return {
    operationId: row.operation_id,
    key: row.operation_key,
    kind: row.kind,
    inputHash: row.input_hash,
    expectedHeadSha: row.expected_head_sha,
    ...(row.coordinator_version === 1 ? { coordinator: coordinatorFromRow(row, descriptors) } : {}),
  };
}

function runFromRow(row) {
  const checkEvidence = checkEvidenceFromRow(row);
  return {
    ...(checkEvidence ? { checkEvidence } : {}),
    runId: row.run_id,
    jobId: row.job_id,
    repositoryId: numberFromDatabase(row.repository_id),
    repositoryFullName: row.repository_full_name,
    issueId: numberFromDatabase(row.issue_id),
    issueNumber: numberFromDatabase(row.issue_number),
    actorId: numberFromDatabase(row.actor_id),
    manifestHash: row.manifest_hash,
    baseRevision: row.base_revision,
    policyRevision: row.policy_revision,
    limits: validateLimitsFromRow(row.limits),
    state: row.state,
    generation: numberFromDatabase(row.generation),
    recoveryCount: numberFromDatabase(row.recovery_count),
    modelCallCount: numberFromDatabase(row.model_call_count),
    reservedInputTokens: numberFromDatabase(row.reserved_input_tokens),
    reservedOutputTokens: numberFromDatabase(row.reserved_output_tokens),
    repairCycleCount: numberFromDatabase(row.repair_cycle_count),
    leaseExpiresAt: timestampFromDatabase(row.lease_expires_at),
    tickDeadlineAt: timestampFromDatabase(row.tick_deadline_at),
    runDeadlineAt: timestampFromDatabase(row.run_deadline_at),
    expectedHeadSha: row.expected_head_sha,
    branchName: row.branch_name,
    pullRequestNumber: row.pull_request_number === null
      ? null : numberFromDatabase(row.pull_request_number),
    lastCheckRunId: row.last_check_run_id === null
      ? null : numberFromDatabase(row.last_check_run_id),
    reviewHeadSha: row.review_head_sha,
    blockerCode: row.blocker_code,
    createdAt: timestampFromDatabase(row.created_at),
    updatedAt: timestampFromDatabase(row.updated_at),
    terminalAt: timestampFromDatabase(row.terminal_at),
  };
}

async function appendEvent(client, {
  runId,
  generation,
  eventType,
  invocationId = null,
  operationId = null,
  state = null,
  repairKey = null,
  repairSource = null,
  repairHeadSha = null,
  repairFindingSha256 = null,
}) {
  const { rows } = await client.query(`
    INSERT INTO agent_worker.events
      (run_id, generation, event_type, invocation_id, operation_id, state,
       repair_key, repair_source, repair_head_sha${repairFindingSha256 === null ? '' : ', repair_finding_sha256'})
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${repairFindingSha256 === null ? '' : ', $10'})
    RETURNING event_id`,
  [runId, generation, eventType, invocationId, operationId, state,
    repairKey, repairSource, repairHeadSha,
    ...(repairFindingSha256 === null ? [] : [repairFindingSha256])]);
  if (rows.length !== 1) fail();
}

function normalizeUsageAgainstReservation(outcome, operation) {
  if (outcome.actualInputTokens !== null
      && (outcome.actualInputTokens > numberFromDatabase(operation.reserved_input_tokens)
        || outcome.actualOutputTokens > numberFromDatabase(operation.reserved_output_tokens))) {
    return {
      outcome: 'excess_usage',
      actualInputTokens: null,
      actualOutputTokens: null,
      blockerCode: 'model_usage_exceeded',
    };
  }
  return outcome;
}

function outcomeReplay(operation, requested) {
  let recorded;
  try {
    recorded = normalizeModelCallOutcome({
      outcome: operation.outcome_code,
      ...(operation.actual_input_tokens === null
        ? {}
        : {
          actualInputTokens: numberFromDatabase(operation.actual_input_tokens),
          actualOutputTokens: numberFromDatabase(operation.actual_output_tokens),
        }),
    });
  } catch {
    fail();
  }
  const sameUsage = recorded.actualInputTokens === requested.actualInputTokens
    && recorded.actualOutputTokens === requested.actualOutputTokens;
  const sameOutcome = recorded.outcome === requested.outcome
    || (recorded.outcome === 'deadline' && requested.outcome === 'success');
  const same = sameOutcome && sameUsage;
  return {
    status: same ? 'existing' : 'conflict',
    outcome: recorded.outcome,
    blockerCode: operation.outcome_blocker_code,
  };
}

function terminal(row) {
  return row.terminal_at !== null || TERMINAL_STATES.has(row.state);
}

export function createWorkerStore(pool, { timeoutMs = DEFAULT_DATABASE_TIMEOUT_MS } = {}) {
  if (!pool || typeof pool.connect !== 'function') fail();
  validateWaitTimeout(timeoutMs, DEFAULT_DATABASE_TIMEOUT_MS);

  function databaseDeadline(options = {}, lease, maximumDeadline = Infinity) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail();
    const deadline = options.deadline ?? Infinity;
    const budget = createWaitDeadline(timeoutMs, deadline);
    if (maximumDeadline !== Infinity) budget.clamp(maximumDeadline);
    if (lease) budget.clamp(Date.parse(lease.expiresAt));
    return budget;
  }

  async function selectOwnedRun(client, lease) {
    const { rows } = await client.query(`
      SELECT runs.*,
        clock_timestamp() AS database_now,
        runs.lease_started_at
          + ((runs.limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second')
          AS tick_deadline_at,
        runs.created_at
          + ((runs.limits ->> 'runLifetimeSeconds')::double precision * interval '1 second')
          AS run_deadline_at
      FROM agent_worker.runs AS runs
      WHERE runs.run_id = $1
        AND runs.job_id = $2
        AND runs.repository_id = $3
        AND runs.repository_full_name = $4
        AND runs.issue_id = $5
        AND runs.issue_number = $6
        AND runs.actor_id = $7
        AND runs.generation = $8
        AND runs.lease_token = $9
        AND runs.terminal_at IS NULL
        AND runs.lease_expires_at > clock_timestamp()
      FOR UPDATE`,
    [lease.runId, lease.jobId, lease.repositoryId, lease.repositoryFullName,
      lease.issueId, lease.issueNumber, lease.actorId, lease.generation, lease.token]);
    return rows[0] ?? null;
  }

  async function stopForBudget(client, lease, blockerCode, {
    operationId = null,
    eventType = 'budget_stopped',
    repair = null,
    journal = false,
  } = {}) {
    const evidence = journal ? repair?.evidence : null;
    const { rows } = await client.query(`
      UPDATE agent_worker.runs
      SET state = 'needs_attention',
          blocker_code = $4,
          ${evidence ? `last_check_head_sha = $5, last_workflow_id = $6,
            last_workflow_run_id = $7, last_check_run_id = $8, prior_check_run_id = $8,
            check_evidence_sha256 = $9, prior_review_id = COALESCE($10, prior_review_id),
            review_head_sha = CASE WHEN $10::bigint IS NOT NULL THEN $5 ELSE review_head_sha END,` : ''}
          lease_token = NULL,
          lease_started_at = NULL,
          lease_expires_at = NULL,
          terminal_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE run_id = $1
        AND generation = $2
        AND lease_token = $3
        AND terminal_at IS NULL
        AND lease_expires_at > clock_timestamp()
        ${journal ? `AND ${JOURNAL_LIVE}` : ''}
        ${evidence ? `AND expected_head_sha = $5 AND ${JOURNAL_WAIT_OPEN}` : ''}
      RETURNING run_id, generation`,
    [lease.runId, lease.generation, lease.token, blockerCode,
      ...(evidence ? [evidence.headSha, evidence.workflowId, evidence.workflowRunId,
        evidence.checkRunId, evidence.checksSha256, evidence.reviewId] : [])]);
    if (rows.length === 0) return false;

    await appendEvent(client, {
      runId: rows[0].run_id,
      generation: numberFromDatabase(rows[0].generation),
      eventType,
      operationId,
      state: 'needs_attention',
      repairKey: repair?.key ?? null,
      repairSource: repair?.source ?? null,
      repairHeadSha: repair?.headSha ?? null,
      repairFindingSha256: repair?.findingSha256 ?? null,
    });
    return true;
  }

  async function claimTick(inputValue, waitOptions = {}) {
    const input = validateClaimInput(inputValue);
    const { invocationId, manifest } = input;

    return withTransaction(pool, async (client) => {
      const { rows: lockRows } = await client.query(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [CLAIM_LOCK_KEY],
      );
      if (lockRows[0]?.locked !== true) return { status: 'busy' };

      const { rows: priorInvocations } = await client.query(`
        SELECT runs.terminal_at
        FROM agent_worker.events AS events
        JOIN agent_worker.runs AS runs ON runs.run_id = events.run_id
        WHERE events.invocation_id = $1
        LIMIT 1`,
      [invocationId]);
      if (priorInvocations.length > 0) {
        return { status: priorInvocations[0].terminal_at === null ? 'busy' : 'idle' };
      }

      const { rows: jobs } = await client.query(`
        SELECT job_id
        FROM agent_intake.jobs
        WHERE repository_id = $1
          AND repository_full_name = $2
          AND issue_id = $3
          AND issue_number = $4
          AND actor_id = $5
          AND status = 'queued'
        LIMIT 1`,
      [
        manifest.repositoryId,
        manifest.repositoryFullName,
        manifest.issueId,
        manifest.issueNumber,
        manifest.actorId,
      ]);
      if (jobs.length === 0) return { status: 'idle' };

      let { rows: existingRows } = await client.query(`
        SELECT *
        FROM agent_worker.runs
        WHERE job_id = $1
        FOR UPDATE`,
      [jobs[0].job_id]);
      let run = existingRows[0];

      if (!run) {
        const inserted = await client.query(`
          INSERT INTO agent_worker.runs
            (job_id, repository_id, repository_full_name, issue_id, issue_number,
             actor_id, manifest_hash, base_revision, policy_revision, limits)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          ON CONFLICT DO NOTHING
          RETURNING *`,
        [
          jobs[0].job_id,
          manifest.repositoryId,
          manifest.repositoryFullName,
          manifest.issueId,
          manifest.issueNumber,
          manifest.actorId,
          manifest.manifestHash,
          manifest.baseRevision,
          manifest.policyRevision,
          JSON.stringify(manifest.limits),
        ]);
        run = inserted.rows[0];

        if (!run) {
          const existing = await client.query(`
            SELECT *
            FROM agent_worker.runs
            WHERE job_id = $1
            FOR UPDATE`,
          [jobs[0].job_id]);
          run = existing.rows[0];
          if (!run) {
            const active = await client.query(`
              SELECT run_id
              FROM agent_worker.runs
              WHERE terminal_at IS NULL
              LIMIT 1`);
            return { status: active.rows.length > 0 ? 'busy' : 'idle' };
          }
        }
      }

      if (!sameManifest(run, manifest) || terminal(run)) return { status: 'idle' };

      const exhausted = await client.query(`
        UPDATE agent_worker.runs
        SET state = 'needs_attention',
            blocker_code = 'lease_recovery_limit',
            lease_token = NULL,
            lease_started_at = NULL,
            lease_expires_at = NULL,
            terminal_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE run_id = $1
          AND terminal_at IS NULL
          AND lease_token IS NOT NULL
          AND lease_expires_at <= clock_timestamp()
          AND recovery_count >= $2
        RETURNING run_id, generation`,
      [run.run_id, manifest.limits.expiredLeaseRecoveries]);
      if (exhausted.rows.length > 0) {
        const expired = exhausted.rows[0];
        await appendEvent(client, {
          runId: expired.run_id,
          generation: numberFromDatabase(expired.generation),
          eventType: 'lease_recovery_limit',
          invocationId,
          state: 'needs_attention',
        });
        return { status: 'idle' };
      }

      const recovering = run.lease_token !== null;
      const claimed = await client.query(`
        UPDATE agent_worker.runs
        SET generation = generation + 1,
            lease_token = gen_random_uuid(),
            lease_started_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + ($2::double precision * interval '1 second'),
            recovery_count = recovery_count + CASE WHEN lease_token IS NULL THEN 0 ELSE 1 END,
            updated_at = clock_timestamp()
        WHERE run_id = $1
          AND terminal_at IS NULL
          AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())
          AND (lease_token IS NULL OR recovery_count < $3)
        RETURNING *`,
      [run.run_id, manifest.limits.leaseSeconds, manifest.limits.expiredLeaseRecoveries]);
      if (claimed.rows.length === 0) return { status: 'busy' };

      const leaseRow = claimed.rows[0];
      if (recovering) {
        await appendEvent(client, {
          runId: leaseRow.run_id,
          generation: numberFromDatabase(leaseRow.generation),
          eventType: 'lease_recovered',
          state: leaseRow.state,
        });
      }
      await appendEvent(client, {
        runId: leaseRow.run_id,
        generation: numberFromDatabase(leaseRow.generation),
        eventType: 'tick_claimed',
        invocationId,
        state: leaseRow.state,
      });

      return { status: 'claimed', lease: leaseFromRow(leaseRow),
        deadline: Math.min(
          Date.parse(timestampFromDatabase(leaseRow.lease_started_at))
            + manifest.limits.tickDeadlineSeconds * 1000,
          Date.parse(timestampFromDatabase(leaseRow.created_at))
            + manifest.limits.runLifetimeSeconds * 1000,
          Date.parse(timestampFromDatabase(leaseRow.lease_expires_at)),
        ) };
    }, databaseDeadline(waitOptions, undefined,
      Date.now() + manifest.limits.tickDeadlineSeconds * 1000));
  }

  async function getCoordinatorSnapshot(leaseValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    return withTransaction(pool, async client => {
      const run = await selectOwnedRun(client, lease);
      if (!run || !liveJournalRun(run)) return { status: 'stale' };
      const phase = phaseFromRow(run);
      if (!phase) return { status: 'owned', run: runFromRow(run), phase: null,
        modelOperation: null, pendingOperation: null };
      const { rows } = await client.query(`SELECT * FROM agent_worker.operations
        WHERE run_id = $1 AND (phase_key = $2 OR operation_id = $3)
        ORDER BY created_at, operation_id`, [lease.runId, phase.key, phase.pendingOperationId]);
      const model = rows.find(op => op.kind === 'model_call' && op.phase_key === phase.key);
      const pending = rows.find(op => op.operation_id === phase.pendingOperationId);
      let descriptors = [];
      if (pending) {
        const files = await client.query(`SELECT * FROM agent_worker.candidate_descriptors
          WHERE run_id = $1 AND operation_id = $2 ORDER BY ordinal`,
        [lease.runId, pending.operation_id]);
        descriptors = files.rows;
      }
      return { status: 'owned', run: runFromRow(run), phase,
        modelOperation: model ? { ...operationFromRow(model), outcome: model.outcome_code } : null,
        pendingOperation: pending ? operationFromRow(pending, descriptors) : null };
    }, databaseDeadline(waitOptions, lease));
  }

  function validPhase(run, phase, state) {
    const knownHead = run.expected_head_sha ?? run.base_revision;
    if (phase.headSha !== knownHead || phase.repairCycle !== numberFromDatabase(run.repair_cycle_count)
        || phase.key !== buildCoordinatorPhaseKey({ runId: run.run_id,
          manifestSha256: run.manifest_hash, purpose: phase.purpose,
          repairCycle: phase.repairCycle, headSha: phase.headSha,
          findingSha256: phase.findingSha256 })) return false;
    const states = { initial_tests: ['generating_tests', 'waiting_red_ci'],
      initial_implementation: ['implementing', 'waiting_ci'],
      repair_investigation: ['repairing'], repair_tests: ['repairing', 'generating_tests', 'waiting_red_ci'],
      repair_implementation: ['repairing', 'implementing', 'waiting_ci'],
      draft_pr: ['opening_pr', 'waiting_review'] };
    if (!states[phase.purpose].includes(state)) return false;
    if (run.coordinator_version == null) {
      return run.state === 'claimed' && phase.purpose === 'initial_tests'
        && phase.repairCycle === 0 && phase.findingSha256 === null;
    }
    if (phase.key === run.phase_key) return state === run.state && phase.purpose === run.phase_purpose
      && phase.headSha === run.phase_head_sha && phase.findingSha256 === run.finding_sha256;
    if (run.pending_operation_id !== null || phase.findingSha256 !== run.finding_sha256) return false;
    return (run.state === 'waiting_red_ci'
        && ((run.phase_purpose === 'initial_tests' && phase.purpose === 'initial_implementation')
          || (run.phase_purpose === 'repair_tests' && phase.purpose === 'repair_implementation')))
      || (run.state === 'waiting_ci' && phase.purpose === 'draft_pr')
      || (run.phase_purpose === 'repair_investigation' && run.state === 'repairing'
        && phase.purpose === 'repair_tests');
  }

  async function checkpointCoordinator(client, lease, change) {
    const run = await selectOwnedRun(client, lease);
    if (!run || !liveJournalRun(run)) return false;
    const p = change.coordinator;
    const evidence = change.evidence;
    if (evidence && (evidence.headSha !== run.expected_head_sha
      || evidence.workflowId !== numberFromDatabase(run.regression_workflow_id))) fail();
    // A confirmed wait retains the phase's original parent, not its published child.
    const polling = p.key === run.phase_key && p.headSha === run.phase_head_sha
      && p.purpose === run.phase_purpose && p.repairCycle === run.phase_round
      && p.findingSha256 === run.finding_sha256 && change.state === run.state;
    const repeatReview = change.state === 'waiting_review' && p.purpose === 'draft_pr'
      && run.state === 'waiting_ci' && run.pull_request_number !== null
      && p.repairCycle > 0;
    if ((!polling && !repeatReview && ['waiting_red_ci', 'waiting_ci', 'waiting_review'].includes(change.state))
        || run.pending_operation_id != null || (!polling && !validPhase(run, p, change.state))
        || (change.hasExpectedHeadSha && change.expectedHeadSha !== run.expected_head_sha
          && !(run.expected_head_sha === null && change.expectedHeadSha === run.base_revision))) fail();
    if (polling && p.key !== buildCoordinatorPhaseKey({ runId: run.run_id,
      manifestSha256: run.manifest_hash, purpose: p.purpose, repairCycle: p.repairCycle,
      headSha: p.headSha, findingSha256: p.findingSha256 })) fail();
    const regression = Object.hasOwn(p, 'expectedRegression') ? p.expectedRegression : regressionFromRow(run);
    const criterion = Object.hasOwn(p, 'criterionSha256') ? p.criterionSha256 : run.criterion_sha256;
    const source = p.findingSource ?? run.finding_source ?? null;
    const findingHead = p.findingHeadSha ?? run.finding_head_sha ?? null;
    if (JSON.stringify(canonical(regression)) !== JSON.stringify(canonical(regressionFromRow(run)))
        || (criterion ?? null) !== (run.criterion_sha256 ?? null)
        || source !== (run.finding_source ?? null) || findingHead !== (run.finding_head_sha ?? null)) fail();
    if ((p.findingSha256 === null) !== (source === null)
        || (p.findingSha256 === null) !== (findingHead === null)) fail();
    const priorCheckRunId = run.prior_check_run_id == null ? null : numberFromDatabase(run.prior_check_run_id);
    const priorReviewId = run.prior_review_id == null ? null : numberFromDatabase(run.prior_review_id);
    if (polling && ((p.priorCheckRunId ?? priorCheckRunId) !== priorCheckRunId
        || (p.priorReviewId ?? priorReviewId) !== priorReviewId
        || evidence && JSON.stringify(canonical(evidence)) !== JSON.stringify(canonical(checkEvidenceFromRow(run))))) fail();
    if (!polling && run.phase_purpose === 'repair_investigation') {
      const prior = await client.query(`SELECT outcome_code FROM agent_worker.operations
        WHERE run_id = $1 AND phase_key = $2 AND kind = 'model_call' LIMIT 1`,
      [lease.runId, run.phase_key]);
      if (prior.rows.length) {
        await stopForBudget(client, lease, prior.rows[0].outcome_code === 'success'
          ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain', { journal: true });
        return false;
      }
    }
    const { rows } = await client.query(`UPDATE agent_worker.runs
      SET coordinator_version = 1, phase_purpose = $4, phase_round = $5,
          phase_head_sha = $6,
          phase_started_at = CASE WHEN phase_key = $7 THEN phase_started_at ELSE clock_timestamp() END,
          wait_started_at = CASE WHEN phase_key = $7 THEN wait_started_at
            WHEN $8::text = 'waiting_review' THEN clock_timestamp() ELSE NULL END,
          phase_key = $7, state = $8,
          regression_workflow_id = $9, regression_test_sha256 = $10,
          regression_proposal_sha256 = $11, criterion_sha256 = $12,
          finding_sha256 = $13, finding_source = $14, finding_head_sha = $15,
          prior_check_run_id = $16, prior_review_id = $17,
          expected_head_sha = CASE WHEN $18::boolean THEN $19::text ELSE expected_head_sha END,
          branch_name = CASE WHEN $20::boolean THEN $21::text ELSE branch_name END,
          pull_request_number = CASE WHEN $22::boolean THEN $23::bigint ELSE pull_request_number END,
          last_check_run_id = CASE WHEN $24::boolean THEN $25::bigint ELSE last_check_run_id END,
          review_head_sha = CASE WHEN $26::boolean THEN $27::text ELSE review_head_sha END,
          blocker_code = CASE WHEN $28::boolean THEN $29::text ELSE blocker_code END,
          ${evidence ? `last_check_head_sha = $30, last_workflow_id = $31,
            last_workflow_run_id = $32, check_evidence_sha256 = $33,` : ''}
          lease_token = NULL, lease_started_at = NULL, lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE run_id = $1 AND generation = $2 AND lease_token = $3 AND ${JOURNAL_LIVE}
        AND ${JOURNAL_WAIT_OPEN} ${evidence ? 'AND expected_head_sha = $30' : ''}
      RETURNING run_id, generation`,
    [lease.runId, lease.generation, lease.token, p.purpose, p.repairCycle, p.headSha, p.key,
      change.state, regression?.workflowId ?? null, regression?.testIdentitySha256 ?? null,
      regression?.proposalSha256 ?? null, criterion ?? null, p.findingSha256, source, findingHead,
      p.priorCheckRunId ?? run.prior_check_run_id ?? null,
      p.priorReviewId ?? run.prior_review_id ?? null,
      change.hasExpectedHeadSha, change.expectedHeadSha, change.hasBranchName, change.branchName,
      change.hasPullRequestNumber, change.pullRequestNumber, change.hasLastCheckRunId, change.lastCheckRunId,
      change.hasReviewHeadSha, change.reviewHeadSha, change.hasBlockerCode, change.blockerCode,
      ...(evidence ? [evidence.headSha, evidence.workflowId, evidence.workflowRunId, evidence.checksSha256] : [])]);
    if (!rows.length) return false;
    await appendEvent(client, { runId: lease.runId, generation: lease.generation,
      eventType: 'checkpointed', state: change.state });
    return true;
  }

  async function checkpoint(leaseValue, changeValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const change = validateCheckpoint(changeValue);
    if (change.hasBranchName && change.branchName !== null &&
        change.branchName !== `agent-work/${lease.runId.toLowerCase()}`) fail();
    return withTransaction(pool, async (client) => {
      if (change.coordinator) return checkpointCoordinator(client, lease, change);
      const { rows } = await client.query(`
        UPDATE agent_worker.runs
        SET state = $4,
            expected_head_sha = CASE WHEN $5::boolean THEN $6::text ELSE expected_head_sha END,
            branch_name = CASE WHEN $7::boolean THEN $8::text ELSE branch_name END,
            pull_request_number = CASE WHEN $9::boolean THEN $10::bigint ELSE pull_request_number END,
            last_check_run_id = CASE WHEN $11::boolean THEN $12::bigint ELSE last_check_run_id END,
            review_head_sha = CASE WHEN $13::boolean THEN $14::text ELSE review_head_sha END,
            blocker_code = CASE WHEN $15::boolean THEN $16::text ELSE blocker_code END,
            lease_token = NULL,
            lease_started_at = NULL,
            lease_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE run_id = $1
          AND job_id = $17
          AND repository_id = $18
          AND repository_full_name = $19
          AND issue_id = $20
          AND issue_number = $21
          AND actor_id = $22
          AND (to_jsonb(runs)->>'coordinator_version') IS NULL
          AND generation = $2
          AND lease_token = $3
          AND terminal_at IS NULL
          AND lease_expires_at > clock_timestamp()
        RETURNING run_id, generation`,
      [
        lease.runId,
        lease.generation,
        lease.token,
        change.state,
        change.hasExpectedHeadSha,
        change.expectedHeadSha,
        change.hasBranchName,
        change.branchName,
        change.hasPullRequestNumber,
        change.pullRequestNumber,
        change.hasLastCheckRunId,
        change.lastCheckRunId,
        change.hasReviewHeadSha,
        change.reviewHeadSha,
        change.hasBlockerCode,
        change.blockerCode,
        lease.jobId,
        lease.repositoryId,
        lease.repositoryFullName,
        lease.issueId,
        lease.issueNumber,
        lease.actorId,
      ]);
      if (rows.length === 0) return false;

      await appendEvent(client, {
        runId: rows[0].run_id,
        generation: numberFromDatabase(rows[0].generation),
        eventType: 'checkpointed',
        state: change.state,
      });
      return true;
    }, databaseDeadline(waitOptions, lease));
  }

  async function putCoordinatorIntent(client, lease, intent) {
    const run = await selectOwnedRun(client, lease);
    if (!run || !liveJournalRun(run)) return { status: 'stale' };
    const c = intent.coordinator;
    if (run.coordinator_version !== 1 || c.phaseKey !== run.phase_key
        || c.purpose !== run.phase_purpose || c.repairCycle !== run.phase_round
        || intent.expectedHeadSha !== run.phase_head_sha) return { status: 'conflict' };
    if (!c.purpose.endsWith('_tests')
        && (JSON.stringify(canonical(c.expectedRegression)) !== JSON.stringify(canonical(regressionFromRow(run)))
          || c.criterionSha256 !== (run.criterion_sha256 ?? null))) return { status: 'conflict' };
    if (c.modelOperationId !== null) {
      const model = await client.query(`SELECT * FROM agent_worker.operations
        WHERE run_id = $1 AND operation_id = $2 FOR UPDATE`, [lease.runId, c.modelOperationId]);
      const m = model.rows[0];
      if (!m || m.run_id !== lease.runId || m.operation_id !== c.modelOperationId
          || m.kind !== 'model_call' || m.outcome_code !== 'success'
          || m.phase_key !== c.phaseKey || m.phase_purpose !== c.purpose
          || m.phase_round !== c.repairCycle || m.expected_head_sha !== intent.expectedHeadSha) {
        return { status: 'conflict' };
      }
    }
    const inserted = await client.query(`INSERT INTO agent_worker.operations
      (run_id, operation_key, kind, input_hash, expected_head_sha, coordinator_version,
       phase_purpose, phase_key, phase_round, model_operation_id, regression_workflow_id,
       regression_test_sha256, regression_proposal_sha256, criterion_sha256, descriptor_count)
      SELECT $1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13, $16
      FROM agent_worker.runs WHERE run_id = $1 AND generation = $14 AND lease_token = $15
        AND pending_operation_id IS NULL AND COALESCE(expected_head_sha, base_revision) = $5
        AND ${JOURNAL_LIVE}
      ON CONFLICT DO NOTHING RETURNING *`,
    [lease.runId, intent.key, intent.kind, intent.inputHash, intent.expectedHeadSha,
      c.purpose, c.phaseKey, c.repairCycle, c.modelOperationId,
      c.expectedRegression?.workflowId ?? null, c.expectedRegression?.testIdentitySha256 ?? null,
      c.expectedRegression?.proposalSha256 ?? null, c.criterionSha256, lease.generation, lease.token,
      intent.kind === 'commit_create' ? c.candidateDescriptors.length : null]);
    let stored = inserted.rows[0];
    if (!stored) {
      const prior = await client.query(`SELECT * FROM agent_worker.operations
        WHERE run_id = $1 AND operation_key = $2 FOR UPDATE`, [lease.runId, intent.key]);
      stored = prior.rows[0];
      if (!stored || stored.coordinator_version !== 1) return { status: 'conflict' };
      const files = await client.query(`SELECT * FROM agent_worker.candidate_descriptors
        WHERE run_id = $1 AND operation_id = $2 ORDER BY ordinal`, [lease.runId, stored.operation_id]);
      const operation = operationFromRow(stored, files.rows);
      const same = operation.kind === intent.kind && operation.inputHash === intent.inputHash
        && operation.expectedHeadSha === intent.expectedHeadSha
        && JSON.stringify(canonical(operation.coordinator)) === JSON.stringify(canonical(c))
        && (run.pending_operation_id === stored.operation_id || stored.effect_phase === 'confirmed');
      return { status: same ? 'existing' : 'conflict', operation };
    }
    for (const [ordinal, d] of c.candidateDescriptors.entries()) {
      await client.query(`INSERT INTO agent_worker.candidate_descriptors
        (run_id, operation_id, ordinal, approved_path_index, change_kind, before_blob_sha,
         after_blob_sha, content_sha256, byte_count, file_mode)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [lease.runId, stored.operation_id, ordinal, d.approvedPathIndex, d.operation,
        d.beforeBlobSha, d.afterBlobSha, d.contentSha256, d.bytes, d.mode]);
    }
    const updated = await client.query(`UPDATE agent_worker.runs
      SET pending_operation_id = $4, regression_workflow_id = $5,
          regression_test_sha256 = $6, regression_proposal_sha256 = $7,
          criterion_sha256 = $8, updated_at = clock_timestamp()
      WHERE run_id = $1 AND generation = $2 AND lease_token = $3
        AND pending_operation_id IS NULL AND ${JOURNAL_LIVE} RETURNING run_id`,
    [lease.runId, lease.generation, lease.token, stored.operation_id,
      c.expectedRegression?.workflowId ?? null, c.expectedRegression?.testIdentitySha256 ?? null,
      c.expectedRegression?.proposalSha256 ?? null, c.criterionSha256]);
    if (updated.rows.length !== 1) fail();
    await appendEvent(client, { runId: lease.runId, generation: lease.generation,
      eventType: 'intent_created', operationId: stored.operation_id });
    return { status: 'created', operation: { ...operationFromRow(stored), coordinator: c } };
  }

  async function putIntent(leaseValue, intentValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const intent = validateIntent(intentValue);
    return withTransaction(pool, async (client) => {
      if (intent.coordinator) return putCoordinatorIntent(client, lease, intent);
      const owner = await client.query(`
        SELECT runs.*
        FROM agent_worker.runs AS runs
        WHERE run_id = $1
          AND job_id = $2
          AND repository_id = $3
          AND repository_full_name = $4
          AND issue_id = $5
          AND issue_number = $6
          AND actor_id = $7
          AND generation = $8
          AND lease_token = $9
          AND terminal_at IS NULL
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE`,
      [
        lease.runId,
        lease.jobId,
        lease.repositoryId,
        lease.repositoryFullName,
        lease.issueId,
        lease.issueNumber,
        lease.actorId,
        lease.generation,
        lease.token,
      ]);
      if (owner.rows.length === 0) return { status: 'stale' };
      if (owner.rows[0].coordinator_version === 1) return { status: 'conflict' };

      const inserted = await client.query(`
        INSERT INTO agent_worker.operations
          (run_id, operation_key, kind, input_hash, expected_head_sha)
        SELECT $1, $2, $3, $4, $5
        WHERE EXISTS (
          SELECT 1
          FROM agent_worker.runs
          WHERE run_id = $1
            AND generation = $6
            AND lease_token = $7
            AND terminal_at IS NULL
            AND lease_expires_at > clock_timestamp()
            AND ($3::text = 'model_call' OR $5::text = CASE
              WHEN $3::text = 'branch_create' THEN base_revision
              ELSE COALESCE(expected_head_sha, base_revision)
            END)
        )
        ON CONFLICT DO NOTHING
        RETURNING operation_id, operation_key, kind, input_hash, expected_head_sha`,
      [lease.runId, intent.key, intent.kind, intent.inputHash, intent.expectedHeadSha,
        lease.generation, lease.token]);
      if (inserted.rows.length > 0) {
        const operation = operationFromRow(inserted.rows[0]);
        await appendEvent(client, {
          runId: lease.runId,
          generation: lease.generation,
          eventType: 'intent_created',
          operationId: operation.operationId,
        });
        return { status: 'created', operation };
      }

      const stillOwned = await client.query(`
        SELECT run_id
        FROM agent_worker.runs
        WHERE run_id = $1
          AND generation = $2
          AND lease_token = $3
          AND terminal_at IS NULL
          AND lease_expires_at > clock_timestamp()`,
      [lease.runId, lease.generation, lease.token]);
      if (stillOwned.rows.length === 0) return { status: 'stale' };

      const prior = await client.query(`
        SELECT operation_id, operation_key, kind, input_hash, expected_head_sha
        FROM agent_worker.operations
        WHERE run_id = $1 AND operation_key = $2`,
      [lease.runId, intent.key]);
      if (prior.rows.length === 0) return { status: 'conflict' };

      const operation = operationFromRow(prior.rows[0]);
      const same = operation.kind === intent.kind
        && operation.inputHash === intent.inputHash
        && operation.expectedHeadSha === intent.expectedHeadSha;
      return { status: same ? 'existing' : 'conflict', operation };
    }, databaseDeadline(waitOptions, lease));
  }

  async function selectIntent(client, lease, intent) {
    const { rows } = await client.query(`SELECT * FROM agent_worker.operations
      WHERE run_id = $1 AND operation_key = $2 FOR UPDATE`, [lease.runId, intent.key]);
    const operation = rows[0];
    if (!operation || operation.kind !== intent.kind
        || operation.input_hash !== intent.inputHash
        || operation.expected_head_sha !== intent.expectedHeadSha) return null;
    if (intent.coordinator) {
      if (operation.coordinator_version !== 1) return null;
      const files = await client.query(`SELECT * FROM agent_worker.candidate_descriptors
        WHERE run_id = $1 AND operation_id = $2 ORDER BY ordinal`, [lease.runId, operation.operation_id]);
      if (JSON.stringify(canonical(coordinatorFromRow(operation, files.rows)))
          !== JSON.stringify(canonical(intent.coordinator))) return null;
    }
    return operation;
  }

  async function fenceIntent(leaseValue, intentValue, phaseValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const intent = validateIntent(intentValue);
    const phase = validatePublicationPhase(phaseValue);
    if (!['commit_create', 'pr_create'].includes(intent.kind)
        || (phase !== 'probe' && (intent.kind === 'pr_create') !== (phase === 'pr'))) fail();
    return withTransaction(pool, async client => {
      const run = await selectOwnedRun(client, lease);
      if (!run) return { status: 'stale' };
      const operation = await selectIntent(client, lease, intent);
      if (!operation || (run.coordinator_version === 1
          && (operation.coordinator_version !== 1 || run.pending_operation_id !== operation.operation_id
            || run.phase_key !== operation.phase_key))) return { status: 'conflict' };
      const now = new Date(timestampFromDatabase(run.database_now)).getTime();
      if (now >= new Date(timestampFromDatabase(run.tick_deadline_at)).getTime()
          || now >= new Date(timestampFromDatabase(run.run_deadline_at)).getTime()) {
        return { status: 'blocked', blockerCode: 'recovery_deadline' };
      }
      const unresolved = await client.query(`SELECT operation_id FROM agent_worker.operations
        WHERE run_id = $1 AND kind = 'model_call' AND outcome_code IS NULL LIMIT 1`,
      [lease.runId]);
      if (unresolved.rows.length > 0) {
        return { status: 'blocked', blockerCode: 'model_outcome_uncertain' };
      }
      if (phase === 'probe') return { status: 'owned',
        decision: intent.kind === 'pr_create' && !operation.pr_attempted
          && operation.effect_phase === 'prepared' ? 'execute' : 'reconcile_only' };
      const column = phase === 'pr' ? 'pr_attempted'
        : phase === 'branch' ? 'branch_attempted' : 'commit_attempted';
      if (operation.effect_phase === 'confirmed' || operation[column]
          || (run.expected_head_sha ?? run.base_revision) !== intent.expectedHeadSha) {
        return { status: 'owned', decision: 'reconcile_only' };
      }
      const updated = await client.query(`UPDATE agent_worker.operations
        SET ${column} = true WHERE operation_id = $1 AND ${column} = false
          AND EXISTS (SELECT 1 FROM agent_worker.runs
            WHERE run_id = $2 AND generation = $3 AND lease_token = $4
              AND terminal_at IS NULL AND lease_expires_at > clock_timestamp()
              AND lease_started_at
                + ((limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second')
                > clock_timestamp()
              AND created_at
                + ((limits ->> 'runLifetimeSeconds')::double precision * interval '1 second')
                > clock_timestamp())
        RETURNING operation_id`, [operation.operation_id, lease.runId, lease.generation, lease.token]);
      if (updated.rows.length !== 1) fail();
      return { status: 'owned', decision: 'execute' };
    }, databaseDeadline(waitOptions, lease));
  }

  async function confirmIntent(leaseValue, intentValue, proofValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const intent = validateIntent(intentValue);
    const proof = validatePublicationProof(proofValue, lease, intent);
    return withTransaction(pool, async client => {
      const run = await selectOwnedRun(client, lease);
      if (!run) return false;
      const now = new Date(timestampFromDatabase(run.database_now)).getTime();
      if (now >= new Date(timestampFromDatabase(run.tick_deadline_at)).getTime()
          || now >= new Date(timestampFromDatabase(run.run_deadline_at)).getTime()) return false;
      const operation = await selectIntent(client, lease, intent);
      const isPr = intent.kind === 'pr_create';
      const reference = isPr ? String(proof.prNumber) : proof.commitSha;
      const head = isPr ? proof.headSha : proof.commitSha;
      if (!operation || (run.coordinator_version === 1 && operation.coordinator_version !== 1)
          || (operation.coordinator_version === 1 && operation.effect_phase !== 'confirmed'
            && (run.pending_operation_id !== operation.operation_id || run.phase_key !== operation.phase_key))
          || proof.baseSha !== run.base_revision
          || ![intent.expectedHeadSha, head].includes(run.expected_head_sha ?? run.base_revision)
          || (operation.effect_reference !== null && operation.effect_reference !== reference)
          || (isPr && run.pull_request_number !== null
            && numberFromDatabase(run.pull_request_number) !== proof.prNumber)) return false;
      if (operation.effect_phase === 'confirmed') return true;
      await client.query(`UPDATE agent_worker.operations
        SET effect_phase = 'confirmed', effect_reference = $2 WHERE operation_id = $1`,
      [operation.operation_id, reference]);
      const state = isPr ? 'waiting_review'
        : operation.coordinator_version === 1 && ['initial_tests', 'repair_tests'].includes(operation.phase_purpose)
          ? 'waiting_red_ci' : 'waiting_ci';
      const updated = await client.query(`UPDATE agent_worker.runs
        SET expected_head_sha = $4, branch_name = $5, state = $6,
            pull_request_number = CASE WHEN $7::boolean THEN $8::bigint ELSE pull_request_number END,
            ${operation.coordinator_version === 1
              ? 'pending_operation_id = NULL, wait_started_at = COALESCE(wait_started_at, clock_timestamp()),' : ''}
            updated_at = clock_timestamp()
        WHERE run_id = $1 AND generation = $2 AND lease_token = $3
          AND terminal_at IS NULL AND lease_expires_at > clock_timestamp()
          AND lease_started_at
            + ((limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second')
            > clock_timestamp()
          AND created_at
            + ((limits ->> 'runLifetimeSeconds')::double precision * interval '1 second')
            > clock_timestamp()
        RETURNING run_id`,
      [lease.runId, lease.generation, lease.token, head, proof.branch, state,
        isPr, isPr ? proof.prNumber : null]);
      if (updated.rows.length !== 1) fail();
      await appendEvent(client, { runId: lease.runId, generation: lease.generation,
        eventType: 'checkpointed', operationId: operation.operation_id, state });
      return true;
    }, databaseDeadline(waitOptions, lease));
  }

  async function reserveModelCall(leaseValue, requestValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const request = validateModelCallInput(requestValue);
    return withTransaction(pool, async (client) => {
      const run = await selectOwnedRun(client, lease);
      if (!run) return { status: 'stale', canExecute: false };
      if (run.coordinator_version === 1) {
        if (!liveJournalRun(run)) return { status: 'stale', canExecute: false };
        if (run.pending_operation_id !== null) return { status: 'blocked', canExecute: false,
          blockerCode: 'coordinator_pending_effect' };
        const prior = await client.query(`SELECT * FROM agent_worker.operations
          WHERE run_id = $1 AND phase_key = $2 AND kind = 'model_call' FOR UPDATE`,
        [lease.runId, run.phase_key]);
        if (prior.rows.length > 0) {
          const blockerCode = prior.rows[0].outcome_code === 'success'
            ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain';
          const stopped = await stopForBudget(client, lease, blockerCode, { journal: true });
          return stopped ? { status: 'needs_attention', canExecute: false, blockerCode }
            : { status: 'stale', canExecute: false };
        }
        if (request.expectedHeadSha !== run.phase_head_sha
            || !['generating_tests', 'implementing', 'repairing'].includes(run.state)
            || run.phase_purpose === 'draft_pr') return { status: 'conflict', canExecute: false };
      }

      const limits = validateLimitsFromRow(run.limits);
      const priorRows = await client.query(`
        SELECT operation_id, kind, input_hash, expected_head_sha,
          reserved_input_tokens, reserved_output_tokens, requested_output_tokens,
          call_deadline_at
        FROM agent_worker.operations
        WHERE run_id = $1 AND operation_key = $2
        FOR UPDATE`,
      [lease.runId, request.key]);
      if (priorRows.rows.length > 0) {
        const prior = priorRows.rows[0];
        const sameBudget = prior.reserved_input_tokens === null
          || (numberFromDatabase(prior.reserved_input_tokens) === request.inputTokens
            && numberFromDatabase(prior.requested_output_tokens)
              === Math.min(request.outputTokens, limits.outputTokensPerCall));
        const same = prior.kind === 'model_call'
          && prior.input_hash === request.inputHash
          && prior.expected_head_sha === request.expectedHeadSha
          && sameBudget;
        return {
          status: same ? 'existing' : 'conflict',
          canExecute: false,
          operationId: prior.operation_id,
        };
      }

      const databaseNow = new Date(timestampFromDatabase(run.database_now)).getTime();
      if (databaseNow >= new Date(timestampFromDatabase(run.run_deadline_at)).getTime()) {
        const stopped = await stopForBudget(client, lease, 'model_run_deadline');
        return stopped
          ? { status: 'needs_attention', canExecute: false, blockerCode: 'model_run_deadline' }
          : { status: 'stale', canExecute: false };
      }
      if (databaseNow >= new Date(timestampFromDatabase(run.tick_deadline_at)).getTime()) {
        const stopped = await stopForBudget(client, lease, 'model_tick_deadline');
        return stopped
          ? { status: 'needs_attention', canExecute: false, blockerCode: 'model_tick_deadline' }
          : { status: 'stale', canExecute: false };
      }

      const unresolvedCalls = await client.query(`
        SELECT operation_id
        FROM agent_worker.operations
        WHERE run_id = $1
          AND kind = 'model_call'
          AND reserved_input_tokens IS NOT NULL
          AND outcome_code IS NULL
          AND operation_key <> $2
        LIMIT 1`,
      [lease.runId, request.key]);
      if (unresolvedCalls.rows.length > 0) {
        const stopped = await stopForBudget(client, lease, 'model_outcome_uncertain');
        return stopped
          ? { status: 'needs_attention', canExecute: false, blockerCode: 'model_outcome_uncertain' }
          : { status: 'stale', canExecute: false };
      }

      const generationCalls = await client.query(`
        SELECT operation_id
        FROM agent_worker.operations
        WHERE run_id = $1 AND kind = 'model_call' AND owner_generation = $2
        LIMIT 1`,
      [lease.runId, lease.generation]);
      if (generationCalls.rows.length > 0
          || numberFromDatabase(run.model_call_count) >= limits.modelCallsPerRun) {
        const stopped = await stopForBudget(client, lease, 'model_call_budget_exhausted');
        return stopped
          ? { status: 'needs_attention', canExecute: false, blockerCode: 'model_call_budget_exhausted' }
          : { status: 'stale', canExecute: false };
      }

      if (request.inputTokens > limits.inputTokensPerCall) {
        const stopped = await stopForBudget(client, lease, 'model_input_token_limit');
        return stopped
          ? { status: 'needs_attention', canExecute: false, blockerCode: 'model_input_token_limit' }
          : { status: 'stale', canExecute: false };
      }

      const reservedInputTokens = numberFromDatabase(run.reserved_input_tokens);
      const reservedOutputTokens = numberFromDatabase(run.reserved_output_tokens);
      if (reservedInputTokens + request.inputTokens > limits.inputTokensPerRun) {
        const stopped = await stopForBudget(client, lease, 'model_token_budget_exhausted');
        return stopped
          ? { status: 'needs_attention', canExecute: false, blockerCode: 'model_token_budget_exhausted' }
          : { status: 'stale', canExecute: false };
      }
      const requestedOutputTokens = Math.min(request.outputTokens, limits.outputTokensPerCall);
      const outputTokens = Math.min(
        requestedOutputTokens,
        limits.outputTokensPerRun - reservedOutputTokens,
      );
      if (outputTokens < 1) {
        const stopped = await stopForBudget(client, lease, 'model_token_budget_exhausted');
        return stopped
          ? { status: 'needs_attention', canExecute: false, blockerCode: 'model_token_budget_exhausted' }
          : { status: 'stale', canExecute: false };
      }

      const inserted = await client.query(`
        INSERT INTO agent_worker.operations
          (run_id, operation_key, kind, input_hash, expected_head_sha,
           owner_generation, reserved_input_tokens, reserved_output_tokens,
           requested_output_tokens, call_deadline_at${run.coordinator_version === 1
            ? ', coordinator_version, phase_purpose, phase_key, phase_round' : ''})
        SELECT runs.run_id, $2, 'model_call', $3, $4, $5, $6, $7, $8,
          LEAST(
            clock_timestamp()
              + ((runs.limits ->> 'modelCallDeadlineSeconds')::double precision * interval '1 second'),
            runs.lease_started_at
              + ((runs.limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second'),
            runs.created_at
              + ((runs.limits ->> 'runLifetimeSeconds')::double precision * interval '1 second'),
            runs.lease_expires_at
          )${run.coordinator_version === 1 ? ', 1, $10, $11, $12' : ''}
        FROM agent_worker.runs AS runs
        WHERE runs.run_id = $1
          AND runs.generation = $5
          AND runs.lease_token = $9
          AND runs.terminal_at IS NULL
          AND runs.lease_expires_at > clock_timestamp()
          AND LEAST(
            clock_timestamp()
              + ((runs.limits ->> 'modelCallDeadlineSeconds')::double precision * interval '1 second'),
            runs.lease_started_at
              + ((runs.limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second'),
            runs.created_at
              + ((runs.limits ->> 'runLifetimeSeconds')::double precision * interval '1 second'),
            runs.lease_expires_at
          ) > clock_timestamp()
        RETURNING operation_id, call_deadline_at`,
      [lease.runId, request.key, request.inputHash, request.expectedHeadSha,
        lease.generation, request.inputTokens, outputTokens, requestedOutputTokens, lease.token,
        ...(run.coordinator_version === 1 ? [run.phase_purpose, run.phase_key, run.phase_round] : [])]);
      if (inserted.rows.length === 0) return { status: 'stale', canExecute: false };

      const updated = await client.query(`
        UPDATE agent_worker.runs
        SET model_call_count = model_call_count + 1,
            reserved_input_tokens = reserved_input_tokens + $4,
            reserved_output_tokens = reserved_output_tokens + $5,
            updated_at = clock_timestamp()
        WHERE run_id = $1
          AND generation = $2
          AND lease_token = $3
          AND terminal_at IS NULL
          AND lease_expires_at > clock_timestamp()
          AND model_call_count < (limits ->> 'modelCallsPerRun')::integer
          AND reserved_input_tokens + $4 <= (limits ->> 'inputTokensPerRun')::integer
          AND reserved_output_tokens + $5 <= (limits ->> 'outputTokensPerRun')::integer
        RETURNING run_id`,
      [lease.runId, lease.generation, lease.token, request.inputTokens, outputTokens]);
      if (updated.rows.length !== 1) fail();

      await appendEvent(client, {
        runId: lease.runId,
        generation: lease.generation,
        eventType: 'model_call_reserved',
        operationId: inserted.rows[0].operation_id,
      });
      return {
        status: 'reserved',
        canExecute: true,
        operationId: inserted.rows[0].operation_id,
        inputTokens: request.inputTokens,
        outputTokens,
        deadlineAt: timestampFromDatabase(inserted.rows[0].call_deadline_at),
      };
    }, databaseDeadline(waitOptions, lease));
  }

  async function recordModelCallOutcome(leaseValue, outcomeValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const input = validateModelCallOutcomeInput(outcomeValue);
    let normalized;
    try {
      normalized = normalizeModelCallOutcome(input.outcomeInput);
    } catch {
      fail();
    }

    return withTransaction(pool, async (client) => {
      const initial = await client.query(`
        SELECT operation_id, owner_generation, reserved_input_tokens,
          reserved_output_tokens, call_deadline_at, outcome_code, outcome_blocker_code,
          actual_input_tokens, actual_output_tokens
        FROM agent_worker.operations
        WHERE operation_id = $1 AND run_id = $2 AND kind = 'model_call'
          AND owner_generation = $3 AND reserved_input_tokens IS NOT NULL`,
      [input.operationId, lease.runId, lease.generation]);
      if (initial.rows.length === 0) return { status: 'stale' };

      const initialOperation = initial.rows[0];
      const reported = normalizeUsageAgainstReservation(normalized, initialOperation);
      if (initialOperation.outcome_code !== null) {
        return outcomeReplay(initialOperation, reported);
      }

      const run = await selectOwnedRun(client, lease);
      if (!run) return { status: 'stale' };
      const currentRows = await client.query(`
        SELECT operation_id, owner_generation, reserved_input_tokens,
          reserved_output_tokens, call_deadline_at, outcome_code, outcome_blocker_code,
          actual_input_tokens, actual_output_tokens
        FROM agent_worker.operations
        WHERE operation_id = $1 AND run_id = $2 AND kind = 'model_call'
          AND owner_generation = $3 AND reserved_input_tokens IS NOT NULL
        FOR UPDATE`,
      [input.operationId, lease.runId, lease.generation]);
      if (currentRows.rows.length === 0) return { status: 'stale' };
      const operation = currentRows.rows[0];
      if (operation.outcome_code !== null) return outcomeReplay(operation, reported);

      let recorded = normalizeUsageAgainstReservation(normalized, operation);
      let blockerCode = recorded.blockerCode;
      const databaseNow = new Date(timestampFromDatabase(run.database_now)).getTime();
      const runDeadline = new Date(timestampFromDatabase(run.run_deadline_at)).getTime();
      const tickDeadline = new Date(timestampFromDatabase(run.tick_deadline_at)).getTime();
      const callDeadline = new Date(timestampFromDatabase(operation.call_deadline_at)).getTime();
      if (databaseNow >= runDeadline) {
        recorded = { ...recorded, outcome: 'deadline' };
        blockerCode = 'model_run_deadline';
      } else if (databaseNow >= tickDeadline) {
        recorded = { ...recorded, outcome: 'deadline' };
        blockerCode = 'model_tick_deadline';
      } else if (databaseNow >= callDeadline) {
        recorded = { ...recorded, outcome: 'deadline' };
        blockerCode = 'model_call_deadline';
      }

      const updated = await client.query(`
        UPDATE agent_worker.operations
        SET outcome_code = $2,
            outcome_blocker_code = $3,
            actual_input_tokens = $4,
            actual_output_tokens = $5
        WHERE operation_id = $1 AND outcome_code IS NULL
        RETURNING operation_id`,
      [input.operationId, recorded.outcome, blockerCode,
        recorded.actualInputTokens, recorded.actualOutputTokens]);
      if (updated.rows.length !== 1) fail();

      const stopped = blockerCode === null ? false : await stopForBudget(
        client,
        lease,
        blockerCode,
        { operationId: input.operationId },
      );
      if (blockerCode !== null && !stopped) fail();
      await appendEvent(client, {
        runId: lease.runId,
        generation: lease.generation,
        eventType: 'model_call_outcome',
        operationId: input.operationId,
        state: blockerCode === null ? run.state : 'needs_attention',
      });
      return blockerCode === null
        ? { status: 'recorded', outcome: recorded.outcome, blockerCode: null }
        : { status: 'needs_attention', outcome: recorded.outcome, blockerCode };
    }, databaseDeadline(waitOptions, lease));
  }

  async function beginRepair(leaseValue, requestValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const request = validateBeginRepairInput(requestValue);
    return withTransaction(pool, async client => {
      const run = await selectOwnedRun(client, lease);
      if (!run || !liveJournalRun(run)) return { status: 'stale', canRepair: false };
      if (run.coordinator_version !== 1 || run.pending_operation_id !== null) {
        return { status: 'conflict', canRepair: false };
      }
      const prior = await client.query(`SELECT event_type, repair_key, repair_source,
          repair_head_sha, repair_finding_sha256
        FROM agent_worker.events WHERE run_id = $1 AND (repair_key = $2
          OR (repair_source = $3 AND repair_head_sha = $4 AND repair_finding_sha256 = $5))
        ORDER BY event_id LIMIT 1`,
      [lease.runId, request.key, request.source, request.headSha, request.findingSha256]);
      if (prior.rows.length) {
        const p = prior.rows[0];
        const same = p.event_type === 'repair_reserved' && p.repair_key === request.key
          && p.repair_source === request.source && p.repair_head_sha === request.headSha
          && p.repair_finding_sha256 === request.findingSha256;
        return { status: same ? 'existing' : 'conflict', canRepair: false };
      }
      if (request.headSha !== (run.expected_head_sha ?? run.base_revision)
          || !['waiting_ci', 'waiting_review'].includes(run.state)
          || (request.source === 'ci' ? run.state !== 'waiting_ci' : run.state !== 'waiting_review')) {
        return { status: 'conflict', canRepair: false };
      }
      const limits = validateLimitsFromRow(run.limits);
      if (numberFromDatabase(run.repair_cycle_count) >= limits.repairCycles) {
        const stopped = await stopForBudget(client, lease, 'repair_cycle_limit', {
          eventType: 'repair_limit_reached', repair: request, journal: true });
        return stopped ? { status: 'needs_attention', canRepair: false, blockerCode: 'repair_cycle_limit' }
          : { status: 'stale', canRepair: false };
      }
      const repairCycleCount = numberFromDatabase(run.repair_cycle_count) + 1;
      const key = buildCoordinatorPhaseKey({ runId: lease.runId, manifestSha256: run.manifest_hash,
        purpose: 'repair_investigation', repairCycle: repairCycleCount,
        headSha: request.headSha, findingSha256: request.findingSha256 });
      const updated = await client.query(`UPDATE agent_worker.runs
        SET repair_cycle_count = repair_cycle_count + 1, phase_round = $4,
            phase_purpose = $5, phase_key = $6, phase_head_sha = $7,
            phase_started_at = clock_timestamp(), wait_started_at = NULL,
            finding_source = $8, finding_head_sha = $7, finding_sha256 = $9,
            ${request.evidence ? `last_check_head_sha = $10, last_workflow_id = $11,
              last_workflow_run_id = $12, last_check_run_id = $13, prior_check_run_id = $13,
              check_evidence_sha256 = $14, prior_review_id = COALESCE($15, prior_review_id),
              review_head_sha = CASE WHEN $15::bigint IS NOT NULL THEN $10 ELSE review_head_sha END,` : ''}
            state = 'repairing', lease_token = NULL, lease_started_at = NULL,
            lease_expires_at = NULL, updated_at = clock_timestamp()
        WHERE run_id = $1 AND generation = $2 AND lease_token = $3
          AND repair_cycle_count < (limits ->> 'repairCycles')::integer
          AND pending_operation_id IS NULL AND ${JOURNAL_LIVE} AND ${JOURNAL_WAIT_OPEN}
          ${request.evidence ? 'AND expected_head_sha = $10' : ''}
        RETURNING repair_cycle_count`,
      [lease.runId, lease.generation, lease.token, repairCycleCount, 'repair_investigation', key,
        request.headSha, request.source, request.findingSha256,
        ...(request.evidence ? [request.evidence.headSha, request.evidence.workflowId,
          request.evidence.workflowRunId, request.evidence.checkRunId,
          request.evidence.checksSha256, request.evidence.reviewId] : [])]);
      if (updated.rows.length !== 1) fail();
      await appendEvent(client, { runId: lease.runId, generation: lease.generation,
        eventType: 'repair_reserved', repairKey: request.key, repairSource: request.source,
        repairHeadSha: request.headSha, repairFindingSha256: request.findingSha256 });
      return { status: 'reserved', canRepair: true, repairCycleCount, phaseKey: key };
    }, databaseDeadline(waitOptions, lease));
  }

  async function reserveRepairCycle(leaseValue, requestValue, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const request = validateRepairInput(requestValue);
    return withTransaction(pool, async (client) => {
      const run = await selectOwnedRun(client, lease);
      if (!run) return { status: 'stale', canRepair: false };
      if (run.coordinator_version === 1) return { status: 'conflict', canRepair: false };

      const priorRows = await client.query(`
        SELECT event_type, repair_source, repair_head_sha
        FROM agent_worker.events
        WHERE run_id = $1 AND repair_key = $2
        LIMIT 1`,
      [lease.runId, request.key]);
      if (priorRows.rows.length > 0) {
        const prior = priorRows.rows[0];
        const same = prior.repair_source === request.source
          && prior.repair_head_sha === request.headSha;
        return {
          status: same && prior.event_type === 'repair_reserved' ? 'existing' : 'conflict',
          canRepair: false,
        };
      }

      const knownHead = run.expected_head_sha ?? run.base_revision;
      if (request.headSha !== knownHead) return { status: 'conflict', canRepair: false };
      const limits = validateLimitsFromRow(run.limits);
      if (numberFromDatabase(run.repair_cycle_count) >= limits.repairCycles) {
        const stopped = await stopForBudget(client, lease, 'repair_cycle_limit', {
          eventType: 'repair_limit_reached',
          repair: request,
        });
        return stopped
          ? { status: 'needs_attention', canRepair: false, blockerCode: 'repair_cycle_limit' }
          : { status: 'stale', canRepair: false };
      }

      const updated = await client.query(`
        UPDATE agent_worker.runs
        SET repair_cycle_count = repair_cycle_count + 1,
            updated_at = clock_timestamp()
        WHERE run_id = $1
          AND generation = $2
          AND lease_token = $3
          AND terminal_at IS NULL
          AND lease_expires_at > clock_timestamp()
          AND repair_cycle_count < (limits ->> 'repairCycles')::integer
        RETURNING repair_cycle_count`,
      [lease.runId, lease.generation, lease.token]);
      if (updated.rows.length !== 1) fail();
      await appendEvent(client, {
        runId: lease.runId,
        generation: lease.generation,
        eventType: 'repair_reserved',
        repairKey: request.key,
        repairSource: request.source,
        repairHeadSha: request.headSha,
      });
      return {
        status: 'reserved',
        canRepair: true,
        repairCycleCount: numberFromDatabase(updated.rows[0].repair_cycle_count),
      };
    }, databaseDeadline(waitOptions, lease));
  }

  async function finishRun(leaseValue, terminalState, optionsValue = {}, waitOptions = {}) {
    const lease = validateLease(leaseValue);
    const finish = validateFinishInput(terminalState, optionsValue);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(`
        UPDATE agent_worker.runs
        SET state = $4,
            blocker_code = CASE WHEN $5::boolean THEN $6::text ELSE NULL END,
            ${finish.evidence ? `last_check_head_sha = $13, last_workflow_id = $14,
              last_workflow_run_id = $15, last_check_run_id = $16, prior_check_run_id = $16,
              check_evidence_sha256 = $17, review_head_sha = $13, prior_review_id = $18,` : ''}
            lease_token = NULL,
            lease_started_at = NULL,
            lease_expires_at = NULL,
            terminal_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE run_id = $1
          AND job_id = $7
          AND repository_id = $8
          AND repository_full_name = $9
          AND issue_id = $10
          AND issue_number = $11
          AND actor_id = $12
          AND generation = $2
          AND lease_token = $3
          AND terminal_at IS NULL
          AND lease_expires_at > clock_timestamp()
          AND lease_started_at
            + ((limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second')
            > clock_timestamp()
          AND created_at
            + ((limits ->> 'runLifetimeSeconds')::double precision * interval '1 second')
            > clock_timestamp()
          ${finish.evidence ? `AND coordinator_version = 1 AND state = 'waiting_review'
            AND pending_operation_id IS NULL AND expected_head_sha = $13
            AND regression_workflow_id = $14 AND ${JOURNAL_WAIT_OPEN}`
            : `AND ($4::text <> 'ready_for_human'
              OR COALESCE((to_jsonb(runs)->>'coordinator_version')::integer, 0) <> 1)`}
        RETURNING run_id, generation`,
      [
        lease.runId,
        lease.generation,
        lease.token,
        finish.state,
        finish.hasBlockerCode,
        finish.blockerCode,
        lease.jobId,
        lease.repositoryId,
        lease.repositoryFullName,
        lease.issueId,
        lease.issueNumber,
        lease.actorId,
        ...(finish.evidence ? [finish.evidence.headSha, finish.evidence.workflowId,
          finish.evidence.workflowRunId, finish.evidence.checkRunId,
          finish.evidence.checksSha256, finish.evidence.reviewId] : []),
      ]);
      if (rows.length === 0) return false;

      await appendEvent(client, {
        runId: rows[0].run_id,
        generation: numberFromDatabase(rows[0].generation),
        eventType: 'run_terminal',
        state: finish.state,
      });
      return true;
    }, databaseDeadline(waitOptions, lease));
  }

  async function getRun(runIdValue, waitOptions = {}) {
    const runId = validateRunId(runIdValue);
    const budget = databaseDeadline(waitOptions);
    let client;
    let discard = false;
    try {
      client = await acquireClient(pool, budget);
      const { rows } = await budget.wait(() => client.query({
        text: `
          SELECT run_id, job_id, repository_id, repository_full_name, issue_id,
            issue_number, actor_id, manifest_hash, base_revision, policy_revision,
            limits, state, generation, recovery_count, model_call_count,
            reserved_input_tokens, reserved_output_tokens, repair_cycle_count,
            lease_expires_at, expected_head_sha, branch_name, pull_request_number,
            last_check_run_id, review_head_sha, blocker_code, created_at,
            updated_at, terminal_at,
            to_jsonb(runs)->>'last_check_head_sha' AS last_check_head_sha,
            to_jsonb(runs)->>'last_workflow_id' AS last_workflow_id,
            to_jsonb(runs)->>'last_workflow_run_id' AS last_workflow_run_id,
            to_jsonb(runs)->>'check_evidence_sha256' AS check_evidence_sha256,
            to_jsonb(runs)->>'prior_review_id' AS prior_review_id,
            lease_started_at
              + ((limits ->> 'tickDeadlineSeconds')::double precision * interval '1 second')
              AS tick_deadline_at,
            created_at
              + ((limits ->> 'runLifetimeSeconds')::double precision * interval '1 second')
              AS run_deadline_at
          FROM agent_worker.runs
          WHERE run_id = $1`,
        values: [runId],
        query_timeout: Math.max(1, budget.deadline - Date.now()),
      }));
      return rows.length === 0 ? null : runFromRow(rows[0]);
    } catch {
      discard = true;
      fail();
    } finally {
      budget.close();
      if (client) {
        try { releaseClient(client, discard ? new Error(SAFE_ERROR) : undefined); } catch { fail(); }
      }
    }
  }

  const reviewRequests = createReviewRequestMethods({
    transaction: (lease, options, operation) => withTransaction(pool, operation, databaseDeadline(options, lease)),
    liveSql: `${JOURNAL_LIVE} AND ${JOURNAL_WAIT_OPEN}`,
  });

  return Object.freeze({
    ...reviewRequests,
    claimTick,
    checkpoint,
    putIntent,
    fenceIntent,
    confirmIntent,
    reserveModelCall,
    recordModelCallOutcome,
    reserveRepairCycle,
    finishRun,
    getRun,
    getCoordinatorSnapshot,
    beginRepair,
  });
}
