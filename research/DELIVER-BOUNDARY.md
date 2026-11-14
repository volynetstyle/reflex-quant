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
