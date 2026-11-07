import type { RuntimeDebugGraphDirection } from "./debug.protocol";

export type RuntimeDiagnosticJson =
  | null
  | boolean
  | number
  | string
  | RuntimeDiagnosticJson[]
  | { [key: string]: RuntimeDiagnosticJson };

export type RuntimeDiagnosticErrorCode =
  | "REFLEX_DIAGNOSTIC_INVALID_INPUT"
  | "REFLEX_DIAGNOSTIC_NODE_NOT_FOUND"
  | "REFLEX_DIAGNOSTIC_TOOL_NOT_FOUND";

export type RuntimeDiagnosticResult =
  | { ok: true; result: RuntimeDiagnosticJson }
  | {
      ok: false;
      code: RuntimeDiagnosticErrorCode;
      message: string;
    };

export interface RuntimeDiagnostics {
  graph: {
    node(id: number): RuntimeDiagnosticResult;
    edges(id: number): RuntimeDiagnosticResult;
    parents(id: number): RuntimeDiagnosticResult;
    children(id: number): RuntimeDiagnosticResult;
    dump(input?: {
      depth?: number;
      direction?: RuntimeDebugGraphDirection;
      rootId?: number;
    }): RuntimeDiagnosticResult;
    integrity(id: number): RuntimeDiagnosticResult;
  };
  runtime: {
    context(): RuntimeDiagnosticResult;
    scheduler(): RuntimeDiagnosticResult;
    phase(): RuntimeDiagnosticResult;
    batchDepth(): RuntimeDiagnosticResult;
    currentConsumer(): RuntimeDiagnosticResult;
    trackingStack(): RuntimeDiagnosticResult;
    stackStats(): RuntimeDiagnosticResult;
  };
  dependencies: {
    whyDirty(id: number): RuntimeDiagnosticResult;
    whoInvalidated(id: number): RuntimeDiagnosticResult;
    chain(id: number, maxDepth?: number): RuntimeDiagnosticResult;
    recomputePath(id: number, limit?: number): RuntimeDiagnosticResult;
  };
  timeline: {
    events(input?: {
      limit?: number;
      nodeId?: number;
    }): RuntimeDiagnosticResult;
    timestamps(id: number): RuntimeDiagnosticResult;
  };
  statistics: {
    summary(): RuntimeDiagnosticResult;
  };
}

export interface RuntimeMcpToolDefinition {
  description: string;
  inputSchema: RuntimeDiagnosticJson;
  name: string;
}

export interface RuntimeMcpToolResponse {
  content: readonly [{ type: "text"; text: string }];
  isError: boolean;
  structuredContent: RuntimeDiagnosticResult;
}

export interface RuntimeMcpAdapter {
  call(name: string, input?: unknown): RuntimeMcpToolResponse;
  list(): readonly RuntimeMcpToolDefinition[];
}
