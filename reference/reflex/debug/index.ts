import "./debug_flag";

import { collectDebugNodeRefs, recordDebugEvent } from "./debug.impl";
import { installRuntimeDebug } from "./debug.runtime";

installRuntimeDebug({ collectDebugNodeRefs, recordDebugEvent });

export {
  subtle,
  type RuntimeDebugSubtle,
  type RuntimeSubtle,
} from "./subtle.internal";
export {
  RUNTIME_DEBUG_PROTOCOL_VERSION,
  type RuntimeDebugCommand,
  type RuntimeDebugGraphDirection,
  type RuntimeDebugGraphEdgeSnapshot,
  type RuntimeDebugGraphIntegrity,
  type RuntimeDebugGraphIssue,
  type RuntimeDebugGraphOptions,
  type RuntimeDebugGraphSnapshot,
  type RuntimeDebugHandshake,
  type RuntimeDebugMessage,
  type RuntimeDebugMessageListener,
  type RuntimeDebugProtocolVersion,
  type RuntimeDebugSession,
  type RuntimeDebugSessionSnapshot,
} from "./debug.protocol";
export type {
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
export type {
  RuntimeDiagnosticErrorCode,
  RuntimeDiagnosticJson,
  RuntimeDiagnosticResult,
  RuntimeDiagnostics,
  RuntimeMcpAdapter,
  RuntimeMcpToolDefinition,
  RuntimeMcpToolResponse,
} from "./diagnostics.types";
export {
  createRuntimeProfileSession,
  diffRuntimeProfileCounters,
  isRuntimeProfilingEnabled,
  profileRuntime,
  profileRuntimeAsync,
  readRuntimeProfileCounters,
  readRuntimeProfileTopology,
  resetRuntimeProfileCounters,
  runtimeProfileCounters,
  setRuntimeProfilingEnabled,
  snapshotRuntimeProfileCounters,
  snapshotRuntimeProfileTopology,
  type RuntimeProfileCounterName,
  type RuntimeProfileCounters,
  type RuntimeProfileResult,
  type RuntimeProfileSession,
  type RuntimeProfileTopology,
  type RuntimeProfileTopologyHotPath,
  type RuntimeProfileTopologyWalker,
} from "@runtime/profiling";
