import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildTrustedAnnotation } from '../../automation/ci/report-annotations.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE_ROOT = path.join(ROOT, 'scripts/tests/fixtures/agent-worker-ci');
const REPORTER = path.join(ROOT, 'automation/ci/test-reporter.mjs');
const RUNNER = path.join(ROOT, 'automation/ci/run-tests.mjs');
const RUNNER_PROBE = path.join(FIXTURE_ROOT, 'runner-probe.mjs');
const HEAD = 'a'.repeat(40);
const CONTEXT = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'randoneering/mellon',
  GITHUB_SHA: HEAD,
  GITHUB_RUN_ID: '717',
  GITHUB_RUN_ATTEMPT: '3',
};
const FIXTURES = {
  nativeFlags: ['native-flags.test.mjs', 0, []],
  unrelatedSkip: ['unrelated-skip.test.mjs', 0, []],
  ambiguousSkips: ['ambiguous-skips.test.mjs', 0, []],
  failingTodo: ['native-todo-failure.test.mjs', 0, []],
  green: ['green.test.mjs', 0, ['ok 1 - native green fixture']],
  assertion: ['assertion.test.mjs', 1, ['not ok 1 - selected assertion regression']],
  setup: ['setup.test.mjs', 1, ['setup failure fixture']],
  nested: ['nested.test.mjs', 1, ['nested child regression']],
  stdout: ['stdout.test.mjs', 0, ['::error::forged', '::notice::forged']],
  syntax: ['syntax.test.mjs', 1, ['SyntaxError']],
  largeName: ['large-name.test.mjs', 0, []],
  failureOverflow: ['failure-overflow.test.mjs', 1, ['overflow failure 0']],
  controlName: ['control-name.test.mjs', 0, []],
};

function parseReport(stdout) {
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith('MELLON_CI_RAW_V2:'));
  if (records.length !== 1) return null;
  const encoded = records[0].slice('MELLON_CI_RAW_V2:'.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function runFixture(name, overrides = {}) {
  const [file, expectedExit, expectedOutput] = FIXTURES[name];
  const fixturePath = path.join(FIXTURE_ROOT, file);
  const environment = { ...process.env, ...CONTEXT, ...overrides };
  delete environment.NODE_TEST_CONTEXT;
  if (!existsSync(REPORTER)) {
    const native = spawnSync(process.execPath, [
      '--test', '--test-concurrency=1', '--test-reporter=tap', fixturePath,
    ], { cwd: ROOT, env: environment, encoding: 'utf8', maxBuffer: 256 * 1024 });
    assert.equal(native.status, expectedExit, `${name} native fixture exit`);
    for (const fragment of expectedOutput) assert.ok(native.stdout.includes(fragment), name);
    return { report: null, output: native.stdout, exitCode: native.status, nativeFallback: true };
  }

  environment.MELLON_CI_PRODUCER_SHA256 = producerDigest();
  const child = spawnSync(process.execPath, [
    '--test', '--test-concurrency=1', `--test-reporter=${REPORTER}`, fixturePath,
  ], { cwd: ROOT, env: environment, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 15000 });
  assert.equal(child.error, undefined, `${name} native reporter process`);
  return {
    report: parseReport(child.stdout),
    output: child.stdout,
    exitCode: child.status,
    nativeFallback: false,
  };
}

function requireReport(name, overrides = {}) {
  const result = runFixture(name, overrides);
  assert.ok(result.report, 'real Node test events must produce one bounded versioned report');
  return { ...result, report: result.report };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function producerDigest() {
  const paths = [
    'automation/ci/guard-command.mjs',
    'automation/ci/run-tests.mjs',
    'automation/ci/test-reporter.mjs',
    'automation/ci/report-annotations.mjs',
    'scripts/lib/output-guard.mjs',
    'package.json',
  ];
  const sources = paths.map(sourcePath => ({
    path: sourcePath,
    sha256: createHash('sha256').update(readFileSync(path.join(ROOT, sourcePath))).digest('hex'),
  }));
  return createHash('sha256').update(canonicalJson(sources)).digest('hex');
}

async function expectedProducerDigest() {
  return producerDigest();
}

async function runnerExports() {
  try {
    return await import(pathToFileURL(RUNNER).href);
  } catch {
    return null;
  }
}

function runRunnerProbe(mode, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mellon-ci-test-'));
  const outputPath = path.join(directory, 'github-output');
  const environment = { ...process.env, ...overrides, GITHUB_OUTPUT: outputPath };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [RUNNER_PROBE, mode], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 128 * 1024,
    timeout: 15000,
  });
  assert.equal(child.error, undefined, `${mode} protected runner process`);
  const outputFields = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  const fields = Object.fromEntries(outputFields.trimEnd().split(/\r?\n/)
    .filter(Boolean).map(line => line.split('=')));
  rmSync(directory, { recursive: true, force: true });
  return {
    output: child.stdout,
    errorOutput: child.stderr,
    exitCode: child.status,
    fields,
  };
}

