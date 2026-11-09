import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commandFor } from '../../automation/ci/guard-command.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('CI does not persist checkout credentials or expose tokens to generated code', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.test.steps;
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout, 'CI must check out source');
  assert.equal(checkout.with?.['persist-credentials'], false,
    'checkout must not persist its token for later code execution');

  const environments = [workflow.env, workflow.jobs.test.env, ...steps.map(step => step.env)];
  for (const environment of environments) {
    for (const key of Object.keys(environment ?? {})) {
      assert.doesNotMatch(key, /^(?:GH_TOKEN|GITHUB_TOKEN|.*DATABASE_URL|NEON_.*|WORKER_.*|OPENAI_.*|.*(?:SECRET|PASSWORD|PRIVATE_KEY))$/i,
        'CI must not explicitly inject worker or provider credentials at any environment scope');
    }
  }
  assert.doesNotMatch(JSON.stringify(workflow), /\bsecrets\s*(?:\.|\[)/i,
    'generated-code CI must not reference repository secret values');

  const generatedCodeSteps = steps.filter(step =>
    step.run === 'npm test' || /automation\/ci\/guard-command\.mjs/.test(step.run ?? '')
  );
  assert.ok(generatedCodeSteps.length > 0, 'CI must identify generated-code execution steps');
  for (const step of generatedCodeSteps) {
    assert.equal(step.env?.GITHUB_TOKEN, undefined,
      `${step.name} must not receive an explicit GitHub token`);
    assert.equal(step.env?.GH_TOKEN, undefined,
      `${step.name} must not receive an explicit GH token`);
  }
});

test('CI preserves the effective command sequence and guards ordinary output', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.test.steps;
  assert.deepEqual(steps.filter(step => step.run).map(step => step.run), [
    'node automation/ci/guard-command.mjs install-root',
    'node automation/ci/guard-command.mjs install-detector',
    'node automation/ci/guard-command.mjs verify-assets',
    'node automation/ci/guard-command.mjs test-build',
    'npm test',
    'node automation/ci/guard-command.mjs test-parity',
    'node automation/ci/guard-command.mjs build',
    'node automation/ci/guard-command.mjs check-dist',
    'node automation/ci/guard-command.mjs validate-release',
  ]);
  const install = commandFor('install-detector');
  assert.equal(install.executable, 'npm');
  assert.deepEqual(install.args, ['ci', '--ignore-scripts']);
  assert.equal(install.cwd, path.join(root, 'detector'));
  assert.equal(steps.find(step => step.name === 'Run JavaScript tests').run, 'npm test');
});

test('CI checks distribution changes with the fixed git status tuple', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.test.steps;
  const build = steps.findIndex(step => step.run === 'node automation/ci/guard-command.mjs build');
  const check = steps.findIndex(step => step.name === 'Check distribution is committed');
  assert.ok(build >= 0 && check > build, 'CI must check distribution files after building');
  assert.equal(steps[check].run, 'node automation/ci/guard-command.mjs check-dist');
  assert.deepEqual(commandFor('check-dist').args, [
    'status', '--porcelain', '--untracked-files=all', '--', 'dist',
  ]);
});

test('reporter uses a separate read-only job and only bounded untrusted job outputs', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.jobs), ['test', 'report']);
  const testJob = workflow.jobs.test;
  const reportJob = workflow.jobs.report;
  assert.deepEqual(reportJob.needs, ['test']);
  assert.equal(reportJob['runs-on'], 'ubuntu-latest');
  assert.deepEqual(reportJob.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(testJob.outputs ?? {}).sort(), ['encoded_report', 'test_exit_code']);
  assert.match(String(reportJob.steps?.[0]?.run), /MELLON_CI_REPORTER_REVISION/);
  assert.match(JSON.stringify(reportJob.steps), /\[\[ ! \\\"\$MELLON_CI_REPORTER_REVISION\\\" =~ \^\[a-f0-9\]\{40\}\$ \]\]/);
  assert.doesNotMatch(JSON.stringify(reportJob.steps), /needs\.test\.outputs[^\n]*run:/);
  assert.doesNotMatch(JSON.stringify(reportJob.steps), /actions\/download-artifact|npm ci|pull_request_target/);
  assert.deepEqual(reportJob.steps.filter(step => step.uses).map(step => step.uses), [
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  ]);
});

test('workflow trust boundary, runner, permissions, and pinned Actions stay unchanged', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on, { push: null, pull_request: null });
  assert.deepEqual(workflow.permissions, {
    contents: 'read',
    issues: 'none',
    'pull-requests': 'none',
  });
  assert.deepEqual(Object.keys(workflow.jobs), ['test', 'report']);
  assert.equal(workflow.jobs.test['runs-on'], 'ubuntu-latest');
  assert.equal(workflow.jobs.test['timeout-minutes'], 15);
  const actions = workflow.jobs.test.steps.filter(step => step.uses).map(step => step.uses);
  assert.deepEqual(actions, [
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  ]);
});

test('release drafter runs on main with a pinned action and does not publish', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/release-drafter.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on, { push: { branches: ['main'] } });
  assert.deepEqual(workflow.permissions, { contents: 'write', 'pull-requests': 'read' });
  const step = workflow.jobs.draft.steps[0];
  assert.match(step.uses, /^release-drafter\/release-drafter@[a-f0-9]{40}$/);
  assert.equal(step.with.publish, false);
  const config = parse(readFileSync(new URL('../../.github/release-drafter.yml', import.meta.url), 'utf8'));
  assert.match(config.template, /\$CHANGES/);
});

test('Action metadata includes Marketplace branding', () => {
  const metadata = parse(readFileSync(new URL('../../action.yml', import.meta.url), 'utf8'));
  assert.deepEqual(metadata.branding, { icon: 'message-square', color: 'yellow' });
});

test('release validator accepts metadata and consumer template boundaries', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-release.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /validated/);
});
