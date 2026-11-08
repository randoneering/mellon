import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const runner = await import(pathToFileURL(resolve(root, 'automation/ci/run-tests.mjs')).href);
const fixtures = resolve(root, 'scripts/tests/fixtures/agent-worker-ci');
const mode = process.argv[2];
let status;

if (mode === 'local-green') {
  status = runner.runLocally([resolve(fixtures, 'green.test.mjs')]);
} else if (mode === 'local-failure') {
  status = runner.runLocally([resolve(fixtures, 'assertion.test.mjs')]);
} else if (mode === 'ci-injection') {
  status = runner.runInGitHubActions([resolve(fixtures, 'stdout.test.mjs')]);
} else if (mode === 'ci-coordinator-skips') {
  delete process.env.AGENT_INTAKE_TEST_DATABASE_URL;
  delete process.env.AGENT_INTAKE_TEST_RUN_ID;
  status = runner.runInGitHubActions([
    resolve(root, 'tests/integration/agent-worker-coordinator.test.mjs'),
  ]);
} else if (mode === 'ci-journal-skips') {
  delete process.env.AGENT_INTAKE_TEST_DATABASE_URL;
  delete process.env.AGENT_INTAKE_TEST_RUN_ID;
  status = runner.runInGitHubActions([
    resolve(root, 'tests/integration/agent-worker-journal.test.mjs'),
  ]);
} else if (mode === 'ci-database-skips' || mode === 'ci-database-red') {
  delete process.env.AGENT_INTAKE_TEST_DATABASE_URL;
  delete process.env.AGENT_INTAKE_TEST_RUN_ID;
  status = runner.runInGitHubActions([
    resolve(root, 'tests/integration/agent-intake-database-guard.test.mjs'),
    resolve(root, 'tests/integration/agent-intake-store.test.mjs'),
    resolve(root, 'tests/integration/agent-worker-store.test.mjs'),
    resolve(root, 'tests/integration/agent-worker-journal.test.mjs'),
    resolve(root, 'tests/integration/agent-worker-coordinator.test.mjs'),
    ...(mode === 'ci-database-red' ? [resolve(fixtures, 'assertion.test.mjs')] : []),
  ]);
} else if (mode === 'ci-private-failure') {
  status = runner.runInGitHubActions([resolve(fixtures, 'private-failure.test.mjs')]);
} else if (mode === 'ci-setup') {
  status = runner.runInGitHubActions([resolve(fixtures, 'setup.test.mjs')]);
} else if (mode === 'ci-failure') {
  status = runner.runInGitHubActions([resolve(fixtures, 'assertion.test.mjs')]);
} else {
  status = 1;
}

process.exitCode = status;
