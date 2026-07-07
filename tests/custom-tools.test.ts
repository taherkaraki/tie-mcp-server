/**
 * Tests for the hand-written discovery tools (src/custom-tools.ts).
 *
 * Each handler composes GET calls on the TIEClient; the fake client below
 * answers by path, so we can assert both the shaped output and which endpoints
 * were (and weren't) hit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customTools } from '../src/custom-tools.js';
import type { TIEClient } from '../src/client.js';

function tool(name: string) {
  const t = customTools.find((c) => c.name === name);
  assert.ok(t, `custom tool ${name} not found`);
  return t!;
}

/** Fake client that answers GETs from a path->response map and records paths. */
function makeFakeClient(responses: Record<string, unknown>): {
  client: TIEClient;
  gets: string[];
} {
  const gets: string[] = [];
  const fake = {
    get(path: string) {
      gets.push(path);
      if (!(path in responses)) {
        return Promise.reject(new Error(`unexpected GET ${path}`));
      }
      return Promise.resolve(responses[path]);
    },
  };
  return { client: fake as unknown as TIEClient, gets };
}

test('get_topology groups domains under forests and keeps empty forests', async () => {
  const { client } = makeFakeClient({
    '/api/infrastructures': [
      { id: 1, name: 'Forest A' },
      { id: 2, name: 'Forest B (empty)' },
    ],
    '/api/directories': [
      { id: 10, name: 'dom1', infrastructureId: 1, type: 'ad', dns: 'a.local' },
      { id: 11, name: 'dom2', infrastructureId: 1 },
    ],
  });

  const result = (await tool('get_topology').handler(client, {})) as {
    forests: Array<{ infrastructureId: number; domains: unknown[] }>;
    totals: { forests: number; domains: number };
  };

  assert.equal(result.forests.length, 2);
  assert.equal(result.forests[0].domains.length, 2);
  assert.equal(result.forests[1].domains.length, 0); // empty forest preserved
  assert.deepEqual(result.totals, { forests: 2, domains: 2 });
});

test('get_preferred_profile resolves the profile name by id', async () => {
  const { client, gets } = makeFakeClient({
    '/api/preferences': { language: 'en', preferredProfileId: 2 },
    '/api/profiles': [
      { id: 1, name: 'Tenable' },
      { id: 2, name: 'Contoso' },
    ],
  });

  const result = await tool('get_preferred_profile').handler(client, {});

  assert.deepEqual(result, { preferredProfileId: 2, preferredProfileName: 'Contoso' });
  assert.ok(gets.includes('/api/profiles'));
});

test('get_preferred_profile returns nulls and skips /api/profiles when none set', async () => {
  const { client, gets } = makeFakeClient({
    '/api/preferences': { language: 'en' }, // no preferredProfileId
  });

  const result = await tool('get_preferred_profile').handler(client, {});

  assert.deepEqual(result, { preferredProfileId: null, preferredProfileName: null });
  assert.ok(!gets.includes('/api/profiles'), 'should not fetch profiles when none preferred');
});

test('custom tool input schemas set additionalProperties: false (v0.2.1 fix)', () => {
  for (const t of customTools) {
    assert.equal(
      t.inputSchema.additionalProperties,
      false,
      `${t.name} inputSchema must set additionalProperties: false`
    );
  }
});
