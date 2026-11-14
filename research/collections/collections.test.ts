import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { effect, dispose, get } from "../../src/index";
import { createCollections } from "./index";
import type { Change, Commit } from "./index";

interface User {
  id: number;
  team: string;
  active: boolean;
  amount: bigint;
}
const row = (id: number, team = "a", amount = BigInt(id)): User => ({
  id,
  team,
  active: true,
  amount,
});
const entries = <K, V>(values: readonly (readonly [K, V])[]) =>
  [...values].sort(([a], [b]) => String(a).localeCompare(String(b)));

describe("local collection contract", () => {
  it("I1 owns and deeply freezes row data and materialized snapshots", () => {
    const c = createCollections();
    const input = { id: 1, nested: { value: 2 }, tags: ["a"] };
    const table = c.table({ key: (r) => r.id, rows: [input] });
    input.nested.value = 99;
    input.tags.push("b");
    expect(table.get(1)).toEqual({ id: 1, nested: { value: 2 }, tags: ["a"] });
    expect(() => Object.assign(table.get(1)!.nested, { value: 4 })).toThrow();
    const snapshot = table.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    table.patch(1, { nested: { value: 3 } });
    expect(snapshot[0]![1].nested.value).toBe(2);
    expect(table.get(1)!.nested.value).toBe(3);
    c.dispose();
  });

  it("rejects exotic, cyclic, accessor and function payloads", () => {
    const c = createCollections();
    for (const value of [new Date(), new Map(), () => 1])
      expect(() => c.table({ key: () => 1, rows: [{ value }] })).toThrow();
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    expect(() => c.table({ key: () => 1, rows: [cyclic] })).toThrow("Cyclic");
    expect(() =>
      c.table({
        key: () => 1,
        rows: [
          {
            get value() {
              return 2;
            },
          },
        ],
      }),
    ).toThrow("Accessors");
    expect(c.stats.quantNodes).toBe(0);
    c.dispose();
  });

  it("I2 maintains unique/multi keys and represents primary-key changes as remove + insert", () => {
    const c = createCollections(),
      table = c.table<number, User>({
        key: (r) => r.id,
        rows: [row(17), row(2, "b")],
      });
    const byId = table.indexBy((r) => r.id, { kind: "unique" });
    const byTeam = table.indexBy((r) => r.team, { kind: "multi" });
    const observed: Commit<Change<number, User>>[] = [];
    table.observeChanges((e) => observed.push(e));
    table.patch(17, { team: "b" });
    expect(byTeam.bucketSize("a")).toBe(0);
    expect(byTeam.bucketSize("b")).toBe(2);
    table.patch(17, { id: 23 });
    expect(table.get(17)).toBeUndefined();
    expect(byId.lookup(17)).toEqual([]);
    expect(byId.lookup(23)[0]!.id).toBe(23);
    expect(
      observed[1]!.changes.map((d) => [d.key, !!d.before, !!d.after]),
    ).toEqual([
      [17, true, false],
      [23, false, true],
    ]);
    expect(() => table.patch(23, { id: 2 })).toThrow("Duplicate");
    expect(table.get(23)!.id).toBe(23);
    c.dispose();
  });

  it("I3/I4 observers and Quant effects see one committed world", () => {
    const c = createCollections(),
      table = c.table<number, User>({ key: (r) => r.id, rows: [row(1)] });
    const active = table.filter((r) => r.active),
      grouped = active.groupBy((r) => r.team);
    const counts = grouped.count(),
      sums = grouped.sumBigInt((r) => r.amount);
    const worlds: unknown[] = [];
    const read = () => [
      table.get(1)!.team,
      grouped.bucketSize("a"),
      grouped.bucketSize("b"),
      counts.get("a"),
      counts.get("b"),
      sums.get("a"),
      sums.get("b"),
    ];
    grouped.observeChanges(() => worlds.push(read()));
    const watcher = effect(() => {
      get(table.revision);
      worlds.push(read());
    });
    worlds.length = 0;
    table.patch(1, { team: "b", amount: 7n });
    expect(worlds).toEqual([
      ["b", 0, 1, undefined, 1, undefined, 7n],
      ["b", 0, 1, undefined, 1, undefined, 7n],
    ]);
    dispose(watcher);
    c.dispose();
  });

  it("reads during maintenance still see committed state", () => {
    const c = createCollections(),
      table = c.table<number, User>({ key: (r) => r.id, rows: [row(1)] });
    const seen: bigint[] = [];
    table.filter((r) => {
      seen.push(table.get(1)!.amount);
      return r.active;
    });
    seen.length = 0;
    table.patch(1, { amount: 9n });
    expect(seen).toEqual([1n]);
    expect(table.get(1)!.amount).toBe(9n);
    c.dispose();
  });

  it("I5 rolls back a late aggregate failure and publishes no scalar or delta", () => {
    const marker = new Error("projection");
    const c = createCollections(),
      table = c.table<number, User>({
        key: (r) => r.id,
        rows: [row(1), row(2)],
      });
    const active = table.filter((r) => r.active),
      groups = active.groupBy((r) => r.team),
      counts = groups.count();
    const sums = groups.sumBigInt((r) => {
      if (r.amount === 999n) throw marker;
      return r.amount;
    });
    let deltas = 0,
      effects = 0;
    table.observeChanges(() => deltas++);
    groups.observeChanges(() => deltas++);
    sums.observeChanges(() => deltas++);
    const watcher = effect(() => {
      get(table.revision);
      counts.get("a");
      sums.get("a");
      effects++;
    });
    const old = table.snapshot(),
      revision = get(table.revision);
    expect(() => table.patch(1, { team: "b", amount: 999n })).toThrow(marker);
    expect(table.snapshot()).toEqual(old);
    expect(get(table.revision)).toBe(revision);
    expect(groups.bucketSize("b")).toBe(0);
    expect(counts.get("a")).toBe(2);
    expect(sums.get("a")).toBe(3n);
    expect(deltas).toBe(0);
    expect(effects).toBe(1);
    table.patch(1, { team: "b", amount: 4n });
    expect(sums.get("b")).toBe(4n);
    dispose(watcher);
    c.dispose();
  });

  it("unique conflicts are atomic, including after other views have staged work", () => {
    const c = createCollections(),
      table = c.table<number, User>({
        key: (r) => r.id,
        rows: [row(1), row(2, "b")],
      });
    const active = table.filter((r) => r.active),
      groups = active.groupBy((r) => r.team),
      counts = groups.count();
    const unique = table.indexBy((r) => r.team, { kind: "unique" });
    expect(() => table.patch(1, { team: "b" })).toThrow("Unique");
    expect(table.get(1)!.team).toBe("a");
    expect(unique.lookup("a")[0]!.id).toBe(1);
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(1);
    expect(get(table.revision)).toBe(0);
    c.dispose();
  });

  it("I6 evaluates a local predicate once for patch/insert and zero times for remove", () => {
    const c = createCollections(),
      table = c.table<number, User>({ key: (r) => r.id, rows: [row(1)] });
    let calls = 0;
    const active = table.filter((r) => {
      calls++;
      return r.active;
    });
    calls = 0;
    table.patch(1, { active: false });
    expect(calls).toBe(1);
    expect(get(active.size)).toBe(0);
    calls = 0;
    table.patch(1, { id: 9, active: true });
    expect(calls).toBe(1);
    expect(active.get(9)!.id).toBe(9);
    calls = 0;
    table.remove(9);
    expect(calls).toBe(0);
    c.dispose();
  });

  it("I7 explicit consumers share one index and evaluate each old/new row key once", () => {
    const c = createCollections(),
      table = c.table<number, User>({
        key: (r) => r.id,
        rows: [row(1), row(2)],
      });
    const grouped = table.groupBy((r) => r.team),
      counts = grouped.count(),
      sums = grouped.sumBigInt((r) => r.amount);
    const events: string[] = [];
    grouped.observeChanges(() => events.push("one"));
    grouped.observeChanges(() => events.push("two"));
    const before = grouped.stats.keyCalls;
    table.patch(1, { team: "b" });
    expect(grouped.stats.builds).toBe(1);
    expect(c.stats.indexesBuilt).toBe(1);
    expect(grouped.stats.keyCalls - before).toBe(2);
    expect(events).toEqual(["one", "two"]);
    expect(counts.get("b")).toBe(1);
    expect(sums.get("b")).toBe(1n);
    c.dispose();
  });

  it("count views compose with filters and indexes without duplicating bucket counts", () => {
    const c = createCollections();
    const table = c.table<number, User>({
      key: (r) => r.id,
      rows: [row(1), row(2)],
    });
    const counts = table.groupBy((r) => r.team).count();
    const large = counts.filter((n) => n > 1);
    const byCount = counts.indexBy((n) => n, { kind: "multi" });
    const events: unknown[] = [];
    counts.observeChanges((event) => events.push(event.changes));
    expect(counts.snapshot()).toEqual([["a", 2]]);
    expect(large.get("a")).toBe(2);
    expect(byCount.lookup(2)).toEqual([2]);
    table.patch(1, { team: "b" });
    expect(counts.snapshot()).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(large.snapshot()).toEqual([]);
    expect(byCount.lookup(2)).toEqual([]);
    expect(byCount.lookup(1)).toEqual([1, 1]);
    expect(events).toEqual([
      [
        { key: "a", before: 2, after: 1 },
        { key: "b", before: undefined, after: 1 },
      ],
    ]);
    table.remove(2);
    expect(counts.get("a")).toBeUndefined();
    expect(byCount.lookup(1)).toEqual([1]);
    c.dispose();
  });

  it("exact bigint sums distinguish an empty group from a nonempty zero sum", () => {
    const c = createCollections(),
      table = c.table<number, User>({
        key: (r) => r.id,
        rows: [row(1, "a", -5n), row(2, "a", 5n)],
      });
    const sums = table.groupBy((r) => r.team).sumBigInt((r) => r.amount);
    expect(sums.get("a")).toBe(0n);
    table.remove(1);
    expect(sums.get("a")).toBe(5n);
    table.remove(2);
    expect(sums.get("a")).toBeUndefined();
    expect(get(sums.size)).toBe(0);
    c.dispose();
  });

  it("post-commit errors do not roll back and retain first-error delivery semantics", () => {
    const c = createCollections(),
      table = c.table<number, User>({ key: (r) => r.id, rows: [row(1)] });
    const first = new Error("delta observer"),
      second = new Error("effect");
    const seen: bigint[] = [];
    let later = 0;
    const off = table.observeChanges(() => {
      throw first;
    });
    table.observeChanges(() => later++);
    const watcher = effect(() => {
      const n = table.get(1)!.amount;
      seen.push(n);
      if (n === 2n) throw second;
    });
    expect(() => table.patch(1, { amount: 2n })).toThrow(first);
    expect(table.get(1)!.amount).toBe(2n);
    expect(seen).toEqual([1n, 2n]);
    expect(later).toBe(1);
    off();
    dispose(watcher);
    table.patch(1, { amount: 3n });
    c.dispose();
  });

  it("rejects reentrant mutation during maintenance and publication", () => {
    const c = createCollections(),
      table = c.table<number, User>({ key: (r) => r.id, rows: [row(1)] });
    table.filter((r) => {
      if (r.amount === 9n) table.remove(1);
      return r.active;
    });
    expect(() => table.patch(1, { amount: 9n })).toThrow("Reentrant");
    expect(table.get(1)!.amount).toBe(1n);
    const off = table.observeChanges(() => table.remove(1));
    expect(() => table.patch(1, { amount: 2n })).toThrow("Reentrant");
    expect(table.get(1)!.amount).toBe(2n);
    off();
    expect(table.remove(1)).toBe(true);
    c.dispose();
  });

  it("I8 adapter node count and local work are independent of row count", () => {
    const observations: unknown[] = [];
    for (const n of [10, 1000]) {
      const c = createCollections(),
        table = c.table<number, User>({
          key: (r) => r.id,
          rows: Array.from({ length: n }, (_, i) => row(i)),
        });
      const active = table.filter((r) => r.active),
        groups = active.groupBy((r) => r.team);
      groups.count();
      groups.sumBigInt((r) => r.amount);
      const before = c.stats;
      table.patch(3, { team: "b", amount: 50n });
      const after = c.stats;
      observations.push([
        after.quantNodes,
        after.predicateCalls - before.predicateCalls,
        after.indexProbes - before.indexProbes,
        after.storeReads - before.storeReads,
        after.stagedWrites - before.stagedWrites,
      ]);
      expect(after.quantNodes).toBe(10);
      c.dispose();
      expect(() => table.get(3)).toThrow("disposed");
    }
    expect(observations[0]).toEqual(observations[1]);
  });

  it("unchanged filtered results do not publish or maintain their descendants", () => {
    const c = createCollections(),
      table = c.table<number, User>({
        key: (r) => r.id,
        rows: [{ ...row(1), active: false }],
      });
    const active = table.filter((r) => r.active),
      groups = active.groupBy((r) => r.team),
      sums = groups.sumBigInt((r) => r.amount);
    let runs = 0;
    const watcher = effect(() => {
      get(active.revision);
      sums.get("a");
      runs++;
    });
    const before = c.stats;
    table.patch(1, { amount: 2n });
    const after = c.stats;
    expect(after.predicateCalls - before.predicateCalls).toBe(1);
    expect(after.keyCalls - before.keyCalls).toBe(1); // Primary key only.
    expect(after.sumCalls - before.sumCalls).toBe(0);
    expect(get(active.revision)).toBe(0);
    expect(get(sums.revision)).toBe(0);
    expect(runs).toBe(1);
    dispose(watcher);
    c.dispose();
  });

  it("throwing undefined during maintenance also rolls everything back", () => {
    const c = createCollections(),
      table = c.table<number, User>({ key: (r) => r.id, rows: [row(1)] });
    const sums = table
      .groupBy((r) => r.team)
      .sumBigInt((r) => {
        if (r.amount === 9n) throw undefined;
        return r.amount;
      });
    let failed = false,
      value: unknown = 1;
    try {
      table.patch(1, { amount: 9n });
    } catch (error) {
      failed = true;
      value = error;
    }
    expect(failed).toBe(true);
    expect(value).toBeUndefined();
    expect(table.get(1)!.amount).toBe(1n);
    expect(sums.get("a")).toBe(1n);
    expect(get(table.revision)).toBe(0);
    c.dispose();
  });

  it("matches full recomputation under insert/remove/patch/key changes", () => {
    const command = fc.record({
      kind: fc.integer({ min: 0, max: 3 }),
      id: fc.integer({ min: 0, max: 15 }),
      nextId: fc.integer({ min: 0, max: 15 }),
      team: fc.integer({ min: 0, max: 3 }),
      active: fc.boolean(),
      amount: fc.integer({ min: -20, max: 20 }),
    });
    fc.assert(
      fc.property(fc.array(command, { maxLength: 40 }), (commands) => {
        const c = createCollections(),
          table = c.table<number, User>({ key: (r) => r.id });
        const active = table.filter((r) => r.active),
          groups = active.groupBy((r) => r.team),
          counts = groups.count(),
          sums = groups.sumBigInt((r) => r.amount);
        const model = new Map<number, User>();
        for (const cmd of commands) {
          if (cmd.kind === 0 && !model.has(cmd.id)) {
            const next = {
              id: cmd.id,
              team: String(cmd.team),
              active: cmd.active,
              amount: BigInt(cmd.amount),
            };
            table.insert(next);
            model.set(cmd.id, next);
          } else if (cmd.kind === 1) {
            expect(table.remove(cmd.id)).toBe(model.delete(cmd.id));
          } else if (model.has(cmd.id)) {
            const nextId = cmd.kind === 3 ? cmd.nextId : cmd.id;
            const next = {
              id: nextId,
              team: String(cmd.team),
              active: cmd.active,
              amount: BigInt(cmd.amount),
            };
            if (nextId !== cmd.id && model.has(nextId))
              expect(() => table.patch(cmd.id, next)).toThrow("Duplicate");
            else {
              table.patch(cmd.id, next);
              model.delete(cmd.id);
              model.set(nextId, next);
            }
          }
          const rows = [...model].filter(([, v]) => v.active),
            totals = new Map<string, bigint>(),
            numbers = new Map<string, number>();
          for (const [, r] of rows) {
            totals.set(r.team, (totals.get(r.team) ?? 0n) + r.amount);
            numbers.set(r.team, (numbers.get(r.team) ?? 0) + 1);
          }
          expect(entries(table.snapshot())).toEqual(entries([...model]));
          expect(entries(active.snapshot())).toEqual(entries(rows));
          expect(entries(counts.snapshot())).toEqual(entries([...numbers]));
          expect(entries(sums.snapshot())).toEqual(entries([...totals]));
          for (const team of ["0", "1", "2", "3"])
            expect(
              groups
                .lookup(team)
                .map((r) => r.id)
                .sort(),
            ).toEqual(
              rows
                .filter(([, r]) => r.team === team)
                .map(([id]) => id)
                .sort(),
            );
        }
        c.dispose();
      }),
      { numRuns: 75, seed: 149021 },
    );
  });
});
