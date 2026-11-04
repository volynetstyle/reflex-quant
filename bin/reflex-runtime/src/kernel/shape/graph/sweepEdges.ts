import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";
import { forgetStrikeConsumer, preparedOwner, releaseLease } from "./tape";

/**
 * Unlink a sequence of incoming edges, from `edge` along `nextIn`, from the
 * outgoing lists of their producers, and clear their links.
 *
 * Precondition: the caller has already cut the sequence out of its
 * consumer's incoming list (`firstIn`/`lastIn` and the edge before it are
 * repaired), so only the producer side is left.
 */
export function unlinkDetachedIncomingEdgeSequence(
  edge: ReactiveEdge | null,
): void {
  while (edge !== null) {
    const nextIn = edge.nextIn;
    const { from, prevOut, nextOut } = edge;

    // A hint never outlives its edge (INV-H). The consumer's own cursor is
    // never in a detached sequence: callers detach after it or clear it.
    if (from.tailIn === edge) from.tailIn = null;

    if (prevOut !== null) prevOut.nextOut = nextOut;
    else from.firstOut = nextOut;

    if (nextOut !== null) nextOut.prevOut = prevOut;
    else from.lastOut = prevOut;

    edge.prevOut = null;
    edge.nextOut = null;
    edge.prevIn = null;
    edge.nextIn = null;

    edge = nextIn;
  }
}

/**
 * Unlink every incoming edge of `consumer` and clear its cursor: the source side
 * of disposal. Cold path.
 */
export function unlinkAllSources(consumer: ReactiveNode): void {
  // Its producers must not leave with their bits (INV-P).
  if (preparedOwner === consumer) releaseLease(consumer);
  forgetStrikeConsumer(consumer);

  const firstIncomingEdge = consumer.firstIn;

  consumer.firstIn = null;
  consumer.lastIn = null;
  consumer.tailIn = null;

  unlinkDetachedIncomingEdgeSequence(firstIncomingEdge);
}

/**
 * Unlink every outgoing edge of `producer` and clear its hint: the subscriber
 * side of disposal. A subscriber whose cursor is on a removed edge gets the
 * edge before it. Cold path.
 */
export function unlinkAllSubscribers(producer: ReactiveNode): void {
  let outgoingEdge = producer.firstOut;
  const slotEdge = producer.tailIn;

  // Every outgoing edge goes, so a hint goes with them (INV-H). A self-edge
  // in the slot is incoming and is repaired by the loop below.
  if (
    slotEdge !== null &&
    slotEdge.from === producer &&
    slotEdge.to !== producer
  ) {
    producer.tailIn = null;
  }

  producer.firstOut = null;
  producer.lastOut = null;

  while (outgoingEdge !== null) {
    const nextOut = outgoingEdge.nextOut;
    const { to, prevIn, nextIn } = outgoingEdge;

    if (to.tailIn === outgoingEdge) {
      to.tailIn = prevIn;
    }

    if (prevIn !== null) prevIn.nextIn = nextIn;
    else to.firstIn = nextIn;

    if (nextIn !== null) nextIn.prevIn = prevIn;
    else to.lastIn = prevIn;

    outgoingEdge.prevOut = null;
    outgoingEdge.nextOut = null;
    outgoingEdge.prevIn = null;
    outgoingEdge.nextIn = null;

    outgoingEdge = nextOut;
  }
}
