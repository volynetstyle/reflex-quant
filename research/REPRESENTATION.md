# Same machine, different compiled representation

This experiment asks whether a specific representation of Quant's existing
contract improves code emitted by a specified V8 version on specified workloads.
It does not claim a universal JIT optimum or change the minimal-mechanism basis.
The semantic contract, graph fields, public API and graph allocation sites are fixed.
Helpers add module-level declarations only, with no per-operation closures.
All candidates are independent isolated copies. Failed or unrepeatable candidates
remain research evidence and are not applied to the production sources.

## First pass

| Candidate       | Shape change                                                                      | Main hypothesis                                                                  | Boundary to preserve                                                                 |
| --------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| drain-direct    | Duplicate a tiny direct-delivery path in drain, falling back to deliver           | Remove a call/budget dependency for live direct effects with no previous cleanup | All other cases still use deliver; exec remains inside the drain's first-error catch |
| exec-recovery   | Move only failed-run context restoration and fail() into a helper                 | Shrink exec without adding a success-path call                                   | Capture cursor, restore active/cursor, run fail, then rethrow the identical error    |
| miss-tail       | Keep immediate successor skip in miss and extract the following bounded tail scan | Reduce miss's common swap CFG and inlining size                                  | Same scans, order, version stamps, moves, indexing and near fallback                 |
| verify-recovery | Extract only the failed-validation unwind                                         | Reduce validator size with no new success-path call                              | Same current node, stack base, dirty/checking flags, trim and rethrow                |

The drain predicate uses `(flags & Flag.Wake) === Flag.Woken`, a live callback,
and a non-function previous value. Between its extra reads and the execution
there is no callback, cleanup or nested evaluation. Moving those reads before
the wake-bit store therefore does not cross a mutation boundary. Stale,
disposed, sleeping and cleanup-bearing watchers retain the original path.

The failure helpers add a constant call depth only on the already failing path.
The tracking helper retains the original bounded loops. No per-read allocation,
new field, ownership policy or execution obligation is introduced.

## Reproduction and checks

`representation-variants.mjs` defines transformations and target/neighbor sets.
The existing experiment runner builds the same production adapter and flags:

```sh
node research/try-sites.mjs --prepare-only --pick baseline,baseline-control,drain-direct,exec-recovery,miss-tail,verify-recovery
node research/try-sites.mjs --structure-only --pick baseline,baseline-control,drain-direct,exec-recovery,miss-tail,verify-recovery
node research/try-sites.mjs --pick baseline,baseline-control,miss-tail --area miss-tail --rounds 15
```

The structure run compares answers, every existing kernel counter, and explicit
stack high-water marks over all 44 workloads (64 warm-up plus 256 measured steps).
This tests exact work/allocation equality for those programs; full tests and
source arguments still carry the semantic and asymptotic claims.

The representation workflow executes all default contract and structural tests
in development and production for baseline and each candidate. Timings and
machine-code jobs require these tests and the exact-work check to pass.

Each area has five target/neighbor workloads measured together on one pinned
runner, fifteen shuffled rounds and two independent repetitions. Every job has
a separately built byte-identical A/A control. It records parent/child affinity,
bundle hashes, engine version, execution order and individual observations.
No absolute times are pooled across runners.

Inlining/optimization/deoptimization logs are captured without graph-dumping
flags first. Separate bytecode, optimized assembly and TurboFan graph captures
use source-map-derived names from the actual minified bundles. These later
captures can change compiler scheduling and must not be mistaken for the code
used by every timed worker.

## Acceptance rule

No candidate enters production merely because its source or bytecode is smaller.
It must preserve the contract and structural bounds, show a repeatable material
target improvement beyond its A/A control, avoid unacceptable neighboring
regressions, and have a machine-code explanation when the measured effect is
large. Surviving candidates require broader production-bundle validation before
adoption. Unrepeatable or regressing changes are rejected from the runtime.
