import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// Research scripts are executable JS specifications, not production modules.
// @ts-expect-error JS research entry is exercised at runtime by Vitest.
import { productionSource } from "../research/transition-source.mjs";
// @ts-expect-error JS research entry is exercised at runtime by Vitest.
import * as transitionAudit from "../research/transition-audit.mjs";
// @ts-expect-error JS research entry is exercised at runtime by Vitest.
import * as transitionModel from "../research/transition-model.mjs";
const { auditTransitions, makeLedger, effectClosure } = transitionAudit;
const { checkProtocols, protocols, proveFlagStores } = transitionModel;
const ledger = JSON.parse(
  readFileSync(
    new URL("../research/transition-write-ledger.json", import.meta.url),
    "utf8",
  ),
);
const original = (file: string) =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const change = (file: string, from: string, to: string) => {
  const text = original(file);
  expect(text.includes(from)).toBe(true);
  return productionSource({ [file]: text.replace(from, to) });
};

describe("formal ownership transition map", () => {
  it("maps the complete production view and closes all 11 API effect alphabets", () => {
    const report = auditTransitions({ ledger });
    expect(report.counts.publicOperations).toBe(11);
    expect(report.ownershipMap.facts).toHaveLength(17);
    expect(report.ownershipMap.handoffs).toHaveLength(8);
    expect(
      report.ownershipMap.facts.find(
        (f: { fact: string }) => f.fact === "Checking",
      ).production,
    ).toContain("no computed birth");
    expect(report.unknownWrites).toEqual([]);
    expect(
      report.ledger.every(
        (s: { transitions: unknown[] }) => s.transitions.length > 0,
      ),
    ).toBe(true);
    expect(
      report.publicClosure.public.find(
        (p: { name: string }) => p.name === "typeOf",
      ).effects,
    ).toEqual([]);
    expect(
      report.publicClosure.public.find(
        (p: { name: string }) => p.name === "signal",
      ).effects,
    ).toEqual(["node.allocate"]);
    expect(report.claims.allConcretePublicOperationsStateClosureProved).toBe(
      false,
    );
  });
  it("finds a write through a local alias of the persistent queue", () => {
    const source = change(
      "host.ts",
      "  w.flags = flags | Flag.Queued;",
      "  const alias = queue; alias[0] = null;\n  w.flags = flags | Flag.Queued;",
    );
    expect(
      source.writes.some(
        (s: { target: string; base: string }) =>
          s.target === "array.cell" && s.base === "alias",
      ),
    ).toBe(true);
    expect(() => auditTransitions({ source, ledger })).toThrow(
      /requires review|Unmapped store/,
    );
  });
  it("rejects mutating helper calls that bypass assignment syntax", () => {
    const source = change(
      "host.ts",
      "  w.flags = flags | Flag.Queued;",
      "  Object.assign(w, {value: undefined});\n  w.flags = flags | Flag.Queued;",
    );
    expect(() => auditTransitions({ source, ledger })).toThrow(
      /Unclassified source effects/,
    );
    const startup = productionSource({
      "host.ts":
        original("host.ts") +
        "\nconst unused = Object.assign({}, {unsafe: true});\n",
    });
    expect(() => auditTransitions({ source: startup, ledger })).toThrow(
      /Unclassified source effects/,
    );
  });
  it("specializes away diagnostic/statistics writes", () => {
    const source = change(
      "host.ts",
      "  w.flags = flags | Flag.Queued;",
      "  if (__STATS__) w.flags = 0;\n  if (__DEV__) w.flags = 8;\n  w.flags = flags | Flag.Queued;",
    );
    expect(
      source.writes.filter(
        (s: { text: string }) =>
          s.text === "w.flags = 0" || s.text === "w.flags = 8",
      ),
    ).toHaveLength(0);
  });
  it("rejects old F3 even when source pins are deliberately bypassed", () => {
    const source = change(
      "kernel.ts",
      "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy;",
      "n.flags = (n.flags & ~Flag.Pending) | Flag.Busy;",
    );
    expect(() => proveFlagStores(source)).toThrow(/Flag transfer not closed/);
  });
  it("rejects a valid-byte premature extinction of fresh Stale", () => {
    const source = change(
      "kernel.ts",
      "n.flags = f & ~Flag.Busy;",
      "n.flags = f & ~(Flag.Busy | Flag.Stale);",
    );
    expect(() => proveFlagStores(source)).toThrow(/Flag transfer not closed/);
  });
  it("does not reuse pre-callback flags after a failed watcher check", () => {
    const source = change(
      "host.ts",
      "w.flags |= Flag.Stale;",
      "w.flags = flags | Flag.Stale;",
    );
    expect(() => proveFlagStores(source)).toThrow(/Flag transfer not closed/);
  });
  it("requires a review for changed guards even if the store text survives", () => {
    const source = change(
      "host.ts",
      "if ((flags & Flag.AutoQueued) !== Flag.Auto) return;",
      "if ((flags & Flag.AutoQueued) === Flag.Auto) return;",
    );
    expect(() => auditTransitions({ source, ledger })).toThrow(
      /requires review/,
    );
  });
  it("rejects callback insertion inside an atomic slot transaction", () => {
    const source = change(
      "kernel.ts",
      "  const cell = s.slot;",
      "  e.to.fn!();\n  const cell = s.slot;",
    );
    expect(() => effectClosure(source, makeLedger(source))).toThrow(
      /Atomic transaction invokes user code/,
    );
  });
  it("rejects an uncontracted public entry even if it writes nothing", () => {
    const source = productionSource({
      "index.ts":
        original("index.ts") + "\nexport function extraOperation(): void {}\n",
    });
    expect(() => effectClosure(source, makeLedger(source))).toThrow(
      /Public operation lacks/,
    );
  });
  it("checks the dispatch premise behind the indirect wake call", () => {
    const source = change("host.ts", "onWake(wake);", "onWake(() => {});");
    expect(() => effectClosure(source, makeLedger(source))).toThrow(
      /startup-only registration/,
    );
  });
  it("requires constructor birth facts, not merely a valid flags byte", () => {
    const source = change("index.ts", "    Flag.Dirty,", "    0,");
    expect(() =>
      auditTransitions({ source, ledger: makeLedger(source) }),
    ).toThrow(/Factory birth facts/);
  });
  it("rejects an invalid fresh slot even with a newly reviewed ledger", () => {
    const source = change(
      "graph.ts",
      "    slot: null,",
      "    slot: {} as never,",
    );
    expect(() =>
      auditTransitions({ source, ledger: makeLedger(source) }),
    ).toThrow(/Node initialization invariant/);
    const badForwarding = change("graph.ts", "    flags,", "    flags: 8,");
    expect(() =>
      auditTransitions({
        source: badForwarding,
        ledger: makeLedger(badForwarding),
      }),
    ).toThrow(/Node parameter forwarding invariant/);
  });
  it("does not confuse a masked subexpression with a ranged store", () => {
    const source = change(
      "kernel.ts",
      "n.gen = (n.gen + 1) & CounterLimit.Mask;",
      "n.gen = ((n.gen + 1) & CounterLimit.Mask) + 2 ** 31;",
    );
    expect(() =>
      auditTransitions({ source, ledger: makeLedger(source) }),
    ).toThrow(/range-transfer shape/);
  });
  it("separates temporary marker values from real observed versions", () => {
    const source = change(
      "graph.ts",
      "export const UNREAD = -1;",
      "export const UNREAD = 0;",
    );
    expect(() =>
      auditTransitions({ source, ledger: makeLedger(source) }),
    ).toThrow(/marker domains overlap/);
  });
  it("pins compile-time counters even when assignment text is unchanged", () => {
    const source = change("graph.ts", "Mask = 0x3fffffff,", "Mask = 3,");
    expect(() => auditTransitions({ source, ledger })).toThrow(
      /configuration requires review/,
    );
  });
  it("rejects retired-identity and consumed-cleanup resurrection within the carrier", () => {
    const retired = structuredClone(protocols);
    const relation = retired.find((p: { id: string }) => p.id === "relation");
    relation.edges.push({
      from: "retired",
      event: "relation.birth",
      to: "tentative",
    });
    expect(() => checkProtocols(retired)).toThrow(
      /retired identity resurrected/,
    );
    const cleanup = structuredClone(protocols);
    cleanup
      .find((p: { id: string }) => p.id === "cleanup")
      .edges.find((e: { event: string }) => e.event === "cleanup.return").to =
      "slot";
    expect(() => checkProtocols(cleanup)).toThrow(
      /consumed cleanup resurrected/,
    );
  });
});
