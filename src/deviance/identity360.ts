/**
 * Orchestration for the identity-360 tools: resolve an identity, gather its
 * deviances across the three layers (target / trustee / inherited), enrich and
 * sort them, and roll up the summary. The full tool returns the sorted list;
 * the summary tool returns only the counts (same code path -> counts always
 * agree with the expanded view).
 */

import type { ADObjectStore, StoredADObject } from '../ad-object-store.js';
import type { DevianceStore } from './store.js';
import type { ControlGraph } from '../graph/graph.js';
import { ancestorContainers } from './inheritance.js';
import {
  enrichDeviance,
  sortDeviances,
  summarize,
  type LayeredDeviance,
  type ProjectOptions,
} from './project.js';
import type { SeverityBand } from './bands.js';

export interface Identity360Params {
  profileId?: number;
  includeTarget: boolean;
  includeTrustee: boolean;
  includeInherited: boolean;
  disabledCheckers: 'exclude' | 'flag' | 'include';
  includeResolved: boolean;
  includeIgnored: boolean;
  minSeverityBand?: SeverityBand;
}

/** A single gathered (deviance, layer) pair with its per-layer context. */
interface Gathered {
  devianceId: number;
  layer: LayeredDeviance['layer'];
  hit?: { grantedRights: string[]; resolvedFrom: string };
  container?: { name: string | null; dn: string | null; objectId: number; depth: number; isDomain: boolean };
}

/** Resolve an identity string/id to a store object, or null. */
export async function resolveIdentity(
  adStore: ADObjectStore,
  ref: { distinguishedName?: string; sid?: string; samAccountName?: string; objectId?: number }
): Promise<StoredADObject | null> {
  if (ref.objectId !== undefined) {
    // No direct by-id lookup on the store; scan the snapshot once (cheap, in-mem).
    await adStore.query('type=LDAP', { limit: 0 }).catch(() => undefined);
    return (await findById(adStore, ref.objectId)) ?? null;
  }
  if (ref.distinguishedName) return adStore.lookup('dn', ref.distinguishedName);
  if (ref.sid) return adStore.lookup('sid', ref.sid);
  if (ref.samAccountName) return adStore.lookup('sam', ref.samAccountName);
  return null;
}

/** Find a stored object by its numeric id via a query over the loaded snapshot. */
async function findById(adStore: ADObjectStore, id: number): Promise<StoredADObject | undefined> {
  const { returned } = await adStore.query(`id=${id}`, { limit: 1 });
  return returned[0];
}

