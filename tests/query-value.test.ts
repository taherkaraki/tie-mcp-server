/**
 * Tests for attribute value normalization (src/query/value.ts).
 *
 * Verifies each TIE valueType decodes to the expected JS type, and that the
 * agreed decisions hold: dates/objects stay strings, bad JSON degrades to the
 * de-quoted raw string rather than throwing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAttributeValue } from '../src/query/value.js';

test('integer decodes to a number', () => {
  assert.equal(normalizeAttributeValue('1', 'integer'), 1);
  assert.equal(normalizeAttributeValue('10', 'integer'), 10);
});

test('boolean decodes to a real boolean', () => {
  assert.equal(normalizeAttributeValue('false', 'boolean'), false);
  assert.equal(normalizeAttributeValue('true', 'boolean'), true);
});

test('string is de-quoted', () => {
  assert.equal(normalizeAttributeValue('"Domain Admins"', 'string'), 'Domain Admins');
});

test('date stays a string (ISO sorts lexically; sentinels pass through)', () => {
  assert.equal(
    normalizeAttributeValue('"2026-06-10T03:32:08.0000000Z"', 'string'),
    '2026-06-10T03:32:08.0000000Z'
  );
  assert.equal(normalizeAttributeValue('"NEVER"', 'string'), 'NEVER');
});

test('object keeps its JSON form for opaque matching', () => {
  const v = normalizeAttributeValue('{"1":false,"2":false}', 'object');
  assert.equal(typeof v, 'string');
  assert.match(v as string, /"1":false/);
});

test('array/string decodes to a string array', () => {
  assert.deepEqual(
    normalizeAttributeValue('["top","group"]', 'array/string'),
    ['top', 'group']
  );
});

test('array/integer decodes to a number array', () => {
  assert.deepEqual(normalizeAttributeValue('[1,2,3]', 'array/integer'), [1, 2, 3]);
});

test('malformed JSON falls back to the de-quoted raw string', () => {
  // Not valid JSON; should not throw.
  assert.equal(normalizeAttributeValue('NORMAL DONT_EXPIRE', 'string'), 'NORMAL DONT_EXPIRE');
});

test('non-numeric integer degrades gracefully', () => {
  // Defensive: an integer-typed value that isn't a number returns the raw text.
  assert.equal(normalizeAttributeValue('"N/A"', 'integer'), 'N/A');
});
