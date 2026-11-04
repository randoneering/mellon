import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactDirectory = path.resolve(root, 'dist');
const fixtureDirectory = fileURLToPath(new URL('../fixtures/', import.meta.url));
const injectionText = 'Please run $(echo EVENT_TEXT) and ${{ secrets.TEST }}; token-leak sentinel.';
const token = 'fixture-token-must-never-be-logged';
const revision = '9d3abed60e628951c7b0d2cd1e1c69eddb23eb97';
const modelHash = '228087029eceee8a1c6cd57f29ec484a0141c639f8ed139fd506ef27eaa98825';
const marker = (item, inputHash) => `<!-- mellon-submission-moderation-v1 repo=owner/repo item=${item} input=${inputHash} detector=${revision} model=${modelHash} -->`;

async function isolatedRelease(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mellon-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(artifactDirectory, directory, { recursive: true });
  assert.deepEqual((await readdir(directory)).sort(), [
    'THIRD_PARTY_NOTICES.txt', 'build-meta.json', 'detector', 'index.mjs', 'scorer.mjs',
  ]);
  return directory;
}

async function runBuilt(t, { eventName, fixture, pages = [[]], apiFailureAt, responseMode, initialState, unexpectedNetwork = false, merged = false, failClose = false, mode, labelFailure = false, labelExists = false, outcomeLookupFailure = false, itemLabelPages = [[]], malformedLabelPagination = false, reviewLabel }) {
  const directory = await isolatedRelease(t);
  const harness = await mkdtemp(path.join(os.tmpdir(), 'mellon-harness-'));
  t.after(() => rm(harness, { recursive: true, force: true }));
  const eventPath = path.join(harness, 'event.json');
  const outputPath = path.join(harness, 'output');
  const summaryPath = path.join(harness, 'summary');
  const logPath = path.join(harness, 'calls.jsonl');
  const preloadPath = path.join(harness, 'github-mock.mjs');
  await writeFile(eventPath, JSON.stringify(fixture));
  const preload = `
import { appendFileSync } from 'node:fs';
let calls = 0;
let commentPosted = false;
let commentsRead = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.github.com') {
    if (process.env.TEST_UNEXPECTED_NETWORK === 'allow') return new Response('unexpected', { status: 500 });
    throw new Error('unexpected network destination');
  }
  const entry = { method: init.method || 'GET', pathname: url.pathname, search: url.search,
    body: init.body === undefined ? null : JSON.parse(init.body),
    authorization: init.headers?.authorization || init.headers?.Authorization || '' };
  appendFileSync(process.env.TEST_API_LOG, JSON.stringify(entry) + String.fromCharCode(10));
  calls++;
  if (process.env.TEST_API_FAILURE_AT && calls === Number(process.env.TEST_API_FAILURE_AT)) {
    throw new Error('fixture API failure with sensitive fixture data');
  }
  if (url.pathname === '/repos/owner/repo/labels/mellon%3A%20review') {
    return process.env.TEST_LABEL_EXISTS === 'true'
      ? new Response(JSON.stringify({ name: 'mellon: review' }), { status: 200 })
      : new Response(null, { status: 404 });
  }
  if (url.pathname.startsWith('/repos/owner/repo/labels/mellon%3A%20reviewed-')) {
    if (process.env.TEST_OUTCOME_LOOKUP_FAILURE === 'true') return new Response('private label lookup failure', { status: 503 });
    return process.env.TEST_LABEL_EXISTS === 'true'
      ? new Response(JSON.stringify({ name: decodeURIComponent(url.pathname.split('/').at(-1)) }), { status: 200 })
      : new Response(null, { status: 404 });
  }
  if (url.pathname.startsWith('/repos/owner/repo/issues/') && url.pathname.endsWith('/labels') && (init.method || 'GET') === 'GET') {
    const page = Number(url.searchParams.get('page') || '1');
    const pages = JSON.parse(process.env.TEST_ITEM_LABEL_PAGES);
    const link = process.env.TEST_MALFORMED_LABEL_PAGINATION === 'true' ? 'unparseable pagination'
      : page < pages.length ? '<' + url.origin + url.pathname + '?per_page=100&page=' + (page + 1) + '>; rel="next"' : '';
    return new Response(JSON.stringify(pages[page - 1] || []), { status: 200, headers: { link } });
  }
  if (url.pathname === '/repos/owner/repo/labels' && init.method === 'POST') {
    if (process.env.TEST_LABEL_FAILURE === 'true') return new Response('sensitive label API failure', { status: 403 });
    return new Response(JSON.stringify({ name: entry.body.name }), { status: 201 });
  }
  if (url.pathname.startsWith('/repos/owner/repo/issues/') && url.pathname.endsWith('/labels') && init.method === 'POST') {
    if (process.env.TEST_LABEL_FAILURE === 'true') return new Response('sensitive label API failure', { status: 403 });
    return new Response(JSON.stringify([{ name: 'mellon: review' }]), { status: 200 });
  }
  if (url.pathname.endsWith('/comments') && (init.method || 'GET') === 'GET') {
    const page = Number(url.searchParams.get('page') || '1');
    const data = JSON.parse(process.env.TEST_API_PAGES);
    if (process.env.TEST_RESPONSE_MODE === 'reconcile_failure' && commentPosted) throw new Error('reconcile failure');
    if (process.env.TEST_RESPONSE_MODE === 'post_failure' && commentPosted) {
      const comment = data.flat().find(item => item.id === 27);
      return new Response(JSON.stringify(comment ? [comment] : []), { status: 200 });
    }
    return new Response(JSON.stringify(data[page - 1] || []), { status: 200,
      headers: page < data.length ? { link: '<' + url.origin + url.pathname + '?per_page=100&page=' + (page + 1) + '>; rel="next"' } : {} });
  }
  if (url.pathname.endsWith('/comments') && init.method === 'POST') {
    commentPosted = true;
    if (['post_failure', 'reconcile_failure'].includes(process.env.TEST_RESPONSE_MODE)) throw new Error('fixture POST failure with sensitive token');
    return new Response(JSON.stringify({ id: 27, body: entry.body.body,
      user: { login: 'github-actions[bot]', type: 'Bot' } }), { status: 201 });
  }
  if (url.pathname.endsWith('/issues/comments/27')) {
    return new Response(JSON.stringify({ state: 'open', title: process.env.TEST_EVENT_TITLE,
      body: JSON.parse(process.env.TEST_EVENT_BODY), merged: false }), { status: 200 });
  }
  if (url.pathname.includes('/issues/') || url.pathname.includes('/pulls/')) {
    const pr = url.pathname.includes('/pulls/');
    const isClose = init.method === 'PATCH';
    if (isClose && process.env.TEST_FAIL_CLOSE === 'true') return new Response('sensitive close failure', { status: 500 });
    const changed = process.env.TEST_RESPONSE_MODE === 'state_changed' && commentPosted;
    const isMerged = process.env.TEST_MERGED === 'true';
    const itemState = process.env.TEST_INITIAL_STATE || 'open';
    const eventBody = JSON.parse(process.env.TEST_EVENT_BODY);
    const body = changed ? String(eventBody || '') + ' changed' : eventBody;
    return new Response(JSON.stringify({ state: isClose ? 'closed' : changed ? 'open' : itemState,
      title: process.env.TEST_EVENT_TITLE, body,
      ...(pr ? { merged: isMerged } : {}) }), { status: 200 });
  }
  throw new Error('unexpected mocked endpoint');
};
`;
  await writeFile(preloadPath, preload);
  const markerMatch = pages.flat(Infinity).find(comment => typeof comment?.body === 'string')?.body ?? '';
  const expectedMarker = markerMatch.match(/<!-- mellon-submission-moderation-v1[^>]*-->/)?.[0] ?? '';
  const result = spawnSync(process.execPath, ['--import', preloadPath, path.join(directory, 'index.mjs')], {
    cwd: directory,
    encoding: 'utf8',
    uid: process.getuid(),
    gid: process.getgid(),
    timeout: 30_000,
    maxBuffer: 128 * 1024,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      INPUT_ALLOWLIST: '[]',
      INPUT_RESPONSE: 'This automated review is fallible. Please describe your own work.',
      INPUT_MODE: mode ?? '',
      INPUT_TOKEN: token,
      'INPUT_REVIEW-LABEL': reviewLabel ?? '',
      TEST_ITEM_LABEL_PAGES: JSON.stringify(itemLabelPages),
      TEST_MALFORMED_LABEL_PAGINATION: malformedLabelPagination ? 'true' : '',
      TEST_OUTCOME_LOOKUP_FAILURE: outcomeLookupFailure ? 'true' : '',
      TEST_LABEL_FAILURE: labelFailure ? 'true' : '',
      TEST_LABEL_EXISTS: labelExists ? 'true' : '',
      TEST_API_LOG: logPath,
      TEST_API_PAGES: JSON.stringify(pages),
      TEST_API_FAILURE_AT: apiFailureAt ? String(apiFailureAt) : '',
      TEST_UNEXPECTED_NETWORK: unexpectedNetwork ? 'allow' : '',
      TEST_RESPONSE_MODE: responseMode ?? '',
      TEST_INITIAL_STATE: initialState ?? '',
      TEST_FAIL_CLOSE: failClose ? 'true' : '',
      TEST_MERGED: merged ? 'true' : '',
      TEST_EXPECTED_MARKER: responseMode === 'post_failure' && pages.flat(Infinity).some(comment => comment?.id === 27)
        ? pages.flat(Infinity).find(comment => comment?.id === 27).body
        : expectedMarker,
      TEST_EVENT_TITLE: fixture.issue?.title ?? fixture.pull_request?.title ?? '',
      TEST_EVENT_BODY: JSON.stringify(fixture.issue?.body ?? fixture.pull_request?.body ?? null),
    },
  });
  return {
    result,
    output: await readFile(outputPath, 'utf8').catch(() => ''),
    summary: await readFile(summaryPath, 'utf8').catch(() => ''),
    requests: (await readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    directory,
    harness,
  };
}

