import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreClassifier, trainClassifier } from '../../src/personalized/classifier.mjs';
import { splitDataset } from '../../src/personalized/split.mjs';
import { prepareSubmission } from '../../src/prepare.mjs';

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

test('tokenizes Unicode letters, marks, and numbers consistently during training and scoring', () => {
  const multilingual = [
    { title: 'café naïve', body: '日本語 текст १२३', label: 'human' },
    { title: '模型生成', body: '机器学习 résumé ٤٥٦', label: 'ai' },
    ...training,
  ];
  const model = trainClassifier(multilingual);
  assert.equal(model.algorithmVersion, 2);
  for (const token of ['café', 'naïve', '日本語', 'текст', '१२३', '模型生成']) {
    assert.ok(model.vocabulary.includes(token), `expected ${token} in vocabulary`);
  }
  assert.equal(scoreClassifier(model, 'café 日本語 текст १२३'), scoreClassifier(model, 'CAFÉ 日本語 текст १२३'));
  const legacy = { algorithm: 'tfidf-logistic-regression', algorithmVersion: 1, vocabulary: ['hello'], idf: [1], weights: [1], bias: 0 };
  assert.ok(Math.abs(scoreClassifier(legacy, 'hello unseen unseen') - 1 / (1 + Math.exp(-1 / Math.sqrt(7)))) < 1e-12);
});

test('sparse classifier operations match dense TF-IDF reference within numerical tolerance', () => {
  const model = trainClassifier(training);
  const features = training.map(record => {
    const words = prepareSubmission(record.title, record.body).toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
    return [...words, ...words.slice(0, -1).map((word, i) => `${word} ${words[i + 1]}`)];
  });
  const terms = model.vocabulary;
  const idf = terms.map(term => Math.log((1 + features.length) / (1 + features.filter(doc => doc.includes(term)).length)) + 1);
  const vectors = features.map(doc => {
    const counts = terms.map(term => doc.filter(value => value === term).length);
    const norm = Math.sqrt(counts.reduce((sum, count) => sum + count * count, 0)) || 1;
    return counts.map((count, i) => count / norm * idf[i]);
  });
  const weights = Array(terms.length).fill(0);
  let bias = 0;
  const sigmoid = value => 1 / (1 + Math.exp(-value));
  for (let iteration = 0; iteration < 500; iteration++) {
    const gradient = Array(terms.length).fill(0);
    let biasGradient = 0;
    for (let row = 0; row < vectors.length; row++) {
      const prediction = sigmoid(vectors[row].reduce((sum, value, i) => sum + value * weights[i], bias));
      const error = prediction - (training[row].label === 'ai' ? 1 : 0);
      biasGradient += error;
      for (let i = 0; i < gradient.length; i++) gradient[i] += error * vectors[row][i];
    }
    for (let i = 0; i < weights.length; i++) weights[i] -= 0.2 * (gradient[i] / vectors.length + weights[i]);
    bias -= 0.2 * biasGradient / vectors.length;
  }
  for (let i = 0; i < weights.length; i++) assert.ok(Math.abs(model.weights[i] - weights[i]) < 1e-10);
  assert.ok(Math.abs(model.bias - bias) < 1e-10);
  const queryWords = prepareSubmission('careful', 'rare unseen word').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const queryFeatures = [...queryWords, ...queryWords.slice(0, -1).map((word, i) => `${word} ${queryWords[i + 1]}`)];
  const queryCounts = terms.map(term => queryFeatures.filter(feature => feature === term).length);
  const allQueryCounts = new Map();
  for (const feature of queryFeatures) allQueryCounts.set(feature, (allQueryCounts.get(feature) ?? 0) + 1);
  const queryNorm = Math.sqrt([...allQueryCounts.values()].reduce((sum, count) => sum + count * count, 0)) || 1;
  const denseLogit = model.bias + queryCounts.reduce((sum, count, i) => sum + count / queryNorm * model.idf[i] * model.weights[i], 0);
  assert.ok(Math.abs(scoreClassifier(model, 'careful rare unseen word') - sigmoid(denseLogit)) < 1e-12);
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
