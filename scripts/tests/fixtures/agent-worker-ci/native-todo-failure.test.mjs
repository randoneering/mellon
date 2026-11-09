import assert from 'node:assert/strict';
import test from 'node:test';

test('native failing todo is not an intended assertion regression', { todo: true }, () => {
  assert.fail('unfinished regression');
});
