import { ins as i, ix as x, type Instruction } from "./imperative-language";
import { boundaryPrograms, type BoundaryProgram } from "./temporal-boundaries";

export interface HandoffProgram extends BoundaryProgram {
  readonly workBound?: { width: number; indexed: number };
  readonly relationIdentity?: {
    source: string;
    consumer: string;
    before: number;
    after: number;
  };
}
const v = x.value,
  r = x.read,
  g = x.register;

export function handoffPrograms(): HandoffProgram[] {
  const out: HandoffProgram[] = [];
  for (const entry of [
    "manual",
    "scheduled",
    "nested-start",
    "failure-recovery",
  ])
    for (const outcome of ["success", "failure", "dispose"])
      for (const place of ["cleanup", "body"]) {
        const change = i.when(x.equal(g("once"), v(false)), [
          i.assign("once", v(true)),
          i.set("a", v(2)),
        ]);
        const perturb = i.when(g("armed"), [
          change,
          ...(outcome === "dispose" ? [i.dispose("w")] : []),
          ...(outcome === "failure"
            ? [
                i.when(x.equal(g("failed"), v(false)), [
                  i.assign("failed", v(true)),
                  i.fail("attempt"),
                ]),
              ]
            : []),
        ]);
        const create = i.epochEffect(
          "w",
          [
            i.read("a"),
            ...(place === "body" ? [perturb] : []),
            i.log("body-value", r("a")),
          ],
          place === "cleanup" ? [perturb] : [],
        );
        const operations: Instruction[] = [
          i.signal("a", 0),
          i.assign("armed", v(false)),
          i.assign("once", v(false)),
          i.assign("failed", v(false)),
        ];
        if (entry === "nested-start") {
          operations.push(i.epochEffect("launcher", [create]));
        } else operations.push(create);
        operations.push(
          i.flush(),
          i.assign("armed", v(true)),
          i.set("a", v(1)),
        );
        if (entry === "manual") operations.push(i.run("w"));
        else operations.push(i.flush());
        if (entry === "failure-recovery")
          operations.push(i.set("a", v(3)), i.flush());
        operations.push(
          i.set("a", v(4)),
          i.flush(),
          i.dispose("w"),
          i.set("a", v(5)),
          i.flush(),
        );
        if (entry === "nested-start") operations.push(i.dispose("launcher"));
        out.push({
          id: `handoff-attempt-${entry}-${outcome}-${place}`,
          family: "handoff-attempt",
          phase: `${entry}/${outcome}/${place}`,
          facts: ["Woken", "Stale", "Dirty", "Busy", "Queued", "cleanup"],
          auto: entry !== "manual",
          operations,
        });
      }
  // One watcher requeues itself after dequeue; its former token cannot steal
  // the new entry's permission, including after a throw or sibling disposal.
  for (const outcome of [
    "success",
    "failure",
    "dispose-sibling",
    "dispose-self",
  ]) {
    out.push({
      id: `handoff-queue-${outcome}`,
      family: "handoff-queue",
      phase: outcome,
      facts: ["Queued", "Busy", "Stale", "Dirty"],
      auto: true,
      operations: [
        i.signal("a", 0),
        i.assign("armed", v(false)),
        i.assign("once", v(false)),
        i.epochEffect("w", [
          i.read("a"),
          i.when(g("armed"), [
            i.when(x.equal(g("once"), v(false)), [
              i.assign("once", v(true)),
              i.set("a", v(2)),
              ...(outcome === "dispose-sibling"
                ? [i.dispose("sibling")]
                : outcome === "dispose-self"
                  ? [i.dispose("w")]
                  : []),
              ...(outcome === "failure" ? [i.fail("queued-body")] : []),
            ]),
          ]),
        ]),
        i.epochEffect("sibling", [i.read("a")]),
        i.assign("armed", v(true)),
        i.batch([i.set("a", v(1))]),
        i.flush(),
        i.set("a", v(3)),
        i.flush(),
        i.dispose("w"),
        i.dispose("sibling"),
      ],
    });
  }
  // The cleanup closure captures the successful attempt's ordinal. A failed
  // replacement attempt has no cleanup to publish and cannot resurrect epoch 1.
  for (const failedPhase of ["body", "cleanup"])
    out.push({
      id: `handoff-cleanup-epochs-${failedPhase}`,
      family: "handoff-cleanup",
      phase: failedPhase,
      facts: ["cleanup", "Dirty", "Woken"],
      auto: true,
      operations: [
        i.signal("a", 0),
        i.assign("fail", v(false)),
        i.epochEffect(
          "w",
          [
            i.read("a"),
            ...(failedPhase === "body"
              ? [i.when(g("fail"), [i.fail("body")])]
              : []),
          ],
          failedPhase === "cleanup"
            ? [i.when(g("fail"), [i.fail("cleanup")])]
            : [],
        ),
        i.assign("fail", v(true)),
        i.set("a", v(1)),
        i.assign("fail", v(false)),
        i.set("a", v(2)),
        i.dispose("w"),
      ],
    });
  // Woken is live on a watcher while nested validation owns Checking on other
  // nodes. Roles are immutable; no node is converted between the two kinds.
  for (const outcome of ["success", "failure", "dispose-root"])
    out.push({
      id: `handoff-alias-${outcome}`,
      family: "handoff-alias",
      phase: outcome,
      facts: ["Woken", "Checking", "cleanup", "scope"],
      auto: true,
      operations: [
        i.signal("a", 0),
        i.signal("b", 0),
        i.assign("armed", v(false)),
        i.assign("once", v(false)),
        i.computed("leaf", [
          i.read("b"),
          i.when(g("armed"), [
            i.when(x.equal(g("once"), v(false)), [
              i.assign("once", v(true)),
              ...(outcome === "dispose-root" ? [i.dispose("root")] : []),
              ...(outcome === "failure" ? [i.fail("alias-leaf")] : []),
            ]),
          ]),
          i.ret(v(0)),
        ]),
        i.computed("root", [i.ret(r("leaf"))]),
        i.read("root"),
        i.epochEffect("w", [i.read("a")], [i.set("a", v(2)), i.read("root")]),
        i.assign("armed", v(true)),
        i.set("b", v(1)),
        i.set("a", v(1)),
        i.set("a", v(3)),
        i.dispose("w"),
        i.read("root"),
      ],
    });
  for (const auto of [false, true]) {
    const operations: Instruction[] = [
      i.signal("a", 0),
      i.signal("b", 0),
      i.signal("failure", 0),
      i.computed("c", [
        i.read("a"),
        i.read("b"),
        i.when(r("failure"), [i.fail("tentative")]),
        i.ret(r("b")),
      ]),
      i.set("failure", v(1)),
      i.read("c"),
    ];
    const before = operations.length - 1;
    operations.push(i.set("failure", v(0)), i.read("c"));
    const after = operations.length - 1;
    operations.push(i.epochEffect("w", [i.read("c")]), i.flush());
    for (let n = 0; n < 20; n++)
      operations.push(i.set("b", v(n + 1)), i.flush());
    operations.push(i.dispose("w"), i.dispose("c"));
    out.push({
      id: `handoff-relation-${auto}`,
      family: "handoff-relation",
      phase: String(auto),
      facts: ["tentative-gen", "Dirty"],
      auto,
      operations,
      relationIdentity: { source: "b", consumer: "c", before, after },
    });
  }
  // Reuse the natural overlapping-index witnesses; the native probe certifies
  // simultaneous owners and displacement, and the new mutations attack transfer.
  for (const p of boundaryPrograms().filter(
    (p) =>
      p.family === "nested-index" ||
      p.family === "first-error" ||
      p.family === "epochs",
  ))
    out.push({ ...p, id: `handoff-${p.id}`, family: `handoff-${p.family}` });
  out.push({
    id: "handoff-debt-cutoff",
    family: "handoff-debt",
    phase: "failed-debt-versus-new-clean",
    facts: ["Dirty", "Stale", "Busy"],
    auto: true,
    operations: [
      i.signal("a", 0),
      i.signal("direct", 0),
      i.assign("fail", v(false)),
      i.computed("c", [i.ret(x.less(r("a"), v(5)))]),
      i.epochEffect("w", [
        i.read("c"),
        i.read("direct"),
        i.when(g("fail"), [i.fail("debt")]),
      ]),
      i.assign("fail", v(true)),
      i.set("direct", v(1)),
      i.assign("fail", v(false)),
      i.set("a", v(1)),
      i.set("a", v(2)),
      i.dispose("w"),
    ],
  });
  out.push({
    id: "handoff-alias-cold-manual-reentry",
    family: "handoff-alias-reentry",
    phase: "cutoff-then-manual-demand",
    facts: ["Woken", "Checking", "Stale"],
    auto: false,
    operations: [
      i.signal("a", 0),
      i.computed("c", [i.ret(x.less(r("a"), v(5)))]),
      i.epochEffect("w", [i.read("c")]),
      i.flush(),
      i.set("a", v(1)),
      i.flush(),
      i.flush(),
      i.run("w"),
      i.dispose("w"),
    ],
  });
  // Each child has constant degree; only one overlaps the parent's current
  // cursor. Untracked demand preserves that cursor across the nested return.
  // Losing its displaced cell forces a full O(width) parent rebuild per child.
  for (const width of [32, 64, 128]) {
    const sources = Array.from({ length: width }, (_, n) => `s${n}`),
      base = Array.from({ length: 24 }, (_, n) => `b${n}`);
    const operations: Instruction[] = [
      i.signal("order", 0),
      ...sources.map((name) => i.signal(name, 1)),
      ...base.map((name) => i.signal(name, 1)),
    ];
    for (let n = 0; n < 12; n++)
      operations.push(
        i.computed(
          `guard${n}`,
          [...sources, ...base].map((name) => i.read(name)),
        ),
        i.read(`guard${n}`),
      );
    for (let n = 0; n < width; n++)
      operations.push(
        i.computed(`child${n}`, [
          i.when(
            r("order"),
            [base[16]!, sources[n]!, ...base.filter((_, j) => j !== 16)].map(
              (name) => i.read(name),
            ),
            [sources[n]!, ...base].map((name) => i.read(name)),
          ),
          i.ret(v(1)),
        ]),
        i.read(`child${n}`),
      );
    const reads = (order: number[]): Instruction[] =>
      order.flatMap((n) => [
        i.read(sources[n]!),
        i.untracked([i.read(`child${n}`)]),
      ]);
    operations.push(
      i.computed("outer", [
        i.when(
          r("order"),
          reads(sources.map((_, n) => (n * 17) % width)),
          reads(sources.map((_, n) => n)),
        ),
        i.ret(v(1)),
      ]),
      i.read("outer"),
      i.set("order", v(1)),
      i.read("outer"),
      i.dispose("outer"),
    );
    out.push({
      id: `handoff-slot-work-${width}`,
      family: "handoff-slot-work",
      phase: String(width),
      facts: ["slot", "stack"],
      auto: false,
      operations,
      workBound: { width, indexed: 48 * width + 128 },
    });
  }
  return out;
}
