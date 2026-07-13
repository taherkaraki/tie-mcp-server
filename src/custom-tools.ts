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
import {
  ADObjectStore,
  type StoreOptions,
  type StoredADObject,
  type ScanProgress,
} from './ad-object-store.js';
import { QuerySyntaxError } from './query/lexer.js';
import { decodeSecurityDescriptor } from './graph/decode.js';
import { reachable, shortestPath, DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES } from './graph/traverse.js';
import type { ControlGraph } from './graph/graph.js';
import { DevianceStore, type DirectoryRef } from './deviance/store.js';
import { identity360, identity360Summary } from './deviance/identity360.js';

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
 *
 * `storeOptions` lets the server inject configuration (e.g. a TTL from
 * TIE_CACHE_TTL_MS) before the store is first created; it must be set prior to
 * any tool call to take effect. Absent config falls back to the store defaults.
 */
let sharedStore: ADObjectStore | null = null;
let sharedDevianceStore: DevianceStore | null = null;
let storeOptions: StoreOptions = {};
/** Base URL of the TIE console, for building UI deeplinks. Set at startup. */
let consoleBaseUrl = '';

/** Configure the shared store before first use (called once at startup). */
export function configureStore(options: StoreOptions & { baseUrl?: string }): void {
  storeOptions = { ttlMs: options.ttlMs };
  if (options.baseUrl) consoleBaseUrl = options.baseUrl;
}

function getStore(client: TIEClient): ADObjectStore {
  if (!sharedStore) sharedStore = new ADObjectStore(client, storeOptions);
  return sharedStore;
}

function getDevianceStore(client: TIEClient): DevianceStore {
  if (!sharedDevianceStore) sharedDevianceStore = new DevianceStore(client, storeOptions);
  return sharedDevianceStore;
}

/** Resolve the effective profile: explicit id, else the user's preferred profile. */
async function resolveProfile(
  client: TIEClient,
  explicit: number | undefined
): Promise<{ id: number; name: string }> {
  const profiles = await client.get<Profile[]>('/api/profiles');
  let id = explicit;
  if (id === undefined) {
    const prefs = await client.get<Preferences>('/api/preferences');
    id = prefs.preferredProfileId ?? profiles[0]?.id ?? 1;
  }
  const name = profiles.find((p) => p.id === id)?.name ?? String(id);
  return { id, name };
}

/** All (infrastructure, directory) pairs to scan, from the topology. */
async function allDirectories(client: TIEClient): Promise<DirectoryRef[]> {
  const dirs = await client.get<Directory[]>('/api/directories');
  return dirs.map((d) => ({ infrastructureId: d.infrastructureId, directoryId: d.id }));
}

/**
 * Expose the shared store for optional startup warming (see index.ts). Creates
 * it bound to `client` if it doesn't exist yet, so a warm and the first user
 * query share the same instance and its in-flight-build dedup.
 */
export function getSharedStore(client: TIEClient): ADObjectStore {
  return getStore(client);
}

/**
 * Server-derived fields that are folded onto a principal's queryable record but
 * aren't in the raw API attributes (so they'd otherwise be invisible in output).
 * Surfaced under a `derived` block so callers can SEE why a credential filter
 * matched, without polluting the faithful `attributes` list.
 */
const DERIVED_FIELDS = [
  'isbreached',
  'isntblank',
  'islmblank',
  'isweak',
  'isweakbyprofile',
] as const;

/** Shape a stored object for tool output: identity + raw attributes + derived. */
function presentObject(obj: StoredADObject) {
  const derived: Record<string, unknown> = {};
  for (const f of DERIVED_FIELDS) {
    if (f in obj.record) derived[f] = obj.record[f];
  }
  return {
    id: obj.id,
    objectId: obj.objectId,
    type: obj.type,
    directoryId: obj.directoryId,
    attributes: obj.raw.objectAttributes,
    ...(Object.keys(derived).length > 0 ? { derived } : {}),
  };
}

/**
 * Ensure the control graph is ready, building it on demand. Graph queries build
 * the graph if it isn't present (a first graph query pays the build cost, then
 * subsequent ones are fast) — unlike the startup warm, which is opt-in. Returns
 * the ready graph, or a `notReady` status object for the tool to return as-is.
 */
