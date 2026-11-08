import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateIntent } from '../../src/automation/worker/store-validation.mjs';
import { candidateInput, phaseFor, canonical, hash, blob, PATH, SOURCE } from '../fixtures/worker-candidates/inputs.mjs';
import { prepareCandidate } from '../../src/automation/worker/candidate.mjs';

function repairCandidateInput() {
  const input = candidateInput();
  input.phase = phaseFor(input.publicationRun, 'repair_tests', 1, 'd'.repeat(64));
  input.changes[0].content = SOURCE.replace('approved regression location', 'approved repair one');
  const file = input.baseFiles.at(-1);
  Object.assign(file, { mode: '100644', text: 'export const old = 1;' });
  file.blobSha = blob(file.text);
  file.sha256 = hash(file.text);
  input.assessment = { disposition: 'confirmed', findingSha256: input.phase.findingSha256,
    criterionIndex: 0, criterionSha256: hash(input.approvedManifest.acceptanceCriteria[0]),
    references: [{ fileIndex: 5, blobSha: file.blobSha, testIdentitySha256: null }] };
  input.phase.investigation = { version: 1, headSha: input.phase.headSha,
    findingSha256: input.phase.findingSha256,
    criteria: [{ criterionIndex: 0, criterionSha256: input.assessment.criterionSha256 }],
    references: structuredClone(input.assessment.references), regressionFileIndex: 3 };
  return input;
}

test('candidate derives native identity and publication hash without model identity claims', () => {
  const input = candidateInput();
  const result = prepareCandidate(input);
  assert.equal(result.expectedRegression.testIdentitySha256, hash(canonical({ column: 1, entryFile: PATH, line: 4, name: 'approved regression location', nesting: 0, type: 'test' })));
  assert.equal(result.expectedRegression.proposalSha256, result.intent.inputHash);
  assert.equal(result.publication.intent.id, result.intent.key);
  assert.equal(result.metadata.criterionSha256, hash('Exact approved criterion.'));
  assert.equal(result.metadata.candidateDescriptors[0].afterBlobSha, blob(SOURCE));
  assert.equal(JSON.stringify(result.metadata).includes('assert.equal(1, 2)'), false);
});

test('candidate selected static fixture agrees with actual Node24 native reporter identity', () => {
  assert.equal(readFileSync(PATH, 'utf8'), SOURCE);
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'randoneering/mellon', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '717', GITHUB_RUN_ATTEMPT: '1', MELLON_CI_PRODUCER_SHA256: 'c'.repeat(64) };
  delete env.NODE_TEST_CONTEXT;
  const native = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=./automation/ci/test-reporter.mjs', PATH], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.equal(native.error, undefined);
  assert.equal(native.status, 1);
  const record = native.stdout.split('\n').find(line => line.startsWith('MELLON_CI_RAW_V2:'));
  assert.ok(record);
  const report = JSON.parse(Buffer.from(record.slice('MELLON_CI_RAW_V2:'.length), 'base64url'));
  assert.equal(report.failures[0].testIdentitySha256, prepareCandidate(candidateInput()).expectedRegression.testIdentitySha256);
});

test('candidate named-import fixture agrees with native Node24 indented coordinates', () => {
  const path = 'tests/fixtures/worker-candidates/named-location.test.mjs';
  const source = readFileSync(path, 'utf8');
  const input = candidateInput();
  input.approvedManifest.allowedPaths[0] = path;
  input.publicationRun.manifestSha256 = hash(canonical(input.approvedManifest));
  input.phase = phaseFor(input.publicationRun);
  input.changes[0].path = path; input.changes[0].content = source;
  input.baseFiles[3].path = path;
  const identity = prepareCandidate(input).expectedRegression.testIdentitySha256;
  assert.equal(identity, hash(canonical({ column: 3, entryFile: path, line: 4, name: 'approved regression location', nesting: 0, type: 'test' })));
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'randoneering/mellon', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '718', GITHUB_RUN_ATTEMPT: '1', MELLON_CI_PRODUCER_SHA256: 'c'.repeat(64) };
  delete env.NODE_TEST_CONTEXT;
  const native = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=./automation/ci/test-reporter.mjs', 'tests/fixtures/worker-candidates/named-location.test.mjs'], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.equal(native.status, 1);
  const record = native.stdout.split('\n').find(line => line.startsWith('MELLON_CI_RAW_V2:'));
  assert.ok(record);
  const report = JSON.parse(Buffer.from(record.slice('MELLON_CI_RAW_V2:'.length), 'base64url'));
  assert.equal(report.failures[0].testIdentitySha256, identity);
});

