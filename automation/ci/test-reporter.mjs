import { createHash } from 'node:crypto';
import { fstatSync, writeSync } from 'node:fs';
import { DATABASE_SKIP_POLICY_SHA256 } from './report-annotations.mjs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const RAW_PREFIX = 'MELLON_CI_RAW_V2:';
const MAX_DIAGNOSTIC_BYTES = 24 * 1024;
let diagnosticFd = null;
if (process.env.MELLON_CI_DIAGNOSTIC_FD === '4') {
  try {
    const stat = fstatSync(4);
    if (stat.isFIFO() || stat.isSocket()) diagnosticFd = 4;
  } catch {}
}
// This private controller channel must not propagate into test subprocesses.
delete process.env.MELLON_CI_DIAGNOSTIC_FD;
const MAX_EVENTS = 20000;
const MAX_TESTS = 4096;
const MAX_FAILURES = 64;
const MAX_SKIPS = 64;
const MAX_REPORT_BYTES = 24 * 1024;
const MAX_NAME_LENGTH = 1024;
const MAX_PATH_LENGTH = 512;
const MAX_NESTING = 32;
const RUN_ATTEMPT_LIMIT = 1000;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const RUN_ID = /^[1-9][0-9]{0,15}$/;
const ALLOWED_EVENTS = new Set([
  'test:complete', 'test:coverage', 'test:dequeue', 'test:diagnostic', 'test:enqueue',
  'test:fail', 'test:pass', 'test:plan', 'test:start', 'test:stderr', 'test:stdout',
  'test:summary',
]);
const INCOMPLETE_REASONS = new Set([
  'event_limit', 'failure_limit', 'identity_ambiguous', 'invalid_context',
  'malformed_event', 'no_tests', 'report_limit', 'unsupported_event', 'test_limit',
]);
const COUNT_KEYS = [
  'testCount', 'passedTestCount', 'failedTestCount', 'aggregateFailureCount',
  'assertionFailureCount', 'setupFailureCount', 'syntaxFailureCount', 'otherFailureCount',
  'skippedTestCount', 'todoTestCount', 'cancelledTestCount', 'rootFailureCount',
];
const NATIVE_SUMMARY_KEYS = ['tests', 'failed', 'passed', 'cancelled', 'skipped', 'todo', 'topLevel', 'suites'];

function isRecord(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function ownValue(record, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function validPositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validNonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function safeText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function readContext(environment) {
  const repository = environment.GITHUB_REPOSITORY;
  const headSha = environment.GITHUB_SHA;
  const runId = environment.GITHUB_RUN_ID;
  const attemptText = environment.GITHUB_RUN_ATTEMPT;
  const producerSha256 = environment.MELLON_CI_PRODUCER_SHA256;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)
      || typeof headSha !== 'string' || !SHA.test(headSha)
      || typeof runId !== 'string' || !RUN_ID.test(runId)
      || !Number.isSafeInteger(Number(runId))
      || typeof attemptText !== 'string' || !/^[1-9][0-9]{0,2}$/.test(attemptText)
      || !validPositiveInteger(Number(attemptText), RUN_ATTEMPT_LIMIT)
      || typeof producerSha256 !== 'string' || !SHA256.test(producerSha256)) return null;
  return {
    context: { repository, headSha, runId, runAttempt: Number(attemptText) },
    producerSha256,
  };
}

function normalizedFile(file) {
  if (!safeText(file, MAX_PATH_LENGTH * 4)) return null;
  const root = resolve(process.cwd());
  const absolute = resolve(root, file);
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
  const normalized = path.split(sep).join('/');
  return safeText(normalized, MAX_PATH_LENGTH) && !/[\\:]/u.test(normalized) ? normalized : null;
}

