import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createControlServer, fixMessage } from '../../internal/factory-worker/control.mjs';

const SECRET = 'a'.repeat(64);
const JOB = { jobId: '12345678-1234-4234-8234-123456789abc', issueNumber: 123, baseSha: 'b'.repeat(40), planSha256: 'c'.repeat(64), task: 'Only the approved file.', allowedPaths: ['tests/unit/personalized-terminal-controls.test.mjs'] };
const MODEL = 'openai-codex/gpt-6.1-sol';

const RELAY = { relayId: 'e'.repeat(64), relayHost: 'mellon-factory-relay-0123456789ab', assessmentSecret: 'b'.repeat(64) };
const GRANT = 'f'.repeat(32);
// Default relay behavior for tests that exercise other controller stages.
function withRelay(run, relayLog = [], relayRun) {
  if (typeof run !== 'function') return run;
  return async (args, input) => {
    const custom = relayRun ? await relayRun(args, input) : undefined;
    if (custom) return custom;
    if (args[1] === RELAY.relayId && args.includes('/opt/bootstrap/relay.mjs')) {
      relayLog.push(args.slice(4));
      if (args[4] === 'issue') return { status: 0, stdout: JSON.stringify({ grantId: GRANT, capability: 'a.b.c', expiresAt: Date.now() + 60000 }) };
      if (args[4] === 'revoke') return { status: 0, stdout: '{"revoked":true}' };
    }
    if (args[0] === 'start' && args[1] === 'd'.repeat(64)) { relayLog.push(['worker-start']); return { status: 0, stdout: args[1] }; }
    if (args[0] === 'exec' && String(args.at(-1)).includes('mellon-t3-ready')) { relayLog.push(['t3-ready']); return { status: 0, stdout: 'mellon-t3-ready' }; }
    if (args[0] === 'exec' && args[2] === 'git') {
      let rest = args.slice(5);
      while (rest[0] === '-c') rest = rest.slice(2);
      relayLog.push(['git', ...rest]);
      if (args.includes('rev-parse')) return { status: 0, stdout: JOB.baseSha };
      return { status: 0, stdout: '' };
    }
    if (args.includes('-e') && String(args.at(-1)).includes('mellon-capability')) {
      relayLog.push(['install', input]);
      return { status: 0, stdout: '{"installed":"mellon-capability"}' };
    }
    return run(args, input);
  };
}

async function running(config, run, review, relayLog, relayRun) {
  const server = createControlServer({ ...RELAY, ...config }, withRelay(run, relayLog, relayRun), review);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const post = (url, body, secret = SECRET) => fetch(url+'/jobs', { method: 'POST', headers: { authorization: 'Bearer '+secret, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('private controller rejects missing authorization before executing anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-http-'));
  let calls = 0;
  const app = await running({ workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir }, () => { calls++; throw new Error('Should not execute.'); });
  try {
    const response = await post(app.url, JOB, 'wrong');
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally { await stop(app.server); }
});

test('corrupt private journal fails closed without exposing data or executing a job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-corrupt-'));
  await writeFile(join(dir, JOB.jobId+'.json'), '{private-journal-canary');
  let calls = 0;
  const app = await running({ workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir }, () => { calls++; throw new Error('Should not execute.'); });
  try {
    const response = await post(app.url, JOB);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('private-journal-canary'), false);
    assert.equal(calls, 0);
  } finally { await stop(app.server); }
});

test('the bounded job deadline stops only its configured worker and records the failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-deadline-'));
  const calls = [];
  const workerId = 'd'.repeat(64);
  const app = await running({ workerId,projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir,maxJobMs:20 }, async args => {
    calls.push(args);
    if (args[0] === 'stop') return { status:0,stdout:workerId };
    return { status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}}) };
  });
  try {
    assert.equal((await post(app.url, JOB)).status, 202);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(calls.find(a => a[0] === 'stop'), ['stop', '--time', '15', workerId]);
  } finally { await stop(app.server); }
});

test('only independently reviewed candidate data becomes a ready proposal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-review-'));
  const path = 'tests/unit/personalized-terminal-controls.test.mjs';
  let reviewedDigest;
  const run = async args => {
    if (args.includes('start')) return { status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}}) };
    if (args.includes('show')) return {status:0,stdout:JSON.stringify({thread:{threadId:'thread-id',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'completed',activeRunId:null,latestRunId:'run-id',pendingRequestCount:0},recentRuns:[{runId:'run-id',status:'completed'}],items:[{text:'all tests passed - untrusted claim'}]})};
    return {status:0,stdout:JSON.stringify({baseSha:JOB.baseSha,files:[{path,content:'test fixture\n'}]})};
  };
  const review = async candidate => { reviewedDigest=candidate.digest;return {status:'approved',candidateDigest:candidate.digest,reviewRunId:'actual-review-id',coverageComplete:true,findingInventoryComplete:true,findings:[]}; };
  const app = await running({ workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir,allowedPaths:[path],reviewDir:dir },run,review);
  try {
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,20));
    await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}});
    await new Promise(resolve=>setTimeout(resolve,40));
    const proposal=await fetch(app.url+'/jobs/'+JOB.jobId+'/proposal',{headers:{authorization:'Bearer '+SECRET}});
    assert.equal(proposal.status,200);
    const value=await proposal.json();
    assert.equal(value.structuredOutput.status,'ready');
    assert.equal(value.review.reviewRunId,'actual-review-id');
    assert.equal(value.review.candidateDigest,reviewedDigest);
    assert.equal(JSON.stringify(value).includes('untrusted claim'),false);
  } finally {await stop(app.server);}
});

test('a saved launching job reconciles by unique title without launching twice', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-launch-recovery-'));
  const digest=createHash('sha256').update(JSON.stringify(JOB)).digest('hex');
  await writeFile(join(dir,JOB.jobId+'.json'),JSON.stringify({...JOB,digest,state:'launching',stage:'t3_launch',createdAt:Date.now()}));
  let starts=0;
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,completionPollMs:10,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir},async args=>{
    if(args.includes('start'))starts++;
    if(args.includes('list'))return{status:0,stdout:JSON.stringify([{threadId:'recovered-thread',projectId:'project-id',title:'factory '+JOB.jobId,providerInstanceId:'pi',model:MODEL}])};
    return{status:0,stdout:JSON.stringify({thread:{threadId:'recovered-thread',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'running',activeRunId:'run-id',latestRunId:'run-id',pendingRequestCount:0},recentRuns:[],items:[]})};
  });
  try{
    const deadline = Date.now() + 5000;
    while (!JSON.parse(await readFile(join(dir, JOB.jobId+'.json'))).threadId) {
      assert.ok(Date.now() < deadline, 'background reconciliation should discover the thread');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const response=await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}});
    const value=await response.json();
    assert.equal(value.threadId,'recovered-thread');assert.equal(starts,0);
  }finally{await stop(app.server);}
});

test('an expired job cannot become approved when its review finishes late', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-review-fence-'));
  const path='tests/unit/personalized-terminal-controls.test.mjs';
  let finishReview;
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir,allowedPaths:[path],reviewDir:dir,maxJobMs:80},async args=>{
    if(args[0]==='stop')return{status:0,stdout:'stopped'};
    if(args.includes('start'))return{status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}})};
    if(args.includes('show'))return{status:0,stdout:JSON.stringify({thread:{threadId:'thread-id',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'completed',activeRunId:null,latestRunId:'run-id',pendingRequestCount:0},recentRuns:[{runId:'run-id',status:'completed'}],items:[]})};
    return{status:0,stdout:JSON.stringify({baseSha:JOB.baseSha,files:[{path,content:'fixture\n'}]})};
  },candidate=>new Promise(resolve=>{finishReview=()=>resolve({status:'approved',candidateDigest:candidate.digest,coverageComplete:true,findingInventoryComplete:true,findings:[]});}));
  try{
    await post(app.url,JOB);await new Promise(resolve=>setTimeout(resolve,10));
    await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}});
    await new Promise(resolve=>setTimeout(resolve,120));
    finishReview();await new Promise(resolve=>setTimeout(resolve,30));
    const response=await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}});
    const value=await response.json();assert.equal(value.state,'blocked');assert.equal(value.stage,'job_deadline');
  }finally{await stop(app.server);}
});

test('a status poll cannot reconcile or block a locally in-flight launch', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-inflight-'));
  let finish;
  let lists=0;
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir},async args=>{
    if(args.includes('start'))return new Promise(resolve=>{finish=()=>resolve({status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}})});});
    if(args.includes('list')){lists++;return{status:0,stdout:'[]'};}
    return{status:0,stdout:JSON.stringify({thread:{threadId:'thread-id',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'running',activeRunId:'run-id',latestRunId:'run-id',pendingRequestCount:0},recentRuns:[],items:[]})};
  });
  try{
    await post(app.url,JOB);
    const poll=await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}});
    const value=await poll.json();assert.equal(value.state,'launching');assert.equal(lists,0);
    while(!finish)await new Promise(resolve=>setTimeout(resolve,2));
    finish();await new Promise(resolve=>setTimeout(resolve,20));
  }finally{finish?.();await stop(app.server);}
});

