/**
 * Hand-written convenience tools that don't map 1:1 to a single API endpoint.
 *
 * These live OUTSIDE src/generated/tools.ts so `npm run generate:tools` never
 * clobbers them. Each tool carries its own `handler` that orchestrates one or
 * more calls to the TIE client and returns a plain JS value (serialized to the
 * MCP response by index.ts).
 *
 * Design notes:
 * - TIE has two orthogonal axes. The *topology* axis is real containment:
 *   Infrastructure (Forest) -> Directory (Domain). The *configuration* axis is
 *   a set of selectable lenses: Profile -> per-checker options -> customizations.
 *   A profile does NOT own infrastructures; it is a view applied over them.
 * - When no profile is specified, the correct default is the user's preferred
 *   profile (`preferredProfileId` from GET /api/preferences), not profile 1.
 */

import type { TIEClient } from './client.js';
import type { ToolInputSchema } from './generated/tools.js';
import { ADObjectStore, type StoredADObject, type ScanProgress } from './ad-object-store.js';
import { QuerySyntaxError } from './query/lexer.js';

/**
 * Optional per-call context the server passes to a custom tool handler. Carries
 * a `reportProgress` hook that, when the MCP client requested progress for this
 * request, forwards indeterminate scan progress as notifications/progress. It is
 * a no-op when the client didn't opt in, so handlers can call it unconditionally.
 */
export interface ToolContext {
  reportProgress?: ScanProgress;
}

export interface CustomTool {
  name: string;
  description: string;
  category: string;
  safety: 'read' | 'write' | 'destructive';
  inputSchema: ToolInputSchema;
  handler: (
    client: TIEClient,
    args: Record<string, unknown>,
    ctx?: ToolContext
  ) => Promise<unknown>;
}

/**
 * Lazily-built, process-wide AD object store. The server uses a single TIEClient
 * for its lifetime, so one store (bound to that client on first use) is shared
 * across every ad-object query/lookup call and its TTL cache is reused.
 */
let sharedStore: ADObjectStore | null = null;
function getStore(client: TIEClient): ADObjectStore {
  if (!sharedStore) sharedStore = new ADObjectStore(client);
  return sharedStore;
}

/**
 * Expose the shared store for optional startup warming (see index.ts). Creates
 * it bound to `client` if it doesn't exist yet, so a warm and the first user
 * query share the same instance and its in-flight-build dedup.
 */
export function getSharedStore(client: TIEClient): ADObjectStore {
  return getStore(client);
}

/** Shape a stored object for tool output: identity + full raw attributes. */
function presentObject(obj: StoredADObject) {
  return {
    id: obj.id,
    objectId: obj.objectId,
    type: obj.type,
    directoryId: obj.directoryId,
    attributes: obj.raw.objectAttributes,
  };
}

/** Minimal shapes of the API responses we consume (see the OpenAPI spec). */
interface Infrastructure {
  id: number;
  name: string;
}
interface Directory {
  id: number;
  name: string;
  infrastructureId: number;
  infrastructureName?: string;
  type?: string;
  dns?: string;
}
interface Profile {
  id: number;
  name: string;
}
interface Preferences {
  language?: string;
  preferredProfileId?: number;
}

