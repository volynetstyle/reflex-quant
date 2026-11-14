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

Structural preflight identified `track.swap-32` as alternating disjoint source
sets (32 links/unlinks per step and no scan hits), so it is an allocation-path
neighbor rather than the primary reorder probe. The tracking primary is
`reorder.rotate-256` (scan hits with zero new/removed links), with reverse,
fresh-after-reorder and stable-read neighbors. Names alone do not identify
the exercised mechanism.

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

## First-pass results

[Run 43615304300](https://github.com/volynetstyle/reflex-quant/actions/runs/43615304300),
commit `2ae3b85`, completed successfully. All five source variants passed the
full default suites in both modes, and the six counting builds matched all
44 programs exactly. Production has 180 passing tests plus seven development-only
skips; development has 187 passing tests.

Fifteen-round median changes from the runner's baseline:

| Candidate / workload                     | Repeat 1 |  A/A 1 | Repeat 2 |   A/A 2 | First-pass decision                             |
| ---------------------------------------- | -------: | -----: | -------: | ------: | ----------------------------------------------- |
| drain-direct / push.effects-1000         |  -11.28% | +0.51% |   -3.30% | +12.12% | Survives screening; broad confirmation needed   |
| drain-direct / fan-out.effects-1000      |  -10.63% | +0.09% |  -13.24% | -10.36% | Same direction, but A/A instability matters     |
| exec-recovery / pull.recompute-chain-100 |   -0.83% | -2.27% |   -0.58% |  -0.72% | No material target benefit; reject from runtime |
| miss-tail / reorder.rotate-256           |   -0.85% | +0.15% |   +2.03% |  -0.11% | Does not repeat; reject from runtime            |
| verify-recovery / pull.validate-wide-256 |   +1.02% | +4.93% |   -0.71% |  -0.60% | Does not repeat; reject from runtime            |

The miss-tail job's original primary label and trace use `track.swap-32`.
Rotation and reversal were nevertheless both timed as neighbors. Structural
inspection corrected the mechanism attribution; the revised configuration
makes rotation the primary and adds a fresh-after-reorder neighbor for future
manual runs. No machine-code conclusion about the rotation is drawn from the
old disjoint-source trace. It is not necessary to repeat a rejected candidate
merely to obtain a more favorable workload.

Neighbors of drain-direct remained close to their baselines: batching -0.66%
and +0.02%; computed-to-effect delivery -1.44% and +0.59%; effect mount/dispose
-0.02% and -0.09%. The direct target still has overlapping and apparently
multi-modal baseline ranges, so its improvement is not summarized as a fixed tax.

Captured code sizes also separate the hypotheses:

| Changed function | Baseline bytecode | Candidate bytecode |  Baseline optimized instruction bytes | Candidate optimized instruction bytes |
| ---------------- | ----------------: | -----------------: | ------------------------------------: | ------------------------------------: |
| drain            |               194 |                237 |                                  3468 |                                  4236 |
| exec             |               295 |                281 |                                  2544 |                                  2372 |
| miss             |               290 |                223 | Not compiled standalone in this probe | Not compiled standalone in this probe |
| verify           |               385 |                288 |                                  3436 |                                  3472 |

Thus a smaller source/bytecode did not make exec or verify materially faster.
Conversely, the direct drain variant is larger. Its ordinary inlining log
records `exec -> drain` directly; the baseline records `exec -> deliver -> drain`.
Those ordinary logs retain concurrent compilation and report no executed deopts
in the direct-delivery probe. The separate graph-dump process sees baseline drain
calling deliver and candidate drain inlining exec. Neither capture is asserted
to be every timed worker's exact compilation history.

## Broad confirmation of the surviving candidate

The confirmation workflow measures all 44 workloads, in six non-overlapping
shards, with two independent repetitions of ten shuffled rounds and an A/A
control in every job. It checks complete coverage and compares only ratios
within each runner. Before timing it requires the exact bundle hashes already
contract-tested above, so a changed candidate cannot silently reuse that proof:

- baseline and A/A: `2464c3f31ebbd089605d004a3d235b4c86856961fdc34c076ce9d78df4952f7d`;
- drain-direct: `8df7cc1f2a23b01698ba7e6310bfb7920ca10df4970b3a8cdabb7b337169e6ba`.

The broad first-pass workflow remains manually runnable; confirming one survivor
does not automatically rerun the other three rejected candidates.

## Broad confirmation result and final decision

[Run 43616317020](https://github.com/volynetstyle/reflex-quant/actions/runs/43616317020),
commit `33100ce`, completed successfully and verified two independent jobs for
each of the 44 workloads. The bundle identities matched the contract-tested
versions. Ten-round median changes from baseline included:

| Workload                | Repeat 1 |   A/A 1 | Repeat 2 |  A/A 2 |
| ----------------------- | -------: | ------: | -------: | -----: |
| push.effects-1000       |   -2.42% | +12.51% |   -2.17% | +2.96% |
| fan-out.effects-1000    |   -8.85% |  -3.75% |   -1.11% | +1.03% |
| effect.rerun-1          |   +6.50% |  +0.02% |   +5.85% | -2.92% |
| effect.through-computed |   +0.33% |  -2.43% |   -0.12% | -0.59% |
| lifecycle.mount-100     |   +2.43% |  -0.06% |   +0.50% | -0.01% |

Bulk direct fan-out still has lower median time, but the isolated one-effect
rerun has higher median time in both repetitions. On EPYC 9V74 that changes
30.080 ns to 32.036 ns, while the A/A median is 30.084 ns. On EPYC 9V45 it
changes 19.320 ns to 20.449 ns, while the A/A median is 18.756 ns. Ranges still
overlap and these are not formal significance claims; the repeated adverse
neighbor result is sufficient to withhold a general runtime optimization.

The candidate exposes a workload tradeoff, not a free improvement. The first
five-neighbor selection omitted `effect.rerun-1`; testing all workloads caught
the missing case. This is the reason for broad confirmation before adoption.

No candidate from this first four-area pass is adopted into `src`:

- drain-direct: reject as a general optimization because of the repeated
  single-effect tradeoff, despite its bulk fan-out results;
- exec-recovery: reject for lack of material repeatable target improvement;
- miss-tail: reject for non-repeating improvements and reorder regressions;
- verify-recovery: reject for lack of material repeatable target improvement.

The transformations and raw CI artifacts remain as reproducible research
evidence. The production runtime, contract and mechanism basis are unchanged.
This decision concerns these four exact representations and this measured
engine/profile, not every possible transformation in those four areas.