const invalidSources = {
  'dynamic literal name': SOURCE.replace("'approved regression location'", '`approved regression location`'),
  'parenthesized callee': SOURCE.replace("test('approved", "((test))('approved"),
  'multiline parenthesized callee': SOURCE.replace("test('approved", "(test)\n('approved"),
  'outer parenthesized registration': SOURCE.replace("test('approved", "(test('approved").replace('});', '}));'),
  'callback context skip': SOURCE.replace('() => {', 't => {').replace('assert.equal(1, 2);', 't.skip();'),
  'callback context todo': SOURCE.replace('() => {', 't => {').replace('assert.equal(1, 2);', 't.todo();'),
  'computed context skip': SOURCE.replace('() => {', 't => {').replace('assert.equal(1, 2);', "t['skip']();"),
  'aliased context skip': SOURCE.replace('() => {', 't => {').replace('assert.equal(1, 2);', 'const alias = t; alias.skip();'),
  'destructured context skip': SOURCE.replace('() => {', '({ skip }) => {').replace('assert.equal(1, 2);', 'skip();'),
  'context passed to reflection': SOURCE.replace('() => {', 't => {').replace('assert.equal(1, 2);', "Reflect.get(t, 'skip')();"),
  'implicit arguments context': SOURCE.replace('() => {', 'function () {').replace('assert.equal(1, 2);', 'arguments[0].skip();'),
  'nested selected call': SOURCE.replace("test('approved", "(() => { test('approved") + '})();',
  'test import alias': SOURCE.replace("import test from", "import aliased from").replace("test('approved", "aliased('approved"),
  'named import alias': SOURCE.replace("import test from 'node:test'", "import { test as alias } from 'node:test'").replace("test('approved", "alias('approved"),
  'generated test loop': SOURCE.replace("test('approved", "for (const item of [1]) test('approved"),
  'skip flag': SOURCE.replace("test('approved", "test.skip('approved"),
  'todo option': SOURCE.replace("location', ()", "location', { todo: true }, ()"),
  'duplicate selected name': SOURCE + SOURCE.slice(SOURCE.indexOf("test('")),
  'ambiguous nested binding': SOURCE.replace('assert.equal(1, 2);', "const alias = test; alias('hidden', () => {});"),
  'unsupported parser syntax': SOURCE + '\nusing resource = foo();',
  'dynamic test module import': SOURCE.replace('assert.equal(1, 2);', "import('node:test').then(m => m.default('generated', () => {}));"),
  'generated eval registration': SOURCE.replace('assert.equal(1, 2);', "eval(\"test('generated', () => {})\");"),
  'generated require registration': SOURCE.replace('assert.equal(1, 2);', "require('node:test')('generated', () => {});"),
  'marker only identity': "// approved regression location identity: forged\nexport const nothing = 1;",
};
for (const [name, source] of Object.entries(invalidSources)) test(`candidate rejects ${name}`, () => {
  const input = candidateInput(); input.changes[0].content = source;
  assert.throws(() => prepareCandidate(input), /Candidate/);
});
for (const [name, mutate] of Object.entries({
  'stale head': input => { input.phase.headSha = 'f'.repeat(40); },
  'wrong approved path': input => { input.changes[0].path = 'src/parser.mjs'; },
  'test phase production edit': input => { input.changes.push({ operation: 'create', path: 'src/parser.mjs', content: 'export const x = 1;' }); },
  'forged model operation': input => { input.modelOperationId = 'model supplied marker'; },
  'forged native claim': input => { input.changes[0].testIdentitySha256 = 'f'.repeat(64); },
  'wrong external pin': input => { input.publicationRun.manifestSha256 = 'f'.repeat(64); },
  'binary text': input => { input.changes[0].content += '\u0000'; },
  'non utf8 text': input => { input.changes[0].content += '\ud800'; },
  'symlink base': input => { input.baseFiles.at(-3).mode = '120000'; input.baseFiles.at(-3).blobSha = 'e'.repeat(40); },
})) test(`candidate rejects ${name}`, () => { const input = candidateInput(); mutate(input); assert.throws(() => prepareCandidate(input), /Candidate/); });

