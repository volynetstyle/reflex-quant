# Research

Reflex Quant is a high-performance, framework-agnostic JavaScript signals
library. These documents explain the contract-driven research behind its
implementation. For current product information and benchmark snapshots, see
the [README](../README.md), [benchmarks](https://volynetstyle.github.io/reflex-quant/benchmarks/)
and [alien-signals comparison](https://volynetstyle.github.io/reflex-quant/alien-signals-comparison/).

- [REPORT.md](REPORT.md) records the mechanism basis, evidence and provenance.
- [LOG.md](LOG.md) records witnesses, design decisions and implementation rationale.
- [COST-MODEL.md](COST-MODEL.md) and [EDGE-CHURN.md](EDGE-CHURN.md) examine costs.
- [ENGINE-FEEDBACK.md](ENGINE-FEEDBACK.md) records V8 guard, deopt and inlining feedback and checked optimization hints.
- [ACCESS-AUDIT.md](ACCESS-AUDIT.md) records object-access reuse, callback boundaries, stable-read budgets and rejected hot-path reshapes.
- [WITNESS-AUDIT.md](WITNESS-AUDIT.md), [mutants.mjs](mutants.mjs) and [mutants.json](mutants.json) record and reproduce ablations.
- [fault-boundaries.mjs](fault-boundaries.mjs) checks whether delivery, stack safety and version observations survive boundary histories.
- [HISTORY.md](HISTORY.md) and [HISTORY.html](HISTORY.html) show benchmark history.
- [versions/](versions/) contains archived intermediate implementations referred to by the design log; these are research artifacts, not the current runtime.

## Fault and representation boundaries

```sh
node research/fault-boundaries.mjs
node research/fault-boundaries.mjs --full-period
node research/fault-boundaries.mjs --mode production --strict
```

The runner builds in-memory ESM bundles with release DEV and PROD settings.
It emits JSON Lines with the Node and V8 versions, the expected and observed
public outcomes for each case, the names of any mismatched fields, and a final
count. An exit code of 0 means the report completed. `--strict` makes any
mismatch exit with code 1. The runner is opt-in while the known cases diverge.

| Contract | Factors and controls |
| --- | --- |
| F4, F5 | No error or a one-shot error during validation, cleanup or body. Vary committed read order and the presence of a second watcher that reads `B`. Replay the batch separately before writing to `A` and to `B`, so recovery in one continuation cannot repair the other. Compare the first error by identity and check the sibling's delivery in the original drain. |
| S7 | Warm chains of 32 and 100,000 computeds. Compare a leaf-only source, a one-shot leaf failure and a shared signal read by every node. Replay the first demand for each continuation: another demand, another write, bottom-up recovery or an independent graph. Record errors from both steps. |
| P1, P5 | Hold one observation across a series of changes. Compare a watcher reading a signal with a computed reading another computed. The default run narrows the shared producer version counter and checks 7, 8 and 9 commits around the shortened period. `--full-period` uses the original runtime and checks exactly `2^30` commits for each source type. |

Use public values, deliveries and error outcomes as the oracle. Internal
flags can explain a mismatch. The deep fixtures measure traversal through a
warmed acyclic graph and collect catchable JavaScript errors. A process exit
or VM abort requires an external observer.

To extend the matrix, name the contract obligation, identify the boundary
that can invalidate the runtime's evidence, and include a matched control.
Rebuild the prefix for every independent continuation. When a narrowed
counter reveals aliasing, confirm the same history with the original counter.

### Repairs and remaining boundary

- **F4 remains open for paths validation never entered.** The `Rewake`
  prototype showed that pending validation and outstanding delivery can
  diverge. It used a backward walk from the watcher, a temporary `Set`, and
  a new push test on every pending computed. That prototype is rejected as
  a runtime mechanism. The unvisited-branch regression remains an expected
  failure in the focused suite and a mismatch in the research runner.
- **P1, P5.** At rollover the producer expires existing version observations
  on its subscriber list. `EXPIRED` compares unequal to every producer version
  and is distinct from both tracking markers. Expiring only observations of
  zero would leave older nonzero versions able to alias later in the cycle.
  The extra pass is linear in live subscribers at rollover. Expiration
  preserves the first-observation obligation on a repeat read.
- **S7.** An interrupted frame with no execution obligation becomes
  `Unverified` during the existing unwind. `pull` validates it and the next
  push passes it, since the flag carries no `STALE` propagation certificate.
  Only frames the validator actually entered can acquire this state. The
  existing push tests and host queue remain the same. A failed body still
  owes execution on demand (D2). The execution frame clears `BUSY` and
  restores the tracking context and index slots in `catch` before calling
  graph cleanup helpers, including when the error is a stack overflow.

### F4 design constraints

The rejected `Rewake` prototype is a counterexample to admitting a mechanism
on the strength of a passing reproducer alone. An error at the host boundary
should not require repairing notification history through the dependency graph
or teaching the normal push to interpret that repair.

- Keeping a failed delivery ready for the next write changes which public
  operation throws. In the two-branch fixture an independent write returns
  normally. Forcing the parked watcher to check on that write raises the
  original left-branch error.
- Continuing validation after the first exception runs a callback on the
  branch the failed delivery would leave untouched. Keeping the first error
  does not undo that callback's effects.
- A forward search across every stale cut while any delivery is stranded
  can keep error attribution exact, but can run on an unrelated graph for as
  long as the original error persists. For `k` writes in one batch to a
  warm chain of depth `d`, repeating the search costs `k·d` edge visits.
  The existing push takes `k + d − 1` on that fixture. At `k = d = 1024`,
  the measured counts were 1,048,576 and 2,047 respectively.

In the witness, the next write to either the stranded branch or a separate
branch stops on a stale computed. The host sees no delivery in either case.
A fix must distinguish those writes through information that the current
push discards or through a different delivery protocol. The rejected
experiments establish that requirement, rather than excluding every protocol.

A chain whose synchronous callbacks recursively enter other `DIRTY` callbacks
can still exhaust the engine’s stack. Pre-running the old frontier would
change D1 and D2: a callback can drop an old dependency whose body now throws,
or perform visible work before reaching that read. The runner keeps those
rows visible, including whether a bottom-up demand and an independent graph
work after the overflow. The focused regression tests are in
[test/fault-boundaries.test.ts](../test/fault-boundaries.test.ts).
