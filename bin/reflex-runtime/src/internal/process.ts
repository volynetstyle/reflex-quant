import { currentConsumer, Watcher, type ReactiveNode } from "@runtime/kernel";

export function getCurrentComputedInternal(): ReactiveNode | undefined {
  const node = currentConsumer;

  return node
    ? node.compute !== null && (node.state & Watcher) === 0
      ? node
      : undefined
    : undefined;
}
