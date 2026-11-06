import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const image = 'postgres@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac';
const container = `mellon-intake-test-${randomUUID()}`;
const password = randomUUID();
const database = 'mellon_intake_test';
const run = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, ...options });
let started = false;
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
    if (run(['exec', container, 'pg_isready', '--username', 'postgres', '--dbname', database]).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Disposable Postgres did not become ready within the startup limit.');
  const url = `postgresql://postgres:${password}@127.0.0.1:${match[1]}/${database}`;
  const result = spawnSync('node', ['--test', '--test-concurrency=1', 'tests/integration/agent-intake-store.test.mjs'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, AGENT_INTAKE_TEST_DATABASE_URL: url },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(url, '[TEST DATABASE]').replaceAll(password, '[REDACTED]');
  console.log(output.trim());
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started && run(['stop', '--time', '5', container]).status !== 0) {
    console.error('The disposable test container could not be stopped; manual cleanup is required.');
    process.exitCode = 1;
  }
}
