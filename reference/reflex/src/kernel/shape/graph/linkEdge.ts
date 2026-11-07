import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";

import { notePreparedLink, preparedOwner } from "./tape";

/**
 * Link a new edge `from -> to` and return it.
 *
 * The edge is appended to the outgoing list of `from`: outgoing lists are
 * append-only, so they hold subscribers in the order they were linked. In
 * the incoming list of `to` it is inserted after `after`, at the head when
 * `after` is null; by default at the tail.
 */
export function linkEdge(
  from: ReactiveNode,
  to: ReactiveNode,
  after: ReactiveEdge | null = to.lastIn,
  stamp = 0,
): ReactiveEdge {
  const prevOut = from.lastOut;
  const nextIn = after === null ? to.firstIn : after.nextIn;

  const edge: ReactiveEdge = {
    stamp,
    from,
    to,
    prevOut,
    nextOut: null,
    prevIn: after,
    nextIn,
  };

  if (prevOut === null) from.firstOut = edge;
  else prevOut.nextOut = edge;

  from.lastOut = edge;

  if (after === null) to.firstIn = edge;
  else after.nextIn = edge;

  if (nextIn === null) to.lastIn = edge;
  else nextIn.prevIn = edge;

  // A link to the prepared-tape owner puts its producer on the tape.
  if (to === preparedOwner) notePreparedLink(edge);
  return edge;
}

/**
 * Link the first incoming edge of `to` during a tracking pass and make it the
 * cursor. Precondition: `to` has no incoming edge.
 */
export function linkFirstTrackedEdgeUnchecked(
  from: ReactiveNode,
  to: ReactiveNode,
  stamp: number,
): ReactiveEdge {
  const prevOut = from.lastOut;

  const edge: ReactiveEdge = {
    stamp,
    from,
    to,
    prevOut,
    nextOut: null,
    prevIn: null,
    nextIn: null,
  } satisfies ReactiveEdge;

  if (prevOut !== null) prevOut.nextOut = edge;
  else from.firstOut = edge;

  from.lastOut = edge;
  to.firstIn = to.lastIn = to.tailIn = edge;

  // A link to the prepared-tape owner puts its producer on the tape.
  if (to === preparedOwner) notePreparedLink(edge);
  return edge;
}

/**
 * Link a new edge after the tracking cursor at the incoming tail of `to` and
 * make it the cursor. Precondition: `cursor` is `to.lastIn`.
 */
export function appendTrackedEdgeAfterCursorUnchecked(
  from: ReactiveNode,
  to: ReactiveNode,
  cursor: ReactiveEdge,
  stamp: number,
): ReactiveEdge {
  const prevOut = from.lastOut;

  const edge: ReactiveEdge = {
    stamp,
    from,
    to,
    prevOut,
    nextOut: null,
    prevIn: cursor,
    nextIn: null,
  } satisfies ReactiveEdge;

  if (prevOut !== null) prevOut.nextOut = edge;
  else from.firstOut = edge;

  from.lastOut = edge;
  cursor.nextIn = edge;
  to.lastIn = to.tailIn = edge;

  // A link to the prepared-tape owner puts its producer on the tape.
  if (to === preparedOwner) notePreparedLink(edge);
  return edge;
}

/**
 * Unlink one edge from both of its lists. A cursor on the edge moves back to
 * its predecessor, and a hint on it is cleared (INV-H).
 */
export function unlinkEdge(edge: ReactiveEdge): void {
  const { from, to, prevOut, nextOut, prevIn, nextIn } = edge;

  if (prevOut !== null) prevOut.nextOut = nextOut;
  else from.firstOut = nextOut;

  if (nextOut !== null) nextOut.prevOut = prevOut;
  else from.lastOut = prevOut;

  if (prevIn !== null) prevIn.nextIn = nextIn;
  else to.firstIn = nextIn;

  if (nextIn !== null) nextIn.prevIn = prevIn;
  else to.lastIn = prevIn;

  if (to.tailIn === edge) to.tailIn = prevIn;
  // A hint never outlives its edge (INV-H). After the incoming repair above,
  // a self-edge is no longer in `from.tailIn`.
  if (from.tailIn === edge) from.tailIn = null;

  edge.prevOut = null;
  edge.nextOut = null;
  edge.prevIn = null;
  edge.nextIn = null;
}
