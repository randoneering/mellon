import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const guardUrl = new URL('../support/agent-intake-database.mjs', import.meta.url);
const guard = await import(guardUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === guardUrl.href) return {};
  throw error;
});
const probeTest = process.env.AGENT_INTAKE_GUARD_PROBE === '1' ? test : test.skip;
const url = process.env.AGENT_INTAKE_TEST_DATABASE_URL;
const marker = process.env.AGENT_INTAKE_TEST_RUN_ID;

async function open(env) {
  assert.equal(typeof guard.openDisposablePool, 'function', 'missing disposable database guard');
  return guard.openDisposablePool(env);
}

probeTest('a URL and matching database name without a runner token cannot authorize migrations', async () => {
  await assert.rejects(open({ AGENT_INTAKE_TEST_DATABASE_URL: url }), /disposable.*verification/i);
});

probeTest('an unmarked loopback database is rejected before intake schema or roles are created', async () => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/mellon_intake_test');
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await assert.rejects(open({ AGENT_INTAKE_TEST_DATABASE_URL: url, AGENT_INTAKE_TEST_RUN_ID: marker }), /disposable.*verification/i);
    const result = await pool.query("SELECT to_regnamespace('agent_intake') IS NULL AS no_schema, NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intake_test_runtime') AS no_role");
    assert.deepEqual(result.rows[0], { no_schema: true, no_role: true });
  } finally { await pool.end(); }
});

probeTest('a wrong database marker is rejected without running intake migrations or granting privileges', async () => {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    const markerRows = await pool.query('SELECT token FROM mellon_test_guard.runs');
    assert.deepEqual(markerRows.rows, [{ token: '0'.repeat(64) }]);
    await assert.rejects(open({ AGENT_INTAKE_TEST_DATABASE_URL: url, AGENT_INTAKE_TEST_RUN_ID: marker }), /disposable.*verification/i);
    const result = await pool.query("SELECT to_regnamespace('agent_intake') IS NULL AS no_schema, NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intake_test_runtime') AS no_role");
    assert.deepEqual(result.rows[0], { no_schema: true, no_role: true });
  } finally { await pool.end(); }
});