function testIdentity(data, details) {
  const name = ownValue(data, 'name');
  const entryFile = normalizedFile(ownValue(data, 'entryFile'));
  const line = ownValue(data, 'line');
  const column = ownValue(data, 'column');
  const nesting = ownValue(data, 'nesting');
  const type = ownValue(details, 'type');
  if (typeof name === 'string' && name.length > MAX_NAME_LENGTH) return { reason: 'test_limit' };
  if (!safeText(name, MAX_NAME_LENGTH) || /::|##\[/u.test(name) || !entryFile
      || !validPositiveInteger(line) || !validPositiveInteger(column)
      || !validNonNegativeInteger(nesting, MAX_NESTING) || type !== 'test') return null;
  const identity = { column, entryFile, line, name, nesting, type };
  const sourceFile = normalizedFile(ownValue(data, 'file'));
  return { identitySha256: hashJson(identity), entryFile,
    ...(sourceFile === entryFile ? { line, column } : {}) };
}

function errorCategory(error, rootFailure) {
  let current = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    const failureType = ownValue(current, 'failureType');
    const name = ownValue(current, 'name');
    const code = ownValue(current, 'code');
    if (failureType === 'hookFailed') return 'setup';
    if (name === 'AssertionError' || code === 'ERR_ASSERTION') return 'assertion';
    if (name === 'SyntaxError') return 'syntax';
    const cause = ownValue(current, 'cause');
    if (rootFailure && typeof cause === 'string') {
      const firstLine = cause.split(/[\r\n]/u, 1)[0];
      if (/^SyntaxError(?:\s|:)/u.test(firstLine)) return 'syntax';
    }
    current = cause;
  }
  return 'other';
}

function makeCounts() {
  return Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
}

function safeReason(value) {
  return INCOMPLETE_REASONS.has(value) ? value : 'malformed_event';
}