function eventFor(kind, { item, title, body }) {
  const target = { number: item, title, body, user: { login: 'contributor' } };
  return kind === 'issues'
    ? { action: 'opened', repository: { full_name: 'owner/repo' }, issue: target }
    : { action: 'opened', repository: { full_name: 'owner/repo' }, pull_request: target };
}

function assertNoSensitiveOutput(run, strings) {
  const visible = `${run.result.stdout}\n${run.result.stderr}\n${run.output}\n${run.summary}`;
  for (const value of strings) assert.equal(visible.includes(value), false, `sensitive data was visible: ${value}`);
}

test('built issue Action scores real classifier text and treats injection as data', async t => {
  const title = 'Describe your work';
  const body = `I carefully explain my own changes. ${injectionText}`;
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 31, title, body }), pages: [[]] });
  assert.equal(run.result.status, 0, `${run.result.stderr} output=${run.output}`);
  assert.match(run.output, /^outcome=closed\nrobot-score=0\.\d+\n$/);
  assert.equal(run.requests.at(-1).method, 'PATCH');
  assertNoSensitiveOutput(run, [token, injectionText]);
  const isolatedFiles = await readdir(run.directory);
  assert.equal(isolatedFiles.includes('node_modules'), false);
  assert.equal(isolatedFiles.some(name => /\.go$|Dockerfile/i.test(name)), false);
});

