import { getCurrentComputedInternal } from "@runtime/internal";
import {
  readPropagateStackStats,
  readShouldRecomputeStackStats,
  resetRuntimeWalkerStackStats,
  type RuntimeWalkerStackStats,
  type ReactiveNode,
  Watcher as WatcherFlag,
} from "@runtime/kernel";
import { untracked } from "@runtime/protocol";

import { checkDebugGraphIntegrity, snapshotDebugGraph } from "./debug.graph";
import {
  snapshotDebugContext,
  labelDebugNode,
  snapshotDebugNode,
  readDebugHistory,
  clearDebugHistory,
  configureDebugContext,
  observeDebugContext,
} from "./debug.impl";
import {
  type RuntimeDebugGraphEdgeSnapshot,
  type RuntimeDebugGraphIntegrity,
  type RuntimeDebugGraphOptions,
  type RuntimeDebugGraphSnapshot,
  type RuntimeDebugSession,
} from "./debug.protocol";
import { createRuntimeDebugSession } from "./debug.session";
import type {
  RuntimeDebugOptions,
  RuntimeDebugContextSnapshot,
  RuntimeDebugEvent,
  RuntimeDebugListener,
  RuntimeDebugNodeSnapshot,
} from "./debug.types";
import { createRuntimeDiagnostics } from "./diagnostics";
import type {
  RuntimeDiagnostics,
  RuntimeMcpAdapter,
} from "./diagnostics.types";
import { createRuntimeMcpAdapter } from "./tool-catalog";

const noopUnsubscribe = () => {};
const IS_DEV = typeof __DEV__ !== "undefined" && __DEV__;

export type State<T = unknown> = ReactiveNode<T> & { compute: null };
export type Computed<T = unknown> = ReactiveNode<T> & { compute: () => T };
export type Watcher<T = unknown> = ReactiveNode<T> & { compute: () => T };

export type RuntimeSubtleGraphOptions = RuntimeDebugGraphOptions;
export type RuntimeSubtleGraphEdge = RuntimeDebugGraphEdgeSnapshot;
export type RuntimeSubtleGraphSnapshot = RuntimeDebugGraphSnapshot;
export type RuntimeSubtleGraphIssue =
  RuntimeDebugGraphIntegrity["issues"][number];
export type RuntimeSubtleGraphIntegrity = RuntimeDebugGraphIntegrity;

function isWatcherNode(node: ReactiveNode): node is Watcher {
  return (node.state & WatcherFlag) !== 0;
}

function isComputedNode(
  node: ReactiveNode | null | undefined,
): node is Computed {
  return (
    node !== null &&
    node !== undefined &&
    !isWatcherNode(node) &&
    node.compute !== null
  );
}

function collectSources(node: ReactiveNode): ReactiveNode[] {
  const sources: ReactiveNode[] = [];

  for (let edge = node.firstIn; edge !== null; edge = edge.nextIn) {
    sources.push(edge.from);
  }

  return sources;
}

function collectSinks(node: ReactiveNode): ReactiveNode[] {
  const sinks: ReactiveNode[] = [];

  for (let edge = node.firstOut; edge !== null; edge = edge.nextOut) {
    sinks.push(edge.to);
  }

  return sinks;
}

export interface RuntimeSubtle {
  readonly enabled: boolean;
  clearHistory(): void;
  configure(
    options?: RuntimeDebugOptions,
  ): RuntimeDebugContextSnapshot | undefined;
  context(): RuntimeDebugContextSnapshot | undefined;
  currentComputed(): Computed | undefined;
  history(): RuntimeDebugEvent[];
  hasSinks(s: State | Computed): boolean;
  hasSources(s: Computed | Watcher): boolean;
  graph(
    s: ReactiveNode,
    options?: RuntimeSubtleGraphOptions,
  ): RuntimeSubtleGraphSnapshot;
  graphIntegrity(s: ReactiveNode): RuntimeSubtleGraphIntegrity;
  introspectSinks(s: State | Computed): (Computed | Watcher)[];
  introspectSources(s: Computed | Watcher): (State | Computed)[];
  label<T extends ReactiveNode>(node: T, label: string | null | undefined): T;
  observe(listener: RuntimeDebugListener): () => void;
  session(): RuntimeDebugSession;
  snapshot(node: ReactiveNode): RuntimeDebugNodeSnapshot | undefined;
  stackStats():
    | {
        shouldRecompute: RuntimeWalkerStackStats;
        propagate: RuntimeWalkerStackStats;
      }
    | undefined;
  resetStackStats(): void;
  untrack<T>(cb: () => T): T;
}

export interface RuntimeDebugSubtle extends RuntimeSubtle {
  diagnostics(): RuntimeDiagnostics;
  mcp(): RuntimeMcpAdapter;
}

export type {
  RuntimeDebugContextSnapshot,
  RuntimeDebugEvent,
  RuntimeDebugListener,
  RuntimeDebugNodeSnapshot,
  RuntimeDebugOptions,
};

export const subtle: RuntimeDebugSubtle = {
  enabled: IS_DEV,

  untrack(cb) {
    return untracked(cb);
  },

  currentComputed() {
    const node = getCurrentComputedInternal();
    return isComputedNode(node) ? node : undefined;
  },

  introspectSources(node) {
    return collectSources(node) as (State | Computed)[];
  },

  introspectSinks(node) {
    return collectSinks(node).filter(
      (sink): sink is Computed | Watcher => sink.compute !== null,
    );
  },

  hasSinks(node) {
    return node.firstOut !== null;
  },

  hasSources(node) {
    return node.firstIn !== null;
  },

  graph(node, options) {
    return snapshotDebugGraph(node, snapshotDebugNode, options);
  },

  graphIntegrity(node) {
    return checkDebugGraphIntegrity(node, snapshotDebugNode);
  },

  context() {
    if (!IS_DEV) return undefined;
    return snapshotDebugContext();
  },

  label(node, label) {
    if (!IS_DEV) return node;
    return labelDebugNode(node, label);
  },

  diagnostics() {
    return createRuntimeDiagnostics(this);
  },

  mcp() {
    return createRuntimeMcpAdapter(this.diagnostics());
  },

  snapshot(node) {
    if (!IS_DEV) return undefined;
    return snapshotDebugNode(node);
  },

  history() {
    if (!IS_DEV) return [];
    return readDebugHistory();
  },

  clearHistory() {
    if (!IS_DEV) return;
    clearDebugHistory();
  },

  configure(options = {}) {
    if (!IS_DEV) return undefined;
    return configureDebugContext(undefined, options);
  },

  observe(listener) {
    if (!IS_DEV) return noopUnsubscribe;
    return observeDebugContext(undefined, listener);
  },

  session() {
    return createRuntimeDebugSession(this);
  },

  stackStats() {
    if (!IS_DEV) return undefined;
    const shouldRecompute = readShouldRecomputeStackStats();
    const propagate = readPropagateStackStats();

    return {
      shouldRecompute: shouldRecompute.shouldRecompute,
      propagate: propagate.propagate,
    };
  },

  resetStackStats() {
    if (!IS_DEV) return;
    resetRuntimeWalkerStackStats();
  },
};
