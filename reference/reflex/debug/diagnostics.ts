import { readRuntimePhase } from "@runtime/kernel/execution";
import {
  currentConsumer,
  reactiveBatchDepth,
  RuntimeState,
  runtimeState,
  trackingStamp,
} from "@runtime/kernel/state";
import { nodeInvalidatedHook, runtimeIdleHook } from "@runtime/kernel/config";
import type { ReactiveNode } from "@runtime/kernel";
import {
  isRuntimeProfilingEnabled,
  readRuntimeProfileCounters,
} from "@runtime/profiling";

import { findDebugNode, listDebugNodes } from "./debug.impl";
import type { RuntimeDebugEvent } from "./debug.types";
import { toDiagnosticJson } from "./diagnostics.json";
import type {
  RuntimeDiagnosticErrorCode,
  RuntimeDiagnosticResult,
  RuntimeDiagnostics,
} from "./diagnostics.types";
import type { RuntimeSubtle } from "./subtle.internal";

const MAX_EVENTS = 500;
const PHASE_NAMES = [
  "idle",
  "propagating",
  "pulling",
  "recomputing",
  "watcher-execution",
] as const;

function success(value: unknown): RuntimeDiagnosticResult {
  return { ok: true, result: toDiagnosticJson(value) };
}

function failure(
  code: RuntimeDiagnosticErrorCode,
  message: string,
): RuntimeDiagnosticResult {
  return { ok: false, code, message };
}

function resolveNode(id: number): ReactiveNode | RuntimeDiagnosticResult {
  if (!Number.isSafeInteger(id) || id <= 0) {
    return failure(
      "REFLEX_DIAGNOSTIC_INVALID_INPUT",
      "Node id must be a positive integer.",
    );
  }
  return (
    findDebugNode(id) ??
    failure("REFLEX_DIAGNOSTIC_NODE_NOT_FOUND", `Unknown node id: ${id}.`)
  );
}

function isFailure(
  value: ReactiveNode | RuntimeDiagnosticResult,
): value is RuntimeDiagnosticResult {
  return "ok" in value;
}

function referencesNode(event: RuntimeDebugEvent, id: number): boolean {
  return (
    event.node?.id === id ||
    event.source?.id === id ||
    event.target?.id === id ||
    event.consumer?.id === id
  );
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_EVENTS, Math.trunc(value)));
}

function phaseSnapshot() {
  const execution = readRuntimePhase();
  return {
    depth: execution.depth,
    name: PHASE_NAMES[execution.phase] ?? "unknown",
    phase: execution.phase,
  };
}

function graphDepth(nodes: ReactiveNode[]): number {
  const memo = new Map<ReactiveNode, number>();
  const visiting = new Set<ReactiveNode>();

  const depth = (node: ReactiveNode): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (visiting.has(node)) return 0;

    visiting.add(node);
    let result = 0;
    for (let edge = node.firstOut; edge !== null; edge = edge.nextOut) {
      result = Math.max(result, 1 + depth(edge.to));
    }
    visiting.delete(node);
    memo.set(node, result);
    return result;
  };

  let maximum = 0;
  for (const node of nodes) {
    maximum = Math.max(maximum, depth(node));
  }
  return maximum;
}

