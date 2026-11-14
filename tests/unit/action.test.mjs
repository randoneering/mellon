import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeResult, runAction } from '../../src/action.mjs';

const event = {
  action: 'opened', repository: { full_name: 'owner/repo' },
  issue: { number: 7, title: 'Describe your contribution', body: 'I implemented a test.',
    user: { login: 'contributor' } },
};

async function setup(t, { uid = 1000, eventName = 'issues', payload = event,
  inputs = { token: 'test-token' }, scorer, fetchImpl } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-action-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(payload));
  const env = {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
  };
  const result = await runAction({
    env, getuid: () => uid,
    getInput: (name, options) => {
      if (name === 'moderation-bot-login') assert.deepEqual(options, { trimWhitespace: false });
      return inputs[name] ?? '';
    },
    ...(scorer ? { score: scorer } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { result, outputPath, summaryPath: env.GITHUB_STEP_SUMMARY };
}

test('unsupported and allowlisted events skip before token, scorer, and API access', async (t) => {
  let scoreCalls = 0;
  let fetchCalls = 0;
  const unsupported = await setup(t, { eventName: 'issues', payload: { action: 'edited' },
    inputs: {}, scorer: async () => { scoreCalls++; }, fetchImpl: async () => { fetchCalls++; } });
  assert.deepEqual(unsupported.result, { outcome: 'skipped' });

  const allowed = await setup(t, { inputs: { token: '', allowlist: '["CONTRIBUTOR"]' },
    scorer: async () => { scoreCalls++; }, fetchImpl: async () => { fetchCalls++; } });
  assert.deepEqual(allowed.result, { outcome: 'skipped' });
  assert.equal(scoreCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('invalid policy and root runtime fail before inference or API access', async (t) => {
  let calls = 0;
  for (const inputs of [{ token: 'secret', allowlist: '[] trailing' },
    { 'moderation-bot-login': ' bot[bot] ', get token() { calls++; return ''; } }]) {
    const invalid = await setup(t, { inputs, scorer: async () => { calls++; },
      fetchImpl: async () => { calls++; } });
    assert.equal(invalid.result.outcome, 'error');
    assert.equal(calls, 0);
  }
  const root = await setup(t, { uid: 0, scorer: async () => { calls++; },
    fetchImpl: async () => { calls++; } });
  assert.equal(root.result.outcome, 'error');
  assert.equal(calls, 0);
});

test('invalid UTF-8 and oversized event files fail safely', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const env = { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: path.join(directory, 'out') };
  await writeFile(eventPath, Buffer.from([0xff]));
  const invalidUtf8 = await runAction({ env, getuid: () => 1000, getInput: () => 'token' });
  assert.equal(invalidUtf8.outcome, 'error');
  await writeFile(eventPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  const oversized = await runAction({ env, getuid: () => 1000, getInput: () => 'token' });
  assert.equal(oversized.outcome, 'error');
});

test('malformed supported event fails before creating API client or scorer', async (t) => {
  let calls = 0;
  const { result } = await setup(t, { payload: { action: 'opened' },
    scorer: async () => { calls++; }, fetchImpl: async () => { calls++; } });
  assert.equal(result.outcome, 'error');
  assert.equal(calls, 0);
});

test('a real packaged scorer runs with trusted packaged detector assets', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-scorer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(event));
  const result = await runAction({
    env: { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    getuid: () => 1000, getInput: name => name === 'token' ? 'test-token' : '',
    fetchImpl: async () => new Response('[]', { status: 200 }),
    actionDirectory: path.resolve('dist'),
  });
  assert.equal(result.outcome, 'below_cutoff');
  assert.ok(result.robotScore >= 0.6 && result.robotScore < 0.8);
  assert.match(await readFile(outputPath, 'utf8'), /^outcome=below_cutoff\nrobot-score=0\.\d+\n$/);
});

test('observe mode validates before inference and reports safe flagged output and summary', async (t) => {
  let calls = 0;
  const invalid = await setup(t, { inputs: { token: 'token', mode: 'Observe' },
    scorer: async () => { calls++; }, fetchImpl: async () => { calls++; } });
  assert.equal(invalid.result.outcome, 'error');
  assert.equal(calls, 0);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-observe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output');
  const summaryPath = path.join(directory, 'summary');
  await writeFile(eventPath, JSON.stringify(event));
  const requests = [];
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    requests.push([options.method ?? 'GET', pathname, options.body && JSON.parse(options.body)]);
    if (pathname === '/repos/owner/repo/issues/7') return new Response(JSON.stringify({ state: 'open', title: event.issue.title,
      body: event.issue.body, merged: false }), { status: 200 });
    if (pathname === '/repos/owner/repo/issues/7/labels') return new Response('[{"name":"mellon: review"}]', { status: 200 });
    if (pathname.includes('/labels/mellon%3A%20')) return new Response(null, { status: 404 });
    if (pathname === '/repos/owner/repo/labels' && options.method === 'POST') {
      return new Response(JSON.stringify({ name: JSON.parse(options.body).name }), { status: 201 });
    }
    if (pathname.endsWith('/issues/7/labels')) return new Response('[{"name":"mellon: review"}]', { status: 200 });
    throw new Error('unexpected mock endpoint');
  };
  const result = await runAction({ env: { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath },
    getuid: () => 1000, getInput: name => ({ token: 'token', mode: 'observe' })[name] ?? '',
    score: async () => ({ protocol_version: 1, outcome: 'classified', robot_score: 0.8,
      detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64) }), fetchImpl });
  assert.equal(result.outcome, 'flagged', JSON.stringify(requests));
  assert.equal(result.robotScore, 0.8);
  const outcomeLabelNames = ['mellon: reviewed-human', 'mellon: reviewed-ai', 'mellon: reviewed-unsure'];
  assert.deepEqual(requests.map(([method, pathname]) => [method, pathname]), [
    ['GET', '/repos/owner/repo/issues/7'],
    ['GET', '/repos/owner/repo/issues/7/labels'],
    ...outcomeLabelNames.flatMap(name => [
      ['GET', `/repos/owner/repo/labels/${encodeURIComponent(name)}`],
      ['POST', '/repos/owner/repo/labels'],
    ]),
    ['GET', '/repos/owner/repo/labels/mellon%3A%20review'],
    ['GET', '/repos/owner/repo/issues/7'], ['GET', '/repos/owner/repo/issues/7/labels'],
    ['POST', '/repos/owner/repo/labels'], ['GET', '/repos/owner/repo/issues/7'],
    ['GET', '/repos/owner/repo/issues/7/labels'], ['POST', '/repos/owner/repo/issues/7/labels'],
  ]);
  assert.deepEqual(requests.filter(([method, pathname]) => method === 'POST' && pathname === '/repos/owner/repo/labels')
    .map(([, , body]) => body.name), [...outcomeLabelNames, 'mellon: review']);
  assert.deepEqual(requests.filter(([method, pathname]) => method === 'POST' && pathname === '/repos/owner/repo/issues/7/labels')
    .map(([, , body]) => body), [{ labels: ['mellon: review'] }]);
  assert.equal(requests.some(([method, pathname]) => method === 'PATCH' || method === 'POST' && pathname.endsWith('/comments')), false);
  assert.equal(await readFile(outputPath, 'utf8'), 'outcome=flagged\nrobot-score=0.8\n');
  assert.match(await readFile(summaryPath, 'utf8'), /Flagged for review/);
  assert.match(await readFile(summaryPath, 'utf8'), /Label: mellon: review/);
});

test('incomplete optional label setup produces a safe summary notice without changing outputs', async t => {
  for (const mode of ['observe', 'enforce']) {
    for (const labeling of [true, false]) {
      for (const lookupFailure of [true, false]) {
        let setupLookups = 0;
        let requests = 0;
        const { result, outputPath, summaryPath } = await setup(t, {
          inputs: { token: 'test-token', mode, 'review-label': labeling ? 'true' : 'false' },
          scorer: async () => ({ protocol_version: 1, outcome: 'classified', robot_score: 0.9,
            detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64) }),
          fetchImpl: async (url, options) => {
            requests++;
            const pathname = new URL(url).pathname;
            if (pathname.includes('/labels/mellon%3A%20reviewed-')) {
              setupLookups++;
              return lookupFailure ? new Response('private setup response', { status: 503 })
                : new Response(JSON.stringify({ name: decodeURIComponent(pathname.split('/').at(-1)) }), { status: 200 });
            }
            if (pathname.endsWith('/labels/mellon%3A%20review')) return new Response('{"name":"mellon: review"}', { status: 200 });
            if (pathname.endsWith('/comments')) {
              return options.method === 'POST'
                ? new Response(JSON.stringify({ id: 8, body: JSON.parse(options.body).body,
                  user: { login: 'github-actions[bot]', type: 'Bot' } }), { status: 201 })
                : new Response('[]', { status: 200 });
            }
            if (pathname.endsWith('/labels')) return new Response(options.method === 'POST' ? '[{"name":"mellon: review"}]' : '[]', { status: 200 });
            return new Response(JSON.stringify({ state: options.method === 'PATCH' ? 'closed' : 'open',
              title: event.issue.title, body: event.issue.body }), { status: 200 });
          },
        });
        const incomplete = labeling && lookupFailure;
        assert.equal(result.outcome, mode === 'observe' ? 'flagged' : 'closed');
        assert.equal(result.outcomeLabelsIncomplete, incomplete ? true : undefined);
        assert.equal(setupLookups, labeling ? 3 : 0);
        if (mode === 'observe' && !labeling) assert.equal(requests, 0);
        const output = await readFile(outputPath, 'utf8');
        const summary = await readFile(summaryPath, 'utf8');
        assert.equal(output, `outcome=${mode === 'observe' ? 'flagged' : 'closed'}\nrobot-score=0.9\n`);
        assert.equal(summary.includes('Outcome-label setup is incomplete'), incomplete);
        if (incomplete) assert.match(summary, /Create missing review outcome labels manually/);
        assert.doesNotMatch(JSON.stringify(result) + output + summary,
          /private setup response|test-token|Describe your contribution|I implemented a test/);
      }
    }
  }
});

test('observe mode with labeling disabled makes no GitHub calls or label claim in summary', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-observe-no-label-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output');
  const summaryPath = path.join(directory, 'summary');
  await writeFile(eventPath, JSON.stringify(event));
  let calls = 0;
  const result = await runAction({ env: { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath },
    getuid: () => 1000, getInput: name => ({ token: 'token', mode: 'observe', 'review-label': 'false' })[name] ?? '',
    score: async () => ({ protocol_version: 1, outcome: 'classified', robot_score: 0.8,
      detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64) }),
    fetchImpl: async () => { calls++; throw new Error('unexpected GitHub request'); } });
  assert.equal(result.outcome, 'flagged');
  assert.equal(result.robotScore, 0.8);
  assert.equal(calls, 0);
  assert.equal(await readFile(outputPath, 'utf8'), 'outcome=flagged\nrobot-score=0.8\n');
  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /Flagged for review/);
  assert.doesNotMatch(summary, /Label: mellon: review/);
});