test('built Action leaves a score between old and new cutoffs unchanged', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability.';
  const scorer = await import('../../dist/scorer.mjs');
  const scored = await scorer.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'));
  assert.ok(scored.robot_score >= 0.6 && scored.robot_score < 0.8);
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 43, title, body }), pages: [[]] });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.output, /^outcome=below_cutoff\nrobot-score=0\.\d+\n$/);
  assert.deepEqual(run.requests, []);
  assertNoSensitiveOutput(run, [token, body]);
});

test('built issue Action uses packaged score and rejects an exact matching contributor spoof marker', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const score = await import('../../dist/scorer.mjs');
  const sourceResult = await score.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'));
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 32, title, body }), pages: [[{
    id: 9, body: marker(32, sourceResult.input_sha256), user: { login: 'contributor', type: 'User' },
  }]], labelExists: true });
  assert.equal(run.result.status, 0, `${run.result.stderr} stdout=${run.result.stdout}`);
  assert.match(run.output, /^outcome=closed\nrobot-score=0\.\d+\n$/);
  assert.equal(run.requests.filter(request => request.method === 'POST' && request.pathname.endsWith('/comments')).length, 1);
  assert.equal(run.requests.filter(request => request.method === 'POST' && request.pathname === '/repos/owner/repo/issues/32/labels').length, 1);
  assert.deepEqual(run.requests.slice(-3).map(({ method, pathname }) => [method, pathname]), [
    ['GET', '/repos/owner/repo/issues/32'],
    ['GET', '/repos/owner/repo/issues/32/labels'],
    ['PATCH', '/repos/owner/repo/issues/32'],
  ]);
  assert.equal(run.requests.some(request => request.body?.body?.includes(injectionText)), false);
  assert.ok(run.requests.every(request => request.authorization === `Bearer ${token}`));
  const existingMarker = marker(32, sourceResult.input_sha256);
  const botComments = run.requests.filter(request => request.method === 'POST' && request.pathname.endsWith('/comments')).map(request => request.body.body);
  assert.equal(botComments.length, 1);
  assert.ok(botComments[0].includes(existingMarker));
  assertNoSensitiveOutput(run, [token, body, injectionText]);
});

