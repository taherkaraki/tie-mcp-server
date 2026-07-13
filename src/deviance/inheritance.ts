/**
 * Layer ③: container / partition inheritance.
 *
 * When a deviance is filed on a container or partition (an OU, CN=Users, a
 * domain root, a DC object, …) and an identity sits UNDER that container, the
 * exposure inherits down the containment tree — but Tenable files the deviance
 * only on the container, so it never appears under the child object's id.
 *
 * We resolve this by walking UP from the queried identity via the control
 * graph's `Contains` edges (parent -> child), collecting ancestor containers,
 * and checking whether any ancestor is itself a flagged (target) object in the
 * deviance index. Walking up is bounded by AD tree depth (~5–15 hops), so it's
 * cheap and touches only what's asked — unlike precomputing every principal
 * under every flagged container (an N×M fan-out).
 */

import type { ControlGraph } from '../graph/graph.js';

export interface AncestorContainer {
  /** Node key of the ancestor container. */
  key: string;
  /** Hops from the identity up to this container (1 = direct parent). */
  depth: number;
  /** Display name / dn of the container, for the counterpart block. */
  name: string | null;
  dn: string | null;
  /** True if this container is a domain head (a domain-wide scope). */
  isDomain: boolean;
}

/**
 * Walk up the `Contains` chain from `startKey`, returning each ancestor
 * container (nearest first), bounded by `maxDepth`. Uses reverse edges: a
 * `Contains` edge points parent -> child, so the parent is found among the
 * edges INTO the child.
 */
export function ancestorContainers(
  graph: ControlGraph,
  startKey: string,
  maxDepth = 30
): AncestorContainer[] {
  const out: AncestorContainer[] = [];
  const seen = new Set<string>([startKey.toLowerCase()]);
  let current = startKey.toLowerCase();

  for (let depth = 1; depth <= maxDepth; depth++) {
    // The parent is the source of the Contains edge pointing at `current`.
    const parentEdge = graph.edgesTo(current).find((e) => e.kind === 'Contains');
    if (!parentEdge) break;
    const parentKey = parentEdge.from.toLowerCase();
    if (seen.has(parentKey)) break; // cycle guard
    seen.add(parentKey);

    const node = graph.node(parentKey);
    out.push({
      key: parentKey,
      depth,
      name: node?.name ?? null,
      dn: node?.dn ?? null,
      isDomain: graph.isDomain(parentKey),
    });
    if (graph.isDomain(parentKey)) break; // stop at the domain root; don't cross partitions
    current = parentKey;
  }
  return out;
}
