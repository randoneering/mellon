import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';

const SAFE_ERROR = 'Worker storage operation failed.';
const SECRET_ERROR = 'synthetic private database detail';

function manifest() {
  return {
    repositoryId: 123,
    repositoryFullName: 'org/repo',
    issueId: 456,
    issueNumber: 7,
    actorId: 789,
    manifestHash: 'a'.repeat(64),
    baseRevision: 'b'.repeat(40),
    policyRevision: 'c'.repeat(40),
    limits: {
      nonterminalPilotRuns: 1,
      modelCallsPerTick: 1,
      modelCallsPerRun: 20,
      inputTokensPerCall: 8000,
      outputTokensPerCall: 2000,
      inputTokensPerRun: 100000,
      outputTokensPerRun: 20000,
      tickDeadlineSeconds: 90,
      modelCallDeadlineSeconds: 45,
      leaseSeconds: 180,
      expiredLeaseRecoveries: 2,
      ciWaitSeconds: 1800,
      reviewWaitSeconds: 1800,
      runLifetimeSeconds: 7200,
      repairCycles: 2,
    },
  };
}

async function rejectionOf(promise) {
  return Promise.resolve(promise).then(
    () => null,
    error => error,
  );
}

function assertSanitized(error, label) {
  assert.equal(error instanceof Error, true, `${label} must reject with an Error`);
  assert.equal(error?.message === SAFE_ERROR, true, `${label} must use the fixed safe message`);
  assert.equal(error?.message?.includes(SECRET_ERROR), false, `${label} must not expose the database detail`);
  assert.equal(error && Object.hasOwn(error, 'cause'), false, `${label} must not preserve a raw cause`);
}

test('claimTick sanitizes pool.connect failures', async () => {
  const store = createWorkerStore({
    async connect() {
      throw new Error(SECRET_ERROR);
    },
    async query() {
      throw new Error(SECRET_ERROR);
    },
  });
  const error = await rejectionOf(store.claimTick({ invocationId: randomUUID(), manifest: manifest() }));
  assertSanitized(error, 'pool.connect failure');
});

test('claimTick sanitizes transaction query failures', async () => {
  const store = createWorkerStore({
    async connect() {
      return {
        async query() {
          throw new Error(SECRET_ERROR);
        },
        release() {},
      };
    },
    async query() {
      throw new Error(SECRET_ERROR);
    },
  });
  const error = await rejectionOf(store.claimTick({ invocationId: randomUUID(), manifest: manifest() }));
  assertSanitized(error, 'transaction query failure');
});

test('failed rollback discards the client without leaking either database exception', async () => {
  let discarded;
  const commands = [];
  const worker = createWorkerStore({
    async connect() {
      return {
        async query(sql) {
          commands.push(sql);
          if (sql === 'BEGIN' || sql.startsWith('SET LOCAL')) return { rows: [] };
          throw new Error(SECRET_ERROR);
        },
        release(value) { discarded = value; },
      };
    },
    async query() { throw new Error(SECRET_ERROR); },
  });
  const error = await rejectionOf(worker.claimTick({ invocationId: randomUUID(), manifest: manifest() }));
  assertSanitized(error, 'rollback failure');
  assert.equal(commands.includes('ROLLBACK'), true);
  assert.ok(discarded, 'an uncertain transaction client must not return to the pool');
  if (discarded instanceof Error) assertSanitized(discarded, 'discard reason');
});

test('lost commit acknowledgment is sanitized and discards the connection even after successful rollback', async () => {
  let discarded;
  const commands = [];
  const worker = createWorkerStore({
    async connect() {
      return {
        async query(sql) {
          commands.push(sql);
          if (sql === 'COMMIT') throw new Error(SECRET_ERROR);
          if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: false }] };
          return { rows: [] };
        },
        release(value) { discarded = value; },
      };
    },
    async query() { throw new Error(SECRET_ERROR); },
  });
  const error = await rejectionOf(worker.claimTick({ invocationId: randomUUID(), manifest: manifest() }));
  assertSanitized(error, 'commit uncertainty');
  assert.equal(commands.includes('COMMIT'), true);
  assert.equal(commands.includes('ROLLBACK'), true);
  assert.ok(discarded);
  if (discarded instanceof Error) assertSanitized(discarded, 'discard reason');
});

