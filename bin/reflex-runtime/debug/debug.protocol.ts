import type {
  RuntimeDebugContextSnapshot,
  RuntimeDebugEvent,
  RuntimeDebugNodeRef,
  RuntimeDebugNodeSnapshot,
  RuntimeDebugOptions,
} from "./debug.types";

export const RUNTIME_DEBUG_PROTOCOL_VERSION = 1;

export type RuntimeDebugProtocolVersion = typeof RUNTIME_DEBUG_PROTOCOL_VERSION;

export type RuntimeDebugGraphDirection = "both" | "sources" | "sinks";

export interface RuntimeDebugGraphOptions {
  depth?: number;
  direction?: RuntimeDebugGraphDirection;
}

export interface RuntimeDebugGraphEdgeSnapshot {
  from: RuntimeDebugNodeSnapshot;
  to: RuntimeDebugNodeSnapshot;
  incomingIndex: number;
  outgoingIndex: number;
  stamp: number;
}

export interface RuntimeDebugGraphSnapshot {
  root: RuntimeDebugNodeSnapshot;
  nodes: RuntimeDebugNodeSnapshot[];
  edges: RuntimeDebugGraphEdgeSnapshot[];
}

export interface RuntimeDebugGraphIssue {
  code:
    | "dangling-incoming-edge"
    | "dangling-outgoing-edge"
    | "duplicate-incoming-edge"
    | "duplicate-outgoing-edge"
    | "unknown-last-in"
    | "unknown-last-in-tail"
    | "unknown-last-out"
    | "unknown-prev-in"
    | "unknown-prev-out"
    | "mismatched-incoming-target"
    | "mismatched-outgoing-source";
  node: RuntimeDebugNodeSnapshot;
  edge?: RuntimeDebugGraphEdgeSnapshot;
  message: string;
}

export interface RuntimeDebugGraphIntegrity {
  ok: boolean;
  issues: RuntimeDebugGraphIssue[];
}

export interface RuntimeDebugHandshake {
  context: RuntimeDebugContextSnapshot | undefined;
  protocolVersion: RuntimeDebugProtocolVersion;
}

export interface RuntimeDebugSessionSnapshot {
  context: RuntimeDebugContextSnapshot | undefined;
  graph?: RuntimeDebugGraphSnapshot;
  history: RuntimeDebugEvent[];
  protocolVersion: RuntimeDebugProtocolVersion;
}

export type RuntimeDebugCommand =
  | {
      id?: string;
      type: "clear-history";
    }
  | {
      id?: string;
      options?: RuntimeDebugOptions;
      type: "configure";
    }
  | {
      id?: string;
      node: RuntimeDebugNodeRef;
      options?: RuntimeDebugGraphOptions;
      type: "inspect-graph";
    }
  | {
      id?: string;
      node: RuntimeDebugNodeRef;
      type: "inspect-node";
    };

export type RuntimeDebugMessage =
  | {
      context: RuntimeDebugContextSnapshot | undefined;
      protocolVersion: RuntimeDebugProtocolVersion;
      type: "debug:handshake";
    }
  | {
      event: RuntimeDebugEvent;
      protocolVersion: RuntimeDebugProtocolVersion;
      type: "debug:event";
    }
  | {
      protocolVersion: RuntimeDebugProtocolVersion;
      snapshot: RuntimeDebugSessionSnapshot;
      type: "debug:snapshot";
    }
  | {
      command: RuntimeDebugCommand;
      protocolVersion: RuntimeDebugProtocolVersion;
      type: "debug:command";
    }
  | {
      commandId?: string;
      error?: string;
      ok: boolean;
      protocolVersion: RuntimeDebugProtocolVersion;
      result?: unknown;
      type: "debug:response";
    };

export type RuntimeDebugMessageListener = (
  message: RuntimeDebugMessage,
) => void;

export interface RuntimeDebugSession {
  clearHistory(): void;
  configure(
    options?: RuntimeDebugOptions,
  ): RuntimeDebugContextSnapshot | undefined;
  destroy(): void;
  handshake(): RuntimeDebugHandshake;
  history(): RuntimeDebugEvent[];
  observe(listener: RuntimeDebugMessageListener): () => void;
  snapshot(options?: {
    graph?: RuntimeDebugGraphSnapshot;
  }): RuntimeDebugSessionSnapshot;
}
