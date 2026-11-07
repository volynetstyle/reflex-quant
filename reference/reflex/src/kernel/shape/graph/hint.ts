import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";

/**
 * Whether `edge`, read from `node.tailIn`, is an outgoing hint rather than an
 * incoming edge (INV-H).
 *
 * `tailIn` is one slot with two lifetime-disjoint readings. While the node
 * is Computing it is the tracking frontier: null or an incoming edge. While
 * it is not, the frontier reading is inactive and the slot holds null, the
 * residual incoming edge of the last pass, or a hint: one attached outgoing
 * edge of the node, the edge found by the last lookup of the node that went
 * past its constant probes (findEdgeInLockstep).
 *
 * The readings are told apart by direction: an incoming edge has
 * `to === node`, a hint has `from === node && to !== node`. A self-edge
 * satisfies both endpoint tests and always reads as incoming; the lookup
 * never writes one, since a self-read comes from the computing node itself.
 *
 * Maintenance: a hint is written only while the node is neither Computing
 * nor a watcher, every unlink of an edge clears the hint that points to it,
 * and every computation clears the slot before it becomes a frontier. So
 * whatever the slot holds is attached, a stale hint is never observed, and
 * the lookup may use any slot edge from the node: as the answer when it is
 * the edge of its pair, otherwise as the centre of a bounded walk of the
 * outgoing list raced against the lockstep (the outgoing finger). A hint is
 * a positive answer or a starting point only and proves nothing about
 * absence.
 */
export function isOutgoingHint(
  node: ReactiveNode,
  edge: ReactiveEdge,
): boolean {
  return edge.from === node && edge.to !== node;
}