function parseWorkflowReport(output) {
  const prefix = '::notice::MELLON_CI_REPORT_V2:';
  const lines = output.trimEnd().split(/\r?\n/);
  let encoded;
  if (lines.length === 1 && lines[0].startsWith(prefix)) encoded = lines[0].slice(prefix.length);
  else {
    assert.ok(lines.length >= 2 && lines.length <= 10);
    const parts = lines.map(line => {
      const match = line.match(/^::notice::MELLON_CI_REPORT_V2_CHUNK:([a-f0-9]{64}):([1-9]|10):([1-9]|10):([A-Za-z0-9_-]+)$/);
      assert.ok(match, 'trusted formatter emits only bounded chunk notices');
      assert.ok(Buffer.byteLength(line.slice('::notice::'.length)) < 4096);
      return { digest: match[1], index: Number(match[2]), count: Number(match[3]), data: match[4] };
    });
    assert.equal(new Set(parts.map(part => part.index)).size, parts.length);
    assert.ok(parts.every(part => part.count === parts.length && part.digest === parts[0].digest));
    encoded = parts.sort((a, b) => a.index - b.index).map(part => part.data).join('');
    assert.equal(createHash('sha256').update(encoded).digest('hex'), parts[0].digest);
  }
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  const bytes = Buffer.from(encoded, 'base64url');
  assert.equal(bytes.toString('base64url'), encoded);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

test('parses real Node boolean and string skip/todo flags and enumerates native skip identities', () => {
  const { report } = requireReport('nativeFlags');
  assert.equal(report.complete, true);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.counts.testCount, 5);
  assert.equal(report.counts.skippedTestCount, 2);
  assert.equal(report.counts.todoTestCount, 2);
  assert.equal(report.counts.passedTestCount, 1);
  assert.equal(report.skippedTestIdentitySha256s.length, 2);
  assert.equal(new Set(report.skippedTestIdentitySha256s).size, 2);
  assert.ok(report.skippedTestIdentitySha256s.every(id => /^[a-f0-9]{64}$/.test(id)));
});

test('protected runner reports the real database guard skip shape without a database', () => {
  const result = runRunnerProbe('ci-database-skips', CONTEXT);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '');
  const report = JSON.parse(Buffer.from(result.fields.encoded_report, 'base64url'));
  assert.equal(report.complete, true);
  assert.equal(report.counts.skippedTestCount, 62);
  assert.equal(report.skippedTestIdentitySha256s.length, 62);
  assert.equal(new Set(report.skippedTestIdentitySha256s).size, 62);
  const trusted = parseWorkflowReport(buildTrustedAnnotation({
    ...CONTEXT,
    MELLON_CI_ENCODED_REPORT: result.fields.encoded_report,
    MELLON_CI_TEST_EXIT_CODE: result.fields.test_exit_code,
    MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
  }));
  assert.deepEqual(trusted.skippedTestIdentitySha256s, report.skippedTestIdentitySha256s);
});

