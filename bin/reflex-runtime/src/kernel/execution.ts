export const RuntimePhase = {
  Idle: 0,
  Propagating: 1,
  Pulling: 2,
  Recomputing: 3,
  WatcherExecution: 4,
} as const;

export type RuntimePhase = (typeof RuntimePhase)[keyof typeof RuntimePhase];

export const RuntimeExecutionError = {
  NestedPull: {
    code: "REFLEX_NESTED_PULL",
    message: [
      "A reactive consumer attempted to start a pull walk while another pull walk was already active.",
      "",
      "This usually indicates:",
      "- synchronous effect execution",
      "- scheduler reentrancy",
      "- runtime hook misuse",
    ].join("\n"),
  },
  NestedPropagation: {
    code: "REFLEX_NESTED_PROPAGATION",
    message:
      "A reactive producer attempted to start propagation while another propagation walk was already active.",
  },
  SchedulerReentrantFlush: {
    code: "REFLEX_SCHEDULER_REENTRANT_FLUSH",
    message: [
      "Host scheduler executed runWatcher() synchronously from onNodeInvalidated.",
      "",
      "Invalidation hooks must enqueue work and return before executing watchers.",
      "",
      "Allowed:",
      "  enqueue watcher",
      "  schedule host flush",
      "",
      "Forbidden:",
      "  runWatcher(...)",
      "  readConsumer(...)",
      "  pull_dependency(...)",
    ].join("\n"),
  },
  SchedulerReactiveReadInHook: {
    code: "REFLEX_SCHEDULER_REACTIVE_READ_IN_HOOK",
    message: [
      "Host scheduler performed a reactive read from onNodeInvalidated.",
      "",
      "Invalidation hooks must not read reactive graph state.",
    ].join("\n"),
  },
  SchedulerTopologyMutationInHook: {
    code: "REFLEX_SCHEDULER_TOPOLOGY_MUTATION_IN_HOOK",
    message: [
      "Host scheduler attempted to dispose a watcher from onNodeInvalidated.",
      "",
      "Invalidation hooks must only enqueue work and return.",
      "Schedule disposal from onRuntimeIdle or another host boundary.",
    ].join("\n"),
  },
  HostHookReenteredRuntime: {
    code: "REFLEX_HOST_HOOK_REENTERED_RUNTIME",
  },
  RecomputeDepthExceeded: {
    code: "REFLEX_RECOMPUTE_DEPTH_EXCEEDED",
    message:
      "Reactive computation depth exceeded the development safety limit.",
  },
} as const;

export interface RuntimeExecutionState {
  phase: RuntimePhase;
  depth: number;
}

const runtimeExecutionState: RuntimeExecutionState = {
  phase: RuntimePhase.Idle,
  depth: 0,
};

const SCHEDULER_POLICY_ENABLED =
  typeof __DEV__ !== "undefined" &&
  __DEV__ &&
  typeof __PROFILE__ !== "undefined" &&
  __PROFILE__;

const phaseStack: RuntimePhase[] = [];
let activeRuntimeHook: string | null = null;
const runtimeHookStack: Array<string | null> = [];
let runtimeHookDepth = 0;
const MAX_RECOMPUTE_DEPTH = 1_024;
let recomputeDepth = 0;

export function enterRuntimePhase(phase: RuntimePhase): void {
  if (!SCHEDULER_POLICY_ENABLED) return;

  if (phase === RuntimePhase.Pulling) {
    assertCurrentPhaseIsNot(
      RuntimePhase.Pulling,
      RuntimeExecutionError.NestedPull,
    );
  } else if (phase === RuntimePhase.Propagating) {
    assertPhaseNotActive(
      RuntimePhase.Propagating,
      RuntimeExecutionError.NestedPropagation,
    );
  } else if (phase === RuntimePhase.Recomputing) {
    if (recomputeDepth >= MAX_RECOMPUTE_DEPTH) {
      const error = RuntimeExecutionError.RecomputeDepthExceeded;
      throw new Error(`${error.code}: ${error.message}`);
    }
    recomputeDepth += 1;
  }

  phaseStack[runtimeExecutionState.depth] = runtimeExecutionState.phase;
  runtimeExecutionState.phase = phase;
  runtimeExecutionState.depth++;
}

export function leaveRuntimePhase(): void {
  if (!SCHEDULER_POLICY_ENABLED) return;

  if (runtimeExecutionState.phase === RuntimePhase.Recomputing) {
    recomputeDepth -= 1;
  }

  if (runtimeExecutionState.depth > 0) {
    runtimeExecutionState.depth--;
  }

  if (runtimeExecutionState.depth === 0) {
    runtimeExecutionState.phase = RuntimePhase.Idle;
    phaseStack.length = 0;
  } else {
    runtimeExecutionState.phase =
      phaseStack[runtimeExecutionState.depth] ?? RuntimePhase.Idle;
    phaseStack.length = runtimeExecutionState.depth;
  }
}

export function readRuntimePhase(): RuntimeExecutionState {
  return runtimeExecutionState;
}

export function enterRuntimeHook(name: string): void {
  if (!SCHEDULER_POLICY_ENABLED) return;

  runtimeHookStack[runtimeHookDepth++] = activeRuntimeHook;
  activeRuntimeHook = name;
}