export const customTools: CustomTool[] = [
  {
    name: 'get_topology',
    description:
      'Discover the Active Directory environment as a Forest -> Domain tree. ' +
      'Returns each infrastructure (forest) with its directories (domains) and ' +
      'their IDs, so you can obtain the infrastructureId / directoryId values ' +
      'required by other tools. This is the topology (containment) axis and is ' +
      'independent of profiles. Call this first when you do not already know the ' +
      'IDs of the forests or domains you need to query.',
    category: 'Discovery',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(client) {
      const [infras, dirs] = await Promise.all([
        client.get<Infrastructure[]>('/api/infrastructures'),
        client.get<Directory[]>('/api/directories'),
      ]);

      // Group domains by their forest. Infrastructures form the spine so that
      // forests with zero domains still appear.
      const byInfra = new Map<number, Directory[]>();
      for (const d of dirs) {
        const list = byInfra.get(d.infrastructureId) ?? [];
        list.push(d);
        byInfra.set(d.infrastructureId, list);
      }

      const forests = infras.map((infra) => ({
        infrastructureId: infra.id,
        infrastructureName: infra.name,
        domains: (byInfra.get(infra.id) ?? []).map((d) => ({
          directoryId: d.id,
          directoryName: d.name,
          type: d.type,
          dns: d.dns,
        })),
      }));

      return {
        forests,
        totals: { forests: forests.length, domains: dirs.length },
      };
    },
  },
  {
    name: 'get_preferred_profile',
    description:
      "Return the user's preferred (default) profile — its id and name — from " +
      'GET /api/preferences. TIE profiles are configuration lenses, not ' +
      'containers; one is marked preferred. Use this profileId by default in ' +
      'profile-scoped tools unless the user explicitly names a different ' +
      'profile. Prevents querying the wrong profile and getting empty results.',
    category: 'Discovery',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(client) {
      const prefs = await client.get<Preferences>('/api/preferences');
      const preferredProfileId = prefs.preferredProfileId ?? null;

      let preferredProfileName: string | null = null;
      if (preferredProfileId !== null) {
        const profiles = await client.get<Profile[]>('/api/profiles');
        preferredProfileName =
          profiles.find((p) => p.id === preferredProfileId)?.name ?? null;
      }

      return { preferredProfileId, preferredProfileName };
    },
  },
  {
    name: 'query_ad_objects',
    description:
      'Search all AD objects with a filter expression, evaluated in memory over ' +
      'a cached snapshot of every object (built once from a full scan, reused ' +
      'until it expires). Avoids re-paging the whole directory on every request. ' +
      'Expression grammar: FIELD OP VALUE combined with AND / OR / NOT and ' +
      'parentheses. Operators: = != > >= < <= for equality/ordering (numeric ' +
      'when both sides are numbers, else case-insensitive string), : for ' +
      'contains/substring (also array membership), & | for numeric bitwise ' +
      'tests. Fields are attribute names (case-insensitive) plus the identity ' +
      'fields type, directoryId, objectId, id. String matching is ' +
      'case-insensitive. Multi-valued attributes match if ANY value matches; a ' +
      'missing attribute never matches. Example: ' +
      '(admincount>0 AND useraccountcontrol:"NORMAL") OR badpwdcount>=5',
    category: 'Search',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'The filter expression, e.g. admincount>0 AND enabled=true. ' +
            'Quote values containing spaces: cn:"Domain Admins".',
        },
        limit: {
          type: 'integer',
          description:
            'Maximum number of matching objects to return (default 50, 0 = all). ' +
            'The total match count is always reported regardless of limit.',
          minimum: 0,
        },
        refresh: {
          type: 'boolean',
          description:
            'Force a fresh full scan instead of using the cached snapshot.',
        },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      const expression = args.expression as string;
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const force = args.refresh === true;

      const store = getStore(client);
      try {
        const { total, returned } = await store.query(expression, {
          limit,
          force,
          onProgress: ctx?.reportProgress,
        });
        return {
          expression,
          total,
          returned: returned.length,
          truncated: limit > 0 && total > returned.length,
          snapshot: store.stats(),
          objects: returned.map(presentObject),
        };
      } catch (err) {
        if (err instanceof QuerySyntaxError) {
          return {
            error: 'Invalid query expression',
            message: err.message,
            position: err.pos,
            expression,
          };
        }
        throw err;
      }
    },
  },
  {
    name: 'get_ad_object',
    description:
      'Look up a single AD object by distinguished name, SID, or SAM account ' +
      'name, using the cached in-memory snapshot (no full re-scan per call). ' +
      'Provide exactly one of distinguishedName, sid, or samAccountName. Returns ' +
      'the object with all of its attributes, or a not-found result.',
    category: 'Search',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        distinguishedName: {
          type: 'string',
          description:
            'Exact DN, e.g. "CN=Domain Admins,CN=Users,DC=alsid,DC=corp".',
        },
        sid: {
          type: 'string',
          description: 'Object SID, e.g. "S-1-5-21-...-512".',
        },
        samAccountName: {
          type: 'string',
          description: 'SAM account name, e.g. "Domain Admins".',
        },
        refresh: {
          type: 'boolean',
          description: 'Force a fresh full scan instead of the cached snapshot.',
        },
      },
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      const dn = args.distinguishedName as string | undefined;
      const sid = args.sid as string | undefined;
      const sam = args.samAccountName as string | undefined;
      const force = args.refresh === true;

      const provided = [dn, sid, sam].filter((v) => typeof v === 'string' && v);
      if (provided.length !== 1) {
        return {
          error:
            'Provide exactly one of distinguishedName, sid, or samAccountName.',
        };
      }

      const store = getStore(client);
      const [by, value]: ['dn' | 'sid' | 'sam', string] = dn
        ? ['dn', dn]
        : sid
          ? ['sid', sid]
          : ['sam', sam as string];

      const obj = await store.lookup(by, value, {
        force,
        onProgress: ctx?.reportProgress,
      });
      if (!obj) {
        return { found: false, searchedBy: by, value, snapshot: store.stats() };
      }
      return { found: true, snapshot: store.stats(), object: presentObject(obj) };
    },
  },
];