test('candidate accepts the typed journal snapshot phase without resetting its timing fields', () => {
  const input = candidateInput();
  Object.assign(input.phase, { startedAt: '2026-06-01T00:00:00.000Z', waitStartedAt: null, pendingOperationId: null,
    expectedRegression: null, criterionSha256: null, findingSource: null, findingHeadSha: null, priorCheckRunId: null, priorReviewId: null });
  assert.equal(prepareCandidate(input).metadata.phaseKey, input.phase.key);
  input.phase.pendingOperationId = '22222222-2222-4222-8222-222222222222';
  assert.throws(() => prepareCandidate(input), /Candidate/);
});

test('candidate emits an intent accepted by the actual typed journal validator', () => {
  const result = prepareCandidate(candidateInput());
  assert.deepEqual(validateIntent(result.intent), result.intent);
  assert.deepEqual(result.intent.coordinator, result.metadata);
});

test('candidate source coordinates affect native identity while markers do not authorize selection', () => {
  const first = prepareCandidate(candidateInput());
  const input = candidateInput(); input.changes[0].content = '// identity claimed by model\n' + SOURCE;
  const shifted = prepareCandidate(input);
  assert.notEqual(first.expectedRegression.testIdentitySha256, shifted.expectedRegression.testIdentitySha256);
});

test('candidate repair requires authenticated matching criterion and pinned reserved name', () => {
  const input = repairCandidateInput();
  assert.equal(prepareCandidate(input).metadata.purpose, 'repair_tests');
  for (const field of ['findingSha256', 'criterionSha256']) {
    const forged = structuredClone(input); forged.assessment[field] = 'f'.repeat(64);
    assert.throws(() => prepareCandidate(forged), /Candidate/);
  }
  for (const disposition of ['suspected_false_positive', 'scope_change', 'insufficient_evidence']) {
    assert.throws(() => prepareCandidate({ ...input, assessment: { ...input.assessment, disposition } }), /Candidate/);
  }
  const forged = structuredClone(input); forged.assessment.references[0].blobSha = 'f'.repeat(40);
  assert.throws(() => prepareCandidate(forged), /Candidate/);
  for (const mutate of [
    value => { value.phase.investigation.headSha = 'f'.repeat(40); },
    value => { value.phase.investigation.regressionFileIndex = 0; },
    value => { value.phase.investigation.regressionFileIndex = '3'; },
    value => { value.assessment.references[0].fileIndex = 1; },
    value => { value.assessment.references[0].testIdentitySha256 = 'f'.repeat(64); },
    value => { value.phase.investigation.criteria.push({ criterionIndex: 31, criterionSha256: 'f'.repeat(64) }); },
    value => { value.phase.investigation.references.push({ fileIndex: 127, blobSha: 'f'.repeat(40), testIdentitySha256: null }); },
    value => { value.changes[0].content = SOURCE.replace('approved regression location', 'approved repair two'); },
  ]) {
    const wrong = structuredClone(input); mutate(wrong);
    assert.throws(() => prepareCandidate(wrong), /Candidate/);
  }
});

