import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const forms = [
  {
    file: 'feature-request.yml',
    required: ['problem', 'solution', 'definition-of-done'],
    optional: [],
  },
  {
    file: 'bug-report.yml',
    required: ['description', 'reproduction', 'expected', 'actual'],
    optional: ['environment'],
  },
];

for (const { file, required, optional } of forms) {
  test(`${file} defines a structured issue form without automatic labels`, () => {
    const form = parse(readFileSync(new URL(`../../.github/ISSUE_TEMPLATE/${file}`, import.meta.url), 'utf8'));
    assert.ok(form.name);
    assert.ok(form.description);
    assert.equal(form.labels, undefined);
    assert.ok(Array.isArray(form.body));
    const ids = form.body.map(field => field.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of [...required, ...optional]) {
      const field = form.body.find(item => item.id === id);
      assert.ok(field, `missing field: ${id}`);
      assert.equal(field.type, 'textarea');
      assert.ok(field.attributes?.label);
      assert.equal(field.validations?.required === true, required.includes(id));
    }
    if (file === 'feature-request.yml') {
      const done = form.body.find(field => field.id === 'definition-of-done');
      assert.match(done.attributes.placeholder, /- \[ \]/);
      assert.match(done.attributes.description, /maintainers/i);
      assert.match(done.attributes.description, /tests.*documentation/i);
      assert.match(done.attributes.placeholder, /user can/i);
      assert.match(done.attributes.placeholder, /when/i);
    }
  });
}