test('pool release exceptions cannot replace the safe store error', async () => {
  const worker = createWorkerStore({
    async connect() {
      return {
        async query(sql) {
          return { rows: sql.includes('pg_try_advisory_xact_lock') ? [{ locked: false }] : [] };
        },
        release() { throw new Error(SECRET_ERROR); },
      };
    },
    async query() { throw new Error(SECRET_ERROR); },
  });
  const error = await rejectionOf(worker.claimTick({ invocationId: randomUUID(), manifest: manifest() }));
  assertSanitized(error, 'release failure');
});

test('recovery fence and confirmation validate typed inputs before database access', async () => {
  let queries = 0;
  const worker = createWorkerStore({
    async connect() { queries += 1; throw new Error(SECRET_ERROR); },
    async query() { queries += 1; throw new Error(SECRET_ERROR); },
  });
  assert.equal(typeof worker.fenceIntent, 'function');
  assert.equal(typeof worker.confirmIntent, 'function');
  const lease = { runId: randomUUID(), jobId: randomUUID(), repositoryId: 123,
    repositoryFullName: 'org/repo', issueId: 456, issueNumber: 7, actorId: 789,
    generation: 1, token: randomUUID(), expiresAt: new Date(Date.now() + 180000).toISOString() };
  const intent = { key: 'a'.repeat(64), kind: 'commit_create',
    inputHash: 'b'.repeat(64), expectedHeadSha: 'c'.repeat(40) };
  const proof = { status: 'confirmed', branch: `agent-work/${lease.runId}`,
    inputHash: intent.inputHash, baseSha: 'd'.repeat(40), parentSha: intent.expectedHeadSha,
    commitSha: 'e'.repeat(40), treeSha: 'f'.repeat(40), branchHeadSha: 'e'.repeat(40) };
  for (const call of [
    () => worker.fenceIntent({}, {}, 'commit'),
    () => worker.confirmIntent({}, {}, { raw: SECRET_ERROR }),
    () => worker.fenceIntent(lease, { ...intent, privateText: SECRET_ERROR }, 'branch'),
    () => worker.fenceIntent(lease, intent, 'arbitrary-effect'),
    () => worker.fenceIntent(lease, intent, 'pr'),
    () => worker.confirmIntent(lease, intent, { ...proof, raw: SECRET_ERROR }),
    () => worker.confirmIntent(lease, intent, { ...proof, inputHash: '0'.repeat(64) }),
    () => worker.confirmIntent(lease, { ...intent, kind: 'pr_create' }, {
      status: 'confirmed', branch: proof.branch, inputHash: intent.inputHash,
      baseSha: proof.baseSha, branchHeadSha: intent.expectedHeadSha,
      headSha: intent.expectedHeadSha, prId: 1, prNumber: 2, prCount: 1, draft: false,
    }),
  ]) assertSanitized(await rejectionOf(call()), 'typed recovery validation');
  assert.equal(queries, 0);
});

test('getRun sanitizes acquisition failures', async () => {
  const store = createWorkerStore({
    async connect() {
      throw new Error(SECRET_ERROR);
    },
    async query() {
      throw new Error(SECRET_ERROR);
    },
  });
  const error = await rejectionOf(store.getRun(randomUUID()));
  assertSanitized(error, 'getRun acquisition failure');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function boundedRejection(promise) {
  let timer;
  try {
    const error = await Promise.race([
      rejectionOf(promise),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); }),
    ]);
    assertSanitized(error, 'bounded database wait');
  } finally {
    clearTimeout(timer);
  }
}

