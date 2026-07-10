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
  parentDn,
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

test('DCSync requires BOTH replication rights AND the domain head (Phase 4a)', () => {
  const bothRights =
    'D:(OA;;CR;1131f6aa-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)' +
    '(OA;;CR;1131f6ad-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)';
  // On the domain head, both rights => DCSync.
  const onDomain = sddlEdges(
    obj({ objectsid: 'S-1-5-21-1-2-3', objectclass: ['top', 'domainDNS'], ntsecuritydescriptor: bothRights })
  );
  assert.ok(onDomain.some((x) => x.kind === 'DCSync'));

  // Same ACEs on a NON-domain object => no DCSync (scoping fix); the templated
  // replication ACE no longer fans out onto child objects.
  const offDomain = sddlEdges(
    obj({ objectsid: 'S-1-5-21-1-2-3-1500', objectclass: ['top', 'group'], ntsecuritydescriptor: bothRights })
  );
  assert.ok(!offDomain.some((x) => x.kind === 'DCSync'));

  // One right on the domain head => still no DCSync.
  const oneRight =
    'D:(OA;;CR;1131f6aa-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)';
  const e2 = sddlEdges(
    obj({ objectsid: 'S-1-5-21-1-2-3', objectclass: ['top', 'domainDNS'], ntsecuritydescriptor: oneRight })
  );
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

test('parentDn strips the first RDN, respecting escaped commas', () => {
  assert.equal(parentDn('CN=bob,OU=Users,DC=alsid,DC=corp'), 'OU=Users,DC=alsid,DC=corp');
  assert.equal(parentDn('OU=Users,DC=alsid,DC=corp'), 'DC=alsid,DC=corp');
  // Escaped comma inside the RDN value must not be treated as a separator.
  assert.equal(parentDn('CN=Doe\\, John,OU=Users,DC=x'), 'OU=Users,DC=x');
  // A single RDN has no parent.
  assert.equal(parentDn('DC=corp'), null);
});

test('Contains edge: parent container -> child (via containment)', () => {
  const e = attributeEdges(obj({
    objectsid: 'S-1-5-21-1-2-3-1105',
    distinguishedname: 'CN=bob,OU=Users,DC=alsid,DC=corp',
  }));
  const c = e.find((x) => x.kind === 'Contains');
  assert.ok(c);
  assert.equal(c!.from, 'OU=Users,DC=alsid,DC=corp'); // parent DN
  assert.equal(c!.fromRef, 'dn');
  assert.equal(c!.targetRef, 'key'); // child is this object's node key
});

test('GpLink and GpoAppliesTo are emitted as inverse edges per link', () => {
  const e = attributeEdges(obj({
    objectsid: undefined,
    cn: 'Sales OU',
    distinguishedname: 'OU=Sales,DC=x',
    gplink: '[LDAP://cn={31B2F340-016D-11D2-945F-00C04FB984F9},cn=policies,cn=system,DC=x;0]',
  }, '1:sales-ou'));
  const gplink = e.find((x) => x.kind === 'GpLink');
  const applies = e.find((x) => x.kind === 'GpoAppliesTo');
  assert.ok(gplink, 'OU -> GPO provenance edge');
  assert.ok(applies, 'GPO -> OU attack-direction edge');
  // GpoAppliesTo points FROM the GPO (dn) TO this OU (node key).
  assert.equal(applies!.fromRef, 'dn');
  assert.equal(applies!.targetRef, 'key');
});
