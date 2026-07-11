/**
 * Assemble the control graph from the resident AD objects and answer traversal
 * queries. Built as an optional layer AFTER the attribute snapshot is warm
 * (see the store lifecycle) — pure CPU over in-memory data, no extra API calls.
 *
 * Responsibilities:
 *   - Build nodes keyed by node key (objectSID, else objectGUID).
 *   - Derive raw edges (attribute + SDDL) and RESOLVE their targets: DNs and
 *     SIDs referenced by edges are mapped to the node keys that own them, so a
 *     `memberof` DN becomes an edge to the group's node.
 *   - Maintain BOTH forward and reverse adjacency, so blast-radius (forward) and
 *     asset-exposure (reverse) are equally cheap.
 *
 * Edges whose target can't be resolved to a known node are kept as "dangling"
 * (they point at an out-of-scope / foreign principal) rather than dropped, so a
 * cross-domain reference doesn't silently vanish — but they don't extend a path
 * beyond the known graph.
 *
 * Facts, not verdicts: the graph reports reachability and the edges that make it,
 * never a severity.
 */

import type { StoredADObject } from '../ad-object-store.js';
import { edgesForObject, nodeKeyFor, type EdgeKind, type RawEdge } from './edges.js';
import { isSyntheticObject } from './credentials.js';

/** A resolved edge between two node keys. */
export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  via: RawEdge['via'];
  detail?: string;
}

/** A node in the control graph. */
export interface GraphNode {
  key: string;
  sid: string | null;
  name: string | null;
  dn: string | null;
  type: string; // e.g. user/group/computer/OU (best-effort from objectclass)
  directoryId: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  dangling: number;
  builtMs: number;
}

/** Progress callback for the (potentially long) build. */
export type GraphProgress = (info: { processed: number; total: number }) => void;

export class ControlGraph {
  private nodes = new Map<string, GraphNode>();
  private forward = new Map<string, Edge[]>();
  private reverse = new Map<string, Edge[]>();
  /** distinguishedName (lower) -> node key, for lookup by DN. */
  private byDn = new Map<string, string>();
  /** samAccountName (lower) -> node key, for lookup by SAM name. */
  private bySam = new Map<string, string>();
  /** domain SID (lower, no RID) -> node keys of security principals in it. */
  private principalsByDomain = new Map<string, string[]>();
  /** node keys whose type is 'domain' (the domain-head hubs). */
  private domainKeys: string[] = [];
  private dangling = 0;
  private builtMs = 0;