export function leaveRuntimeHook(): void {
  if (!SCHEDULER_POLICY_ENABLED) return;

  if (runtimeHookDepth === 0) {
    activeRuntimeHook = null;
    return;
  }

  activeRuntimeHook = runtimeHookStack[--runtimeHookDepth] ?? null;
  runtimeHookStack.length = runtimeHookDepth;
}

export function readActiveRuntimeHook(): string | null {
  return activeRuntimeHook;
}

export function devAssertNoRuntimeHookWatcherExecution(): void {
  if (!SCHEDULER_POLICY_ENABLED || activeRuntimeHook !== "onNodeInvalidated") {
    return;
  }

  throwRuntimeExecutionError(RuntimeExecutionError.SchedulerReentrantFlush);
}

export function devAssertNoRuntimeHookReactiveRead(): void {
  if (!SCHEDULER_POLICY_ENABLED || activeRuntimeHook !== "onNodeInvalidated") {
    return;
  }

  throwRuntimeExecutionError(RuntimeExecutionError.SchedulerReactiveReadInHook);
}

export function devAssertNoRuntimeHookTopologyMutation(): void {
  if (!SCHEDULER_POLICY_ENABLED || activeRuntimeHook !== "onNodeInvalidated") {
    return;
  }

  throwRuntimeExecutionError(
    RuntimeExecutionError.SchedulerTopologyMutationInHook,
  );
}

export function devAssertRuntimeHookDidNotReenter(
  hookName: string,
  phaseBefore: RuntimePhase,
  depthBefore: number,
): void {
  if (!SCHEDULER_POLICY_ENABLED) return;

  if (
    runtimeExecutionState.phase === phaseBefore &&
    runtimeExecutionState.depth === depthBefore
  ) {
    return;
  }

  throwRuntimeExecutionError({
    code: RuntimeExecutionError.HostHookReenteredRuntime.code,
    message: [
      `Host hook ${hookName} changed runtime execution phase while it was running.`,
      "",
      "Runtime hooks must enqueue work and return before watchers or reactive reads execute.",
    ].join("\n"),
  });
}

/**
 * Diagnostic execution state saved with an inactive execution context.
 * `null` is the idle frame. Only populated when the scheduler policy is on.
 */
export interface RuntimeExecutionFrame {
  readonly phase: RuntimePhase;
  readonly phases: readonly RuntimePhase[];
  readonly hook: string | null;
  readonly hooks: readonly (string | null)[];
  readonly recomputeDepth: number;
}

export const RUNTIME_EXECUTION_FRAMES_ENABLED = SCHEDULER_POLICY_ENABLED;

/** Captures the live diagnostic state; `null` when it is idle. */
export function saveRuntimeExecutionFrame(): RuntimeExecutionFrame | null {
  if (!SCHEDULER_POLICY_ENABLED) return null;
  if (
    runtimeExecutionState.depth === 0 &&
    runtimeHookDepth === 0 &&
    activeRuntimeHook === null &&
    recomputeDepth === 0
  ) {
    return null;
  }

  return {
    phase: runtimeExecutionState.phase,
    phases: phaseStack.slice(0, runtimeExecutionState.depth),
    hook: activeRuntimeHook,
    hooks: runtimeHookStack.slice(0, runtimeHookDepth),
    recomputeDepth,
  };
}

/** Replaces the live diagnostic state with a saved frame. */
export function loadRuntimeExecutionFrame(
  frame: RuntimeExecutionFrame | null,
): void {
  if (!SCHEDULER_POLICY_ENABLED) return;
  if (frame === null) {
    resetRuntimeExecutionState();
    return;
  }

  runtimeExecutionState.phase = frame.phase;
  runtimeExecutionState.depth = frame.phases.length;
  phaseStack.length = 0;
  phaseStack.push(...frame.phases);
  activeRuntimeHook = frame.hook;
  runtimeHookDepth = frame.hooks.length;
  runtimeHookStack.length = 0;
  runtimeHookStack.push(...frame.hooks);
  recomputeDepth = frame.recomputeDepth;
}

export function resetRuntimeExecutionState(): void {
  runtimeExecutionState.phase = RuntimePhase.Idle;
  runtimeExecutionState.depth = 0;
  recomputeDepth = 0;
  phaseStack.length = 0;
  activeRuntimeHook = null;
  runtimeHookDepth = 0;
  runtimeHookStack.length = 0;
}

function assertPhaseNotActive(
  phase: RuntimePhase,
  error: RuntimeExecutionErrorDefinition,
): void {
  if (!isPhaseActive(phase)) {
    return;
  }

  throwRuntimeExecutionError(error);
}

function assertCurrentPhaseIsNot(
  phase: RuntimePhase,
  error: RuntimeExecutionErrorDefinition,
): void {
  if (
    runtimeExecutionState.phase !== phase ||
    runtimeExecutionState.depth === 0
  ) {
    return;
  }

  throwRuntimeExecutionError(error);
}

type RuntimeExecutionErrorDefinition = {
  code: string;
  message: string;
};

function throwRuntimeExecutionError(
  error: RuntimeExecutionErrorDefinition,
): never {
  throw new Error(`[${error.code}]\n\n${error.message}`);
}

function isPhaseActive(phase: RuntimePhase): boolean {
  if (runtimeExecutionState.depth === 0) return false;
  if (runtimeExecutionState.phase === phase) return true;

  for (let i = runtimeExecutionState.depth - 1; i >= 0; i--) {
    if (phaseStack[i] === phase) return true;
  }

  return false;
}
