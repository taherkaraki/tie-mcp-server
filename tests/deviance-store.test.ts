import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevianceStore } from '../src/deviance/store.js';
import type { TIEClient } from '../src/client.js';

/** Fake client serving checker/reason/category/option metadata + a deviance page. */
function makeClient() {
  const gets: string[] = [];
  const deviances = [
    // profile 2, target=joffrey(44656), checker 59 shadow creds, trustee jaime in ACE
    {
      id: 163121, checkerId: 59, profileId: 2, adObjectId: 44656, directoryId: 12,
      reasonId: 59005, resolvedEventId: null, resolvedAt: null, ignoreUntil: null,
      createdEventId: 1107554, eventDate: '2025-10-04T18:59:14.000Z',
      devianceProviderId: 'abc',
      attributes: [
        { name: 'ObjectName', value: 'joffrey.baratheon' },
        {
          name: 'DangerousAceList',
          value: JSON.stringify([
            { Item2: 'S-1-5-21-1-2-3-1114', Item3: 'sevenkingdoms.local\\jaime.lannister', Item4: [{ Item1: 'Write all properties', Item2: '' }] },
          ]),
        },
      ],
    },
    // profile 1 copy of a finding — must be excluded when building profile 2
    {
      id: 999, checkerId: 3, profileId: 1, adObjectId: 44673, directoryId: 12,
      reasonId: 4, resolvedEventId: null, resolvedAt: null, ignoreUntil: null,
      createdEventId: 1, eventDate: '2025-10-04T18:59:14.000Z', devianceProviderId: 'x',
      attributes: [{ name: 'Cn', value: 'renly.baratheon' }],
    },
    // profile 2, target=renly(44673), never-expiring password
    {
      id: 163119, checkerId: 3, profileId: 2, adObjectId: 44673, directoryId: 12,
      reasonId: 4, resolvedEventId: null, resolvedAt: null, ignoreUntil: null,
      createdEventId: 2, eventDate: '2025-10-04T18:59:14.000Z', devianceProviderId: 'y',
      attributes: [{ name: 'Cn', value: 'renly.baratheon' }],
    },
  ];
  const client = {
    get(path: string) {
      gets.push(path);
      if (path === '/api/checkers')
        return Promise.resolve([
          { id: 59, codename: 'C-SHADOW-CREDENTIALS', name: 'Shadow Credentials', categoryId: 5, remediationCost: 50 },
          { id: 3, codename: 'C-PASSWORD-DONT-EXPIRE', name: 'Accounts With Never Expiring Passwords', categoryId: 2, remediationCost: 50 },
        ]);
      if (path === '/api/reasons')
        return Promise.resolve([
          { id: 59005, codename: 'R-KEY-CRED-ACL', name: 'Unsafe permissions on account', description: 'Unsafe permissions on account' },
          { id: 4, codename: 'R-DONT-EXPIRE-SET', name: 'Not forced to change password', description: '...' },
        ]);
      if (path === '/api/categories')
        return Promise.resolve([{ id: 2, name: 'User management' }, { id: 5, name: 'Directory objects' }]);
      if (path.includes('/checker-options')) {
        const cid = Number(path.match(/checkers\/(\d+)\//)![1]);
        return Promise.resolve([
          { codename: 'O-CRITICITY', value: cid === 59 ? '65' : '50', valueType: 'integer', checkerId: cid, profileId: 2, staged: false, directoryId: null },
          { codename: 'O-ENABLED', value: 'true', valueType: 'boolean', checkerId: cid, profileId: 2, staged: false, directoryId: null },
        ]);
      }
      if (path.includes('/deviances')) {
        const last = Number(path.match(/lastIdentifierSeen=(\d+)/)![1]);
        return Promise.resolve(deviances.filter((d) => d.id > last));
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    },
  };
  return { client: client as unknown as TIEClient, gets };
}

const DIRS = [{ infrastructureId: 14, directoryId: 12 }];

test('DevianceStore scopes to the requested profile and builds forward index', async () => {
  const { client } = makeClient();
  const store = new DevianceStore(client);
  await store.ensureLoaded(2, DIRS);

  // profile-1 deviance (id 999) is excluded
  assert.equal(store.getRaw(999), undefined);
  assert.equal(store.stats().deviances, 2);
  // forward: joffrey (44656) has the shadow-creds deviance
  assert.deepEqual(store.forwardFor(44656), [163121]);
  assert.deepEqual(store.forwardFor(44673), [163119]);
});

test('DevianceStore builds the reverse trustee index from DangerousAceList', async () => {
  const { client } = makeClient();
  const store = new DevianceStore(client);
  await store.ensureLoaded(2, DIRS);

  // jaime is the risky trustee inside joffrey's deviance
  const hits = store.reverseForSid('S-1-5-21-1-2-3-1114');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].devianceId, 163121);
  assert.deepEqual(hits[0].grantedRights, ['Write all properties']);
  assert.equal(hits[0].resolvedFrom, 'DangerousAceList[0]');
});

test('DevianceStore lazily fetches checker config only when asked', async () => {
  const { client, gets } = makeClient();
  const store = new DevianceStore(client);
  await store.ensureLoaded(2, DIRS);
  assert.ok(!gets.some((g) => g.includes('/checker-options')), 'no config fetched during scan');

  await store.ensureCheckerConfig([59]);
  assert.ok(gets.some((g) => g.includes('/checkers/59/checker-options')));
  assert.ok(!gets.some((g) => g.includes('/checkers/3/checker-options')), 'only requested checker fetched');
  assert.equal(store.configFor(59)?.defaultCriticity, 65);
});

test('DevianceStore rebuilds when the profile changes', async () => {
  const { client } = makeClient();
  const store = new DevianceStore(client);
  await store.ensureLoaded(2, DIRS);
  assert.equal(store.stats().profileId, 2);
  await store.ensureLoaded(1, DIRS);
  assert.equal(store.stats().profileId, 1);
  // now only the profile-1 deviance is present
  assert.equal(store.getRaw(999) !== undefined, true);
  assert.equal(store.getRaw(163121), undefined);
});
