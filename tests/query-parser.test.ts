/**
 * Tests for the lexer + parser (src/query/lexer.ts, src/query/parser.ts).
 *
 * Focuses on precedence (OR < AND < NOT), grouping, operand typing, and the
 * syntax errors that guard malformed input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, type QueryNode } from '../src/query/parser.js';
import { QuerySyntaxError } from '../src/query/lexer.js';

test('single comparison parses to a comparison node', () => {
  const ast = parseQuery('admincount>0');
  assert.equal(ast.type, 'comparison');
  if (ast.type === 'comparison') {
    assert.equal(ast.field, 'admincount');
    assert.equal(ast.op, '>');
    assert.deepEqual(ast.operand, { kind: 'number', raw: '0', num: 0 });
  }
});

test('quoted string operand keeps spaces and is typed string', () => {
  const ast = parseQuery('cn:"Domain Admins"');
  assert.equal(ast.type, 'comparison');
  if (ast.type === 'comparison') {
    assert.equal(ast.op, ':');
    assert.deepEqual(ast.operand, { kind: 'string', raw: 'Domain Admins' });
  }
});

test('AND binds tighter than OR', () => {
  // a=1 OR b=2 AND c=3  =>  a=1 OR (b=2 AND c=3)
  const ast = parseQuery('a=1 OR b=2 AND c=3');
  assert.equal(ast.type, 'logical');
  if (ast.type === 'logical') {
    assert.equal(ast.op, 'OR');
    assert.equal(ast.left.type, 'comparison');
    assert.equal(ast.right.type, 'logical');
    if (ast.right.type === 'logical') assert.equal(ast.right.op, 'AND');
  }
});

test('parentheses override precedence', () => {
  // (a=1 OR b=2) AND c=3  =>  root is AND
  const ast = parseQuery('(a=1 OR b=2) AND c=3');
  assert.equal(ast.type, 'logical');
  if (ast.type === 'logical') {
    assert.equal(ast.op, 'AND');
    assert.equal(ast.left.type, 'logical');
    if (ast.left.type === 'logical') assert.equal(ast.left.op, 'OR');
  }
});

test('NOT binds to the following term', () => {
  const ast = parseQuery('NOT enabled=true AND admincount>0');
  // => (NOT enabled=true) AND admincount>0
  assert.equal(ast.type, 'logical');
  if (ast.type === 'logical') {
    assert.equal(ast.op, 'AND');
    assert.equal(ast.left.type, 'not');
  }
});

test('the motivating example parses without error', () => {
  const ast: QueryNode = parseQuery(
    '((admincount>0 AND isdeviant=true) OR (useraccountcontrol:"Normal" AND badpwdcount=10))'
  );
  assert.equal(ast.type, 'logical');
});

test('bitwise operators parse as comparisons', () => {
  const ast = parseQuery('useraccountcontrol & 2');
  assert.equal(ast.type, 'comparison');
  if (ast.type === 'comparison') assert.equal(ast.op, '&');
});

test('empty query throws', () => {
  assert.throws(() => parseQuery('   '), QuerySyntaxError);
});

test('missing operator throws with a position', () => {
  try {
    parseQuery('admincount 0');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof QuerySyntaxError);
    assert.equal(typeof (err as QuerySyntaxError).pos, 'number');
  }
});

test('unterminated string throws', () => {
  assert.throws(() => parseQuery('cn:"unterminated'), QuerySyntaxError);
});

test('trailing input throws', () => {
  assert.throws(() => parseQuery('a=1 b=2'), QuerySyntaxError);
});
