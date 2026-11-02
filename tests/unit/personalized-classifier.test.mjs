import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreClassifier, trainClassifier } from '../../src/personalized/classifier.mjs';
import { splitDataset } from '../../src/personalized/split.mjs';

const training = [
  { title: 'human written', body: 'careful personal explanation', label: 'human' },
  { title: 'human note', body: 'my own thoughtful account', label: 'human' },
  { title: 'ai generated', body: 'automated synthetic response', label: 'ai' },
  { title: 'machine text', body: 'generated synthetic answer', label: 'ai' },
];

test('classifier artifact is deterministic and JSON round-trip preserves predictions', () => {
  const model = trainClassifier(training);
  assert.deepEqual(model, trainClassifier(training));
  const restored = JSON.parse(JSON.stringify(model));
  assert.equal(scoreClassifier(restored, 'careful personal explanation'), scoreClassifier(model, 'careful personal explanation'));
  assert.equal(model.positiveLabel, 'ai');
});

test('requires examples from both labels', () => {
  assert.throws(() => trainClassifier([training[0]]), /both human and ai/);
});

test('fits vocabulary only from the actual training split', () => {
  const records = Array.from({ length: 12 }, (_, i) => ({
    url: `item-${i}`, title: `uniqueword${i}`, body: 'common text',
    label: i % 2 ? 'ai' : 'human',
  }));
  const split = splitDataset(records);
  assert.ok(split.holdout.length > 0);
  const model = trainClassifier(split.training);
  for (const record of split.holdout) assert.ok(!model.vocabulary.includes(record.title));
});

test('rejects malformed records and excludes fenced code from features', () => {
  assert.throws(() => trainClassifier([training[0], { label: 'ai' }]), /text/);
  const model = trainClassifier([training[0], { title: 'AI', body: '```\nsecretcode\n```', label: 'ai' }]);
  assert.ok(!model.vocabulary.includes('secretcode'));
});
