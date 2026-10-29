import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, positiveInt, publicBaseUrl } from '../src/helpers.js';

test('positiveInt rejects zero, fractions and non-numeric input', () => {
  assert.equal(positiveInt('18'), 18);
  assert.equal(positiveInt('0'), 0);
  assert.equal(positiveInt('2.5'), 0);
  assert.equal(positiveInt('x'), 0);
});

test('escapeHtml encodes markup and quotes', () => {
  assert.equal(escapeHtml(`<a title="x">'&`), '&lt;a title=&quot;x&quot;&gt;&#39;&amp;');
});

test('publicBaseUrl honors forwarded host and protocol', () => {
  const req = {
    get(name) {
      return { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.example.test' }[name];
    },
    protocol: 'http',
  };
  assert.equal(publicBaseUrl(req), 'https://api.example.test');
});