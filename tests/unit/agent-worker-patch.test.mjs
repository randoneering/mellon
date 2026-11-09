import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as patchModule from '../../src/automation/worker/patch.mjs';
const { validateChanges } = patchModule;

const blobSha = (content) => createHash('sha1')
  .update(`blob ${Buffer.byteLength(content, 'utf8')}\0${content}`)
  .digest('hex');
const scope = { kind: 'bounded-public-issue', maxChangedFiles: 10, maxFileBytes: 65536, maxTotalBytes: 262144 };
const manifest = (allowedPaths, pilotScope = scope) => ({ allowedPaths, pilotScope: { ...pilotScope } });
const base = (path, content, mode = '100644') => ({ path, mode, blobSha: blobSha(content) });
const modify = (path, content, expectedBlobSha) => ({ operation: 'modify', path, content, expectedBlobSha });
const create = (path, content) => ({ operation: 'create', path, content });

const absent = path => ({ path, mode: null, blobSha: null });
const directory = path => ({ path, mode: '040000', blobSha: null });

// Normal fixtures explicitly attest safe parents and target absence at one synthetic base.
// Topology regressions below call the raw validator with independently chosen records.
function validateFixture(baseFiles, proposed, policy) {
  if (!Array.isArray(baseFiles) || !Array.isArray(proposed)) return validateChanges(baseFiles, proposed, policy);
  const entries = baseFiles.map(file => ({ ...file }));
  const known = new Map(entries.map(file => [file.path, file]));
  function add(file) {
    if (!known.has(file.path)) { known.set(file.path, file); entries.push(file); }
  }
  function parents(path) {
    if (typeof path !== 'string') return;
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) add(directory(parts.slice(0, index).join('/')));
  }
  for (const file of entries.slice()) parents(file.path);
  for (const change of proposed) {
    if (typeof change?.path !== 'string') continue;
    parents(change.path);
    add(absent(change.path));
  }
  return validateChanges(entries, proposed, policy);
}


test('accepts approved regular UTF-8 text create and modify changes', () => {
  const result = validateFixture([base('src/a.txt', 'old')], [
    modify('src/a.txt', 'new', blobSha('old')),
    create('src/b.txt', 'λ'),
  ], manifest(['src/a.txt', 'src/b.txt']));
  assert.deepEqual(result.map(({ operation, path, content, mode }) => ({ operation, path, content, mode })), [
    { operation: 'modify', path: 'src/a.txt', content: 'new', mode: '100644' },
    { operation: 'create', path: 'src/b.txt', content: 'λ', mode: '100644' },
  ]);
});

test('preserves existing executable text mode without allowing an operation to change it', () => {
  const result = validateFixture([base('scripts/example.mjs', 'old', '100755')], [
    modify('scripts/example.mjs', 'new', blobSha('old')),
  ], manifest(['scripts/example.mjs']));
  assert.equal(result[0].mode, '100755');
  assert.throws(() => validateFixture([base('scripts/example.mjs', 'old', '100755')], [
    { ...modify('scripts/example.mjs', 'new', blobSha('old')), mode: '100644' },
  ], manifest(['scripts/example.mjs'])));
});

