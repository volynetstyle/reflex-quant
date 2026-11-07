import type { RuntimeDebugContext } from "@runtime/kernel/config";
import type { ReactiveEdge, ReactiveNode } from "@runtime/kernel/shape";

import type {
  RuntimeDebugEvent,
  RuntimeDebugEventType,
  RuntimeDebugNodeRef,
} from "./debug.types";

export type RuntimeDebugEventInput = {
  consumer?: ReactiveNode;
  detail?: Record<string, unknown>;
  node?: ReactiveNode;
  source?: ReactiveNode;
  target?: ReactiveNode;
};

type CollectDebugNodeRefs = (
  edge: ReactiveEdge | null,
  selectNode: (edge: ReactiveEdge) => ReactiveNode,
  next: (edge: ReactiveEdge) => ReactiveEdge | null,
) => RuntimeDebugNodeRef[];

type RecordDebugEvent = (
  context: RuntimeDebugContext,
  type: RuntimeDebugEventType,
  input?: RuntimeDebugEventInput,
) => RuntimeDebugEvent | undefined;

let collectDebugNodeRefsImpl: CollectDebugNodeRefs = () => [];
let recordDebugEventImpl: RecordDebugEvent = () => undefined;

export function installRuntimeDebug(implementation: {
  collectDebugNodeRefs: CollectDebugNodeRefs;
  recordDebugEvent: RecordDebugEvent;
}): void {
  collectDebugNodeRefsImpl = implementation.collectDebugNodeRefs;
  recordDebugEventImpl = implementation.recordDebugEvent;
}

export function collectDebugNodeRefs(
  edge: ReactiveEdge | null,
  selectNode: (edge: ReactiveEdge) => ReactiveNode,
  next: (edge: ReactiveEdge) => ReactiveEdge | null,
): RuntimeDebugNodeRef[] {
  return collectDebugNodeRefsImpl(edge, selectNode, next);
}

export function recordDebugEvent(
  context: RuntimeDebugContext,
  type: RuntimeDebugEventType,
  input: RuntimeDebugEventInput = {},
): RuntimeDebugEvent | undefined {
  return recordDebugEventImpl(context, type, input);
}
