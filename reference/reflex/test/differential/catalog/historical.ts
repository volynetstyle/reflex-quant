import type { Op } from "../api";
import { expr, op } from "../api";

export interface HistoricalFault {
  id: string;
  faultClass: string;
  fixedBy: string;
  discoveredBy: string;
  program: readonly Op[];
}

const { signal, computed, watcher, read, set, flush } = op;

export const historicalFaults: readonly HistoricalFault[] = [
  {
    id: "validation-history-dependence",
    faultClass: "exception atomicity / pull validation",
    fixedBy: "79dace5",
    discoveredBy: "stateful differential fuzzing",
    program: [
      signal("p0", -Infinity),
      signal("p1", -Infinity),
      signal("p2", false),
      computed(
        "c0",
        expr.when(
          expr.read("p2"),
          expr.add(expr.read("p1"), expr.fail("generated failure")),
          expr.read("p0"),
        ),
      ),
      watcher("w0", expr.read("c0")),
      flush(),
      set("p0", Infinity),
      read("c0"),
      set("p2", true),
      flush(),
      flush(),
    ],
  },
  {
    id: "lost-unknown-to-changed-promotion",
    faultClass: "invalidation lattice / state promotion",
    fixedBy: "79dace5",
    discoveredBy: "stateful differential fuzzing",
    program: [
      signal("p0", -Infinity),
      signal("p1", -Infinity),
      signal("p2", -Infinity),
      computed("c0", expr.add(expr.read("p0"), expr.read("p1"))),
      watcher("w0", expr.read("c0")),
      watcher("w1", expr.read("p2"), { cleanup: expr.read("p1") }),
      watcher(
        "w2",
        expr.when(expr.read("p2"), expr.read("c0"), expr.read("p0")),
      ),
      flush(),
      set("p0", 0),
      set("p2", false),
      flush(),
    ],
  },
  {
    id: "lost-watcher-invalidation-after-validation-recovery",
    faultClass: "watcher retry / cross-dependency invalidation",
    fixedBy: "8c56acc",
    discoveredBy: "causal action permutation differential exploration",
    program: [
      signal("changeSource", false),
      signal("failGate", false),
      computed("changed", expr.read("changeSource")),
      computed(
        "failing",
        expr.when(
          expr.read("failGate"),
          expr.fail("dependency failure"),
          expr.value(false),
        ),
      ),
      watcher(
        "watcher",
        expr.equal(expr.read("failing"), expr.read("changed")),
      ),
      flush(),
      set("failGate", true),
      set("changeSource", true),
      read("changed"),
      flush(),
      set("failGate", false),
      flush(),
    ],
  },
  {
    id: "cleanup-before-validation-completes",
    faultClass: "watcher lifecycle / dependency validation",
    fixedBy: "8c56acc",
    discoveredBy: "bounded failure-recovery continuation generation",
    program: [
      signal("condition", false),
      signal("fallback", false),
      computed(
        "computed",
        expr.when(
          expr.read("condition"),
          expr.fail("bounded failure"),
          expr.read("fallback"),
        ),
      ),
      watcher("watcher", expr.read("computed"), {
        cleanup: expr.read("condition"),
      }),
      flush(),
      set("fallback", true),
      read("computed"),
      set("condition", true),
      flush(),
    ],
  },
];
