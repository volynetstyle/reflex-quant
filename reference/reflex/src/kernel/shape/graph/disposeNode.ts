import type ReactiveNode from "@runtime/kernel/shape/node";

import { unlinkAllSources, unlinkAllSubscribers } from "./sweepEdges";

/**
 * Detach `node` from the graph in both directions and drop its compute
 * function and payload. Disposal carries no state bit: a disposed node is a
 * node without edges, compute or payload.
 */
export function disposeNode(node: ReactiveNode): void {
  unlinkAllSources(node);
  unlinkAllSubscribers(node);

  node.compute = undefined;
  node.payload = undefined;
}

/** The same function, under the name the event API imports. */
export const disposeNodeEvent = disposeNode;
