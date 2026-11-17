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
