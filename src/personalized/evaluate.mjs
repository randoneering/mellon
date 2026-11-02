import { createHash } from 'node:crypto';
import { prepareSubmission } from '../prepare.mjs';
import { CLASSIFIER_VERSION, scoreClassifier } from './classifier.mjs';

export const EVALUATION_VERSION = 1;
export const BASELINE_CUTOFF = 0.8;
export const PERSONALIZED_CUTOFF = 0.5;
export const PREPARATION_VERSION = 1;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalRecords(records) {
  return [...records].sort((a, b) => a.url.localeCompare(b.url));
}

export function createEvaluationMetadata(records, split, baselineModelHash) {
  if (!Array.isArray(records) || !split || !split.assignments || typeof baselineModelHash !== 'string') {
    throw new TypeError('Dataset, split, and baseline model hash are required.');
  }
  const snapshot = canonicalRecords(records);
  return {
    evaluationVersion: EVALUATION_VERSION,
    datasetHash: hash(JSON.stringify(snapshot)),
    holdoutHash: hash(JSON.stringify(canonicalRecords(split.holdout ?? []))),
    splitVersion: split.version,
    assignments: Object.fromEntries(Object.entries(split.assignments).sort(([a], [b]) => a.localeCompare(b))),
    preparationVersion: PREPARATION_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    baselineModelHash,
    trainingParameters: {
      algorithm: 'tfidf-logistic-regression',
      decisionCutoff: PERSONALIZED_CUTOFF,
    },
  };
}

function metrics(rows) {
  const confusion = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  const support = { human: 0, ai: 0 };
  for (const { label, predicted } of rows) {
    support[label]++;
    if (label === 'ai' && predicted) confusion.truePositive++;
    else if (label === 'human' && predicted) confusion.falsePositive++;
    else if (label === 'human') confusion.trueNegative++;
    else confusion.falseNegative++;
  }
  const precisionDenominator = confusion.truePositive + confusion.falsePositive;
  const recallDenominator = confusion.truePositive + confusion.falseNegative;
  return {
    support,
    totalSupport: rows.length,
    confusion,
    falsePositives: confusion.falsePositive,
    falseNegatives: confusion.falseNegative,
    precision: precisionDenominator ? confusion.truePositive / precisionDenominator : null,
    recall: recallDenominator ? confusion.truePositive / recallDenominator : null,
    undefinedMetrics: [
      ...(!precisionDenominator ? ['precision'] : []),
      ...(!recallDenominator ? ['recall'] : []),
    ],
  };
}

export async function evaluateHoldout(model, records, baselineScore) {
  if (!Array.isArray(records) || typeof baselineScore !== 'function') {
    throw new TypeError('Evaluation records and baseline scorer are required.');
  }
  const metadata = model?.evaluation;
  if (!metadata || metadata.evaluationVersion !== EVALUATION_VERSION) {
    throw new TypeError('Model is missing supported dataset and split metadata.');
  }
  const snapshot = canonicalRecords(records);
  const suppliedHash = hash(JSON.stringify(snapshot));
  const assignments = Object.fromEntries(snapshot.map(record => [record.url, 'holdout']));
  const recordedHoldout = Object.fromEntries(Object.entries(metadata.assignments ?? {})
    .filter(([, assignment]) => assignment === 'holdout'));
  if (metadata.holdoutHash !== suppliedHash || JSON.stringify(recordedHoldout) !== JSON.stringify(assignments)) {
    throw new Error('Evaluation dataset does not match recorded dataset and split.');
  }
  const rows = [];
  const unscorable = [];
  for (const record of records) {
    const text = prepareSubmission(record.title, record.body);
    try {
      const [baseline, personalized] = await Promise.all([
        baselineScore(text),
        Promise.resolve(scoreClassifier(model, text)),
      ]);
      const baselineScoreValue = typeof baseline === 'number' ? baseline : baseline?.robot_score;
      if (!Number.isFinite(baselineScoreValue) || !Number.isFinite(personalized)) throw new Error('invalid score');
      rows.push({
        label: record.label,
        baseline: baselineScoreValue >= BASELINE_CUTOFF,
        personalized: personalized >= PERSONALIZED_CUTOFF,
      });
    } catch {
      unscorable.push({ url: record.url, reason: 'one or more detectors could not score record' });
    }
  }
  const warnings = [];
  if (rows.length < 10) warnings.push('Holdout is small; results do not establish detector superiority.');
  if (new Set(rows.map(row => row.label)).size < 2) warnings.push('Holdout is missing one or more classes.');
  if (unscorable.length) warnings.push('Some records were unscorable and excluded from both detector metrics.');
  const baselineRows = rows.map(row => ({ label: row.label, predicted: row.baseline }));
  const personalizedRows = rows.map(row => ({ label: row.label, predicted: row.personalized }));
  return {
    evaluationVersion: EVALUATION_VERSION,
    datasetHash: metadata.datasetHash,
    splitAssignments: metadata.assignments,
    preparationVersion: metadata.preparationVersion,
    classifierVersion: metadata.classifierVersion,
    baselineModelHash: metadata.baselineModelHash,
    trainingParameters: { ...metadata.trainingParameters, ...model.hyperparameters },
    cutoffs: { baseline: BASELINE_CUTOFF, personalized: PERSONALIZED_CUTOFF },
    detectors: { baseline: metrics(baselineRows), personalized: metrics(personalizedRows) },
    unscorable,
    warnings,
  };
}
