import test from 'node:test';
import assert from 'node:assert/strict';
import { executeReviewProcess } from '../../internal/factory-worker/review.mjs';

test('review subprocesses do not block HTTP/deadline timers', async () => {
  let timerFired = false;
  const timer=setTimeout(()=>{timerFired=true;},20);
  const pending=executeReviewProcess(process.execPath,['-e','setTimeout(()=>process.stdout.write("ready"),120)'],{timeout:2000});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(timerFired,true);
  const result=await pending;
  assert.equal(result.status,0);assert.equal(result.stdout,'ready');
  clearTimeout(timer);
});

test('a child that exits zero after its deadline is a timed-out failure', async () => {
  const result=await executeReviewProcess(process.execPath,['-e','process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'],{timeout:100});
  assert.equal(result.timedOut,true);assert.notEqual(result.status,0);
});

test('a child ignoring SIGTERM is force-killed and settles within a bounded grace period', async () => {
  const started=Date.now();
  const result=await executeReviewProcess(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{timeout:100,graceMs:200});
  assert.equal(result.timedOut,true);assert.notEqual(result.status,0);
  assert.ok(Date.now()-started<2000);
});

test('multibyte output counts against the byte budget', async () => {
  const result = await executeReviewProcess(process.execPath, ['-e', 'process.stdout.write("界".repeat(40))'], { maxBytes: 100 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});