test('a failed initial journal write does not strand an unlaunched job in memory', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-write-failure-'));
  let starts=0;
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir},async args=>{
    if(args.includes('start'))starts++;
    return{status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}})};
  });
  try{
    await new Promise(resolve=>setTimeout(resolve,10));
    await chmod(dir,0o500);
    assert.equal((await post(app.url,JOB)).status,503);
    assert.equal(starts,0);
    await chmod(dir,0o700);
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(starts,1);
  }finally{await chmod(dir,0o700);await stop(app.server);}
});

test('persistent job identity prevents duplicate launches after a controller restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-restart-'));
  const config = { workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir };
  let starts = 0;
  const run = async args => {
    if (args.includes('start')) { starts++; return { status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}}) }; }
    throw new Error('Unexpected controller command.');
  };
  let app = await running(config, run);
  try {
    assert.equal((await post(app.url, JOB)).status, 202);
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { await stop(app.server); }
  app = await running(config, run);
  try {
    assert.equal((await post(app.url, JOB)).status, 200);
    assert.equal(starts, 1);
    const second = { ...JOB, jobId:'22345678-1234-4234-8234-123456789abc' };
    assert.equal((await post(app.url, second)).status, 409);
  } finally { await stop(app.server); }
});

test('a later completed run on the same thread never satisfies the launched pilot run', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-run-fence-'));
  let exported=0;
  const run=async args=>{
    if (args[0] === 'stop') return { status: 0, stdout: '' };
    if(args.includes('start'))return{status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}})};
    if(args.includes('show'))return{status:0,stdout:JSON.stringify({thread:{threadId:'thread-id',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'completed',activeRunId:null,latestRunId:'later-run',pendingRequestCount:0},recentRuns:[{runId:'later-run',status:'completed'},{runId:'run-id',status:'completed'}],items:[]})};
    exported++;return{status:1,stdout:''};
  };
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir},run);
  try{
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,20));
    const value=await (await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}})).json();
    assert.equal(value.state,'blocked');assert.equal(value.stage,'t3_run_mismatch');assert.equal(exported,0);
  }finally{await stop(app.server);}
});

test('a reconciled thread without a launch run identity blocks instead of guessing', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-run-unknown-'));
  let exported=0;
  const run=async args=>{
    if (args[0] === 'stop') return { status: 0, stdout: '' };
    if(args.includes('start'))return{status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:null,modelSelection:{instanceId:'pi',model:MODEL}})};
    if(args.includes('show'))return{status:0,stdout:JSON.stringify({thread:{threadId:'thread-id',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'completed',activeRunId:null,latestRunId:'run-id',pendingRequestCount:0},recentRuns:[{runId:'run-id',status:'completed'}],items:[]})};
    exported++;return{status:1,stdout:''};
  };
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir},run);
  try{
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,20));
    const value=await (await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}})).json();
    assert.equal(value.state,'blocked');assert.equal(value.stage,'t3_run_unconfirmed');assert.equal(exported,0);
  }finally{await stop(app.server);}
});

test('the job grant is installed through stdin before launch and revoked before candidate export', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-relay-order-'));
  const order=[];const log=[];
  const run=async(args,input)=>{
    if(args.includes('start')){order.push('launch');return{status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}})};}
    if(args.includes('show'))return{status:0,stdout:JSON.stringify({thread:{threadId:'thread-id',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'completed',activeRunId:null,latestRunId:'run-id',pendingRequestCount:0},recentRuns:[{runId:'run-id',status:'completed'}],items:[]})};
    order.push('export');return{status:1,stdout:''};
  };
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir,allowedPaths:['tests/unit/personalized-terminal-controls.test.mjs']},async(args,input)=>{const r=await run(args,input);log.push([order.at(-1)]);return r;},undefined,log);
  try{
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,20));
    await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}});
    await new Promise(resolve=>setTimeout(resolve,30));
    const seq=log.map(e=>e[0]).filter((x,i,a)=>['issue','install','revoke','launch','export'].includes(x)&&a.indexOf(x)===i);
    assert.deepEqual(seq,['issue','install','launch','revoke','export']);
    const install=log.find(entry=>entry[0]==='install');
    assert.equal(JSON.parse(install[1]).apiKey,'a.b.c');
    assert.equal(JSON.parse(install[1]).baseUrl,'http://mellon-factory-relay-0123456789ab:8790/backend-api');
    const issueAt=log.findIndex(e=>e[0]==='issue'),revokeAt=log.findIndex(e=>e[0]==='revoke');
    assert.ok(issueAt>=0&&revokeAt>issueAt);
    assert.deepEqual(log[revokeAt],['revoke',GRANT]);
  }finally{await stop(app.server);}
});

test('an unconfirmed revocation blocks export so worker data never leaves with a live grant', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-relay-revoke-'));
  let exported=0;
  const run=async args=>{
    if(args.includes('start'))return{status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}})};
    if(args.includes('show'))return{status:0,stdout:JSON.stringify({thread:{threadId:'thread-id',projectId:'project-id',providerInstanceId:'pi',model:MODEL,status:'completed',activeRunId:null,latestRunId:'run-id',pendingRequestCount:0},recentRuns:[{runId:'run-id',status:'completed'}],items:[]})};
    exported++;return{status:1,stdout:''};
  };
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir,allowedPaths:['tests/unit/personalized-terminal-controls.test.mjs']},run,undefined,undefined,async args=>args.includes('/opt/bootstrap/relay.mjs')&&args[4]==='revoke'?{status:1,stdout:''}:undefined);
  try{
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,20));
    await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}});
    await new Promise(resolve=>setTimeout(resolve,30));
    const value=await (await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}})).json();
    assert.equal(value.state,'blocked');assert.equal(value.stage,'relay_revoke_unconfirmed');assert.equal(exported,0);
    assert.equal(value.cleanupUnconfirmed, true);
    assert.equal((await post(app.url, { ...JOB, jobId: JOB2.jobId })).status, 409);
  }finally{await stop(app.server);}
});

test('a failed grant issue never launches a coding run', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-relay-issue-'));
  let starts=0;
  const run=async args=>{
    if(args.includes('start'))starts++;
    return{status:0,stdout:JSON.stringify({threadId:'thread-id',projectId:'project-id',runId:'run-id',modelSelection:{instanceId:'pi',model:MODEL}})};
  };
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir},run,undefined,undefined,async args=>args.includes('/opt/bootstrap/relay.mjs')&&args[4]==='issue'?{status:1,stdout:''}:undefined);
  try{
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,20));
    const value=await (await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}})).json();
    assert.equal(value.state,'blocked');assert.equal(value.stage,'relay_grant_failed');assert.equal(starts,0);
  }finally{await stop(app.server);}
});

test('the controller refuses to start without a separate relay', () => {
  for(const relay of [{relayId:undefined},{relayId:'d'.repeat(64)},{relayHost:'other-host'}]){
    assert.throws(()=>createControlServer({workerId:'d'.repeat(64),projectId:'p',model:MODEL,secret:SECRET,issueNumber:1,baseSha:JOB.baseSha,storeDir:'/tmp/x',...RELAY,...relay}),/Controller configuration rejected/);
  }
});

test('an uncertain launch that reconciliation blocks also revokes its grant', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-uncertain-revoke-'));
  const log=[];
  const run=async args=>{
    if(args.includes('start'))return{status:1,stdout:''};
    if(args.includes('list'))return{status:0,stdout:'[]'};
    return{status:1,stdout:''};
  };
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir},run,undefined,log);
  try{
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,30));
    const value=await (await fetch(app.url+'/jobs/'+JOB.jobId,{headers:{authorization:'Bearer '+SECRET}})).json();
    assert.equal(value.state,'blocked');assert.equal(value.stage,'t3_launch_uncertain');
    assert.deepEqual(log.filter(e=>e[0]==='revoke'),[['revoke',GRANT]]);
  }finally{await stop(app.server);}
});

test('a grant that lands after the job deadline is revoked and never launched', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mellon-control-late-grant-'));
  const log=[];let starts=0;
  const run=async args=>{ if(args.includes('start'))starts++; return{status:0,stdout:'d'.repeat(64)}; };
  const slowIssue=async args=>{
    if(args.includes('/opt/bootstrap/relay.mjs')&&args[4]==='issue'){
      await new Promise(resolve=>setTimeout(resolve,60));
      log.push(['issue']);
      return{status:0,stdout:JSON.stringify({grantId:GRANT,capability:'a.b.c',expiresAt:Date.now()+60000})};
    }
    return undefined;
  };
  const app=await running({workerId:'d'.repeat(64),projectId:'project-id',model:MODEL,secret:SECRET,issueNumber:123,baseSha:JOB.baseSha,storeDir:dir,maxJobMs:20},run,undefined,log,slowIssue);
  try{
    assert.equal((await post(app.url,JOB)).status,202);
    await new Promise(resolve=>setTimeout(resolve,140));
    assert.equal(starts,0);
    assert.deepEqual(log.filter(e=>e[0]==='revoke'),[['revoke',GRANT]]);
  }finally{await stop(app.server);}
});

