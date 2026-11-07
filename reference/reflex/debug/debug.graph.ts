import type { ReactiveNode } from "@runtime/kernel";
import { Computing, Watcher, isOutgoingHint } from "@runtime/kernel/shape";

import {
  type RuntimeDebugGraphEdgeSnapshot,
  type RuntimeDebugGraphIntegrity,
  type RuntimeDebugGraphIssue,
  type RuntimeDebugGraphOptions,
  type RuntimeDebugGraphSnapshot,
} from "./debug.protocol";
import type { RuntimeDebugNodeSnapshot } from "./debug.types";

type ReactiveNodeEdge = NonNullable<ReactiveNode["firstIn"]>;

function normalizeGraphDepth(depth: number | undefined): number {
  if (depth === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(depth)) return Number.POSITIVE_INFINITY;

  return Math.max(0, Math.trunc(depth));
}

function outgoingIndex(edge: ReactiveNode["firstOut"]): number {
  let index = 0;

  for (
    let cursor = edge?.from.firstOut ?? null;
    cursor !== null;
    cursor = cursor.nextOut
  ) {
    if (cursor === edge) return index;
    index++;
  }

  return -1;
}

function incomingIndex(edge: ReactiveNode["firstIn"]): number {
  let index = 0;

  for (
    let cursor = edge?.to.firstIn ?? null;
    cursor !== null;
    cursor = cursor.nextIn
  ) {
    if (cursor === edge) return index;
    index++;
  }

  return -1;
}

export function snapshotDebugGraphEdge(
  edge: ReactiveNodeEdge,
  snapshotNode: (node: ReactiveNode) => RuntimeDebugNodeSnapshot,
): RuntimeDebugGraphEdgeSnapshot {
  return {
    from: snapshotNode(edge.from),
    to: snapshotNode(edge.to),
    incomingIndex: incomingIndex(edge),
    outgoingIndex: outgoingIndex(edge),
    stamp: edge.stamp,
  };
}

export function snapshotDebugGraph(
  root: ReactiveNode,
  snapshotNode: (node: ReactiveNode) => RuntimeDebugNodeSnapshot,
  options: RuntimeDebugGraphOptions = {},
): RuntimeDebugGraphSnapshot {
  const direction = options.direction ?? "both";
  const maxDepth = normalizeGraphDepth(options.depth);
  const nodes = new Map<ReactiveNode, RuntimeDebugNodeSnapshot>();
  const edges: RuntimeDebugGraphEdgeSnapshot[] = [];
  const seenEdges = new Set<ReactiveNodeEdge>();
  const queue: { node: ReactiveNode; depth: number }[] = [
    { node: root, depth: 0 },
  ];

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { node, depth } = queue[cursor]!;
    if (!nodes.has(node)) nodes.set(node, snapshotNode(node));
    if (depth >= maxDepth) continue;

    if (direction === "both" || direction === "sources") {
      for (let edge = node.firstIn; edge !== null; edge = edge.nextIn) {
        if (!seenEdges.has(edge)) {
          seenEdges.add(edge);
          edges.push(snapshotDebugGraphEdge(edge, snapshotNode));
        }
        if (!nodes.has(edge.from)) {
          queue.push({ node: edge.from, depth: depth + 1 });
        }
      }
    }

    if (direction === "both" || direction === "sinks") {
      for (let edge = node.firstOut; edge !== null; edge = edge.nextOut) {
        if (!seenEdges.has(edge)) {
          seenEdges.add(edge);
          edges.push(snapshotDebugGraphEdge(edge, snapshotNode));
        }
        if (!nodes.has(edge.to)) {
          queue.push({ node: edge.to, depth: depth + 1 });
        }
      }
    }
  }

  return {
    root: snapshotNode(root),
    nodes: [...nodes.values()],
    edges,
  };
}

