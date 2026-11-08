import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeChildEnvironment } from '../../scripts/lib/output-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPORTER_PATH = join(ROOT, 'automation/ci/test-reporter.mjs');
const PRODUCER_PATHS = [
  'automation/ci/guard-command.mjs',
  'automation/ci/run-tests.mjs',
  'automation/ci/test-reporter.mjs',
  'automation/ci/report-annotations.mjs',
  'scripts/lib/output-guard.mjs',
  'package.json',
];
const TEST_DIRECTORIES = ['detector/tests', 'tests/unit', 'tests/integration', 'scripts/tests'];
// Keep required paths in the pinned producer graph so discovery cannot drop tests.
const BASELINE_TEST_FILES = Object.freeze([
  'detector/tests/adapter.test.mjs',
  'detector/tests/bundle.test.mjs',
  'detector/tests/parity.test.mjs',
  'detector/tests/scorer-import.test.mjs',
  'tests/unit/action.test.mjs',
  'tests/unit/agent-intake-function.test.mjs',
  'tests/unit/agent-intake-github.test.mjs',
  'tests/unit/agent-intake.test.mjs',
  'tests/unit/agent-worker-agent.test.mjs',
  'tests/unit/agent-worker-approval.test.mjs',
  'tests/unit/agent-worker-budgets.test.mjs',
  'tests/unit/agent-worker-checks.test.mjs',
  'tests/unit/agent-worker-patch.test.mjs',
  'tests/unit/agent-worker-policy.test.mjs',
  'tests/unit/agent-worker-publisher.test.mjs',
  'tests/unit/agent-worker-recovery.test.mjs',
  'tests/unit/agent-worker-store.test.mjs',
  'tests/unit/github.test.mjs',
  'tests/unit/inputs.test.mjs',
  'tests/unit/moderation-boundaries.test.mjs',
  'tests/unit/moderation-label-reconciliation.test.mjs',
  'tests/unit/moderation-outcome-labels.test.mjs',
  'tests/unit/moderation.test.mjs',
  'tests/unit/personalized-classifier.test.mjs',
  'tests/unit/personalized-dataset.test.mjs',
  'tests/unit/personalized-evaluate.test.mjs',
  'tests/unit/personalized-github.test.mjs',
  'tests/unit/personalized-split.test.mjs',
  'tests/unit/prepare.test.mjs',
  'tests/unit/request-boundaries.test.mjs',
  'tests/integration/agent-intake-database-guard.test.mjs',
  'tests/integration/agent-intake-store.test.mjs',
  'tests/integration/agent-worker-store.test.mjs',
  'tests/integration/built-action.test.mjs',
  'tests/integration/personalized-cli.test.mjs',
  'scripts/tests/action-package.test.mjs',
  'scripts/tests/agent-worker-ci-reporter.test.mjs',
  'scripts/tests/agent-worker-db.test.mjs',
  'scripts/tests/build-safety.test.mjs',
  'scripts/tests/issue-forms.test.mjs',
  'scripts/tests/output-guard.test.mjs',
  'scripts/tests/workflow-validation.test.mjs',
]);
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RAW_REPORT_BYTES = 24 * 1024;
const MAX_ENCODED_REPORT_BYTES = 32 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const CI_TEST_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_TEST_EVENTS = 20000;
const MAX_DIAGNOSTIC_BYTES = 24 * 1024;
const MAX_VISIBLE_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_FAILURES = 64;
const MAX_RUN_ATTEMPT = 1000;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,15}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REPORT_PREFIX = 'MELLON_CI_RAW_V2:';
const COUNT_KEYS = [
  'testCount', 'passedTestCount', 'failedTestCount', 'aggregateFailureCount',
  'assertionFailureCount', 'setupFailureCount', 'syntaxFailureCount', 'otherFailureCount',
  'skippedTestCount', 'todoTestCount', 'cancelledTestCount', 'rootFailureCount',
];
const REPORT_KEYS = [
  'schemaVersion', 'complete', 'truncated', 'reason', 'context', 'producerSha256',
  'counts', 'failures', 'rootFailures', 'skipPolicySha256', 'skippedTestIdentitySha256s',
];
const FAILURE_CATEGORIES = new Set(['assertion', 'other', 'setup', 'syntax']);
const INCOMPLETE_REASONS = new Set([
  'event_limit', 'failure_limit', 'identity_ambiguous', 'invalid_context',
  'malformed_event', 'no_tests', 'report_limit', 'unsupported_event', 'test_limit',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, expected) {
  return isRecord(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function equalHash(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string'
    && SHA256.test(actual) && SHA256.test(expected)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function readReviewedSources() {
  const sources = [];
  for (const sourcePath of PRODUCER_PATHS) {
    const absolutePath = join(ROOT, sourcePath);
    const before = lstatSync(absolutePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SOURCE_BYTES) {
      throw new Error('source_invalid');
    }
    const bytes = readFileSync(absolutePath);
    const after = lstatSync(absolutePath);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes.length
        || bytes.length > MAX_SOURCE_BYTES) throw new Error('source_invalid');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    sources.push({ path: sourcePath, sha256: hash(bytes) });
  }
  return hash(Buffer.from(canonicalJson(sources), 'utf8'));
}

function readGitHubContext(environment) {
  const repository = environment.GITHUB_REPOSITORY;
  const headSha = environment.GITHUB_SHA;
  const runId = environment.GITHUB_RUN_ID;
  const attempt = environment.GITHUB_RUN_ATTEMPT;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)
      || typeof headSha !== 'string' || !SHA.test(headSha)
      || typeof runId !== 'string' || !RUN_ID.test(runId)
      || !Number.isSafeInteger(Number(runId))
      || typeof attempt !== 'string' || !/^[1-9][0-9]{0,2}$/.test(attempt)
      || Number(attempt) > MAX_RUN_ATTEMPT) return null;
  return { repository, headSha, runId, runAttempt: Number(attempt) };
}

export function fixedTestFiles() {
  const files = [];
  for (const directory of TEST_DIRECTORIES) {
    const entries = readdirSync(join(ROOT, directory), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
      .map(entry => `${directory}/${entry.name}`)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.length === 0) throw new Error('test_set_empty');
    files.push(...entries);
  }
  const discovered = new Set(files);
  if (BASELINE_TEST_FILES.some(file => !discovered.has(file))) {
    throw new Error('test_set_incomplete');
  }
  return files;
}

function validContext(value) {
  return sameKeys(value, ['repository', 'headSha', 'runId', 'runAttempt'])
    && typeof value.repository === 'string' && REPOSITORY.test(value.repository)
    && typeof value.headSha === 'string' && SHA.test(value.headSha)
    && typeof value.runId === 'string' && RUN_ID.test(value.runId)
    && Number.isSafeInteger(Number(value.runId))
    && Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0
    && value.runAttempt <= MAX_RUN_ATTEMPT;
}

function validCounts(value) {
  return sameKeys(value, COUNT_KEYS)
    && COUNT_KEYS.every(key => Number.isSafeInteger(value[key])
      && value[key] >= 0 && value[key] <= MAX_TEST_EVENTS);
}

function validFailureList(value, maximum, hasIdentity) {
  return Array.isArray(value) && value.length <= maximum
    && value.every(item => hasIdentity
      ? sameKeys(item, ['testIdentitySha256', 'category'])
        && typeof item.testIdentitySha256 === 'string' && SHA256.test(item.testIdentitySha256)
        && FAILURE_CATEGORIES.has(item.category)
      : sameKeys(item, ['category']) && FAILURE_CATEGORIES.has(item.category));
}

function reportCountsAgree(report) {
  const counts = report.counts;
  const categoryTotal = counts.assertionFailureCount + counts.setupFailureCount
    + counts.syntaxFailureCount + counts.otherFailureCount;
  const testTotal = counts.passedTestCount + counts.failedTestCount
    + counts.aggregateFailureCount + counts.skippedTestCount + counts.todoTestCount
    + counts.cancelledTestCount;
  const actualCategories = report.failures.reduce((total, failure) => {
    total[failure.category] += 1;
    return total;
  }, { assertion: 0, other: 0, setup: 0, syntax: 0 });
  const rootCategories = report.rootFailures.reduce((total, failure) => {
    total[failure.category] += 1;
    return total;
  }, { assertion: 0, other: 0, setup: 0, syntax: 0 });
  return counts.failedTestCount === report.failures.length
    && counts.rootFailureCount === report.rootFailures.length
    && counts.skippedTestCount === report.skippedTestIdentitySha256s.length
    && counts.testCount === testTotal
    && categoryTotal === counts.failedTestCount + counts.rootFailureCount
    && counts.assertionFailureCount === actualCategories.assertion + rootCategories.assertion
    && counts.otherFailureCount === actualCategories.other + rootCategories.other
    && counts.setupFailureCount === actualCategories.setup + rootCategories.setup
    && counts.syntaxFailureCount === actualCategories.syntax + rootCategories.syntax;
}

function validRawReport(report) {
  if (!sameKeys(report, REPORT_KEYS) || report.schemaVersion !== 2
      || typeof report.complete !== 'boolean' || typeof report.truncated !== 'boolean'
      || !validContext(report.context) || typeof report.producerSha256 !== 'string'
      || !SHA256.test(report.producerSha256) || !validCounts(report.counts)
      || !validFailureList(report.failures, MAX_FAILURES, true)
      || !validFailureList(report.rootFailures, MAX_FAILURES, false)
      || typeof report.skipPolicySha256 !== 'string' || !SHA256.test(report.skipPolicySha256)
      || !Array.isArray(report.skippedTestIdentitySha256s) || report.skippedTestIdentitySha256s.length > 64
      || !report.skippedTestIdentitySha256s.every(id => typeof id === 'string' && SHA256.test(id))
      || new Set(report.skippedTestIdentitySha256s).size !== report.skippedTestIdentitySha256s.length
      || report.failures.some(item => report.skippedTestIdentitySha256s.includes(item.testIdentitySha256))
      || new Set(report.failures.map(failure => failure.testIdentitySha256)).size !== report.failures.length) return false;
  if (report.complete) {
    return report.truncated === false && report.reason === null
      && (report.counts.testCount > 0 || report.counts.rootFailureCount > 0)
      && reportCountsAgree(report);
  }
  return typeof report.reason === 'string' && INCOMPLETE_REASONS.has(report.reason);
}

function decodeReporterOutput(stdout) {
  if (!Buffer.isBuffer(stdout) || stdout.length === 0 || stdout.length > MAX_CHILD_OUTPUT_BYTES) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch {
    return null;
  }
  if (!text.endsWith('\n') || text.includes('\r')) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 1 || !lines[0].startsWith(REPORT_PREFIX)) return null;
  const encoded = lines[0].slice(REPORT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let bytes;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length > MAX_RAW_REPORT_BYTES || bytes.toString('base64url') !== encoded) return null;
  try {
    const textReport = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const report = JSON.parse(textReport);
    return validRawReport(report) ? report : null;
  } catch {
    return null;
  }
}

