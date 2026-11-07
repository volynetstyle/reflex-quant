import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

import { findEdgeInLockstep } from "./findEdge";
import { linkEdge } from "./linkEdge";

// The default read-tracking strategy (kernel/config.ts) and its
// reconciliation step. The resolver never calls them: while the default is
// configured, it reconciles its own lookup result with the tracking moves
// (stages/tracking/resolve.ts, shape/graph/cursorMoves.ts). Benchmarks and
// tools call them directly, with insertion and suffix positions of their own.

/**
 * Move a suffix edge after `insertAfterEdge`, or to the head when it is null;
 * a no-op when the edge is already there. The same move as
 * moveIncomingEdgeAfterUnchecked, kept here so the strategy's callers inline
 * it (A.graph.reuse-first-out).
 */
function moveSuffixEdgeAfterCursor(
  consumer: ReactiveNode,
  edge: ReactiveEdge,
  insertAfterEdge: ReactiveEdge | null,
): void {
  const previousIncomingEdge = edge.prevIn;
  if (previousIncomingEdge === insertAfterEdge) return;

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.tracking.edge.move");
  const nextIncomingEdge = edge.nextIn;

  if (insertAfterEdge === null) {
    // The previous edge is non-null: an existing head already returned above.
    previousIncomingEdge!.nextIn = nextIncomingEdge;
    if (nextIncomingEdge !== null)
      nextIncomingEdge.prevIn = previousIncomingEdge;
    else consumer.lastIn = previousIncomingEdge;
    const firstIncomingEdge = consumer.firstIn!;
    edge.prevIn = null;
    edge.nextIn = firstIncomingEdge;
    firstIncomingEdge.prevIn = edge;
    consumer.firstIn = edge;
    return;
  }
  // An edge moved after itself stays, as in moveIncomingEdgeAfterUnchecked.
  if (previousIncomingEdge === null && edge === insertAfterEdge) return;
  if (previousIncomingEdge !== null)
    previousIncomingEdge.nextIn = nextIncomingEdge;
  else consumer.firstIn = nextIncomingEdge;
  if (nextIncomingEdge !== null) nextIncomingEdge.prevIn = previousIncomingEdge;
  else consumer.lastIn = previousIncomingEdge;

  const nextEdgeAtInsertion = insertAfterEdge.nextIn;
  edge.prevIn = insertAfterEdge;
  edge.nextIn = nextEdgeAtInsertion;
  if (nextEdgeAtInsertion !== null) nextEdgeAtInsertion.prevIn = edge;
  else consumer.lastIn = edge;
  insertAfterEdge.nextIn = edge;
}

/**
 * Commit a read whose edge has already been located.
 *
 * `edge` is the result of an exact lookup of `producer -> consumer` that is
 * known not to lie in the tracked prefix: an existing edge is in the suffix
 * and is moved after `insertAfterEdge`; `null` means the pair has no edge and
 * a new one is linked there.
 *
 * The unvisited suffix is never unlinked here. Its edges keep their identity
 * until cleanupUnvisitedSources removes whatever the pass did not read, so a
 * later read of a suffix producer moves its existing edge instead of linking
 * a new one. While the pass runs, suffix edges carry no causal authority:
 * propagation marks a computing consumer only through its tracked prefix.
 * `suffixStartEdge` no longer takes part; it stays in the signature of this
 * internal export.
 */
export function reuseLocatedIncomingEdgeOrLink(
  producer: ReactiveNode,
  consumer: ReactiveNode,
  insertAfterEdge: ReactiveEdge | null,
  suffixStartEdge: ReactiveEdge | null,
  passStamp: number,
  edge: ReactiveEdge | null,
): ReactiveEdge {
  if (edge !== null) {
    moveSuffixEdgeAfterCursor(consumer, edge, insertAfterEdge);
    edge.stamp = passStamp;

    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.tracking.suffix.reuse");
    return edge;
  }

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.tracking.suffix.link-new");
  return linkEdge(producer, consumer, insertAfterEdge, passStamp);
}

/**
 * Resolve a producer -> consumer incoming edge relative to a known insertion
 * position: the default read tracking strategy.
 *
 * Precondition: `producer` was not read earlier in this pass, so any existing
 * edge of the pair lies in the suffix that starts at `suffixStartEdge` (the
 * whole incoming list when it is `null`).
 *
 * The suffix head is compared directly, then the producer's newest edge;
 * otherwise findEdgeInLockstep locates the edge over the producer's outgoing
 * list and the rest of the suffix. The result is reused or linked by
 * reuseLocatedIncomingEdgeOrLink.
 */
export function reuseIncomingEdgeFromSuffixOrLink(
  producer: ReactiveNode,
  consumer: ReactiveNode,
  insertAfterEdge: ReactiveEdge | null,
  suffixStartEdge: ReactiveEdge | null,
  passStamp = 0,
): ReactiveEdge {
  if (suffixStartEdge !== null && suffixStartEdge.from === producer) {
    suffixStartEdge.stamp = passStamp;
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.tracking.suffix.head-hit",
      );
    return suffixStartEdge;
  }

  // The producer's newest edge answers a pair linked or relinked last, and
  // every pair of a producer with one subscriber, without the lookup.
  const newest = producer.lastOut;
  const edge =
    newest !== null && newest.to === consumer
      ? newest
      : findEdgeInLockstep(
          producer,
          consumer,
          null,
          suffixStartEdge === null ? consumer.firstIn : suffixStartEdge.nextIn,
        );

  return reuseLocatedIncomingEdgeOrLink(
    producer,
    consumer,
    insertAfterEdge,
    suffixStartEdge,
    passStamp,
    edge,
  );
}

/** Earlier name of reuseIncomingEdgeFromSuffixOrLink, kept as an export. */
export const reuseIncomingEdgeFromSuffixOrCreate =
  reuseIncomingEdgeFromSuffixOrLink;
