import type {
  RuntimeDiagnosticResult,
  RuntimeDiagnosticJson,
  RuntimeDiagnostics,
  RuntimeMcpAdapter,
  RuntimeMcpToolDefinition,
  RuntimeMcpToolResponse,
} from "./diagnostics.types";

const EMPTY_SCHEMA = { type: "object", additionalProperties: false } as const;
const NODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

const DEFINITIONS: readonly RuntimeMcpToolDefinition[] = [
  ["graph.node", "Inspect a node by debug id.", NODE_SCHEMA],
  ["graph.edges", "List incoming and outgoing edges.", NODE_SCHEMA],
  ["graph.parents", "List direct dependencies.", NODE_SCHEMA],
  ["graph.children", "List direct subscribers.", NODE_SCHEMA],
  [
    "graph.dump",
    "Dump the known graph or a bounded component.",
    {
      type: "object",
      properties: {
        rootId: { type: "integer", minimum: 1 },
        depth: { type: "integer", minimum: 0, maximum: 20 },
        direction: { enum: ["both", "sources", "sinks"] },
      },
    },
  ],
  ["graph.integrity", "Check graph structural invariants.", NODE_SCHEMA],
  ["runtime.context", "Read debug runtime context.", EMPTY_SCHEMA],
  ["runtime.scheduler", "Read scheduler and batching state.", EMPTY_SCHEMA],
  ["runtime.phase", "Read the active execution phase.", EMPTY_SCHEMA],
  ["runtime.batchDepth", "Read the active reactive batch depth.", EMPTY_SCHEMA],
  ["runtime.currentConsumer", "Read the active tracking consumer.", EMPTY_SCHEMA],
  ["runtime.trackingStack", "Read available tracking-stack diagnostics.", EMPTY_SCHEMA],
  ["runtime.stackStats", "Read walker stack statistics.", EMPTY_SCHEMA],
  ["dependency.whyDirty", "Explain the latest known dirty cause.", NODE_SCHEMA],
  ["dependency.whoInvalidated", "Find the latest invalidating source.", NODE_SCHEMA],
  [
    "dependency.chain",
    "Dump the upstream dependency chain.",
    {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        maxDepth: { type: "integer", minimum: 0, maximum: 20 },
      },
    },
  ],
  [
    "dependency.recomputePath",
    "Read recomputation-related events for a dependency chain.",
    {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 0, maximum: 500 },
      },
    },
  ],
  [
    "timeline.events",
    "Read bounded runtime history, optionally for one node.",
    {
      type: "object",
      properties: {
        nodeId: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 0, maximum: 500 },
      },
    },
  ],
  ["timeline.timestamps", "Read known lifecycle timestamps for a node.", NODE_SCHEMA],
  ["statistics.summary", "Measure graph topology and recomputation activity.", EMPTY_SCHEMA],
].map(([name, description, inputSchema]) => ({
  name: name as string,
  description: description as string,
  inputSchema: inputSchema as RuntimeDiagnosticJson,
}));

function response(result: RuntimeDiagnosticResult): RuntimeMcpToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: !result.ok,
    structuredContent: result,
  };
}

export function createRuntimeMcpAdapter(
  diagnostics: RuntimeDiagnostics,
): RuntimeMcpAdapter {
  return {
    list: () => DEFINITIONS,
    call(name, input = {}) {
      const args =
        input !== null && typeof input === "object"
          ? (input as Record<string, unknown>)
          : {};
      const id = args.id as number;
      const handlers: Record<string, () => RuntimeDiagnosticResult> = {
        "graph.node": () => diagnostics.graph.node(id),
        "graph.edges": () => diagnostics.graph.edges(id),
        "graph.parents": () => diagnostics.graph.parents(id),
        "graph.children": () => diagnostics.graph.children(id),
        "graph.dump": () => diagnostics.graph.dump(args),
        "graph.integrity": () => diagnostics.graph.integrity(id),
        "runtime.context": diagnostics.runtime.context,
        "runtime.scheduler": diagnostics.runtime.scheduler,
        "runtime.phase": diagnostics.runtime.phase,
        "runtime.batchDepth": diagnostics.runtime.batchDepth,
        "runtime.currentConsumer": diagnostics.runtime.currentConsumer,
        "runtime.trackingStack": diagnostics.runtime.trackingStack,
        "runtime.stackStats": diagnostics.runtime.stackStats,
        "dependency.whyDirty": () => diagnostics.dependencies.whyDirty(id),
        "dependency.whoInvalidated": () => diagnostics.dependencies.whoInvalidated(id),
        "dependency.chain": () => diagnostics.dependencies.chain(id, args.maxDepth as number),
        "dependency.recomputePath": () => diagnostics.dependencies.recomputePath(id, args.limit as number),
        "timeline.events": () => diagnostics.timeline.events(args),
        "timeline.timestamps": () => diagnostics.timeline.timestamps(id),
        "statistics.summary": diagnostics.statistics.summary,
      };
      return response(
        handlers[name]?.() ?? {
          ok: false,
          code: "REFLEX_DIAGNOSTIC_TOOL_NOT_FOUND",
          message: `Unknown tool: ${name}.`,
        },
      );
    },
  };
}