test('built observe mode provisions repository labels but applies only the pending label', async t => {
  const cases = [
    ['issues', 'issue', 61],
    ['pull_request_target', 'pull_request', 62],
  ];
  for (const [eventName, kind, item] of cases) {
    const title = 'Describe your work';
    const body = 'The implementation provides a comprehensive, robust, and seamless solution that leverages systematic methods to enhance maintainability and functionality.';
    const scorer = await import('../../dist/scorer.mjs');
    const score = await scorer.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'));
    assert.ok(score.robot_score >= 0.8, `fixture score ${score.robot_score} must reach observation cutoff`);
    const run = await runBuilt(t, { eventName, fixture: eventFor(eventName, { item, title, body }), mode: 'observe' });
    assert.equal(run.result.status, 0, `${run.result.stderr} output=${run.output} requests=${JSON.stringify(run.requests)}`);
    assert.match(run.output, /^outcome=flagged\nrobot-score=0\.\d+\n$/);
    const outcomeLabelNames = ['mellon: reviewed-human', 'mellon: reviewed-ai', 'mellon: reviewed-unsure'];
    assert.deepEqual(run.requests.map(({ method, pathname }) => [method, pathname]), [
      ['GET', `/repos/owner/repo/${kind === 'issue' ? 'issues' : 'pulls'}/${item}`],
      ['GET', `/repos/owner/repo/issues/${item}/labels`],
      ...outcomeLabelNames.flatMap(name => [
        ['GET', `/repos/owner/repo/labels/${encodeURIComponent(name)}`],
        ['POST', '/repos/owner/repo/labels'],
      ]),
      ['GET', '/repos/owner/repo/labels/mellon%3A%20review'],
      ['GET', `/repos/owner/repo/${kind === 'issue' ? 'issues' : 'pulls'}/${item}`],
      ['GET', `/repos/owner/repo/issues/${item}/labels`],
      ['POST', '/repos/owner/repo/labels'],
      ['GET', `/repos/owner/repo/${kind === 'issue' ? 'issues' : 'pulls'}/${item}`],
      ['GET', `/repos/owner/repo/issues/${item}/labels`],
      ['POST', `/repos/owner/repo/issues/${item}/labels`],
    ]);
    assert.deepEqual(run.requests.filter(({ method, pathname }) => method === 'POST' && pathname === '/repos/owner/repo/labels')
      .map(({ body }) => body.name), [...outcomeLabelNames, 'mellon: review']);
    assert.equal(run.requests.some(({ method, pathname }) => method === 'PATCH' || pathname.endsWith('/comments')), false);
    assert.deepEqual(run.requests.at(-1).body, { labels: ['mellon: review'] });
    assertNoSensitiveOutput(run, [token, body]);
  }
});

