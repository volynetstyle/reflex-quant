import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";

// Incoming-list moves of the tracking tiers (stages/tracking/resolve.ts):
// each moves an unvisited suffix edge next to the tracking cursor `tailIn` of
// a computing consumer, stamps it with the pass stamp and makes it the
// cursor. A pass needs exactly two: to the head while the prefix is empty,
// right after the cursor otherwise. Generic moves are in ./edgeList.ts.
//
// "Unchecked": the preconditions listed on each function are the caller's
// responsibility and are not verified.

/**
 * Move a non-head incoming edge to the head, stamp it with the pass stamp
 * and make it the cursor: the first read of a pass that found its edge
 * elsewhere in the list.
 *
 * Preconditions:
 * - `movedEdge` is in the incoming list of `consumer`
 * - movedEdge.prevIn !== null
 */
export function moveTrackedIncomingEdgeToFrontUnchecked(
  consumer: ReactiveNode,
  movedEdge: ReactiveEdge,
  passStamp: number,
): void {
  const previousMovedEdge = movedEdge.prevIn!;
  const afterMovedEdge = movedEdge.nextIn;

  previousMovedEdge.nextIn = afterMovedEdge;

  if (afterMovedEdge !== null) {
    afterMovedEdge.prevIn = previousMovedEdge;
  } else {
    consumer.lastIn = previousMovedEdge;
  }

  const firstIncomingEdge = consumer.firstIn!;

  movedEdge.prevIn = null;
  movedEdge.nextIn = firstIncomingEdge;
  firstIncomingEdge.prevIn = movedEdge;
  consumer.firstIn = movedEdge;

  movedEdge.stamp = passStamp;
  consumer.tailIn = movedEdge;
}

/**
 * Move a suffix edge right after the tracking cursor, stamp it with the
 * cursor's stamp, the pass stamp (INV-T3), and make it the cursor: every
 * reorder of an inner cursor miss (one-hop, two-hop, the physical tail, a
 * located suffix edge).
 *
 *   cursor -> expectedNext -> ... -> movedEdge
 *
 * becomes
 *
 *   cursor -> movedEdge -> expectedNext -> ...
 *
 * Preconditions:
 * - cursorEdge.nextIn !== null
 * - movedEdge.prevIn !== null
 * - movedEdge comes after cursorEdge.nextIn
 * - all edges are in the incoming list of `consumer`
 *
 * Returns `true`; callers do not use the value.
 */
export function moveTrackedIncomingEdgeAfterCursorUnchecked(
  consumer: ReactiveNode,
  cursorEdge: ReactiveEdge,
  movedEdge: ReactiveEdge,
): true {
  const expectedNextEdge = cursorEdge.nextIn!;
  const previousMovedEdge = movedEdge.prevIn!;
  const afterMovedEdge = movedEdge.nextIn;

  previousMovedEdge.nextIn = afterMovedEdge;

  if (afterMovedEdge !== null) {
    afterMovedEdge.prevIn = previousMovedEdge;
  } else {
    consumer.lastIn = previousMovedEdge;
  }

  movedEdge.prevIn = cursorEdge;
  movedEdge.nextIn = expectedNextEdge;

  cursorEdge.nextIn = movedEdge;
  expectedNextEdge.prevIn = movedEdge;

  movedEdge.stamp = cursorEdge.stamp;
  consumer.tailIn = movedEdge;

  return true;
}