function collectEdgeListIntegrity(
  node: ReactiveNode,
  snapshot: RuntimeDebugNodeSnapshot,
  direction: "in" | "out",
  snapshotNode: (node: ReactiveNode) => RuntimeDebugNodeSnapshot,
  issues: RuntimeDebugGraphIssue[],
): ReactiveNodeEdge[] {
  const edges: ReactiveNodeEdge[] = [];
  const seen = new Set<ReactiveNodeEdge>();
  let edge = direction === "in" ? node.firstIn : node.firstOut;
  let previous: ReactiveNodeEdge | null = null;

  while (edge !== null) {
    const duplicateCode =
      direction === "in"
        ? "duplicate-incoming-edge"
        : "duplicate-outgoing-edge";
    const prevCode =
      direction === "in" ? "unknown-prev-in" : "unknown-prev-out";

    if (seen.has(edge)) {
      issues.push({
        code: duplicateCode,
        node: snapshot,
        edge: snapshotDebugGraphEdge(edge, snapshotNode),
        message: "Edge list contains a cycle or a duplicate edge.",
      });
      break;
    }

    seen.add(edge);
    edges.push(edge);

    if ((direction === "in" ? edge.prevIn : edge.prevOut) !== previous) {
      issues.push({
        code: prevCode,
        node: snapshot,
        edge: snapshotDebugGraphEdge(edge, snapshotNode),
        message: "Edge previous pointer does not match list order.",
      });
    }

    if (direction === "in" && edge.to !== node) {
      issues.push({
        code: "mismatched-incoming-target",
        node: snapshot,
        edge: snapshotDebugGraphEdge(edge, snapshotNode),
        message:
          "Incoming edge target does not point back to the inspected node.",
      });
    }

    if (direction === "out" && edge.from !== node) {
      issues.push({
        code: "mismatched-outgoing-source",
        node: snapshot,
        edge: snapshotDebugGraphEdge(edge, snapshotNode),
        message:
          "Outgoing edge source does not point back to the inspected node.",
      });
    }

    previous = edge;
    edge = direction === "in" ? edge.nextIn : edge.nextOut;
  }

  return edges;
}

export function checkDebugGraphIntegrity(
  root: ReactiveNode,
  snapshotNode: (node: ReactiveNode) => RuntimeDebugNodeSnapshot,
): RuntimeDebugGraphIntegrity {
  const graph = snapshotDebugGraph(root, snapshotNode);
  const queue: ReactiveNode[] = [root];
  const seen = new Set<ReactiveNode>();
  const issues: RuntimeDebugGraphIssue[] = [];

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor]!;
    if (seen.has(node)) continue;
    seen.add(node);

    const nodeSnapshot = snapshotNode(node);
    const incoming = collectEdgeListIntegrity(
      node,
      nodeSnapshot,
      "in",
      snapshotNode,
      issues,
    );
    const outgoing = collectEdgeListIntegrity(
      node,
      nodeSnapshot,
      "out",
      snapshotNode,
      issues,
    );

    if (node.lastIn !== (incoming.at(-1) ?? null)) {
      issues.push({
        code: "unknown-last-in",
        node: nodeSnapshot,
        message: "lastIn does not point to the final incoming edge.",
      });
    }

    if (node.lastOut !== (outgoing.at(-1) ?? null)) {
      issues.push({
        code: "unknown-last-out",
        node: nodeSnapshot,
        message: "lastOut does not point to the final outgoing edge.",
      });
    }

    // INV-H: a Computing node's tailIn is its frontier (incoming); an idle
    // node's may also be a hint, one of its own attached outgoing edges.
    const tail = node.tailIn;
    if (
      tail !== null &&
      !incoming.includes(tail) &&
      ((node.state & (Computing | Watcher)) !== 0 ||
        !isOutgoingHint(node, tail) ||
        !outgoing.includes(tail))
    ) {
      issues.push({
        code: "unknown-last-in-tail",
        node: nodeSnapshot,
        edge: snapshotDebugGraphEdge(tail, snapshotNode),
        message:
          "tailIn is neither an incoming edge nor, on an idle node, an attached outgoing hint.",
      });
    }

    for (const edge of incoming) {
      if (outgoingIndex(edge) < 0) {
        issues.push({
          code: "dangling-incoming-edge",
          node: nodeSnapshot,
          edge: snapshotDebugGraphEdge(edge, snapshotNode),
          message: "Incoming edge is absent from its source outgoing list.",
        });
      }
      queue.push(edge.from);
    }

    for (const edge of outgoing) {
      if (incomingIndex(edge) < 0) {
        issues.push({
          code: "dangling-outgoing-edge",
          node: nodeSnapshot,
          edge: snapshotDebugGraphEdge(edge, snapshotNode),
          message: "Outgoing edge is absent from its target incoming list.",
        });
      }
      queue.push(edge.to);
    }
  }

  return {
    ok: issues.length === 0 && graph.nodes.length === seen.size,
    issues,
  };
}
