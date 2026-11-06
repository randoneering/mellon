import pg from 'pg';

const SAFE_ERROR = 'Disposable database verification failed; no migrations are authorized.';

export async function openDisposablePool(env = process.env) {
  let pool;
  try {
    const url = new URL(env.AGENT_INTAKE_TEST_DATABASE_URL);
    const marker = env.AGENT_INTAKE_TEST_RUN_ID;
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/mellon_intake_test' || url.search ||
        !/^[a-f0-9]{64}$/.test(marker ?? '')) throw new Error(SAFE_ERROR);
    pool = new pg.Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 10000 });
    const { rows } = await pool.query('SELECT token FROM mellon_test_guard.runs WHERE token = $1', [marker]);
    if (rows.length !== 1 || rows[0].token !== marker) throw new Error(SAFE_ERROR);
    return pool;
  } catch {
    if (pool) await pool.end().catch(() => {});
    throw new Error(SAFE_ERROR);
  }
}
