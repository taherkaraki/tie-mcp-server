/**
 * Tests for the in-memory AD object store (src/ad-object-store.ts).
 *
 * A fake client serves paginated ad-object batches and counts GET calls so we
 * can assert the store scans once and reuses the snapshot, honours the TTL,
 * paginates via lastIdentifierSeen, and answers queries/lookups from memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADObjectStore, DEFAULT_TTL_MS } from '../src/ad-object-store.js';
import type { TIEClient } from '../src/client.js';

interface RawAttr {
  name: string;
  value: string;
  valueType: string;
}
function obj(id: number, directoryId: number, attrs: RawAttr[], type = 'LDAP') {
  return { id, objectId: `${directoryId}:guid-${id}`, type, directoryId, objectAttributes: attrs };
}

/**
 * Fake client that pages through a fixed object list in batches of `pageSize`,
 * mimicking TIE's lastIdentifierSeen cursor. Records how many GETs it served.
 */
function makePagingClient(all: ReturnType<typeof obj>[], pageSize = 1000) {
  let getCount = 0;
  const client = {
    get(path: string) {
      getCount++;
      const m = path.match(/lastIdentifierSeen=(\d+)/);
      const lastId = m ? Number(m[1]) : 0;
      const batch = all.filter((o) => o.id > lastId).slice(0, pageSize);
      return Promise.resolve({ _embedded: { 'ad-objects': batch } });
    },
  } as unknown as TIEClient;
  return { client, getCalls: () => getCount };
}

const sampleObjects = [
  obj(1, 1, [
    { name: 'cn', value: '"Domain Admins"', valueType: 'string' },
    { name: 'samaccountname', value: '"Domain Admins"', valueType: 'string' },
    { name: 'distinguishedname', value: '"CN=Domain Admins,CN=Users,DC=alsid,DC=corp"', valueType: 'string' },
    { name: 'objectsid', value: '"S-1-5-21-1-2-3-512"', valueType: 'string' },
    { name: 'admincount', value: '1', valueType: 'integer' },
  ]),
  obj(2, 1, [
    { name: 'cn', value: '"King Cardona"', valueType: 'string' },
    { name: 'admincount', value: '0', valueType: 'integer' },
    { name: 'useraccountcontrol', value: '"NORMAL DONT_EXPIRE"', valueType: 'string' },
    { name: 'badpwdcount', value: '10', valueType: 'integer' },
  ]),
  obj(3, 2, [
    { name: 'cn', value: '"Policies"', valueType: 'string' },
  ], 'SYSVOL'),
];

test('scans once and reuses the cached snapshot', async () => {
  const { client, getCalls } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);

  await store.query('admincount>0');
  const afterFirst = getCalls();
  assert.ok(afterFirst >= 1, 'first query should hit the API');

  await store.query('type=LDAP');
  assert.equal(getCalls(), afterFirst, 'second query must not re-scan');
});

test('query returns matching objects with a total count', async () => {
  const { client } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);

  const res = await store.query('admincount>0');
  assert.equal(res.total, 1);
  assert.equal(res.returned[0].id, 1);
});

test('limit caps returned objects but total reflects all matches', async () => {
  const { client } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);

  const res = await store.query('type=LDAP', { limit: 1 });
  assert.equal(res.total, 2); // objects 1 and 2 are LDAP
  assert.equal(res.returned.length, 1);
});

test('lookup finds by dn, sid, and sam (case-insensitive)', async () => {
  const { client } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);

  const byDn = await store.lookup('dn', 'cn=domain admins,cn=users,dc=alsid,dc=corp');
  assert.equal(byDn?.id, 1);

  const bySid = await store.lookup('sid', 'S-1-5-21-1-2-3-512');
  assert.equal(bySid?.id, 1);

  const bySam = await store.lookup('sam', 'domain admins');
  assert.equal(bySam?.id, 1);

  const missing = await store.lookup('sam', 'nobody');
  assert.equal(missing, null);
});

test('paginates across multiple pages via the cursor', async () => {
  // 2500 objects, pageSize 1000 => 3 pages.
  const many = Array.from({ length: 2500 }, (_, i) =>
    obj(i + 1, 1, [{ name: 'admincount', value: String(i % 2), valueType: 'integer' }])
  );
  const { client, getCalls } = makePagingClient(many, 1000);
  const store = new ADObjectStore(client);

  const res = await store.query('admincount>0');
  assert.equal(getCalls(), 3, 'should page exactly three times');
  assert.equal(res.total, 1250); // half have admincount 1
});

test('force refresh triggers a re-scan', async () => {
  const { client, getCalls } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);

  await store.query('type=LDAP');
  const afterFirst = getCalls();

  await store.query('type=LDAP', { force: true });
  assert.ok(getCalls() > afterFirst, 'force should re-scan');
});

test('expired snapshot re-scans on next access', async () => {
  const { client, getCalls } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client, { ttlMs: 0 }); // everything is stale

  await store.query('type=LDAP');
  const afterFirst = getCalls();
  await store.query('type=LDAP');
  assert.ok(getCalls() > afterFirst, 'expired snapshot should rebuild');
});

test('onProgress fires once per page with cumulative counts', async () => {
  const many = Array.from({ length: 2500 }, (_, i) =>
    obj(i + 1, 1, [{ name: 'cn', value: `"o${i}"`, valueType: 'string' }])
  );
  const { client } = makePagingClient(many, 1000);
  const store = new ADObjectStore(client);

  const events: Array<{ pages: number; objects: number }> = [];
  await store.query('type=LDAP', { onProgress: (info) => events.push(info) });

  assert.equal(events.length, 3, 'three pages => three progress events');
  assert.deepEqual(
    events.map((e) => e.pages),
    [1, 2, 3]
  );
  // Cumulative object counts across pages.
  assert.deepEqual(
    events.map((e) => e.objects),
    [1000, 2000, 2500]
  );
});

test('invalid expression rejects before any scan (fail fast)', async () => {
  const { client, getCalls } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);

  await assert.rejects(() => store.query('admincount >')); // missing operand
  assert.equal(getCalls(), 0, 'must not scan when the expression is invalid');
});

test('default TTL is one day and is reported in stats', async () => {
  const { client } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);
  await store.query('type=LDAP');
  const stats = store.stats();
  assert.equal(DEFAULT_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(stats.ttlMs, DEFAULT_TTL_MS, 'stats should surface the TTL');
  assert.equal(stats.fresh, true);
});

test('a configured TTL keeps the snapshot fresh across queries (no re-scan)', async () => {
  const { client, getCalls } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client, { ttlMs: 60_000 });
  await store.query('type=LDAP');
  const afterFirst = getCalls();
  await store.query('admincount>0');
  assert.equal(getCalls(), afterFirst, 'within TTL there must be no re-scan');
  assert.equal(store.stats().ttlMs, 60_000);
});

test('warm() builds the snapshot up front and is reused by later queries', async () => {
  const { client, getCalls } = makePagingClient(sampleObjects);
  const store = new ADObjectStore(client);

  await store.warm();
  const afterWarm = getCalls();
  assert.ok(afterWarm >= 1, 'warm should scan');

  await store.query('type=LDAP');
  assert.equal(getCalls(), afterWarm, 'query after warm must not re-scan');
});
