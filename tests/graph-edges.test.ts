/**
 * Tests for control-edge derivation (src/graph/edges.ts).
 *
 * Verifies BOTH edge sources: plain attributes (membership, primaryGroup,
 * delegation, RBCD, sidHistory, gplink) and the SDDL DACL/owner — with the
 * precise right semantics (WP-on-member => AddMember, DCSync needs both rights).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeEdges,
  sddlEdges,
  edgesForObject,
  nodeKeyFor,
} from '../src/graph/edges.js';
import type { StoredADObject } from '../src/ad-object-store.js';

function obj(record: Record<string, unknown>, objectId = '1:guid-x'): StoredADObject {
  return {
    id: 1,
    objectId,
    type: 'LDAP',
    directoryId: 1,
    record,
    raw: { id: 1, objectId, type: 'LDAP', directoryId: 1, objectAttributes: [] },
  };
}

function kinds(edges: { kind: string }[]): string[] {
  return edges.map((e) => e.kind).sort();
}

test('nodeKeyFor prefers objectSID, falls back to objectId', () => {
  assert.equal(nodeKeyFor(obj({ objectsid: 'S-1-5-21-1-2-3-512' })), 's-1-5-21-1-2-3-512');
  assert.equal(nodeKeyFor(obj({}, '1:OU-GUID')), '1:ou-guid');
});

test('memberof produces a MemberOf edge to the group DN', () => {
  const e = attributeEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-1105',
    memberof: ['CN=Domain Admins,CN=Users,DC=alsid,DC=corp'],
  }));
  const m = e.find((x) => x.kind === 'MemberOf' && x.via === 'member');
  assert.ok(m);
  assert.equal(m!.targetRef, 'dn');
  assert.equal(m!.to, 'CN=Domain Admins,CN=Users,DC=alsid,DC=corp');
});

test('primaryGroupID yields a MemberOf edge to domain+RID', () => {
  const e = attributeEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-1105',
    primarygroupid: 513,
  }));
  const pg = e.find((x) => x.via === 'primaryGroup');
  assert.ok(pg);
  assert.equal(pg!.to, 's-1-5-21-1-2-3-513');
});

test('sidHistory yields a SIDHistory edge per carried SID', () => {
  const e = attributeEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-1105',
    sidhistory: ['S-1-5-21-1-2-3-512'],
  }));
  const sh = e.find((x) => x.kind === 'SIDHistory');
  assert.ok(sh);
  assert.equal(sh!.to, 's-1-5-21-1-2-3-512');
});

test('constrained delegation and RBCD are captured', () => {
  const deleg = attributeEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-1105',
    'msds-allowedtodelegateto': ['HOST/dc01.alsid.corp'],
  }));
  assert.ok(deleg.some((x) => x.kind === 'AllowedToDelegate'));

  const rbcd = attributeEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-2000',
    'msds-allowedtoactonbehalfofotheridentity': 'O:...D:(A;;...)',
  }));
  assert.ok(rbcd.some((x) => x.kind === 'AllowedToAct'));
});

test('SDDL owner produces an Owns edge', () => {
  const e = sddlEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-9',
    ntsecuritydescriptor: 'O:S-1-5-21-1-2-3-512G:S-1-5-18D:(A;;RP;;;S-1-1-0)',
  }));
  const owns = e.find((x) => x.kind === 'Owns');
  assert.ok(owns);
  assert.equal(owns!.from, 's-1-5-21-1-2-3-512');
});

test('full-control ACE => GenericAll', () => {
  const e = sddlEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-9',
    ntsecuritydescriptor: 'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-5-21-1-2-3-1105)',
  }));
  assert.deepEqual(kinds(e), ['GenericAll']);
});

test('WriteProperty on member GUID => AddMember, not GenericWrite', () => {
  const e = sddlEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-9',
    ntsecuritydescriptor:
      'D:(OA;;WP;bf9679c0-0de6-11d0-a285-00aa003049e2;;S-1-5-21-1-2-3-1105)',
  }));
  assert.deepEqual(kinds(e), ['AddMember']);
});

test('WriteProperty with no object-type => GenericWrite', () => {
  const e = sddlEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-9',
    ntsecuritydescriptor: 'D:(A;;WP;;;S-1-5-21-1-2-3-1105)',
  }));
  assert.deepEqual(kinds(e), ['GenericWrite']);
});

test('DCSync requires BOTH replication rights for the same trustee', () => {
  const bothRights =
    'D:(OA;;CR;1131f6aa-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)' +
    '(OA;;CR;1131f6ad-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)';
  const e = sddlEdges(obj({ objectsid: 'S-1-5-21-1-2-3', ntsecuritydescriptor: bothRights }));
  assert.ok(e.some((x) => x.kind === 'DCSync'));

  const oneRight =
    'D:(OA;;CR;1131f6aa-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)';
  const e2 = sddlEdges(obj({ objectsid: 'S-1-5-21-1-2-3', ntsecuritydescriptor: oneRight }));
  assert.ok(!e2.some((x) => x.kind === 'DCSync'));
});

test('ForceChangePassword edge from the extended right', () => {
  const e = sddlEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-1200',
    ntsecuritydescriptor:
      'D:(OA;;CR;00299570-246d-11d0-a768-00aa006e0529;;S-1-5-21-1-2-3-1105)',
  }));
  assert.ok(e.some((x) => x.kind === 'ForceChangePassword'));
});

test('deny ACEs and SELF trustee produce no edge', () => {
  const e = sddlEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-9',
    ntsecuritydescriptor: 'D:(D;;GA;;;S-1-1-0)(A;;GA;;;S-1-5-10)',
  }));
  assert.deepEqual(e, []);
});

test('edgesForObject merges attribute and SDDL edges', () => {
  const e = edgesForObject(obj({
    objectsid: 'S-1-5-21-1-2-3-1105',
    memberof: ['CN=G,DC=x'],
    ntsecuritydescriptor: 'O:S-1-5-21-1-2-3-512D:(A;;GA;;;S-1-5-21-1-2-3-777)',
  }));
  assert.ok(e.some((x) => x.kind === 'MemberOf'));
  assert.ok(e.some((x) => x.kind === 'Owns'));
  assert.ok(e.some((x) => x.kind === 'GenericAll'));
});