test('trusted formatter accepts the eight explicitly reviewed frozen journal DB identities', () => {
  assert.equal(createHash('sha256').update(readFileSync(path.join(ROOT,
    'tests/integration/agent-worker-journal.test.mjs'))).digest('hex'),
  '1f766fa870fce783d739242bace954427e6081b2d5d1b97ce1db239a75a2d71a');
  const result = runRunnerProbe('ci-journal-skips', CONTEXT);
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(Buffer.from(result.fields.encoded_report, 'base64url'));
  assert.equal(report.complete, true);
  assert.equal(report.counts.skippedTestCount, 8);
  assert.deepEqual([...report.skippedTestIdentitySha256s].sort(), [
    '163fa9b39f0587f0d3af8cf3210a4268f3eee4a9aad0a7199084a52e626826f3',
    '392e42a4eb60f95fdb429cb23b34a549f903b1482887948d6cdb7ac318b1ede7',
    '3aa113afae75d8a35ff9e73a050439891f263604112cc7cee95c6e24ce96dd17',
    '6943c432a17e2dfd6b47f398926bd05bba64d3347dfe666be90fcd57ad205282',
    '7a0b5d45ba181d03eabf7b6859d6cdf0b284f5a3fd868cb99072673fcd41060b',
    'b3a8ae769e55b89259d4a23cc495d8cfde6900b1f75496ac3238dd4e73f60edd',
    'd50be9b0b1afcdff68c30009b314428422d59ed3037e6db457c94a8bf962af97',
    'ed5d204b0eadbb7c629110a62d52f6789497376b3a76ec80edf827211fe625dd',
  ]);
  assert.match(buildTrustedAnnotation({ ...CONTEXT,
    MELLON_CI_ENCODED_REPORT: result.fields.encoded_report,
    MELLON_CI_TEST_EXIT_CODE: result.fields.test_exit_code,
    MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
  }), /^::notice::MELLON_CI_REPORT_V2:/);
});

test('trusted formatter accepts the six explicitly reviewed frozen coordinator DB identities', () => {
  assert.equal(createHash('sha256').update(readFileSync(path.join(ROOT,
    'tests/integration/agent-worker-coordinator.test.mjs'))).digest('hex'),
  '94e2765707bfbcaeb601ae1ce96104c8a10f45cd0fbcaf0cd74762ef7d86b89e');
  const result = runRunnerProbe('ci-coordinator-skips', CONTEXT);
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(Buffer.from(result.fields.encoded_report, 'base64url'));
  assert.equal(report.complete, true);
  assert.deepEqual([...report.skippedTestIdentitySha256s].sort(), [
    '054c8cebc9f59c0f5b3df8645b83269d4869f288e4773579ff095bfcc8711916',
    '09d72ef105de01bfaf403c942a714a28bc82bc304e57019e8af60c22cfb29c0e',
    '194abf4587f35bbf8c037012ed12c1eaf3dd0ef55d1cf5fada8b4263c094bbe3',
    'b0aaf0ddd3b557c44782ff485a1e836430e404a1c62d5183e603ab37c591093b',
    'd62fca6fcda07658e44eb3ae4ac26d731deb7e6a0f02c5e1a7abda74fc9d3a17',
    'de02bcac3413af36f31b898cb4b37fa479053ed0cabe5b9ce8e760fb219ffcf0',
  ]);
  assert.match(buildTrustedAnnotation({ ...CONTEXT,
    MELLON_CI_ENCODED_REPORT: result.fields.encoded_report,
    MELLON_CI_TEST_EXIT_CODE: result.fields.test_exit_code,
    MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
  }), /^::notice::MELLON_CI_REPORT_V2:/);
});