function buildReport(source, contextInfo) {
  const counts = makeCounts();
  const failures = [];
  const rootFailures = [];
  const diagnostics = [];
  const skippedTestIdentitySha256s = [];
  const enqueued = new Set();
  const completed = new Set();
  const identities = new Set();
  const fileSummaries = new Set();
  let events = 0;
  let truncated = false;
  let reason = contextInfo ? null : 'invalid_context';
  let streamEnded = false;
  let globalSummary;

  function markIncomplete(nextReason, isTruncated = false) {
    if (reason === null) reason = safeReason(nextReason);
    if (isTruncated) truncated = true;
  }

  function eventKey(data, entryFile) {
    const testId = ownValue(data, 'testId');
    if (!validPositiveInteger(testId)) return null;
    return canonicalJson({ entryFile, testId });
  }

  function addFailure(category, identitySha256 = null, rootFailure = false, location = null) {
    counts[`${category}FailureCount`] += 1;
    if (rootFailure) {
      counts.rootFailureCount += 1;
      if (rootFailures.length < MAX_FAILURES) {
        rootFailures.push({ category });
        if (location && diagnostics.length < MAX_FAILURES) {
          diagnostics.push({ root: true, category, entryFile: location.entryFile });
        }
      } else markIncomplete('failure_limit', true);
      return;
    }
    counts.failedTestCount += 1;
    if (identitySha256 === null) {
      markIncomplete('malformed_event');
      return;
    }
    if (failures.length < MAX_FAILURES) {
      failures.push({ testIdentitySha256: identitySha256, category });
      if (location && diagnostics.length < MAX_FAILURES) {
        diagnostics.push({ category, testIdentitySha256: identitySha256,
          entryFile: location.entryFile,
          ...(location.line === undefined ? {} : { line: location.line, column: location.column }) });
      }
    } else markIncomplete('failure_limit', true);
  }

  function readSummary(data) {
    const summaryCounts = ownValue(data, 'counts');
    const success = ownValue(data, 'success');
    if (!isRecord(summaryCounts) || Object.keys(summaryCounts).length !== NATIVE_SUMMARY_KEYS.length
        || !NATIVE_SUMMARY_KEYS.every(key => Object.hasOwn(summaryCounts, key))
        || !NATIVE_SUMMARY_KEYS.every(key => validNonNegativeInteger(ownValue(summaryCounts, key), MAX_EVENTS))
        || typeof success !== 'boolean') {
      markIncomplete('malformed_event');
      return;
    }
    const entryFileValue = ownValue(data, 'entryFile');
    if (entryFileValue === undefined) {
      if (globalSummary) markIncomplete('malformed_event');
      else globalSummary = { success, counts: summaryCounts };
      return;
    }
    const entryFile = normalizedFile(entryFileValue);
    if (!entryFile || fileSummaries.has(entryFile)) markIncomplete('malformed_event');
    else fileSummaries.add(entryFile);
  }

  return (async () => {
    try {
      for await (const event of source) {
        events += 1;
        if (events > MAX_EVENTS) {
          markIncomplete('event_limit', true);
          continue;
        }
        if (!isRecord(event) || !ALLOWED_EVENTS.has(ownValue(event, 'type'))) {
          markIncomplete('unsupported_event');
          continue;
        }
        const type = ownValue(event, 'type');
        const data = ownValue(event, 'data');
        if (!isRecord(data)) {
          markIncomplete('malformed_event');
          continue;
        }
        if (type === 'test:summary') {
          readSummary(data);
          continue;
        }
        if (type === 'test:enqueue') {
          const entryFileValue = ownValue(data, 'entryFile');
          if (entryFileValue === undefined) continue;
          const entryFile = normalizedFile(entryFileValue);
          const key = entryFile && eventKey(data, entryFile);
          if (!key || enqueued.has(key)) markIncomplete('malformed_event');
          else enqueued.add(key);
          continue;
        }
        if (type !== 'test:complete') continue;

        const details = ownValue(data, 'details');
        if (!isRecord(details) || ownValue(details, 'type') !== 'test'
            || typeof ownValue(details, 'passed') !== 'boolean') {
          markIncomplete('malformed_event');
          continue;
        }
        const entryFileValue = ownValue(data, 'entryFile');
        if (entryFileValue === undefined) {
          const name = ownValue(data, 'name');
          if (!safeText(name, MAX_PATH_LENGTH * 4)) {
            markIncomplete('malformed_event');
            continue;
          }
          const error = ownValue(details, 'error');
          if (error !== undefined && error !== null) {
            if (ownValue(error, 'failureType') !== 'subtestsFailed') {
              const entryFile = normalizedFile(ownValue(data, 'file'));
              addFailure(errorCategory(error, true), null, true, entryFile ? { entryFile } : null);
            }
          }
          continue;
        }

        const identity = testIdentity(data, details);
        if (identity?.reason === 'test_limit') {
          markIncomplete('test_limit', true);
          continue;
        }
        const entryFile = identity?.entryFile;
        const key = entryFile && eventKey(data, entryFile);
        if (!identity || !key || !enqueued.has(key) || completed.has(key)) {
          markIncomplete('malformed_event');
          continue;
        }
        completed.add(key);
        if (identities.has(identity.identitySha256)) markIncomplete('identity_ambiguous');
        identities.add(identity.identitySha256);
        counts.testCount += 1;
        if (counts.testCount > MAX_TESTS) markIncomplete('test_limit', true);

        const skip = ownValue(data, 'skip');
        const todo = ownValue(data, 'todo');
        const cancelled = ownValue(data, 'cancelled');
        const error = ownValue(details, 'error');
        const validFlag = value => value === undefined || typeof value === 'boolean'
          || typeof value === 'string' && value.length <= MAX_NAME_LENGTH
            && !/[\u0000-\u001f\u007f-\u009f]|::|##\[/u.test(value);
        const isSkip = skip === true || typeof skip === 'string';
        const isTodo = todo === true || typeof todo === 'string';
        if (!validFlag(skip) || !validFlag(todo)
            || cancelled !== undefined && typeof cancelled !== 'boolean'
            || isSkip && isTodo || (isSkip || isTodo) && cancelled === true
            || isSkip && (error !== undefined && error !== null || !ownValue(details, 'passed'))) {
          markIncomplete('malformed_event');
          continue;
        }
        if (isSkip) {
          counts.skippedTestCount += 1;
          if (skippedTestIdentitySha256s.length < MAX_SKIPS) {
            skippedTestIdentitySha256s.push(identity.identitySha256);
          } else markIncomplete('test_limit', true);
          continue;
        }
        if (isTodo) {
          counts.todoTestCount += 1;
          continue;
        }
        if (cancelled === true) {
          counts.cancelledTestCount += 1;
          continue;
        }
        if (error === undefined || error === null) {
          if (ownValue(details, 'passed')) counts.passedTestCount += 1;
          else markIncomplete('malformed_event');
          continue;
        }
        if (!isRecord(error)) {
          markIncomplete('malformed_event');
          continue;
        }
        if (ownValue(error, 'failureType') === 'subtestsFailed') {
          counts.aggregateFailureCount += 1;
          continue;
        }
        addFailure(errorCategory(error, false), identity.identitySha256, false, identity);
      }
      streamEnded = true;
    } catch {
      markIncomplete('malformed_event');
    }

    if (!streamEnded) markIncomplete('malformed_event');
    if (counts.testCount === 0 && counts.rootFailureCount === 0) markIncomplete('no_tests');
    if (enqueued.size !== completed.size || [...enqueued].some(key => !completed.has(key))) {
      markIncomplete('malformed_event');
    }
    if (!globalSummary) markIncomplete('malformed_event');
    else {
      const native = globalSummary.counts;
      if (native.tests !== counts.testCount + counts.rootFailureCount
          || native.failed !== counts.failedTestCount + counts.aggregateFailureCount + counts.rootFailureCount
          || native.passed !== counts.passedTestCount
          || native.skipped !== counts.skippedTestCount
          || native.todo !== counts.todoTestCount
          || native.cancelled !== counts.cancelledTestCount
          || globalSummary.success !== (native.failed === 0 && native.cancelled === 0)) {
        markIncomplete('malformed_event');
      }
    }

    const report = {
      schemaVersion: 2,
      complete: reason === null && streamEnded && !truncated,
      truncated,
      reason,
      context: contextInfo?.context ?? null,
      producerSha256: contextInfo?.producerSha256 ?? null,
      counts,
      failures,
      rootFailures,
      skipPolicySha256: DATABASE_SKIP_POLICY_SHA256,
      skippedTestIdentitySha256s,
    };
    let json = JSON.stringify(report);
    if (Buffer.byteLength(json, 'utf8') > MAX_REPORT_BYTES) {
      report.complete = false;
      report.truncated = true;
      report.reason = 'report_limit';
      report.failures = [];
      report.rootFailures = [];
      report.skippedTestIdentitySha256s = [];
      json = JSON.stringify(report);
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_REPORT_BYTES) {
      report.context = null;
      report.producerSha256 = null;
      report.counts = makeCounts();
      report.reason = 'report_limit';
      report.failures = [];
      report.rootFailures = [];
      report.skippedTestIdentitySha256s = [];
      json = JSON.stringify(report);
    }
    if (!report.complete) process.exitCode = 1;
    if (diagnosticFd !== null) {
      const packet = { version: 1, context: report.context, producerSha256: report.producerSha256,
        entries: report.complete ? diagnostics : [] };
      while (packet.entries.length && Buffer.byteLength(JSON.stringify(packet)) > MAX_DIAGNOSTIC_BYTES) {
        packet.entries.pop();
      }
      try { writeSync(diagnosticFd, JSON.stringify(packet)); } catch {}
    }
    return `${RAW_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}\n`;
  })();
}

export default async function* nativeTestReporter(source) {
  const contextInfo = readContext(process.env);
  yield await buildReport(source, contextInfo);
}
