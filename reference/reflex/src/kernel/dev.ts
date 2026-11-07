import {
  recordDebugEvent,
  collectDebugNodeRefs,
} from "../../debug/debug.runtime";

import type { RuntimeDebugContext } from "./config";
import { currentConsumer } from "./state";
import { Computing, type ReactiveEdge } from "./shape";
import type ReactiveNode from "./shape/node";

type DebugNodeEventInput = {
  consumer?: ReactiveNode;
  node: ReactiveNode;
  detail: Record<string, unknown>;
};

function withOptionalConsumer(
  input: Omit<DebugNodeEventInput, "consumer">,
  consumer: ReactiveNode | null | undefined,
): DebugNodeEventInput {
  return consumer === null || consumer === undefined
    ? input
    : { ...input, consumer };
}

export function devAssertTrackReadAlive(
  sourceDead: boolean,
  consumerDead: boolean,
): void {
  if (!__DEV__) return;
  if (sourceDead) throw new Error("track from dead source");
  if (consumerDead) throw new Error("track into dead consumer");
}

export function devRecordTrackRead(
  context: RuntimeDebugContext,
  consumer: ReactiveNode,
  source: ReactiveNode,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "track:read", {
    consumer,
    source,
  });
}

export function devRecordNodeCreated(
  node: ReactiveNode,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;
  recordDebugEvent(context, "node:create", { node });
}

export function devRecordCleanupStaleSources(
  node: ReactiveNode,
  staleHead: ReactiveEdge,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  const removedSources = collectDebugNodeRefs(
    staleHead,
    (edge) => edge.from,
    (edge) => edge.nextIn,
  );

  recordDebugEvent(context, "cleanup:stale-sources", {
    node,
    detail: {
      removedCount: removedSources.length,
      removedSources,
    },
  });
}

export function devAssertRecomputeAlive(): void {
  if (!__DEV__) return;

  throw new Error("recompute dead node");
}

export function devRecordRecompute(
  node: ReactiveNode,
  changed: boolean,
  next: unknown,
  previous: unknown,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "recompute", {
    node,
    detail: {
      changed,
      next,
      previous,
    },
  });
}

export function devAssertReadDeadProducer(): void {
  if (!__DEV__) return;

  throw new Error("read from dead producer");
}

export function devAssertReadDeadConsumer(): void {
  if (!__DEV__) return;

  throw new Error("read dead consumer");
}

export function devAssertConsumerCanStabilize(state: number): void {
  if (!__DEV__) return;
  if ((state & Computing) === 0) return;

  throw new Error("Cycle detected while refreshing reactive graph");
}

export function devRecordReadProducer(
  node: ReactiveNode,
  value: unknown,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(
    context,
    "read:producer",
    withOptionalConsumer(
      {
        node,
        detail: {
          value,
        },
      },
      currentConsumer,
    ),
  );
}

export function devRecordReadConsumer(
  node: ReactiveNode,
  mode: "eager" | "lazy",
  value: unknown,
  context: RuntimeDebugContext,
  consumer?: ReactiveNode | null,
): void {
  if (!__DEV__) return;

  recordDebugEvent(
    context,
    "read:consumer",
    withOptionalConsumer(
      {
        node,
        detail: {
          mode,
          value,
        },
      },
      consumer,
    ),
  );
}

export function devAssertWriteAlive(): void {
  if (!__DEV__) return;

  throw new Error("write into dead node");
}

export function devRecordWriteProducer(
  node: ReactiveNode,
  changed: boolean,
  next: unknown,
  previous: unknown,
  hasSubscribers: boolean | undefined,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "write:producer", {
    node,
    detail: {
      changed,
      next,
      previous,
      hasSubscribers,
    },
  });
}

export function devAssertShouldRecomputeAlive(): void {
  if (!__DEV__) return;

  throw new Error("shouldRecompute dead node");
}

export function devAssertPropagateAlive(): void {
  if (!__DEV__) return;

  throw new Error("propagate from dead node");
}

export function devAssertExecutableNode(node: ReactiveNode): void {
  if (!__DEV__) return;

  if (!node.compute) {
    throw new Error(
      "Cannot execute a reactive node without a compute function",
    );
  }

  if ((node.state & Computing) !== 0) {
    throw new Error("Cycle detected while recomputing reactive node");
  }
}

export function devAssertIncomingEdge(
  node: ReactiveNode,
  edge: ReactiveEdge,
): void {
  if (!__DEV__) return;
  if (edge.to === node) return;

  throw new Error("walker invariant violation: edge.to !== node");
}

export function devAssertRefreshEdge(
  node: ReactiveNode,
  edge: ReactiveEdge,
): void {
  if (!__DEV__) return;

  if (edge.from !== node) {
    throw new Error("advance invariant violation: edge.from !== node");
  }

  for (let cursor = node.firstOut; cursor !== null; cursor = cursor.nextOut) {
    if (cursor === edge) return;
  }

  throw new Error("advance invariant violation: edge is not attached out");
}

export function devRecordComputeStart(
  node: ReactiveNode,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "compute:start", { node });
}

export function devRecordComputeError(
  node: ReactiveNode,
  error: unknown,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "compute:error", {
    node,
    detail: { error },
  });
}

export function devRecordComputeFinish(
  node: ReactiveNode,
  result: unknown,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "compute:finish", {
    node,
    detail: { result },
  });
}

export function devRecordWatcherSkip(
  node: ReactiveNode,
  reason: "clean" | "stable",
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "watcher:run:skip", {
    node,
    detail: { reason },
  });
}

export function devRecordWatcherStart(
  node: ReactiveNode,
  hadCleanup: boolean,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "watcher:run:start", {
    node,
    detail: { hadCleanup },
  });
}

export function devRecordWatcherCleanup(
  node: ReactiveNode,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "watcher:cleanup", { node });
}

export function devRecordWatcherFinish(
  node: ReactiveNode,
  hasCleanup: boolean,
  result: unknown,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "watcher:run:finish", {
    node,
    detail: {
      hasCleanup,
      result,
    },
  });
}

export function devRecordWatcherDispose(
  node: ReactiveNode,
  hadCleanup: boolean,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "watcher:dispose", {
    node,
    detail: { hadCleanup },
  });
}

export function devRecordWatcherInvalidated(
  node: ReactiveNode,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "watcher:invalidated", { node });
}

export function devRecordPropagate(
  edge: ReactiveEdge,
  nextState: number,
  immediate: boolean,
  context: RuntimeDebugContext,
): void {
  if (!__DEV__) return;

  recordDebugEvent(context, "propagate", {
    detail: {
      immediate,
      nextState,
    },
    source: edge.from,
    target: edge.to,
  });
}
