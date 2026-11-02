import { prepareSubmission } from '../prepare.mjs';

const ALGORITHM_VERSION = 1;
const REGULARIZATION = 1;
const ITERATIONS = 500;
const LEARNING_RATE = 0.2;
const DECISION_CUTOFF = 0.5;

function tokens(text) {
  if (typeof text !== 'string') throw new TypeError('Classifier input must be text.');
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const features = [...words];
  for (let i = 0; i + 1 < words.length; i++) features.push(`${words[i]} ${words[i + 1]}`);
  return features;
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function trainClassifier(trainingRecords) {
  if (!Array.isArray(trainingRecords)) throw new TypeError('Training records must be an array.');
  if (trainingRecords.some(record => !record || !['human', 'ai'].includes(record.label))) {
    throw new TypeError('Training records must use human or ai labels.');
  }
  const labels = new Set(trainingRecords.map(record => record.label));
  if (labels.size !== 2) throw new TypeError('Training requires examples from both human and ai labels.');
  const documents = trainingRecords.map(record => tokens(prepareSubmission(record.title, record.body)));
  const vocabulary = [...new Set(documents.flat())].sort();
  const idf = vocabulary.map(term => Math.log((1 + documents.length) / (1 + documents.filter(doc => doc.includes(term)).length)) + 1);
  const vectors = documents.map(doc => {
    const counts = new Map();
    for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
    const norm = Math.sqrt([...counts.values()].reduce((sum, count) => sum + count * count, 0)) || 1;
    return vocabulary.map((term, i) => ((counts.get(term) ?? 0) / norm) * idf[i]);
  });
  const weights = Array(vocabulary.length).fill(0);
  let bias = 0;
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const gradient = Array(vocabulary.length).fill(0);
    let biasGradient = 0;
    for (let row = 0; row < vectors.length; row++) {
      const prediction = sigmoid(vectors[row].reduce((sum, value, i) => sum + value * weights[i], bias));
      const error = prediction - (trainingRecords[row].label === 'ai' ? 1 : 0);
      biasGradient += error;
      for (let i = 0; i < gradient.length; i++) gradient[i] += error * vectors[row][i];
    }
    for (let i = 0; i < weights.length; i++) {
      weights[i] -= LEARNING_RATE * (gradient[i] / vectors.length + REGULARIZATION * weights[i]);
    }
    bias -= LEARNING_RATE * biasGradient / vectors.length;
  }
  return {
    algorithm: 'tfidf-logistic-regression',
    algorithmVersion: ALGORITHM_VERSION,
    hyperparameters: { regularization: REGULARIZATION, iterations: ITERATIONS, learningRate: LEARNING_RATE, decisionCutoff: DECISION_CUTOFF },
    vocabulary,
    idf,
    weights,
    bias,
    positiveLabel: 'ai',
  };
}

export function scoreClassifier(model, text) {
  if (!model || model.algorithmVersion !== ALGORITHM_VERSION || !Array.isArray(model.vocabulary) || !Array.isArray(model.idf) || !Array.isArray(model.weights) || model.vocabulary.length !== model.idf.length || model.vocabulary.length !== model.weights.length) {
    throw new TypeError('Classifier model is invalid or unsupported.');
  }
  const counts = new Map();
  for (const term of tokens(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const norm = Math.sqrt([...counts.values()].reduce((sum, count) => sum + count * count, 0)) || 1;
  let logit = model.bias;
  for (let i = 0; i < model.vocabulary.length; i++) {
    logit += ((counts.get(model.vocabulary[i]) ?? 0) / norm) * model.idf[i] * model.weights[i];
  }
  return sigmoid(logit);
}
