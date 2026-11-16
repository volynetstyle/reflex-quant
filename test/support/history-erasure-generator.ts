import fc from "fast-check";
import {
  expr as e,
  op,
  type Expr,
  type Op,
} from "../../reference/reflex/test/differential/api";
import type { HistoryCase } from "./history-erasure";

export const historyRules = [
  "reorder-inverse",
  "branch-return",
  "computed-recovery",
  "watcher-recovery",
  "disposed-neighbor",
  "settled-aba",
] as const;
type Rule = (typeof historyRules)[number];

interface Parameters {
  width: number;
  depth: number;
  watchers: number;
  bias: number;
  history: readonly Rule[];
  historyA: readonly Rule[];
  actions: readonly {
    target: "a0" | "order" | "branch" | "failure" | "tick";
    value: number;
    demand: boolean;
  }[];
}

const sum = (ids: readonly string[]): Expr =>
  ids.reduce<Expr>((left, id) => e.add(left, e.read(id)), e.value(0));

/** Rules propose convergent histories. Only the independent spec certifies them. */
export function historyCase(parameters: Partial<Parameters> = {}): HistoryCase {
  const {
    width = 16,
    depth = 2,
    watchers = 2,
    bias = 0,
    history = historyRules,
    historyA = [],
    actions = [],
  } = parameters;
  const forward = Array.from({ length: width }, (_, i) => `a${i}`);
  const alternate = Array.from({ length: width }, (_, i) => `b${i}`);
  const handles = [
    "order",
    "branch",
    "failure",
    "tick",
    ...forward,
    ...alternate,
    "c",
  ];
  const prefix: Op[] = [
    ...["order", "branch", "failure", "tick"].map((id) => op.signal(id, 0)),
    ...forward.map((id, i) => op.signal(id, bias + i + 1)),
    ...alternate.map((id, i) => op.signal(id, bias + (i + 1) * 3)),
    op.computed(
      "c",
      e.add(
        e.read("tick"),
        e.when(
          e.equal(e.read("failure"), e.value(1)),
          e.add(sum(alternate), e.fail("computed attempt")),
          e.when(
            e.read("branch"),
            sum(alternate),
            e.when(e.read("order"), sum([...forward].reverse()), sum(forward)),
          ),
        ),
      ),
    ),
  ];
  let outer = "c";
  for (let i = 0; i < depth; i++) {
    const id = `c${i}`;
    handles.push(id);
    prefix.push(op.computed(id, e.add(e.read(outer), e.value(1))));
    outer = id;
  }
  const effects = Array.from({ length: watchers }, (_, i) => `w${i}`);
  for (const id of effects) {
    handles.push(id);
    prefix.push(
      op.watcher(
        id,
        e.when(
          e.equal(e.read("failure"), e.value(2)),
          e.add(sum(alternate), e.fail("watcher attempt")),
          e.add(e.read("a0"), e.read(outer)),
        ),
        { cleanup: e.read("a0") },
      ),
    );
  }
  prefix.push(op.read(outer), op.flush());
  const expand = (rules: readonly Rule[]): Op[] => {
    const churn: Op[] = [];
    rules.forEach((rule, index) => {
      if (rule === "disposed-neighbor") {
        const id = `private${index}`;
        churn.push(
          op.watcher(id, e.add(e.read(outer), sum(forward)), {
            cleanup: e.read("a0"),
          }),
          op.flush(),
          op.dispose(id),
        );
      } else if (rule === "settled-aba") {
        churn.push(
          op.set("a0", bias + 100),
          op.set("a0", bias + 1),
          op.read(outer),
          op.flush(),
        );
      } else {
        const target =
          rule === "reorder-inverse"
            ? "order"
            : rule === "branch-return"
              ? "branch"
              : "failure";
        const value = rule === "watcher-recovery" ? 2 : 1;
        churn.push(
          op.set(target, value),
          op.read(outer),
          op.flush(),
          op.set(target, 0),
          op.read(outer),
          op.flush(),
        );
      }
    });
    return churn;
  };
  const suffix: Op[] = [
    op.read(outer),
    op.read(outer),
    op.set("order", 1),
    op.read(outer),
    op.set("order", 0),
    op.read(outer),
  ];
  for (const action of actions) {
    suffix.push(
      op.set(action.target, action.value),
      action.demand ? op.read(outer) : op.flush(),
    );
  }
  suffix.push(
    op.set("failure", 0),
    op.set("branch", 0),
    op.set("order", 0),
    op.read(outer),
    op.flush(),
  );
  const stable = suffix.length;
  suffix.push(
    op.read(outer),
    ...effects.map((id) => op.dispose(id)),
    op.set("a0", bias - 1),
    op.read(outer),
    op.flush(),
  );
  return {
    id: `history-${width}-${depth}-${watchers}-${bias}-A:${historyA.join("+")}-B:${history.join("+")}`,
    rule: [...new Set([...historyA, ...history])].join(" + "),
    histories: { a: historyA, b: history },
    handles,
    prefixA: [...prefix, ...expand(historyA)],
    prefixB: [...prefix, ...expand(history)],
    suffix,
    bounds: [
      ...[0, 1, stable].map((at) => ({
        at,
        max: { links: 0, lookups: 0, runs: 0 },
      })),
      ...[3, 5].map((at) => ({ at, max: { links: 0 } })),
    ],
  };
}

const historyParametersArbitrary = fc.record({
  width: fc.integer({ min: 1, max: 48 }),
  depth: fc.integer({ min: 0, max: 3 }),
  watchers: fc.integer({ min: 1, max: 3 }),
  bias: fc.integer({ min: -5, max: 5 }),
  history: fc.array(fc.constantFrom(...historyRules), {
    minLength: 1,
    maxLength: 12,
  }),
  actions: fc.array(
    fc.record({
      target: fc.constantFrom(
        "a0" as const,
        "order" as const,
        "branch" as const,
        "failure" as const,
        "tick" as const,
      ),
      value: fc.integer({ min: 0, max: 2 }),
      demand: fc.boolean(),
    }),
    { maxLength: 16 },
  ),
});

export const historyCaseArbitrary: fc.Arbitrary<HistoryCase> =
  historyParametersArbitrary.map(historyCase);

export const symmetricHistoryCaseArbitrary: fc.Arbitrary<HistoryCase> = fc
  .tuple(
    historyParametersArbitrary,
    fc.array(fc.constantFrom(...historyRules), { minLength: 1, maxLength: 12 }),
  )
  .map(([parameters, historyA]) => historyCase({ ...parameters, historyA }));
