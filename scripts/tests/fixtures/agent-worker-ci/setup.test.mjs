import { before, test } from 'node:test';

before(() => {
  throw new Error('fixture setup detail');
});

test('setup failure fixture', () => {});
