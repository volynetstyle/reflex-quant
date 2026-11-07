import { currentConsumer } from "@runtime/kernel/state";
import type ReactiveNode from "@runtime/kernel/shape/node";

import { resolveTrackedRead } from "./resolve";

/**
 * Record a read of `source` by `consumer`, the active consumer by default;
 * outside a computation the read is not tracked.
 *
 * An entry for tests and tools: the protocol read paths call
 * resolveTrackedRead directly.
 */
export function trackRead(
  source: ReactiveNode,
  consumer = currentConsumer,
): void {
  if (consumer === null) return;
  resolveTrackedRead(source, consumer);
}
