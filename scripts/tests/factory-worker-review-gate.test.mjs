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