test('observation label API failures report safe error without leaking API details', async (t) => {
  const secret = 'raw api body must not appear';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-observe-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(event));
  const result = await runAction({ env: { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath }, getuid: () => 1000,
    getInput: name => ({ token: 'secret-token', mode: 'observe' })[name] ?? '',
    score: async () => ({ protocol_version: 1, outcome: 'classified', robot_score: 0.9,
      detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64) }),
    fetchImpl: async () => new Response(secret, { status: 500 }) });
  assert.equal(result.outcome, 'error');
  assert.doesNotMatch(JSON.stringify(result), /secret-token|raw api body/);
  assert.equal(await readFile(outputPath, 'utf8'), 'outcome=error\n');
});

test('commented outcomes publish validated score output and remain successful', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-commented-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(event));
  const result = await runAction({
    env: { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    getuid: () => 1000,
    getInput: name => ({ token: 'test-token', 'auto-close': 'false', 'review-label': 'false' })[name] ?? '',
    score: async () => ({ protocol_version: 1, outcome: 'classified', robot_score: 0.9,
      detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64) }),
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/comments') && (options.method ?? 'GET') === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (pathname.endsWith('/comments') && options.method === 'POST') {
        return new Response(JSON.stringify({ id: 22, body: JSON.parse(options.body).body,
          user: { login: 'github-actions[bot]', type: 'Bot' } }), { status: 201 });
      }
      if (pathname.endsWith('/issues/7')) {
        return new Response(JSON.stringify({ state: 'open', title: event.issue.title,
          body: event.issue.body, merged: false }), { status: 200 });
      }
      throw new Error('unexpected mocked endpoint');
    },
  });
  assert.equal(result.outcome, 'commented');
  assert.equal(result.robotScore, 0.9);
  assert.equal(await readFile(outputPath, 'utf8'), 'outcome=commented\nrobot-score=0.9\n');
  assert.doesNotMatch(JSON.stringify(result), /test-token|Describe your contribution|I implemented a test/);
});

