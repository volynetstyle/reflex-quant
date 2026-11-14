# Moving the watcher validation recovery boundary

This is a semantics-neutral optimization candidate in an isolated source copy,
under the optimization criteria in ARCHITECTURE.md. It adds no persistent state
or runtime feature. The production sources are unchanged pending evidence.

## Evidence prompting the experiment

[Run 43610466948](https://github.com/volynetstyle/reflex-quant/actions/runs/43610466948)
finished successfully. The job logs reproduce these measurements (ns/step):

| Workload / variant                          | Baseline | Variant | Change in time |
| ------------------------------------------- | -------: | ------: | -------------: |
| All handlers removed / push.effects-1000    |  17788.4 | 16886.9 |          -5.1% |
| All handlers removed / fan-out.effects-1000 |  18504.3 | 17426.8 |          -5.8% |
| single-4 / push.effects-1000, repeat 1      |  21895.4 | 19906.4 |          -9.1% |
| single-4 / push.effects-1000, repeat 2      |  28311.0 | 25581.4 |          -9.6% |

The equally weighted geometric mean ratio over all 44 workloads was about
-0.234% using the logged medians. The broad result remains near zero.
Site 4 is the catch around `check(w)` in `host.deliver`. The repeated local
association warrants a narrower experiment; the ranges still overlap and
this does not yet identify an inlining, register-allocation or code-size cause.

A separate counting build (`node research/try-path-probe.mjs`) executes 64
steps and observes 64,000 deliveries with zero stale-branch entries for
`push.effects-1000`. Its positive control, `effect.through-computed`, observes
64 deliveries and 64 stale-branch entries. Instrumented code is never timed.

## Candidate and controls

`node research/try-sites.mjs --prepare-only --pick baseline,baseline-control,single-4,cumulative-3,cumulative-4,check-safe`
creates isolated copies under `.cache/try-sites`.

- `baseline` and `baseline-control` must produce byte-identical bundles; the
  latter supplies an A/A timing control with its own process executions.
- `single-4`, `cumulative-3` and `cumulative-4` reproduce the earlier ablations.
- `check-safe` moves exactly the original try/catch into `checkSafe(w)` and
  calls it at the original site. The catch still sets `Flag.Stale` and rethrows
  the same value, before any later cleanup or execution. Exceptions from
  cleanup and `exec` stay outside that boundary, as before.

The helper is a regular function; the experiment does not force V8 to keep it
out of line. Whether inlining puts its exceptional region back into a caller
is part of what the traces must establish.

## CI protocol

The `Deliver recovery boundary` workflow tests baseline and candidate against
every default semantic and structural suite in development and production,
and typechecks both. Timings and traces wait for these checks.

Timing jobs run 15 shuffled rounds, with two independent runner repetitions
and different shuffle seeds. Within a job all variants share a pinned logical
CPU and use the existing fresh-process worker with warm-up and 21 batches.
Parent and child affinity are checked, and the runtime, V8 and esbuild versions,
bundle hashes, execution order and raw worker observations are saved.

The main comparison runs the four requested ablations plus `check-safe` and
the A/A control on `push.effects-1000` and its graph counterpart. Separate
checks compare baseline, A/A and candidate on the stale path and a lazy chain
with no watcher delivery. Ratios are compared within runners; absolute times
are not pooled across runners. A hosted VM still cannot guarantee physical
CPU exclusivity or fixed clock frequency.

The trace job includes `single-4` and maps `deliver` and `drain` to their actual
minified identifiers using external source maps. It saves the bundles and maps,
`--trace-turbo-inlining`, `--trace-opt`, `--trace-deopt`, selected bytecode,
optimized assembly and TurboFan JSON graphs, in separate worker invocations
from timing. A function that is only inlined might have no standalone optimized
code or graph; its caller's graph and inlining log are then the relevant evidence.

The original broad workflow remains manually runnable. This follow-up does
not rerun it automatically, and does not interpret the old six trace variants
as a diagnosis of site 4.

## Follow-up results

[Run 43612701775](https://github.com/volynetstyle/reflex-quant/actions/runs/43612701775),
commit `e6234e08314aa8f665a5837a9d5a4fa1c6002ce3`, completed successfully.
The candidate passed 187 development tests and 180 production tests (seven
development-only tests skipped), across 13 test files. Baseline passed both
modes as well. These include the default differential, failure, disposal,
tracking, retention, generation, stack and structural-bound suites.

Fifteen-round medians, expressed as percentage changes from each job's own
baseline, were:

| Workload / repeat            | CPU                       |    A/A | single-4 | cumulative-3 | cumulative-4 | check-safe |
| ---------------------------- | ------------------------- | -----: | -------: | -----------: | -----------: | ---------: |
| push.effects-1000 / 1        | AMD EPYC 9V45             | +1.17% |   -0.69% |       +1.03% |       +0.05% |     -0.37% |
| push.effects-1000 / 2        | AMD EPYC 7763             | +0.05% |   +0.30% |       -1.17% |      -13.08% |     +0.39% |
| fan-out.effects-1000 / 1     | Intel Xeon Platinum 8573C | +0.57% |   +0.12% |      -10.13% |      -10.82% |     +0.10% |
| fan-out.effects-1000 / 2     | Intel Xeon 6975P-C        | +0.17% |   -0.64% |       -1.88% |       -2.19% |     -0.66% |
| effect.through-computed / 1  | AMD EPYC 9V45             | +2.06% |        — |            — |            — |     -1.42% |
| effect.through-computed / 2  | AMD EPYC 7763             | -0.06% |        — |            — |            — |     -2.28% |
| pull.recompute-chain-100 / 1 | AMD EPYC 7763             | +0.71% |        — |            — |            — |     +0.37% |
| pull.recompute-chain-100 / 2 | AMD EPYC 7763             | +0.10% |        — |            — |            — |     +0.23% |

The earlier isolated site-4 improvement did not reproduce in this narrower
run. `check-safe` preserved correctness but did not produce a repeatable
material benefit on direct fan-out. The cumulative results are non-additive
and vary between runners. These observations do not establish a fixed 9%
cost for the unused handler.

To exclude a changed build as the explanation, the original generator from
commit `230eae4` was rebuilt separately and compared with the archived new
bundles. Baseline, single-4, cumulative-3 and cumulative-4 were byte-identical:

| Variant      | SHA-256                                                            |
| ------------ | ------------------------------------------------------------------ |
| baseline     | `2464c3f31ebbd089605d004a3d235b4c86856961fdc34c076ce9d78df4952f7d` |
| single-4     | `ced6356e2bd28915370ae78d95d6502a6866f67a87f084f94b1cd4bfef4159c6` |
| cumulative-3 | `6e2a1f404ac3f12c8c2325fe2250015a185c4636eaa053507be5d099bb2eb26b` |
| cumulative-4 | `ceb4768fd559e1492c5d6e58b3f071e8c30fbdd2f3c18fbb46b65f4d8e8981aa` |

## What the machine-code captures show

The trace runner was AMD EPYC 9V74, Node 22.23.4. Values below refer to the
captured compilations, not to an inferred compilation inside every timed worker:

| Variant      | deliver bytecode bytes | Bytecode handler table bytes | deliver optimized instruction bytes | drain optimized instruction bytes | deliver inlined into drain |
| ------------ | ---------------------: | ---------------------------: | ----------------------------------: | --------------------------------: | -------------------------- |
| baseline     |                    143 |                           16 |                                2672 |                              3468 | no                         |
| single-4     |                    113 |                            0 |                                2672 |                              3468 | no                         |
| cumulative-3 |                    143 |                           16 |                                2464 |                              3468 | no                         |
| cumulative-4 |                    113 |                            0 |                                2464 |                              4212 | yes                        |
| check-safe   |                    113 |                            0 |                                2672 |                              3468 | no                         |

The direct optimized `deliver` listings for baseline, single-4 and check-safe
all contain 578 instruction lines. After discarding address relocation and
comment differences, the observed differences are a stack-limit reservation
offset and, for check-safe, a module-context slot offset. This is a comparison
of these disassemblies, not a claim of byte-identical native code. None of
the ten captured worker logs reports an executed deoptimization.

The drain inlining trace prints the following sizes for its deliver candidate:

| Variant      | Own bytecode + already inlined bytecode | floor(1.2 × sum) | Observed inlining |
| ------------ | --------------------------------------: | ---------------: | ----------------- |
| baseline     |                         143 + 683 = 826 |              991 | no                |
| single-4     |                         113 + 683 = 796 |              955 | no                |
| cumulative-3 |                         143 + 628 = 771 |              925 | no                |
| cumulative-4 |                         113 + 628 = 741 |              889 | yes               |
| check-safe   |                         113 + 683 = 796 |              955 | no                |

[The matching V8 heuristic](https://github.com/nodejs/node/blob/v22.23.4/deps/v8/src/compiler/js-inlining-heuristic.cc#L258)
adds the candidate's bytecode and existing inlinees, scales the reservation,
and checks the cumulative budget. Saved flags report a factor of 1.2 and a
default budget of 920. The computed reservations straddle that default and
are consistent with the observed decision. This supports an inlining-budget
interaction in the diagnostic run; it does not prove the state of every
timed worker or attribute the full timing change to that decision.

In particular, `--trace-turbo` prints that concurrent recompilation is disabled.
Its compilation schedule differs from timing. The old baseline trace, captured
without graph dumping, did inline deliver into drain. Together these captures
demonstrate why compilation history matters and why smaller bytecode alone
does not guarantee a faster generated hot path.

The `deliver-v8-traces` artifact contains all five minified bundles, external
source maps, symbol mapping, bytecode, optimized assembly and TurboFan JSON
graphs for deliver and drain. `deliver-summary` contains the per-runner table;
the timing artifacts retain all observations, order, hashes and affinity checks.

## Decision

Keep `check-safe` as a research candidate. It passes the contract but has not
met the repeated material-improvement criterion for a runtime optimization.
Do not remove failure semantics or adopt the helper on the basis of the earlier
isolated 9% result. Further causal work would need to correlate compilation
history and inlining decisions with the timed workers without conflating the
graph-dumping compiler schedule with normal execution.
