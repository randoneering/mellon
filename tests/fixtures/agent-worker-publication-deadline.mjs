import { publish, ensureDraftPr } from '../../src/automation/worker/publisher.mjs';
import { createPublisherFixture, createDraftPrFixture } from './agent-worker-publication.mjs';

const phase = process.argv[2];
if (!['branch', 'commit', 'pr'].includes(phase)) throw new Error('Invalid probe phase.');
const start = Date.now();
let elapsed = 0;
Date.now = () => start + elapsed;
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled += 1; });
const fixture = phase === 'pr' ? createDraftPrFixture() : createPublisherFixture();
const expiry = new Date(start + 240_000).toISOString();
fixture.context.contextExpiresAt = expiry;
fixture.context.signingPreflight.expiresAt = expiry;
const fence = fixture.dependencies.checkFence;
fixture.dependencies.checkFence = async args => {
  const result = await fence(args);
  if (args.phase === phase) elapsed = 190_000;
  return result;
};
const result = await (phase === 'pr' ? ensureDraftPr : publish)(fixture.request, fixture.dependencies);
await new Promise(resolve => setImmediate(resolve));
process.stdout.write(`${JSON.stringify({
  status: result.status, reason: result.reason,
  branchWrites: fixture.state.branchWrites, commitWrites: fixture.state.commitWrites,
  prWrites: fixture.state.prWrites ?? 0, unhandled,
})}\n`);
