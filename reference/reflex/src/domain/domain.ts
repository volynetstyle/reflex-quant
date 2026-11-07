import { enterReactiveBatch, leaveReactiveBatch } from "../kernel/batch";
import type {
  ReadTrackingStrategy,
  RuntimeHooks,
  RuntimeSchedulerHooks,
} from "../kernel/config";
import {
  configureRuntimeContext,
  createRuntimeContext,
  enterRuntimeContextRegion,
  getActiveRuntimeContext,
  leaveRuntimeContextRegion,
  runWithRuntimeContext,
  type RuntimeContext,
} from "../kernel/context";
import type { ReactiveNode } from "../kernel/shape";

/**
 * Host scheduler policy attached to exactly one execution domain.
 *
 * Hooks follow the runtime contract: `onNodeInvalidated` only enqueues.
 * `batch`/`flush`, when present, replace the default composition and always
 * run inside the domain.
 */
export interface ExecutionDomainScheduler {
  readonly onNodeInvalidated?: (node: ReactiveNode) => void;
  readonly onRuntimeIdle?: () => void;
  readonly onHostFlush?: () => void;
  enterBatch?(): void;
  leaveBatch?(): void;
  batch?<T>(fn: () => T): T;
  flush?(): void;
  hasPending?(): boolean;
  /** Drops queued work and pending host requests when the domain closes. */
  release?(): void;
}

export interface ExecutionDomainOptions {
  /** Additional host hooks, composed after the scheduler's own hooks. */
  hooks?: RuntimeHooks;
  readTrackingStrategy?: ReadTrackingStrategy;
  /** A scheduler, or a factory receiving the domain's runtime context. */
  scheduler?:
    | ExecutionDomainScheduler
    | ((context: RuntimeContext) => ExecutionDomainScheduler);
  /** Receives errors thrown by deferred teardown. Defaults to console.error. */
  onTeardownError?: (error: unknown) => void;
}

// Primitive states are inlined by the build; the exported object is the API.
const OPEN = 0;
const CLOSING = 1;
const CLOSED = 2;

export const ExecutionDomainState = {
  Open: OPEN,
  Closing: CLOSING,
  Closed: CLOSED,
} as const;

export type ExecutionDomainState =
  (typeof ExecutionDomainState)[keyof typeof ExecutionDomainState];

/**
 * An isolated reactive execution area: one register bank, one scheduler, one
 * managed entry depth. Nodes are not tagged with their domain; isolation is a
 * contract of the managed entry points (see docs/architecture).
 */
export interface ExecutionDomain {
  readonly context: RuntimeContext;
  readonly state: ExecutionDomainState;
  /** `true` once `close()` was requested. */
  readonly closed: boolean;
  /** Aborted as soon as `close()` is requested. */
  readonly signal: AbortSignal;
  /** Managed entries currently on the stack. Zero is a safe point. */
  readonly depth: number;
  run<T>(fn: () => T): T;
  batch<T>(fn: () => T): T;
  flush(): void;
  hasPending(): boolean;
  /**
   * Runs graph teardown at a safe point: now when no managed entry of this
   * domain is on the stack, otherwise at the outermost managed exit.
   */
  teardown(fn: () => void): void;
  /** Logical close now; physical teardown at the next safe point. */
  close(): void;
}

export class ExecutionDomainClosedError extends Error {
  constructor() {
    super("The execution domain is closed.");
    this.name = "ExecutionDomainClosedError";
  }
}

const domains = new WeakMap<RuntimeContext, ExecutionDomain>();

/** The domain that owns `context`, if it was created by a domain. */
export function getExecutionDomain(
  context: RuntimeContext,
): ExecutionDomain | undefined {
  return domains.get(context);
}

/** The domain of the active runtime context, if any. */
export function getActiveExecutionDomain(): ExecutionDomain | undefined {
  return domains.get(getActiveRuntimeContext());
}

function reportTeardownError(error: unknown): void {
  console.error("Execution domain teardown error:", error);
}

/** Hooks are untrusted input: anything but a function is ignored. */
function compose<A extends unknown[]>(
  first: unknown,
  second: unknown,
): ((...args: A) => void) | undefined {
  if (typeof first !== "function") first = undefined;
  if (typeof second !== "function") second = undefined;
  if (first === undefined) return second as ((...args: A) => void) | undefined;
  if (second === undefined) return first as (...args: A) => void;
  return (...args: A): void => {
    (first as (...args: A) => void)(...args);
    (second as (...args: A) => void)(...args);
  };
}

