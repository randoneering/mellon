import assert from 'node:assert/strict';
import test from 'node:test';

test('nested parent fixture', async context => {
  await context.test('nested child regression', () => {
    assert.equal('missing behavior', 'implemented behavior');
  });
});
