import { prepareSubmission } from '../prepare.mjs';

export const CLASSIFIER_VERSION = 2;
const ALGORITHM_VERSION = CLASSIFIER_VERSION;
const REGULARIZATION = 1;
const ITERATIONS = 500;
const LEARNING_RATE = 0.2;
const DECISION_CUTOFF = 0.5;

function tokens(text, version = ALGORITHM_VERSION) {
  if (typeof text !== 'string') throw new TypeError('Classifier input must be text.');
  const pattern = version === 1 ? /[a-z0-9]+/g : /[\p{L}\p{M}\p{N}]+/gu;
  const words = text.toLowerCase().match(pattern) ?? [];
  const features = [...words];
  for (let i = 0; i + 1 < words.length; i++) features.push(`${words[i]} ${words[i + 1]}`);
  return features;
}

function sparseVector(document, vocabularyIndex, idf) {
  const counts = new Map();
  for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
  const norm = Math.sqrt([...counts.values()].reduce((sum, count) => sum + count * count, 0)) || 1;
  const vector = new Map();
  for (const [term, count] of counts) {
    const index = vocabularyIndex.get(term);
    if (index !== undefined) vector.set(index, count / norm * idf[index]);
  }
  return vector;
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
  const vocabularyIndex = new Map(vocabulary.map((term, index) => [term, index]));
  const documentFrequencies = new Uint32Array(vocabulary.length);
  for (const document of documents) {
    for (const term of new Set(document)) documentFrequencies[vocabularyIndex.get(term)]++;
  }
  const idf = vocabulary.map((_, index) => Math.log((1 + documents.length) / (1 + documentFrequencies[index])) + 1);
  const vectors = documents.map(document => sparseVector(document, vocabularyIndex, idf));
  const weights = Array(vocabulary.length).fill(0);
  let bias = 0;
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const gradient = Array(vocabulary.length).fill(0);
    let biasGradient = 0;
    for (let row = 0; row < vectors.length; row++) {
      let logit = bias;
      for (const [index, value] of vectors[row]) logit += value * weights[index];
      const prediction = sigmoid(logit);
      const error = prediction - (trainingRecords[row].label === 'ai' ? 1 : 0);
      biasGradient += error;
      for (const [index, value] of vectors[row]) gradient[index] += error * value;
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
  if (!model || ![1, ALGORITHM_VERSION].includes(model.algorithmVersion) || !Array.isArray(model.vocabulary) || !Array.isArray(model.idf) || !Array.isArray(model.weights) || model.vocabulary.length !== model.idf.length || model.vocabulary.length !== model.weights.length) {
    throw new TypeError('Classifier model is invalid or unsupported.');
  }
  const vocabularyIndex = new Map(model.vocabulary.map((term, index) => [term, index]));
  const vector = sparseVector(tokens(text, model.algorithmVersion), vocabularyIndex, model.idf);
  let logit = model.bias;
  for (const [index, value] of vector) logit += value * model.weights[index];
  return sigmoid(logit);
}