for (const [name, mutate] of [
  ['missing regular text', input => { delete input.baseFiles[5].text; }],
  ['missing regular SHA-256', input => { delete input.baseFiles[5].sha256; }],
  ['missing both regular fields', input => { delete input.baseFiles[5].text; delete input.baseFiles[5].sha256; }],
  ['mismatched regular digest', input => { input.baseFiles[5].sha256 = 'f'.repeat(64); }],
  ['unexpected ancestor digest', input => { input.baseFiles[0].sha256 = 'f'.repeat(64); }],
]) test(`candidate rejects incomplete prepared repair evidence: ${name}`, () => {
  const input = repairCandidateInput();
  mutate(input);
  assert.throws(() => prepareCandidate(input), /Candidate/);
});

test('candidate requires every unchanged approved path in its prepared context', () => {
  const input = candidateInput();
  input.baseFiles.pop();
  assert.throws(() => prepareCandidate(input), /Candidate/);
});

test('candidate rejects an out-of-scope regular file even if its hashes match', () => {
  const input = candidateInput();
  const text = 'export const outside = true;';
  input.baseFiles.push({ path: 'src/outside.mjs', mode: '100644', blobSha: blob(text),
    text, sha256: hash(text) });
  assert.throws(() => prepareCandidate(input), /Candidate/);
});

test('candidate validates complete repair context without changing file-index order', () => {
  const input = repairCandidateInput();
  const paths = input.baseFiles.map(file => file.path);
  const result = prepareCandidate(input);
  assert.deepEqual(input.baseFiles.map(file => file.path), paths);
  assert.equal(input.assessment.references[0].fileIndex, 5);
  assert.equal(result.metadata.candidateDescriptors[0].approvedPathIndex, 0);
});

test('candidate permits direct assertion access through a plain callback context', () => {
  const input = candidateInput();
  input.changes[0].content = SOURCE.replace('() => {', 't => {')
    .replace('assert.equal(1, 2);', 't.assert.equal(1, 2);');
  assert.equal(prepareCandidate(input).metadata.purpose, 'initial_tests');
});

test('candidate criterion hashing keeps exact Unicode bytes and stable intent ignores lease generation', () => {
  const input = candidateInput(); input.approvedManifest.acceptanceCriteria[0] = 'Cafe\u0301 exact criterion.';
  input.publicationRun.manifestSha256 = hash(canonical(input.approvedManifest)); input.phase = phaseFor(input.publicationRun);
  const first = prepareCandidate(input);
  assert.equal(first.metadata.criterionSha256, hash('Cafe\u0301 exact criterion.'));
  assert.notEqual(first.metadata.criterionSha256, hash('Caf\u00e9 exact criterion.'));
  input.publicationRun.generation += 1;
  assert.equal(prepareCandidate(input).intent.key, first.intent.key);
});

test('candidate implementation preserves the entire accepted regression blob', () => {
  const initial = prepareCandidate(candidateInput());
  const input = candidateInput(); input.phase = phaseFor(input.publicationRun, 'initial_implementation');
  input.phase.expectedRegression = initial.expectedRegression;
  input.baseFiles[input.baseFiles.length - 3] = { path: PATH, mode: '100644', blobSha: blob(SOURCE), text: SOURCE, sha256: hash(SOURCE) };
  input.changes = [{ operation: 'create', path: 'src/parser.mjs', content: 'export const result = true;' }];
  assert.deepEqual(prepareCandidate(input).expectedRegression, initial.expectedRegression);
  input.changes.push({ operation: 'modify', path: PATH, expectedBlobSha: blob(SOURCE), content: SOURCE + '\n' });
  assert.throws(() => prepareCandidate(input), /Candidate/);
});
