import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { isPostgresTcpReady } from './lib/postgres-readiness.mjs';

const suite = process.argv.length === 2 ? 'intake' : process.argv[2] === '--suite' && ['intake', 'worker', 'journal', 'coordinator', 'runtime', 'review-requests'].includes(process.argv[3]) && process.argv.length === 4 ? process.argv[3] : null;
if (!suite) { console.error('Usage: node scripts/test-agent-intake-db.mjs [--suite intake|worker|journal|coordinator|runtime|review-requests]'); process.exit(2); }
const suiteFiles = Object.freeze({
  intake: 'tests/integration/agent-intake-store.test.mjs',
  worker: 'tests/integration/agent-worker-store.test.mjs',
  journal: 'tests/integration/agent-worker-journal.test.mjs',
  coordinator: 'tests/integration/agent-worker-coordinator.test.mjs',
  runtime: 'tests/support/agent-worker-runtime-postgres.mjs',
  'review-requests': 'tests/manual/agent-worker-review-request-journal.mjs',
});
const image = 'postgres@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac';
const container = `mellon-${suite}-test-${randomUUID()}`;
const password = randomUUID();
const database = 'mellon_intake_test';
const runId = randomBytes(32).toString('hex');
const run = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, ...options });
let started = false;
let phase = 'container setup';
try {
  const start = run([
    'run', '--detach', '--rm', '--name', container,
    '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', `POSTGRES_DB=${database}`,
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '--memory', '512m', '--cpus', '1', image,
  ], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  if (start.status !== 0) throw new Error('Could not start the disposable Postgres test container.');
  started = true;
  const portResult = run(['port', container, '5432/tcp']);
  const match = portResult.stdout?.trim().match(/^127\.0\.0\.1:(\d+)$/);
  if (portResult.status !== 0 || !match) throw new Error('Could not resolve the private test database port.');
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (isPostgresTcpReady(run, container, database)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Disposable Postgres did not become ready within the startup limit.');
  const url = `postgresql://postgres:${password}@127.0.0.1:${match[1]}/${database}`;
  const setup = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  try {
    // Only the runner writes markers, after starting this fresh memory-backed container.
    await setup.query('CREATE SCHEMA mellon_test_guard');
    await setup.query('CREATE TABLE mellon_test_guard.runs (token text PRIMARY KEY)');
    await setup.query('INSERT INTO mellon_test_guard.runs (token) VALUES ($1)', ['0'.repeat(64)]);
  } finally { await setup.end(); }
  phase = 'marker guard probes';
  const probes = spawnSync('node', ['--test', '--test-concurrency=1', 'tests/integration/agent-intake-database-guard.test.mjs'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, AGENT_INTAKE_TEST_DATABASE_URL: url, AGENT_INTAKE_TEST_RUN_ID: runId, AGENT_INTAKE_GUARD_PROBE: '1' },
  });
  console.log(`${probes.stdout ?? ''}${probes.stderr ?? ''}`.replaceAll(url, '[TEST DATABASE]').replaceAll(password, '[REDACTED]').replaceAll(runId, '[RUN MARKER]').trim());
  if (probes.status !== 0) throw new Error('Disposable database guard probes failed.');
  phase = 'mark verified local database';
  const mark = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  try { await mark.query('INSERT INTO mellon_test_guard.runs (token) VALUES ($1)', [runId]); }
  finally { await mark.end(); }
  phase = `${suite} integration suite`;
  const result = spawnSync('node', ['--test', '--test-concurrency=1', suiteFiles[suite]], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, AGENT_INTAKE_TEST_DATABASE_URL: url, AGENT_INTAKE_TEST_RUN_ID: runId, AGENT_INTAKE_GUARD_PROBE: '0' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(url, '[TEST DATABASE]').replaceAll(password, '[REDACTED]').replaceAll(runId, '[RUN MARKER]');
  console.log(output.trim());
  process.exitCode = result.status ?? 1;
} catch {
  console.error(`Disposable Postgres ${phase} failed; private details withheld.`);
  process.exitCode = 1;
} finally {
  if (started && run(['stop', '--time', '5', container]).status !== 0) {
    console.error('The disposable test container could not be stopped; manual cleanup is required.');
    process.exitCode = 1;
  }
}