const firstRun = id => `run:thread:${encodeURIComponent(id)}:ordinal:1`;
function startWithoutRunId(show, exported) {
  return async args => {
    if (args[0] === 'stop') return { status: 0, stdout: '' };
    if (args.includes('start')) return { status: 0, stdout: JSON.stringify({ threadId: 'mcp:thread-id', projectId: 'project-id', runId: null }) };
    if (args.includes('show')) return { status: 0, stdout: JSON.stringify({ thread: { threadId: 'mcp:thread-id', projectId: 'project-id', providerInstanceId: 'pi', model: MODEL, status: 'completed', activeRunId: null, pendingRequestCount: 0, ...show }, recentRuns: [{ runId: show.latestRunId, status: 'completed' }], items: [] }) };
    exported.count++; return { status: 1, stdout: '' };
  };
}
async function pollOnce(show) {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-first-run-'));
  const exported = { count: 0 };
  const app = await running({ workerId: 'd'.repeat(64), projectId: 'project-id', model: MODEL, secret: SECRET, issueNumber: 123, baseSha: JOB.baseSha, storeDir: dir, allowedPaths: ['tests/unit/personalized-terminal-controls.test.mjs'] }, startWithoutRunId(show, exported));
  try {
    assert.equal((await post(app.url, JOB)).status, 202);
    await new Promise(resolve => setTimeout(resolve, 20));
    await fetch(app.url + '/jobs/' + JOB.jobId, { headers: { authorization: 'Bearer ' + SECRET } });
    await new Promise(resolve => setTimeout(resolve, 30));
    const value = await (await fetch(app.url + '/jobs/' + JOB.jobId, { headers: { authorization: 'Bearer ' + SECRET } })).json();
    return { value, exported: exported.count };
  } finally { await stop(app.server); }
}

test('a thread this controller started binds to its first and only run when T3 omits the run id', async () => {
  const { value, exported } = await pollOnce({ runCount: 1, latestRunId: firstRun('mcp:thread-id') });
  assert.equal(exported, 1);
  assert.notEqual(value.stage, 't3_run_unconfirmed');
});

for (const [label, show] of [
  ['a second run', { runCount: 2, latestRunId: `run:thread:${encodeURIComponent('mcp:thread-id')}:ordinal:2` }],
  ['a missing run count', { latestRunId: firstRun('mcp:thread-id') }],
  ['a first run of another thread', { runCount: 1, latestRunId: firstRun('mcp:other-thread') }],
  ['a non-first ordinal with one run', { runCount: 1, latestRunId: `run:thread:${encodeURIComponent('mcp:thread-id')}:ordinal:2` }],
]) {
  test(`without a launch run id, ${label} blocks instead of binding`, async () => {
    const { value, exported } = await pollOnce(show);
    assert.equal(value.state, 'blocked');
    assert.equal(value.stage, 't3_run_unconfirmed');
    assert.equal(exported, 0);
  });
}

// Observed from pinned T3 0.1.5: `t3 thread start --json` prints only these fields.
const REAL_START = { threadId: 'mcp:real-thread', projectId: 'project-id', runId: `run:thread:${encodeURIComponent('mcp:real-thread')}:ordinal:1` };
async function launchWith(startOutput) {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-real-start-'));
  let lists = 0;
  const run = async args => {
    if (args.includes('start')) return { status: 0, stdout: JSON.stringify(startOutput) };
    if (args.includes('list')) { lists++; return { status: 0, stdout: '[]' }; }
    return { status: 0, stdout: JSON.stringify({ thread: { threadId: startOutput.threadId, projectId: 'project-id', providerInstanceId: 'pi', model: MODEL, status: 'running', activeRunId: REAL_START.runId, latestRunId: REAL_START.runId, runCount: 1, pendingRequestCount: 0 }, recentRuns: [], items: [] }) };
  };
  const app = await running({ workerId: 'd'.repeat(64), projectId: 'project-id', model: MODEL, secret: SECRET, issueNumber: 123, baseSha: JOB.baseSha, storeDir: dir }, run);
  try {
    assert.equal((await post(app.url, JOB)).status, 202);
    await new Promise(resolve => setTimeout(resolve, 20));
    const value = await (await fetch(app.url + '/jobs/' + JOB.jobId, { headers: { authorization: 'Bearer ' + SECRET } })).json();
    const journal = JSON.parse(await readFile(join(dir, JOB.jobId + '.json'), 'utf8'));
    return { value, journal, lists };
  } finally { await stop(app.server); }
}

test('the real T3 start output binds the exact returned run without reconciliation', async () => {
  const { value, journal, lists } = await launchWith(REAL_START);
  assert.equal(value.state, 'running');
  assert.equal(journal.runId, REAL_START.runId);
  assert.equal(journal.threadSource, 'start');
  assert.equal(lists, 0);
});

test('a start result for another project is not accepted as this job', async () => {
  const { value, journal } = await launchWith({ ...REAL_START, projectId: 'other-project' });
  assert.equal(value.state, 'blocked');
  assert.equal(journal.runId ?? null, null);
});

// Observed from pinned T3 0.1.5: `t3 thread show --json` prints {thread, messages}, no recentRuns.
test('the real T3 show output completes the exact launched run and starts review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-real-show-'));
  let exported = 0;
  const run = async args => {
    if (args.includes('start')) return { status: 0, stdout: JSON.stringify(REAL_START) };
    if (args.includes('show')) return { status: 0, stdout: JSON.stringify({ thread: { threadId: REAL_START.threadId, projectId: 'project-id', providerInstanceId: 'pi', model: MODEL, status: 'completed', activeRunId: null, latestRunId: REAL_START.runId, runCount: 1, pendingRequestCount: 0, settled: false }, messages: [{ text: 'untrusted' }] }) };
    exported++; return { status: 1, stdout: '' };
  };
  const app = await running({ workerId: 'd'.repeat(64), projectId: 'project-id', model: MODEL, secret: SECRET, issueNumber: 123, baseSha: JOB.baseSha, storeDir: dir, allowedPaths: ['tests/unit/personalized-terminal-controls.test.mjs'] }, run);
  try {
    assert.equal((await post(app.url, JOB)).status, 202);
    const deadline = Date.now() + 5000;
    let state;
    do {
      state = await (await call(app.url, '/jobs/' + JOB.jobId)).json();
      if (state.state === 'blocked') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(state.stage, 'candidate_or_review_unconfirmed');
    assert.equal(exported, 1);
  } finally { await stop(app.server); }
});

// Fix loop: a T3 0.1.5 emulator. `thread send --json` prints
// {threadId, messageId, runId, status, delivery}; show reflects the current run.
function t3Emulator({ sendResult, contents = ['first\n', 'second\n'], sendStatus = 0 } = {}) {
  const state = { run: REAL_START.runId, sends: [], exports: 0 };
  const run = async (args, input) => {
    if (args.includes('start')) return { status: 0, stdout: JSON.stringify(REAL_START) };
    if (args.includes('send')) {
      state.sends.push({ args, input });
      if (sendStatus !== 0) return { status: sendStatus, stdout: '' };
      const sent = sendResult ?? { threadId: REAL_START.threadId, messageId: 'message-2', runId: `run:thread:${encodeURIComponent(REAL_START.threadId)}:ordinal:2`, status: 'running', delivery: 'started' };
      state.run = sent.runId;
      return { status: 0, stdout: JSON.stringify(sent) };
    }
    if (args.includes('show')) return { status: 0, stdout: JSON.stringify({ thread: { threadId: REAL_START.threadId, projectId: 'project-id', providerInstanceId: 'pi', model: MODEL, status: 'completed', activeRunId: null, latestRunId: state.run, runCount: state.sends.length + 1, pendingRequestCount: 0 }, messages: [] }) };
    const content = contents[Math.min(state.exports, contents.length - 1)];
    state.exports++;
    return { status: 0, stdout: JSON.stringify({ baseSha: JOB.baseSha, files: [{ path: 'tests/unit/personalized-terminal-controls.test.mjs', content }] }) };
  };
  return { state, run };
}
const FINDING = { id: 'finding-1', title: 'C1 OSC untested', reportedCategory: 'Reliability', reportedSeverity: 'Medium', reportedActionLevel: 'informational', location: { file_path: 'tests/unit/personalized-terminal-controls.test.mjs', start_line: 90 } };
const reviewSequence = statuses => {
  const calls = [];
  const fn = async candidate => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push(candidate.digest);
    return { status, candidateDigest: candidate.digest, reviewRunId: `review-${calls.length}`, coverageComplete: true, findingInventoryComplete: true, findings: status === 'approved' ? [] : [FINDING] };
  };
  return { calls, fn };
};
async function fixLoop(emulator, reviewer, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-fix-'));
  const log = [];
  const app = await running({ workerId: 'd'.repeat(64), projectId: 'project-id', model: MODEL, secret: SECRET, issueNumber: 123, baseSha: JOB.baseSha, storeDir: dir, allowedPaths: ['tests/unit/personalized-terminal-controls.test.mjs'], ...extra }, emulator.run, reviewer.fn, log);
  const poll = async () => (await fetch(app.url + '/jobs/' + JOB.jobId, { headers: { authorization: 'Bearer ' + SECRET } })).json();
  try {
    assert.equal((await post(app.url, JOB)).status, 202);
    let value;
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 15));
      value = await poll();
      if (['approved', 'blocked', 'awaiting_assessment'].includes(value.state)) break;
    }
    const journal = JSON.parse(await readFile(join(dir, JOB.jobId + '.json'), 'utf8'));
    return { value, journal, log };
  } finally { await stop(app.server); }
}

