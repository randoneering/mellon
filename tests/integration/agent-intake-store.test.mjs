import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { currentIssue, dependencies, issueEvent, jobRecord, signedRequest } from '../support/agent-intake-fixtures.mjs';
import { createIntake } from '../../src/automation/intake.mjs';
import { createFunction } from '../../src/automation/function.mjs';
import { openDisposablePool } from '../support/agent-intake-database.mjs';

const storeUrl = new URL('../../src/automation/store.mjs', import.meta.url);
const storeModule = await import(storeUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === storeUrl.href) return {};
  throw error;
});
function createStore(pool) {
  assert.equal(typeof storeModule.createStore, 'function', 'missing transactional intake store');
  return storeModule.createStore(pool);
}

const databaseTest = process.env.AGENT_INTAKE_TEST_DATABASE_URL && process.env.AGENT_INTAKE_TEST_RUN_ID ? test : test.skip;

let migration;
async function loadMigration() {
  migration ??= await readFile(new URL('../../migrations/agent-intake/001-initial.sql', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(typeof migration, 'string', 'missing additive intake migration');
  return migration;
}

databaseTest('migration creates only the intake schema with durable uniqueness and restricted runtime writes', async () => {
  const pool = await openDisposablePool();
  try {
    await pool.query(await loadMigration());
    const { rows: tables } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'agent_intake' ORDER BY table_name");
    assert.deepEqual(tables.map(row => row.table_name), ['deliveries', 'jobs']);
    await assert.rejects(pool.query(await loadMigration()), /already exists/);
    await pool.query('ROLLBACK');
    const { rows: columns } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'agent_intake'");
    assert.ok(!columns.some(row => /^(title|body|payload|token|signature)$/.test(row.column_name)));
    const values = ['00000000-0000-4000-8000-000000000010', 123, 'randoneering/mellon', 456, 21, 789, '00000000-0000-4000-8000-000000000011'];
    const insert = 'INSERT INTO agent_intake.jobs (job_id, repository_id, repository_full_name, issue_id, issue_number, actor_id, initial_delivery_id) VALUES ($1,$2,$3,$4,$5,$6,$7)';
    await pool.query(insert, values);
    await assert.rejects(pool.query(insert, ['00000000-0000-4000-8000-000000000012', ...values.slice(1)]), /unique constraint/);
    await assert.rejects(pool.query(insert, ['00000000-0000-4000-8000-000000000013', -1, ...values.slice(2)]), /check constraint/);
    const receipt = 'INSERT INTO agent_intake.deliveries (delivery_id, body_hash, job_id) VALUES ($1,$2,$3)';
    await assert.rejects(pool.query(receipt, [values[6], 'invalid', values[0]]), /check constraint/);
    await pool.query(receipt, [values[6], 'a'.repeat(64), values[0]]);
    await assert.rejects(pool.query(receipt, [values[6], 'a'.repeat(64), values[0]]), /unique constraint/);
    await pool.query('CREATE ROLE intake_test_runtime NOLOGIN');
    await pool.query('GRANT USAGE ON SCHEMA agent_intake TO intake_test_runtime');
    await pool.query('GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA agent_intake TO intake_test_runtime');
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const { rows } = await pool.query("SELECT has_table_privilege('intake_test_runtime', 'agent_intake.jobs', $1) AS allowed", [privilege]);
      assert.equal(rows[0].allowed, ['SELECT', 'INSERT'].includes(privilege));
    }
  } finally { await pool.end(); }
});

databaseTest('store survives restart and reconciles redelivery with one persisted job', async () => {
  const pool = await openDisposablePool();
  try {
    const record = jobRecord();
    const store = createStore(pool);
    assert.equal(await store.getDelivery(record.deliveryId), null);
    assert.deepEqual(await store.enqueue(record), { created: true });
    const restarted = createStore(pool);
    assert.deepEqual(await restarted.getDelivery(record.deliveryId), { bodyHash: record.bodyHash });
    assert.deepEqual(await restarted.enqueue(record), { created: false });
    assert.deepEqual(await restarted.enqueue({ ...record, deliveryId: randomUUID() }), { created: false });
    const count = await pool.query('SELECT count(*)::int AS count FROM agent_intake.jobs WHERE issue_id = $1', [record.issueId]);
    assert.equal(count.rows[0].count, 1);
  } finally { await pool.end(); }
});

databaseTest('concurrent real transactions converge on one job and retain every delivery receipt', async () => {
  const pool = await openDisposablePool();
  try {
    const store = createStore(pool);
    const records = Array.from({ length: 12 }, () => jobRecord({ issueId: 701 }));
    const results = await Promise.all(records.map(record => store.enqueue(record)));
    assert.equal(results.filter(result => result.created).length, 1);
    const counts = await pool.query('SELECT count(*)::int AS count FROM agent_intake.deliveries d JOIN agent_intake.jobs j USING (job_id) WHERE j.issue_id = 701');
    assert.equal(counts.rows[0].count, 12);
    const repeated = jobRecord({ issueId: 702 });
    const retries = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(repeated)));
    assert.equal(retries.filter(result => result.created).length, 1);
  } finally { await pool.end(); }
});

