/**
 * Traversal over the control graph — the engine behind the three query lenses:
 *   - blast radius (forward reachability from a principal)
 *   - control paths (shortest path[s] between two nodes)
 *   - asset exposure (reverse reachability into a target/Tier-0 set)
 *
 * All three are BFS over the same bidirectional graph; they differ only in
 * direction (edgesFrom vs edgesTo) and start set. BFS gives shortest paths in an
 * unweighted graph, which is what defenders want ("closest attacker first").
 *
 * Guardrails (a security tool must never silently under-report):
 *   - maxDepth caps hops (default DEFAULT_MAX_DEPTH). Depth is shallow in AD;
 *     breadth is the real cost, so maxNodes caps total visited nodes.
 *   - When a cap stops expansion with frontier remaining, the result flags
 *     `truncated` with the reason, so "no more paths" is never faked.
 *
 * Facts, not verdicts: results report reachability and the edge chain that makes
 * it. Severity is the caller's / Tenable IOE's judgment.
 */

import type { ControlGraph, Edge, GraphNode } from './graph.js';

/** Default hop cap — comfortably covers real AD control paths. */
export const DEFAULT_MAX_DEPTH = 6;
/** Default cap on total nodes visited, guarding against fan-out explosion. */
export const DEFAULT_MAX_NODES = 2000;

export interface TraverseOptions {
  maxDepth?: number;
  maxNodes?: number;
  /**
   * Virtual `Controls` expansion when traversal reaches a domain node (§9.5):
   *   'off'       — default; domain compromise does not expand further.
   *   'toTargets' — synthesize a Controls hop only to keys in `controlsTargets`
   *                 (O(1) per domain; used by targeted A→B path-finding).
   *   'all'       — synthesize Controls to every in-domain principal (bounded by
   *                 maxNodes; used by open-ended blast radius).
   * Only meaningful for forward traversal.
   */
  expandControls?: 'off' | 'toTargets' | 'all';
  /** Target node keys for expandControls: 'toTargets'. */
  controlsTargets?: Set<string>;
}

/** One hop in a reconstructed path. */
export interface PathStep {
  from: NodeRef;
  to: NodeRef;
  kind: Edge['kind'];
  via: Edge['via'];
  detail?: string;
}

/** A node as reported in results: key plus resolved identity, when known. */
export interface NodeRef {
  key: string;
  name: string | null;
  type: string | null;
}

export interface ReachEntry {
  node: NodeRef;
  /** Hop distance from the start (1 = directly adjacent). */
  depth: number;
  /** Shortest edge chain from the start to this node. */
  path: PathStep[];
}

export interface TraverseResult {
  start: NodeRef[];
  direction: 'forward' | 'reverse';
  reached: ReachEntry[];
  truncated: null | 'depth' | 'nodes';
  visited: number;
}

function nodeRef(g: ControlGraph, key: string): NodeRef {
  const n: GraphNode | undefined = g.node(key);
  return { key, name: n?.name ?? null, type: n?.type ?? null };
}

function stepFrom(g: ControlGraph, e: Edge): PathStep {
  return {
    from: nodeRef(g, e.from),
    to: nodeRef(g, e.to),
    kind: e.kind,
    via: e.via,
    detail: e.detail,
  };
}

/**
 * BFS reachability from a set of start keys in one direction. Returns every
 * reachable node with its shortest path. Shared by all three query lenses.
 */
