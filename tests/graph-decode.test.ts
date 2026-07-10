/**
 * Tests for the human-readable security-descriptor decoder
 * (src/graph/decode.ts) and the schema map (src/graph/schema-map.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSecurityDescriptor } from '../src/graph/decode.js';
import { buildSchemaMap } from '../src/graph/schema-map.js';

const RESOLVE: Record<string, string> = {
  'S-1-5-21-1-2-3-512': 'Domain Admins',
  'S-1-5-21-1-2-3-1105': 'bob.shaft',
};
const resolver = (sid: string) => RESOLVE[sid] ?? null;

test('decodes owner/group and resolves SIDs to names', () => {
  const d = decodeSecurityDescriptor(
    'O:S-1-5-21-1-2-3-512G:S-1-5-21-1-2-3-512D:(A;;RP;;;S-1-1-0)',
    resolver
  );
  assert.equal(d.owner?.name, 'Domain Admins');
  assert.equal(d.group?.name, 'Domain Admins');
});

test('names rights and flags broad trustees', () => {
  const d = decodeSecurityDescriptor('D:(A;;WP;;;S-1-1-0)', resolver);
  const ace = d.aces[0];
  assert.equal(ace.effect, 'Allow');
  assert.equal(ace.trustee.sid, 'S-1-1-0');
  assert.equal(ace.trustee.name, 'Everyone'); // via well-known fallback
  assert.equal(ace.trustee.broad, true);
  assert.deepEqual(ace.rights, ['WriteProperty']);
});

test('collapses full-control sequence to GenericAll', () => {
  const d = decodeSecurityDescriptor(
    'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-5-21-1-2-3-1105)',
    resolver
  );
  assert.deepEqual(d.aces[0].rights, ['GenericAll']);
  assert.equal(d.aces[0].trustee.name, 'bob.shaft');
});

test('marks deny effect', () => {
  const d = decodeSecurityDescriptor('D:(D;;WP;;;S-1-1-0)');
  assert.equal(d.aces[0].effect, 'Deny');
});

test('names the object-type via the schema map', () => {
  // Force-change-password extended right is a seeded well-known GUID.
  const schema = buildSchemaMap([]);
  const d = decodeSecurityDescriptor(
    'D:(OA;;CR;00299570-246d-11d0-a768-00aa006e0529;;S-1-5-21-1-2-3-1105)',
    resolver,
    schema
  );
  assert.equal(d.aces[0].appliesTo, 'User-Force-Change-Password');
});

test('schema map resolves GUIDs from resident schema objects', () => {
  const schema = buildSchemaMap([
    {
      record: {
        schemaidguid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        ldapdisplayname: 'msDS-CustomAttr',
      },
    },
  ]);
  assert.equal(
    schema.resolve('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'),
    'msDS-CustomAttr'
  ); // case-insensitive
  assert.equal(schema.resolve('no-such-guid'), null);
});

test('unresolved SIDs and object-types degrade to null / raw GUID', () => {
  const d = decodeSecurityDescriptor('D:(OA;;CR;deadbeef-0000-0000-0000-000000000000;;S-1-5-21-9-9-9-1234)');
  assert.equal(d.aces[0].trustee.name, null); // unknown SID, no resolver
  assert.equal(d.aces[0].appliesTo, 'deadbeef-0000-0000-0000-000000000000'); // raw GUID kept
});
