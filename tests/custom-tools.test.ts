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

/** Fake client that serves a single ad-objects page then an empty one. */
function makeADObjectClient() {
  const page = [
    {
      id: 1,
      objectId: '1:guid-1',
      type: 'LDAP',
      directoryId: 1,
      objectAttributes: [
        { name: 'cn', value: '"Domain Admins"', valueType: 'string' },
        { name: 'samaccountname', value: '"Domain Admins"', valueType: 'string' },
        {
          name: 'distinguishedname',
          value: '"CN=Domain Admins,CN=Users,DC=alsid,DC=corp"',
          valueType: 'string',
        },
        // RID -512 makes this a Tier-0 seed for asset-exposure tests.
        { name: 'objectsid', value: '"S-1-5-21-9-9-9-512"', valueType: 'string' },
        { name: 'admincount', value: '1', valueType: 'integer' },
      ],
    },
    {
      id: 2,
      objectId: '1:guid-2',
      type: 'LDAP',
      directoryId: 1,
      objectAttributes: [{ name: 'admincount', value: '0', valueType: 'integer' }],
    },
    {
      id: 3,
      objectId: '1:guid-3',
      type: 'LDAP',
      directoryId: 1,
      objectAttributes: [
        { name: 'cn', value: '"Widget Group"', valueType: 'string' },
        { name: 'samaccountname', value: '"WidgetGroup"', valueType: 'string' },
        {
          name: 'distinguishedname',
          value: '"CN=Widget Group,OU=Groups,DC=alsid,DC=corp"',
          valueType: 'string',
        },
        { name: 'objectsid', value: '"S-1-5-21-9-9-9-1500"', valueType: 'string' },
        // WidgetGroup is a member of Domain Admins -> control edge to Tier-0.
        {
          name: 'memberof',
          value: '["CN=Domain Admins,CN=Users,DC=alsid,DC=corp"]',
          valueType: 'array/string',
        },
        {
          name: 'ntsecuritydescriptor',
          value:
            '"O:S-1-5-21-9-9-9-512G:S-1-5-21-9-9-9-512D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-1-0)"',
          valueType: 'string',
        },
      ],
    },
    {
      id: 4,
      objectId: '1:guid-4',
      type: 'LDAP',
      directoryId: 1,
      objectAttributes: [
        { name: 'cn', value: '"bob"', valueType: 'string' },
        { name: 'samaccountname', value: '"bob"', valueType: 'string' },
        {
          name: 'distinguishedname',
          value: '"CN=bob,OU=Users,DC=alsid,DC=corp"',
          valueType: 'string',
        },
        { name: 'objectsid', value: '"S-1-5-21-9-9-9-2000"', valueType: 'string' },
        { name: 'objectclass', value: '["top","person","user"]', valueType: 'array/string' },
        // bob is a member of WidgetGroup -> two hops from Domain Admins.
        {
          name: 'memberof',
          value: '["CN=Widget Group,OU=Groups,DC=alsid,DC=corp"]',
          valueType: 'array/string',
        },
      ],
    },
  ];
  const fake = {
    get(path: string) {
      const m = path.match(/lastIdentifierSeen=(\d+)/);
      const lastId = m ? Number(m[1]) : 0;
      return Promise.resolve({
        _embedded: { 'ad-objects': page.filter((o) => o.id > lastId) },
      });
    },
  };
  return fake as unknown as TIEClient;
}

test('query_ad_objects returns matches with total and truncation flags', async () => {
  const client = makeADObjectClient();
  const result = (await tool('query_ad_objects').handler(client, {
    expression: 'admincount>0',
    limit: 50,
  })) as { total: number; returned: number; truncated: boolean; objects: unknown[] };

  assert.equal(result.total, 1);
  assert.equal(result.returned, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.objects.length, 1);
});

test('query_ad_objects reports a syntax error instead of throwing', async () => {
  const client = makeADObjectClient();
  const result = (await tool('query_ad_objects').handler(client, {
    expression: 'admincount >', // missing operand
  })) as { error?: string; position?: number };

  assert.equal(result.error, 'Invalid query expression');
  assert.equal(typeof result.position, 'number');
});

test('query_ad_objects forwards scan progress via ctx.reportProgress', async () => {
  const client = makeADObjectClient();
  const events: Array<{ pages: number; objects: number }> = [];
  // refresh:true forces a scan even if a prior test already warmed the shared
  // store, so progress is guaranteed to fire.
  await tool('query_ad_objects').handler(
    client,
    { expression: 'type=LDAP', refresh: true },
    { reportProgress: (info) => events.push(info) }
  );
  assert.ok(events.length >= 1, 'progress should be reported at least once');
  assert.equal(typeof events[0].objects, 'number');
});