export function reachable(
  graph: ControlGraph,
  starts: string[],
  direction: 'forward' | 'reverse',
  opts: TraverseOptions = {}
): TraverseResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const expandControls = opts.expandControls ?? 'off';

  // Synthetic Controls edges (virtual — never stored), materialized as needed.
  // Forward: from a domain node → the principals it controls.
  // Reverse: from a principal → the domain head that controls it (its inbound
  //   Controls predecessor), so exposure/who-can-reach queries account for
  //   domain compromise. Both always encode the edge as domain --Controls-->
  //   principal so the path reads consistently regardless of traversal dir.
  const mkControls = (domainKey: string, principalKey: string): Edge => ({
    from: domainKey,
    to: principalKey,
    kind: 'Controls',
    via: 'domainControls',
  });

  const controlsNeighbours = (key: string): Edge[] => {
    if (expandControls === 'off') return [];
    if (direction === 'forward') {
      if (!graph.isDomain(key)) return [];
      if (expandControls === 'toTargets') {
        const out: Edge[] = [];
        for (const t of opts.controlsTargets ?? []) {
          if (graph.domainControls(key, t)) out.push(mkControls(key, t));
        }
        return out;
      }
      return graph.principalsControlledBy(key).map((p) => mkControls(key, p)); // 'all'
    }
    // reverse: this principal's controlling domain is an inbound predecessor.
    const dom = graph.controllingDomainOf(key);
    return dom ? [mkControls(dom, key)] : [];
  };

  const neighbours = (key: string): readonly Edge[] => {
    const real = direction === 'forward' ? graph.edgesFrom(key) : graph.edgesTo(key);
    const virt = controlsNeighbours(key);
    return virt.length ? [...real, ...virt] : real;
  };
  // For reverse traversal, the "next" node is the edge's source, not target.
  const nextKey = (e: Edge): string => (direction === 'forward' ? e.to : e.from);

  const startKeys = starts.map((s) => s.toLowerCase());
  const reached = new Map<string, ReachEntry>();
  const seen = new Set<string>(startKeys);
  let truncated: TraverseResult['truncated'] = null;

  // Frontier holds (key, path-so-far). Start nodes have depth 0 and empty path.
  let frontier: Array<{ key: string; path: PathStep[] }> = startKeys.map((key) => ({
    key,
    path: [],
  }));

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Array<{ key: string; path: PathStep[] }> = [];
    for (const { key, path } of frontier) {
      for (const edge of neighbours(key)) {
        const nk = nextKey(edge);
        if (seen.has(nk)) continue; // BFS: first visit is the shortest path
        seen.add(nk);

        if (reached.size >= maxNodes) {
          truncated = 'nodes';
          break;
        }

        const step = stepFrom(graph, edge);
        const newPath = [...path, step];
        reached.set(nk, { node: nodeRef(graph, nk), depth, path: newPath });
        next.push({ key: nk, path: newPath });
      }
      if (truncated === 'nodes') break;
    }
    if (truncated === 'nodes') break;
    // If we exit the loop because depth hit the cap but frontier still had more
    // to expand, flag depth truncation.
    frontier = next;
    if (depth === maxDepth && frontier.length > 0) truncated = 'depth';
  }

  return {
    start: startKeys.map((k) => nodeRef(graph, k)),
    direction,
    reached: [...reached.values()].sort((a, b) => a.depth - b.depth),
    truncated,
    visited: seen.size,
  };
}

/**
 * Shortest path(s) from `fromKey` to `toKey` (forward). Returns the single
 * shortest path (BFS) or null if unreachable within the caps.
 */
export function shortestPath(
  graph: ControlGraph,
  fromKey: string,
  toKey: string,
  opts: TraverseOptions = {}
): { path: PathStep[]; depth: number } | { path: null; truncated: TraverseResult['truncated'] } {
  const target = toKey.toLowerCase();
  // Enable virtual Controls expansion toward the target, so a path that runs
  // through domain compromise (…→ domain → target) completes instead of dead-
  // ending at the domain (§9.5). O(1) per domain reached — only the target is
  // ever synthesized. Caller opts can override.
  const result = reachable(graph, [fromKey], 'forward', {
    expandControls: 'toTargets',
    controlsTargets: new Set([target]),
    ...opts,
  });
  const hit = result.reached.find((r) => r.node.key === target);
  if (hit) return { path: hit.path, depth: hit.depth };
  return { path: null, truncated: result.truncated };
}

/**
 * Compute the DERIVED Tier-0 set: the well-known privileged seeds PLUS every
 * principal that can reach a seed by chaining control edges. These "de facto
 * Tier-0" principals aren't in a privileged group but can trivially become
 * privileged (e.g. WriteDacl on a group whose members are DA), so defenders
 * must treat them as Tier-0 too.
 *
 * Implementation: reverse-reachability from the seeds (who can reach them) unioned
 * with the seeds themselves. Bounded by the same maxDepth/maxNodes guardrails; a
 * truncated traversal returns a partial (still-safe) set and reports it.
 */
export function derivedTier0(
  graph: ControlGraph,
  seeds: string[],
  opts: TraverseOptions = {}
): { keys: string[]; truncated: TraverseResult['truncated'] } {
  const seedKeys = seeds.map((s) => s.toLowerCase());
  const set = new Set<string>(seedKeys);
  if (seedKeys.length === 0) return { keys: [], truncated: null };

  const res = reachable(graph, seedKeys, 'reverse', opts);
  for (const r of res.reached) set.add(r.node.key);
  return { keys: [...set], truncated: res.truncated };
}
