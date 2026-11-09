import assert from 'node:assert/strict';
import test from 'node:test';

for (let index = 0; index < 65; index += 1) {
  test(`overflow failure ${index}`, () => assert.fail('fixture failure'));
}
