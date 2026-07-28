/**
 * Tests for the AD-object consolidation projection (src/consolidate.ts).
 *
 * Models the three record kinds TIE returns for one real object (verified on
 * middleeast with W12-WS-1) and asserts they collapse to a single record.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consolidate, isSyntheticRow, isPhantomShell } from '../src/consolidate.js';
import type { StoredADObject } from '../src/ad-object-store.js';

/** Minimal StoredADObject fake — consolidate only reads `.record`. */
function rec(record: Record<string, unknown>): StoredADObject {
  return {
    id: Number(record['id'] ?? 0),
    objectId: String(record['objectid'] ?? ''),
    type: String(record['type'] ?? 'LDAP'),
    directoryId: Number(record['directoryid'] ?? 1),
    record,
    raw: {} as StoredADObject['raw'],
  };
}

// The six W12-WS-1 records observed on middleeast.
const realGuid = '3816fac4-9684-43a4-a1fd-9881c1b97a48';
const w12Real = rec({
  objectclass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
  objectguid: realGuid,
  objectsid: 'S-1-5-21-1-2-3-1105',
  samaccountname: 'W12-WS-1$',
  distinguishedname: 'CN=W12-WS-1,OU=Computers,OU=Tier-2,DC=alsid,DC=corp',
  cn: 'W12-WS-1',
  operatingsystem: 'Windows Server 2012',
});
const w12Scan = rec({
  objectclass: ['passwordHashScan'],
  objectguid: realGuid, // same guid + DN as the real object
  distinguishedname: 'CN=W12-WS-1,OU=Computers,OU=Tier-2,DC=alsid,DC=corp',
  isbreached: true,
  isweak: '{"2":true}',
});
const phantom = (guid: string) =>
  rec({
    objectclass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
    objectguid: guid,
    distinguishedname: 'CN=W12-WS-1,CN=Computers,DC=alsid,DC=corp', // default container, no SID/sam
  });

test('the six W12-WS-1 records collapse to the one real object', () => {
  const input = [
    w12Real,
    w12Scan,
    phantom('2e2d8241-fe63-41b5-b8e8-ebacf3f63d5c'),
    phantom('9b847963-d109-4769-ac0e-e9f24fd40138'),
    phantom('51f7d433-650d-42f4-b841-e8d5c7da3452'),
    phantom('ca7a374c-2b50-4a99-b694-30ba5e9fc5dc'),
  ];
  const out = consolidate(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].record['samaccountname'], 'W12-WS-1$');
  assert.equal(out[0].record['objectsid'], 'S-1-5-21-1-2-3-1105');
});

test('same-guid twins collapse to the richest record regardless of order', () => {
  const sparse = rec({ objectguid: realGuid, objectclass: ['computer'], objectsid: 'S-1-5-21-1-2-3-1105', distinguishedname: 'CN=x' });
  // richest wins even when it appears second
  assert.equal(consolidate([sparse, w12Real])[0].record['operatingsystem'], 'Windows Server 2012');
  assert.equal(consolidate([w12Real, sparse])[0].record['operatingsystem'], 'Windows Server 2012');
});

test('synthetic scan/reuse rows are dropped', () => {
  assert.equal(isSyntheticRow(w12Scan), true);
  assert.equal(isSyntheticRow(rec({ objectclass: ['passwordHashReuse'], objectguid: 'g' })), true);
  assert.equal(isSyntheticRow(w12Real), false);
  // a lone scan row with no principal drops entirely
  assert.equal(consolidate([w12Scan]).length, 0);
});

test('phantom shells are dropped but real & SID-less-but-real objects are kept', () => {
  assert.equal(isPhantomShell(phantom('g1')), true);
  assert.equal(isPhantomShell(w12Real), false); // has SID + sam
  // SID-less schema/container/OU objects are REAL — must NOT be dropped
  const schema = rec({ objectclass: ['top', 'attributeSchema'], objectguid: 's1', cn: 'ms-DS-Foo' });
  const container = rec({ objectclass: ['top', 'container'], objectguid: 'c1', cn: 'Computers' });
  const ou = rec({ objectclass: ['top', 'organizationalUnit'], objectguid: 'o1', ou: 'Tier-2' });
  const out = consolidate([schema, container, ou, phantom('p1')]);
  assert.equal(out.length, 3);
  assert.ok(!out.some((o) => isPhantomShell(o)));
});

test('a computer with a samAccountName but no SID is NOT a phantom (kept)', () => {
  // defensive: only guid-only shells are phantoms; a named computer is real
  const named = rec({ objectclass: ['computer'], objectguid: 'n1', samaccountname: 'HOST$', distinguishedname: 'CN=HOST' });
  assert.equal(isPhantomShell(named), false);
  assert.equal(consolidate([named]).length, 1);
});

test('records without a guid pass through unchanged', () => {
  const noGuid = rec({ objectclass: ['top', 'foreignSecurityPrincipal'], distinguishedname: 'CN=S-1-5-11' });
  assert.equal(consolidate([noGuid]).length, 1);
});
