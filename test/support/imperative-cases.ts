import { ins as i, ix as x, type IBody } from "./imperative-language";
import type { ImperativeProgram } from "./imperative-worlds";

const v = x.value,
  r = x.read,
  g = x.register;
export function imperativeCases(): ImperativeProgram[] {
  const p5: IBody = [
    i.assign("once", v(0)),
    i.signal("a", 1),
    i.computed("c", [
      i.read("a"),
      i.when(x.equal(g("once"), v(0)), [
        i.assign("once", v(1)),
        i.set("a", v(2)),
      ]),
      i.ret(r("a")),
    ]),
    i.read("c"),
    i.read("c"),
    i.read("c"),
  ];
  return [
    {
      id: "cleanup-write-before-failed-body-is-not-in-pass-invalidation",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.assign("step", v(0)),
        i.effect(
          "w",
          [
            i.read("a"),
            i.when(x.equal(g("step"), v(1)), [
              i.assign("step", v(2)),
              i.fail("body"),
            ]),
          ],
          [
            i.when(x.equal(g("step"), v(0)), [
              i.assign("step", v(1)),
              i.set("a", v(2)),
            ]),
          ],
        ),
        i.set("a", v(1)),
        i.flush(),
        i.set("a", v(3)),
      ],
    },
    { id: "P5-first-observation-reread", auto: false, operations: p5 },
    {
      id: "W2-self-write-reread",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.effect("w", [
          i.read("a", "seen"),
          i.when(x.less(g("seen"), v(2)), [i.set("a", x.add(g("seen"), v(1)))]),
        ]),
        i.read("a"),
      ],
    },
    {
      id: "W3-self-disposal-cleanup-write",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.effect("w", [i.read("a")], [i.dispose("w"), i.set("a", v(2))]),
        i.set("a", v(1)),
        i.set("a", v(3)),
      ],
    },
    {
      id: "W3-dispose-computed-in-own-body",
      auto: false,
      operations: [
        i.signal("a", 1),
        i.computed("c", [
          i.read("a"),
          i.dispose("c"),
          i.set("a", v(2)),
          i.ret(v(9)),
        ]),
        i.read("c"),
        i.read("c"),
      ],
    },
    {
      id: "nested-watcher-invalidates-parent",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.assign("made", v(false)),
        i.effect("parent", [
          i.read("a"),
          i.when(x.equal(g("made"), v(false)), [
            i.assign("made", v(true)),
            i.effect("child", [
              i.read("a", "childSeen"),
              i.when(x.equal(g("childSeen"), v(0)), [i.set("a", v(1))]),
            ]),
          ]),
        ]),
        i.set("a", v(2)),
      ],
    },
    {
      id: "failed-nested-read-reentry",
      auto: false,
      operations: [
        i.signal("gate", 0),
        i.computed("d", [
          i.when(x.equal(r("gate"), v(1)), [i.fail("d")]),
          i.ret(v(4)),
        ]),
        i.computed("c", [i.ret(x.add(r("d"), v(1)))]),
        i.read("c"),
        i.set("gate", v(1)),
        i.attempt([i.read("c")], "caught"),
        i.set("gate", v(0)),
        i.read("c"),
      ],
    },
    {
      id: "F5-batch-body-first",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.effect("first", [
          i.when(x.equal(r("a"), v(1)), [i.fail("first watcher")]),
        ]),
        i.effect("later", [
          i.log("later", r("a")),
          i.when(x.equal(r("a"), v(1)), [i.fail("later watcher")]),
        ]),
        i.batch([
          i.set("a", v(1)),
          i.batch([i.set("a", v(1))]),
          i.fail("body first"),
        ]),
        i.set("a", v(2)),
      ],
    },
    {
      id: "F5-drain-continues-after-error",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.effect("first", [i.when(x.equal(r("a"), v(1)), [i.fail("first")])]),
        i.effect("second", [
          i.log("second", r("a")),
          i.when(x.equal(r("a"), v(1)), [i.fail("second")]),
        ]),
        i.set("a", v(1)),
        i.set("a", v(2)),
      ],
    },
    {
      id: "W5-failed-effect-rollback",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.attempt(
          [i.effect("failed", [i.read("a"), i.fail("construction")])],
          "constructionError",
        ),
        i.set("a", v(1)),
      ],
    },
    {
      id: "W5-nested-established-child-outlives-parent-rollback",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.attempt(
          [
            i.effect(
              "parent",
              [i.read("a"), i.effect("child", [i.read("a"), i.fail("child")])],
              [i.fail("rollback cleanup")],
            ),
          ],
          "error",
        ),
        i.set("a", v(1)),
      ],
    },
    {
      id: "cleanup-failure-consumed-before-retry",
      auto: true,
      operations: [
        i.signal("a", 0),
        i.assign("throwCleanup", v(true)),
        i.effect(
          "w",
          [i.read("a")],
          [
            i.when(g("throwCleanup"), [
              i.assign("throwCleanup", v(false)),
              i.fail("cleanup"),
            ]),
          ],
        ),
        i.set("a", v(1)),
        i.flush(),
        i.set("a", v(2)),
        i.dispose("w"),
      ],
    },
    {
      id: "C1-reentrant-cycle-excluded",
      auto: true,
      operations: [i.computed("c", [i.ret(r("c"))]), i.read("c")],
    },
  ];
}

