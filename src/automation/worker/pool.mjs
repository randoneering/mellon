import pg from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { workerRuntimeEnvironment } from './environment.mjs';
import { createWaitDeadline } from './store-validation.mjs';

const ROLE_QUERY = `
WITH expected(rel, required, forbidden) AS (
  VALUES
    ('agent_intake.jobs', ARRAY['SELECT'], ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']),
    ('agent_worker.runs', ARRAY['SELECT','INSERT','UPDATE'], ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER']),
    ('agent_worker.operations', ARRAY['SELECT','INSERT','UPDATE'], ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER']),
    ('agent_worker.events', ARRAY['SELECT','INSERT'], ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']),
    ('agent_worker.candidate_descriptors', ARRAY['SELECT','INSERT'], ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
)
SELECT current_user AS role_name, session_user AS session_role,
  COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl,
  r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolinherit,
  EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS has_memberships,
  EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = r.oid) AS owns_database,
  EXISTS (
    SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('agent_intake','agent_worker') AND n.nspowner = r.oid
    UNION ALL
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('agent_intake','agent_worker') AND c.relowner = r.oid
  ) AS owns_app_objects,
  has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
  EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('agent_intake','agent_worker')
    AND has_schema_privilege(current_user, n.oid, 'CREATE')) AS schema_create,
  (
    (SELECT bool_and(has_schema_privilege(current_user, schema_name, 'USAGE'))
      FROM unnest(ARRAY['agent_intake','agent_worker']) AS schemas(schema_name))
    AND
    (SELECT bool_and(
      to_regclass(e.rel) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM unnest(e.required) AS permissions(privilege)
        WHERE has_table_privilege(current_user, to_regclass(e.rel), privilege) IS DISTINCT FROM true)
      AND NOT EXISTS (SELECT 1 FROM unnest(e.forbidden) AS permissions(privilege)
        WHERE has_table_privilege(current_user, to_regclass(e.rel), privilege) IS DISTINCT FROM false)
    ) FROM expected e)
    AND
    (SELECT count(*) > 0 AND bool_and(
      has_sequence_privilege(current_user, c.oid, 'USAGE')
      AND has_sequence_privilege(current_user, c.oid, 'SELECT')
      AND NOT has_sequence_privilege(current_user, c.oid, 'UPDATE'))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'agent_worker' AND c.relkind = 'S')
    AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('agent_intake','agent_worker') AND c.relkind IN ('r','p','v','m','f')
        AND n.nspname || '.' || c.relname NOT IN (SELECT rel FROM expected)
        AND has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    )
  ) AS grants_ok
FROM pg_roles r WHERE r.rolname = current_user`;
const FALSE_FIELDS = [
  'rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication',
  'rolinherit', 'has_memberships', 'owns_database', 'owns_app_objects',
  'database_create', 'schema_create',
];
const ROLE_ERROR = 'Worker database role could not be verified.';

function discardQuietly(client) {
  try { client?.release(true); } catch {}
}

export function createWorkerDatabase({ env, databaseRole, report = line => console.error(line) },
  { Pool = pg.Pool, attachPool = attachDatabasePool } = {}) {
  let pool;
  try {
    if (typeof report !== 'function' || typeof Pool !== 'function'
      || typeof attachPool !== 'function') throw new Error();
    const clean = workerRuntimeEnvironment(env, databaseRole);
    const url = new URL(clean.AGENT_WORKER_DATABASE_URL);
    const password = decodeURIComponent(url.password);
    if (!password || password.includes('\0')) throw new Error();
    const port = url.port ? Number(url.port) : 5432;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error();
    // Explicit fields prevent pg's URL parser and PG* environment fallbacks from changing authority.
    pool = new Pool({
      host: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
      port, user: decodeURIComponent(url.username), password,
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: { rejectUnauthorized: true }, enableChannelBinding: true,
      max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
      query_timeout: 5000, statement_timeout: 5000,
      options: '-c statement_timeout=5000 -c lock_timeout=2000',
      application_name: 'mellon-agent-worker', allowExitOnIdle: true,
    });
    if (typeof pool.connect !== 'function' || typeof pool.end !== 'function') throw new Error();
    attachPool(pool, { onUnexpectedError() {
      // The SDK's fallback reporter includes the raw database error if this callback throws.
      try { Promise.resolve(report('[agent_worker] database_pool_unavailable')).catch(() => {}); } catch {}
    } });
  } catch {
    try { Promise.resolve(pool?.end()).catch(() => {}); } catch {}
    throw new Error('Worker database configuration is invalid.');
  }

  async function verifyRole({ signal, deadline = Infinity, limits } = {}) {
    let budget;
    let acquisition;
    let client;
    let discard = false;
    let abort;
    try {
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error();
      budget = createWaitDeadline(5000, deadline);
      abort = () => budget.close();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) budget.close();
      client = await budget.wait(() => {
        acquisition = Promise.resolve(pool.connect());
        return acquisition;
      });
      if (typeof client?.query !== 'function' || typeof client.release !== 'function') throw new Error();
      const text = limits === undefined ? ROLE_QUERY
        : ROLE_QUERY.replace('SELECT current_user AS role_name',
          'SELECT agent_worker.valid_limits($1::jsonb) AS limits_ok, current_user AS role_name');
      const receipt = await budget.wait(() => client.query({
        text, ...(limits === undefined ? {} : { values: [JSON.stringify(limits)] }),
        query_timeout: Math.max(1, budget.deadline - Date.now()),
      }));
      budget.check();
      if (!Array.isArray(receipt?.rows) || receipt.rows.length !== 1) throw new Error();
      const row = receipt.rows[0];
      if (row.role_name !== databaseRole || row.session_role !== databaseRole
        || (limits !== undefined && row.limits_ok !== true)
        || row.ssl !== true || row.grants_ok !== true
        || !FALSE_FIELDS.every(field => row[field] === false)) throw new Error();
      return true;
    } catch {
      discard = true;
      throw new Error(ROLE_ERROR);
    } finally {
      budget?.close();
      if (abort) signal?.removeEventListener('abort', abort);
      if (client) {
        try { client.release(discard); } catch { throw new Error(ROLE_ERROR); }
      } else if (acquisition) {
        acquisition.then(discardQuietly, () => {});
      }
    }
  }

  async function close() {
    const budget = createWaitDeadline(5000);
    try { await budget.wait(() => pool.end()); }
    catch { throw new Error('Worker database pool could not be closed.'); }
    finally { budget.close(); }
  }

  return Object.freeze({ pool, verifyRole, close });
}
