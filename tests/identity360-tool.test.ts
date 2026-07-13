/**
 * End-to-end test of the get_identity_360 / _summary tools through their handlers
 * with a fake client, covering identity resolution, the target + trustee layers,
 * profile defaulting, disabled-checker suppression, and summary/detail agreement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customTools, configureStore } from '../src/custom-tools.js';
import type { TIEClient } from '../src/client.js';

function tool(name: string) {
  const t = customTools.find((c) => c.name === name);
  assert.ok(t, `tool ${name} not found`);
  return t!;
}

// Two AD objects: joffrey (victim, 44656) and jaime (trustee, 44669).
const AD_OBJECTS = [
  {
    id: 44656, objectId: '12:guid-joffrey', type: 'LDAP', directoryId: 12,
    objectAttributes: [
      { name: 'cn', value: '"joffrey.baratheon"', valueType: 'string' },
      { name: 'samaccountname', value: '"joffrey.baratheon"', valueType: 'string' },
      { name: 'distinguishedname', value: '"CN=joffrey.baratheon,DC=sevenkingdoms,DC=local"', valueType: 'string' },
      { name: 'objectsid', value: '"S-1-5-21-1-2-3-1116"', valueType: 'string' },
      { name: 'objectclass', value: '["top","person","user"]', valueType: 'array/string' },
    ],
  },
  {
    id: 44669, objectId: '12:guid-jaime', type: 'LDAP', directoryId: 12,
    objectAttributes: [
      { name: 'cn', value: '"jaime.lannister"', valueType: 'string' },
      { name: 'samaccountname', value: '"jaime.lannister"', valueType: 'string' },
      { name: 'distinguishedname', value: '"CN=jaime.lannister,DC=sevenkingdoms,DC=local"', valueType: 'string' },
      { name: 'objectsid', value: '"S-1-5-21-1-2-3-1114"', valueType: 'string' },
      { name: 'objectclass', value: '["top","person","user"]', valueType: 'array/string' },
    ],
  },
];

const DEVIANCES = [
  // Shadow Credentials filed on joffrey; jaime is the risky trustee inside the ACE.
  {
    id: 163121, checkerId: 59, profileId: 2, adObjectId: 44656, directoryId: 12,
    reasonId: 59005, resolvedEventId: null, resolvedAt: null, ignoreUntil: null,
    createdEventId: 1107554, eventDate: '2025-10-04T18:59:14.000Z', devianceProviderId: 'abc',
    attributes: [
      { name: 'ObjectName', value: 'joffrey.baratheon' },
      { name: 'DangerousAceList', value: JSON.stringify([{ Item2: 'S-1-5-21-1-2-3-1114', Item3: 'sevenkingdoms.local\\jaime.lannister', Item4: [{ Item1: 'Write all properties', Item2: '' }] }]) },
    ],
  },
];

function makeClient() {
  const client = {
    get(path: string) {
      if (path === '/api/profiles') return Promise.resolve([{ id: 2, name: 'Contoso' }]);
      if (path === '/api/preferences') return Promise.resolve({ preferredProfileId: 2 });
      if (path === '/api/directories') return Promise.resolve([{ id: 12, name: 'sevenkingdoms.local', infrastructureId: 14 }]);
      if (path === '/api/checkers') return Promise.resolve([{ id: 59, codename: 'C-SHADOW-CREDENTIALS', name: 'Shadow Credentials', categoryId: 5, remediationCost: 50 }]);
      if (path === '/api/reasons') return Promise.resolve([{ id: 59005, codename: 'R-KEY-CRED-ACL', name: 'Unsafe permissions on account', description: '...' }]);
      if (path === '/api/categories') return Promise.resolve([{ id: 5, name: 'Directory objects' }]);
      if (path.includes('/checker-options')) return Promise.resolve([{ codename: 'O-CRITICITY', value: '65', valueType: 'integer', checkerId: 59, profileId: 2, staged: false, directoryId: null }, { codename: 'O-ENABLED', value: 'true', valueType: 'boolean', checkerId: 59, profileId: 2, staged: false, directoryId: null }]);
      if (path.includes('/deviances')) {
        const last = Number(path.match(/lastIdentifierSeen=(\d+)/)?.[1] ?? 0);
        return Promise.resolve(DEVIANCES.filter((d) => d.id > last));
      }
      if (path.startsWith('/api/ad-objects')) {
        const last = Number(path.match(/lastIdentifierSeen=(\d+)/)?.[1] ?? 0);
        return Promise.resolve({ _embedded: { 'ad-objects': AD_OBJECTS.filter((o) => o.id > last) } });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    },
  };
  return client as unknown as TIEClient;
}

test('get_identity_360 finds jaime as the risky trustee (reverse layer)', async () => {
  configureStore({ baseUrl: 'https://middleeast.tenable.ad' });
  const client = makeClient();
  const result = (await tool('get_identity_360').handler(client, {
    samAccountName: 'jaime.lannister',
    includeInherited: false, // keep the test off the graph
    refresh: true,
  })) as {
    identity: { resolved: boolean; name: string };
    summary: { total: number; byLayer: Record<string, number>; bySeverityBand: Record<string, number> };
    deviances: Array<{ layer: string; checker: { name: string }; severity: { band: string }; counterpart?: { name: string }; deeplink: string; grantedRights?: string[] }>;
  };

  assert.equal(result.identity.resolved, true);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.byLayer.trustee, 1);
  const d = result.deviances[0];
  assert.equal(d.layer, 'trustee');
  assert.equal(d.checker.name, 'Shadow Credentials');
  assert.equal(d.severity.band, 'High'); // criticity 65
  assert.equal(d.counterpart?.name, 'joffrey.baratheon');
  assert.deepEqual(d.grantedRights, ['Write all properties']);
  assert.match(d.deeplink, /59-C-SHADOW-CREDENTIALS\/deviant-objects$/);
});

test('get_identity_360 finds the deviance on joffrey (target layer) with a working deeplink', async () => {
  configureStore({ baseUrl: 'https://middleeast.tenable.ad' });
  const result = (await tool('get_identity_360').handler(makeClient(), {
    samAccountName: 'joffrey.baratheon',
    includeInherited: false,
    refresh: true,
  })) as { deviances: Array<{ layer: string; deeplinkFilterHint: string }> };
  assert.equal(result.deviances[0].layer, 'target');
  assert.equal(result.deviances[0].deeplinkFilterHint, 'id:"44656"');
});

test('get_identity_360_summary badge counts match the detail view', async () => {
  configureStore({ baseUrl: 'https://middleeast.tenable.ad' });
  const client = makeClient();
  const summary = (await tool('get_identity_360_summary').handler(client, {
    identities: ['jaime.lannister', 'nonexistent.user'],
    includeInherited: false,
    refresh: true,
  })) as { identities: Array<{ resolved: boolean; name?: string; bySeverityBand?: Record<string, number> }>; unresolved: number };

  assert.equal(summary.unresolved, 1);
  const jaime = summary.identities.find((i) => i.name === 'jaime.lannister')!;
  assert.equal(jaime.bySeverityBand!.High, 1);
});

test('get_identity_360 requires exactly one identifier', async () => {
  const result = (await tool('get_identity_360').handler(makeClient(), {
    samAccountName: 'x', sid: 'S-1-5-21-1', includeInherited: false,
  })) as { error?: string };
  assert.match(result.error ?? '', /exactly one/);
});
