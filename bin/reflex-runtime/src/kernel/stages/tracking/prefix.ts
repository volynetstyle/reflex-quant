import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";

/**
 * Whether `edge`, an incoming edge of `consumer`, lies in the tracked prefix
 * `firstIn..cursorEdge`, the part of the list the current pass has accepted.
 *
 * With the cursor at `lastIn` the suffix is empty, so every edge is in the
 * prefix (INV-T2). This also covers watcher validation, which spans the
 * committed frontier by setting the cursor to `lastIn`.
 *
 * Otherwise a pass is running with a nonempty suffix, and the stamps decide
 * (INV-T3): the pass writes its stamp, the cursor's, on every edge it accepts,
 * and the suffix holds only edges accepted by earlier passes of this consumer,
 * which took smaller stamps from the forward-only clock. So an edge is in the
 * prefix exactly when it carries the cursor's stamp. Stamp 0 is never a pass
 * stamp; it appears only on graphs built by hand, where the prefix is walked.
 */
export function isEdgeInTrackedPrefix(
  consumer: ReactiveNode,
  cursorEdge: ReactiveEdge,
  edge: ReactiveEdge,
): boolean {
  if (cursorEdge === consumer.lastIn) return true;

  const passStamp = cursorEdge.stamp;
  if (passStamp !== 0) return edge.stamp === passStamp;

  for (
    let prefixEdge: ReactiveEdge | null = cursorEdge;
    prefixEdge !== null;
    prefixEdge = prefixEdge.prevIn
  ) {
    if (prefixEdge === edge) return true;
  }

  return false;
}
