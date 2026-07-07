/**
 * Invariants over the auto-generated tool descriptors (src/generated/tools.ts).
 *
 * These guard against a regenerated spec silently changing the tool surface:
 * a dropped/renamed tool, a bad safety tier, a path param that doesn't line up
 * with the path template, or the profile-scope hint failing to be baked in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../src/generated/tools.js';

const SAFETY_TIERS = new Set(['read', 'write', 'destructive']);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

test('exposes exactly 131 generated tools', () => {
  assert.equal(tools.length, 131);
});

test('all tool names are unique', () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('every tool has a valid safety tier and HTTP method', () => {
  for (const t of tools) {
    assert.ok(SAFETY_TIERS.has(t.safety), `bad safety on ${t.name}: ${t.safety}`);
    assert.ok(METHODS.has(t.method), `bad method on ${t.name}: ${t.method}`);
  }
});

test('pathParams and {placeholders} in the path agree exactly', () => {
  for (const t of tools) {
    const inPath = [...t.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
    const declared = [...t.pathParams].sort();
    assert.deepEqual(declared, inPath, `path params mismatch on ${t.name} (${t.path})`);
  }
});

test('every inputSchema is an object schema', () => {
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', `bad inputSchema on ${t.name}`);
  }
});

test('spot-check: get_about is a read GET', () => {
  const about = tools.find((t) => t.name === 'get_about');
  assert.ok(about, 'get_about missing');
  assert.equal(about!.safety, 'read');
  assert.equal(about!.method, 'get');
});

test('spot-check: at least one destructive delete_* tool exists', () => {
  const destructive = tools.filter((t) => t.safety === 'destructive');
  assert.ok(destructive.length > 0, 'no destructive tools found');
  assert.ok(
    destructive.some((t) => t.name.startsWith('delete_')),
    'expected a delete_* tool among destructive tools'
  );
});

test('profile-scoped tools carry the preferred-profile hint', () => {
  const profileScoped = tools.filter((t) => t.path.includes('{profileId}'));
  assert.ok(profileScoped.length > 0, 'expected some {profileId} tools');
  for (const t of profileScoped) {
    assert.match(
      t.description,
      /get_preferred_profile/,
      `missing profile hint on ${t.name}`
    );
  }
});