databaseTest('a conflicting delivery rolls back its new job and preserves the original receipt', async () => {
  const pool = await openDisposablePool();
  try {
    const store = createStore(pool);
    const record = jobRecord({ issueId: 703 });
    await store.enqueue(record);
    await assert.rejects(store.enqueue({ ...record, issueId: 704, bodyHash: 'b'.repeat(64) }), error => error.status === 400);
    assert.deepEqual(await store.getDelivery(record.deliveryId), { bodyHash: record.bodyHash });
    const result = await pool.query('SELECT count(*)::int AS count FROM agent_intake.jobs WHERE issue_id = 704');
    assert.equal(result.rows[0].count, 0);
  } finally { await pool.end(); }
});

databaseTest('lost commit acknowledgment returns 503 and redelivery finds the committed job', async () => {
  const pool = await openDisposablePool();
  try {
    const uncertainPool = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, values) {
            const result = await client.query(sql, values);
            if (sql === 'COMMIT') throw new Error('private lost acknowledgment');
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    const event = issueEvent({ issue: { id: 705, number: 705 } });
    const github = { async authorizeSender() { return true; }, async readIssue() { return currentIssue({ id: 705, number: 705 }); } };
    const delivery = randomUUID();
    const request = () => signedRequest(event, { headers: { 'x-github-delivery': delivery } });
    const first = await createIntake(dependencies({ github, store: createStore(uncertainPool) }))(request());
    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { status: 'unavailable' });
    const retry = await createIntake(dependencies({ github, store: createStore(pool) }))(request());
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { status: 'duplicate' });
    const count = await pool.query('SELECT count(*)::int AS count FROM agent_intake.jobs WHERE issue_id = 705');
    assert.equal(count.rows[0].count, 1);
  } finally { await pool.end(); }
});

databaseTest('full signed HTTP flow with real Postgres uses only the runtime SELECT and INSERT grants', async () => {
  const pool = await openDisposablePool();
  try {
    const runtime = {
      async query(sql, values) {
        const client = await pool.connect();
        try {
          await client.query('SET ROLE intake_test_runtime');
          return await client.query(sql, values);
        } finally { await client.query('RESET ROLE'); client.release(); }
      },
      async connect() {
        const client = await pool.connect();
        await client.query('SET ROLE intake_test_runtime');
        return { query: client.query.bind(client), release() { client.query('RESET ROLE').then(() => client.release(), () => client.release(true)); } };
      },
    };
    const event = issueEvent({ issue: { id: 706, number: 999999, title: 'private', body: 'not executable' } });
    const deps = dependencies({ store: createStore(runtime), github: { async authorizeSender() { return true; }, async readIssue() { return currentIssue({ id: 706, number: 999999 }); } } });
    const run = createIntake(deps);
    const headers = { 'x-github-delivery': randomUUID() };
    assert.equal((await run(signedRequest(event, { headers }))).status, 202);
    assert.deepEqual(await (await run(signedRequest(event, { headers }))).json(), { status: 'duplicate' });
    const { rows } = await pool.query('SELECT * FROM agent_intake.jobs WHERE issue_id = 706');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'queued');
    assert.doesNotMatch(JSON.stringify(rows[0]), /private|not executable|body|title/);
  } finally { await pool.end(); }
});

databaseTest('configured Function joins signed HTTP, bounded GitHub reads, and the real transactional store', async () => {
  const pool = await openDisposablePool();
  try {
    const event = issueEvent({ issue: { id: 707, number: 707, title: 'private input', body: 'never stored' } });
    const calls = [];
    const fn = createFunction({
      env: {
        GITHUB_WEBHOOK_SECRET: 'synthetic-test-webhook-secret', GITHUB_READ_TOKEN: 'synthetic-github-token',
        GITHUB_REPOSITORY_ID: '123', GITHUB_REPOSITORY_FULL_NAME: 'randoneering/mellon',
        // Pool injection targets local Postgres; the production configuration still requires TLS.
        AGENT_INTAKE_DATABASE_URL: 'postgresql://intake_runtime:synthetic@db.example/test?sslmode=verify-full',
      },
      poolFactory: () => pool,
      async fetchImpl(resource, options) {
        calls.push(resource);
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        return Response.json(resource.includes('/collaborators/') ? {
          permission: 'write', role_name: 'maintain', user: { id: 789, login: 'maintainer', type: 'User' },
        } : currentIssue({ id: 707, number: 707 }));
      },
    });
    const headers = { 'x-github-delivery': randomUUID() };
    assert.equal((await fn.fetch(signedRequest(event, { headers }))).status, 202);
    assert.deepEqual(calls, [
      'https://api.github.com/repos/randoneering/mellon/collaborators/maintainer/permission',
      'https://api.github.com/repos/randoneering/mellon/issues/707',
    ]);
    assert.deepEqual(await (await fn.fetch(signedRequest(event, { headers }))).json(), { status: 'duplicate' });
    assert.equal(calls.length, 2);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM agent_intake.jobs WHERE issue_id = 707');
    assert.equal(rows[0].count, 1);
  } finally { await pool.end(); }
});