for (const method of ['claimTick', 'getRun']) {
  test(`${method} bounds queued pool acquisition and destroys a late client without SQL`, async () => {
    const connection = deferred();
    const commands = [];
    const releases = [];
    let queries = 0;
    const worker = createWorkerStore({
      connect() { return connection.promise; },
      async query() { queries += 1; return new Promise(() => {}); },
    }, { timeoutMs: 20 });
    const pending = method === 'getRun' ? worker.getRun(randomUUID())
      : worker.claimTick({ invocationId: randomUUID(), manifest: manifest() });
    await boundedRejection(pending);
    connection.resolve({
      async query(sql) { commands.push(sql); return { rows: [] }; },
      release(error) { releases.push(error); },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(commands, []);
    assert.equal(queries, 0, 'getRun must acquire an owned client instead of pool.query');
    assert.equal(releases.length, 1);
    assertSanitized(releases[0], 'late connection disposal');
  });
}

for (const phase of ['BEGIN', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout',
  'body', 'COMMIT', 'ROLLBACK']) {
  test(`hung ${phase} is bounded and never returns an active uncertain client for reuse`, async () => {
    const stalled = deferred();
    const commands = [];
    const releases = [];
    const worker = createWorkerStore({
      async connect() {
        return {
          query(sql) {
            commands.push(sql);
            const selected = phase === 'body' ? sql.includes('pg_try_advisory_xact_lock')
              : sql.startsWith(phase);
            if (selected) return stalled.promise;
            if (phase === 'ROLLBACK' && sql.includes('pg_try_advisory_xact_lock')) {
              return Promise.reject(new Error(SECRET_ERROR));
            }
            return Promise.resolve({ rows: sql.includes('pg_try_advisory_xact_lock')
              ? [{ locked: false }] : [] });
          },
          release(error) { releases.push(error); },
        };
      },
      async query() { throw new Error('must not use pool.query'); },
    }, { timeoutMs: 20 });
    await boundedRejection(worker.claimTick({ invocationId: randomUUID(), manifest: manifest() }));
    assert.equal(releases.length, 1);
    assertSanitized(releases[0], 'active connection destruction');
    const before = [...commands];
    stalled.resolve({ rows: [{ locked: false }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(commands, before, 'ignored cancellation must not continue SQL or COMMIT');
    assert.equal(releases.length, 1);
  });
}

test('getRun bounds its query after acquisition and destroys a client that ignores cancellation', async () => {
  const stalled = deferred();
  const releases = [];
  const worker = createWorkerStore({
    async connect() { return { query() { return stalled.promise; },
      release(error) { releases.push(error); } }; },
    async query() { return stalled.promise; },
  }, { timeoutMs: 20 });
  await boundedRejection(worker.getRun(randomUUID()));
  assert.equal(releases.length, 1);
  assertSanitized(releases[0], 'read disposal');
  stalled.reject(new Error(SECRET_ERROR));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(releases.length, 1);
});

test('explicit absolute deadline prevents even pool acquisition after expiry', async () => {
  let connections = 0;
  const worker = createWorkerStore({
    async connect() { connections += 1; throw new Error(SECRET_ERROR); },
    async query() { connections += 1; throw new Error(SECRET_ERROR); },
  });
  assertSanitized(await rejectionOf(worker.getRun(randomUUID(), { deadline: Date.now() - 1 })),
    'expired read');
  assert.equal(connections, 0);
});

test('a pool acquisition rejection after expiry remains observed', async () => {
  const connection = deferred();
  const worker = createWorkerStore({ connect() { return connection.promise; } }, { timeoutMs: 20 });
  await boundedRejection(worker.getRun(randomUUID()));
  connection.reject(new Error(SECRET_ERROR));
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('transaction startup shares one deadline instead of restarting a timeout for each statement', async () => {
  const commands = [];
  const releases = [];
  const worker = createWorkerStore({
    async connect() {
      return {
        async query(sql) {
          commands.push(sql);
          await new Promise(resolve => setTimeout(resolve, 15));
          return { rows: [] };
        },
        release(error) { releases.push(error); },
      };
    },
  }, { timeoutMs: 25 });
  await boundedRejection(worker.claimTick({ invocationId: randomUUID(), manifest: manifest() }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(commands.length, 2);
  assert.equal(commands[0], 'BEGIN');
  assert.equal(commands[1].startsWith('SET LOCAL lock_timeout'), true);
  assert.equal(releases.length, 1);
  assertSanitized(releases[0], 'startup disposal');
});

test('late connection cleanup observes a wrapper cleanup rejection without reusing the client', async () => {
  const connection = deferred();
  let released = 0;
  const worker = createWorkerStore({ connect() { return connection.promise; } }, { timeoutMs: 20 });
  await boundedRejection(worker.getRun(randomUUID()));
  connection.resolve({
    query() { throw new Error('late query must never start'); },
    release(error) {
      assertSanitized(error, 'wrapper disposal');
      released += 1;
      return Promise.reject(new Error(SECRET_ERROR));
    },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(released, 1);
});
