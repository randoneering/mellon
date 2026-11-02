import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDataset } from '../../src/personalized/split.mjs';

const rec = (url, title, body, label) => ({ url, title, body, label });

test('split is order-independent and keeps exact prepared duplicates together', () => {
  const records = [
    rec('a', 'human title', 'human body', 'human'),
    rec('b', 'ai title', 'ai body', 'ai'),
    rec('c', 'duplicate', 'same text', 'human'),
    rec('d', 'duplicate', 'same text', 'human'),
    rec('e', 'other', 'different', 'ai'),
  ];
  const first = splitDataset(records);
  const second = splitDataset([...records].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.version, 1);
  assert.equal(first.assignments.c, first.assignments.d);
  assert.deepEqual(first.training.map(item => item.url), [...first.training.map(item => item.url)].sort());
});

test('excludes unsure, empty prepared text, and exact duplicates with conflicting labels', () => {
  const result = splitDataset([
    rec('u', 'unsure', 'text', 'unsure'),
    rec('empty', '```js\ncode\n```', '', 'human'),
    rec('x', 'repeat', 'same', 'human'),
    rec('y', 'repeat', 'same', 'ai'),
  ]);
  assert.equal(result.training.length + result.holdout.length, 0);
  assert.equal(result.exclusions.length, 4);
});

test('warns when holdout is missing a class', () => {
  const records = Array.from({ length: 5 }, (_, i) => rec(`item-${i}`, `unique ${i}`, '', i % 2 ? 'ai' : 'human'));
  const result = splitDataset(records);
  assert.equal(result.holdout.length, 1);
  assert.ok(result.warnings.some(warning => /holdout.*both labels/i.test(warning)));
});

test('handles empty, single-class, and small datasets with warnings and no overlap', () => {
  for (const records of [[], [rec('a', 'one', 'text', 'human')], [
    rec('a', 'one', 'text', 'human'), rec('b', 'two', 'more', 'human'),
  ]]) {
    const result = splitDataset(records);
    assert.ok(result.warnings.length > 0);
    assert.equal(result.version, 1);
    assert.equal(result.training.some(item => result.holdout.includes(item)), false);
  }
});
