import assert from 'node:assert/strict';
import test from 'node:test';
import { workerRuntimeEnvironment } from '../../src/automation/worker/environment.mjs';

const role = 'agent_worker';
const url = username => `postgresql://${username}:synthetic@db.invalid/worker?sslmode=verify-full`;

for (const [worker, intake] of [
  ['agent%5Fworker', 'agent_worker'],
  ['agent_worker', 'agent%5Fworker'],
  ['agent%5fworker', 'agent%5Fworker'],
  ['%61gent_worker', 'agent%5Fworker'],
]) test(`equivalent worker/intake roles are rejected: ${worker} and ${intake}`, () => {
  assert.throws(() => workerRuntimeEnvironment({
    AGENT_WORKER_DATABASE_URL: url(worker), AGENT_INTAKE_DATABASE_URL: url(intake),
  }, role), { message: 'Worker configuration is invalid.' });
});

test('malformed intake-role encoding fails closed without exposing its URL', () => {
  assert.throws(() => workerRuntimeEnvironment({
    AGENT_WORKER_DATABASE_URL: url('agent_worker'),
    AGENT_INTAKE_DATABASE_URL: url('intake%ZZrole'),
  }, role), { message: 'Worker configuration is invalid.' });
});

test('distinct decoded roles preserve the worker-only environment', () => {
  const worker = url('agent%5Fworker');
  assert.deepEqual(workerRuntimeEnvironment({
    AGENT_WORKER_DATABASE_URL: worker,
    AGENT_INTAKE_DATABASE_URL: url('intake%5Frole'),
    DATABASE_URL: 'postgresql://owner:synthetic@owner.invalid/owner',
  }, role), { AGENT_WORKER_DATABASE_URL: worker,
    DATABASE_URL: worker, DATABASE_URL_UNPOOLED: worker });
});
