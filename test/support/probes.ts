// Phase 0 probes: small programs at the edges of the written contract, where
// the executable spec and current Reflex could part. REPORT.md classifies
// each one.
import { expr as e, op } from "../../../reflex-runtime/test/differential/api";
import type { Program } from "../../../reflex-runtime/test/differential/api";

export const probes: Program[] = [
  {
    // Computed validation quantifier: the first source changed and a later
    // source now throws, but the re-execution no longer reads it.
    id: "P1-validation-quantifier",
    operations: [
      op.signal("p", false),
      op.signal("q", false),
      op.computed("x", e.when(e.read("q"), e.fail("x"), e.value(1))),
      op.computed("c", e.when(e.read("p"), e.value(0), e.read("x"))),
      op.read("c"),
      op.set("q", true),
      op.set("p", true),
      op.read("c"),
    ],
  },
  {
    // A failed computed whose old frontier holds a source that now throws
    // and that its retry does not read (C3: the next demand executes).
    id: "P2-failed-computed-old-frontier",
    operations: [
      op.signal("a", 0),
      op.signal("b", false),
      op.computed("x", e.when(e.read("b"), e.fail("x"), e.value(2))),
      op.computed(
        "c",
        e.when(
          e.greaterThan(e.read("a"), e.value(0)),
          e.when(e.greaterThan(e.read("a"), e.value(1)), e.value(5), e.fail("c")),
          e.read("x"),
        ),
      ),
      op.read("c"),
      op.set("a", 1),
      op.read("c"),
      op.set("b", true),
      op.set("a", 2),
      op.read("c"),
    ],
  },
  {
    // W2/V3: after a failed watcher run that read a new computed, is that
    // computed validated (validation failure, flush-retryable) or only a
    // wake trigger (cold: a plain flush is a no-op)?
    id: "P3-tentative-read-validated",
    operations: [
      op.signal("s", 0),
      op.signal("t", false),
      op.computed("y", e.when(e.read("t"), e.fail("y"), e.value(1))),
      op.watcher(
        "w",
        e.when(e.greaterThan(e.read("s"), e.value(0)), e.add(e.read("y"), e.fail("w")), e.value(0)),
      ),
      op.flush(),
      op.set("s", 1),
      op.flush(),
      op.set("t", true),
      op.flush(),
      op.flush(),
    ],
  },
  {
    // W2: the retry set is committed ∪ the last attempt's reads. A source
    // read only by an earlier failed attempt must not wake the watcher.
    id: "P4-retry-set-of-repeated-failures",
    operations: [
      op.signal("k", 0),
      op.signal("a", 0),
      op.signal("b", 0),
      op.watcher(
        "w",
        e.when(
          e.equal(e.read("k"), e.value(1)),
          e.add(e.read("a"), e.fail("w1")),
          e.when(e.equal(e.read("k"), e.value(2)), e.add(e.read("b"), e.fail("w2")), e.value(0)),
        ),
      ),
      op.flush(),
      op.set("k", 1),
      op.flush(),
      op.set("k", 2),
      op.flush(),
      op.set("a", 5),
      op.flush(),
    ],
  },
  {
    // W3: a committed dependency the failed attempt did not reach still wakes.
    id: "P5-committed-unread-wakes",
    operations: [
      op.signal("p", 0),
      op.signal("q", 0),
      op.watcher("w", e.add(e.when(e.greaterThan(e.read("p"), e.value(0)), e.fail("w"), e.value(0)), e.read("q"))),
      op.flush(),
      op.set("p", 1),
      op.flush(),
      op.flush(),
      op.set("q", 1),
      op.flush(),
    ],
  },
  {
    // Value ABA on a direct source: versions, not values, decide.
    id: "P6-direct-aba",
    operations: [
      op.signal("p", 0),
      op.watcher("w", e.read("p")),
      op.flush(),
      op.set("p", 1),
      op.set("p", 0),
      op.flush(),
    ],
  },
  {
    // Cutoff: an unchanged computed shields its watcher.
    id: "P7-cutoff",
    operations: [
      op.signal("p", 1),
      op.computed("c", e.greaterThan(e.read("p"), e.value(0))),
      op.watcher("w", e.read("c")),
      op.flush(),
      op.set("p", 2),
      op.flush(),
      op.set("p", -1),
      op.flush(),
    ],
  },
  {
    // V3: the first committed dependency changed and a later one throws:
    // validation fails before the cleanup runs (universal watcher barrier).
    id: "P10-watcher-barrier",
    operations: [
      op.signal("p", 0),
      op.signal("q", 0),
      op.computed("c", e.when(e.greaterThan(e.read("q"), e.value(0)), e.fail("c"), e.value(1))),
      op.watcher("w", e.add(e.read("p"), e.read("c")), { cleanup: e.value("cleaned") }),
      op.flush(),
      op.set("p", 1),
      op.set("q", 1),
      op.flush(),
      op.set("q", 0),
      op.flush(),
    ],
  },
  {
    // R2 after a run that had succeeded: the obligation of the failed run
    // survives a wake that arrives only through an unchanged computed.
    id: "P9-obligation-survives-unchanged-wake",
    operations: [
      op.signal("d", 0),
      op.signal("u", 0),
      op.computed("c", e.greaterThan(e.read("u"), e.value(5))),
      op.watcher("w", e.add(e.read("c"), e.when(e.greaterThan(e.read("d"), e.value(0)), e.fail("w"), e.value(0)))),
      op.flush(),
      op.set("d", 1),
      op.flush(),
      op.set("u", 1),
      op.flush(),
      op.flush(),
    ],
  },
  {
    // A cleanup that throws leaves the watcher cold until a change.
    id: "P8-throwing-cleanup",
    operations: [
      op.signal("p", 0),
      op.signal("q", 0),
      op.watcher("w", e.read("p"), { cleanup: e.when(e.greaterThan(e.read("q"), e.value(0)), e.fail("cleanup"), e.value(0)) }),
      op.flush(),
      op.set("q", 1),
      op.set("p", 1),
      op.flush(),
      op.flush(),
      op.set("p", 2),
      op.flush(),
    ],
  },
];
