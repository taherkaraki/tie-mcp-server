/**
 * Tests for control-graph assembly (src/graph/graph.ts): node building, edge
 * target resolution (DN/SID -> node key), bidirectional adjacency, and the
 * out-of-scope (dangling) reference count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlGraph, type Edge } from '../src/graph/graph.js';
import type { StoredADObject } from '../src/ad-object-store.js';

function obj(record: Record<string, unknown>, objectId: string): StoredADObject {
  return {
    id: 0,
    objectId,
    type: 'LDAP',
    directoryId: 1,
    record,
    raw: { id: 0, objectId, type: 'LDAP', directoryId: 1, objectAttributes: [] },
  };
}

// A tiny domain: bob is a member of "Helpdesk"; Helpdesk has GenericAll on
// dcadmin (via SDDL); dcadmin is a member of Domain Admins.
function fixture(): StoredADObject[] {
  const domainAdmins = obj(
    {
      objectsid: 'S-1-5-21-1-2-3-512',
      cn: 'Domain Admins',
      samaccountname: 'Domain Admins',
      distinguishedname: 'CN=Domain Admins,CN=Users,DC=x',
      objectclass: ['top', 'group'],
    },
    '1:da'
  );
  const dcadmin = obj(
    {
      objectsid: 'S-1-5-21-1-2-3-1105',
      cn: 'dcadmin',
      samaccountname: 'dcadmin',
      distinguishedname: 'CN=dcadmin,CN=Users,DC=x',
      objectclass: ['top', 'person', 'user'],
      memberof: ['CN=Domain Admins,CN=Users,DC=x'],
    },
    '1:dcadmin'
  );
  const helpdesk = obj(
    {
      objectsid: 'S-1-5-21-1-2-3-1200',
      cn: 'Helpdesk',
      samaccountname: 'Helpdesk',
      distinguishedname: 'CN=Helpdesk,OU=Groups,DC=x',
      objectclass: ['top', 'group'],
      // Helpdesk has GenericAll over dcadmin.
      // (edge is emitted from dcadmin's SDDL below instead; keep group plain)
    },
    '1:helpdesk'
  );
  // Put the GenericAll ACE on dcadmin, granting Helpdesk full control of it.
  dcadmin.record['ntsecuritydescriptor'] =
    'O:S-1-5-18D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-5-21-1-2-3-1200)';
  const bob = obj(
    {
      objectsid: 'S-1-5-21-1-2-3-2000',
      cn: 'bob',
      samaccountname: 'bob',
      distinguishedname: 'CN=bob,OU=Users,DC=x',
      objectclass: ['top', 'person', 'user'],
      memberof: ['CN=Helpdesk,OU=Groups,DC=x'],
    },
    '1:bob'
  );
  return [domainAdmins, dcadmin, helpdesk, bob];
}

const T = () => 1_000; // fixed clock so builtMs is deterministic (0)

test('builds nodes keyed by SID with classified types', () => {
  const g = ControlGraph.build(fixture(), undefined, T);
  assert.equal(g.node('S-1-5-21-1-2-3-512')?.type, 'group');
  assert.equal(g.node('S-1-5-21-1-2-3-1105')?.type, 'user');
  assert.equal(g.node('s-1-5-21-1-2-3-2000')?.name, 'bob'); // case-insensitive
});

test('resolves memberof DN edges to the group node', () => {
  const g = ControlGraph.build(fixture(), undefined, T);
  // bob --MemberOf--> Helpdesk (resolved from DN to SID node key)
  const out = forwardOf(g, 's-1-5-21-1-2-3-2000');
  const m = out.find((e) => e.kind === 'MemberOf');
  assert.ok(m);
  assert.equal(m!.to, 's-1-5-21-1-2-3-1200');
});

test('resolves SDDL GenericAll edge to the target object', () => {
  const g = ControlGraph.build(fixture(), undefined, T);
  // Helpdesk --GenericAll--> dcadmin
  const out = forwardOf(g, 's-1-5-21-1-2-3-1200');
  const ga = out.find((e) => e.kind === 'GenericAll');
  assert.ok(ga);
  assert.equal(ga!.to, 's-1-5-21-1-2-3-1105');
});

test('reverse adjacency mirrors forward (for exposure queries)', () => {
  const g = ControlGraph.build(fixture(), undefined, T);
  // Domain Admins should have inbound edges (dcadmin is a member).
  const inbound = reverseOf(g, 's-1-5-21-1-2-3-512');
  assert.ok(inbound.some((e) => e.kind === 'MemberOf' && e.from === 's-1-5-21-1-2-3-1105'));
});

test('unresolvable (cross-domain / out-of-scope) targets count as dangling', () => {
  const foreign = obj(
    {
      objectsid: 'S-1-5-21-9-9-9-1000',
      cn: 'ext',
      distinguishedname: 'CN=ext,DC=other',
      objectclass: ['user'],
      // memberof points at a group not in this store
      memberof: ['CN=Nonexistent,DC=other'],
    },
    '2:ext'
  );
  const g = ControlGraph.build([foreign], undefined, T);
  // Two unresolvable refs dangle: the memberof group, and the Contains parent
  // (CN=ext's parent DC=other is not a resolvable object). No edges created.
  assert.equal(g.stats().dangling, 2);
  assert.equal(g.stats().edges, 0);
});

test('stats report node and edge counts', () => {
  const g = ControlGraph.build(fixture(), undefined, T);
  const s = g.stats();
  assert.equal(s.nodes, 4);
  assert.ok(s.edges >= 3); // bob->Helpdesk, Helpdesk->dcadmin, dcadmin->DA
});

// Adjacency read via the public traversal accessors.
function forwardOf(g: ControlGraph, key: string): readonly Edge[] {
  return g.edgesFrom(key);
}
function reverseOf(g: ControlGraph, key: string): readonly Edge[] {
  return g.edgesTo(key);
}

test('GPO -> OU -> child chain composes through GpoAppliesTo + Contains (Phase 4a)', () => {
  // A GPO, an OU that links it, and a computer contained in that OU.
  const gpo = obj(
    {
      cn: '{POLICY-GUID}',
      distinguishedname: 'CN={POLICY-GUID},CN=Policies,CN=System,DC=x',
      objectclass: ['top', 'groupPolicyContainer'],
    },
    '1:gpo'
  );
  const ou = obj(
    {
      cn: 'Workstations',
      distinguishedname: 'OU=Workstations,DC=x',
      objectclass: ['top', 'organizationalUnit'],
      gplink: '[LDAP://CN={POLICY-GUID},CN=Policies,CN=System,DC=x;0]',
    },
    '1:ou'
  );
  const comp = obj(
    {
      objectsid: 'S-1-5-21-1-2-3-1500',
      cn: 'WS01',
      samaccountname: 'WS01$',
      distinguishedname: 'CN=WS01,OU=Workstations,DC=x',
      objectclass: ['top', 'computer'],
    },
    '1:ws01'
  );
  const g = ControlGraph.build([gpo, ou, comp], undefined, T);

  // GPO --GpoAppliesTo--> OU
  const gpoOut = g.edgesFrom('1:gpo');
  const applies = gpoOut.find((e) => e.kind === 'GpoAppliesTo');
  assert.ok(applies, 'GPO should point at the OU it applies to');
  assert.equal(applies!.to, '1:ou');

  // OU --Contains--> computer
  const ouOut = g.edgesFrom('1:ou');
  const contains = ouOut.find((e) => e.kind === 'Contains');
  assert.ok(contains, 'OU should contain the computer');
  assert.equal(contains!.to, 's-1-5-21-1-2-3-1500');
});
