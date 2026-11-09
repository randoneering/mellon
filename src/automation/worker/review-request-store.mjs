import { fail, validateLease } from './store-validation.mjs';

const ID = value => Number.isSafeInteger(value) && value > 0;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
const FIELDS = ['headSha', 'identitySha256', 'actorId', 'actorLogin', 'appId', 'pullRequestNumber'];
function validate(value, extras = []) {
  const keys = [...FIELDS, ...extras];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
    || !SHA1.test(value.headSha ?? '') || !SHA256.test(value.identitySha256 ?? '')
    || !ID(value.actorId) || !ID(value.appId) || !ID(value.pullRequestNumber)
    || typeof value.actorLogin !== 'string' || !LOGIN.test(value.actorLogin)
    || extras.includes('commentId') && !ID(value.commentId)
    || extras.includes('source') && !['qodo', 'maintainer'].includes(value.source)
    || extras.includes('reviewId') && !ID(value.reviewId)) fail();
  return Object.freeze({ ...value });
}
function project(row) {
  if (!row) return null;
  const number = value => { const result = Number(value); if (!ID(result)) fail(); return result; };
  return Object.freeze({ runId: row.run_id, headSha: row.head_sha,
    repositoryId: number(row.repository_id), repositoryFullName: row.repository_full_name,
    pullRequestNumber: number(row.pull_request_number), actorId: number(row.actor_id),
    actorLogin: row.actor_login, appId: number(row.app_id), identitySha256: row.identity_sha256,
    leaseGeneration: number(row.lease_generation), attempted: row.attempted,
    commentId: row.comment_id == null ? null : number(row.comment_id),
    evidenceSource: row.evidence_source, nativeReviewId: row.native_review_id == null ? null : number(row.native_review_id) });
}
function matches(row, input) {
  return row.identity_sha256 === input.identitySha256 && Number(row.actor_id) === input.actorId
    && row.actor_login === input.actorLogin && Number(row.app_id) === input.appId
    && Number(row.pull_request_number) === input.pullRequestNumber;
}

export function createReviewRequestMethods({ transaction, liveSql }) {
  const live = `EXISTS (SELECT 1 FROM agent_worker.runs WHERE run_id=$1 AND ${liveSql})`;
  async function parent(client, lease, headSha) {
    const { rows } = await client.query(`SELECT * FROM agent_worker.runs
      WHERE run_id=$1 AND job_id=$2 AND repository_id=$3 AND repository_full_name=$4
        AND issue_id=$5 AND issue_number=$6 AND actor_id=$7 AND generation=$8 AND lease_token=$9
        AND ${liveSql} AND state='waiting_review' AND pending_operation_id IS NULL
        AND expected_head_sha=$10 AND branch_name='agent-work/' || run_id::text
        AND last_check_head_sha=expected_head_sha AND check_evidence_sha256 IS NOT NULL
        AND EXISTS (SELECT 1 FROM agent_worker.operations o WHERE o.run_id=runs.run_id
          AND o.kind='commit_create' AND o.effect_phase='confirmed' AND o.effect_reference=runs.expected_head_sha)
        AND EXISTS (SELECT 1 FROM agent_worker.operations o WHERE o.run_id=runs.run_id
          AND o.kind='pr_create' AND o.effect_phase='confirmed' AND o.effect_reference=runs.pull_request_number::text)
      FOR UPDATE`, [lease.runId, lease.jobId, lease.repositoryId, lease.repositoryFullName,
      lease.issueId, lease.issueNumber, lease.actorId, lease.generation, lease.token, headSha]);
    return rows[0] ?? null;
  }
  async function mutate(leaseValue, inputValue, action, options) {
    const lease = validateLease(leaseValue);
    const input = validate(inputValue, action === 'confirm' ? ['commentId'] : action === 'evidence' ? ['source', 'reviewId'] : []);
    return transaction(lease, options, async client => {
      const run = await parent(client, lease, input.headSha);
      if (!run) return null;
      if (Number(run.pull_request_number) !== input.pullRequestNumber) fail();
      if (action === 'reserve') {
        await client.query(`INSERT INTO agent_worker.review_requests
          (run_id,head_sha,repository_id,repository_full_name,pull_request_number,actor_id,
           actor_login,app_id,identity_sha256,lease_generation)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE ${live}
          ON CONFLICT (run_id,head_sha) DO NOTHING`, [lease.runId, input.headSha,
          lease.repositoryId, lease.repositoryFullName, input.pullRequestNumber, input.actorId,
          input.actorLogin, input.appId, input.identitySha256, lease.generation]);
      }
      const { rows } = await client.query(`SELECT * FROM agent_worker.review_requests
        WHERE run_id=$1 AND head_sha=$2 FOR UPDATE`, [lease.runId, input.headSha]);
      const row = rows[0];
      if (!row) return null;
      if (!matches(row, input)) fail();
      if (action === 'reserve') return project(row);
      if (action === 'attempt' && row.attempted) return Object.freeze({ ...project(row), canExecute: false });
      if (action === 'confirm' && (!row.attempted || row.comment_id != null && Number(row.comment_id) !== input.commentId)) fail();
      if (action === 'evidence' && (!row.attempted || row.comment_id == null
        || row.evidence_source != null && (row.evidence_source !== input.source || Number(row.native_review_id) !== input.reviewId))) fail();
      let query, args;
      if (action === 'attempt') {
        query = `UPDATE agent_worker.review_requests SET attempted=true,attempted_generation=$3,updated_at=clock_timestamp()
          WHERE run_id=$1 AND head_sha=$2 AND NOT attempted AND ${live} RETURNING *`;
        args = [lease.runId, input.headSha, lease.generation];
      } else if (action === 'confirm') {
        query = `UPDATE agent_worker.review_requests SET comment_id=$3,updated_at=clock_timestamp()
          WHERE run_id=$1 AND head_sha=$2 AND ${live} RETURNING *`;
        args = [lease.runId, input.headSha, input.commentId];
      } else {
        query = `UPDATE agent_worker.review_requests SET evidence_source=$3,native_review_id=$4,updated_at=clock_timestamp()
          WHERE run_id=$1 AND head_sha=$2 AND ${live} RETURNING *`;
        args = [lease.runId, input.headSha, input.source, input.reviewId];
      }
      const changed = (await client.query(query, args)).rows[0];
      return changed ? Object.freeze({ ...project(changed), ...(action === 'attempt' ? { canExecute: true } : {}) }) : null;
    });
  }
  return Object.freeze({
    reserveReviewRequest: (lease, input, options = {}) => mutate(lease, input, 'reserve', options),
    attemptReviewRequest: (lease, input, options = {}) => mutate(lease, input, 'attempt', options),
    confirmReviewRequest: (lease, input, options = {}) => mutate(lease, input, 'confirm', options),
    recordReviewEvidence: (lease, input, options = {}) => mutate(lease, input, 'evidence', options),
    async getReviewRequest(leaseValue, headSha, options = {}) {
      const lease = validateLease(leaseValue);
      if (!SHA1.test(headSha ?? '')) fail();
      return transaction(lease, options, async client => {
        if (!await parent(client, lease, headSha)) return null;
        const { rows } = await client.query('SELECT * FROM agent_worker.review_requests WHERE run_id=$1 AND head_sha=$2', [lease.runId, headSha]);
        return project(rows[0]);
      });
    },
  });
}
