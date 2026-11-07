// Program generator for the differential suites. Acyclic by construction:
// computed k reads only producers and earlier computeds. Expressions mix
// conditionals (dynamic dependencies), repeated reads, reordering and
// conditional throws; actions write, read, flush and dispose.
import fc from "fast-check";
import type { Expr, Op, Value } from "../../reference/reflex/test/differential/api";


const values: Value[] = [0, 1, 2, true, false];

const exprOf = (depth: number, readable: string[]): fc.Arbitrary<Expr> => {
  const leaf = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...readable).map((id): Expr => ({ type: "read", id })) },
    { weight: 1, arbitrary: fc.constantFrom(...values).map((value): Expr => ({ type: "constant", value })) },
  );
  if (depth === 0) return leaf;
  const sub = exprOf(depth - 1, readable);
  return fc.oneof(
    { weight: 3, arbitrary: leaf },
    { weight: 2, arbitrary: fc.tuple(sub, sub).map(([left, right]): Expr => ({ type: "add", left, right })) },
    {
      weight: 3,
      arbitrary: fc.tuple(sub, sub, sub).map(([condition, then, otherwise]): Expr => ({ type: "if", condition, then, else: otherwise })),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(sub, fc.constantFrom("e1", "e2")).map(([condition, message]): Expr => ({
        type: "if",
        condition: { type: "greaterThan", left: condition, right: { type: "constant", value: 1 } },
        then: { type: "throw", message },
        else: condition,
      })),
    },
  );
};

export const programArbitrary: fc.Arbitrary<Op[]> = fc
  .record({
    producers: fc.integer({ min: 2, max: 4 }),
    computeds: fc.integer({ min: 1, max: 4 }),
    watchers: fc.integer({ min: 1, max: 3 }),
  })
  .chain(({ producers, computeds, watchers }) => {
    const p = Array.from({ length: producers }, (_, i) => `p${i}`);
    const c = Array.from({ length: computeds }, (_, i) => `c${i}`);
    const w = Array.from({ length: watchers }, (_, i) => `w${i}`);
    const computedExprs = c.map((_, i) => exprOf(2, [...p, ...c.slice(0, i)]));
    const all = [...p, ...c];
    const watcherExprs = w.map(() => exprOf(2, all));
    const cleanups = w.map(() => fc.option(exprOf(1, all), { nil: undefined }));
    const action = fc.oneof(
      { weight: 5, arbitrary: fc.tuple(fc.constantFrom(...p), fc.constantFrom(...values)).map(([id, value]): Op => ({ type: "set", id, value })) },
      { weight: 3, arbitrary: fc.constant<Op>({ type: "flush" }) },
      { weight: 2, arbitrary: fc.constantFrom(...c).map((id): Op => ({ type: "read", id })) },
      { weight: 1, arbitrary: fc.constantFrom(...w).map((id): Op => ({ type: "dispose", id })) },
    );
    return fc
      .tuple(
        fc.tuple(...computedExprs),
        fc.tuple(...watcherExprs),
        fc.tuple(...cleanups),
        fc.tuple(...p.map(() => fc.constantFrom(...values))),
        fc.array(action, { minLength: 4, maxLength: 14 }),
      )
      .map(([ce, we, cl, init, actions]) => {
        const ops: Op[] = [
          ...p.map((id, i): Op => ({ type: "signal", id, value: init[i]! })),
          ...c.map((id, i): Op => ({ type: "computed", id, expression: ce[i]! })),
          ...w.map((id, i): Op => ({ type: "effect", id, expression: we[i]!, ...(cl[i] ? { cleanup: cl[i] } : {}) })),
          { type: "flush" },
        ];
        const disposed = new Set<string>();
        for (const a of actions) {
          if (a.type === "dispose") {
            if (disposed.has(a.id)) continue;
            disposed.add(a.id);
          }
          ops.push(a);
        }
        return ops;
      });
  });
