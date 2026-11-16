import { describe, expect, it } from "vitest";
import { expr as e, op } from "../reference/reflex/test/differential/api";
import type { Edge } from "../src/graph";
import {
  createHistoryQuantWorld,
  runHistoryCase,
  type QuantWorld,
} from "./support/history-erasure";
import { historyCase } from "./support/history-erasure-generator";
import {
  auditRetiredEdges,
  type RetirementPort,
  type RetirementRecord,
} from "./support/history-retirement";

const graphPort = async () =>
  (await import("../src/graph")) as typeof import("../src/graph") &
    RetirementPort;

const watchers = async () => {
  const world = await createHistoryQuantWorld();
  for (const operation of [
    op.signal("s", 0),
    op.watcher("survivor", e.read("s")),
    op.watcher("retired", e.read("s")),
    op.flush(),
  ])
    world.execute(operation);
  return world;
};

describe("operation-scoped retirement integrity", () => {
  it("checks legal interior chains and drops the whole registry after each operation", async () => {
    const world = await createHistoryQuantWorld();
    const graph = await graphPort();
    for (const operation of [
      op.signal("branch", 0),
      op.signal("a", 1),
      op.signal("b", 2),
      op.signal("c", 3),
      op.computed(
        "value",
        e.when(
          e.read("branch"),
          e.value(0),
          e.add(e.read("a"), e.add(e.read("b"), e.read("c"))),
        ),
      ),
      op.read("value"),
    ])
      world.execute(operation);
    world.execute(op.set("branch", 1));
    world.execute(op.read("value"));
    const counts = world.audit().retirement!;
    expect(counts.cutRuns).toBe(1);
    expect(counts.cutEdges).toBe(3);
    expect(counts.singleEdges).toBe(0);
    expect(graph.__historyRetirementState()).toEqual({
      active: false,
      records: 0,
    });
  });

  it("observes tentative-edge pruning in fail, including operations which throw", async () => {
    const world = await createHistoryQuantWorld();
    const graph = await graphPort();
    for (const operation of [
      op.signal("mode", 0),
      op.signal("a", 1),
      op.signal("b", 2),
      op.signal("c", 3),
      op.computed(
        "value",
        e.when(
          e.equal(e.read("mode"), e.value(0)),
          e.read("a"),
          e.add(
            e.when(
              e.equal(e.read("mode"), e.value(1)),
              e.read("b"),
              e.read("c"),
            ),
            e.fail("attempt"),
          ),
        ),
      ),
      op.read("value"),
    ])
      world.execute(operation);
    world.execute(op.set("mode", 1));
    expect(world.execute(op.read("value")).error?.message).toBe("attempt");
    world.execute(op.set("mode", 2));
    expect(world.execute(op.read("value")).error?.message).toBe("attempt");
    expect(world.audit().retirement!.singleEdges).toBe(1);
    expect(graph.__historyRetirementState()).toEqual({
      active: false,
      records: 0,
    });
    world.audit();
  });

  it("releases records after disposal cleanup throws", async () => {
    const world = await createHistoryQuantWorld();
    for (const operation of [
      op.signal("s", 0),
      op.watcher("w", e.read("s"), { cleanup: e.fail("cleanup") }),
      op.flush(),
    ])
      world.execute(operation);
    expect(world.execute(op.dispose("w")).error?.message).toBe("cleanup");
    expect(world.audit().retirement!.edges).toBe(1);
    expect((await graphPort()).__historyRetirementState()).toEqual({
      active: false,
      records: 0,
    });
  });

  it("sees an orphan's stale pointer which the retained-root oracle cannot reach", async () => {
    const world = await watchers();
    const graph = await graphPort();
    const host = await import("../src/host");
    const retired = world.nodes.get("retired")!.node.firstDep!;
    const live = world.nodes.get("survivor")!.node.firstDep!;
    // Capture a real removal without the world's automatic drain, then simulate
    // the old forgotten nextSub store before auditing its retirement records.
    graph.__historyBeginRetirement();
    host.stop(world.nodes.get("retired")!.node);
    const records = graph.__historyTakeRetirements();
    retired.nextSub = live;
    expect(world.audit().reachableEdges).toBe(1);
    expect(() => auditRetiredEdges(records)).toThrow(
      "retired subscriber retains a neighbour",
    );
    expect(records).toHaveLength(0);
    expect(graph.__historyRetirementState()).toEqual({
      active: false,
      records: 0,
    });
    retired.nextSub = null;
  });

  it("rejects cross-run dependency pointers even when both targets are retired", async () => {
    const world = await watchers();
    const graph = await graphPort();
    const host = await import("../src/host");
    const a = world.nodes.get("retired")!.node.firstDep!;
    const b = world.nodes.get("survivor")!.node.firstDep!;
    graph.__historyBeginRetirement();
    host.stop(world.nodes.get("retired")!.node);
    host.stop(world.nodes.get("survivor")!.node);
    const records = graph.__historyTakeRetirements();
    const runs = records.filter((record) => record.kind === "cut");
    a.nextDep = b;
    expect(world.audit().reachableEdges).toBe(0);
    expect(() => auditRetiredEdges(records)).toThrow(
      "outside its own retired run",
    );
    expect(records).toHaveLength(0);
    expect(runs.every((record) => record.edges.length === 0)).toBe(true);
    a.nextDep = null;
  });

  it("requires individually pruned identities to clear both dependency neighbours", async () => {
    const world = await watchers();
    const retired = world.nodes.get("retired")!.node.firstDep!;
    const live = world.nodes.get("survivor")!.node.firstDep!;
    world.execute(op.dispose("retired"));
    retired.prevDep = live;
    const records: RetirementRecord[] = [{ kind: "unlink", edge: retired }];
    expect(() => auditRetiredEdges(records)).toThrow(
      "individually retired dependency retains a neighbour",
    );
    expect(records).toHaveLength(0);
    retired.prevDep = null;
  });

  it("turns a retirement-witness failure into the structural verdict", async () => {
    const test = historyCase({ width: 1, history: ["disposed-neighbor"] });
    const factory = async (): Promise<QuantWorld> => {
      const world = await createHistoryQuantWorld();
      let old: Edge | null = null;
      return {
        ...world,
        execute(operation) {
          if (operation.type === "dispose" && operation.id === "private0")
            old = world.nodes.get("private0")!.node.firstDep;
          const observation = world.execute(operation);
          if (old !== null) {
            old.nextSub = world.nodes.get("a0")!.node.firstSub;
            auditRetiredEdges([{ kind: "unlink", edge: old }]);
          }
          return observation;
        },
      };
    };
    const result = await runHistoryCase(test, factory);
    expect(result.kind).toBe("structure");
    expect(result.message).toContain("retirement integrity");
  });
});