test('reports green native tests with exact run context, source digest, and complete counts', async () => {
  const { report, exitCode } = requireReport('green');
  assert.equal(exitCode, 0);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.complete, true);
  assert.equal(report.truncated, false);
  assert.deepEqual(report.context, {
    repository: CONTEXT.GITHUB_REPOSITORY,
    headSha: HEAD,
    runId: CONTEXT.GITHUB_RUN_ID,
    runAttempt: 3,
  });
  assert.equal(report.producerSha256, await expectedProducerDigest());
  assert.equal(report.counts.testCount, 1);
  assert.equal(report.counts.passedTestCount, 1);
  assert.equal(report.counts.failedTestCount, 0);
});

test('classifies an actual native AssertionError with one stable canonical test identity', () => {
  const first = requireReport('assertion');
  const second = requireReport('assertion');
  assert.equal(first.exitCode, 1);
  assert.equal(first.report.complete, true);
  assert.equal(first.report.counts.assertionFailureCount, 1);
  assert.equal(first.report.failures.length, 1);
  assert.equal(first.report.failures[0].category, 'assertion');
  assert.match(first.report.failures[0].testIdentitySha256, /^[a-f0-9]{64}$/);
  assert.equal(first.report.failures[0].testIdentitySha256, second.report.failures[0].testIdentitySha256);
  assert.equal(first.report.counts.setupFailureCount, 0);
  assert.equal(first.report.counts.syntaxFailureCount, 0);
});

test('classifies native hook and syntax failures separately from assertion regressions', () => {
  const setup = requireReport('setup');
  const syntax = requireReport('syntax');
  assert.equal(setup.report.complete, true);
  assert.equal(setup.report.counts.setupFailureCount, 1);
  assert.equal(setup.report.counts.assertionFailureCount, 0);
  assert.equal(syntax.report.complete, true);
  assert.equal(syntax.report.counts.syntaxFailureCount, 1);
  assert.equal(syntax.report.counts.assertionFailureCount, 0);
});

test('does not count nested aggregate failures as additional leaf failures', () => {
  const { report } = requireReport('nested');
  assert.equal(report.complete, true);
  assert.equal(report.counts.testCount, 2);
  assert.equal(report.counts.failedTestCount, 1);
  assert.equal(report.counts.aggregateFailureCount, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].category, 'assertion');
});

test('drops forged child commands and leaves annotation publication to the trusted formatter', () => {
  const result = requireReport('stdout');
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, /::|##\[|\r|\u001b/);
  const command = buildTrustedAnnotation({
    ...CONTEXT,
    MELLON_CI_ENCODED_REPORT: Buffer.from(JSON.stringify(result.report)).toString('base64url'),
    MELLON_CI_TEST_EXIT_CODE: '0',
    MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
  });
  assert.match(command, /^::notice::MELLON_CI_REPORT_V2:/);
  assert.doesNotMatch(command, /::error::forged|::notice::forged/);
});

test('marks malformed head, run, and attempt context unsupported', () => {
  for (const [key, value] of [
    ['GITHUB_SHA', 'not-a-commit'],
    ['GITHUB_RUN_ID', '0'],
    ['GITHUB_RUN_ATTEMPT', '1.5'],
  ]) {
    const { report, exitCode } = requireReport('green', { [key]: value });
    assert.equal(report.complete, false);
    assert.equal(report.reason, 'invalid_context');
    assert.notEqual(exitCode, 0);
  }
});

test('bounds test identity and failure output without claiming complete evidence', () => {
  const oversized = requireReport('largeName');
  const overflow = requireReport('failureOverflow');
  const controlName = requireReport('controlName');
  for (const { report } of [oversized, overflow]) {
    assert.equal(report.complete, false);
    assert.equal(report.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 24 * 1024);
  }
  assert.equal(controlName.report.complete, false);
  assert.equal(controlName.report.reason, 'malformed_event');
  assert.doesNotMatch(controlName.output, /::error::forged/);
});