test('get_ad_object looks up by distinguished name', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_ad_object').handler(client, {
    distinguishedName: 'CN=Domain Admins,CN=Users,DC=alsid,DC=corp',
  })) as { found: boolean; object?: { id: number } };

  assert.equal(result.found, true);
  assert.equal(result.object?.id, 1);
});

test('get_ad_object requires exactly one identifier', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_ad_object').handler(client, {
    distinguishedName: 'CN=x',
    sid: 'S-1-5-21-1',
  })) as { error?: string };

  assert.match(result.error ?? '', /exactly one/);
});

test('get_ad_object decodes the security descriptor on request', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_ad_object').handler(client, {
    samAccountName: 'WidgetGroup',
    decodeSecurityDescriptor: true,
  })) as {
    found: boolean;
    securityDescriptor?: {
      owner?: { name: string | null };
      aces: Array<{ trustee: { name: string | null; broad: boolean }; rights: string[] }>;
    };
  };

  assert.equal(result.found, true);
  const sd = result.securityDescriptor!;
  // Owner SID -512 resolves via the well-known RID fallback.
  assert.equal(sd.owner?.name, 'Domain Admins');
  // The Everyone full-control ACE is decoded, resolved, and flagged broad.
  const ace = sd.aces[0];
  assert.equal(ace.trustee.name, 'Everyone');
  assert.equal(ace.trustee.broad, true);
  assert.deepEqual(ace.rights, ['GenericAll']);
});

test('get_blast_radius reaches Domain Admins from bob through the group chain', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_blast_radius').handler(client, {
    principal: 'bob',
  })) as {
    reachableCount: number;
    reachable: Array<{ node: { key: string; name: string | null }; depth: number }>;
  };

  const names = result.reachable.map((r) => r.node.name);
  assert.ok(names.includes('WidgetGroup'), 'reaches WidgetGroup');
  assert.ok(names.includes('Domain Admins'), 'reaches Domain Admins transitively');
});

test('get_control_paths returns the edge chain bob -> Domain Admins', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_control_paths').handler(client, {
    from: 'bob',
    to: 'Domain Admins',
  })) as {
    reachable: boolean;
    hops?: number;
    path?: Array<{ kind: string }>;
  };

  assert.equal(result.reachable, true);
  assert.equal(result.hops, 2); // bob -> WidgetGroup -> Domain Admins
  assert.deepEqual(result.path?.map((s) => s.kind), ['MemberOf', 'MemberOf']);
});

test('get_control_paths reports unreachable when no path exists', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_control_paths').handler(client, {
    from: 'Domain Admins',
    to: 'bob',
  })) as { reachable: boolean };
  assert.equal(result.reachable, false);
});

test('get_asset_exposure (Tier-0 preset) lists principals that can reach Domain Admins', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_asset_exposure').handler(client, {})) as {
    exposedCount: number;
    exposedPrincipals: Array<{ node: { name: string | null } }>;
  };

  const names = result.exposedPrincipals.map((p) => p.node.name);
  assert.ok(names.includes('bob'), 'bob is exposed to Tier-0');
  assert.ok(names.includes('WidgetGroup'), 'WidgetGroup is exposed to Tier-0');
});

test('graph tools resolve a principal that does not exist to a not-found result', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_blast_radius').handler(client, {
    principal: 'nonexistent-user',
  })) as { found: boolean };
  assert.equal(result.found, false);
});

test('get_tier0 reports built-in seeds plus derived de facto members', async () => {
  const client = makeADObjectClient();
  const result = (await tool('get_tier0').handler(client, {})) as {
    builtinCount: number;
    derivedCount: number;
    tier0Total: number;
    builtin: Array<{ node: { name: string | null } }>;
    derived: Array<{ node: { name: string | null }; hops: number; escalationPath: Array<{ kind: string }> }>;
  };

  // Domain Admins (RID -512) is the built-in seed.
  assert.ok(result.builtin.some((b) => b.node.name === 'Domain Admins'));
  // WidgetGroup and bob can reach it, so they are derived Tier-0.
  const derivedNames = result.derived.map((d) => d.node.name);
  assert.ok(derivedNames.includes('WidgetGroup'));
  assert.ok(derivedNames.includes('bob'));
  assert.equal(result.tier0Total, result.builtinCount + result.derivedCount);

  // The escalation path for bob reads member -> ... -> seed.
  const bob = result.derived.find((d) => d.node.name === 'bob');
  assert.ok(bob && bob.escalationPath.length === bob.hops);
});