test('open findings go back to the same thread once, and the fixed candidate is reviewed again', async () => {
  const emulator = t3Emulator();
  const reviewer = reviewSequence(['awaiting_assessment', 'approved']);
  const { value, journal, log } = await fixLoop(emulator, reviewer);
  assert.equal(value.state, 'approved');
  assert.equal(emulator.state.sends.length, 1);
  assert.deepEqual(emulator.state.sends[0].args.slice(-6, -3), ['send', REAL_START.threadId, '-']);
  assert.match(emulator.state.sends[0].input, /C1 OSC untested/);
  assert.match(emulator.state.sends[0].input, /tests\/unit\/personalized-terminal-controls\.test\.mjs/);
  assert.equal(reviewer.calls.length, 2);
  assert.notEqual(reviewer.calls[0], reviewer.calls[1]);
  assert.equal(journal.runId, emulator.state.run);
  assert.equal(journal.fixRounds, 1);
  assert.equal(value.fixRounds, 1);
  // Each model session gets its own grant, revoked before every export.
  assert.equal(log.filter(e => e[0] === 'issue').length, 2);
  assert.equal(log.filter(e => e[0] === 'revoke').length >= 2, true);
});

test('fix rounds are bounded; remaining findings pause for owner assessment', async () => {
  const emulator = t3Emulator({ contents: ['first\n', 'second\n', 'third\n'] });
  const reviewer = reviewSequence(['awaiting_assessment']);
  const { value } = await fixLoop(emulator, reviewer, { maxFixRounds: 1 });
  assert.equal(value.state, 'awaiting_assessment');
  assert.equal(emulator.state.sends.length, 1);
  assert.equal(reviewer.calls.length, 2);
});

test('a fix run that leaves the candidate unchanged pauses without another review', async () => {
  const emulator = t3Emulator({ contents: ['same\n'] });
  const reviewer = reviewSequence(['awaiting_assessment']);
  const { value } = await fixLoop(emulator, reviewer);
  assert.equal(value.state, 'awaiting_assessment');
  assert.equal(value.stage, 'review_no_progress');
  assert.equal(reviewer.calls.length, 1);
});

for (const [label, options] of [
  ['a failed send', { sendStatus: 1 }],
  ['a send for another thread', { sendResult: { threadId: 'mcp:other', messageId: 'm', runId: 'run-x', status: 'running', delivery: 'started' } }],
  ['a send that reuses the reviewed run', { sendResult: { threadId: REAL_START.threadId, messageId: 'm', runId: REAL_START.runId, status: 'running', delivery: 'started' } }],
  ['a send that steered or restarted a run', { sendResult: { threadId: REAL_START.threadId, messageId: 'm', runId: 'run-y', status: 'running', delivery: 'restarted' } }],
]) {
  test(`${label} blocks the fix loop without resending and revokes its grant`, async () => {
    const emulator = t3Emulator(options);
    const reviewer = reviewSequence(['awaiting_assessment', 'approved']);
    const { value, log } = await fixLoop(emulator, reviewer);
    assert.equal(value.state, 'blocked');
    assert.equal(value.stage, 't3_fix_uncertain');
    assert.equal(emulator.state.sends.length, 1);
    assert.equal(reviewer.calls.length, 1);
    const issues = log.filter(e => e[0] === 'issue').length;
    assert.equal(log.filter(e => e[0] === 'revoke').length >= issues, true);
  });
}

test('the fix round budget must be a small explicit integer', () => {
  for (const maxFixRounds of [-1, 4, 1.5, '2']) {
    assert.throws(() => createControlServer({ workerId: 'd'.repeat(64), projectId: 'p', model: MODEL, secret: SECRET, issueNumber: 1, baseSha: JOB.baseSha, storeDir: '/tmp/x', ...RELAY, maxFixRounds }), /Controller budget rejected/);
  }
});

// Owner assessment: a separate credential, an explicit window, and the review gate.
const OWNER = 'c'.repeat(64);
const FINDING_B = { ...FINDING, id: 'finding-2', title: 'Test name misdescribes input' };
const twoFindings = () => {
  const calls = [];
  const fn = async candidate => {
    calls.push(candidate.digest);
    const status = calls.length === 1 ? 'awaiting_assessment' : 'approved';
    return { status, candidateDigest: candidate.digest, reviewRunId: `review-${calls.length}`, coverageComplete: true, findingInventoryComplete: true, findings: status === 'approved' ? [] : [FINDING, FINDING_B] };
  };
  return { calls, fn };
};
async function paused(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-assess-'));
  const emulator = t3Emulator();
  const reviewer = options.reviewer ?? twoFindings();
  const log = [];
  const app = await running({ workerId: 'd'.repeat(64), projectId: 'project-id', model: MODEL, secret: SECRET, issueNumber: 123, baseSha: JOB.baseSha, storeDir: dir, allowedPaths: ['tests/unit/personalized-terminal-controls.test.mjs'], maxFixRounds: 0, assessmentSecret: OWNER, ...options.config }, emulator.run, reviewer.fn, log);
  t.after(() => stop(app.server));
  const get = async (path = '', secret = SECRET) => fetch(app.url + '/jobs/' + JOB.jobId + path, { headers: { authorization: 'Bearer ' + secret } });
  const assess = (body, secret = OWNER) => fetch(app.url + '/jobs/' + JOB.jobId + '/assessment', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const waitFor = async states => { let v; for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 15)); v = await (await get()).json(); if (states.includes(v.state)) return v; } return v; };
  assert.equal((await post(app.url, JOB)).status, 202);
  const value = await waitFor(['awaiting_assessment', 'blocked', 'approved']);
  assert.equal(value.state, 'awaiting_assessment');
  const body = (decision, ratings, extra = {}) => ({ decision, assessmentRunId: value.assessmentRunId, reviewRunId: value.review.reviewRunId, candidateDigest: value.review.candidateDigest, findings: [{ id: 'finding-1', ...ratings[0] }, { id: 'finding-2', ...ratings[1] }], ...extra });
  return { app, dir, emulator, reviewer, log, value, get, assess, waitFor, body };
}

test('a failed approval write leaves the proposal inaccessible and the decision retryable', async t => {
  const p = await paused(t);
  const approval = p.body('approve', [{ rating: 'low' }, { rating: 'low' }]);
  await chmod(p.dir, 0o500);
  try {
    assert.equal((await p.assess(approval)).status, 503);
    assert.equal((await p.get('/proposal')).status, 409);
  } finally { await chmod(p.dir, 0o700); }
  assert.equal((await p.assess(approval)).status, 200);
});

test('owner assessment needs its own credential; neither credential works for the other endpoint', async t => {
  const p = await paused(t);
  assert.equal((await p.assess(p.body('approve', [{ rating: 'low' }, { rating: 'low' }]), SECRET)).status, 401);
  assert.equal((await p.get('', OWNER)).status, 401);
  assert.equal((await p.get()).status, 200);
});

test('approve publishes only when every open finding is Low or Invalid with a reason, and keeps raw metadata', async t => {
  const p = await paused(t);
  for (const ratings of [
    [{ rating: 'low' }, { rating: 'medium' }],
    [{ rating: 'low' }, { rating: 'critical' }],
    [{ rating: 'low' }, { rating: 'invalid' }],
    [{ rating: 'low' }, { rating: 'invalid', note: '   ' }],
    [{ rating: 'low' }, { rating: 'unknown' }],
  ]) assert.equal((await p.assess(p.body('approve', ratings))).status, 422);
  assert.equal((await p.assess({ ...p.body('approve', [{ rating: 'low' }, { rating: 'low' }]), findings: [{ id: 'finding-1', rating: 'low' }] })).status, 422);
  assert.equal((await p.assess({ ...p.body('approve', [{ rating: 'low' }, { rating: 'low' }]), findings: [{ id: 'finding-1', rating: 'low' }, { id: 'finding-1', rating: 'low' }] })).status, 422);
  assert.equal((await p.assess(p.body('approve', [{ rating: 'low' }, { rating: 'low' }], { reviewRunId: 'stale' }))).status, 409);
  assert.equal((await p.assess(p.body('approve', [{ rating: 'low' }, { rating: 'low' }], { candidateDigest: 'e'.repeat(64) }))).status, 409);
  assert.equal((await p.get('/proposal')).status, 409);
  const ok = await p.assess(p.body('approve', [{ rating: 'low', note: 'cosmetic' }, { rating: 'invalid', note: 'Fixture has two ESC bytes.' }]));
  assert.equal(ok.status, 200);
  const proposal = await (await p.get('/proposal')).json();
  assert.equal(proposal.approval.source, 'owner_assessment');
  assert.deepEqual(proposal.approval.findings.map(f => [f.id, f.rating]), [['finding-1', 'low'], ['finding-2', 'invalid']]);
  assert.equal(proposal.review.findings[0].reportedActionLevel, 'informational');
  assert.equal(proposal.review.status, 'awaiting_assessment');
  assert.equal((await p.assess(p.body('approve', [{ rating: 'low' }, { rating: 'low' }]))).status, 409);
});