  /** Build the graph from all stored objects. `now` is injected for testing. */
  static build(
    objects: StoredADObject[],
    onProgress?: GraphProgress,
    now: () => number = Date.now
  ): ControlGraph {
    const g = new ControlGraph();
    const start = now();

    // Pass 1: nodes, plus DN and SID -> node-key indexes for target resolution.
    const byDn = g.byDn;
    const bySid = new Map<string, string>();
    for (const obj of objects) {
      // Skip TIE's synthetic analysis objects (passwordHashScan / -Reuse): they
      // are data ABOUT principals, not principals, and share a principal's DN —
      // admitting them as nodes produced bogus edges (e.g. fake Tier-0 members).
      // Their signal is folded onto principals in the store layer (§10.2/10.3).
      if (isSyntheticObject(obj.record)) continue;

      const key = nodeKeyFor(obj);
      const sid = strField(obj, 'objectsid');
      const dn = strField(obj, 'distinguishedname');
      const sam = strField(obj, 'samaccountname');
      g.nodes.set(key, {
        key,
        sid: sid?.toLowerCase() ?? null,
        name: sam ?? strField(obj, 'cn'),
        dn,
        type: classify(obj),
        directoryId: obj.directoryId,
      });
      if (dn) {
        // On a DN collision, prefer the real principal (has a SID) over a
        // SID-less object so edges resolve to the principal, not a companion.
        const dnKey = dn.toLowerCase();
        const incumbent = byDn.get(dnKey);
        if (!incumbent || (sid && !g.nodes.get(incumbent)?.sid)) {
          byDn.set(dnKey, key);
        }
      }
      if (sid) bySid.set(sid.toLowerCase(), key);
      if (sam) g.bySam.set(sam.toLowerCase(), key);
    }

    // Pass 1b: index domain heads and their in-domain security principals, so
    // the virtual `Controls` expansion (traverse.ts) is O(1) per domain hop.
    // A domain node's SID is the domain SID (no RID); a principal is in that
    // domain when its SID is that domain SID + "-<rid>".
    for (const [key, node] of g.nodes) {
      if (node.type === 'domain' && node.sid) g.domainKeys.push(key);
    }
    const domainSids = g.domainKeys
      .map((k) => g.nodes.get(k)!.sid!)
      .sort((a, b) => b.length - a.length); // longest first for prefix match
    for (const [key, node] of g.nodes) {
      if (!node.sid || node.type === 'domain') continue;
      const dom = domainSids.find((d) => node.sid!.startsWith(d + '-'));
      if (dom) {
        const list = g.principalsByDomain.get(dom);
        if (list) list.push(key);
        else g.principalsByDomain.set(dom, [key]);
      }
    }

    // Pass 2: derive + resolve edges.
    let processed = 0;
    for (const obj of objects) {
      for (const raw of edgesForObject(obj)) {
        const from = resolveRef(raw.from, raw.fromRef ?? 'sid', byDn, bySid, g.nodes);
        const to = resolveRef(raw.to, raw.targetRef, byDn, bySid, g.nodes);
        if (!from || !to) {
          g.dangling++;
          continue; // source or target out of scope; count, don't extend graph
        }
        g.addEdge({ from, to, kind: raw.kind, via: raw.via, detail: raw.detail });
      }
      if (++processed % 5000 === 0) onProgress?.({ processed, total: objects.length });
    }

    g.builtMs = now() - start;
    onProgress?.({ processed: objects.length, total: objects.length });
    return g;
  }

  private addEdge(e: Edge): void {
    if (e.from === e.to) return; // no self-loops
    const f = this.forward.get(e.from);
    if (f) f.push(e);
    else this.forward.set(e.from, [e]);
    const r = this.reverse.get(e.to);
    if (r) r.push(e);
    else this.reverse.set(e.to, [e]);
  }

  node(key: string): GraphNode | undefined {
    return this.nodes.get(key.toLowerCase());
  }

  /** Outbound edges from a node (empty if none). Used by forward traversal. */
  edgesFrom(key: string): readonly Edge[] {
    return this.forward.get(key.toLowerCase()) ?? [];
  }

  /** Inbound edges to a node (empty if none). Used by reverse traversal. */
  edgesTo(key: string): readonly Edge[] {
    return this.reverse.get(key.toLowerCase()) ?? [];
  }

  /**
   * Resolve an identifier (node key, SID, distinguishedName, or samAccountName)
   * to a node key, or null if no node matches. Case-insensitive.
   */
  findNodeKey(identifier: string): string | null {
    const id = identifier.trim().toLowerCase();
    if (this.nodes.has(id)) return id; // already a node key (SID or GUID)
    if (this.byDn.has(id)) return this.byDn.get(id)!;
    if (this.bySam.has(id)) return this.bySam.get(id)!;
    return null;
  }

  /** All node keys (for target-set derivation / iteration). */
  allNodeKeys(): IterableIterator<string> {
    return this.nodes.keys();
  }

