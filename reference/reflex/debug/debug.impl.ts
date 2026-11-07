import {
  defaultContext,
  type RuntimeDebugContext,
} from "@runtime/kernel/config";
import { currentConsumer, propagationScopeDepth } from "@runtime/kernel/state";
import {
  Changed,
  Consumer,
  Both,
  Unknown,
  Producer,
  Visited,
  Scheduled,
  Computing,
  Watcher,
  type ReactiveEdge,
  type ReactiveNode,
} from "@runtime/kernel/shape";

import type {
  RuntimeDebugContextSnapshot,
  RuntimeDebugEvent,
  RuntimeDebugEventType,
  RuntimeDebugFlag,
  RuntimeDebugDirtyState,
  RuntimeDebugListener,
  RuntimeDebugNodeKind,
  RuntimeDebugNodeRef,
  RuntimeDebugNodeSnapshot,
  RuntimeDebugOptions,
} from "./debug.types";
import type { RuntimeDebugEventInput } from "./debug.runtime";

const DEFAULT_HISTORY_LIMIT = 250;

interface RuntimeDebugState {
  id: number;
  nextEventId: number;
  history: RuntimeDebugEvent[];
  historyLimit: number;
  listeners: Set<RuntimeDebugListener>;
}

const contextStates = new WeakMap<object, RuntimeDebugState>();
const nodeIds = new WeakMap<ReactiveNode, number>();
const nodesById = new Map<number, WeakRef<ReactiveNode>>();
const nodeLabels = new WeakMap<ReactiveNode, string>();
const invalidContextKey = {};
const invalidNodeIds = new Map<unknown, number>();

let nextContextId = 1;
let nextNodeId = 1;

function isObjectKey(value: unknown): value is object {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null
  );
}

function normalizeHistoryLimit(
  historyLimit: number | undefined,
  fallback: number,
): number {
  if (historyLimit === undefined) return fallback;
  if (!Number.isFinite(historyLimit)) return fallback;

  return Math.max(0, Math.trunc(historyLimit));
}

function getDirtyState(state: number): RuntimeDebugDirtyState {
  const dirty = state & Both;

  if (dirty === 0) return "clean";
  if (dirty === Unknown) return "unknown";
  if (dirty === Changed) return "changed";
  return "unknown+changed";
}

function getNodeKind(state: number): RuntimeDebugNodeKind {
  if ((state & Watcher) !== 0) return "watcher";
  if ((state & Consumer) !== 0) return "consumer";
  if ((state & Producer) !== 0) return "producer";
  return "unknown";
}

function getFlags(state: number): RuntimeDebugFlag[] {
  const flags: RuntimeDebugFlag[] = [];

  if ((state & Producer) !== 0) flags.push("producer");
  if ((state & Consumer) !== 0) flags.push("consumer");
  if ((state & Watcher) !== 0) flags.push("watcher");
  if ((state & Unknown) !== 0) flags.push("unknown");
  if ((state & Changed) !== 0) flags.push("changed");
  if ((state & Visited) !== 0) flags.push("visited");
  if ((state & Computing) !== 0) flags.push("computing");
  if ((state & Scheduled) !== 0) flags.push("scheduled");
  if ((state & Computing) !== 0) flags.push("tracking");

  return flags;
}

function normalizeContextKey(context: RuntimeDebugContext): object {
  return isObjectKey(context) ? context : invalidContextKey;
}

function ensureContextState(context: RuntimeDebugContext): RuntimeDebugState {
  const key = normalizeContextKey(context);
  const existing = contextStates.get(key);

  if (existing) return existing;

  const state: RuntimeDebugState = {
    id: nextContextId++,
    nextEventId: 1,
    history: [],
    historyLimit: DEFAULT_HISTORY_LIMIT,
    listeners: new Set(),
  };

  contextStates.set(key, state);
  return state;
}

function ensureNodeId(node: ReactiveNode): number {
  if (!isObjectKey(node)) {
    const existing = invalidNodeIds.get(node);
    if (existing !== undefined) return existing;

    const id = nextNodeId++;
    invalidNodeIds.set(node, id);
    return id;
  }

  const existing = nodeIds.get(node);

  if (existing !== undefined) return existing;

  const id = nextNodeId++;
  nodeIds.set(node, id);
  nodesById.set(id, new WeakRef(node));
  return id;
}

export function findDebugNode(id: number): ReactiveNode | undefined {
  const node = nodesById.get(id)?.deref();
  if (node === undefined) nodesById.delete(id);
  return node;
}

export function listDebugNodes(): ReactiveNode[] {
  const nodes: ReactiveNode[] = [];

  for (const [id, reference] of nodesById) {
    const node = reference.deref();
    if (node === undefined) nodesById.delete(id);
    else nodes.push(node);
  }

  return nodes;
}

function createNodeRef(node: ReactiveNode): RuntimeDebugNodeRef {
  if (!isObjectKey(node)) {
    return {
      id: ensureNodeId(node),
      kind: "unknown",
      dirty: "clean",
      flags: [],
      state: 0,
    };
  }

  const label = nodeLabels.get(node);
  const ref: RuntimeDebugNodeRef = {
    id: ensureNodeId(node),
    kind: getNodeKind(node.state),
    dirty: getDirtyState(node.state),
    flags: getFlags(node.state),
    state: node.state,
  };

  if (label !== undefined) {
    ref.label = label;
  }

  return ref;
}

