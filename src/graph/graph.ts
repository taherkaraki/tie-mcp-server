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
    const byDn = new Map<string, string>();
    const bySid = new Map<string, string>();
    for (const obj of objects) {
      const key = nodeKeyFor(obj);
      const sid = strField(obj, 'objectsid');
      const dn = strField(obj, 'distinguishedname');
      g.nodes.set(key, {
        key,
        sid: sid?.toLowerCase() ?? null,
        name: strField(obj, 'samaccountname') ?? strField(obj, 'cn'),
        dn,
        type: classify(obj),
        directoryId: obj.directoryId,
      });
      if (dn) byDn.set(dn.toLowerCase(), key);
      if (sid) bySid.set(sid.toLowerCase(), key);
    }

    // Pass 2: derive + resolve edges.
    let processed = 0;
    for (const obj of objects) {
      for (const raw of edgesForObject(obj)) {
        const from = resolveRef(raw.from, 'sid', byDn, bySid) ?? raw.from.toLowerCase();
        const to = resolveRef(raw.to, raw.targetRef, byDn, bySid);
        if (!to) {
          g.dangling++;
          continue; // target out of scope; keep count, don't extend graph
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

/** Resolve a raw edge reference (sid/dn/guid) to a known node key, or null. */
function resolveRef(
  ref: string,
  kind: 'sid' | 'dn' | 'guid',
  byDn: Map<string, string>,
  bySid: Map<string, string>
): string | null {
  const lower = ref.toLowerCase();
  if (kind === 'dn') return byDn.get(lower) ?? null;
  if (kind === 'sid') return bySid.get(lower) ?? (lower.startsWith('s-1-') ? lower : null);
  return null; // guid refs resolved later if needed
}