test('send back returns only the chosen findings to T3, then the fixed candidate is reviewed again', async t => {
  const p = await paused(t);
  assert.equal((await p.assess(p.body('fix', [{ rating: 'low' }, { rating: 'invalid', note: 'n/a' }]))).status, 422);
  const sent = await p.assess(p.body('fix', [{ rating: 'medium', fix: true, note: 'Cover U+009D too.' }, { rating: 'invalid', note: 'Wrong.' }]));
  assert.equal(sent.status, 202);
  const value = await p.waitFor(['approved', 'blocked', 'awaiting_assessment']);
  assert.equal(value.state, 'approved');
  assert.equal(p.emulator.state.sends.length, 1);
  assert.match(p.emulator.state.sends[0].input, /C1 OSC untested/);
  assert.match(p.emulator.state.sends[0].input, /Cover U\+009D too\./);
  assert.doesNotMatch(p.emulator.state.sends[0].input, /misdescribes/);
  assert.equal(p.reviewer.calls.length, 2);
  assert.equal(value.ownerFixRounds, 1);
  const proposal = await (await p.get('/proposal')).json();
  assert.equal(proposal.approval.source, 'independent_review');
});

test('a paused job outlives the coding deadline, gets a fresh lease to fix, and expires after its window', async t => {
  const p = await paused(t, { config: { maxJobMs: 60, assessmentWindowMs: 400 } });
  await new Promise(r => setTimeout(r, 90));
  assert.equal((await (await p.get()).json()).state, 'awaiting_assessment');
  assert.equal((await p.assess(p.body('fix', [{ rating: 'high', fix: true }, { rating: 'low' }]))).status, 202);
  await p.waitFor(['approved', 'blocked']);
  assert.equal(p.emulator.state.sends.length, 1);
  assert.ok(p.log.filter(e => e[0] === 'issue').length >= 2);
  const expiring = await paused(t, { config: { assessmentWindowMs: 40 } });
  await new Promise(r => setTimeout(r, 80));
  const expired = await (await expiring.get()).json();
  assert.equal(expired.state, 'blocked');
  assert.equal(expired.stage, 'assessment_expired');
  assert.equal((await expiring.assess(expiring.body('approve', [{ rating: 'low' }, { rating: 'low' }]))).status, 409);
});

test('owner send-backs are bounded separately from automatic fix rounds', async t => {
  const always = { calls: [], fn: async c => { always.calls.push(c.digest); return { status: 'awaiting_assessment', candidateDigest: c.digest, reviewRunId: `r-${always.calls.length}`, coverageComplete: true, findingInventoryComplete: true, findings: [FINDING, FINDING_B] }; } };
  const p = await paused(t, { reviewer: always, config: { maxOwnerFixRounds: 1 } });
  p.emulator.state.run = p.emulator.state.run;
  assert.equal((await p.assess(p.body('fix', [{ rating: 'high', fix: true }, { rating: 'low' }]))).status, 202);
  const again = await p.waitFor(['awaiting_assessment', 'blocked']);
  assert.equal(again.state, 'awaiting_assessment');
  const next = { decision: 'fix', assessmentRunId: again.assessmentRunId, reviewRunId: again.review.reviewRunId, candidateDigest: again.review.candidateDigest, findings: [{ id: 'finding-1', rating: 'high', fix: true }, { id: 'finding-2', rating: 'low' }] };
  assert.equal((await p.assess(next)).status, 409);
});

test('the assessment credential must be present and distinct, and windows are bounded', () => {
  const base = { workerId: 'd'.repeat(64), projectId: 'p', model: MODEL, secret: SECRET, issueNumber: 1, baseSha: JOB.baseSha, storeDir: '/tmp/x', ...RELAY };
  for (const extra of [{ assessmentSecret: undefined }, { assessmentSecret: SECRET }, { assessmentSecret: 'short' }]) {
    assert.throws(() => createControlServer({ ...base, ...extra }), /Controller configuration rejected/);
  }
  for (const extra of [{ assessmentWindowMs: 0 }, { assessmentWindowMs: 73 * 3600000 }, { maxOwnerFixRounds: 4 }]) {
    assert.throws(() => createControlServer({ ...base, assessmentSecret: OWNER, ...extra }), /Controller budget rejected/);
  }
});

// The gate leaves Low findings unchanged and forbids inferring severity, so the
// automatic loop acts only on findings Qodo itself classifies Medium or worse.
for (const [label, reportedSeverity] of [['unclassified', null], ['Low', 'Low'], ['lowercase low', 'low']]) {
  test(`${label} findings skip the automatic fix loop and pause for the owner`, async () => {
    const emulator = t3Emulator();
    const finding = { ...FINDING, reportedSeverity };
    const reviewer = { calls: [], fn: async c => { reviewer.calls.push(c.digest); return { status: 'awaiting_assessment', candidateDigest: c.digest, reviewRunId: 'r-1', coverageComplete: true, findingInventoryComplete: true, findings: [finding] }; } };
    const { value } = await fixLoop(emulator, reviewer);
    assert.equal(value.state, 'awaiting_assessment');
    assert.equal(emulator.state.sends.length, 0);
  });
}

test('the automatic loop sends only the classified Medium-or-worse findings', async () => {
  const emulator = t3Emulator();
  const findings = [{ ...FINDING, reportedSeverity: 'HIGH' }, { ...FINDING, id: 'finding-low', title: 'cosmetic naming', reportedSeverity: 'Low' }, { ...FINDING, id: 'finding-none', title: 'unclassified idea', reportedSeverity: null }];
  const reviewer = { calls: [], fn: async c => { reviewer.calls.push(c.digest); const first = reviewer.calls.length === 1; return { status: first ? 'awaiting_assessment' : 'approved', candidateDigest: c.digest, reviewRunId: `r-${reviewer.calls.length}`, coverageComplete: true, findingInventoryComplete: true, findings: first ? findings : [] }; } };
  const { value } = await fixLoop(emulator, reviewer);
  assert.equal(value.state, 'approved');
  assert.equal(emulator.state.sends.length, 1);
  assert.match(emulator.state.sends[0].input, /C1 OSC untested/);
  assert.doesNotMatch(emulator.state.sends[0].input, /cosmetic naming|unclassified idea/);
});

test('more than ten fixable findings pause instead of being silently truncated', async () => {
  const emulator = t3Emulator();
  const many = Array.from({ length: 11 }, (_, i) => ({ ...FINDING, id: `f-${i}`, title: `finding ${i}` }));
  const reviewer = { calls: [], fn: async c => { reviewer.calls.push(c.digest); return { status: 'awaiting_assessment', candidateDigest: c.digest, reviewRunId: 'r-1', coverageComplete: true, findingInventoryComplete: true, findings: many }; } };
  const { value } = await fixLoop(emulator, reviewer);
  assert.equal(value.state, 'awaiting_assessment');
  assert.equal(emulator.state.sends.length, 0);
  assert.throws(() => fixMessage(many), /Too many findings/);
});

test('an owner send-back of more than ten findings is refused, not truncated', async t => {
  const many = Array.from({ length: 11 }, (_, i) => ({ ...FINDING, id: `f-${i}`, title: `finding ${i}` }));
  const reviewer = { calls: [], fn: async c => { reviewer.calls.push(c.digest); return { status: 'awaiting_assessment', candidateDigest: c.digest, reviewRunId: 'r-1', coverageComplete: true, findingInventoryComplete: true, findings: many }; } };
  const p = await paused(t, { reviewer });
  const body = { decision: 'fix', assessmentRunId: p.value.assessmentRunId, reviewRunId: p.value.review.reviewRunId, candidateDigest: p.value.review.candidateDigest, findings: many.map(f => ({ id: f.id, rating: 'high', fix: true })) };
  const response = await p.assess(body);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, 'too_many_fix_findings');
  assert.equal(p.emulator.state.sends.length, 0);
});

// Enablement: job-scoped paths, one active job, workspace reset, proposal metadata, claims.
const JOB2 = { ...JOB, jobId: '22345678-1234-4234-8234-123456789abc', issueNumber: 124 };
const buildConfig = dir => ({ workerId: 'd'.repeat(64), projectId: 'project-id', model: MODEL, secret: SECRET, storeDir: dir });
const call = (url, path, method = 'GET', body) => fetch(url + path, { method, headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('jobs carry their own no-rebuild paths; rebuild, workflow and generated paths are refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-paths-'));
  const app = await running(buildConfig(dir), t3Emulator().run);
  t.after(() => stop(app.server));
  for (const allowedPaths of [['src/action.mjs'], ['.github/workflows/ci.yml'], ['dist/index.mjs'], ['package.json'], ['src/github.mjs'], [], ['README.md', 'README.md']]) {
    assert.equal((await post(app.url, { ...JOB, allowedPaths })).status, 400);
  }
  assert.equal((await post(app.url, { ...JOB, allowedPaths: ['src/personalized/cli.mjs', 'docs/guide/setup.md', 'README.md', 'tests/integration/x.test.mjs'] })).status, 202);
});

