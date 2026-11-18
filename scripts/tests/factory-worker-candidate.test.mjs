import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidate, candidateProgram } from '../../internal/factory-worker/candidate.mjs';

const PATH = 'tests/unit/personalized-terminal-controls.test.mjs';
const CONFIG = { baseSha: 'a'.repeat(40), allowedPaths: [PATH] };
const VALUE = { baseSha: CONFIG.baseSha, files: [{ path: PATH, content: 'import test from "node:test";\n' }] };

test('candidate identity is recomputed from bounded file content, not worker claims', () => {
  const result = validateCandidate(VALUE, CONFIG);
  assert.equal(result.files[0].path, PATH);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.baseSha, CONFIG.baseSha);
  assert.equal(result.totalBytes, 30);
});
for (const value of [
  { ...VALUE, baseSha: 'b'.repeat(40) },
  { ...VALUE, files: [{ path: '../outside', content: 'unsafe' }] },
  { ...VALUE, files: [{ path: '.github/workflows/evil.yml', content: 'unsafe' }] },
  { ...VALUE, files: [{ path: PATH, content: 'x'.repeat(131073) }] },
  { ...VALUE, files: [{ path: PATH, content: '-----BEGIN PRIVATE KEY-----' }] },
  { ...VALUE, files: [VALUE.files[0], VALUE.files[0]] },
]) {
  test('rejects expanded source scope, credentials, oversized or duplicate candidate data', () => {
    assert.throws(() => validateCandidate(value, CONFIG), /Factory candidate rejected/);
  });
}

test('export program has fixed source/base scope and rejects arbitrary path configuration', () => {
  assert.equal(typeof candidateProgram(CONFIG), 'string');
  assert.throws(() => candidateProgram({ ...CONFIG, allowedPaths: ['/root/.ssh/id_rsa'] }), /Factory candidate rejected/);
});

test('export runs against a real checkout, skips the proposal file and returns its metadata separately', async () => {
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'mellon-candidate-run-'));
  // Isolated from the host's git config (signing would wait for a passphrase).
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env, timeout: 20000 }).trim();
  git('init', '-q'); await writeFile(join(root, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'README.md'), 'changed\n');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'new.md'), 'new doc\n');
  await writeFile(join(root, '.factory-proposal.json'), JSON.stringify({ title: 'docs(readme): explain setup', summary: 'Adds a doc.' }));
  const auth = join(root, '..', `auth-${Date.now()}.json`);
  await writeFile(auth, '{}');
  const program = candidateProgram({ baseSha: base, allowedPaths: ['README.md', 'docs/new.md'] })
    .replace("root='/workspace/mellon'", `root=${JSON.stringify(root)}`)
    .replace('process.getuid()!==10001||', '')
    .replace("'/worker-state/pi-agent/auth.json'", JSON.stringify(auth));
  const r = spawnSync(process.execPath, ['--input-type=module', '-'], { input: program, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.files.map(f => f.path), ['README.md', 'docs/new.md']);
  assert.deepEqual(out.meta, { title: 'docs(readme): explain setup', summary: 'Adds a doc.' });
  assert.equal(validateCandidate(out, { baseSha: base, allowedPaths: ['README.md', 'docs/new.md'] }).files.length, 2);
});

test('a planned deletion exports as a deletion; an unplanned one is refused', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'mellon-candidate-delete-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env, timeout: 20000 }).trim();
  git('init', '-q');
  await writeFile(join(root, 'README.md'), 'base\n');
  await writeFile(join(root, 'old.md'), 'old\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const auth = join(root, '..', `auth-del-${Date.now()}.json`);
  await writeFile(auth, '{}');
  const exportWith = allowedPaths => spawnSync(process.execPath, ['--input-type=module', '-'], { encoding: 'utf8', input: candidateProgram({ baseSha: base, allowedPaths })
    .replace("root='/workspace/mellon'", `root=${JSON.stringify(root)}`).replace('process.getuid()!==10001||', '').replace("'/worker-state/pi-agent/auth.json'", JSON.stringify(auth)) });
  // A rename: old.md removed, docs/new.md added.
  await rm(join(root, 'old.md'));
  await (await import('node:fs/promises')).mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'new.md'), 'old\n');
  // old.md is outside the docs/ policy, so use README.md as the planned deletion instead.
  await rm(join(root, 'README.md'));
  const refused = exportWith(['docs/new.md', 'README.md']);
  assert.notEqual(refused.status, 0, 'old.md was deleted without being planned');
  git('checkout', '--', 'old.md');
  const r = exportWith(['docs/new.md', 'README.md']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.files.map(f => [f.path, f.deleted === true]), [['README.md', true], ['docs/new.md', false]]);
  const checked = validateCandidate(out, { baseSha: base, allowedPaths: ['docs/new.md', 'README.md'] });
  assert.deepEqual(checked.files.map(f => [f.path, f.deleted === true]), [['README.md', true], ['docs/new.md', false]]);
  assert.equal(checked.files[0].content, undefined);
});

test('deletion records carry no content and must name an allowed path', () => {
  const config = { baseSha: 'a'.repeat(40), allowedPaths: ['README.md', 'docs/a.md'] };
  const ok = validateCandidate({ baseSha: config.baseSha, files: [{ path: 'README.md', deleted: true }] }, config);
  assert.deepEqual(ok.files, [{ path: 'README.md', deleted: true }]);
  const withContent = validateCandidate({ baseSha: config.baseSha, files: [{ path: 'docs/a.md', content: 'x\n' }] }, config);
  assert.notEqual(ok.digest, withContent.digest);
  for (const file of [{ path: 'README.md', deleted: true, content: 'x' }, { path: 'other.md', deleted: true }, { path: 'README.md', deleted: 'yes' }]) {
    assert.throws(() => validateCandidate({ baseSha: config.baseSha, files: [file] }, config), /Factory candidate rejected/);
  }
});

test('the exporter accepts every path the job validator accepts, and nothing more', async () => {
  const { NO_REBUILD_PATH, REBUILD_PATH } = await import('../../internal/factory-worker/control-policy.mjs');
  const ok = ['action.yml', 'tests/fixtures/a.json', 'tests/fixtures/deep/b.txt', 'src/inputs.mjs', 'src/personalized/cli.mjs', 'docs/a.md', 'README.md', 'tests/unit/a.test.mjs'];
  for (const path of ok) {
    assert.equal(NO_REBUILD_PATH.test(path) || REBUILD_PATH.test(path), true, path);
    assert.equal(typeof candidateProgram({ baseSha: 'a'.repeat(40), allowedPaths: [path] }), 'string', path);
  }
  for (const path of ['src/deep/x.mjs', 'scripts/build.mjs', 'dist/index.mjs', 'package.json', 'detector/scorer.mjs']) {
    assert.throws(() => candidateProgram({ baseSha: 'a'.repeat(40), allowedPaths: [path] }), /Factory candidate rejected/, path);
  }
});