function throwCollected(errors: unknown[]): never {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Reactive batch failed");
}

/**
 * Cold exit of a batch whose callback threw: both boundaries still close, in
 * order, and every failure is reported, the callback's first.
 */
function leaveBatchAfterError(
  scheduler: ExecutionDomainScheduler,
  error: unknown,
): never {
  const errors = [error];
  try {
    scheduler.leaveBatch?.();
  } catch (leaveError) {
    errors.push(leaveError);
  }
  try {
    leaveReactiveBatch();
  } catch (leaveError) {
    errors.push(leaveError);
  }
  return throwCollected(errors);
}

/** Cold exit when the scheduler boundary itself failed to close. */
function leaveReactiveBatchAfterError(error: unknown): never {
  const errors = [error];
  try {
    leaveReactiveBatch();
  } catch (leaveError) {
    errors.push(leaveError);
  }
  return throwCollected(errors);
}

/** Live per-domain state behind the prototype accessors. */
interface DomainView {
  state(): ExecutionDomainState;
  depth(): number;
  signal(): AbortSignal;
}

type DomainOperations = Pick<
  ExecutionDomain,
  "run" | "batch" | "flush" | "hasPending" | "teardown" | "close"
>;

const VIEW: unique symbol = Symbol("ExecutionDomain.view");

interface DomainInstance extends DomainOperations {
  readonly context: RuntimeContext;
  readonly [VIEW]: DomainView;
}

const viewOf = (domain: object): DomainView => (domain as DomainInstance)[VIEW];

/**
 * Operations are own data properties holding closures, so they work detached
 * (`const { batch } = domain`). The accessors live on this shared prototype:
 * own accessors on the domain object kept V8 from treating `run` and `batch`
 * as constant methods, so every `domain.run(fn)` was a dynamic call that
 * could not inline. A class with a private field gave the same calls but
 * shifted unrelated kernel workloads (fan-out) into a slower code shape.
 */
const domainPrototype = {
  get state(): ExecutionDomainState {
    return viewOf(this).state();
  },
  get closed(): boolean {
    return viewOf(this).state() !== OPEN;
  },
  get signal(): AbortSignal {
    return viewOf(this).signal();
  },
  get depth(): number {
    return viewOf(this).depth();
  },
};

function createDomainObject(
  context: RuntimeContext,
  view: DomainView,
  operations: DomainOperations,
): ExecutionDomain {
  const domain = Object.create(domainPrototype) as DomainInstance;
  Object.assign(domain, { context }, operations, { [VIEW]: view });
  return domain as unknown as ExecutionDomain;
}

