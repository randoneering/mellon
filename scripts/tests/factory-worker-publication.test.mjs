import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GENERATED_PATHS, selectGeneratedChanges } from '../../internal/factory-worker/publication.mjs';
import { reconcileGeneratedWrite, gitBlobSha } from '../../internal/factory-worker/publication.mjs';

const SOURCE='a'.repeat(40);
const blob=text=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
function fixture(){return{additions:GENERATED_PATHS.map(path=>({path,contents:Buffer.from('abc').toString('base64')})),tree:{truncated:false,tree:GENERATED_PATHS.map(path=>({path,type:'blob',sha:blob('abc')}))},sourceSha:SOURCE,treeSourceSha:SOURCE};}

test('all19 validated identical generated files skip the publication mutation',()=>{
  const r=selectGeneratedChanges(fixture());
  assert.equal(r.noOp,true);assert.equal(r.unchangedCount,19);assert.equal(r.batches.length,0);
});
test('only changed generated files enter separate bounded signed-commit batches',()=>{
  const f=fixture();f.additions[0].contents=Buffer.from('changed').toString('base64');f.additions[1].contents=Buffer.from('different').toString('base64');
  const r=selectGeneratedChanges(f);assert.equal(r.noOp,false);assert.equal(r.batches.length,2);
  assert.equal(r.batches.every(batch=>batch.length===1),true);
  assert.deepEqual(r.changedPaths,[GENERATED_PATHS[0],GENERATED_PATHS[1]]);
});
for(const change of [
  f=>{f.treeSourceSha='b'.repeat(40);},f=>{f.tree.truncated=true;},
  f=>{f.additions.pop();},f=>{f.additions[0].path='.github/workflows/unsafe.yml';},
  f=>{f.additions[0].contents='not base64';},f=>{f.tree.tree.push(f.tree.tree[0]);},
]){
  test('publication refuses mixed identity, incomplete inventory or unsafe generated content',()=>{
    const f=fixture();change(f);assert.throws(()=>selectGeneratedChanges(f),/Generated publication input rejected/);
  });
}

const HEAD0 = 'a'.repeat(40), HEAD1 = 'b'.repeat(40);
const GEN_BLOB = gitBlobSha(Buffer.from('generated\n'));
const headCommitFor = (over = {}) => ({ sha: HEAD1, parents: [{ sha: HEAD0 }], commit: { message: 'build(mellon): regenerate dist/index.mjs for #7', verification: { verified: true } }, files: [{ filename: 'dist/index.mjs', status: 'modified', sha: GEN_BLOB }], ...over });
const RECONCILE = { recordedHead: HEAD0, path: 'dist/index.mjs', blobSha: GEN_BLOB, message: 'build(mellon): regenerate dist/index.mjs for #7' };

test('git GEN_BLOB ids match git hash-object', async () => {
  const { execFileSync } = await import('node:child_process');
  assert.equal(gitBlobSha(Buffer.from('generated\n')), execFileSync('git', ['hash-object', '--stdin'], { input: 'generated\n', encoding: 'utf8' }).trim());
});

test('an unmoved branch head means commit next, naming the recorded head', () => {
  assert.deepEqual(reconcileGeneratedWrite({ ...RECONCILE, branchHead: HEAD0 }), { action: 'commit', expectedHead: HEAD0 });
});

test('a head one step ahead with exactly our signed single-file commit is recorded, not rewritten', () => {
  assert.deepEqual(reconcileGeneratedWrite({ ...RECONCILE, branchHead: HEAD1, headCommit: headCommitFor() }), { action: 'record', headSha: HEAD1 });
});

for (const [label, over] of [
  ['an unsigned commit', { commit: { message: RECONCILE.message, verification: { verified: false } } }],
  ['another parent', { parents: [{ sha: 'c'.repeat(40) }] }],
  ['a merge', { parents: [{ sha: HEAD0 }, { sha: 'c'.repeat(40) }] }],
  ['another message', { commit: { message: 'fix: something else', verification: { verified: true } } }],
  ['other files', { files: [{ filename: 'dist/index.mjs', status: 'modified', sha: GEN_BLOB }, { filename: 'src/a.mjs', status: 'modified', sha: GEN_BLOB }] }],
  ['other content', { files: [{ filename: 'dist/index.mjs', status: 'modified', sha: 'f'.repeat(40) }] }],
  ['a commit for another head', { sha: 'd'.repeat(40) }],
]) {
  test(`a moved head with ${label} blocks for the owner`, () => {
    const result = reconcileGeneratedWrite({ ...RECONCILE, branchHead: HEAD1, headCommit: headCommitFor(over) });
    assert.equal(result.action, 'block');
    assert.equal(typeof result.reason, 'string');
  });
}

test('reconciliation refuses malformed input', () => {
  for (const input of [{ ...RECONCILE, branchHead: 'zz' }, { ...RECONCILE, recordedHead: undefined, branchHead: HEAD0 }, { ...RECONCILE, path: 'src/a.mjs', branchHead: HEAD0 }, { ...RECONCILE, blobSha: 'x', branchHead: HEAD0 }]) {
    assert.equal(reconcileGeneratedWrite(input).action, 'block');
  }
});