test('trusted formatter rejects changed context, malformed data, and forged exit status', () => {
  const { report } = requireReport('green');
  const encoded = Buffer.from(JSON.stringify(report)).toString('base64url');
  const expected = {
    ...CONTEXT,
    MELLON_CI_ENCODED_REPORT: encoded,
    MELLON_CI_TEST_EXIT_CODE: '0',
    MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
  };
  assert.match(buildTrustedAnnotation(expected), /^::notice::MELLON_CI_REPORT_V2:/);
  assert.equal(buildTrustedAnnotation({ ...expected, GITHUB_RUN_ATTEMPT: '4' }), null);
  assert.equal(buildTrustedAnnotation({ ...expected, MELLON_CI_ENCODED_REPORT: 'not_base64!' }), null);
  assert.equal(buildTrustedAnnotation({ ...expected, MELLON_CI_TEST_EXIT_CODE: '256' }), null);
});

test('runner keeps the npm test set and script route unchanged apart from its protected entrypoint', async () => {
  const runner = await runnerExports();
  assert.equal(typeof runner?.fixedTestFiles, 'function');
  const directories = ['detector/tests', 'tests/unit', 'tests/integration', 'scripts/tests'];
  const expected = directories.flatMap(directory =>
    globSync(`${directory}/*.test.mjs`, { cwd: ROOT })
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(runner.fixedTestFiles(), expected);
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node automation/ci/run-tests.mjs');
});

test('runner rejects missing, renamed, and nonregular baseline tests before execution', async t => {
  const probe = path.join(FIXTURE_ROOT, 'test-set-probe.mjs');
  for (const mode of ['omit', 'rename', 'symlink']) {
    for (const target of ['action.test.mjs', 'agent-worker-recovery.test.mjs', 'inputs.test.mjs']) {
      await t.test(`${mode} ${target}`, () => {
        const child = spawnSync(process.execPath, [probe, mode, target], {
          cwd: ROOT, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 1);
        assert.equal(child.stdout, '', 'no test subprocess may start with a missing baseline');
        assert.equal(child.stderr, '');
      });
    }
  }
});

test('runner executes added regression files alongside every baseline test', async () => {
  const probe = path.join(FIXTURE_ROOT, 'test-set-probe.mjs');
  const child = spawnSync(process.execPath, [probe, 'add'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  const files = JSON.parse(child.stdout);
  assert.ok(files.includes('tests/unit/added-regression.test.mjs'));
  assert.ok(files.includes('tests/unit/action.test.mjs'));
  assert.ok(files.includes('tests/unit/agent-worker-recovery.test.mjs'));
  assert.ok(files.includes('tests/unit/inputs.test.mjs'));
  assert.equal(new Set(files).size, files.length);
});

test('local runner preserves native TAP output and child exit status', () => {
  const green = runRunnerProbe('local-green');
  assert.equal(green.exitCode, 0);
  assert.match(green.output, /✔ native green fixture/);
  const failed = runRunnerProbe('local-failure');
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /✖ selected assertion regression/);
});

test('GitHub runner emits only bounded job outputs and preserves assertion failure status', () => {
  const green = runRunnerProbe('ci-injection', CONTEXT);
  assert.equal(green.exitCode, 0);
  assert.equal(green.errorOutput, '');
  assert.equal(green.output, '');
  assert.match(green.fields.encoded_report, /^[A-Za-z0-9_-]+$/);
  assert.ok(green.fields.encoded_report.length <= 32 * 1024);
  assert.equal(green.fields.test_exit_code, '0');
  const greenReport = JSON.parse(Buffer.from(green.fields.encoded_report, 'base64url').toString('utf8'));
  assert.equal(greenReport.complete, true);
  assert.deepEqual(greenReport.context, {
    repository: CONTEXT.GITHUB_REPOSITORY,
    headSha: HEAD,
    runId: CONTEXT.GITHUB_RUN_ID,
    runAttempt: 3,
  });

  const failed = runRunnerProbe('ci-failure', CONTEXT);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /assertion failure at scripts\/tests\/fixtures\/agent-worker-ci\/assertion\.test\.mjs:4:1/);
  assert.doesNotMatch(failed.output, /selected assertion regression|missing behavior|implemented behavior|AssertionError|::error::/);
  const failureReport = JSON.parse(Buffer.from(failed.fields.encoded_report, 'base64url').toString('utf8'));
  assert.equal(failed.fields.test_exit_code, '1');
  assert.equal(failureReport.complete, true);
  assert.equal(failureReport.counts.assertionFailureCount, 1);
  assert.deepEqual(failureReport.failures.map(item => item.category), ['assertion']);
  assert.deepEqual(failureReport, requireReport('assertion').report);
});

test('CI failure locations omit private names, assertion text and arbitrary child streams', () => {
  const failed = runRunnerProbe('ci-private-failure', CONTEXT);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /private-failure\.test\.mjs:4:1/);
  assert.doesNotMatch(failed.output + failed.errorOutput,
    /SYNTHETIC_PRIVATE|AssertionError|::error::|\u001b/);
  const report = JSON.parse(Buffer.from(failed.fields.encoded_report, 'base64url').toString('utf8'));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.complete, true);
  assert.deepEqual(Object.keys(report.failures[0]).sort(), ['category', 'testIdentitySha256']);
});

