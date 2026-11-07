import { recordDebugEvent } from "../../debug/debug.runtime";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

import {
  devAssertRuntimeHookDidNotReenter,
  enterRuntimeHook,
  leaveRuntimeHook,
  readRuntimePhase,
} from "./execution";
import {
  clearHostWorkPending,
  markHostWorkPending,
  RuntimeState,
  runtimeState,
} from "./state";
import type { ReactiveEdge, ReactiveNode } from "./shape";
import { reuseIncomingEdgeFromSuffixOrCreate } from "./shape/graph";

export interface RuntimeDebugContext {
  readonly scope: "runtime";
}

export const defaultContext: RuntimeDebugContext = {
  scope: "runtime",
};

// #region Read tracking strategy

export type ReadTrackingStrategy = (
  source: ReactiveNode,
  consumer: ReactiveNode,
  prev: ReactiveEdge | null,
  nextExpected: ReactiveEdge | null,
  version: number,
) => ReactiveEdge;

export const DEFAULT_READ_TRACKING_STRATEGY: ReadTrackingStrategy =
  reuseIncomingEdgeFromSuffixOrCreate;

// eslint-disable-next-line no-var
export var readTrackingStrategy: ReadTrackingStrategy =
  DEFAULT_READ_TRACKING_STRATEGY;

// #endregion

// #region Runtime hooks

export interface RuntimeHooks {
  /** Enqueue-only invalidation notification; reactive execution is forbidden. */
  onNodeInvalidated?(node: ReactiveNode): void;
  /** Idle host boundary; synchronous scheduler drain is permitted. */
  onRuntimeIdle?(): void;
}

export interface RuntimeSchedulerHooks {
  /** Synchronous host drain requested by an enqueue-only invalidation hook. */
  onHostFlush?(): void;
}

export type RuntimeHostHooks = RuntimeHooks;

export type NodeInvalidatedHook = RuntimeHooks["onNodeInvalidated"];
export type RuntimeIdleHook = RuntimeHooks["onRuntimeIdle"];
export type HostFlushHook = RuntimeSchedulerHooks["onHostFlush"];

// eslint-disable-next-line no-var
export var nodeInvalidatedHook: NodeInvalidatedHook = undefined;

// eslint-disable-next-line no-var
export var runtimeIdleHook: RuntimeIdleHook = undefined;

// eslint-disable-next-line no-var
export var hostFlushHook: HostFlushHook = undefined;

// #endregion

// #region Runtime configuration

export interface RuntimeConfiguration {
  readTrackingStrategy: ReadTrackingStrategy;
  nodeInvalidatedHook: NodeInvalidatedHook;
  runtimeIdleHook: RuntimeIdleHook;
  hostFlushHook: HostFlushHook;
}

export interface RuntimeConfigurationOptions {
  readTrackingStrategy?: ReadTrackingStrategy;
}

export function loadRuntimeConfiguration(
  configuration: RuntimeConfiguration,
): void {
  readTrackingStrategy = configuration.readTrackingStrategy;
  nodeInvalidatedHook = configuration.nodeInvalidatedHook;
  runtimeIdleHook = configuration.runtimeIdleHook;
  hostFlushHook = configuration.hostFlushHook;
}

// #endregion

// #region Hook emitters

// eslint-disable-next-line no-var
export var emitNodeInvalidated = !__DEV__
  ? (node: ReactiveNode) => {
      const hook = nodeInvalidatedHook;
      if (hook === undefined) return;

      hook(node);
    }
  : function (node: ReactiveNode): void {
      if (__PROFILE__)
        observeRuntimeProjection?.("projection.semantic.node.invalidated.emit");

      if (__DEV__) {
        recordDebugEvent(defaultContext, "watcher:invalidated", { node });
      }

      const hook = nodeInvalidatedHook;
      if (hook === undefined) return;

      if (!__DEV__) {
        hook(node);
        return;
      }

      const before = readRuntimePhase();
      const phaseBefore = before.phase;
      const depthBefore = before.depth;

      enterRuntimeHook("onNodeInvalidated");
      try {
        hook(node);
        devAssertRuntimeHookDidNotReenter(
          "onNodeInvalidated",
          phaseBefore,
          depthBefore,
        );
      } finally {
        leaveRuntimeHook();
      }
    };

export function emitRuntimeIdle(): void {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.settled.emit");

  if ((runtimeState & RuntimeState.HostWorkPending) !== RuntimeState.Idle) {
    const flush = hostFlushHook;

    try {
      if (flush !== undefined) callIdleHostHook("onHostFlush", flush);
    } finally {
      clearHostWorkPending();
    }
  }

  const hook = runtimeIdleHook;
  if (hook === undefined) return;

  callIdleHostHook("onRuntimeIdle", hook);
}

export function requestHostFlush(): void {
  markHostWorkPending();
}

export function cancelHostFlushRequest(): void {
  clearHostWorkPending();
}

function callIdleHostHook(name: string, hook: () => void): void {
  if (!__DEV__) {
    hook();
    return;
  }

  const before = readRuntimePhase();
  const phaseBefore = before.phase;
  const depthBefore = before.depth;

  enterRuntimeHook(name);
  try {
    hook();
    devAssertRuntimeHookDidNotReenter(name, phaseBefore, depthBefore);
  } finally {
    leaveRuntimeHook();
  }
}

// #endregion