export function createExecutionDomain(
  options: ExecutionDomainOptions = {},
): ExecutionDomain {
  const context = createRuntimeContext(
    options.readTrackingStrategy === undefined
      ? {}
      : { readTrackingStrategy: options.readTrackingStrategy },
  );
  const scheduler: ExecutionDomainScheduler =
    typeof options.scheduler === "function"
      ? options.scheduler(context)
      : (options.scheduler ?? {});
  const onTeardownError = options.onTeardownError ?? reportTeardownError;
  const hooks = options.hooks;

  // Trusted, already-validated hooks; the context is still inactive.
  context.nodeInvalidatedHook = compose(
    scheduler.onNodeInvalidated,
    hooks?.onNodeInvalidated,
  );
  context.runtimeIdleHook = compose(
    scheduler.onRuntimeIdle,
    hooks?.onRuntimeIdle,
  );
  context.hostFlushHook = compose(scheduler.onHostFlush, undefined);

  let state: ExecutionDomainState = OPEN;
  let depth = 0;
  let controller: AbortController | undefined;
  const pendingTeardown: Array<() => void> = [];
  let draining = false;

  const enter = <T>(fn: () => T): T =>
    getActiveRuntimeContext() === context
      ? fn()
      : runWithRuntimeContext(context, fn);

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      enter(() => {
        while (pendingTeardown.length !== 0) {
          const task = pendingTeardown.shift()!;
          try {
            task();
          } catch (error) {
            onTeardownError(error);
          }
        }
      });
    } finally {
      draining = false;
    }
  };

  const finalize = (): void => {
    drain();
    state = CLOSED;
    // Stray raw writes after close must not reach the released scheduler.
    configureRuntimeContext(context, {
      hooks: {},
      scheduler: {} satisfies RuntimeSchedulerHooks,
    });
  };

  // Outermost managed exit: a safe point only does work when teardown is
  // pending or close() was requested meanwhile.
  const leaveSafePoint = (): void => {
    if (pendingTeardown.length !== 0) drain();
    if (state === CLOSING) finalize();
  };

  // Managed entries are ordered from the cheapest case to the most expensive.
  // An open domain whose context is already active only counts the entry; a
  // context switch, a pending safe point and failures leave the straight
  // line. The callback is invoked by run() and batch() themselves and never
  // passed on, so both stay small enough to inline and a caller's closure
  // need not be allocated.
  const enterManaged = (): RuntimeContext | null => {
    if (state === CLOSED) {
      throw new ExecutionDomainClosedError();
    }

    ++depth;
    return getActiveRuntimeContext() === context
      ? null
      : enterRuntimeContextRegion(context);
  };

  // Mirrors the nesting of runWithRuntimeContext inside run(): the context is
  // restored first, then the entry is uncounted.
  const leaveManaged = (previous: RuntimeContext | null): void => {
    try {
      if (previous !== null) leaveRuntimeContextRegion(previous);
    } finally {
      if (--depth === 0 && (pendingTeardown.length !== 0 || state === CLOSING))
        leaveSafePoint();
    }
  };

  const run = <T>(fn: () => T): T => {
    const previous = enterManaged();
    try {
      return fn();
    } finally {
      leaveManaged(previous);
    }
  };

  // A failure while opening leaves the boundaries as the unfused composition
  // did: only the managed entry is undone.
  const enterBatch = (): RuntimeContext | null => {
    const previous = enterManaged();
    try {
      enterReactiveBatch();
      scheduler.enterBatch?.();
    } catch (error) {
      leaveManaged(previous);
      throw error;
    }
    return previous;
  };

  // Close scheduler policy before the reactive batch so a settled hook never
  // observes the scheduler in its batching phase.
  const leaveBatch = (previous: RuntimeContext | null): void => {
    try {
      try {
        scheduler.leaveBatch?.();
      } catch (error) {
        leaveReactiveBatchAfterError(error);
      }
      leaveReactiveBatch();
    } finally {
      leaveManaged(previous);
    }
  };

  const leaveBatchFailed = (
    previous: RuntimeContext | null,
    error: unknown,
  ): never => {
    try {
      return leaveBatchAfterError(scheduler, error);
    } finally {
      leaveManaged(previous);
    }
  };

  const defaultBatch = <T>(fn: () => T): T => {
    const previous = enterBatch();
    let result: T;
    try {
      result = fn();
    } catch (error) {
      return leaveBatchFailed(previous, error);
    }
    leaveBatch(previous);
    return result;
  };

  const customBatch = scheduler.batch;
  const batch =
    customBatch === undefined
      ? defaultBatch
      : <T>(fn: () => T): T => run(() => customBatch(fn));
  const flushImpl = scheduler.flush;

  const domain = createDomainObject(
    context,
    {
      state: () => state,
      depth: () => depth,
      signal(): AbortSignal {
        if (controller === undefined) {
          controller = new AbortController();
          if (state !== OPEN) controller.abort();
        }
        return controller.signal;
      },
    },
    {
      run,
      batch,
      flush(): void {
        if (state === CLOSED || flushImpl === undefined) {
          return;
        }
        run(flushImpl);
      },
      hasPending(): boolean {
        return state !== CLOSED ? (scheduler.hasPending?.() ?? false) : false;
      },
      teardown(fn: () => void): void {
        if (depth === 0 && !draining) {
          enter(fn);
          return;
        }
        pendingTeardown.push(fn);
      },
      close(): void {
        if (state !== OPEN) return;
        state = CLOSING;
        try {
          scheduler.release?.();
        } finally {
          controller?.abort();
          if (depth === 0) finalize();
        }
      },
    },
  );

  domains.set(context, domain);
  return domain;
}
