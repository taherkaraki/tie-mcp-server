import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityBand, remediationBand, severityRank } from '../src/deviance/bands.js';
import { embeddedTrustees, parseDangerousAceList } from '../src/deviance/trustees.js';
import { buildDeeplink, buildFilterHint } from '../src/deviance/deeplink.js';

test('severityBand maps UI-confirmed criticity values to the right tiers', () => {
  // Confirmed against the console: 100/90/81/80 -> Critical, 65/70 -> High,
  // 50/40/35 -> Medium, 30/20/10 -> Low.
  assert.equal(severityBand(100), 'Critical');
  assert.equal(severityBand(80), 'Critical');
  assert.equal(severityBand(79), 'High');
  assert.equal(severityBand(65), 'High');
  assert.equal(severityBand(60), 'High');
  assert.equal(severityBand(59), 'Medium');
  assert.equal(severityBand(34), 'Medium');
  assert.equal(severityBand(33), 'Low');
  assert.equal(severityBand(10), 'Low');
  assert.equal(severityBand(null), 'Unknown');
});

test('remediationBand splits into equal thirds (cost 40 & 60 = Medium)', () => {
  assert.equal(remediationBand(2), 'Low');
  assert.equal(remediationBand(20), 'Low');
  assert.equal(remediationBand(33), 'Low');
  assert.equal(remediationBand(40), 'Medium');
  assert.equal(remediationBand(50), 'Medium');
  assert.equal(remediationBand(60), 'Medium'); // UI-confirmed Medium, not High
  assert.equal(remediationBand(66), 'Medium');
  assert.equal(remediationBand(70), 'High');
  assert.equal(remediationBand(90), 'High');
  assert.equal(remediationBand(null), 'Unknown');
});

test('severityRank orders bands descending', () => {
  assert.ok(severityRank('Critical') > severityRank('High'));
  assert.ok(severityRank('High') > severityRank('Medium'));
  assert.ok(severityRank('Medium') > severityRank('Low'));
  assert.ok(severityRank('Low') > severityRank('Unknown'));
});

test('parseDangerousAceList extracts trustee sid, name, and granted rights', () => {
  const value = JSON.stringify([
    {
      Item1: 'A;;SWWPRC;;;S-1-5-21-1-2-3-1114',
      Item2: 'S-1-5-21-1-2-3-1114',
      Item3: 'sevenkingdoms.local\\jaime.lannister',
      Item4: [
        { Item1: 'Write all properties', Item2: '' },
        { Item1: 'All validated writes', Item2: '' },
      ],
    },
  ]);
  const [t] = parseDangerousAceList(value);
  assert.equal(t.sid, 's-1-5-21-1-2-3-1114');
  assert.equal(t.name, 'sevenkingdoms.local\\jaime.lannister');
  assert.deepEqual(t.grantedRights, ['Write all properties', 'All validated writes']);
  assert.equal(t.resolvedFrom, 'DangerousAceList[0]');
});

test('parseDangerousAceList tolerates malformed JSON', () => {
  assert.deepEqual(parseDangerousAceList('not json'), []);
  assert.deepEqual(parseDangerousAceList('{}'), []);
});

test('embeddedTrustees pulls from DangerousAceList and MemberDn', () => {
  const trustees = embeddedTrustees([
    { name: 'ObjectName', value: 'joffrey.baratheon' },
    {
      name: 'DangerousAceList',
      value: JSON.stringify([{ Item2: 'S-1-5-21-9-9-9-500', Item3: 'corp\\admin', Item4: [] }]),
    },
    { name: 'MemberDn', value: 'CN=evil,DC=corp,DC=local' },
  ]);
  assert.equal(trustees.length, 2);
  assert.equal(trustees[0].sid, 's-1-5-21-9-9-9-500');
  assert.equal(trustees[1].name, 'CN=evil,DC=corp,DC=local');
});

test('buildDeeplink matches the verified console URL shape', () => {
  const url = buildDeeplink('https://middleeast.tenable.ad', 'Contoso', 59, 'C-SHADOW-CREDENTIALS');
  assert.equal(
    url,
    'https://middleeast.tenable.ad/profile/contoso/indicators-of-exposure/ad/details/59-C-SHADOW-CREDENTIALS/deviant-objects'
  );
  assert.equal(buildFilterHint(44656), 'id:"44656"');
});