test('computes published blob metadata against a literal Git object vector', () => {
  const result = validateFixture([], [create('src/example.txt', 'hello\n')], manifest(['src/example.txt']));
  assert.equal(result[0].contentBytes, 6);
  assert.equal(result[0].contentBlobSha, 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('rejects expected-blob mismatches and malformed base blob metadata', () => {
  assert.throws(() => validateFixture([base('src/a.txt', 'old')], [modify('src/a.txt', 'new', blobSha('else'))], manifest(['src/a.txt'])));
  assert.throws(() => validateFixture([{ path: 'src/a.txt', mode: '100644', blobSha: 'bad' }], [modify('src/a.txt', 'new', 'bad')], manifest(['src/a.txt'])));
});

test('rejects traversal, encoded, ambiguous, and control paths', () => {
  for (const path of ['../x', 'src/../x', 'src/%2e%2e/x', 'src\\x', '/src/x', 'C:/x', 'src//x', 'src/./x', 'src/\u0001x']) {
    assert.throws(() => validateFixture([], [create(path, 'x')], manifest([path])));
  }
});

test('rejects protected paths even when explicitly allowlisted', () => {
  for (const path of ['.env', 'credentials.json', 'AGENTS.md', '.github/workflows/test.yml', 'package.json', 'package-lock.json', 'src/automation/worker/patch.mjs', 'automation/policy/pilot.json', 'skills/example/SKILL.md', 'dist/index.js']) {
    assert.throws(() => validateFixture([], [create(path, 'x')], manifest([path])));
  }
});

test('protects deployment, dependency settings, worker tests, and CI check controls even when allowlisted', () => {
  for (const path of [
    'neon.ts', '.neon/project.json', '.npmrc', '.pi/prompts/worker.md',
    'scripts/build.mjs', 'scripts/validate-release.mjs', 'scripts/verify-assets.mjs',
    'scripts/test-agent-intake-db.mjs', 'scripts/test-agent-worker-db.mjs',
    'scripts/tests/workflow-validation.test.mjs',
    'tests/unit/agent-worker-approval.test.mjs', 'tests/integration/agent-intake-store.test.mjs',
    'tests/support/agent-intake-database.mjs',
  ]) {
    assert.throws(() => validateFixture([], [create(path, 'untrusted change')], manifest([path])), {
      name: 'TypeError', message: 'Patch validation failed.',
    }, path);
  }
});

test('isolates the aggregate UTF-8 byte limit while all files fit the per-file limit', () => {
  const paths = Array.from({ length: 5 }, (_, index) => `src/file-${index}.txt`);
  const proposals = paths.map(path => create(path, 'x'.repeat(65536)));
  const policy = manifest(paths);
  assert.equal(validateFixture([], proposals.slice(0, 4), policy).length, 4);
  assert.throws(() => validateFixture([], proposals, policy), {
    name: 'TypeError', message: 'Patch validation failed.',
  });
  assert.equal(validateFixture([], [create('src/unicode.txt', 'λ'.repeat(32768))], manifest(['src/unicode.txt']))[0].contentBytes, 65536);
});

test('protects the Action definition and its complete local implementation graph', () => {
  for (const path of ['action.yml', 'action.yaml', 'src/action.mjs', 'src/github.mjs', 'src/inputs.mjs', 'src/moderation.mjs', 'src/prepare.mjs']) {
    assert.throws(() => validateFixture([], [create(path, 'changed action')], manifest([path])), {
      name: 'TypeError', message: 'Patch validation failed.',
    }, path);
  }
});

test('rejects file-directory conflicts among proposals and known current files in either direction', () => {
  for (const proposals of [
    [create('entry', 'x'), create('entry/child', 'y')],
    [create('entry/child', 'y'), create('entry', 'x')],
  ]) assert.throws(() => validateChanges([absent('entry'), absent('entry/child')], proposals, manifest(['entry', 'entry/child'])));
  assert.throws(() => validateChanges([base('entry', 'old'), absent('entry/child')], [create('entry/child', 'y')], manifest(['entry/child'])));
  assert.throws(() => validateChanges([absent('entry'), base('entry/child', 'old')], [create('entry', 'y')], manifest(['entry'])));
  assert.throws(() => validateChanges([directory('entry'), base('entry/child', 'old')], [create('entry', 'y')], manifest(['entry'])));
});

test('requires target and ancestor topology and rejects symlinks, gitlinks, and unknown ancestry', () => {
  const proposals = [create('link/child.txt', 'safe')];
  const policy = manifest(['link/child.txt']);
  assert.throws(() => validateChanges([], proposals, policy));
  assert.throws(() => validateChanges([absent('link/child.txt')], proposals, policy));
  assert.throws(() => validateChanges([directory('link')], proposals, policy));
  for (const mode of ['120000', '160000', '100644', '100755']) {
    assert.throws(() => validateChanges([base('link', 'existing', mode), absent('link/child.txt')], proposals, policy));
  }
  assert.equal(validateChanges([directory('link'), absent('link/child.txt')], proposals, policy).length, 1);
  assert.equal(validateChanges([absent('link'), absent('link/child.txt')], proposals, policy).length, 1);
  assert.throws(() => validateChanges([absent('link'), base('link/child.txt', 'impossible')], proposals, policy));
  assert.throws(() => validateChanges([absent('link'), directory('link/nested'), absent('link/nested/file.txt')],
    [create('link/nested/file.txt', 'bad topology')], manifest(['link/nested/file.txt'])));
});

test('enforces file count, per-file bytes, and total UTF-8 bytes', () => {
  assert.throws(() => validateFixture([], Array.from({ length: 11 }, (_, i) => create(`src/${i}.txt`, 'x')), manifest(Array.from({ length: 11 }, (_, i) => `src/${i}.txt`))));
  assert.throws(() => validateFixture([], [create('src/a.txt', 'λ'.repeat(32769))], manifest(['src/a.txt'])));
  assert.throws(() => validateFixture([], [create('src/a.txt', 'x'.repeat(140000)), create('src/b.txt', 'y'.repeat(122145))], manifest(['src/a.txt', 'src/b.txt'])));
});

test('rejects deletions, moves, duplicates, wrong modes, and unsupported fields', () => {
  for (const proposal of [
    { operation: 'delete', path: 'src/a.txt', expectedBlobSha: blobSha('x') },
    { operation: 'move', path: 'src/a.txt', content: 'x' },
    { ...create('src/a.txt', 'x'), mode: '120000' },
    { ...create('src/a.txt', 'x'), extra: true },
  ]) assert.throws(() => validateFixture([], [proposal], manifest(['src/a.txt'])));
  assert.throws(() => validateFixture([], [create('src/a.txt', 'x'), create('src/a.txt', 'y')], manifest(['src/a.txt'])));
  assert.throws(() => validateFixture([base('src/a.txt', 'x')], [create('src/a.txt', 'y')], manifest(['src/a.txt'])));
  assert.throws(() => validateFixture([], [modify('src/a.txt', 'y', blobSha('x'))], manifest(['src/a.txt'])));
  assert.throws(() => validateFixture([base('src/a.txt', 'x', '120000')], [modify('src/a.txt', 'y', blobSha('x'))], manifest(['src/a.txt'])));
});

test('rejects sparse proposal arrays rather than returning empty accepted slots', () => {
  assert.throws(() => validateFixture([], new Array(1), manifest(['src/a.txt'])), {
    name: 'TypeError', message: 'Patch validation failed.',
  });
});

test('rejects a scope whose per-file allowance exceeds its aggregate allowance', () => {
  assert.throws(() => validateFixture([], [create('src/a.txt', '')], manifest(['src/a.txt'], {
    ...scope, maxTotalBytes: 1,
  })), { name: 'TypeError', message: 'Patch validation failed.' });
});

test('rejects binary controls and malformed Unicode text', () => {
  for (const content of ['a\0b', 'a\u0007b', '\ud800']) {
    assert.throws(() => validateFixture([], [create('src/a.txt', content)], manifest(['src/a.txt'])));
  }
});

test('returns frozen caller-independent records without mutating inputs', () => {
  const input = [create('src/a.txt', 'safe')];
  const allow = ['src/a.txt'];
  const policy = manifest(allow);
  const accepted = validateFixture([], input, policy);
  assert.equal(input[0].content, 'safe');
  assert.equal(allow[0], 'src/a.txt');
  input[0].content = 'mutated';
  allow[0] = 'elsewhere';
  policy.pilotScope.maxFileBytes = 1;
  assert.equal(accepted[0].content, 'safe');
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted[0]), true);
  assert.throws(() => { accepted[0].path = 'neon.ts'; }, TypeError);
  assert.throws(() => { accepted.push(create('src/other.txt', 'bad')); }, TypeError);
  assert.throws(() => validateFixture([], [create('src/other.txt', 'bad')], policy));
});
