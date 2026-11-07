import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";

// Generic moves within one node's incoming list: internal exports for tests,
// benchmarks and graph tools; the runtime does not call them. The moves of
// the tracking tiers are in ./cursorMoves.ts. Outgoing lists are never
// reordered.
//
// "Unchecked": the preconditions listed on each function are the caller's
// responsibility and are not verified.

/**
 * Move `movedEdge` after `insertAfterEdge` in the incoming list of `consumer`,
 * or to its head when `insertAfterEdge` is null. A no-op when already there.
 *
 * Preconditions:
 * - `movedEdge` is in the incoming list of `consumer`
 * - `insertAfterEdge` is null or in the same list
 */
export function moveIncomingEdgeAfterUnchecked(
  consumer: ReactiveNode,
  movedEdge: ReactiveEdge,
  insertAfterEdge: ReactiveEdge | null,
): void {
  if (movedEdge === insertAfterEdge || movedEdge.prevIn === insertAfterEdge)
    return;

  const previousIncomingEdge = movedEdge.prevIn;
  const nextIncomingEdge = movedEdge.nextIn;

  if (previousIncomingEdge !== null)
    previousIncomingEdge.nextIn = nextIncomingEdge;
  else consumer.firstIn = nextIncomingEdge;

  if (nextIncomingEdge !== null) nextIncomingEdge.prevIn = previousIncomingEdge;
  else consumer.lastIn = previousIncomingEdge;

  const nextEdgeAtInsertion =
    insertAfterEdge !== null ? insertAfterEdge.nextIn : consumer.firstIn;

  movedEdge.prevIn = insertAfterEdge;
  movedEdge.nextIn = nextEdgeAtInsertion;

  if (nextEdgeAtInsertion !== null) nextEdgeAtInsertion.prevIn = movedEdge;
  else consumer.lastIn = movedEdge;

  if (insertAfterEdge !== null) insertAfterEdge.nextIn = movedEdge;
  else consumer.firstIn = movedEdge;
}

/**
 * Move an incoming edge that is neither head nor tail after another edge.
 *
 * Preconditions:
 * - movedEdge.prevIn !== null
 * - movedEdge.nextIn !== null
 * - insertAfterEdge !== movedEdge
 * - insertAfterEdge belongs to the same incoming list
 * - movedEdge.prevIn !== insertAfterEdge
 */
export function moveMiddleIncomingEdgeAfterEdgeUnchecked(
  consumer: ReactiveNode,
  movedEdge: ReactiveEdge,
  insertAfterEdge: ReactiveEdge,
): void {
  const previousIncomingEdge = movedEdge.prevIn!;
  const nextIncomingEdge = movedEdge.nextIn!;

  previousIncomingEdge.nextIn = nextIncomingEdge;
  nextIncomingEdge.prevIn = previousIncomingEdge;

  const nextEdgeAtInsertion = insertAfterEdge.nextIn;

  movedEdge.prevIn = insertAfterEdge;
  movedEdge.nextIn = nextEdgeAtInsertion;

  if (nextEdgeAtInsertion !== null) nextEdgeAtInsertion.prevIn = movedEdge;
  else consumer.lastIn = movedEdge;

  insertAfterEdge.nextIn = movedEdge;
}

/**
 * Move a non-head incoming edge to the head.
 *
 * Preconditions:
 * - movedEdge.prevIn !== null
 * - `movedEdge` is in the incoming list of `consumer`
 */
export function moveNonHeadIncomingEdgeToFrontUnchecked(
  consumer: ReactiveNode,
  movedEdge: ReactiveEdge,
): void {
  const previousIncomingEdge = movedEdge.prevIn!;
  const nextIncomingEdge = movedEdge.nextIn;

  previousIncomingEdge.nextIn = nextIncomingEdge;

  if (nextIncomingEdge !== null) nextIncomingEdge.prevIn = previousIncomingEdge;
  else consumer.lastIn = previousIncomingEdge;

  const firstIncomingEdge = consumer.firstIn!;

  movedEdge.prevIn = null;
  movedEdge.nextIn = firstIncomingEdge;
  firstIncomingEdge.prevIn = movedEdge;

  consumer.firstIn = movedEdge;
}

/**
 * Move the last incoming edge to the head.
 *
 * Preconditions:
 * - lastIncomingEdge.nextIn === null
 * - lastIncomingEdge.prevIn !== null
 */
export function moveLastIncomingEdgeToFrontUnchecked(
  consumer: ReactiveNode,
  lastIncomingEdge: ReactiveEdge,
): void {
  const previousLastEdge = lastIncomingEdge.prevIn!;

  previousLastEdge.nextIn = null;
  consumer.lastIn = previousLastEdge;

  const firstIncomingEdge = consumer.firstIn!;

  lastIncomingEdge.prevIn = null;
  lastIncomingEdge.nextIn = firstIncomingEdge;
  firstIncomingEdge.prevIn = lastIncomingEdge;

  consumer.firstIn = lastIncomingEdge;
}

/**
 * Move the last incoming edge after another edge; a no-op when it is already
 * there.
 *
 * Preconditions:
 * - movedEdge.nextIn === null
 * - movedEdge.prevIn !== null
 * - insertAfterEdge !== movedEdge
 * - insertAfterEdge belongs to the same incoming list
 */
export function moveLastIncomingEdgeAfterEdgeUnchecked(
  consumer: ReactiveNode,
  movedEdge: ReactiveEdge,
  insertAfterEdge: ReactiveEdge,
): void {
  if (movedEdge.prevIn === insertAfterEdge) return;

  const previousIncomingEdge = movedEdge.prevIn!;

  previousIncomingEdge.nextIn = null;
  consumer.lastIn = previousIncomingEdge;

  const nextEdgeAtInsertion = insertAfterEdge.nextIn!;

  movedEdge.prevIn = insertAfterEdge;
  movedEdge.nextIn = nextEdgeAtInsertion;

  nextEdgeAtInsertion.prevIn = movedEdge;

  insertAfterEdge.nextIn = movedEdge;
}
