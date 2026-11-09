import assert from 'node:assert/strict';
import test from 'node:test';

test('selected assertion regression', () => {
  assert.equal('missing behavior', 'implemented behavior');
});
