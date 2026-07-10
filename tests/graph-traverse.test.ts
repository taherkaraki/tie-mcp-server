/**
 * Tests for control-graph traversal (src/graph/traverse.ts): forward blast
 * radius, shortest paths, reverse exposure, and the depth/node guardrails with
 * honest truncation reporting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlGraph } from '../src/graph/graph.js';
import {
  reachable,
  shortestPath,
  derivedTier0,
  DEFAULT_MAX_DEPTH,
} from '../src/graph/traverse.js';
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

const T = () => 0;

/**
 * Chain fixture: bob -MemberOf-> Helpdesk -GenericAll-> dcadmin -MemberOf->
 * Domain Admins. (Same shape as the assembly test, reused for traversal.)
 */
function chain(): ControlGraph {
  const da = obj(
    { objectsid: 'S-1-5-21-1-2-3-512', cn: 'Domain Admins', samaccountname: 'Domain Admins',
      distinguishedname: 'CN=Domain Admins,DC=x', objectclass: ['group'] },
    '1:da'
  );
  const dcadmin = obj(
    { objectsid: 'S-1-5-21-1-2-3-1105', cn: 'dcadmin', samaccountname: 'dcadmin',
      distinguishedname: 'CN=dcadmin,DC=x', objectclass: ['user'],
      memberof: ['CN=Domain Admins,DC=x'],
      ntsecuritydescriptor: 'O:S-1-5-18D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-5-21-1-2-3-1200)' },
    '1:dcadmin'
  );
  const helpdesk = obj(
    { objectsid: 'S-1-5-21-1-2-3-1200', cn: 'Helpdesk', samaccountname: 'Helpdesk',
      distinguishedname: 'CN=Helpdesk,DC=x', objectclass: ['group'] },
    '1:helpdesk'
  );
  const bob = obj(
    { objectsid: 'S-1-5-21-1-2-3-2000', cn: 'bob', samaccountname: 'bob',
      distinguishedname: 'CN=bob,DC=x', objectclass: ['user'],
      memberof: ['CN=Helpdesk,DC=x'] },
    '1:bob'
  );
  return ControlGraph.build([da, dcadmin, helpdesk, bob], undefined, T);
}

test('forward reachability finds the full chain from bob', () => {
  const g = chain();
  const res = reachable(g, ['s-1-5-21-1-2-3-2000'], 'forward');
  const keys = res.reached.map((r) => r.node.key);
  assert.ok(keys.includes('s-1-5-21-1-2-3-1200')); // Helpdesk (depth 1)
  assert.ok(keys.includes('s-1-5-21-1-2-3-1105')); // dcadmin (depth 2)
  assert.ok(keys.includes('s-1-5-21-1-2-3-512')); // Domain Admins (depth 3)
  assert.equal(res.truncated, null);
});

test('BFS depth reflects shortest hop count', () => {
  const g = chain();
  const res = reachable(g, ['s-1-5-21-1-2-3-2000'], 'forward');
  const da = res.reached.find((r) => r.node.key === 's-1-5-21-1-2-3-512');
  assert.equal(da?.depth, 3);
  assert.equal(da?.path.length, 3); // three edges in the chain
});

test('shortestPath returns the edge chain bob -> Domain Admins', () => {
  const g = chain();
  const r = shortestPath(g, 's-1-5-21-1-2-3-2000', 's-1-5-21-1-2-3-512');
  assert.ok('depth' in r && r.path);
  if (r.path) {
    assert.equal(r.depth, 3);
    assert.deepEqual(
      r.path.map((s) => s.kind),
      ['MemberOf', 'GenericAll', 'MemberOf']
    );
  }
});

test('shortestPath reports unreachable when no path exists', () => {
  const g = chain();
  // Domain Admins has no outbound control edges to bob.
  const r = shortestPath(g, 's-1-5-21-1-2-3-512', 's-1-5-21-1-2-3-2000');
  assert.equal(r.path, null);
});