export function prepareDiagnosticSources(files) {
  const sources = new Map();
  if (!Array.isArray(files) || files.length > 4096) return sources;
  for (const file of files) {
    try {
      if (typeof file !== 'string' || file.length > 2048) continue;
      const absolute = resolve(ROOT, file);
      const name = relative(ROOT, absolute).split(sep).join('/');
      if (isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')
        || !/^(?:detector\/tests|tests\/(?:unit|integration)|scripts\/tests)\/[A-Za-z0-9._/-]+\.mjs$/.test(name)
        || name.length > 512 || realpathSync(absolute) !== absolute) continue;
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absolute));
      sources.set(name, text.split(/\r?\n/u).map(line => line.length + 1));
    } catch {}
  }
  return sources;
}

export function formatFailureDiagnostics(report, data, sources) {
  const unavailable = '[ci] Test failure source locations unavailable.\n';
  if (!validRawReport(report)) return unavailable;
  const total = report.counts.failedTestCount + report.counts.rootFailureCount;
  if (!report.complete) return unavailable;
  if (total === 0 && report.counts.cancelledTestCount === 0) return '';
  if (!Buffer.isBuffer(data) || data.length === 0
    || data.length > MAX_DIAGNOSTIC_BYTES || !(sources instanceof Map)) return unavailable;
  let packet;
  try { packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { return unavailable; }
  if (!sameKeys(packet, ['version', 'context', 'producerSha256', 'entries'])
    || packet.version !== 1 || !validContext(packet.context)
    || canonicalJson(packet.context) !== canonicalJson(report.context)
    || !equalHash(packet.producerSha256, report.producerSha256)
    || !Array.isArray(packet.entries) || packet.entries.length > MAX_FAILURES) return unavailable;
  const known = new Map(report.failures.map(item => [item.testIdentitySha256, item.category]));
  const roots = report.rootFailures.reduce((counts, item) => {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1); return counts;
  }, new Map());
  const seen = new Set();
  const lines = [];
  let bytes = 0;
  for (const entry of packet.entries) {
    if (!isRecord(entry) || typeof entry.entryFile !== 'string' || !sources.has(entry.entryFile)) return unavailable;
    let line;
    let identity;
    if (entry.root === true) {
      if (!sameKeys(entry, ['root', 'category', 'entryFile']) || !(roots.get(entry.category) > 0)) return unavailable;
      roots.set(entry.category, roots.get(entry.category) - 1);
      identity = `root:${entry.entryFile}:${entry.category}`;
      line = `[ci] ${entry.category} failure in ${entry.entryFile} (file-level location).`;
    } else {
      const positioned = Object.hasOwn(entry, 'line') || Object.hasOwn(entry, 'column');
      if (!sameKeys(entry, positioned
        ? ['category', 'testIdentitySha256', 'entryFile', 'line', 'column']
        : ['category', 'testIdentitySha256', 'entryFile'])
        || !known.has(entry.testIdentitySha256) || known.get(entry.testIdentitySha256) !== entry.category) return unavailable;
      identity = entry.testIdentitySha256;
      const columns = sources.get(entry.entryFile);
      if (positioned && (!Number.isSafeInteger(entry.line) || entry.line < 1 || entry.line > columns.length
        || !Number.isSafeInteger(entry.column) || entry.column < 1
        || entry.column > columns[entry.line - 1])) return unavailable;
      const position = positioned ? `:${entry.line}:${entry.column}` : ' (entry file; exact location unavailable)';
      line = `[ci] ${entry.category} failure at ${entry.entryFile}${position} (test ${identity}).`;
    }
    if (seen.has(identity)) return unavailable;
    seen.add(identity);
    const length = Buffer.byteLength(line) + 1;
    if (bytes + length <= MAX_VISIBLE_DIAGNOSTIC_BYTES - 128) { lines.push(line); bytes += length; }
  }
  const missing = total - lines.length;
  if (missing > 0) lines.push(`[ci] ${missing} additional failure source locations unavailable.`);
  if (report.counts.cancelledTestCount > 0) lines.push(`[ci] ${report.counts.cancelledTestCount} native tests cancelled.`);
  return lines.length ? lines.join('\n') + '\n' : unavailable;
}