export function createRuntimeDiagnostics(
  subtle: RuntimeSubtle,
): RuntimeDiagnostics {
  const history = () => subtle.history();

  return {
    graph: {
      node(id) {
        const node = resolveNode(id);
        return isFailure(node) ? node : success(subtle.snapshot(node));
      },
      edges(id) {
        const node = resolveNode(id);
        if (isFailure(node)) return node;
        const snapshot = subtle.snapshot(node);
        return success({
          incoming: snapshot?.sources ?? [],
          outgoing: snapshot?.subscribers ?? [],
        });
      },
      parents(id) {
        const node = resolveNode(id);
        return isFailure(node)
          ? node
          : success(subtle.snapshot(node)?.sources ?? []);
      },
      children(id) {
        const node = resolveNode(id);
        return isFailure(node)
          ? node
          : success(subtle.snapshot(node)?.subscribers ?? []);
      },
      dump(input = {}) {
        if (input.rootId !== undefined) {
          const root = resolveNode(input.rootId);
          if (isFailure(root)) return root;
          return success(
            subtle.graph(root, {
              ...(input.depth === undefined ? {} : { depth: input.depth }),
              ...(input.direction === undefined
                ? {}
                : { direction: input.direction }),
            }),
          );
        }

        const nodes = listDebugNodes();
        const snapshots = nodes.flatMap((node) => {
          const snapshot = subtle.snapshot(node);
          return snapshot === undefined ? [] : [snapshot];
        });
        const edges = snapshots.flatMap((node) =>
          node.subscribers.map((target) => ({ from: node.id, to: target.id })),
        );
        return success({ edges, nodes: snapshots });
      },
      integrity(id) {
        const node = resolveNode(id);
        return isFailure(node) ? node : success(subtle.graphIntegrity(node));
      },
    },
    runtime: {
      context: () => success(subtle.context() ?? null),
      scheduler: () =>
        success({
          batchDepth: reactiveBatchDepth,
          idlePending: (runtimeState & RuntimeState.IdlePending) !== 0,
          nodeInvalidatedHookConfigured: nodeInvalidatedHook !== undefined,
          phase: phaseSnapshot(),
          runtimeIdleHookConfigured: runtimeIdleHook !== undefined,
          runtimeState,
        }),
      phase: () => success(phaseSnapshot()),
      batchDepth: () => success(reactiveBatchDepth),
      currentConsumer: () =>
        success(
          currentConsumer === null ? null : subtle.snapshot(currentConsumer),
        ),
      trackingStack: () =>
        success({
          available: false,
          currentConsumer:
            currentConsumer === null ? null : subtle.snapshot(currentConsumer),
          reason:
            "Runtime currently exposes only currentConsumer, not a tracking stack.",
        }),
      stackStats: () => success(subtle.stackStats() ?? null),
    },
    dependencies: {
      whyDirty(id) {
        const node = resolveNode(id);
        if (isFailure(node)) return node;
        const snapshot = subtle.snapshot(node);
        if (snapshot?.dirty === "clean") {
          return success({ dirty: false, node: snapshot });
        }
        const cause = history()
          .slice()
          .reverse()
          .find(
            (event) =>
              (event.type === "propagate" && event.target?.id === id) ||
              (event.type === "write:producer" && event.node?.id === id) ||
              (event.type === "watcher:invalidated" && event.node?.id === id),
          );
        return success({ cause: cause ?? null, dirty: true, node: snapshot });
      },
      whoInvalidated(id) {
        const node = resolveNode(id);
        if (isFailure(node)) return node;
        const event = history()
          .slice()
          .reverse()
          .find(
            (candidate) =>
              candidate.type === "propagate" && candidate.target?.id === id,
          );
        return success({ event: event ?? null, source: event?.source ?? null });
      },
      chain(id, maxDepth = 20) {
        const root = resolveNode(id);
        if (isFailure(root)) return root;
        return success(
          subtle.graph(root, {
            depth: Math.max(0, Math.min(20, Math.trunc(maxDepth))),
            direction: "sources",
          }),
        );
      },
      recomputePath(id, limit = 100) {
        const node = resolveNode(id);
        if (isFailure(node)) return node;
        const dependencyIds = new Set(
          subtle
            .graph(node, { direction: "sources" })
            .nodes.map((entry) => entry.id),
        );
        dependencyIds.add(id);
        const events = history()
          .filter((event) =>
            [...dependencyIds].some((nodeId) => referencesNode(event, nodeId)),
          )
          .slice(-boundedLimit(limit, 100));
        return success(events);
      },
    },
    timeline: {
      events(input = {}) {
        let events = history();
        if (input.nodeId !== undefined) {
          events = events.filter((event) =>
            referencesNode(event, input.nodeId!),
          );
        }
        return success(events.slice(-boundedLimit(input.limit, 100)));
      },
      timestamps(id) {
        const node = resolveNode(id);
        if (isFailure(node)) return node;
        const events = history().filter((event) => referencesNode(event, id));
        const latestEvent = (
          predicate: (event: RuntimeDebugEvent) => boolean,
        ) => events.slice().reverse().find(predicate);
        const latest = (type: RuntimeDebugEvent["type"]) =>
          latestEvent((event) => event.type === type)?.timestamp ?? null;
        return success({
          changedAt:
            latestEvent(
              (event) =>
                (event.type === "write:producer" && event.node?.id === id) ||
                (event.type === "propagate" && event.target?.id === id),
            )?.timestamp ?? null,
          createdAt: latest("node:create"),
          invalidatedAt: latest("watcher:invalidated"),
          recomputedAt: latest("recompute"),
          validatedAt: null,
        });
      },
    },
    statistics: {
      summary() {
        const nodes = listDebugNodes();
        const fanOutHistogram: Record<number, number> = {};
        let edgeCount = 0;
        for (const node of nodes) {
          let fanOut = 0;
          for (let edge = node.firstOut; edge !== null; edge = edge.nextOut) {
            fanOut++;
          }
          edgeCount += fanOut;
          fanOutHistogram[fanOut] = (fanOutHistogram[fanOut] ?? 0) + 1;
        }
        const events = history();
        const profiling = isRuntimeProfilingEnabled();
        const counters = readRuntimeProfileCounters();
        return success({
          cacheHits: {
            available: profiling,
            value: profiling ? counters.readConsumerCleanFastPath : null,
          },
          cacheMisses: {
            available: profiling,
            value: profiling ? counters.readConsumerDirtyPath : null,
          },
          edgeCount,
          eventCount: events.length,
          fanOutHistogram,
          maxDepth: graphDepth(nodes),
          nodeCount: nodes.length,
          recomputeCount: {
            historyWindow: events.filter((event) => event.type === "recompute")
              .length,
            profiled: profiling ? counters.advanceComputeRuns : null,
          },
          trackingStamp,
        });
      },
    },
  };
}