test('reverse exposure finds who can reach Domain Admins', () => {
  const g = chain();
  const res = reachable(g, ['s-1-5-21-1-2-3-512'], 'reverse');
  const keys = res.reached.map((r) => r.node.key);
  // dcadmin, Helpdesk, and bob all have inbound control paths to DA.
  assert.ok(keys.includes('s-1-5-21-1-2-3-1105'));
  assert.ok(keys.includes('s-1-5-21-1-2-3-1200'));
  assert.ok(keys.includes('s-1-5-21-1-2-3-2000'));
});

test('maxDepth caps hops and flags depth truncation', () => {
  const g = chain();
  const res = reachable(g, ['s-1-5-21-1-2-3-2000'], 'forward', { maxDepth: 1 });
  const keys = res.reached.map((r) => r.node.key);
  assert.ok(keys.includes('s-1-5-21-1-2-3-1200')); // Helpdesk at depth 1
  assert.ok(!keys.includes('s-1-5-21-1-2-3-512')); // DA is beyond depth 1
  assert.equal(res.truncated, 'depth');
});

test('maxNodes caps results and flags node truncation', () => {
  const g = chain();
  const res = reachable(g, ['s-1-5-21-1-2-3-2000'], 'forward', { maxNodes: 1 });
  assert.equal(res.reached.length, 1);
  assert.equal(res.truncated, 'nodes');
});

test('a fully explored graph reports no truncation', () => {
  const g = chain();
  const res = reachable(g, ['s-1-5-21-1-2-3-2000'], 'forward', {
    maxDepth: DEFAULT_MAX_DEPTH,
  });
  assert.equal(res.truncated, null);
});

test('cycles do not cause infinite traversal', () => {
  // A -MemberOf-> B -MemberOf-> A (nested-group loop).
  const a = obj(
    { objectsid: 'S-1-5-21-9-9-9-1', cn: 'A', samaccountname: 'A',
      distinguishedname: 'CN=A,DC=x', objectclass: ['group'], memberof: ['CN=B,DC=x'] },
    '1:a'
  );
  const b = obj(
    { objectsid: 'S-1-5-21-9-9-9-2', cn: 'B', samaccountname: 'B',
      distinguishedname: 'CN=B,DC=x', objectclass: ['group'], memberof: ['CN=A,DC=x'] },
    '1:b'
  );
  const g = ControlGraph.build([a, b], undefined, T);
  const res = reachable(g, ['s-1-5-21-9-9-9-1'], 'forward');
  // B reachable; A is the start (not re-listed); terminates.
  assert.ok(res.reached.some((r) => r.node.key === 's-1-5-21-9-9-9-2'));
  assert.equal(res.truncated, null);
});

test('derivedTier0 includes seeds plus everyone who can reach them', () => {
  // Domain Admins (-512) is the only seed; bob, Helpdesk, and dcadmin all have
  // inbound control paths, so all are de facto Tier-0. (Local System S-1-5-18
  // also appears: it owns dcadmin via the SDDL owner field, a real Owns edge.)
  const g = chain();
  const { keys, truncated } = derivedTier0(g, ['s-1-5-21-1-2-3-512']);
  assert.equal(truncated, null);
  assert.ok(keys.includes('s-1-5-21-1-2-3-512')); // seed itself
  assert.ok(keys.includes('s-1-5-21-1-2-3-1105')); // dcadmin
  assert.ok(keys.includes('s-1-5-21-1-2-3-1200')); // Helpdesk
  assert.ok(keys.includes('s-1-5-21-1-2-3-2000')); // bob
});

test('derivedTier0 with no seeds returns empty', () => {
  const g = chain();
  assert.deepEqual(derivedTier0(g, []), { keys: [], truncated: null });
});