test('built Action rejects malformed label pagination before pending labeling or closure', async t => {
  const title = 'Describe your work';
  const body = 'The implementation provides a comprehensive, robust, and seamless solution that leverages systematic methods to enhance maintainability and functionality.';
  for (const [mode, reviewLabel] of [['observe', 'true'], ['enforce', 'true'], ['enforce', 'false']]) {
    const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 66, title, body }),
      mode, reviewLabel, malformedLabelPagination: true });
    assert.equal(run.result.status, 1);
    assert.equal(run.output.startsWith('outcome=error\n'), true);
    assert.equal(run.requests.some(request => request.method === 'PATCH'), false);
    assert.equal(run.requests.some(request => request.method === 'POST' && request.pathname.endsWith('/labels')), false);
    assertNoSensitiveOutput(run, [token, body]);
  }
});

test('built Action respects completed outcomes on later label pages', async t => {
  const title = 'Describe your work';
  const body = 'The implementation provides a comprehensive, robust, and seamless solution that leverages systematic methods to enhance maintainability and functionality.';
  for (const [mode, reviewLabel] of [['observe', 'true'], ['enforce', 'true'], ['enforce', 'false']]) {
    for (const name of ['mellon: reviewed-human', 'mellon: reviewed-ai', 'mellon: reviewed-unsure']) {
      const run = await runBuilt(t, { eventName: 'pull_request_target', fixture: eventFor('pull_request_target', { item: 67, title, body }),
        mode, reviewLabel, itemLabelPages: [[{ name: 'unrelated' }], [{ name }]] });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.match(run.output, /^outcome=skipped\nrobot-score=0\.\d+\n$/);
      assert.ok(run.requests.some(request => request.pathname === '/repos/owner/repo/issues/67/labels' && request.search.includes('page=2')));
      assert.equal(run.requests.some(request => request.method === 'PATCH'), false);
      assert.equal(run.requests.some(request => request.method === 'POST' && request.pathname.endsWith('/labels')), false);
      assertNoSensitiveOutput(run, [token, body]);
    }
  }
});

test('built observe mode below cutoff makes no API requests', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability.';
  const scorer = await import('../../dist/scorer.mjs');
  const score = await scorer.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'));
  assert.ok(score.robot_score < 0.8, `fixture score ${score.robot_score} must be below observation cutoff`);
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 63, title, body }), mode: 'observe' });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.output, /^outcome=below_cutoff\nrobot-score=0\.\d+\n$/);
  assert.deepEqual(run.requests, []);
});

test('built observe mode reports label API failure without posting or closing', async t => {
  const title = 'Describe your work';
  const body = 'The implementation provides a comprehensive, robust, and seamless solution that leverages systematic methods to enhance maintainability and functionality.';
  const scorer = await import('../../dist/scorer.mjs');
  const score = await scorer.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'));
  assert.ok(score.robot_score >= 0.8);
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 64, title, body }), mode: 'observe', labelFailure: true });
  assert.equal(run.result.status, 1);
  assert.match(run.output, /^outcome=error\n$/);
  assert.equal(run.requests.some(({ method, pathname }) => method === 'PATCH' || pathname.endsWith('/comments')), false);
  assertNoSensitiveOutput(run, [token, body, 'sensitive label API failure']);
});

