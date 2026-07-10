/**
 * Tests for the SDDL parser (src/graph/sddl.ts).
 *
 * Covers owner/group extraction, allow/deny/object ACEs, rights token splitting,
 * inheritance flags, hex masks, and the defensive no-throw contract. Includes a
 * realistic multi-ACE descriptor shaped like the live-tenant data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSddl } from '../src/graph/sddl.js';

test('extracts owner and group SIDs', () => {
  const sd = parseSddl('O:S-1-5-32-544G:S-1-5-21-1-2-3-512D:AI(A;;RP;;;S-1-1-0)');
  assert.equal(sd.owner, 'S-1-5-32-544');
  assert.equal(sd.group, 'S-1-5-21-1-2-3-512');
  assert.equal(sd.malformed, false);
});

test('parses a plain allow ACE with combined rights', () => {
  const sd = parseSddl('O:S-1-5-18G:S-1-5-18D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-5-21-1-2-3-512)');
  assert.equal(sd.dacl.length, 1);
  const ace = sd.dacl[0];
  assert.equal(ace.isAllow, true);
  assert.equal(ace.trustee, 'S-1-5-21-1-2-3-512');
  assert.ok(ace.rights.includes('CC'));
  assert.ok(ace.rights.includes('WD'));
  assert.ok(ace.rights.includes('WO'));
});

test('marks deny ACEs as not-allow', () => {
  const sd = parseSddl('D:(D;;WP;;;S-1-1-0)');
  assert.equal(sd.dacl[0].isAllow, false);
  assert.equal(sd.dacl[0].type, 'D');
});

test('parses object ACE with object-type and inherited-object-type GUIDs', () => {
  const sd = parseSddl(
    'D:(OA;CIID;CR;00299570-246d-11d0-a768-00aa006e0529;bf967aba-0de6-11d0-a285-00aa003049e2;S-1-5-21-1-2-3-1234)'
  );
  const ace = sd.dacl[0];
  assert.equal(ace.isObjectAce, true);
  assert.equal(ace.objectType, '00299570-246d-11d0-a768-00aa006e0529');
  assert.equal(ace.inheritedObjectType, 'bf967aba-0de6-11d0-a285-00aa003049e2');
  assert.ok(ace.rights.includes('CR'));
});

test('detects inherited ACEs via the ID flag', () => {
  const sd = parseSddl('D:(A;CIID;RP;;;S-1-5-11)(A;;RP;;;S-1-5-18)');
  assert.equal(sd.dacl[0].inherited, true); // has ID
  assert.equal(sd.dacl[1].inherited, false); // no ID
});

test('preserves a hex rights mask', () => {
  const sd = parseSddl('D:(A;;0x100;;;S-1-1-0)');
  assert.equal(sd.dacl[0].rightsRaw, '0x100');
  assert.deepEqual(sd.dacl[0].rights, []); // not split as mnemonics
});

test('captures DACL flags between D: and the first ACE', () => {
  const sd = parseSddl('O:S-1-5-18D:PAI(A;;RP;;;S-1-1-0)');
  assert.equal(sd.daclFlags, 'PAI');
});

test('parses multiple ACEs and stops at the SACL', () => {
  const sd = parseSddl(
    'O:S-1-5-18G:S-1-5-18D:AI(A;;RP;;;S-1-1-0)(A;;WP;;;S-1-5-11)(A;;GA;;;S-1-5-21-1-2-3-512)S:(AU;SA;WP;;;S-1-1-0)'
  );
  assert.equal(sd.dacl.length, 3); // SACL ACE not counted
  assert.equal(sd.dacl[2].trustee, 'S-1-5-21-1-2-3-512');
});

test('never throws on malformed input', () => {
  for (const bad of ['', 'garbage', 'O:D:(', 'D:(A;;RP)', '(((']) {
    assert.doesNotThrow(() => parseSddl(bad));
  }
  const sd = parseSddl('D:(A;;RP)'); // too few ACE fields
  assert.equal(sd.malformed, true);
});

test('handles a descriptor with owner only, no DACL', () => {
  const sd = parseSddl('O:S-1-5-18G:S-1-5-18');
  assert.equal(sd.owner, 'S-1-5-18');
  assert.equal(sd.dacl.length, 0);
  assert.equal(sd.malformed, false);
});
