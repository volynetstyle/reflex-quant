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
- [watcher-validation.mjs](watcher-validation.mjs) checks F4, F5 and the D7 validation barrier against the existing runtime.
- [HISTORY.md](HISTORY.md) and [HISTORY.html](HISTORY.html) show benchmark history.
- [versions/](versions/) contains archived intermediate implementations referred to by the design log; these are research artifacts, not the current runtime.

## Watcher validation after failure

```sh
node research/watcher-validation.mjs --strict
node research/watcher-validation.mjs --mode production --strict
```

The runner builds the current sources with release DEV and PROD settings and
research counters compiled out. Its 64 cases cover a one-shot error in
validation, cleanup or body, controls without errors, both source read orders,
an optional sibling watcher, and separate continuations through each source.
Each continuation gets a fresh runtime. JSON Lines record Node and V8 versions,
expected and observed outcomes, mismatched fields, and a final count. A
completed report exits with code 0. `--strict` exits with code 1 on a mismatch.

The original lost-delivery finding assumed that every write into an unvisited
pending sibling must retry a failed watcher validation. F4 preserves an
established execution obligation. The demand-based model explicitly represents
it as `executionPending` and can leave it false when the first source throws.
D7 clarifies automatic delivery after that failure. Pending sibling changes
may coalesce. A later delivered invalidation retries the full committed
frontier with the latest values. The runner checks that causal recovery as
well as the intermediate coalesced state.

The tests in [watcher-validation.test.ts](../test/watcher-validation.test.ts)
check both values of `executionPending` in the independent model, causal
recovery and cutoff through the public API, an obligation surviving repeated
failure, and F1 on explicit computed demand. Test-only representation
assertions check `DIRTY` before and after a thrown validation, including a
change confirmed partway through the check. D7 is valid in both build modes.

### Rejected notification repair

The proposed path from failed validation through `Rewake` and `reopenPush`
reconstructed notification history by traversing dependencies backwards.
It allocated a temporary `Set`, marked pending computeds, and changed the
ordinary push tests. It implemented a stronger retry guarantee than the
contract requires. In the two-branch witness it also made a sibling write
surface the throwing source's error again. That mechanism was rejected.

`research/fault-recovery-candidate` preserves separate experiments for
interrupted deep validation (`Unverified`), version rollover (`EXPIRED`), and
restoring `BUSY` and index slots after stack overflow. Their necessity and
representation require their own contract and structural evidence. The D7
tests and oracle run against `f9be2d0` without those candidate mechanisms.
