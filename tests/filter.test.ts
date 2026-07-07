/**
 * Tests for the safety-tier filter (src/filter.ts).
 *
 * filterTools reads TIE_ALLOWED_SAFETY from the environment, so each test sets
 * or clears it and restores the prior value afterward.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { filterTools } from '../src/filter.js';

const ITEMS = [
  { name: 'a', safety: 'read' },
  { name: 'b', safety: 'write' },
  { name: 'c', safety: 'destructive' },
];

const ORIGINAL = process.env.TIE_ALLOWED_SAFETY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TIE_ALLOWED_SAFETY;
  else process.env.TIE_ALLOWED_SAFETY = ORIGINAL;
});

test('returns all tools when TIE_ALLOWED_SAFETY is unset', () => {
  delete process.env.TIE_ALLOWED_SAFETY;
  assert.deepEqual(filterTools(ITEMS), ITEMS);
});

test('keeps only the single allowed tier', () => {
  process.env.TIE_ALLOWED_SAFETY = 'read';
  assert.deepEqual(
    filterTools(ITEMS).map((t) => t.name),
    ['a']
  );
});

test('parses a comma list and trims whitespace', () => {
  process.env.TIE_ALLOWED_SAFETY = ' read , write ';
  assert.deepEqual(
    filterTools(ITEMS).map((t) => t.name),
    ['a', 'b']
  );
});

test('an unknown tier matches nothing', () => {
  process.env.TIE_ALLOWED_SAFETY = 'bogus';
  assert.deepEqual(filterTools(ITEMS), []);
});

test('empty string behaves like unset (all tools)', () => {
  process.env.TIE_ALLOWED_SAFETY = '';
  assert.deepEqual(filterTools(ITEMS), ITEMS);
});
