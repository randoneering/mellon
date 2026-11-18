import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../../internal/factory-worker/control.mjs';

const JOB = {
  jobId: '12345678-1234-4234-8234-123456789abc', issueNumber: 52,
  baseSha: 'a'.repeat(40), planSha256: 'b'.repeat(64),
  task: 'Implement the approved boolean change.',
  allowedPaths: ['src/inputs.mjs', 'tests/unit/inputs.test.mjs'], requiresRebuild: true,
};
const SECRET = 'c'.repeat(64), OWNER = 'd'.repeat(64);
const WORKER = 'e'.repeat(64), RELAY = 'f'.repeat(64);
const MODEL = 'openai-codex/gpt-6.1-sol';
const THREAD = 'mcp:handoff-test';
const runId = n => `run:thread:${encodeURIComponent(THREAD)}:ordinal:${n}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, { findings = [], seed, beforeShow, pollMs = 10, config = {} } = {}) {
  const storeDir = await mkdtemp(join(tmpdir(), 'mellon-handoff-'));
  if (seed) await writeFile(join(storeDir, `${JOB.jobId}.json`), JSON.stringify(seed));
  const calls = [], reviews = [];
  let ordinal = seed ? 2 : 1, content = 'first\n';
  let inFlight = 0, maxConcurrent = 0;
  const execute = async (args, input) => {
    if (args.includes('/opt/bootstrap/relay.mjs')) {
      calls.push(args[4]);
      return { status: 0, stdout: JSON.stringify(args[4] === 'issue'
        ? { grantId: '1'.repeat(32), capability: 'a.b.c' } : { revoked: true }) };
    }
    if (args[0] === 'start') return { status: 0, stdout: WORKER };
    if (args[0] === 'stop') { calls.push('stop'); return { status: 0, stdout: WORKER }; }
    if (args[2] === 'git') return { status: 0, stdout: args.includes('rev-parse') ? JOB.baseSha : '' };
    if (String(args.at(-1)).includes('mellon-t3-ready')) return { status: 0, stdout: 'mellon-t3-ready' };
    if (String(args.at(-1)).includes('mellon-capability')) return { status: 0, stdout: '{"installed":"mellon-capability"}' };
    if (args.includes('/opt/t3/t3')) {
      if (args.includes('start')) {
        calls.push({ startPrompt: input });
        return { status: 0, stdout: JSON.stringify({ threadId: THREAD, projectId: 'project', runId: runId(1) }) };
      }
      if (args.includes('send')) {
        calls.push({ fixPrompt: input }); ordinal++; content = 'fixed\n';
        return { status: 0, stdout: JSON.stringify({ threadId: THREAD, runId: runId(ordinal), delivery: 'started' }) };
      }
      assert.ok(args.includes('show'));
      inFlight++; maxConcurrent = Math.max(inFlight, maxConcurrent);
      try {
        calls.push('show');
        if (beforeShow) await beforeShow();
        return { status: 0, stdout: JSON.stringify({ thread: {
          threadId: THREAD, projectId: 'project', providerInstanceId: 'pi', model: MODEL,
          status: 'completed', activeRunId: null, latestRunId: runId(ordinal), runCount: ordinal, pendingRequestCount: 0,
        }, messages: [] }) };
      } finally { inFlight--; }
    }
    calls.push('export');
    return { status: 0, stdout: JSON.stringify({ baseSha: JOB.baseSha,
      files: JOB.allowedPaths.map(path => ({ path, content })) }) };
  };
  const review = async (candidate, config) => {
    reviews.push({ candidate, config });
    calls.push('review');
    return { status: reviews.length === 1 && findings.length ? 'awaiting_assessment' : 'approved',
      candidateDigest: candidate.digest, reviewRunId: `review-${reviews.length}`,
      coverageComplete: true, findingInventoryComplete: true,
      findings: reviews.length === 1 ? findings : [] };
  };
  const server = createControlServer({ workerId: WORKER, relayId: RELAY,
    relayHost: 'mellon-factory-relay-0123456789ab', projectId: 'project', model: MODEL,
    secret: SECRET, assessmentSecret: OWNER, storeDir, maxFixRounds: 0,
    completionPollMs: pollMs, maxJobMs: 5000, ...config }, execute, review);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, owner = false) => fetch(url + path, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${owner ? OWNER : SECRET}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const journal = () => readFile(join(storeDir, `${JOB.jobId}.json`), 'utf8').then(JSON.parse);
  const until = async predicate => {
    for (let i = 0; i < 100; i++) { await wait(10); const j = await journal(); if (predicate(j)) return j; }
    assert.fail('Expected journal transition did not occur without external polling.');
  };
  return { request, journal, until, calls, reviews, server, maxConcurrent: () => maxConcurrent };
}

test('authorized coding completes review without an n8n status poll or publication', async t => {
  const s = await setup(t);
  assert.equal((await s.request('/jobs', JOB)).status, 202);
  const j = await s.until(j => j.state === 'approved');
  assert.equal(j.grantRevoked, true);
  assert.equal(j.publication, undefined);
  assert.equal(s.reviews.length, 1);
  assert.ok(s.calls.indexOf('revoke') < s.calls.indexOf('export'));
  assert.equal(s.reviews[0].config.requiresRebuild, true);
  assert.match(s.calls.find(c => c.startPrompt)?.startPrompt ?? '', /source-candidate/i);
  assert.match(s.calls.find(c => c.startPrompt)?.startPrompt ?? '', /runner owns.*dist\//i);
});

test('owner follow-up progresses without a new workflow run and carries stage context', async t => {
  const s = await setup(t, { findings: [{ id: 'gap', title: 'Regression coverage', reportedSeverity: null }] });
  await s.request('/jobs', JOB);
  const paused = await s.until(j => j.state === 'awaiting_assessment');
  const shown = s.calls.filter(c => c === 'show').length;
  await wait(40);
  assert.equal(s.calls.filter(c => c === 'show').length, shown, 'paused jobs must not be polled');
  const response = await s.request(`/jobs/${JOB.jobId}/assessment`, {
    decision: 'fix', assessmentRunId: paused.runId, reviewRunId: paused.review.reviewRunId, candidateDigest: paused.candidate.digest,
    findings: [{ id: 'gap', rating: 'medium', fix: true }],
  }, true);
  assert.equal(response.status, 202);
  const j = await s.until(j => j.state === 'approved');
  assert.equal(j.runId, runId(2));
  assert.equal(s.reviews.length, 2);
  assert.notEqual(s.reviews[0].candidate.digest, s.reviews[1].candidate.digest);
  const prompt = s.calls.find(c => c.fixPrompt).fixPrompt;
  assert.match(prompt, /runner owns.*dist\//i);
  assert.match(prompt, /src\/inputs\.mjs/);
  assert.match(prompt, /do not expand.*scope/i);
});

test('a fresh fix run does not expose the old run as completed', async t => {
  const s = await setup(t, { pollMs: 60000, findings: [{ id: 'gap', title: 'Coverage gap' }] });
  await s.request('/jobs', JOB);
  await s.until(j => j.state === 'running');
  await s.request(`/jobs/${JOB.jobId}`);
  const paused = await s.until(j => j.state === 'awaiting_assessment');
  await s.request(`/jobs/${JOB.jobId}/assessment`, {
    decision: 'fix', assessmentRunId: paused.runId, reviewRunId: paused.review.reviewRunId, candidateDigest: paused.candidate.digest,
    findings: [{ id: 'gap', rating: 'medium', fix: true }],
  }, true);
  const fixing = await s.until(j => j.stage === 't3_fix_run');
  assert.equal(fixing.thread ?? null, null);
});

test('timer and concurrent HTTP reads share one completion check', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = await setup(t, { beforeShow: () => gate });
  t.after(() => release());
  await s.request('/jobs', JOB);
  await s.until(j => j.state === 'running');
  const requests = Array.from({ length: 4 }, () => s.request(`/jobs/${JOB.jobId}`));
  await wait(60);
  assert.equal(s.maxConcurrent(), 1);
  release();
  await Promise.all(requests);
  await s.until(j => j.state === 'approved');
  assert.equal(s.reviews.length, 1);
});

test('deadline fences an in-flight monitor check and prevents export', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = await setup(t, { beforeShow: () => gate, config: { maxJobMs: 100 } });
  t.after(() => release());
  await s.request('/jobs', JOB);
  await s.until(j => j.stage === 'job_deadline' && j.state === 'blocked');
  release();
  await wait(50);
  assert.equal(s.calls.includes('export'), false);
  assert.equal(s.reviews.length, 0);
  assert.equal(s.calls.includes('stop'), true);
});

test('closing the server stops checks and prevents a late check exporting', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = await setup(t, { beforeShow: () => gate });
  t.after(() => release());
  await s.request('/jobs', JOB);
  await s.until(() => s.calls.includes('show'));
  s.server.closeAllConnections();
  await new Promise(resolve => s.server.close(resolve));
  const count = s.calls.length;
  release();
  await wait(50);
  assert.equal(s.calls.length, count);
  assert.equal(s.reviews.length, 0);
});

test('restart resumes completion checks for an existing run without launching again', async t => {
  const { createHash } = await import('node:crypto');
  const seed = { ...JOB, digest: createHash('sha256').update(JSON.stringify(JOB)).digest('hex'),
    generation: 1, state: 'running', stage: 't3_fix_run', createdAt: Date.now(), deadlineAt: Date.now() + 5000,
    threadId: THREAD, runId: runId(2), grantId: '1'.repeat(32), grantRevoked: false, reviewStarted: false };
  const s = await setup(t, { seed });
  await s.until(j => j.state === 'approved');
  assert.equal(s.calls.some(c => c.startPrompt || c.fixPrompt), false);
});
