import { RUNTIME_DEBUG_PROTOCOL_VERSION } from "../debug/debug.protocol";
import type {
  RuntimeDebugGraphIntegrity,
  RuntimeDebugGraphSnapshot,
  RuntimeDebugSession,
  RuntimeDebugSessionSnapshot,
} from "../debug/debug.protocol";
import type {
  RuntimeDebugContextSnapshot,
  RuntimeDebugEvent,
  RuntimeDebugListener,
  RuntimeDebugNodeSnapshot,
  RuntimeDebugOptions,
} from "../debug/debug.types";
import type {
  Computed,
  RuntimeSubtle,
  RuntimeSubtleGraphOptions,
  State,
  Watcher,
} from "../debug/subtle.internal";
import type { ReactiveNode } from "./kernel";
import { untracked } from "./protocol/utils/untracked";

export type {
  Computed,
  RuntimeSubtle,
  RuntimeSubtleGraphEdge,
  RuntimeSubtleGraphIntegrity,
  RuntimeSubtleGraphIssue,
  RuntimeSubtleGraphOptions,
  RuntimeSubtleGraphSnapshot,
  State,
  Watcher,
} from "../debug/subtle.internal";
export type {
  RuntimeDiagnosticErrorCode,
  RuntimeDiagnosticJson,
  RuntimeDiagnosticResult,
  RuntimeDiagnostics,
  RuntimeMcpAdapter,
  RuntimeMcpToolDefinition,
  RuntimeMcpToolResponse,
} from "../debug/diagnostics.types";
export type {
  RuntimeDebugContextSnapshot,
  RuntimeDebugEvent,
  RuntimeDebugListener,
  RuntimeDebugNodeSnapshot,
  RuntimeDebugOptions,
};

const noopUnsubscribe = () => {};

const EMPTY_NODE: RuntimeDebugNodeSnapshot = {
  dirty: "clean",
  flags: [],
  hasCompute: false,
  id: 0,
  inDegree: 0,
  kind: "unknown",
  payload: undefined,
  sources: [],
  state: 0,
  subscribers: [],
};

const EMPTY_GRAPH: RuntimeDebugGraphSnapshot = {
  edges: [],
  nodes: [],
  root: EMPTY_NODE,
};

const EMPTY_INTEGRITY: RuntimeDebugGraphIntegrity = {
  issues: [],
  ok: true,
};

function createEmptySessionSnapshot(): RuntimeDebugSessionSnapshot {
  return {
    context: undefined,
    history: [],
    protocolVersion: RUNTIME_DEBUG_PROTOCOL_VERSION,
  };
}

const noopSession: RuntimeDebugSession = {
  clearHistory() {},

  configure() {
    return undefined;
  },

  destroy() {},

  handshake() {
    return {
      context: undefined,
      protocolVersion: RUNTIME_DEBUG_PROTOCOL_VERSION,
    };
  },

  history() {
    return [];
  },

  observe() {
    return noopUnsubscribe;
  },

  snapshot() {
    return createEmptySessionSnapshot();
  },
};

export const subtle: RuntimeSubtle = {
  enabled: false,

  clearHistory() {},

  configure(_options: RuntimeDebugOptions = {}) {
    return undefined;
  },

  context() {
    return undefined;
  },

  currentComputed() {
    return undefined;
  },

  graph(_node: ReactiveNode, _options?: RuntimeSubtleGraphOptions) {
    return EMPTY_GRAPH;
  },

  graphIntegrity(_node: ReactiveNode) {
    return EMPTY_INTEGRITY;
  },

  hasSinks(_node: State | Computed) {
    return false;
  },

  hasSources(_node: Computed | Watcher) {
    return false;
  },

  history() {
    return [];
  },

  introspectSinks(_node: State | Computed) {
    return [];
  },

  introspectSources(_node: Computed | Watcher) {
    return [];
  },

  label<T extends ReactiveNode>(node: T, _label: string | null | undefined) {
    return node;
  },

  observe(_listener: RuntimeDebugListener) {
    return noopUnsubscribe;
  },

  resetStackStats() {},

  session() {
    return noopSession;
  },

  snapshot(_node: ReactiveNode) {
    return undefined;
  },

  stackStats() {
    return undefined;
  },

  untrack<T>(cb: () => T): T {
    return untracked(cb);
  },
};
