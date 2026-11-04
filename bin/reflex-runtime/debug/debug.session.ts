import {
  RUNTIME_DEBUG_PROTOCOL_VERSION,
  type RuntimeDebugGraphSnapshot,
  type RuntimeDebugMessage,
  type RuntimeDebugMessageListener,
  type RuntimeDebugSession,
  type RuntimeDebugSessionSnapshot,
} from "./debug.protocol";
import type {
  RuntimeDebugContextSnapshot,
  RuntimeDebugEvent,
  RuntimeDebugListener,
  RuntimeDebugOptions,
} from "./debug.types";

interface RuntimeDebugSessionHost {
  clearHistory(): void;
  configure(
    options?: RuntimeDebugOptions,
  ): RuntimeDebugContextSnapshot | undefined;
  context(): RuntimeDebugContextSnapshot | undefined;
  history(): RuntimeDebugEvent[];
  observe(listener: RuntimeDebugListener): () => void;
}

export function createRuntimeDebugSession(
  host: RuntimeDebugSessionHost,
): RuntimeDebugSession {
  const listeners = new Set<RuntimeDebugMessageListener>();
  const emitMessage = (message: RuntimeDebugMessage): void => {
    for (const listener of [...listeners]) {
      listener(message);
    }
  };
  const unsubscribeEvents = host.observe((event) => {
    emitMessage({
      event,
      protocolVersion: RUNTIME_DEBUG_PROTOCOL_VERSION,
      type: "debug:event",
    });
  });

  return {
    clearHistory() {
      host.clearHistory();
    },

    configure(options) {
      return host.configure(options);
    },

    destroy() {
      listeners.clear();
      unsubscribeEvents();
    },

    handshake() {
      return {
        context: host.context(),
        protocolVersion: RUNTIME_DEBUG_PROTOCOL_VERSION,
      };
    },

    history() {
      return host.history();
    },

    observe(listener) {
      listeners.add(listener);
      listener({
        context: host.context(),
        protocolVersion: RUNTIME_DEBUG_PROTOCOL_VERSION,
        type: "debug:handshake",
      });

      return () => {
        listeners.delete(listener);
      };
    },

    snapshot(options = {}) {
      const snapshot = createRuntimeDebugSessionSnapshot(host, options.graph);

      emitMessage({
        protocolVersion: RUNTIME_DEBUG_PROTOCOL_VERSION,
        snapshot,
        type: "debug:snapshot",
      });

      return snapshot;
    },
  };
}

function createRuntimeDebugSessionSnapshot(
  host: RuntimeDebugSessionHost,
  graph: RuntimeDebugGraphSnapshot | undefined,
): RuntimeDebugSessionSnapshot {
  const snapshot: RuntimeDebugSessionSnapshot = {
    context: host.context(),
    history: host.history(),
    protocolVersion: RUNTIME_DEBUG_PROTOCOL_VERSION,
  };

  if (graph !== undefined) {
    snapshot.graph = graph;
  }

  return snapshot;
}