async function ensureGraph(
  store: ADObjectStore,
  onProgress?: ScanProgress
): Promise<
  | { graph: ControlGraph }
  | { notReady: { error: string; graphState: string; hint: string } }
> {
  // buildGraph() loads the snapshot first, then builds edges; it dedups
  // concurrent builds and is a no-op once ready.
  await store.buildGraph(
    onProgress
      ? ({ processed, total }) => onProgress({ pages: processed, objects: total })
      : undefined
  );
  const graph = store.getGraph();
  if (!graph) {
    const status = store.graphStatus();
    return {
      notReady: {
        error: 'Control graph is not ready',
        graphState: status.state,
        hint: 'The graph is still building; retry shortly.',
      },
    };
  }
  return { graph };
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
      '(admincount>0 AND useraccountcontrol:"NORMAL") OR badpwdcount>=5. ' +
      'CACHING: the snapshot is cached for a long TTL (1 day by default; the ' +
      'response "snapshot" reports its age and ttlMs). It is NOT live — if the ' +
      'directory may have changed, or the data must be current, pass ' +
      'refresh:true to force a fresh scan.',
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
      'the object with all of its attributes, or a not-found result. CACHING: the ' +
      'snapshot is cached for a long TTL (1 day by default; the response ' +
      '"snapshot" reports its age and ttlMs) and is NOT live — pass refresh:true ' +
      'to force a fresh scan when current data is required. Set ' +
      'decodeSecurityDescriptor:true to also return the object\'s ' +
      'ntSecurityDescriptor parsed into readable ACEs (trustee SIDs resolved to ' +
      'names, rights and object-types named) — useful for inspecting who has ' +
      'which permissions without hand-parsing SDDL.',
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
        decodeSecurityDescriptor: {
          type: 'boolean',
          description:
            'Also return the ntSecurityDescriptor decoded into readable ACEs ' +
            '(resolved trustees, named rights). Facts only, no risk scoring.',
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
      const decode = args.decodeSecurityDescriptor === true;

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

      const result: Record<string, unknown> = {
        found: true,
        snapshot: store.stats(),
        object: presentObject(obj),
      };

      if (decode) {
        const sddl = obj.record['ntsecuritydescriptor'];
        result.securityDescriptor =
          typeof sddl === 'string'
            ? decodeSecurityDescriptor(
                sddl,
                (s) => store.resolveSid(s),
                store.getSchemaMap()
              )
            : { error: 'Object has no ntSecurityDescriptor attribute' };
      }

      return result;
    },
  },
  {
    name: 'get_blast_radius',
    description:
      'Control-graph analysis: from a principal, list every object it can reach ' +
      'by chaining control relationships (group membership, GenericAll/WriteDacl/' +
      'WriteOwner, AddMember, ForceChangePassword, DCSync, delegation, SID ' +
      'history, GPO links). Answers "if this account is compromised, what is the ' +
      'blast radius?". Each result carries the shortest edge chain that reaches ' +
      'it. Facts only — reachability and the edges, not a severity score. NOTE: ' +
      'directory-control edges only (no logon sessions / local-admin). Requires ' +
      'the control graph; the first such call builds it (can take tens of ' +
      'seconds on a large tenant).',
    category: 'Graph',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        principal: {
          type: 'string',
          description: 'Start principal: SID, distinguishedName, or samAccountName.',
        },
        maxDepth: {
          type: 'integer',
          description: `Max control hops to follow (default ${DEFAULT_MAX_DEPTH}).`,
          minimum: 1,
        },
        maxNodes: {
          type: 'integer',
          description: `Cap on nodes returned (default ${DEFAULT_MAX_NODES}).`,
          minimum: 1,
        },
      },
      required: ['principal'],
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      const principal = args.principal as string;
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : undefined;
      const maxNodes = typeof args.maxNodes === 'number' ? args.maxNodes : undefined;
      const store = getStore(client);
      const g = await ensureGraph(store, ctx?.reportProgress);
      if ('notReady' in g) return g.notReady;

      const key = g.graph.findNodeKey(principal);
      if (!key) return { found: false, principal, reason: 'principal not found in graph' };

      // expandControls:'all' — if the principal reaches domain compromise, its
      // blast radius includes everything that domain Controls (bounded by
      // maxNodes). §9.5.
      const res = reachable(g.graph, [key], 'forward', {
        maxDepth,
        maxNodes,
        expandControls: 'all',
      });
      return {
        principal: g.graph.node(key)?.name ?? principal,
        reachableCount: res.reached.length,
        truncated: res.truncated,
        graph: store.graphStatus().stats,
        reachable: res.reached,
      };
    },
  },
  {
    name: 'get_control_paths',
    description:
      'Control-graph analysis: find the shortest control path from one principal ' +
      'to another — "how can X reach/compromise Y?". Returns the edge chain ' +
      '(e.g. bob -MemberOf-> Helpdesk -GenericAll-> dcadmin -MemberOf-> Domain ' +
      'Admins) or reports no path within the depth cap. Facts only. Requires the ' +
      'control graph; the first graph call builds it.',
    category: 'Graph',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source principal: SID, distinguishedName, or samAccountName.',
        },
        to: {
          type: 'string',
          description: 'Target principal/object: SID, distinguishedName, or samAccountName.',
        },
        maxDepth: {
          type: 'integer',
          description: `Max control hops (default ${DEFAULT_MAX_DEPTH}).`,
          minimum: 1,
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      const from = args.from as string;
      const to = args.to as string;
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : undefined;
      const store = getStore(client);
      const g = await ensureGraph(store, ctx?.reportProgress);
      if ('notReady' in g) return g.notReady;

      const fromKey = g.graph.findNodeKey(from);
      const toKey = g.graph.findNodeKey(to);
      if (!fromKey) return { found: false, reason: `from principal not found: ${from}` };
      if (!toKey) return { found: false, reason: `to principal not found: ${to}` };

      const result = shortestPath(g.graph, fromKey, toKey, { maxDepth });
      if (result.path === null) {
        return {
          from: g.graph.node(fromKey)?.name ?? from,
          to: g.graph.node(toKey)?.name ?? to,
          reachable: false,
          truncated: result.truncated,
          note:
            result.truncated === 'depth'
              ? 'No path within maxDepth; a longer path may exist.'
              : 'No control path found.',
        };
      }
      return {
        from: g.graph.node(fromKey)?.name ?? from,
        to: g.graph.node(toKey)?.name ?? to,
        reachable: true,
        hops: result.depth,
        path: result.path,
      };
    },
  },
  {
    name: 'get_asset_exposure',
    description:
      'Control-graph analysis (reverse): given a protected asset or the Tier-0 ' +
      'set, list every principal that can ultimately reach it by chaining control ' +
      'edges — "who is exposed to / can take over this asset?". Provide explicit ' +
      'targets, or use the built-in Tier-0 preset (Domain Admins, Enterprise ' +
      'Admins, Administrators, Schema Admins). Each attacker carries its shortest ' +
      'inbound path, closest first. Facts only. Requires the control graph.',
    category: 'Graph',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Explicit target principals (SID/DN/samAccountName). Omit to use the ' +
            'Tier-0 preset.',
        },
        tier0: {
          type: 'boolean',
          description:
            'Use the built-in Tier-0 target set (privileged groups). Default true ' +
            'when no explicit targets are given.',
        },
        maxDepth: {
          type: 'integer',
          description: `Max inbound control hops (default ${DEFAULT_MAX_DEPTH}).`,
          minimum: 1,
        },
        maxNodes: {
          type: 'integer',
          description: `Cap on principals returned (default ${DEFAULT_MAX_NODES}).`,
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      const explicit = Array.isArray(args.targets) ? (args.targets as string[]) : [];
      const useTier0 = args.tier0 === true || explicit.length === 0;
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : undefined;
      const maxNodes = typeof args.maxNodes === 'number' ? args.maxNodes : undefined;
      const store = getStore(client);
      const g = await ensureGraph(store, ctx?.reportProgress);
      if ('notReady' in g) return g.notReady;

      const keys = new Set<string>();
      for (const t of explicit) {
        const k = g.graph.findNodeKey(t);
        if (k) keys.add(k);
      }
      if (useTier0) for (const k of g.graph.tier0Seeds()) keys.add(k);

      if (keys.size === 0) {
        return { error: 'No resolvable targets', targets: explicit, tier0: useTier0 };
      }

      // expandControls:'all' (reverse) — whoever compromises a target's domain
      // is also exposed to it, via the virtual Controls predecessor. §9.5.
      const res = reachable(g.graph, [...keys], 'reverse', {
        maxDepth,
        maxNodes,
        expandControls: 'all',
      });
      return {
        targets: [...keys].map((k) => g.graph.node(k)?.name ?? k),
        exposedCount: res.reached.length,
        truncated: res.truncated,
        graph: store.graphStatus().stats,
        exposedPrincipals: res.reached,
      };
    },
  },
  {
    name: 'get_tier0',
    description:
      'Control-graph analysis: compute the DERIVED Tier-0 set — not just the ' +
      'well-known privileged groups (Domain Admins, Enterprise Admins, ' +
      'Administrators, Schema Admins), but every principal that can *become* ' +
      'privileged by chaining control edges (e.g. WriteDacl on a group whose ' +
      'members are Domain Admins). Each derived member carries the shortest ' +
      'escalation path to a privileged seed, showing exactly how it reaches ' +
      'Tier-0. Answers "what is my true Tier-0 attack surface?". Facts only. ' +
      'Requires the control graph; the first graph call builds it.',
    category: 'Graph',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: {
          type: 'integer',
          description: `Max escalation hops to consider (default ${DEFAULT_MAX_DEPTH}).`,
          minimum: 1,
        },
        maxNodes: {
          type: 'integer',
          description: `Cap on derived members returned (default ${DEFAULT_MAX_NODES}).`,
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : undefined;
      const maxNodes = typeof args.maxNodes === 'number' ? args.maxNodes : undefined;
      const store = getStore(client);
      const g = await ensureGraph(store, ctx?.reportProgress);
      if ('notReady' in g) return g.notReady;

      const seeds = new Set(g.graph.tier0Seeds());
      if (seeds.size === 0) {
        return {
          error: 'No well-known privileged groups found in the graph',
          note: 'The snapshot may not include the privileged group objects.',
        };
      }

      // Reverse-reachability from the seeds: each reached node is a de facto
      // Tier-0 member, and its inbound path is the escalation route.
      // expandControls:'all' folds in domain-compromise: a privileged group is
      // Controlled by its domain, so DCSync-ers (domain -> group) surface as
      // Tier-0 even though DCSync now terminates at the domain node, not the
      // group directly (Phase 4a scoping). §9.5.
      const res = reachable(g.graph, [...seeds], 'reverse', {
        maxDepth,
        maxNodes,
        expandControls: 'all',
      });

      const builtin = [...seeds].map((k) => ({
        node: { key: k, name: g.graph.node(k)?.name ?? null, type: g.graph.node(k)?.type ?? null },
      }));
      const derived = res.reached.map((r) => ({
        node: r.node,
        hops: r.depth,
        // Path is seed -> ... -> member (reverse traversal); reverse it so it
        // reads member -> ... -> seed (the escalation direction).
        escalationPath: [...r.path].reverse(),
      }));

      return {
        graph: store.graphStatus().stats,
        truncated: res.truncated,
        builtinCount: builtin.length,
        derivedCount: derived.length,
        tier0Total: builtin.length + derived.length,
        builtin,
        derived,
      };
    },
  },
  {
    name: 'get_identity_360',
    description:
      'Identity exposure 360: for a single AD object, return every Indicator-of-' +
      'Exposure deviance that concerns it, enriched and sorted by severity. Goes ' +
      "beyond Tenable's per-object view by resolving THREE layers: (1) target — " +
      'deviances Tenable filed directly on this object; (2) trustee — deviances ' +
      'where this identity is the dangerous principal embedded inside ANOTHER ' +
      "object's finding (e.g. a risky ACE in a Dangerous-ACE list), which never " +
      'appear under this object in Tenable; (3) inherited — deviances on a ' +
      'container/partition this object sits under, whose exposure inherits down. ' +
      'Each deviance carries its checker, reason, severity (raw O-CRITICITY plus ' +
      'the Critical/High/Medium/Low band), remediation cost (raw plus band), the ' +
      'related counterpart object, granted rights, resolved/ignored state, and a ' +
      'deeplink into the Tenable UI (plus a filter hint to narrow to the exact ' +
      'object). Provide exactly one of distinguishedName, sid, samAccountName, or ' +
      'objectId. Severity is profile-specific; omit profileId to use the preferred ' +
      'profile. Layer 3 requires the control graph and builds it on first use ' +
      '(tens of seconds on a large tenant). Deviances from checkers DISABLED in ' +
      'the profile/directory are excluded by default (see summary.suppressed). ' +
      'Facts only. CACHING: deviances + checker config are cached for a long TTL; ' +
      'pass refresh:true to force a rescan.',
    category: 'Deviance',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        distinguishedName: { type: 'string', description: 'Exact DN of the identity.' },
        sid: { type: 'string', description: 'Object SID of the identity.' },
        samAccountName: { type: 'string', description: 'SAM account name of the identity.' },
        objectId: { type: 'integer', description: 'Tenable AD object id of the identity.' },
        profileId: { type: 'integer', description: 'Profile (lens) id. Omit for the preferred profile.' },
        includeTarget: { type: 'boolean', description: 'Include deviances filed on the object (default true).' },
        includeTrustee: { type: 'boolean', description: 'Include deviances where the object is the risky trustee (default true).' },
        includeInherited: { type: 'boolean', description: 'Include container/partition-inherited deviances (default true; builds the graph).' },
        minSeverityBand: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'], description: 'Only return deviances at or above this band.' },
        includeResolved: { type: 'boolean', description: 'Include resolved deviances (default false).' },
        includeIgnored: { type: 'boolean', description: 'Include ignored deviances (default false).' },
        includeDisabledCheckers: { type: 'string', enum: ['exclude', 'flag', 'include'], description: 'How to treat deviances from disabled checkers (default exclude).' },
        refresh: { type: 'boolean', description: 'Force a fresh deviance scan instead of the cached index.' },
      },
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      return runIdentity360(client, args, ctx, false);
    },
  },
  {
    name: 'get_identity_360_summary',
    description:
      'Batch identity-exposure roll-up: for a list of AD objects, return per-' +
      'identity deviance COUNTS by severity band (Critical/High/Medium/Low), by ' +
      'layer (target/trustee/inherited), the total, and the single highest ' +
      'severity — but NOT the full deviance lists. Designed to populate per-user ' +
      'badges in a report (e.g. an attack path of several users, each showing its ' +
      'Critical/High/Medium/Low tally) in one call; drill into any identity with ' +
      'get_identity_360 for the full, sorted, deep-linked findings. Accepts a mix ' +
      'of distinguishedName / sid / samAccountName / objectId (as strings or ' +
      'numbers); unresolved inputs are returned with resolved:false rather than ' +
      'failing the batch. Counts use the same layers, profile, and filters as ' +
      'get_identity_360, so a badge here always matches the expanded view there. ' +
      'Omit profileId to use the preferred profile. Facts only. CACHING: shares ' +
      'the cached deviance index with get_identity_360 (this call warms it).',
    category: 'Deviance',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        identities: {
          type: 'array',
          items: { type: ['string', 'integer'] },
          description: 'Identities to summarize (DN / SID / samAccountName / objectId).',
        },
        profileId: { type: 'integer', description: 'Profile (lens) id. Omit for the preferred profile.' },
        includeTarget: { type: 'boolean', description: 'Include target-layer deviances (default true).' },
        includeTrustee: { type: 'boolean', description: 'Include trustee-layer deviances (default true).' },
        includeInherited: { type: 'boolean', description: 'Include inherited-layer deviances (default true; builds the graph).' },
        minSeverityBand: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'], description: 'Only count deviances at or above this band.' },
        includeResolved: { type: 'boolean', description: 'Include resolved deviances (default false).' },
        includeIgnored: { type: 'boolean', description: 'Include ignored deviances (default false).' },
        includeDisabledCheckers: { type: 'string', enum: ['exclude', 'flag', 'include'], description: 'How to treat deviances from disabled checkers (default exclude).' },
        refresh: { type: 'boolean', description: 'Force a fresh deviance scan instead of the cached index.' },
      },
      required: ['identities'],
      additionalProperties: false,
    },
    async handler(client, args, ctx) {
      return runIdentity360(client, args, ctx, true);
    },
  },
];