/** Gather (deviance, layer) pairs for an identity across the enabled layers. */
export function gatherLayered(
  devStore: DevianceStore,
  adStore: ADObjectStore,
  graph: ControlGraph | null,
  obj: StoredADObject,
  params: Identity360Params
): Gathered[] {
  const out: Gathered[] = [];
  const seen = new Set<string>();
  const add = (devianceId: number, layer: Gathered['layer'], extra?: Omit<Gathered, 'devianceId' | 'layer'>) => {
    const k = `${devianceId}:${layer}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ devianceId, layer, ...extra });
  };

  const sid = strOf(obj, 'objectsid');
  const dn = strOf(obj, 'distinguishedname');

  // ① target
  if (params.includeTarget) for (const devId of devStore.forwardFor(obj.id)) add(devId, 'target');

  // ② trustee (by SID, and by DOMAIN\name / DN forms for SID-less hits)
  if (params.includeTrustee) {
    const nameForms = nameFormsFor(obj);
    const hits = [
      ...(sid ? devStore.reverseForSid(sid) : []),
      ...nameForms.flatMap((n) => devStore.reverseForName(n)),
    ];
    for (const h of hits) add(h.devianceId, 'trustee', { hit: { grantedRights: h.grantedRights, resolvedFrom: h.resolvedFrom } });
  }

  // ③ inherited (walk up Contains chain; map each container node back to its adObjectId)
  if (params.includeInherited && graph && (sid || dn)) {
    const startKey = graph.findNodeKey(sid ?? dn ?? '') ?? null;
    if (startKey) {
      for (const anc of ancestorContainers(graph, startKey)) {
        const node = graph.node(anc.key);
        const ancObjId = node?.dn ? dnToObjectId(adStore, node.dn) : null;
        if (ancObjId === null) continue;
        for (const devId of devStore.forwardFor(ancObjId)) {
          add(devId, 'inherited', {
            container: { name: anc.name, dn: anc.dn, objectId: ancObjId, depth: anc.depth, isDomain: anc.isDomain },
          });
        }
      }
    }
  }

  return out;
}

/** Enrich + sort + summarize the gathered deviances for one identity. */
export async function projectIdentity(
  devStore: DevianceStore,
  gathered: Gathered[],
  opts: ProjectOptions
): Promise<{ deviances: LayeredDeviance[]; summary: ReturnType<typeof summarize> }> {
  await devStore.ensureCheckerConfig(
    gathered.map((g) => devStore.getRaw(g.devianceId)?.checkerId).filter((c): c is number => c !== undefined)
  );

  const enriched: LayeredDeviance[] = [];
  let suppressed = 0;
  for (const g of gathered) {
    const base = enrichDeviance(devStore, g.devianceId, opts);
    if (!base) {
      if (opts.disabledCheckers === 'exclude' && devStore.getRaw(g.devianceId)) suppressed++;
      continue;
    }
    const rec: LayeredDeviance = { ...base, layer: g.layer };
    if (g.hit) {
      rec.grantedRights = g.hit.grantedRights;
      const dev = devStore.getRaw(g.devianceId);
      const nameAttr = dev?.attributes.find((a) => ['ObjectName', 'Cn', 'AccountCn', 'DistinguishedName'].includes(a.name));
      rec.counterpart = { role: 'target', name: nameAttr?.value ?? null, objectId: dev?.adObjectId ?? null, dn: null, resolvedFrom: g.hit.resolvedFrom };
      rec.deeplinkContext = `Opens ${rec.counterpart.name ?? 'the flagged object'} — this identity appears inside its ${g.hit.resolvedFrom}.`;
    } else if (g.container) {
      rec.counterpart = { role: 'partition', name: g.container.name, objectId: g.container.objectId, dn: g.container.dn, resolvedFrom: `container-inheritance (depth ${g.container.depth})` };
      rec.deeplinkContext = `Opens ${g.container.name ?? 'the container'} — this identity inherits exposure from it${g.container.isDomain ? ' (domain-wide scope)' : ''}.`;
    }
    enriched.push(rec);
  }

  const sorted = sortDeviances(enriched);
  return { deviances: sorted, summary: summarize(sorted, suppressed) };
}

// --- helpers ---

function strOf(obj: StoredADObject, key: string): string | null {
  const v = obj.record[key];
  return typeof v === 'string' && v ? v : null;
}

/** DOMAIN\name and DN forms an ACE might use to name this principal as a trustee. */
function nameFormsFor(obj: StoredADObject): string[] {
  const forms: string[] = [];
  const dn = strOf(obj, 'distinguishedname');
  if (dn) forms.push(dn);
  const sam = strOf(obj, 'samaccountname');
  // DangerousAceList Item3 is "dnsroot\sam"; we don't always know the dnsroot,
  // so match on the sam suffix by storing the bare sam too (reverseForName
  // lower-cases; a "domain\sam" hit is keyed whole, so also index bare sam).
  if (sam) forms.push(sam);
  return forms;
}

/** Map a container DN to its numeric Tenable AD object id via the snapshot. */
const dnIdCache = new WeakMap<ADObjectStore, Map<string, number>>();
function dnToObjectId(adStore: ADObjectStore, dn: string): number | null {
  // Built lazily & cached per store generation is overkill here; we do a small
  // synchronous scan through a cached DN->id map the first time.
  let map = dnIdCache.get(adStore);
  if (!map) {
    map = new Map();
    dnIdCache.set(adStore, map);
  }
  const key = dn.toLowerCase();
  if (map.has(key)) return map.get(key)!;
  return null; // populated by primeDnIndex before the walk
}

/** Populate the DN->id cache from the loaded snapshot (call once before gathering). */
export async function primeDnIndex(adStore: ADObjectStore): Promise<void> {
  const { returned } = await adStore.query('type=LDAP OR type=SYSVOL', { limit: 0 });
  let map = dnIdCache.get(adStore);
  if (!map) {
    map = new Map();
    dnIdCache.set(adStore, map);
  }
  for (const o of returned) {
    const dn = o.record['distinguishedname'];
    if (typeof dn === 'string' && dn) map.set(dn.toLowerCase(), o.id);
  }
}

// --- tool entry points (called by custom-tools.ts) ---

export interface Stores {
  adStore: ADObjectStore;
  devStore: DevianceStore;
  /** Control graph, if built (needed for layer ③); null skips inheritance. */
  graph: ControlGraph | null;
}

/** Shape the identity block for output from a resolved store object. */
function identityBlock(obj: StoredADObject, dirName: (id: number) => string | null) {
  return {
    resolved: true as const,
    name: strOf(obj, 'samaccountname') ?? strOf(obj, 'cn') ?? null,
    objectId: obj.id,
    sid: strOf(obj, 'objectsid'),
    dn: strOf(obj, 'distinguishedname'),
    type: obj.type,
    directoryId: obj.directoryId,
    directoryName: dirName(obj.directoryId),
  };
}

/** Full single-identity 360 view. */
export async function identity360(
  stores: Stores,
  ref: { distinguishedName?: string; sid?: string; samAccountName?: string; objectId?: number },
  params: Identity360Params,
  opts: ProjectOptions,
  dirName: (id: number) => string | null = () => null
) {
  const obj = await resolveIdentity(stores.adStore, ref);
  if (!obj) return { identity: { resolved: false as const, input: ref } };

  if (params.includeInherited && stores.graph) await primeDnIndex(stores.adStore);
  const gathered = gatherLayered(stores.devStore, stores.adStore, stores.graph, obj, params);
  const { deviances, summary } = await projectIdentity(stores.devStore, gathered, opts);

  return { identity: identityBlock(obj, dirName), summary, deviances };
}

/** Batch summary: per-identity band counts only, no deviance lists. */
export async function identity360Summary(
  stores: Stores,
  refs: Array<{ distinguishedName?: string; sid?: string; samAccountName?: string; objectId?: number } | string>,
  params: Identity360Params,
  opts: ProjectOptions,
  dirName: (id: number) => string | null = () => null
) {
  if (params.includeInherited && stores.graph) await primeDnIndex(stores.adStore);
  const rows: unknown[] = [];
  let unresolved = 0;
  for (const raw of refs) {
    const ref = typeof raw === 'string' ? asRef(raw) : raw;
    const obj = await resolveIdentity(stores.adStore, ref);
    if (!obj) {
      unresolved++;
      rows.push({ resolved: false, input: raw });
      continue;
    }
    const gathered = gatherLayered(stores.devStore, stores.adStore, stores.graph, obj, params);
    const { summary } = await projectIdentity(stores.devStore, gathered, opts);
    const idb = identityBlock(obj, dirName);
    rows.push({
      resolved: true,
      name: idb.name,
      objectId: idb.objectId,
      sid: idb.sid,
      bySeverityBand: summary.bySeverityBand,
      byLayer: summary.byLayer,
      total: summary.total,
      highestSeverity: summary.highestSeverity,
      suppressed: summary.suppressed,
    });
  }
  return { identities: rows, unresolved };
}

/** Interpret a bare string ref as sid / DN / sam / numeric objectId. */
function asRef(s: string): { distinguishedName?: string; sid?: string; samAccountName?: string; objectId?: number } {
  const t = s.trim();
  if (/^\d+$/.test(t)) return { objectId: Number(t) };
  if (/^s-1-/i.test(t)) return { sid: t };
  if (/=.+,/.test(t) || /^(cn|ou|dc)=/i.test(t)) return { distinguishedName: t };
  return { samAccountName: t };
}