export function runLocally(files) {
  const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (child.error) {
    process.stderr.write('Unable to start the Node test runner.\n');
    return 1;
  }
  return Number.isSafeInteger(child.status) ? child.status : 1;
}

export function runInGitHubActions(files) {
  const context = readGitHubContext(process.env);
  if (!context) return 1;

  let producerSha256;
  try {
    producerSha256 = readReviewedSources();
  } catch {
    return 1;
  }
  const sources = prepareDiagnosticSources(files);
  const environment = { ...safeChildEnvironment({
    ...process.env,
    MELLON_CI_PRODUCER_SHA256: producerSha256,
  }), MELLON_CI_DIAGNOSTIC_FD: '4' };
  const child = spawnSync(process.execPath, [
    '--test', '--test-concurrency=1', `--test-reporter=${REPORTER_PATH}`, ...files,
  ], {
    cwd: ROOT,
    env: environment,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'],
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    timeout: CI_TEST_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });
  if (child.error || child.signal !== null || !Number.isSafeInteger(child.status)) return 1;

  let currentProducerSha256;
  try {
    currentProducerSha256 = readReviewedSources();
  } catch {
    return 1;
  }
  if (!equalHash(currentProducerSha256, producerSha256)) return 1;

  const report = decodeReporterOutput(child.stdout);
  if (!report) return 1;
  const encodedReport = Buffer.from(JSON.stringify(report), 'utf8').toString('base64url');
  if (encodedReport.length > MAX_ENCODED_REPORT_BYTES || !process.env.GITHUB_OUTPUT) return 1;
  try {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `encoded_report=${encodedReport}\ntest_exit_code=${child.status}\n`,
      { encoding: 'utf8', mode: 0o600 });
  } catch {
    return 1;
  }
  // Only validated coordinates cross the private channel; raw child streams stay suppressed.
  const diagnostic = formatFailureDiagnostics(report, child.output?.[4], sources);
  if (diagnostic) process.stdout.write(diagnostic);
  return report.complete ? child.status : Math.max(1, child.status);
}

function main() {
  try {
    const files = fixedTestFiles();
    const status = process.env.GITHUB_ACTIONS === 'true'
      ? runInGitHubActions(files)
      : runLocally(files);
    if (status !== 0) process.exitCode = status;
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
