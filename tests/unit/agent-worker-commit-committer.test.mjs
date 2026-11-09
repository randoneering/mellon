import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_COMMITTER, REPOSITORY_FULL_NAME, verifyCommitProof, verifyOwnedCommitProof }
  from '../../src/automation/worker/publication-validation.mjs';

const actor = { databaseId: 354307453, login: 'randoneering-mellon-worker[bot]' };
const parentSha = 'a'.repeat(40);
const expected = { repositoryId: 1431725779, oid: 'c'.repeat(40), parentSha, actor };

// Shape observed on a live App commit made through createCommitOnBranch.
function proof(committer = { ...EXPECTED_COMMITTER }) {
  return { repositoryId: expected.repositoryId, repositoryName: REPOSITORY_FULL_NAME,
    commit: { oid: expected.oid, tree: { oid: 'd'.repeat(40) }, parents: [parentSha],
      author: { ...actor }, committer,
      signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true } } };
}

test('commit proofs accept the GitHub web-flow committer for App commits', () => {
  assert.equal(verifyCommitProof(proof(), expected), true);
  assert.deepEqual(verifyOwnedCommitProof(proof(), expected),
    { treeSha: 'd'.repeat(40), parentSha });
});

for (const [name, committer] of [
  ['the App bot as committer', { ...actor }],
  ['a different committer name', { name: 'Someone', email: EXPECTED_COMMITTER.email }],
  ['a different committer email', { name: EXPECTED_COMMITTER.name, email: 'someone@example.com' }],
  ['extra committer fields', { ...EXPECTED_COMMITTER, databaseId: 1 }],
  ['a missing committer', null],
]) {
  test(`commit proofs reject ${name}`, () => {
    assert.equal(verifyCommitProof(proof(committer), expected), false);
    assert.equal(verifyOwnedCommitProof(proof(committer), expected), null);
  });
}
