import test from 'node:test';
import assert from 'node:assert/strict';
import { createEligibleContinuation, parseEvent, parsePolicy } from '../../src/inputs.mjs';

const issue = {
  action: 'opened',
  repository: { full_name: 'acme/project' },
  issue: { number: 12, title: 'Title', body: null, user: { login: 'contributor' } },
};
const runner = { eventName: 'issues', repository: 'acme/project' };
const validInputs = { allowlist: '[]', response: 'Please describe your work in your own words.' };

test('supports opened issues and binds trusted runner repository and identity', () => {
  assert.deepEqual(parseEvent({ eventName: 'issues', repository: 'acme/project', payload: issue }), {
    kind: 'issue', repository: 'acme/project', number: 12, title: 'Title', body: null, author: 'contributor',
  });
  assert.equal(parseEvent({ eventName: 'issues', repository: 'acme/project', payload: {
    ...issue, issue: { ...issue.issue, body: 'text' },
  } }).body, 'text');
});

test('supports only the target pull request opening event', () => {
  const payload = { action: 'opened', repository: issue.repository, pull_request: { ...issue.issue, head: { repo: { full_name: 'fork/repo' } } } };
  assert.equal(parseEvent({ eventName: 'pull_request_target', repository: 'acme/project', payload }).kind, 'pull_request');
  assert.equal(parseEvent({ eventName: 'pull_request', repository: 'acme/project', payload }).kind, 'skip');
});

test('unsupported events skip before parsing malformed payload details', () => {
  assert.deepEqual(parseEvent({ eventName: 'issues', repository: 'acme/project', payload: { action: 'edited' } }), { kind: 'skip' });
  assert.deepEqual(parseEvent({ eventName: 'workflow_dispatch', repository: 'acme/project', payload: null }), { kind: 'skip' });
});

test('rejects malformed supported event identities without reflecting payload text', () => {
  for (const altered of [
    { ...issue, repository: { full_name: 'fork/repo' } },
    { ...issue, issue: { ...issue.issue, number: 0 } },
    { ...issue, issue: { ...issue.issue, number: 1.5 } },
    { ...issue, issue: { ...issue.issue, title: '' } },
    { ...issue, issue: { ...issue.issue, body: 3 } },
    { ...issue, issue: { ...issue.issue, user: { login: '' } } },
  ]) {
    assert.throws(() => parseEvent({ ...runner, payload: altered }), (error) => {
      assert.match(error.message, /invalid/i);
      assert.doesNotMatch(error.message, /fork\/repo|contributor|Title/);
      return true;
    });
  }
});

test('rejects invalid runner repo and oversized or invalid-UTF8 event bytes', () => {
  assert.throws(() => parseEvent({ ...runner, repository: 'ACME/project', payload: issue }));
  assert.throws(() => parseEvent({ ...runner, payload: issue, eventBytes: Buffer.alloc(4 * 1024 * 1024 + 1) }));
  assert.throws(() => parseEvent({ ...runner, payload: issue, eventBytes: Buffer.from([0xc3, 0x28]) }));
});

test('defaults to enforce and accepts only explicit enforce or observe mode', () => {
  assert.equal(parsePolicy({}).mode, 'enforce');
  assert.equal(parsePolicy({ mode: 'observe' }).mode, 'observe');
  assert.equal(parsePolicy({ mode: 'enforce' }).mode, 'enforce');
  for (const mode of ['', 'Observe', 'observe ', 'enforced', null, 1]) {
    assert.throws(() => parsePolicy({ mode }));
  }
});

test('parses auto-close as a strict default-enabled boolean in every mode', () => {
  for (const mode of ['enforce', 'observe']) {
    assert.equal(parsePolicy({ mode }).autoClose, true);
    assert.equal(parsePolicy({ mode, autoClose: '' }).autoClose, true);
    assert.equal(parsePolicy({ mode, autoClose: 'true' }).autoClose, true);
    assert.equal(parsePolicy({ mode, autoClose: 'false' }).autoClose, false);
    for (const autoClose of ['TRUE', 'false ', 'yes', '0', null, true, 0]) {
      assert.throws(() => parsePolicy({ mode, autoClose }));
    }
  }
});

test('defaults allowlist and validates literal response and fixed cutoff', () => {
  assert.deepEqual(parsePolicy({}), { allowlist: [], response: "AI-assisted code is welcome. Please describe your work in your own words. This automated review can make mistakes. If this submission does not meet the repository's contribution policy, maintainers may close it. Contact a maintainer if you need help.", cutoff: 0.8, mode: 'enforce', autoClose: true });
  assert.deepEqual(parsePolicy(validInputs).allowlist, []);
  assert.deepEqual(parsePolicy({ allowlist: '["Alice", "dependabot[bot]"]', response: 'Exact words.' }).allowlist, ['Alice', 'dependabot[bot]']);
  for (const bad of [
    { allowlist: '' }, { allowlist: '{"account":"a"}' }, { allowlist: '["*"]' }, { allowlist: '[" "]' },
    { allowlist: '[1]' }, { allowlist: '[] trailing' }, { response: '' }, { mode: 'observe', apiHost: 'x' }, { response: '   ' },
    { response: 'é'.repeat(16385) }, { cutoff: '0.2' }, { apiHost: 'evil.invalid' },
  ]) assert.throws(() => parsePolicy({ ...validInputs, ...bad }));
});

test('lazy eligible continuation runs only for eligible valid inputs', async () => {
  const calls = [];
  const run = createEligibleContinuation({
    getContext: () => ({ ...runner, payload: issue }),
    getInputs: () => validInputs,
  });
  assert.deepEqual(await run(async (context, policy) => {
    calls.push('eligible');
    assert.equal(context.kind, 'issue');
    assert.equal(policy.cutoff, 0.8);
    return { outcome: 'eligible' };
  }), { outcome: 'eligible' });
  assert.deepEqual(calls, ['eligible']);
});

test('unsupported and allowlisted work does not invoke detector or API continuation', async () => {
  let calls = 0;
  for (const [event, inputs] of [
    [{ eventName: 'pull_request', repository: 'acme/project', payload: issue }, validInputs],
    [{ ...runner, payload: issue }, { allowlist: '["CONTRIBUTOR"]', response: 'literal' }],
  ]) {
    const run = createEligibleContinuation({ getContext: () => event, getInputs: () => inputs });
    assert.deepEqual(await run(async () => { calls++; }), { outcome: 'skipped' });
  }
  assert.equal(calls, 0);
});

test('invalid event and policy fail before eligible continuation', async () => {
  let calls = 0;
  const invalidEvent = createEligibleContinuation({ getContext: () => ({ ...runner, payload: { ...issue, issue: { ...issue.issue, number: -1 } } }), getInputs: () => validInputs });
  await assert.rejects(invalidEvent(async () => { calls++; }));
  const invalidPolicy = createEligibleContinuation({ getContext: () => ({ ...runner, payload: issue }), getInputs: () => ({ allowlist: 'not json', response: 'literal' }) });
  await assert.rejects(invalidPolicy(async () => { calls++; }));
  assert.equal(calls, 0);
});
