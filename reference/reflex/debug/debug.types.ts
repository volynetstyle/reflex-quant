export type RuntimeDebugEventType =
  | "cleanup:stale-sources"
  | "compute:error"
  | "compute:finish"
  | "compute:start"
  | "context:enter-propagation"
  | "context:hooks"
  | "context:optimizations"
  | "context:leave-propagation"
  | "context:settled"
  | "node:create"
  | "propagate"
  | "read:consumer"
  | "read:producer"
  | "recompute"
  | "track:read"
  | "watcher:cleanup"
  | "watcher:dispose"
  | "watcher:invalidated"
  | "watcher:run:finish"
  | "watcher:run:skip"
  | "watcher:run:start"
  | "write:producer";

export type RuntimeDebugFlag =
  | "changed"
  | "computing"
  | "consumer"
  | "unknown"
  | "producer"
  | "scheduled"
  | "tracking"
  | "visited"
  | "watcher";

export type RuntimeDebugNodeKind =
  | "consumer"
  | "producer"
  | "unknown"
  | "watcher";

export type RuntimeDebugDirtyState =
  | "changed"
  | "clean"
  | "unknown"
  | "unknown+changed";

export interface RuntimeDebugOptions {
  historyLimit?: number;
}

export interface RuntimeDebugNodeRef {
  id: number;
  kind: RuntimeDebugNodeKind;
  dirty: RuntimeDebugDirtyState;
  flags: RuntimeDebugFlag[];
  label?: string;
  state: number;
}

export interface RuntimeDebugNodeSnapshot extends RuntimeDebugNodeRef {
  payload: unknown;
  hasCompute: boolean;
  inDegree: number;
  sources: RuntimeDebugNodeRef[];
  subscribers: RuntimeDebugNodeRef[];
}

export interface RuntimeDebugContextSnapshot {
  id: number;
  propagationScopeDepth: number;
  historySize: number;
  historyLimit: number;
  observerCount: number;
  currentConsumer?: RuntimeDebugNodeRef;
}

export interface RuntimeDebugEvent {
  id: number;
  contextId: number;
  timestamp: number;
  type: RuntimeDebugEventType;
  consumer?: RuntimeDebugNodeRef;
  detail?: Record<string, unknown>;
  node?: RuntimeDebugNodeRef;
  source?: RuntimeDebugNodeRef;
  target?: RuntimeDebugNodeRef;
}

export type RuntimeDebugListener = (event: RuntimeDebugEvent) => void;