/**
 * Shared setup for both identity-360 tools: resolve the profile, warm the
 * deviance index (and the control graph when inheritance is on), then dispatch
 * to the single or batch projection. Returns the tool's JSON result.
 */
async function runIdentity360(
  client: TIEClient,
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  batch: boolean
): Promise<unknown> {
  const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const params = {
    profileId: typeof args.profileId === 'number' ? args.profileId : undefined,
    includeTarget: bool(args.includeTarget, true),
    includeTrustee: bool(args.includeTrustee, true),
    includeInherited: bool(args.includeInherited, true),
    disabledCheckers: (['exclude', 'flag', 'include'] as const).includes(args.includeDisabledCheckers as never)
      ? (args.includeDisabledCheckers as 'exclude' | 'flag' | 'include')
      : 'exclude',
    includeResolved: bool(args.includeResolved, false),
    includeIgnored: bool(args.includeIgnored, false),
    minSeverityBand: (['Critical', 'High', 'Medium', 'Low'] as const).includes(args.minSeverityBand as never)
      ? (args.minSeverityBand as 'Critical' | 'High' | 'Medium' | 'Low')
      : undefined,
  };
  const force = args.refresh === true;

  const adStore = getStore(client);
  const devStore = getDevianceStore(client);
  const [profile, directories, dirs] = await Promise.all([
    resolveProfile(client, params.profileId),
    allDirectories(client),
    client.get<Directory[]>('/api/directories'),
  ]);
  const dirName = (id: number) => dirs.find((d) => d.id === id)?.name ?? null;

  await devStore.ensureLoaded(profile.id, directories, {
    force,
    onProgress: ctx?.reportProgress
      ? ({ deviances }) => ctx.reportProgress?.({ pages: 0, objects: deviances })
      : undefined,
  });

  // Layer ③ needs the control graph; build it on demand (progress bridged).
  let graph = null as ControlGraph | null;
  if (params.includeInherited) {
    await adStore.buildGraph(
      ctx?.reportProgress ? ({ processed, total }) => ctx.reportProgress?.({ pages: processed, objects: total }) : undefined
    );
    graph = adStore.getGraph();
  }

  const stores = { adStore, devStore, graph };
  const opts = {
    baseUrl: consoleBaseUrl,
    profileName: profile.name,
    disabledCheckers: params.disabledCheckers,
    includeResolved: params.includeResolved,
    includeIgnored: params.includeIgnored,
    minSeverityBand: params.minSeverityBand,
  };
  const meta = {
    profile: { id: profile.id, name: profile.name, wasDefault: params.profileId === undefined },
    layersIncluded: [
      params.includeTarget ? 'target' : null,
      params.includeTrustee ? 'trustee' : null,
      params.includeInherited && graph ? 'inherited' : null,
    ].filter(Boolean),
    graphBuilt: graph !== null,
    index: devStore.stats(),
  };

  if (batch) {
    const identities = Array.isArray(args.identities) ? (args.identities as Array<string | number>) : [];
    const refs = identities.map((v) => (typeof v === 'number' ? { objectId: v } : v));
    const res = await identity360Summary(stores, refs, params, opts, dirName);
    return { ...res, meta };
  }
  const ref = {
    distinguishedName: args.distinguishedName as string | undefined,
    sid: args.sid as string | undefined,
    samAccountName: args.samAccountName as string | undefined,
    objectId: typeof args.objectId === 'number' ? args.objectId : undefined,
  };
  const provided = [ref.distinguishedName, ref.sid, ref.samAccountName, ref.objectId].filter((v) => v !== undefined);
  if (provided.length !== 1) {
    return { error: 'Provide exactly one of distinguishedName, sid, samAccountName, or objectId.' };
  }
  const res = await identity360(stores, ref, params, opts, dirName);
  return { ...res, meta };
}
