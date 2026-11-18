import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidateReview } from '../../internal/factory-worker/review.mjs';

const EXPECTED = { baseSha:'a'.repeat(40),treeSha:'b'.repeat(40),candidateDigest:'c'.repeat(64) };
function clean() { return { findings:[],finding_state:{complete:true,introduced:[],still_open:[],dismissed:[]},meta:{coverage:{complete:true},skipped_files:[],run:{id:'review-id',snapshot:{base_sha:EXPECTED.baseSha,commit_sha:EXPECTED.baseSha,tree_sha:EXPECTED.treeSha}}} }; }

test('review gate accepts only complete current snapshot evidence without open findings', () => {
  const result = evaluateCandidateReview(clean(), EXPECTED);
  assert.equal(result.status, 'approved');
  assert.equal(result.reviewRunId, 'review-id');
  assert.equal(result.candidateDigest, EXPECTED.candidateDigest);
});
for (const change of [
  x => { x.meta.coverage.complete=false; },
  x => { x.finding_state.complete=false; },
  x => { x.meta.skipped_files=['tests/unit/candidate.test.mjs']; },
  x => { x.meta.run.snapshot.tree_sha='d'.repeat(40); },
  x => { x.meta.run.snapshot.base_sha='d'.repeat(40); },
]) {
  test('stale, incomplete or filtered review cannot authorize publication', () => {
    const value=clean();change(value);
    assert.throws(()=>evaluateCandidateReview(value,EXPECTED),/Factory review evidence rejected/);
  });
}

test('action level is never converted into severity and unclassified findings pause', () => {
  const value=clean();
  value.findings=[{id:'finding-id',category:'Correctness',action_level:'remediation_recommended',title:'A concern'}];
  value.finding_state.introduced=['finding-id'];
  const result=evaluateCandidateReview(value,EXPECTED);
  assert.equal(result.status,'awaiting_assessment');
  assert.equal(result.findings[0].reportedSeverity,null);
  assert.equal(result.findings[0].reportedActionLevel,'remediation_recommended');
});

test('a reported finding missing from every state list blocks approval', () => {
  const value=clean();
  value.findings=[{id:'unlisted-id',category:'Security',action_level:'action_required',title:'Unaccounted'}];
  assert.throws(()=>evaluateCandidateReview(value,EXPECTED),/Factory review evidence rejected/);
});

test('a finding listed in two states or a listed id without a finding record is rejected', () => {
  const twice=clean();
  twice.findings=[{id:'x',category:'Correctness',action_level:'informational',title:'t'}];
  twice.finding_state.introduced=['x'];twice.finding_state.dismissed=['x'];
  assert.throws(()=>evaluateCandidateReview(twice,EXPECTED),/Factory review evidence rejected/);
  const orphan=clean();orphan.finding_state.still_open=['ghost'];
  assert.throws(()=>evaluateCandidateReview(orphan,EXPECTED),/Factory review evidence rejected/);
});

test('only resolved or dismissed findings can be absent from the open inventory', () => {
  const value=clean();
  value.findings=[{id:'r',category:'Correctness',action_level:'informational',title:'resolved'},{id:'d',category:'Correctness',action_level:'informational',title:'dismissed'}];
  value.finding_state.resolved=['r'];value.finding_state.dismissed=['d'];
  assert.equal(evaluateCandidateReview(value,EXPECTED).status,'approved');
  const missing=clean();missing.findings=undefined;
  assert.throws(()=>evaluateCandidateReview(missing,EXPECTED),/Factory review evidence rejected/);
});

test('candidate review runs on a named local branch so Qodo can build a finding inventory', async () => {
  const { candidateCheckoutCommands } = await import('../../internal/factory-worker/review.mjs');
  const commands = candidateCheckoutCommands('/r', EXPECTED.baseSha, EXPECTED.candidateDigest);
  assert.deepEqual(commands[0], ['-C', '/r', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', EXPECTED.baseSha]);
  assert.deepEqual(commands[1], ['-C', '/r', '-c', 'core.hooksPath=/dev/null', 'switch', '--create', `factory-candidate-${EXPECTED.candidateDigest.slice(0, 16)}`]);
  assert.throws(() => candidateCheckoutCommands('/r', 'main', EXPECTED.candidateDigest), /rejected/);
  assert.throws(() => candidateCheckoutCommands('/r', EXPECTED.baseSha, 'not-a-digest'), /rejected/);
});

test('the review clone applies edits and planned deletions, staging both, and refuses symlinks', async () => {
  const { applyCandidateFiles } = await import('../../internal/factory-worker/review.mjs');
  const { mkdtemp, writeFile, symlink, readFile, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'mellon-review-apply-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = async args => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env, timeout: 20000 }).trim();
  await git(['init', '-q']);
  await writeFile(join(root, 'README.md'), 'base\n');
  await writeFile(join(root, 'old.md'), 'old\n');
  await git(['add', '.']); await git(['commit', '-q', '-m', 'base']);
  await applyCandidateFiles(root, [{ path: 'README.md', content: 'new\n' }, { path: 'old.md', deleted: true }, { path: 'docs/added.md', content: 'added\n' }], git);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'new\n');
  await assert.rejects(access(join(root, 'old.md')));
  assert.deepEqual((await git(['diff', '--cached', '--name-status'])).split('\n').sort(), ['A\tdocs/added.md', 'D\told.md', 'M\tREADME.md']);
  await symlink('/etc/hostname', join(root, 'link.md'));
  await assert.rejects(applyCandidateFiles(root, [{ path: 'link.md', content: 'x\n' }], git), /rejected/);
  await assert.rejects(applyCandidateFiles(root, [{ path: 'link.md', deleted: true }], git), /rejected/);
  await assert.rejects(applyCandidateFiles(root, [{ path: 'missing.md', deleted: true }], git), /rejected/);
});
