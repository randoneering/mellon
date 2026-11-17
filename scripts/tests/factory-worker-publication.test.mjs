import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GENERATED_PATHS, selectGeneratedChanges } from '../../internal/factory-worker/publication.mjs';

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
