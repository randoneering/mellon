import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationMetadata, evaluateHoldout } from '../../src/personalized/evaluate.mjs';
import { prepareSubmission } from '../../src/prepare.mjs';
import { scoreRequest } from '../../detector/scorer.mjs';

const records = [
  { url: 'a', title: 'human title', body: 'human body', label: 'human' },
  { url: 'b', title: 'ai title', body: 'ai body', label: 'ai' },
];
const model = {
  algorithmVersion: 1,
  vocabulary: [], idf: [], weights: [], bias: 0,
  hyperparameters: { decisionCutoff: 0.5, regularization: 1, iterations: 500, learningRate: 0.2 }, positiveLabel: 'ai',
};
const split = { version: 1, assignments: { a: 'holdout', b: 'holdout' }, training: [], holdout: records };
const evaluatedModel = { ...model, evaluation: createEvaluationMetadata(records, split, 'baseline-hash') };

test('evaluates both detectors on identical prepared snapshots using fixed cutoffs', async () => {
  const seen = [];
  const result = await evaluateHoldout(evaluatedModel, records, async text => {
    seen.push(text);
    return text.includes('ai title') ? 0.8 : 0.2;
  });
  assert.deepEqual(seen, records.map(record => prepareSubmission(record.title, record.body)));
  assert.equal(result.cutoffs.baseline, 0.8);
  assert.equal(result.cutoffs.personalized, 0.5);
  assert.deepEqual(result.detectors.baseline.confusion, { truePositive: 1, falsePositive: 0, trueNegative: 1, falseNegative: 0 });
  assert.deepEqual(result.detectors.personalized.confusion, { truePositive: 1, falsePositive: 1, trueNegative: 0, falseNegative: 0 });
});

test('records snapshot and split metadata and rejects changed evaluation data', async () => {
  const metadata = createEvaluationMetadata(records, {
    version: 1,
    assignments: { a: 'holdout', b: 'holdout' },
    training: [], holdout: records,
  }, 'baseline-hash');
  const result = await evaluateHoldout({ ...model, evaluation: metadata }, records, async () => 0.5);
  assert.equal(result.datasetHash, metadata.datasetHash);
  assert.equal(result.trainingParameters.regularization, 1);
  assert.equal(result.trainingParameters.iterations, 500);
  assert.equal(result.trainingParameters.learningRate, 0.2);
  assert.equal(metadata.classifierVersion, 2);
  assert.deepEqual(result.splitAssignments, metadata.assignments);
  await assert.rejects(evaluateHoldout({ ...model, evaluation: metadata }, [records[0]], async () => 0.5), /dataset.*split/i);
});

test('discloses scorer failures and compares detectors on same scorable records', async () => {
  const result = await evaluateHoldout(evaluatedModel, records, async text => {
    if (text.includes('human title')) throw new Error('bad snapshot');
    return 0.9;
  });
  assert.equal(result.unscorable.length, 1);
  assert.equal(result.detectors.baseline.totalSupport, 1);
  assert.ok(result.warnings.length > 0);
  assert.equal(typeof scoreRequest, 'function');
});
