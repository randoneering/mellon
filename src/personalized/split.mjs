import { createHash } from 'node:crypto';
import { prepareSubmission } from '../prepare.mjs';

export const SPLIT_VERSION = 2;

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function splitDataset(records) {
  if (!Array.isArray(records)) throw new TypeError('Dataset records must be an array.');
  const exclusions = [];
  const groups = new Map();
  for (const record of records) {
    if (!record || !['human', 'ai', 'unsure'].includes(record.label) || typeof record.title !== 'string' || typeof record.body !== 'string') {
      throw new TypeError('Dataset record has invalid fields or label.');
    }
    if (record.label === 'unsure') {
      exclusions.push({ url: record.url, reason: 'unsure' });
      continue;
    }
    const text = prepareSubmission(record.title, record.body);
    if (!text.trim()) {
      exclusions.push({ url: record.url, reason: 'empty-prepared-text' });
      continue;
    }
    const hash = hashText(text);
    if (!groups.has(hash)) groups.set(hash, { hash, records: [], labels: new Set() });
    const group = groups.get(hash);
    group.records.push(record);
    group.labels.add(record.label);
  }
  for (const [hash, group] of groups) {
    if (group.labels.size > 1) {
      for (const record of group.records) exclusions.push({ url: record.url, reason: 'conflicting-label-duplicate', groupHash: hash });
      groups.delete(hash);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.hash.localeCompare(b.hash));
  const groupsByLabel = new Map([['human', []], ['ai', []]]);
  for (const group of sorted) groupsByLabel.get([...group.labels][0]).push(group);
  const eachLabelCanSplit = [...groupsByLabel.values()].every(groups => groups.length >= 2);
  const holdoutTarget = Math.min(sorted.length - 2, Math.max(Math.round(sorted.length * 0.2), eachLabelCanSplit ? 2 : 0));
  const holdoutGroups = [];
  if (holdoutTarget > 0) {
    const quotas = new Map([...groupsByLabel].map(([label, groups]) => [label, Math.floor(holdoutTarget * groups.length / sorted.length)]));
    let remaining = holdoutTarget - [...quotas.values()].reduce((sum, count) => sum + count, 0);
    const rankedLabels = [...groupsByLabel.keys()].sort((left, right) => {
      const leftRemainder = holdoutTarget * groupsByLabel.get(left).length / sorted.length - quotas.get(left);
      const rightRemainder = holdoutTarget * groupsByLabel.get(right).length / sorted.length - quotas.get(right);
      return rightRemainder - leftRemainder || left.localeCompare(right);
    });
    for (const label of rankedLabels) if (remaining > 0) { quotas.set(label, quotas.get(label) + 1); remaining--; }
    if (eachLabelCanSplit && holdoutTarget >= 2) {
      for (const label of groupsByLabel.keys()) quotas.set(label, Math.max(1, quotas.get(label)));
      while ([...quotas.values()].reduce((sum, count) => sum + count, 0) > holdoutTarget) {
        const label = [...groupsByLabel.keys()].sort((a, b) => quotas.get(b) - quotas.get(a) || b.localeCompare(a))[0];
        if (quotas.get(label) <= 1) break;
        quotas.set(label, quotas.get(label) - 1);
      }
    }
    for (const [label, groups] of groupsByLabel) holdoutGroups.push(...groups.slice(0, Math.min(quotas.get(label), groups.length - 1)));
  }
  const holdoutSet = new Set(holdoutGroups.map(group => group.hash));
  const trainingGroups = sorted.filter(group => !holdoutSet.has(group.hash));
  const assignments = {};
  const groupHashes = {};
  for (const group of [...trainingGroups, ...holdoutGroups]) {
    for (const record of group.records) {
      assignments[record.url] = holdoutSet.has(group.hash) ? 'holdout' : 'training';
      groupHashes[record.url] = group.hash;
    }
  }
  const warnings = [];
  if (!sorted.length) warnings.push('No eligible records remain after exclusions.');
  if (new Set(trainingGroups.map(group => [...group.labels][0])).size < 2) warnings.push('Training split does not contain both labels.');
  if (!holdoutGroups.length) warnings.push('Holdout split is empty or too small.');
  if (new Set(holdoutGroups.map(group => [...group.labels][0])).size < 2) warnings.push('Holdout split does not contain both labels.');
  return {
    version: SPLIT_VERSION,
    training: trainingGroups.flatMap(group => group.records).sort((a, b) => a.url.localeCompare(b.url)),
    holdout: holdoutGroups.flatMap(group => group.records).sort((a, b) => a.url.localeCompare(b.url)),
    groupHashes: Object.fromEntries(Object.entries(groupHashes).sort(([a], [b]) => a.localeCompare(b))),
    assignments: Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b))),
    exclusions: exclusions.sort((a, b) => a.url.localeCompare(b.url)),
    warnings,
  };
}
