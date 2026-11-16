import { vi } from "vitest";
import type { Edge, Node } from "../../src/graph";
import { KEEP, TRIM, Flag } from "../../src/graph";
import { checkGraph } from "./graph";
import { auditRetiredEdges, type RetirementPort } from "./history-retirement";

export interface ResearchOptions {
  readonly counterMask?: 3 | 7 | 15;
}
export interface KernelRoots {
  active: Node | null;
  cursor: Edge | null;
  top: number;
  peak: number;
  slots: (Edge | null)[];
}
export interface HostRoots {
  size: number;
  hold: number;
  head: number;
  mask: number;
  spare: number;
  calm: number;
  peakQueued: number;
  slots: (Node | null)[];
}

/** Same source, fresh modules; overrides alter only the finite counter domain. */
export async function loadResearchQuant(options: ResearchOptions = {}) {
  vi.resetModules();
  const nodes: Node[] = [];
  vi.doMock("../../src/graph", async (original) => {
    const graph = await original<typeof import("../../src/graph")>();
    return {
      ...graph,
      ...(options.counterMask === undefined
        ? {}
        : {
            CounterLimit: { Mask: options.counterMask },
            SETTLE: options.counterMask >> 1,
          }),
      createNode(...args: Parameters<typeof graph.createNode>) {
        const node = graph.createNode(...args);
        nodes.push(node);
        return node;
      },
    };
  });
  try {
    const kernel =
      (await import("../../src/kernel")) as typeof import("../../src/kernel") & {
        __historyRoots(): KernelRoots;
      };
    const host =
      (await import("../../src/host")) as typeof import("../../src/host") & {
        __historyRoots(): HostRoots;
      };
    const api = await import("../../src/index");
    const graph =
      (await import("../../src/graph")) as typeof import("../../src/graph") &
        RetirementPort;
    const identities = new WeakMap<Edge, number>();
    let births = 0,
      retired = 0;
    const edgeId = (edge: Edge) => {
      let id = identities.get(edge);
      if (id === undefined) {
        id = ++births;
        identities.set(edge, id);
      }
      return id;
    };
    const capture = () => {
      for (const node of nodes) {
        const seen = new Set<Edge>();
        for (let edge = node.firstDep; edge !== null; edge = edge.nextDep) {
          if (seen.has(edge))
            throw new Error("cyclic research dependency list");
          seen.add(edge);
          edgeId(edge);
        }
      }
    };
    const audit = () => {
      const k = kernel.__historyRoots(),
        h = host.__historyRoots();
      if (
        k.active !== null ||
        k.cursor !== null ||
        k.top !== 0 ||
        k.slots.some((slot) => slot !== null)
      )
        throw new Error("research kernel roots not clear");
      if (
        h.hold !== 0 ||
        h.size !== 0 ||
        h.head !== 0 ||
        h.slots.some((slot) => slot !== null)
      )
        throw new Error("research host roots not clear");
      if (
        k.slots.length > TRIM ||
        h.slots.length > Math.max(KEEP, 2 * h.peakQueued)
      )
        throw new Error("research retained storage bound");
      if (h.mask !== h.slots.length - 1 || (h.slots.length & h.mask) !== 0)
        throw new Error("research ring shape");
      for (const node of nodes)
        if ((node.flags & Flag.Queued) !== 0)
          throw new Error("research stale QUEUED token");
      capture();
      checkGraph(nodes, "research");
      for (const node of nodes)
        if (
          (node.flags & Flag.Watch) !== 0 &&
          node.fn === null &&
          (node.firstDep !== null ||
            node.slot !== null ||
            typeof node.value === "function")
        )
          throw new Error("research disposed watcher retained state");
    };
    return {
      api,
      host,
      kernel,
      graph,
      nodes,
      audit,
      operation<T>(fn: () => T): T {
        graph.__historyBeginRetirement();
        try {
          return fn();
        } finally {
          const records = graph.__historyTakeRetirements();
          for (const record of records)
            if (record.kind === "unlink") edgeId(record.edge);
          retired += auditRetiredEdges(records).edges;
          capture();
        }
      },
      fingerprint() {
        capture();
        const nodeId = (node: Node) => nodes.indexOf(node);
        return {
          nodes: nodes.map((node) => {
            const deps = [],
              subs = [];
            for (let edge = node.firstDep; edge !== null; edge = edge.nextDep)
              deps.push([edgeId(edge), nodeId(edge.from), edge.ver, edge.gen]);
            for (let edge = node.firstSub; edge !== null; edge = edge.nextSub)
              subs.push([edgeId(edge), nodeId(edge.to)]);
            return {
              flags: node.flags,
              ver: node.ver,
              gen: node.gen,
              deps,
              subs,
            };
          }),
          births,
          retired,
          work: { ...kernel.stats },
          kernel: {
            capacity: kernel.__historyRoots().slots.length,
            highWater: kernel.stackHighWater(),
          },
          host: {
            ...host.__historyRoots(),
            slots: host
              .__historyRoots()
              .slots.map((node) => (node === null ? null : nodeId(node))),
          },
          counterMask: options.counterMask ?? 0x3fffffff,
        };
      },
    };
  } finally {
    vi.doUnmock("../../src/graph");
  }
}
export type ResearchQuant = Awaited<ReturnType<typeof loadResearchQuant>>;
