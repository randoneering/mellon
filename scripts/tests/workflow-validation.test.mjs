import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = () => parse(readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8'));

test('CI does not persist checkout credentials or inject secrets into contributor code', () => {
  const value = workflow();
  const steps = value.jobs.test.steps;
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout, 'CI must check out source');
  assert.equal(checkout.with?.['persist-credentials'], false);
  for (const environment of [value.env, value.jobs.test.env, ...steps.map(step => step.env)]) {
    for (const key of Object.keys(environment ?? {})) {
      assert.doesNotMatch(key, /^(?:GH_TOKEN|GITHUB_TOKEN|.*DATABASE_URL|.*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY))$/i);
    }
  }
  assert.doesNotMatch(JSON.stringify(value), /\bsecrets\s*(?:\.|\[)/i);
});

test('CI retains locked installs and every ordinary release check without agent reporting', () => {
  const value = workflow();
  assert.deepEqual(Object.keys(value.jobs), ['test']);
  assert.equal(value.jobs.test.outputs, undefined);
  assert.deepEqual(value.jobs.test.steps.filter(step => step.run && step.id !== 'summarize_failures').map(step => step.run), [
    'npm ci --ignore-scripts',
    'npm ci --prefix detector --ignore-scripts',
    'npm run verify:assets',
    'npm run test:build',
    'npm test',
    'npm run test:parity',
    'npm run build',
    'test -z "$(git status --porcelain --untracked-files=all -- dist)"',
    'npm run validate:release',
  ]);
});

test('CI failure summary uses every stage outcome and writes only fixed names of failed stages', t => {
  const steps = workflow().jobs.test.steps;
  const summary = steps.at(-1);
  assert.equal(summary.id, 'summarize_failures');
  assert.equal(summary.if, '${{ failure() }}');
  assert.equal(summary.shell, 'bash');
  assert.doesNotMatch(summary.run, /\$\{\{/);

  const stages = steps.slice(0, -1);
  const outcomeVariable = stage => `${stage.id.toUpperCase()}_OUTCOME`;
  assert.deepEqual(summary.env, Object.fromEntries(stages.map(stage => [
    outcomeVariable(stage), `\${{ steps.${stage.id}.outcome }}`,
  ])));

  const directory = mkdtempSync(join(tmpdir(), 'mellon-ci-summary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'summary.md');
  const existingSummary = 'Existing summary\n';
  const outcomes = Object.fromEntries(stages.map(stage => [outcomeVariable(stage), 'success']));
  for (const stage of stages) {
    writeFileSync(path, existingSummary);
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', summary.run], {
      env: {
        ...outcomes,
        GITHUB_STEP_SUMMARY: path,
        [outcomeVariable(stages.at(-1))]: 'skipped',
        [outcomeVariable(stage)]: 'failure',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path, 'utf8'),
      `${existingSummary}## Release verification failed\n\n- ${stage.name}\n`);
  }
});

test('CI checks both tracked and untracked distribution changes after building', () => {
  const steps = workflow().jobs.test.steps;
  const build = steps.findIndex(step => step.run === 'npm run build');
  const check = steps.findIndex(step => step.name === 'Check distribution is committed');
  assert.ok(build >= 0 && check > build);
  assert.equal(steps[check].run, 'test -z "$(git status --porcelain --untracked-files=all -- dist)"');
});

test('CI cancels superseded runs only within the same pull request', () => {
  assert.deepEqual(workflow().concurrency, {
    group: "mellon-node-ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}",
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
});

test('workflow keeps fork-safe triggers, hosted runners, least privilege and pinned Actions', () => {
  const value = workflow();
  assert.deepEqual(value.on, { push: null, pull_request: null });
  assert.deepEqual(value.permissions, { contents: 'read', issues: 'none', 'pull-requests': 'none' });
  assert.deepEqual(Object.keys(value.jobs), ['test']);
  assert.equal(value.jobs.test['runs-on'], 'ubuntu-latest');
  assert.equal(value.jobs.test['timeout-minutes'], 15);
  assert.deepEqual(value.jobs.test.steps.filter(step => step.uses).map(step => step.uses), [
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  ]);
});

test('release drafter runs on main with a pinned action and does not publish', () => {
  const value = parse(readFileSync(new URL('../../.github/workflows/release-drafter.yml', import.meta.url), 'utf8'));
  assert.deepEqual(value.on, { push: { branches: ['main'] } });
  assert.deepEqual(value.permissions, { contents: 'write', 'pull-requests': 'read' });
  const step = value.jobs.draft.steps[0];
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