test('normal no-score outcomes write only validated output records', async (t) => {
  const { result, outputPath } = await setup(t, { scorer: async () => ({
    protocol_version: 1, outcome: 'classified', robot_score: 0.599999,
    detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64),
    input_sha256: 'b'.repeat(64),
  }) });
  assert.equal(result.outcome, 'below_cutoff');
  assert.equal(result.robotScore, 0.599999);
  assert.equal(await readFile(outputPath, 'utf8'), 'outcome=below_cutoff\nrobot-score=0.599999\n');
});

test('scorer/API failures are redacted and set error output', async (t) => {
  const secret = 'token-should-not-leak';
  const source = 'private submission text';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(event));
  const result = await runAction({
    env: { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    getuid: () => 1000, getInput: (name) => name === 'token' ? secret : '',
    score: async () => { throw new Error(`${source} ${secret}`); },
  });
  assert.equal(result.outcome, 'error');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${source}|${secret}`));
  assert.equal(await readFile(outputPath, 'utf8'), 'outcome=error\n');
});

test('output write errors become operational failures without leaking event data', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({ action: 'edited' }));
  const result = await runAction({
    env: { GITHUB_EVENT_NAME: 'issues', GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: directory },
    getuid: () => 1000, getInput: () => '',
  });
  assert.equal(result.outcome, 'error');
});

test('rejects unsafe outcome and non-finite scores in output formatter', async () => {
  const { formatOutputs } = await import('../../src/action.mjs');
  assert.throws(() => formatOutputs({ outcome: 'secret\nTOKEN=value' }));
  assert.throws(() => formatOutputs({ outcome: 'below_cutoff', robotScore: NaN }));
  assert.throws(() => formatOutputs({ outcome: 'below_cutoff', robotScore: 1.1 }));
  assert.throws(() => formatOutputs({ outcome: 'below_cutoff', robotScore: '0.6' }));
});

test('real client enforces configured App authorship and migration stops', async t => {
  const marker = `<!-- mellon-submission-moderation-v1 repo=owner/repo item=7 input=${'b'.repeat(64)} detector=${'c'.repeat(40)} model=${'a'.repeat(64)} -->`;
  const response = (status, body) => new Response(JSON.stringify(body), { status });
  const current = () => ({ state: 'open', merged: false,
    title: event.issue.title, body: event.issue.body });
  for (const eventName of ['issues', 'pull_request_target']) {
    for (const scenario of ['create', 'reuse', 'lost', 'bad-author', 'bad-body', 'mixed', 'reconciled-mixed', 'missing', 'failed-list']) {
      const paths = [];
      let postBody;
      let listings = 0;
      const app = { id: 82, body: marker, user: { login: 'Mellon[BoT]', type: 'Bot' } };
      const legacy = { ...app, id: 81, user: { login: 'github-actions[bot]', type: 'Bot' } };
      const safe = await setup(t, { eventName, payload: eventName === 'issues' ? event : { action: 'opened', repository: event.repository, pull_request: event.issue },
        scorer: async () => ({ protocol_version: 1, outcome: 'classified', robot_score: 0.8,
          detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64) }), inputs: { token: 'fixture-credential', 'moderation-bot-login': 'MeLLoN[BoT]' },
        fetchImpl: async (url, options) => {
          const path = new URL(url).pathname;
          paths.push(`${options.method} ${path}`);
          const itemPath = eventName === 'issues' ? '/repos/owner/repo/issues/7' : '/repos/owner/repo/pulls/7';
          if (options.method === 'GET' && path === itemPath) return response(200, current());
          if (path.endsWith('/comments')) {
            if (options.method === 'GET') {
              listings++;
              if (scenario === 'reuse') return response(200, [app]);
              if (scenario === 'mixed' || (scenario === 'reconciled-mixed' && listings === 2)) return response(200, [app, legacy]);
              if (listings === 2 && scenario === 'failed-list') return response(503, { message: 'private server detail' });
              return response(200, listings === 2 && scenario === 'lost' ? [app] : []);
            }
            postBody = JSON.parse(options.body);
            assert.deepEqual(Object.keys(postBody), ['body']);
            if (['lost', 'reconciled-mixed', 'missing', 'failed-list'].includes(scenario)) throw new Error('private server detail');
            if (scenario === 'bad-author') return response(201, { ...app, body: postBody.body,
              user: { login: 'mellon[bot]', type: 'User' } });
            return response(201, { ...app, body: scenario === 'bad-body' ? marker : postBody.body });
          }
          if (path.startsWith('/repos/owner/repo/labels/')) return response(200, { name: decodeURIComponent(path.split('/').at(-1)) });
          if (path.endsWith('/labels')) return response(200, options.method === 'POST' ? [{ name: 'mellon: review' }] : []);
          if (options.method === 'PATCH' && path === itemPath) return response(200, { ...current(), state: 'closed' });
          throw new Error('unexpected mocked request');
        } });
      const successful = ['create', 'reuse', 'lost'].includes(scenario);
      const conflict = ['mixed', 'reconciled-mixed'].includes(scenario);
      assert.equal(safe.result.outcome, successful ? 'closed' : 'error',
        `${eventName}/${scenario}: ${JSON.stringify(safe.result)}; requests=${paths.join(', ')}`);
      assert.equal(paths.filter(path => path.startsWith('POST') && path.endsWith('/comments')).length,
        ['reuse', 'mixed'].includes(scenario) ? 0 : 1);
      assert.equal(paths.filter(path => path.startsWith('PATCH')).length, successful ? 1 : 0);
      if (!successful) assert.equal(paths.some(path => path.endsWith('/labels')), false);
      assert.equal(safe.result.commentId, conflict ? 82 : undefined);
      if (conflict) {
        assert.equal(safe.result.category, 'moderation_identity_migration_conflict');
        assert.match(await readFile(safe.summaryPath, 'utf8'), /Manual review.*default identity/);
        assert.match(await readFile(safe.summaryPath, 'utf8'), /Comment ID: 82/);
        assert.doesNotMatch(await readFile(safe.summaryPath, 'utf8'), /Comment ID: 81/);
      }
      if (scenario === 'failed-list') assert.equal(safe.result.category, 'comment_reconciliation_failed');
      assert.doesNotMatch(JSON.stringify(safe.result) + await readFile(safe.summaryPath, 'utf8') + await readFile(safe.outputPath, 'utf8'), /private server detail|fixture-credential|Describe your contribution|I implemented a test/);
    }
  }
});

test('result normalization accepts only fixed operational diagnostics', () => {
  const accepted = [
    ['comment_inventory', 'comment_inventory_failed'],
    ['comment_inventory', 'moderation_identity_migration_conflict'],
    ['comment_reconciliation', 'moderation_identity_migration_conflict'],
    ['comment_reconciliation', 'comment_reconciliation_failed'],
    ['comment_create', 'comment_unconfirmed'],
  ];
  for (const [stage, category] of accepted) {
    const result = normalizeResult({ outcome: 'error', stage, category, error: 'private error' });
    assert.equal(result.stage, stage);
    assert.equal(result.category, category);
    assert.equal(result.error, undefined);
  }
  for (const [stage, category] of [['raw detail', 'comment_unconfirmed'], ['comment_create', 'raw detail'],
    ['comment_inventory', 'comment_unconfirmed']]) {
    const result = normalizeResult({ outcome: 'error', stage, category });
    assert.equal(result.stage, undefined);
    assert.equal(result.category, undefined);
  }
});
