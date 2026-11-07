import "../debug/dev_flag";
export { subtle, type RuntimeSubtle } from "./subtle";
export type {
  RuntimeDiagnosticErrorCode,
  RuntimeDiagnosticJson,
  RuntimeDiagnosticResult,
  RuntimeDiagnostics,
  RuntimeMcpAdapter,
  RuntimeMcpToolDefinition,
  RuntimeMcpToolResponse,
} from "./subtle";
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
} from "../debug/debug.protocol";

export type {
  ConsumerNode,
  ProducerNode,
  ReactiveNode,
  WatcherCleanup,
  WatcherNode,
  WatcherResult,
} from "./kernel";

export {
  createProducer,
  createConsumer,
  createWatcher,
  readProducer,
  writeProducer,
  readConsumer,
  readConsumerLazy,
  readConsumerEager,
  ConsumerReadMode,
  runWatcher,
  disposeWatcher,
  untracked,
} from "./protocol";
export type {
  ConsumerReadModeValue,
  ProducerComparator,
  WatcherFn,
} from "./protocol";

export {
  RuntimePhase,
  RuntimeExecutionError,
  readRuntimePhase,
  readActiveRuntimeHook,
} from "./kernel/execution";
export type { RuntimeExecutionState } from "./kernel/execution";

export {
  configureRuntimeContext,
  createRuntimeContext,
  getActiveRuntimeContext,
  resetRuntimeContext,
  restoreRuntimeContextSnapshot,
  runWithRuntimeContext,
  snapshotRuntimeContext,
} from "./kernel/context";
export type {
  RuntimeContext,
  RuntimeContextOptions,
  RuntimeContextSnapshot,
  RuntimeHooks,
  RuntimeHostHooks,
} from "./kernel/context";

export {
  createExecutionDomain,
  ExecutionDomainClosedError,
  ExecutionDomainState,
  getActiveExecutionDomain,
  getExecutionDomain,
} from "./domain";
export type {
  ExecutionDomain,
  ExecutionDomainOptions,
  ExecutionDomainScheduler,
} from "./domain";