test('built observe mode reuses existing label without recreation or enforcement writes', async t => {
  const title = 'Describe your work';
  const body = 'The implementation provides a comprehensive, robust, and seamless solution that leverages systematic methods to enhance maintainability and functionality.';
  const scorer = await import('../../dist/scorer.mjs');
  assert.ok((await scorer.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'))).robot_score >= 0.8);
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 65, title, body }), mode: 'observe', labelExists: true });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.requests.some(({ pathname }) => pathname === '/repos/owner/repo/labels'), false);
  assert.equal(run.requests.some(({ method, pathname }) => method === 'PATCH' || pathname.endsWith('/comments')), false);
  assert.equal(run.requests.at(-1).pathname, '/repos/owner/repo/issues/65/labels');
});

test('built pull request Action skips a merged PR before posting', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const scorer = await import('../../dist/scorer.mjs');
  const scored = await scorer.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'));
  assert.ok(scored.robot_score >= 0.8);
  const run = await runBuilt(t, { eventName: 'pull_request_target', fixture: eventFor('pull_request_target', { item: 40, title, body }), pages: [[]], merged: true });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.output, /^outcome=skipped\nrobot-score=0\.\d+\n$/);
  assert.equal(run.requests.some(request => request.method === 'POST' || request.method === 'PATCH'), false);
  assertNoSensitiveOutput(run, [token, body]);
});

test('built Action classifies prepared empty input without GitHub requests', async t => {
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 41, title: '```js\nconst input = 1;\n```', body: null }), pages: [[]] });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.output, 'outcome=empty_input\n');
  assert.deepEqual(run.requests, []);
  assertNoSensitiveOutput(run, [token]);
});

test('built pull request Action reports confirmed response when closure fails', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const run = await runBuilt(t, { eventName: 'pull_request_target', fixture: eventFor('pull_request_target', { item: 42, title, body }), pages: [[]], failClose: true });
  assert.equal(run.result.status, 1);
  assert.match(run.output, /^outcome=error\nrobot-score=0\.\d+\n$/);
  assert.match(run.summary, /Response confirmed: yes/);
  assert.match(run.summary, /Closure completed: no/);
  assert.match(run.summary, /Comment ID: 27/);
  assert.match(run.summary, /Detector revision: [a-f0-9]{40}/);
  assert.match(run.summary, /Model SHA-256: [a-f0-9]{64}/);
  assert.match(run.summary, /Input SHA-256: [a-f0-9]{64}/);
  assert.equal(run.requests.filter(request => request.method === 'POST' && request.pathname.endsWith('/comments')).length, 1);
  assert.equal(run.requests.filter(request => request.method === 'POST' && request.pathname === '/repos/owner/repo/issues/42/labels').length, 1);
  assert.deepEqual(run.requests.slice(-3).map(({ method, pathname }) => [method, pathname]), [
    ['GET', '/repos/owner/repo/pulls/42'],
    ['GET', '/repos/owner/repo/issues/42/labels'],
    ['PATCH', '/repos/owner/repo/pulls/42'],
  ]);
  assertNoSensitiveOutput(run, [token, body, 'sensitive close failure']);
});

test('built pull request Action scores nullable body and uses pull request API endpoints', async t => {
  const title = 'A short but complete contribution';
  const run = await runBuilt(t, { eventName: 'pull_request_target', fixture: eventFor('pull_request_target', { item: 33, title, body: null }), pages: [[]] });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.output, /^outcome=(?:below_cutoff|closed)\n/);
  assert.equal(run.requests.some(request => request.pathname === '/repos/owner/repo/issues/33'), false);
  assert.equal(run.requests.every(request => request.pathname === '/repos/owner/repo/pulls/33' || request.pathname === '/repos/owner/repo/issues/33/comments'), true);
  assertNoSensitiveOutput(run, [token]);
});

test('built Action skips an issue that was already closed before responding', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 36, title, body }), pages: [[]], initialState: 'closed' });
  assert.equal(run.result.status, 0);
  assert.equal(run.output.startsWith('outcome=skipped\n'), true);
  assert.equal(run.requests.some(request => request.method === 'POST' || request.method === 'PATCH'), false);
  assertNoSensitiveOutput(run, [token, body]);
});

