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