test('an unsuccessful stop after a terminal run failure keeps the worker reserved', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-stop-failed-'));
  const emulator = t3Emulator();
  const hooks = async args => {
    if (args[0] === 'stop') return { status: 1, stdout: '' };
    if (args.includes('show')) return { status: 0, stdout: JSON.stringify({ thread: {
      threadId: REAL_START.threadId, projectId: 'project-id', providerInstanceId: 'pi', model: MODEL,
      status: 'failed', latestRunId: REAL_START.runId, activeRunId: null, pendingRequestCount: 0, runCount: 1,
    } }) };
  };
  const app = await running(buildConfig(dir), emulator.run, undefined, [], hooks);
  t.after(() => stop(app.server));
  await post(app.url, JOB);
  const deadline = Date.now() + 5000;
  let job;
  do {
    job = await (await call(app.url, '/jobs/' + JOB.jobId)).json();
    if (job.state === 'blocked') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(job.stage, 't3_failed');
  assert.equal(job.cleanupUnconfirmed, true);
  assert.equal((await post(app.url, JOB2)).status, 409);
});

test('only one job is active; a terminal job frees the slot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-busy-'));
  const launch = Promise.withResolvers();
  const app = await running(buildConfig(dir), async args => {
    if (args.includes('start')) await launch.promise;
    if (args[0] === 'stop') return { status: 0, stdout: '' };
    if (args.includes('list')) return { status: 0, stdout: '[]' };
    return { status: 1, stdout: '' };
  });
  t.after(() => { launch.resolve(); return stop(app.server); });
  assert.equal((await post(app.url, JOB)).status, 202);
  assert.equal((await post(app.url, JOB2)).status, 409);
  launch.resolve();
  const deadline = Date.now() + 5000;
  let job;
  do {
    job = await (await call(app.url, '/jobs/' + JOB.jobId)).json();
    if (job.state === 'blocked' && !job.cleanupUnconfirmed) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(job.state, 'blocked');
  assert.equal(job.cleanupUnconfirmed, false);
  assert.equal((await post(app.url, JOB2)).status, 202);
});

test('the worker checkout is stashed if dirty, then reset to the job base before any grant or launch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-reset-'));
  const log = [];
  const emulator = t3Emulator();
  const dirty = async args => (args[0] === 'exec' && args[2] === 'git' && args.includes('status') && !log.some(e => e[1] === 'stash'))
    ? (log.push(['git', 'status']), { status: 0, stdout: '?? leftover.txt\n' }) : undefined;
  const app = await running(buildConfig(dir), emulator.run, undefined, log, dirty);
  t.after(() => stop(app.server));
  assert.equal((await post(app.url, JOB)).status, 202);
  await new Promise(r => setTimeout(r, 30));
  const steps = log.map(e => e[0] === 'git' ? e[1] : e[0]);
  const first = name => steps.indexOf(name);
  assert.ok(first('stash') >= 0 && first('stash') < first('fetch') && first('fetch') < first('checkout') && first('checkout') < first('issue'));
  assert.equal(emulator.state.sends.length, 0);
  const stash = log.find(e => e[1] === 'stash');
  // --all keeps ignored files too, so nothing a job wrote reaches the next one.
  assert.ok(stash.includes('--all'));
  assert.ok(log.some(e => e[1] === 'status' && e.includes('--ignored')));
  assert.ok(log.findIndex(e => e[0] === 'worker-start') >= 0 && log.findIndex(e => e[0] === 'worker-start') < log.findIndex(e => e[1] === 'stash'));
  assert.ok(log.find(e => e[1] === 'checkout').includes(JOB.baseSha));
});

test('a failed workspace reset blocks the job before any grant or launch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-reset-fail-'));
  const log = [];
  let starts = 0;
  const run = async args => { if (args.includes('start')) starts++; return { status: 0, stdout: '{}' }; };
  const failFetch = async args => (args[0] === 'exec' && args[2] === 'git' && args.includes('fetch')) ? { status: 1, stdout: '' } : undefined;
  const app = await running(buildConfig(dir), run, undefined, log, failFetch);
  t.after(() => stop(app.server));
  assert.equal((await post(app.url, JOB)).status, 202);
  await new Promise(r => setTimeout(r, 30));
  const value = await (await call(app.url, '/jobs/' + JOB.jobId)).json();
  assert.equal(value.state, 'blocked');
  assert.equal(value.stage, 'workspace_reset_failed');
  assert.equal(starts, 0);
  assert.equal(log.filter(e => e[0] === 'issue').length, 0);
});

async function approvedJob(t, meta) {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-meta-'));
  const emulator = t3Emulator();
  const exportMeta = async args => (args[0] === 'exec' && args.includes('--input-type=module') && args.at(-1) === '-' && !args.includes('-e'))
    ? { status: 0, stdout: JSON.stringify({ baseSha: JOB.baseSha, files: [{ path: JOB.allowedPaths[0], content: 'x\n' }], ...(meta === undefined ? {} : { meta }) }) } : undefined;
  const reviewer = reviewSequence(['approved']);
  const log = [];
  const app = await running(buildConfig(dir), emulator.run, reviewer.fn, log, exportMeta);
  t.after(() => stop(app.server));
  assert.equal((await post(app.url, JOB)).status, 202);
  let value;
  for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 15)); value = await (await call(app.url, '/jobs/' + JOB.jobId)).json(); if (value.state === 'approved') break; }
  assert.equal(value.state, 'approved');
  return { app, dir };
}

test('PR title and summary come from validated worker metadata, with a fixed fallback', async t => {
  const good = await approvedJob(t, { title: 'docs(readme): explain setup', summary: 'Adds setup notes.' });
  let proposal = await (await call(good.app.url, '/jobs/' + JOB.jobId + '/proposal')).json();
  assert.equal(proposal.structuredOutput.title, 'docs(readme): explain setup');
  assert.equal(proposal.structuredOutput.summary, 'Adds setup notes.');
  assert.deepEqual(proposal.structuredOutput.files.map(f => f.path), JOB.allowedPaths);
  for (const meta of [undefined, { title: 'Explain setup\nwith injection', summary: 'x' }, { title: 'feat(x): ' + 'a'.repeat(200), summary: 'x' }, { title: 'docs(readme): ok', summary: 'ghp_' + 'a'.repeat(30) }]) {
    const bad = await approvedJob(t, meta);
    proposal = await (await call(bad.app.url, '/jobs/' + JOB.jobId + '/proposal')).json();
    assert.equal(proposal.structuredOutput.title, `chore(factory): address issue #${JOB.issueNumber}`);
    assert.equal(proposal.metadataSource, 'fallback');
  }
});

test('publication is claimed once; an unfinished claim cannot be retaken, and publishing frees the slot', async t => {
  const { app } = await approvedJob(t, { title: 'test(x): add cases', summary: 'Adds cases.' });
  const active = await (await call(app.url, '/jobs/active')).json();
  assert.equal(active.job.jobId, JOB.jobId);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: 'a'.repeat(40) })).status, 409);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).status, 200);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).status, 409);
  assert.equal((await post(app.url, JOB2)).status, 409);
  for (const body of [{ prNumber: 9, prUrl: 'https://evil.example/pull/9', commitSha: 'a'.repeat(40) }, { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/10', commitSha: 'a'.repeat(40) }, { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: 'zz' }]) {
    assert.equal((await call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', body)).status, 400);
  }
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: 'a'.repeat(40) })).status, 409);
  assert.equal((await stage(app, { stage: 'source_committed', commitSha: 'a'.repeat(40) })).status, 200);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: 'a'.repeat(40) })).status, 200);
  assert.equal((await (await call(app.url, '/jobs/' + JOB.jobId)).json()).state, 'published');
  assert.equal((await (await call(app.url, '/jobs/active')).json()).job, null);
  assert.equal((await post(app.url, JOB2)).status, 202);
});

test('a failed publication write keeps the slot occupied until a durable retry', async t => {
  const { app, dir } = await approvedJob(t);
  const sha = 'a'.repeat(40);
  const publish = () => call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', {
    prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: sha,
  });
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).status, 200);
  assert.equal((await stage(app, { stage: 'source_committed', commitSha: sha })).status, 200);
  await chmod(dir, 0o500);
  try {
    assert.equal((await publish()).status, 503);
    assert.equal((await post(app.url, JOB2)).status, 409);
    assert.equal(JSON.parse(await readFile(join(dir, JOB.jobId + '.json'))).state, 'approved');
  } finally { await chmod(dir, 0o700); }
  assert.equal((await publish()).status, 200);
});

test('an assessment is claimed once per review run', async t => {
  const p = await paused(t);
  const claim = () => call(p.app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'assess', reviewRunId: p.value.review.reviewRunId });
  assert.equal((await claim()).status, 200);
  assert.equal((await claim()).status, 409);
  assert.equal((await call(p.app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'assess', reviewRunId: 'other' })).status, 409);
  assert.equal((await call(p.app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).status, 409);
});