test('built Action skips when current submission text changes after response', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 37, title, body }), pages: [[]], responseMode: 'state_changed' });
  assert.equal(run.result.status, 0);
  assert.equal(run.output.startsWith('outcome=skipped\n'), true);
  assert.equal(run.requests.some(request => request.method === 'POST'), true);
  assert.equal(run.requests.some(request => request.method === 'PATCH'), false);
  assertNoSensitiveOutput(run, [token, body]);
});

test('built Action reuses a verified matching bot comment without reposting', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const score = await import('../../dist/scorer.mjs');
  const sourceResult = await score.scoreRequest({ protocol_version: 1, text: `${title}\n\n${body}` }, path.join(artifactDirectory, 'detector'));
  const existing = { id: 27, body: marker(38, sourceResult.input_sha256), user: { login: 'github-actions[bot]', type: 'Bot' } };
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 38, title, body }),
    pages: [[existing]], responseMode: 'post_failure', labelExists: true });
  assert.equal(run.result.status, 0);
  assert.equal(run.output.startsWith('outcome=closed\n'), true);
  assert.equal(run.requests.filter(request => request.method === 'POST' && request.pathname.endsWith('/comments')).length, 0);
  assert.equal(run.requests.filter(request => request.method === 'POST' && request.pathname === '/repos/owner/repo/issues/38/labels').length, 1);
  assert.deepEqual(run.requests.slice(-3).map(({ method, pathname }) => [method, pathname]), [
    ['GET', '/repos/owner/repo/issues/38'],
    ['GET', '/repos/owner/repo/issues/38/labels'],
    ['PATCH', '/repos/owner/repo/issues/38'],
  ]);
  assertNoSensitiveOutput(run, [token, body]);
});

test('built Action fails safely when uncertain POST reconciliation fails', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 39, title, body }),
    pages: [[]], responseMode: 'reconcile_failure' });
  assert.equal(run.result.status, 1);
  assert.equal(run.output.startsWith('outcome=error\n'), true);
  assert.equal(run.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(run.requests.some(request => request.method === 'PATCH'), false);
  assertNoSensitiveOutput(run, [token, body, 'reconcile failure']);
});

test('built pull request Action keeps moderating after an outcome-label lookup fails', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const run = await runBuilt(t, { eventName: 'pull_request_target', fixture: eventFor('pull_request_target', { item: 34, title, body }), pages: [[]], outcomeLookupFailure: true });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.output, /^outcome=closed\nrobot-score=0\.\d+\n$/);
  assert.ok(run.requests.some(request => request.method === 'POST' && request.pathname.endsWith('/comments')));
  assert.equal(run.requests.at(-1).method, 'PATCH');
  assertNoSensitiveOutput(run, [token, body, 'private label lookup failure']);
});

test('built pull request Action reports a safe error on required API failure', async t => {
  const title = 'Check the math';
  const body = 'This change introduces a structured approach to configuration management and improves maintainability. It provides a comprehensive solution that enhances reliability, streamlines workflows, and ensures consistent behavior across the application.';
  const run = await runBuilt(t, { eventName: 'pull_request_target', fixture: eventFor('pull_request_target', { item: 34, title, body }), pages: [[]], apiFailureAt: 1 });
  assert.equal(run.result.status, 1);
  assert.equal(run.output, 'outcome=error\n');
  assert.equal(run.requests.some(request => request.method !== 'GET'), false);
  assertNoSensitiveOutput(run, [token, body, 'fixture API failure']);
});

test('built Action does not run with node_modules or make runtime dependency requests', async t => {
  const title = 'hello';
  const body = null;
  const run = await runBuilt(t, { eventName: 'issues', fixture: eventFor('issues', { item: 35, title, body }), pages: [[]] });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal((await readdir(run.directory)).includes('node_modules'), false);
  assert.deepEqual(run.requests, []);
  assert.doesNotMatch(run.result.stderr, /Cannot find package/);
});
