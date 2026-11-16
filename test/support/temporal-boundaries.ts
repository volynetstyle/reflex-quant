import {
  ins as i,
  ix as x,
  type IBody,
  type Instruction,
} from "./imperative-language";
import type { ImperativeProgram } from "./imperative-worlds";

export interface BoundaryProgram extends ImperativeProgram {
  readonly family: string;
  readonly facts: readonly string[];
  readonly phase: string;
  readonly indexed?: boolean;
}
const v = x.value,
  r = x.read,
  g = x.register;
const armed = (body: IBody): Instruction => i.when(g("armed"), body);
const once = (body: IBody): Instruction =>
  armed([
    i.when(x.equal(g("done"), v(false)), [i.assign("done", v(true)), ...body]),
  ]);

/** Boundary twins share the perturbation, not an asserted equivalence equation. */
export function boundaryPrograms(): BoundaryProgram[] {
  const programs: BoundaryProgram[] = [];
  for (const phase of [
    "before-dequeue",
    "check",
    "cleanup",
    "before-read",
    "after-read",
    "unwind",
    "after-failure",
  ])
    for (const action of ["write", "dispose-self", "dispose-other"])
      for (const fails of [false, true]) {
        const change =
          action === "write"
            ? i.set("a", v(2))
            : i.dispose(action === "dispose-self" ? "w" : "other");
        const event = once([
          change,
          ...(fails ? [i.assign("failBody", v(true))] : []),
        ]);
        const at = (place: string): Instruction[] =>
          phase === place ? [event] : [];
        const failure = i.when(g("failBody"), [
          i.assign("failBody", v(false)),
          i.fail("body"),
        ]);
        programs.push({
          id: `boundary-deliver-${phase}-${action}-${fails}`,
          family: "deliver",
          phase,
          facts: ["Woken", "Dirty", "Queued", "cleanup", "host", "Busy"],
          auto: true,
          operations: [
            i.signal("a", 0),
            i.signal("kick", 0),
            i.signal("gate", 0),
            i.assign("armed", v(false)),
            i.assign("done", v(false)),
            i.assign("failBody", v(false)),
            i.computed("boom", [i.fail("inner")]),
            i.computed("c", [i.read("gate"), ...at("check"), i.ret(r("gate"))]),
            i.effect("leader", [i.read("kick"), ...at("before-dequeue")]),
            i.effect("other", [i.read("a")]),
            i.effect(
              "w",
              [
                ...at("before-read"),
                i.read("a"),
                i.read("c"),
                i.read("kick"),
                ...at("after-read"),
                ...(phase === "unwind"
                  ? [
                      armed([
                        i.attempt([i.read("boom")], "error", [event, failure]),
                      ]),
                    ]
                  : []),
                failure,
              ],
              [...at("cleanup"), i.log("cleanup", r("a"))],
            ),
            i.assign("armed", v(true)),
            ...(phase === "after-failure" && fails
              ? [i.assign("failBody", v(true))]
              : []),
            i.batch([i.set("gate", v(1)), i.batch([i.set("kick", v(1))])]),
            ...at("after-failure"),
            i.flush(),
            i.set("a", v(2)),
            i.set("a", v(3)),
            i.flush(),
            i.dispose("w"),
            i.dispose("other"),
            i.dispose("leader"),
            i.set("kick", v(2)),
            i.flush(),
          ],
        });
      }

  for (const target of ["w", "root", "middle", "other", "write"])
    for (const fails of [false, true])
      for (const stage of ["validation", "body"]) {
        programs.push({
          id: `boundary-validation-${stage}-${target}-${fails}`,
          family: "validation-lifecycle",
          phase: stage,
          facts: [
            "Stale",
            "Checking",
            "Busy",
            "stack",
            "terminal",
            "retirement",
          ],
          auto: true,
          operations: [
            i.signal("a", 0),
            i.signal("b", 0),
            i.assign("armed", v(false)),
            i.assign("done", v(false)),
            i.computed("leaf", [
              i.read("a"),
              ...(stage === "validation"
                ? [
                    once([
                      target === "write" ? i.set("b", v(1)) : i.dispose(target),
                      ...(fails ? [i.fail("leaf")] : []),
                    ]),
                  ]
                : []),
              i.ret(r("a")),
            ]),
            i.computed("middle", [i.ret(r("leaf"))]),
            i.computed("root", [i.ret(r("middle"))]),
            i.effect("other", [i.read("b")]),
            i.effect(
              "w",
              [
                i.read("root"),
                i.read("b"),
                ...(stage === "body"
                  ? [
                      once([
                        target === "write"
                          ? i.set("b", v(1))
                          : i.dispose(target),
                        ...(fails ? [i.fail("body")] : []),
                      ]),
                    ]
                  : []),
              ],
              [i.log("cleanup", r("b"))],
            ),
            i.assign("armed", v(true)),
            i.set("a", v(1)),
            i.flush(),
            i.set("a", v(2)),
            i.flush(),
            i.set("b", v(2)),
            i.read("root"),
            i.dispose("w"),
            i.dispose("root"),
            i.dispose("middle"),
            i.dispose("other"),
          ],
        });
      }

  for (const auto of [false, true])
    for (const action of [
      "write",
      "dispose-self",
      "nested-watcher",
      "nested-read",
    ])
      for (const fails of [false, true]) {
        const change =
          action === "write"
            ? i.set("a", v(2))
            : action === "dispose-self"
              ? i.dispose("w")
              : action === "nested-watcher"
                ? i.effect(
                    "child",
                    [i.read("a")],
                    [i.log("child-cleanup", r("a"))],
                  )
                : i.read("c");
        programs.push({
          id: `boundary-cleanup-${auto}-${action}-${fails}`,
          family: "cleanup",
          phase: action,
          facts: ["cleanup", "terminal", "Woken", "first-error", "Queued"],
          auto,
          operations: [
            i.signal("a", 0),
            i.assign("armed", v(false)),
            i.assign("done", v(false)),
            i.computed("c", [i.ret(r("a"))]),
            i.effect(
              "w",
              [i.read("a")],
              [once([change, ...(fails ? [i.fail("cleanup")] : [])])],
            ),
            i.flush(),
            i.assign("armed", v(true)),
            i.set("a", v(1)),
            i.flush(),
            i.set("a", v(3)),
            i.flush(),
            i.dispose("w"),
            i.set("a", v(4)),
            i.flush(),
            ...(action === "nested-watcher"
              ? [i.when(x.exists("child"), [i.dispose("child")])]
              : []),
          ],
        });
      }

  for (const depth of [2, 3])
    for (const target of ["none", "outer", "middle", "inner"])
      for (const fails of [false, true]) {
        const width = 40,
          sources = Array.from({ length: width }, (_, n) => `s${n}`);
        const permutation = sources.map((_, n) => sources[(n * 17) % width]!);
        const body = (id: string, child?: string): IBody => {
          const reads = (order: string[]): Instruction[] =>
            order.flatMap((name, n) => [
              i.read(name),
              ...(n === 12 && child
                ? [
                    i.attempt([i.read(child)], "caught", [
                      i.log("caught", g("caught")),
                    ]),
                  ]
                : []),
              ...(n === 10 && id === "inner"
                ? [
                    once([
                      ...(target === "none" ? [] : [i.dispose(target)]),
                      ...(fails ? [i.fail("indexed-inner")] : []),
                    ]),
                  ]
                : []),
            ]);
          return [
            i.read("tick"),
            i.when(r("order"), reads(permutation), reads(sources)),
            i.ret(r("s0")),
          ];
        };
        const setup: Instruction[] = [
          i.signal("tick", 0),
          i.signal("order", 0),
          i.assign("armed", v(false)),
          i.assign("done", v(false)),
          ...sources.map((name, n) => i.signal(name, n)),
        ];
        // Older subscribers exceed pair()'s bounded search and defeat absence proofs.
        for (let n = 0; n < 12; n++)
          setup.push(
            i.computed(
              `guard${n}`,
              sources.map((name) => i.read(name)),
            ),
            i.read(`guard${n}`),
          );
        setup.push(i.computed("inner", body("inner")));
        if (depth === 3)
          setup.push(i.computed("middle", body("middle", "inner")));
        else setup.push(i.computed("middle", [i.ret(v(0))]));
        setup.push(
          i.computed("outer", body("outer", depth === 3 ? "middle" : "inner")),
          i.read("outer"),
        );
        programs.push({
          id: `boundary-index-${depth}-${target}-${fails}`,
          family: "nested-index",
          phase: `${depth}/${target}/${fails}`,
          facts: [
            "slot",
            "stack",
            "Busy",
            "UNREAD",
            "tentative-gen",
            "retirement",
            "terminal",
          ],
          auto: false,
          indexed: true,
          operations: [
            ...setup,
            i.assign("armed", v(true)),
            i.set("order", v(1)),
            i.set("tick", v(1)),
            i.read("outer"),
            i.set("order", v(0)),
            i.set("tick", v(2)),
            i.read("outer"),
            i.read("inner"),
            i.dispose("outer"),
            i.dispose("middle"),
            i.dispose("inner"),
          ],
        });
      }

  for (const shape of ["swap", "stride", "reverse"])
    for (const fails of [false, true]) {
      const sources = Array.from({ length: 12 }, (_, n) => `s${n}`);
      const permuted =
        shape === "swap"
          ? [sources[1]!, sources[0]!, ...sources.slice(2)]
          : shape === "stride"
            ? sources.map((_, n) => sources[(n * 5) % sources.length]!)
            : [...sources].reverse();
      programs.push({
        id: `boundary-markers-${shape}-${fails}`,
        family: "markers",
        phase: shape,
        facts: ["UNREAD", "SKIPPED", "tentative-gen", "Dirty", "retirement"],
        auto: false,
        operations: [
          i.signal("order", 0),
          i.assign("armed", v(false)),
          i.assign("done", v(false)),
          ...sources.map((name, n) => i.signal(name, n)),
          i.computed(
            "guard",
            sources.map((name) => i.read(name)),
          ),
          i.read("guard"),
          i.computed("c", [
            i.when(
              r("order"),
              permuted.flatMap((name, n) => [
                i.read(name),
                ...(n === 2 && fails ? [once([i.fail("marker")])] : []),
              ]),
              sources.map((name) => i.read(name)),
            ),
            i.ret(r("s0")),
          ]),
          i.read("c"),
          i.assign("armed", v(true)),
          i.set("order", v(1)),
          i.read("c"),
          i.read("c"),
          i.set("order", v(0)),
          i.read("c"),
          i.set("s0", v(99)),
          i.read("c"),
          i.dispose("c"),
        ],
      });
    }

  programs.push({
    id: "boundary-first-error-chain",
    family: "first-error",
    phase: "batch-drain-rollback",
    facts: ["first-error", "cleanup", "Queued", "host", "terminal"],
    auto: true,
    operations: [
      i.signal("a", 0),
      i.assign("armed", v(false)),
      i.effect(
        "first",
        [i.read("a"), armed([i.fail("sibling-C")])],
        [armed([i.fail("cleanup-B")])],
      ),
      i.effect("b", [i.read("a"), armed([i.fail("sibling-D")])]),
      i.assign("armed", v(true)),
      i.batch([i.set("a", v(1)), i.batch([i.fail("body-A")])]),
      i.flush(),
      i.dispose("first"),
      i.dispose("b"),
      i.effect("cleanupOwner", [i.read("a")], [i.fail("cleanup-B")]),
      i.effect(
        "rollback",
        [
          i.effect("bodyError", [i.fail("body-A")]),
          i.set("a", v(2)),
          i.effect("siblingError", [i.fail("sibling-C")]),
        ],
        [i.fail("rollback-D")],
      ),
      i.dispose("cleanupOwner"),
      i.dispose("bodyError"),
      i.dispose("siblingError"),
    ],
  });
  const epochs: Instruction[] = [
    i.signal("a", 0),
    i.signal("b", 0),
    i.signal("choose", 0),
    i.signal("failure", 0),
    i.computed("c", [
      i.when(r("failure"), [i.read("b"), i.fail("epoch")]),
      i.when(r("choose"), [i.ret(r("b"))]),
      i.ret(r("a")),
    ]),
    i.effect("w", [i.read("c")]),
  ];
  for (let n = 0; n < 40; n++)
    epochs.push(
      i.set("failure", v(1)),
      i.set("choose", v(n & 1)),
      i.set("failure", v(0)),
      i.set("a", v(n + 1)),
      i.set("b", v(n + 2)),
      i.effect(`neighbour${n}`, [i.read("a")]),
      i.dispose(`neighbour${n}`),
    );
  epochs.push(i.dispose("w"), i.dispose("c"));
  programs.push({
    id: "boundary-epoch-recovery",
    family: "epochs",
    phase: "failure-commit-neighbour",
    facts: ["tentative-gen", "Dirty", "Stale", "retirement"],
    auto: true,
    operations: epochs,
  });
  programs.push({
    id: "boundary-failed-frontier-replacement",
    family: "epochs",
    phase: "failed-attempt-replacement",
    facts: ["tentative-gen", "Dirty", "retirement"],
    auto: false,
    operations: [
      i.signal("a", 0),
      i.signal("b", 0),
      i.signal("d", 0),
      i.signal("e", 0),
      i.signal("failure", 0),
      i.assign("branch", v(0)),
      i.computed("c", [
        i.read("a"),
        i.when(r("failure"), [
          i.when(x.equal(g("branch"), v(0)), [i.read("b")]),
          i.when(x.equal(g("branch"), v(1)), [i.read("d")]),
          i.when(x.equal(g("branch"), v(2)), [i.read("e")]),
          i.fail("frontier"),
        ]),
        i.ret(v(0)),
      ]),
      i.read("c"),
      i.set("failure", v(1)),
      i.read("c"),
      i.assign("branch", v(1)),
      i.read("c"),
      i.assign("branch", v(2)),
      i.read("c"),
      i.set("failure", v(0)),
      i.read("c"),
      i.dispose("c"),
    ],
  });
  programs.push({
    id: "boundary-committed-new-frontier",
    family: "epochs",
    phase: "new-committed-computed-relation",
    facts: ["tentative-gen", "Stale", "Dirty"],
    auto: true,
    operations: [
      i.signal("mode", 0),
      i.signal("a", 0),
      i.signal("b", 0),
      i.computed("ca", [i.ret(r("a"))]),
      i.computed("cb", [i.ret(r("b"))]),
      i.effect("w", [
        i.when(r("mode"), [i.log("value", r("cb"))], [i.log("value", r("ca"))]),
      ]),
      i.set("mode", v(1)),
      i.set("b", v(1)),
      i.set("mode", v(0)),
      i.set("a", v(1)),
      i.dispose("w"),
    ],
  });
  return programs;
}
