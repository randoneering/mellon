import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require('yaml');
} catch {
  yaml = require('js-yaml');
}
const action = yaml.parse(await readFile('action.yml', 'utf8'));
assert.equal(action.runs?.using, 'node24');
assert.equal(action.runs?.main, 'dist/index.mjs');
assert.deepEqual(Object.keys(action.inputs).sort(), ['allowlist', 'auto-close', 'mode', 'response', 'token']);
assert.equal(action.inputs.mode.default, 'enforce');
assert.equal(action.inputs['auto-close'].default, 'true');
assert.deepEqual(Object.keys(action.outputs).sort(), ['outcome', 'robot-score']);

const workflowText = await readFile('examples/submission-moderation.yml', 'utf8');
const workflow = yaml.parse(workflowText);
assert.deepEqual(Object.keys(workflow.on).sort(), ['issues', 'pull_request_target']);
assert.deepEqual(workflow.on.issues.types, ['opened']);
assert.deepEqual(workflow.on.pull_request_target.types, ['opened']);
assert.deepEqual(workflow.permissions, { issues: 'write', 'pull-requests': 'write' });
assert.equal(workflow.concurrency['cancel-in-progress'], false);
assert.match(workflow.concurrency.group, /repository/);
assert.match(workflow.concurrency.group, /issue\.number/);
assert.match(workflow.concurrency.group, /pull_request\.number/);
assert.ok(workflow.jobs.moderate['timeout-minutes'] > 0);
assert.equal(workflow.jobs.moderate.steps.length, 1);
assert.match(workflow.jobs.moderate.steps[0].uses,
  /^OWNER\/mellon@REPLACE_WITH_REVIEWED_40_CHARACTER_RELEASE_SHA$/);
assert.equal(workflowText.includes('actions/checkout'), false);
assert.equal(workflowText.includes('pull-requests: write'), true);

for (const relative of ['dist/index.mjs', 'dist/scorer.mjs', 'dist/detector/provenance.json',
  'dist/detector/vendor/aicomment/model.json', 'dist/THIRD_PARTY_NOTICES.txt']) {
  await readFile(path.resolve(relative));
}
console.log('Action metadata, template boundaries, and distributable files validated.');
