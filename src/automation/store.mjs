import { randomUUID } from 'node:crypto';
import { InputError, positiveId, validRepository } from './http.mjs';

const SAFE_ERROR = 'Intake persistence unavailable.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;

function validRecord(record) {
  return validRepository({ id: record?.repositoryId, fullName: record?.repositoryFullName }) &&
    positiveId(record.issueId) && positiveId(record.issueNumber) && positiveId(record.actorId) &&
    UUID.test(record.deliveryId ?? '') && DIGEST.test(record.bodyHash ?? '');
}

export function createStore(pool) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') {
    throw new Error('Invalid intake store configuration.');
  }
  return {
    async getDelivery(deliveryId) {
      if (!UUID.test(deliveryId ?? '')) throw new InputError(400);
      try {
        const { rows } = await pool.query({
          text: 'SELECT body_hash FROM agent_intake.deliveries WHERE delivery_id = $1',
          values: [deliveryId], query_timeout: 10000,
        });
        if (!rows.length) return null;
        if (!DIGEST.test(rows[0].body_hash)) throw new Error(SAFE_ERROR);
        return { bodyHash: rows[0].body_hash };
      } catch { throw new Error(SAFE_ERROR); }
    },
    async enqueue(record) {
      if (!validRecord(record)) throw new InputError(400);
      let client;
      let discard = false;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        const inserted = await client.query(
          'INSERT INTO agent_intake.jobs (job_id, repository_id, repository_full_name, issue_id, issue_number, actor_id, initial_delivery_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (repository_id, issue_id) DO NOTHING RETURNING job_id',
          [randomUUID(), record.repositoryId, record.repositoryFullName, record.issueId, record.issueNumber, record.actorId, record.deliveryId],
        );
        const created = inserted.rows.length === 1;
        const jobs = created ? inserted : await client.query(
          'SELECT job_id FROM agent_intake.jobs WHERE repository_id = $1 AND issue_id = $2',
          [record.repositoryId, record.issueId],
        );
        const jobId = jobs.rows[0]?.job_id;
        if (!jobId) throw new Error(SAFE_ERROR);
        const receipt = await client.query(
          'INSERT INTO agent_intake.deliveries (delivery_id, body_hash, job_id) VALUES ($1,$2,$3) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id',
          [record.deliveryId, record.bodyHash, jobId],
        );
        if (!receipt.rows.length) {
          const existing = await client.query(
            'SELECT body_hash, job_id FROM agent_intake.deliveries WHERE delivery_id = $1', [record.deliveryId],
          );
          if (existing.rows[0]?.body_hash !== record.bodyHash || existing.rows[0]?.job_id !== jobId) throw new InputError(400);
        }
        await client.query('COMMIT');
        return { created };
      } catch (error) {
        if (client) {
          try { await client.query('ROLLBACK'); } catch { discard = true; }
        }
        if (error instanceof InputError) throw error;
        throw new Error(SAFE_ERROR);
      } finally {
        if (client) client.release(discard);
      }
    },
  };
}