test('a blocked job stays visible to the scheduler until it is acknowledged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-ack-'));
  const app = await running(buildConfig(dir), async args => args[0] === 'stop' ? { status: 0, stdout: '' } : args.includes('start') ? { status: 1, stdout: '' } : args.includes('list') ? { status: 0, stdout: '[]' } : { status: 1, stdout: '' });
  t.after(() => stop(app.server));
  assert.equal((await (await call(app.url, '/jobs/active')).json()).job, null);
  assert.equal((await post(app.url, JOB)).status, 202);
  await new Promise(r => setTimeout(r, 30));
  const seen = await (await call(app.url, '/jobs/active')).json();
  assert.equal(seen.job.state, 'blocked');
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/acknowledge`, 'POST', {})).status, 200);
  assert.equal((await (await call(app.url, '/jobs/active')).json()).job, null);
});

test('a deadline holds the slot until its revoke and worker stop finish', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-stopping-'));
  let releaseStop;
  const stopping = new Promise(resolve => { releaseStop = resolve; });
  const emulator = t3Emulator();
  const slowStop = async args => (args[0] === 'stop') ? (await stopping, { status: 0, stdout: 'd'.repeat(64) }) : undefined;
  const app = await running({ ...buildConfig(dir), maxJobMs: 40 }, async (args, input) => (args.includes('show') ? { status: 0, stdout: JSON.stringify({ thread: { threadId: REAL_START.threadId, projectId: 'project-id', providerInstanceId: 'pi', model: MODEL, status: 'running', activeRunId: REAL_START.runId, latestRunId: REAL_START.runId, runCount: 1, pendingRequestCount: 0 }, messages: [] }) } : emulator.run(args, input)), undefined, [], slowStop);
  t.after(() => { releaseStop(); return stop(app.server); });
  assert.equal((await post(app.url, JOB)).status, 202);
  await new Promise(r => setTimeout(r, 80));
  const during = await (await call(app.url, '/jobs/' + JOB.jobId)).json();
  assert.equal(during.state, 'stopping');
  assert.equal((await post(app.url, JOB2)).status, 409);
  releaseStop();
  await new Promise(r => setTimeout(r, 30));
  const after = await (await call(app.url, '/jobs/' + JOB.jobId)).json();
  assert.equal(after.state, 'blocked');
  assert.equal(after.stage, 'job_deadline');
  assert.equal((await post(app.url, JOB2)).status, 202);
});

test('a publication that wrote nothing can be released at once as a policy block', async t => {
  const { app } = await approvedJob(t, { title: 'test(x): add cases', summary: 'Adds cases.' });
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'policy' })).status, 409);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).status, 200);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'other' })).status, 400);
  const released = await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'policy' });
  assert.equal(released.status, 200);
  const value = await released.json();
  assert.equal(value.state, 'blocked');
  assert.equal(value.stage, 'publication_policy_blocked');
  assert.equal((await post(app.url, JOB2)).status, 202);
});

test('a fresh publish claim exposes its time and cannot be released as uncertain yet', async t => {
  const { app } = await approvedJob(t, { title: 'test(x): add cases', summary: 'Adds cases.' });
  const claimed = await (await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).json();
  assert.equal(typeof claimed.publishClaimedAt, 'number');
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'uncertain' })).status, 409);
});

test('the uncertain-publication age is configurable and bounded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-uncertain-'));
  const emulator = t3Emulator();
  const exportMeta = async args => (args[0] === 'exec' && args.includes('--input-type=module') && args.at(-1) === '-' && !args.includes('-e'))
    ? { status: 0, stdout: JSON.stringify({ baseSha: JOB.baseSha, files: [{ path: JOB.allowedPaths[0], content: 'x\n' }] }) } : undefined;
  const app = await running({ ...buildConfig(dir), publicationClaimMs: 30 }, emulator.run, reviewSequence(['approved']).fn, [], exportMeta);
  t.after(() => stop(app.server));
  assert.equal((await post(app.url, JOB)).status, 202);
  for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 15)); if ((await (await call(app.url, '/jobs/' + JOB.jobId)).json()).state === 'approved') break; }
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).status, 200);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'uncertain' })).status, 409);
  await new Promise(r => setTimeout(r, 50));
  const released = await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'uncertain' });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).stage, 'publication_uncertain');
  const seen = await (await call(app.url, '/jobs/active')).json();
  assert.equal(seen.job.stage, 'publication_uncertain');
  for (const publicationClaimMs of [0, 2 * 3600000 + 1, 1.5]) {
    assert.throws(() => createControlServer({ ...buildConfig(dir), ...RELAY, publicationClaimMs }), /Controller budget rejected/);
  }
});

test('a status poll in flight when the deadline fires cannot free the slot during cleanup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-inflight-poll-'));
  let releaseShow, releaseStop;
  const showGate = new Promise(r => { releaseShow = r; });
  const stopGate = new Promise(r => { releaseStop = r; });
  const emulator = t3Emulator();
  const hooks = async args => {
    if (args[0] === 'stop') { await stopGate; return { status: 0, stdout: 'd'.repeat(64) }; }
    if (args.includes('show')) { await showGate; return { status: 0, stdout: JSON.stringify({ thread: { threadId: REAL_START.threadId, projectId: 'project-id', providerInstanceId: 'pi', model: MODEL, status: 'failed', activeRunId: null, latestRunId: REAL_START.runId, runCount: 1, pendingRequestCount: 0 }, messages: [] }) }; }
    return undefined;
  };
  const app = await running({ ...buildConfig(dir), maxJobMs: 60 }, emulator.run, undefined, [], hooks);
  t.after(() => { releaseShow(); releaseStop(); return stop(app.server); });
  assert.equal((await post(app.url, JOB)).status, 202);
  await new Promise(r => setTimeout(r, 20));
  const poll = call(app.url, '/jobs/' + JOB.jobId);
  await new Promise(r => setTimeout(r, 70));
  releaseShow();
  const during = await (await poll).json();
  assert.equal(during.state, 'stopping');
  assert.equal((await post(app.url, JOB2)).status, 409);
  releaseStop();
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await (await call(app.url, '/jobs/' + JOB.jobId)).json()).state, 'blocked');
});

test('launch waits for the T3 service after a worker start, and blocks if it never answers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-t3-ready-'));
  let probes = 0;
  const slowReady = async args => (args[0] === 'exec' && String(args.at(-1)).includes('mellon-t3-ready'))
    ? (++probes < 3 ? { status: 1, stdout: '' } : { status: 0, stdout: 'mellon-t3-ready' }) : undefined;
  const emulator = t3Emulator();
  const log = [];
  const app = await running({ ...buildConfig(dir), readinessIntervalMs: 5 }, emulator.run, undefined, log, slowReady);
  t.after(() => stop(app.server));
  assert.equal((await post(app.url, JOB)).status, 202);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(probes, 3);
  assert.equal(log.filter(e => e[0] === 'issue').length, 1);

  const dir2 = await mkdtemp(join(tmpdir(), 'mellon-control-t3-never-'));
  const never = async args => (args[0] === 'exec' && String(args.at(-1)).includes('mellon-t3-ready')) ? { status: 1, stdout: '' } : undefined;
  const log2 = [];
  let starts = 0;
  const app2 = await running({ ...buildConfig(dir2), readinessIntervalMs: 2, readinessAttempts: 4 }, async (a, i) => { if (a.includes('start')) starts++; return emulator.run(a, i); }, undefined, log2, never);
  t.after(() => stop(app2.server));
  assert.equal((await post(app2.url, JOB)).status, 202);
  await new Promise(r => setTimeout(r, 60));
  const value = await (await call(app2.url, '/jobs/' + JOB.jobId)).json();
  assert.equal(value.state, 'blocked');
  assert.equal(value.stage, 'worker_not_ready');
  assert.equal(log2.filter(e => e[0] === 'issue').length, 0);
  assert.equal(starts, 0);
});

test('readiness rejects a successful probe that arrives past its overall deadline', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-readiness-deadline-'));
  const late = async args => {
    if (!String(args.at(-1)).includes('mellon-t3-ready')) return;
    now += 90001;
    return { status: 0, stdout: 'mellon-t3-ready' };
  };
  const log = [];
  const app = await running(buildConfig(dir), t3Emulator().run, undefined, log, late);
  t.after(() => stop(app.server));
  assert.equal((await post(app.url, JOB)).status, 202);
  const until = Date.now() + 5000;
  let job;
  do {
    job = await (await call(app.url, '/jobs/' + JOB.jobId)).json();
    if (job.state === 'blocked') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  assert.equal(job.stage, 'worker_not_ready');
  assert.equal(log.some(entry => entry[0] === 'issue'), false);
});

test('a new pause after an unchanged owner fix accepts a fresh assessment claim', async t => {
  const emulator = t3Emulator({ contents: ['same\n'] });
  const reviewer = twoFindings();
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-reclaim-'));
  const app = await running({ workerId: 'd'.repeat(64), projectId: 'project-id', model: MODEL, secret: SECRET, storeDir: dir, maxFixRounds: 0, assessmentSecret: OWNER }, emulator.run, reviewer.fn);
  t.after(() => stop(app.server));
  const get = async () => (await call(app.url, '/jobs/' + JOB.jobId)).json();
  const waitState = async s => { let v; for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 15)); v = await get(); if (v.state === s) return v; } return v; };
  assert.equal((await post(app.url, JOB)).status, 202);
  const first = await waitState('awaiting_assessment');
  assert.equal(first.assessmentClaimed, false);
  const claim = () => call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'assess', reviewRunId: first.review.reviewRunId });
  assert.equal((await claim()).status, 200);
  assert.equal((await get()).assessmentClaimed, true);
  assert.equal((await claim()).status, 409);
  const body = { decision: 'fix', assessmentRunId: first.assessmentRunId, reviewRunId: first.review.reviewRunId, candidateDigest: first.review.candidateDigest, findings: [{ id: 'finding-1', rating: 'critical', fix: true }, { id: 'finding-2', rating: 'low' }] };
  assert.equal((await fetch(app.url + `/jobs/${JOB.jobId}/assessment`, { method: 'POST', headers: { authorization: 'Bearer ' + OWNER, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 202);
  await new Promise(r => setTimeout(r, 20));
  const again = await waitState('awaiting_assessment');
  assert.equal(again.stage, 'review_no_progress');
  assert.equal(again.review.reviewRunId, first.review.reviewRunId);
  assert.notEqual(first.assessmentRunId, again.assessmentRunId);
  assert.equal((await fetch(app.url + `/jobs/${JOB.jobId}/assessment`, { method: 'POST', headers: { authorization: 'Bearer ' + OWNER, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 409);
  assert.equal(again.assessmentClaimed, false);
  assert.equal((await claim()).status, 200);
  assert.equal((await claim()).status, 409);
});

test('an owner send-back tells T3 the owner wants each finding fixed, with rating and note', () => {
  const owner = fixMessage([{ ...FINDING, ownerRating: 'critical', ownerNote: 'Trim to pointers.' }], { owner: true });
  assert.match(owner, /owner reviewed/i);
  assert.match(owner, /"ownerRating":"critical"/);
  assert.match(owner, /Trim to pointers\./);
  assert.doesNotMatch(owner, /leave it unchanged if it is not valid/);
  assert.match(owner, /explain/i);
  const automatic = fixMessage([FINDING]);
  assert.match(automatic, /leave it unchanged if it is not valid/);
});

// Rebuild publications: tracked stages with their own deadlines and an exact head chain.
const REBUILD_JOB = { ...JOB, allowedPaths: ['src/inputs.mjs', 'tests/unit/inputs.test.mjs'], requiresRebuild: true };
async function approvedRebuild(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mellon-control-rebuild-'));
  const emulator = t3Emulator();
  const exportFiles = async args => (args[0] === 'exec' && args.includes('--input-type=module') && args.at(-1) === '-' && !args.includes('-e'))
    ? { status: 0, stdout: JSON.stringify({ baseSha: JOB.baseSha, files: [{ path: 'src/inputs.mjs', content: 'export const x = 1;\n' }, { path: 'tests/unit/inputs.test.mjs', content: 'test\n' }] }) } : undefined;
  const app = await running({ ...buildConfig(dir), ...extra }, emulator.run, reviewSequence(['approved']).fn, [], exportFiles);
  t.after(() => stop(app.server));
  assert.equal((await post(app.url, REBUILD_JOB)).status, 202);
  let value;
  for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 15)); value = await (await call(app.url, '/jobs/' + JOB.jobId)).json(); if (value.state === 'approved') break; }
  assert.equal(value.state, 'approved');
  const proposal = await (await call(app.url, `/jobs/${JOB.jobId}/proposal`)).json();
  assert.equal(proposal.structuredOutput.requires_dist_rebuild, true);
  return app;
}
const stage = (app, body) => call(app.url, `/jobs/${JOB.jobId}/publication-stage`, 'POST', body);
const SRC = 'a'.repeat(40), G1 = 'b'.repeat(40), G2 = 'c'.repeat(40);

test('publication stages advance only in order, and the runner stage is for rebuild jobs', async t => {
  const app = await approvedRebuild(t);
  assert.equal((await stage(app, { stage: 'source_committed', commitSha: SRC })).status, 409);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' })).status, 200);
  assert.equal((await stage(app, { stage: 'runner', requestId: 'n8n-1000001' })).status, 409);
  assert.equal((await stage(app, { stage: 'source_committed', commitSha: 'zz' })).status, 400);
  const committed = await (await stage(app, { stage: 'source_committed', commitSha: SRC })).json();
  assert.equal(committed.publishStage, 'source_committed');
  assert.equal(committed.publishHead, SRC);
  assert.equal((await stage(app, { stage: 'source_committed', commitSha: SRC })).status, 409);
  assert.equal((await stage(app, { stage: 'runner', requestId: 'bad id' })).status, 400);
  assert.equal((await stage(app, { stage: 'runner', requestId: 'n8n-1000001' })).status, 200);
  assert.equal((await stage(app, { stage: 'mystery' })).status, 400);
});

test('generated commits must chain from the recorded head, once per generated path', async t => {
  const app = await approvedRebuild(t);
  await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' });
  await stage(app, { stage: 'source_committed', commitSha: SRC });
  await stage(app, { stage: 'runner', requestId: 'n8n-1000001' });
  assert.equal((await stage(app, { stage: 'generated', expectedHead: SRC, headSha: G1, path: 'dist/index.mjs' })).status, 409, 'generated needs a built stage first');
  assert.equal((await stage(app, { stage: 'built', runId: 'x', changedPaths: [] })).status, 400);
  assert.equal((await stage(app, { stage: 'built', runId: '123', changedPaths: ['src/inputs.mjs'] })).status, 400);
  assert.equal((await stage(app, { stage: 'built', runId: '123', changedPaths: ['dist/index.mjs', 'dist/build-meta.json'] })).status, 200);
  assert.equal((await stage(app, { stage: 'generated', expectedHead: G1, headSha: G2, path: 'dist/index.mjs' })).status, 409);
  assert.equal((await stage(app, { stage: 'generated', expectedHead: SRC, headSha: G1, path: 'src/inputs.mjs' })).status, 400);
  assert.equal((await stage(app, { stage: 'generated', expectedHead: SRC, headSha: G1, path: 'dist/scorer.mjs' })).status, 409, 'not a changed path');
  assert.equal((await stage(app, { stage: 'generated', expectedHead: SRC, headSha: SRC, path: 'dist/index.mjs' })).status, 400);
  const first = await (await stage(app, { stage: 'generated', expectedHead: SRC, headSha: G1, path: 'dist/index.mjs' })).json();
  assert.equal(first.publishHead, G1);
  assert.equal((await stage(app, { stage: 'generated', expectedHead: G1, headSha: G2, path: 'dist/index.mjs' })).status, 409);
  assert.equal((await stage(app, { stage: 'generated', expectedHead: G1, headSha: G2, path: 'dist/build-meta.json' })).status, 200);
  // Publication must name the last generated head.
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: G1 })).status, 409);
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: G2 })).status, 200);
});

test('a live runner stage holds the claim past the plain claim age; an overrun stage can be released', async t => {
  const app = await approvedRebuild(t, { publicationClaimMs: 20, runnerStageMs: 120 });
  await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' });
  await stage(app, { stage: 'source_committed', commitSha: SRC });
  const runner = await (await stage(app, { stage: 'runner', requestId: 'n8n-1000001' })).json();
  assert.ok(runner.publishDeadlineAt > Date.now() + 60);
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'uncertain' })).status, 409);
  await new Promise(r => setTimeout(r, 100));
  const released = await call(app.url, `/jobs/${JOB.jobId}/publication-failed`, 'POST', { reason: 'uncertain' });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).stage, 'publication_uncertain');
});

test('the runner stage budget is bounded', async () => {
  for (const runnerStageMs of [0, 3 * 3600000, 1.5]) {
    assert.throws(() => createControlServer({ ...buildConfig('/tmp/x'), ...RELAY, runnerStageMs }), /Controller budget rejected/);
  }
});

test('a rebuild job cannot be published before its build is recorded and every changed file is committed', async t => {
  const app = await approvedRebuild(t);
  const publish = commitSha => call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha });
  await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' });
  await stage(app, { stage: 'source_committed', commitSha: SRC });
  assert.equal((await publish(SRC)).status, 409, 'no runner yet');
  await stage(app, { stage: 'runner', requestId: 'n8n-1000001' });
  assert.equal((await publish(SRC)).status, 409, 'runner not finished');
  await stage(app, { stage: 'built', runId: '123', changedPaths: ['dist/index.mjs'] });
  assert.equal((await publish(SRC)).status, 409, 'changed file not committed');
  await stage(app, { stage: 'generated', expectedHead: SRC, headSha: G1, path: 'dist/index.mjs' });
  assert.equal((await publish(G1)).status, 200);
});

test('a rebuild whose generated files are unchanged publishes on the source commit', async t => {
  const app = await approvedRebuild(t);
  await call(app.url, `/jobs/${JOB.jobId}/claim`, 'POST', { action: 'publish' });
  await stage(app, { stage: 'source_committed', commitSha: SRC });
  await stage(app, { stage: 'runner', requestId: 'n8n-1000001' });
  const built = await (await stage(app, { stage: 'built', runId: '123', changedPaths: [] })).json();
  assert.equal(built.publishStage, 'built');
  assert.equal((await call(app.url, `/jobs/${JOB.jobId}/published`, 'POST', { prNumber: 9, prUrl: 'https://github.com/randoneering/mellon/pull/9', commitSha: SRC })).status, 200);
});
