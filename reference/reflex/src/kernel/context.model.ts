import {
  DEFAULT_READ_TRACKING_STRATEGY,
  type ReadTrackingStrategy,
  type RuntimeIdleHook,
  type RuntimeConfiguration,
  type RuntimeConfigurationOptions,
  type RuntimeHooks,
  type RuntimeSchedulerHooks,
  type NodeInvalidatedHook,
} from "./config";
import type { RuntimeExecutionFrame } from "./execution";
import type { ReactiveNode } from "./shape";

const RUNTIME_CONTEXT_BRAND: unique symbol = Symbol("RuntimeContext");

export interface RuntimeContextOptions extends RuntimeConfigurationOptions {
  hooks?: RuntimeHooks;
  scheduler?: RuntimeSchedulerHooks;
}

export interface RuntimeContext extends RuntimeConfiguration {
  readonly [RUNTIME_CONTEXT_BRAND]: true;
  currentConsumer: ReactiveNode | null;
  trackingStamp: number;
  propagationScopeDepth: number;
  batchDepth: number;
  runtimeState: number;
  /** DEV+PROFILE diagnostic phase/hook state saved while inactive. */
  executionFrame: RuntimeExecutionFrame | null;
}

export type RuntimeContextSnapshot = Omit<
  RuntimeContext,
  typeof RUNTIME_CONTEXT_BRAND | "executionFrame"
>;

export function createRuntimeContext(
  options: RuntimeContextOptions = {},
): RuntimeContext {
  const context = {
    [RUNTIME_CONTEXT_BRAND]: true,
    currentConsumer: null,
    trackingStamp: 0,
    propagationScopeDepth: 0,
    batchDepth: 0,
    runtimeState: 0,
    executionFrame: null,
    readTrackingStrategy: DEFAULT_READ_TRACKING_STRATEGY,
    nodeInvalidatedHook: undefined,
    runtimeIdleHook: undefined,
    hostFlushHook: undefined,
  } satisfies RuntimeContext;
  applyRuntimeContextOptions(context, options);
  return context;
}

export function isRuntimeContext(value: unknown): value is RuntimeContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RuntimeContext)[RUNTIME_CONTEXT_BRAND] === true
  );
}

export function applyRuntimeContextOptions(
  context: RuntimeContext,
  options: RuntimeContextOptions,
): void {
  if ("readTrackingStrategy" in options) {
    context.readTrackingStrategy =
      asFunction<ReadTrackingStrategy>(options.readTrackingStrategy) ??
      DEFAULT_READ_TRACKING_STRATEGY;
  }

  if ("hooks" in options) {
    const hooks = options.hooks ?? {};
    context.nodeInvalidatedHook = ownFunction<NodeInvalidatedHook>(
      hooks,
      "onNodeInvalidated",
    );
    context.runtimeIdleHook = ownFunction<RuntimeIdleHook>(
      hooks,
      "onRuntimeIdle",
    );
  }

  if ("scheduler" in options) {
    const scheduler = options.scheduler ?? {};
    context.hostFlushHook = ownFunction<RuntimeConfiguration["hostFlushHook"]>(
      scheduler,
      "onHostFlush",
    );
  }
}

function asFunction<T>(value: unknown): T | undefined {
  return typeof value === "function" ? (value as T) : undefined;
}

function ownFunction<T>(
  hooks: RuntimeHooks | RuntimeSchedulerHooks,
  name: keyof RuntimeHooks | keyof RuntimeSchedulerHooks,
): T | undefined {
  const values = hooks as Record<PropertyKey, unknown>;
  return Object.prototype.hasOwnProperty.call(hooks, name)
    ? asFunction<T>(values[name])
    : undefined;
}