test('derivedTier0 respects maxDepth and reports truncation', () => {
  const g = chain();
  // Depth 1 from the seed only reaches its direct controllers (dcadmin).
  const { keys, truncated } = derivedTier0(g, ['s-1-5-21-1-2-3-512'], { maxDepth: 1 });
  assert.ok(keys.includes('s-1-5-21-1-2-3-1105')); // dcadmin, depth 1
  assert.ok(!keys.includes('s-1-5-21-1-2-3-2000')); // bob is 3 hops away
  assert.equal(truncated, 'depth');
});

// --- Phase 4b: virtual Controls expansion --------------------------------
// A domain head + two in-domain principals; one (attacker) can DCSync the
// domain, the other (victim) is just a member of the domain.
function domainFixture(): ControlGraph {
  const domain = obj(
    { objectsid: 'S-1-5-21-1-2-3', cn: 'corp', samaccountname: 'corp',
      distinguishedname: 'DC=corp', objectclass: ['top', 'domainDNS'],
      // attacker holds both replication rights on the domain head -> DCSync.
      ntsecuritydescriptor:
        'D:(OA;;CR;1131f6aa-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)' +
        '(OA;;CR;1131f6ad-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105)' },
    '1:dom'
  );
  const attacker = obj(
    { objectsid: 'S-1-5-21-1-2-3-1105', cn: 'attacker', samaccountname: 'attacker',
      distinguishedname: 'CN=attacker,DC=corp', objectclass: ['user'] },
    '1:atk'
  );
  // Victim sits under a deep OU so it is NOT a direct child of the domain head;
  // only the virtual Controls edge (not one-level Contains) should reach it.
  // We omit the intervening OU objects so no Contains chain exists either.
  const victim = obj(
    { objectsid: 'S-1-5-21-1-2-3-2500', cn: 'crownjewel', samaccountname: 'crownjewel',
      distinguishedname: 'CN=crownjewel,OU=Tier0,OU=Admins,DC=corp', objectclass: ['user'] },
    '1:vic'
  );
  return ControlGraph.build([domain, attacker, victim], undefined, T);
}

test('Controls off by default: DCSync stops at the domain node', () => {
  const g = domainFixture();
  const res = reachable(g, ['s-1-5-21-1-2-3-1105'], 'forward'); // expandControls default 'off'
  const keys = res.reached.map((r) => r.node.key);
  assert.ok(keys.includes('s-1-5-21-1-2-3'), 'reaches the domain');
  assert.ok(!keys.includes('s-1-5-21-1-2-3-2500'), 'does NOT reach the victim without expansion');
});

test('shortestPath completes A->B THROUGH domain compromise (toTargets)', () => {
  const g = domainFixture();
  const r = shortestPath(g, 's-1-5-21-1-2-3-1105', 's-1-5-21-1-2-3-2500');
  assert.ok('depth' in r && r.path, 'victim reachable via domain compromise');
  if (r.path) {
    assert.deepEqual(r.path.map((s) => s.kind), ['DCSync', 'Controls']);
    assert.equal(r.path[1].from.key, 's-1-5-21-1-2-3'); // Controls from the domain
    assert.equal(r.path[1].to.key, 's-1-5-21-1-2-3-2500');
  }
});

test('expandControls:all reaches every in-domain principal (blast radius)', () => {
  const g = domainFixture();
  const res = reachable(g, ['s-1-5-21-1-2-3-1105'], 'forward', { expandControls: 'all' });
  const keys = res.reached.map((r) => r.node.key);
  assert.ok(keys.includes('s-1-5-21-1-2-3-2500'), 'blast radius includes the victim');
});

test('reverse Controls: victim exposed to whoever can DCSync its domain', () => {
  const g = domainFixture();
  const res = reachable(g, ['s-1-5-21-1-2-3-2500'], 'reverse', { expandControls: 'all' });
  const keys = res.reached.map((r) => r.node.key);
  assert.ok(keys.includes('s-1-5-21-1-2-3'), 'reaches the controlling domain (reverse)');
  assert.ok(keys.includes('s-1-5-21-1-2-3-1105'), 'and the DCSync attacker behind it');
});