export function queueBurst(width = 1024): ImperativeProgram {
  return {
    id: `queue-burst-${width}`,
    auto: true,
    operations: [
      i.signal("large", 0),
      i.signal("small", 0),
      i.effect("smallWatcher", [i.read("small")]),
      i.batch(
        Array.from({ length: width }, (_, n) =>
          i.effect(`w${n}`, [i.read("large")]),
        ),
      ),
      i.set("large", v(1)),
      i.batch(Array.from({ length: width }, (_, n) => i.dispose(`w${n}`))),
      ...Array.from({ length: 2 * width }, (_, n) => i.set("small", v(n + 1))),
    ],
  };
}

/** Bounded overlapping callback actions, not arbitrary JavaScript. */
export function composedCallbackCases(): ImperativeProgram[] {
  const cases: ImperativeProgram[] = [];
  for (const auto of [false, true])
    for (const place of ["computed", "watcher", "cleanup"] as const)
      for (const action of [
        "write-self",
        "write-other",
        "dispose-self",
        "dispose-other",
        "nested-read",
      ] as const)
        for (const fail of [false, true]) {
          const change =
            action === "write-self"
              ? i.set("a", v(1))
              : action === "write-other"
                ? i.set("b", v(1))
                : action === "dispose-self"
                  ? i.dispose("main")
                  : action === "dispose-other"
                    ? i.dispose("other")
                    : i.read("child");
          const perturb = i.when(x.equal(g("once"), v(0)), [
            i.assign("once", v(1)),
            change,
            ...(fail ? [i.fail("attempt")] : []),
          ]);
          const ordinary = [i.ret(x.add(r("a"), r("child")))];
          const body =
            place === "cleanup"
              ? ordinary
              : [i.read("a"), perturb, ...ordinary];
          const create =
            place === "computed"
              ? i.computed("main", body)
              : i.effect(
                  "main",
                  body,
                  place === "cleanup"
                    ? [perturb, i.log("cleanup-a", r("a"))]
                    : [i.log("cleanup-a", r("a"))],
                );
          const demand = place === "computed" ? i.read("main") : i.flush();
          cases.push({
            id: `compose-${auto}-${place}-${action}-${fail}`,
            auto,
            operations: [
              i.signal("a", 0),
              i.signal("b", 0),
              i.assign("once", v(0)),
              i.computed("child", [i.ret(x.add(r("b"), v(1)))]),
              i.read("child"),
              i.effect("other", [i.read("b")]),
              i.batch([create]),
              demand,
              i.set("a", v(2)),
              demand,
              i.set("a", v(3)),
              demand,
              i.set("b", v(2)),
              demand,
              i.dispose("main"),
              i.set("a", v(4)),
              i.flush(),
            ],
          });
        }
  return cases;
}