  /**
   * The Tier-0 target set: nodes whose SID is a well-known privileged group
   * (Domain Admins -512, Enterprise Admins -519, Administrators -544, Schema
   * Admins -518) or the domain root. This is the "domain-admins" preset; the
   * "tier0-derived" preset (reverse-reachability closure) is computed by the
   * exposure tool on top of these seeds.
   */
  tier0Seeds(): string[] {
    const seeds: string[] = [];
    const privRids = new Set(['512', '519', '518', '520']);
    for (const [key, node] of this.nodes) {
      if (!node.sid) continue;
      const rid = node.sid.slice(node.sid.lastIndexOf('-') + 1);
      if (node.sid === 's-1-5-32-544' || privRids.has(rid)) seeds.push(key);
    }
    return seeds;
  }

  /** True if `key` is a domain-head node (a `Controls` hub). */
  isDomain(key: string): boolean {
    return this.nodes.get(key.toLowerCase())?.type === 'domain';
  }

  /**
   * The domain-head node key that controls `principalKey` (the domain whose SID
   * is a prefix of the principal's SID), or null. Used by reverse traversal to
   * treat domain compromise as an inbound predecessor of each in-domain object.
   */
  controllingDomainOf(principalKey: string): string | null {
    const node = this.nodes.get(principalKey.toLowerCase());
    if (!node?.sid || node.type === 'domain') return null;
    for (const dk of this.domainKeys) {
      const dsid = this.nodes.get(dk)!.sid!;
      if (node.sid.startsWith(dsid + '-')) return dk;
    }
    return null;
  }

  /**
   * Node keys of security principals in the domain whose head is `domainKey`
   * (i.e. the objects a domain compromise `Controls`). Empty if not a domain or
   * the domain has no in-scope principals.
   */
  principalsControlledBy(domainKey: string): readonly string[] {
    const sid = this.nodes.get(domainKey.toLowerCase())?.sid;
    if (!sid) return [];
    return this.principalsByDomain.get(sid) ?? [];
  }

  /**
   * Is `principalKey` a security principal controlled by domain `domainKey`?
   * O(1) — used by targeted path-finding to synthesize a single Controls hop
   * without enumerating the whole domain.
   */
  domainControls(domainKey: string, principalKey: string): boolean {
    const domSid = this.nodes.get(domainKey.toLowerCase())?.sid;
    const pSid = this.nodes.get(principalKey.toLowerCase())?.sid;
    if (!domSid || !pSid) return false;
    return pSid.startsWith(domSid + '-');
  }

  stats(): GraphStats {
    let edges = 0;
    for (const list of this.forward.values()) edges += list.length;
    return { nodes: this.nodes.size, edges, dangling: this.dangling, builtMs: this.builtMs };
  }
}

/** Read a store record field as a plain string. */
function strField(obj: StoredADObject, key: string): string | null {
  const v = obj.record[key];
  return typeof v === 'string' && v ? v : null;
}

/** Best-effort node type from objectclass / samaccounttype. */
function classify(obj: StoredADObject): string {
  const oc = obj.record['objectclass'];
  const classes = Array.isArray(oc) ? oc.map(String) : [];
  if (classes.includes('computer')) return 'computer';
  if (classes.includes('group')) return 'group';
  if (classes.includes('user')) return 'user';
  if (classes.includes('organizationalUnit')) return 'ou';
  if (classes.includes('groupPolicyContainer')) return 'gpo';
  if (classes.includes('domainDNS')) return 'domain';
  return classes[classes.length - 1] ?? obj.type;
}

/** Resolve a raw edge reference (key/sid/dn/guid) to a known node key, or null. */
function resolveRef(
  ref: string,
  kind: 'sid' | 'dn' | 'guid' | 'key',
  byDn: Map<string, string>,
  bySid: Map<string, string>,
  nodes: Map<string, GraphNode>
): string | null {
  const lower = ref.toLowerCase();
  if (kind === 'key') return nodes.has(lower) ? lower : null; // already a node key
  if (kind === 'dn') return byDn.get(lower) ?? null;
  if (kind === 'sid') return bySid.get(lower) ?? (lower.startsWith('s-1-') ? lower : null);
  return null; // guid refs resolved later if needed
}
