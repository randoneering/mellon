import test from 'node:test';

test('syntax failure fixture', async () => {
  await import('./syntax.fixture.mjs');
});