function collectAdjacentNodes(
  edge: ReactiveEdge | null,
  selectNode: (edge: ReactiveEdge) => ReactiveNode,
  next: (edge: ReactiveEdge) => ReactiveEdge | null,
): RuntimeDebugNodeRef[] {
  const nodes: RuntimeDebugNodeRef[] = [];

  for (let cursor = edge; cursor !== null; cursor = next(cursor)) {
    nodes.push(createNodeRef(selectNode(cursor)));
  }

  return nodes;
}

function emitToListeners(
  listeners: Set<RuntimeDebugListener>,
  event: RuntimeDebugEvent,
): void {
  for (const listener of [...listeners]) {
    // Debug observers must not be able to interrupt runtime bookkeeping.
    try {
      listener(event);
    } catch {
      // Observer failures are intentionally isolated from the reactive runtime.
    }
  }
}

function pushHistory(state: RuntimeDebugState, event: RuntimeDebugEvent): void {
  if (state.historyLimit === 0) return;

  state.history.push(event);

  const overflow = state.history.length - state.historyLimit;
  if (overflow > 0) {
    state.history.splice(0, overflow);
  }
}

export function labelDebugNode<T extends ReactiveNode>(
  node: T,
  label: string | null | undefined,
): T {
  if (label && label.length > 0) {
    nodeLabels.set(node, label);
  } else {
    nodeLabels.delete(node);
  }

  return node;
}

export function configureDebugContext(
  context: RuntimeDebugContext = defaultContext,
  options: RuntimeDebugOptions = {},
): RuntimeDebugContextSnapshot {
  const state = ensureContextState(context);
  state.historyLimit = normalizeHistoryLimit(
    options.historyLimit,
    state.historyLimit,
  );

  const overflow = state.history.length - state.historyLimit;
  if (overflow > 0) {
    state.history.splice(0, overflow);
  }

  return snapshotDebugContext(context);
}

export function observeDebugContext(
  context: RuntimeDebugContext = defaultContext,
  listener: RuntimeDebugListener,
): () => void {
  const state = ensureContextState(context);
  state.listeners.add(listener);

  return () => {
    state.listeners.delete(listener);
  };
}

export function readDebugHistory(
  context: RuntimeDebugContext = defaultContext,
): RuntimeDebugEvent[] {
  return ensureContextState(context).history.slice();
}

export function clearDebugHistory(
  context: RuntimeDebugContext = defaultContext,
): void {
  ensureContextState(context).history.length = 0;
}

export function snapshotDebugContext(
  context: RuntimeDebugContext = defaultContext,
): RuntimeDebugContextSnapshot {
  const state = ensureContextState(context);
  const snapshot: RuntimeDebugContextSnapshot = {
    id: state.id,
    propagationScopeDepth: propagationScopeDepth,
    historyLimit: state.historyLimit,
    historySize: state.history.length,
    observerCount: state.listeners.size,
  };

  if (currentConsumer !== null) {
    snapshot.currentConsumer = createNodeRef(currentConsumer);
  }

  return snapshot;
}

export function snapshotDebugNode(
  node: ReactiveNode,
): RuntimeDebugNodeSnapshot {
  const sources = collectAdjacentNodes(
    node.firstIn,
    (edge) => edge.from,
    (edge) => edge.nextIn,
  );
  const subscribers = collectAdjacentNodes(
    node.firstOut,
    (edge) => edge.to,
    (edge) => edge.nextOut,
  );

  return {
    ...createNodeRef(node),
    payload: node.payload,
    hasCompute: node.compute !== undefined,
    inDegree: sources.length,
    sources,
    subscribers,
  };
}

export function collectDebugNodeRefs(
  edge: ReactiveEdge | null,
  selectNode: (edge: ReactiveEdge) => ReactiveNode,
  next: (edge: ReactiveEdge) => ReactiveEdge | null,
): RuntimeDebugNodeRef[] {
  return collectAdjacentNodes(edge, selectNode, next);
}

export function recordDebugEvent(
  context: RuntimeDebugContext = defaultContext,
  type: RuntimeDebugEventType,
  input: RuntimeDebugEventInput = {},
): RuntimeDebugEvent {
  const state = ensureContextState(context);
  const event: RuntimeDebugEvent = {
    id: state.nextEventId++,
    contextId: state.id,
    timestamp: Date.now(),
    type,
  };

  if (input.node !== undefined) {
    event.node = createNodeRef(input.node);
  }

  if (input.source !== undefined) {
    event.source = createNodeRef(input.source);
  }

  if (input.target !== undefined) {
    event.target = createNodeRef(input.target);
  }

  if (input.consumer !== undefined) {
    event.consumer = createNodeRef(input.consumer);
  }

  if (input.detail !== undefined) {
    event.detail = input.detail;
  }

  pushHistory(state, event);
  emitToListeners(state.listeners, event);
  return event;
}
