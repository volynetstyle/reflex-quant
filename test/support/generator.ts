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

/** Wide, shared readers force nested slot indexes, unlike the small general generator. */
export const slotStackProgramArbitrary: fc.Arbitrary<Op[]> = fc
  .record({ width: fc.integer({ min: 12, max: 32 }), depth: fc.integer({ min: 2, max: 5 }) })
  .chain(({ width, depth }) => fc.tuple(
    fc.shuffledSubarray(Array.from({ length: width }, (_, i) => `p${i}`), { minLength: width, maxLength: width }),
    fc.array(fc.record({
      source: fc.integer({ min: 0, max: width - 1 }),
      value: fc.integer({ min: -5, max: 5 }),
      failure: fc.integer({ min: 0, max: depth }),
      narrow: fc.boolean(),
    }), { minLength: 4, maxLength: 12 }),
  ).map(([order, actions]) => {
    const get = (id: string): Expr => ({ type: "read", id });
    const constant = (value: Value): Expr => ({ type: "constant", value });
    const sequence = (expressions: Expr[]): Expr => expressions.reduce(
      (left, right): Expr => ({ type: "add", left, right }), constant(0),
    );
    const top = `c${depth - 1}`;
    const ops: Op[] = [
      ...Array.from({ length: width }, (_, i): Op => ({ type: "signal", id: `p${i}`, value: i })),
      { type: "signal", id: "tick", value: 0 },
      { type: "signal", id: "failure", value: 0 },
      { type: "signal", id: "narrow", value: false },
    ];
    // More than SCAN subscribers precede every real reader. Reorders must
    // index instead of succeeding through the bounded subscriber scan.
    for (let i = 0; i < 10; i++) ops.push(
      { type: "computed", id: `f${i}`, expression: sequence(order.map(get)) },
      { type: "read", id: `f${i}` },
    );
    for (let level = 0; level < depth; level++) {
      const rotated = [...order.slice(level), ...order.slice(0, level)];
      ops.push({ type: "computed", id: `c${level}`, expression: sequence([
        get("tick"),
        { type: "if", condition: get("narrow"), then: sequence(rotated.slice(0, width >> 1).map(get)), else: {
          type: "if", condition: get("tick"), then: sequence([...rotated].reverse().map(get)), else: sequence(rotated.map(get)),
        } },
        ...(level === 0 ? [] : [get(`c${level - 1}`)]),
        get(rotated[0]!), get(rotated[width >> 1]!), get(rotated[0]!),
        { type: "if", condition: { type: "equal", left: get("failure"), right: constant(level + 1) },
          then: { type: "throw", message: `slot-${level}` }, else: constant(0) },
      ]) });
    }
    ops.push({ type: "effect", id: "w", expression: get(top), cleanup: get(order[0]!) }, { type: "flush" });
    const step = (tick: number, failure: number, narrow: boolean) => ops.push(
      { type: "set", id: "tick", value: tick },
      { type: "set", id: "failure", value: failure },
      { type: "set", id: "narrow", value: narrow },
      { type: "read", id: top }, { type: "flush" },
    );
    step(1, 0, false);
    step(0, 0, false);
    // Fail at each nesting level, then recover; random actions add changes
    // to the frontier while failures are outstanding.
    for (let level = 1; level <= depth; level++) step(level & 1, level, false);
    actions.forEach((a, i) => {
      ops.push({ type: "set", id: `p${a.source}`, value: a.value });
      step(i & 1, a.failure, a.narrow);
    });
    step(1, 0, false);
    ops.push({ type: "dispose", id: "w" }, { type: "set", id: order[0]!, value: 99 }, { type: "read", id: top }, { type: "flush" });
    return ops;
  }));