test('native setup failures show only a safe source location and category', () => {
  const failed = runRunnerProbe('ci-setup', CONTEXT);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /setup failure.*setup\.test\.mjs/);
  assert.doesNotMatch(failed.output + failed.errorOutput, /fixture setup detail|setup failure fixture|Error:/);
});

test('incomplete native evidence provides a fixed diagnostic without raw event details', async () => {
  const runner = await runnerExports();
  const { report } = requireReport('controlName');
  assert.equal(report.complete, false);
  const output = runner.formatFailureDiagnostics(report, Buffer.from('SYNTHETIC_PRIVATE'), new Map());
  assert.match(output, /source locations unavailable/);
  assert.doesNotMatch(output, /SYNTHETIC_PRIVATE|::|##\[/);
});

function diagnosticPacket(report, entry = {}) {
  return Buffer.from(JSON.stringify({ version: 1, context: report.context,
    producerSha256: report.producerSha256, entries: [{
      category: 'assertion', testIdentitySha256: report.failures[0].testIdentitySha256,
      entryFile: 'scripts/tests/fixtures/agent-worker-ci/assertion.test.mjs', line: 4, column: 1,
      ...entry,
    }] }));
}

test('safe diagnostic rendering binds source coordinates to existing failure evidence and selected files', async () => {
  const runner = await runnerExports();
  assert.equal(typeof runner.prepareDiagnosticSources, 'function');
  assert.equal(typeof runner.formatFailureDiagnostics, 'function');
  const { report } = requireReport('assertion');
  const sources = runner.prepareDiagnosticSources([path.join(FIXTURE_ROOT, 'assertion.test.mjs')]);
  const output = runner.formatFailureDiagnostics(report, diagnosticPacket(report), sources);
  assert.match(output, /assertion\.test\.mjs:4:1/);
  assert.match(output, new RegExp(report.failures[0].testIdentitySha256));
  assert.doesNotMatch(output, /selected assertion regression|missing behavior|AssertionError/);
});

for (const [name, entry] of [
  ['outside repository', { entryFile: '/tmp/private-name.test.mjs' }],
  ['traversal', { entryFile: 'tests/../../private-name.test.mjs' }],
  ['unselected file', { entryFile: 'tests/unit/action.test.mjs' }],
  ['invalid line', { line: 999999 }],
  ['invalid column', { column: 999999 }],
  ['unknown identity', { testIdentitySha256: 'f'.repeat(64) }],
  ['wrong category', { category: 'syntax' }],
  ['private extra field', { message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' }],
]) test(`safe diagnostics reject ${name} without echoing input`, async () => {
  const runner = await runnerExports();
  assert.equal(typeof runner.prepareDiagnosticSources, 'function');
  const { report } = requireReport('assertion');
  const sources = runner.prepareDiagnosticSources([path.join(FIXTURE_ROOT, 'assertion.test.mjs')]);
  const output = runner.formatFailureDiagnostics(report, diagnosticPacket(report, entry), sources);
  assert.doesNotMatch(output, /private-name|SYNTHETIC_PRIVATE|action\.test\.mjs|:999999/);
  assert.match(output, /source locations unavailable/);
});

test('malformed or wrong-context diagnostic channels cannot alter machine evidence', async () => {
  const runner = await runnerExports();
  assert.equal(typeof runner.prepareDiagnosticSources, 'function');
  const { report } = requireReport('assertion');
  const before = JSON.stringify(report);
  const sources = runner.prepareDiagnosticSources([path.join(FIXTURE_ROOT, 'assertion.test.mjs')]);
  const wrong = JSON.parse(diagnosticPacket(report).toString());
  wrong.context.headSha = 'b'.repeat(40);
  const wrongProducer = JSON.parse(diagnosticPacket(report).toString());
  wrongProducer.producerSha256 = 'b'.repeat(64);
  for (const bytes of [Buffer.from('SYNTHETIC_PRIVATE_BROKEN_JSON'),
    Buffer.from(JSON.stringify(wrong)), Buffer.from(JSON.stringify(wrongProducer)),
    Buffer.alloc(32 * 1024, 'x')]) {
    const output = runner.formatFailureDiagnostics(report, bytes, sources);
    assert.match(output, /source locations unavailable/);
    assert.doesNotMatch(output, /SYNTHETIC_PRIVATE/);
  }
  assert.equal(JSON.stringify(report), before);
});

test('large reviewed reports survive GitHub four-KiB annotation readback without dropping skip identities', () => {
  const native = runRunnerProbe('ci-database-skips', CONTEXT);
  const report = JSON.parse(Buffer.from(native.fields.encoded_report, 'base64url').toString('utf8'));
  const output = buildTrustedAnnotation({ ...CONTEXT,
    MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
    MELLON_CI_ENCODED_REPORT: native.fields.encoded_report, MELLON_CI_TEST_EXIT_CODE: '0' });
  assert.equal(typeof output, 'string');
  const commands = output.split('\n');
  assert.ok(commands.length >= 2 && commands.length <= 10);
  for (const command of commands) {
    assert.ok(command.startsWith('::notice::MELLON_CI_REPORT_V2_CHUNK:'));
    assert.ok(Buffer.byteLength(command.slice('::notice::'.length)) < 4096);
    assert.equal(command.slice('::notice::'.length).slice(0, 4096), command.slice('::notice::'.length));
  }
  const parsed = parseWorkflowReport(output);
  assert.deepEqual(parsed.skippedTestIdentitySha256s, report.skippedTestIdentitySha256s);
  assert.deepEqual(parsed.counts, report.counts);
  assert.equal(parsed.schemaVersion, 2);
});

test('pins the reviewed DB policy independently of the current skipped set', async () => {
  const { DATABASE_SKIP_IDENTITIES, DATABASE_SKIP_POLICY_SHA256 } = await import('../../automation/ci/report-annotations.mjs');
  assert.equal(createHash('sha256').update(readFileSync(path.join(ROOT, 'tests/integration/agent-worker-store.test.mjs'))).digest('hex'),
    'fed4a38c547aa52f7aa891f79ad79ac323fb2db2dd67b4412428238479f996bb');
  assert.equal(DATABASE_SKIP_IDENTITIES.length, 62);
  assert.equal(DATABASE_SKIP_POLICY_SHA256, 'bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab');
  assert.equal(createHash('sha256').update(canonicalJson({
    version: 1, testIdentitySha256s: DATABASE_SKIP_IDENTITIES,
  })).digest('hex'), DATABASE_SKIP_POLICY_SHA256);
  const result = runRunnerProbe('ci-database-skips', CONTEXT);
  const report = JSON.parse(Buffer.from(result.fields.encoded_report, 'base64url'));
  assert.deepEqual([...report.skippedTestIdentitySha256s].sort(), DATABASE_SKIP_IDENTITIES);
});

test('trusted formatter accepts actual native intended RED alongside reviewed database skips', () => {
  const result = runRunnerProbe('ci-database-red', CONTEXT);
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(Buffer.from(result.fields.encoded_report, 'base64url'));
  assert.equal(report.complete, true);
  assert.equal(report.counts.skippedTestCount, 62);
  assert.equal(report.counts.assertionFailureCount, 1);
  assert.equal(report.failures.length, 1);
  const trusted = parseWorkflowReport(buildTrustedAnnotation({
    ...CONTEXT,
    MELLON_CI_ENCODED_REPORT: result.fields.encoded_report,
    MELLON_CI_TEST_EXIT_CODE: '1',
    MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
  }));
  assert.deepEqual(trusted.failures, report.failures);
  assert.deepEqual(trusted.skippedTestIdentitySha256s, report.skippedTestIdentitySha256s);
});

test('formatter independently rejects unreviewed native skips and native todo tests', () => {
  for (const fixture of ['nativeFlags', 'unrelatedSkip', 'failingTodo']) {
    const { report } = requireReport(fixture);
    assert.equal(report.complete, true);
    assert.equal(buildTrustedAnnotation({
      ...CONTEXT,
      MELLON_CI_ENCODED_REPORT: Buffer.from(JSON.stringify(report)).toString('base64url'),
      MELLON_CI_TEST_EXIT_CODE: '0',
      MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
    }), null);
  }
});

test('ambiguous native skip identities cannot produce complete evidence', () => {
  const { report } = requireReport('ambiguousSkips');
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'identity_ambiguous');
});

test('formatter rejects malformed skip enumeration, policy redefinition and inconsistent summaries', () => {
  const result = runRunnerProbe('ci-database-skips', CONTEXT);
  const base = JSON.parse(Buffer.from(result.fields.encoded_report, 'base64url'));
  const invalid = [
    { ...base, skipPolicySha256: '0'.repeat(64) },
    { ...base, skipPolicySha256: undefined },
    { ...base, skippedTestIdentitySha256s: undefined },
    { ...base, skippedTestIdentitySha256s: base.skippedTestIdentitySha256s.map(() => base.skippedTestIdentitySha256s[0]) },
    { ...base, skippedTestIdentitySha256s: base.skippedTestIdentitySha256s.slice(1) },
    { ...base, skippedTestIdentitySha256s: ['::notice::forged'] },
    { ...base, counts: { ...base.counts, passedTestCount: 1 } },
    { ...base, counts: { ...base.counts, testCount: 63, todoTestCount: 1 } },
    { ...base, counts: { ...base.counts, testCount: 63, cancelledTestCount: 1 } },
    { ...base, schemaVersion: 1 },
    { ...base, failures: [{ testIdentitySha256: base.skippedTestIdentitySha256s[0], category: 'assertion' }],
      counts: { ...base.counts, testCount: 63, failedTestCount: 1, assertionFailureCount: 1 } },
  ];
  for (const report of invalid) {
    assert.equal(buildTrustedAnnotation({
      ...CONTEXT,
      MELLON_CI_ENCODED_REPORT: Buffer.from(JSON.stringify(report)).toString('base64url'),
      MELLON_CI_TEST_EXIT_CODE: '1',
      MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
    }), null);
  }
});

test('formatter rejects coercible producer and failure identity digests', () => {
  const green = requireReport('green').report;
  const red = requireReport('assertion').report;
  const reports = [
    [{ ...green, producerSha256: [green.producerSha256] }, '0'],
    [{ ...red, failures: [{ ...red.failures[0], testIdentitySha256: [red.failures[0].testIdentitySha256] }] }, '1'],
  ];
  for (const [report, exitCode] of reports) {
    assert.equal(buildTrustedAnnotation({ ...CONTEXT,
      MELLON_CI_ENCODED_REPORT: Buffer.from(JSON.stringify(report)).toString('base64url'),
      MELLON_CI_TEST_EXIT_CODE: exitCode,
      MELLON_CI_REPORTER_REVISION: 'b'.repeat(40),
    }), null);
  }
});
