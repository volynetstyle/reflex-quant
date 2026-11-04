# Stage semantics preserved by implementation experiments

This contract records the behavior of the existing implementation before stage
optimization. Snapshot bundles and source hashes are produced by
the repository-level `scripts/snapshot-stages.mjs`; the differential suite observes both production
and development execution, including profiling and debug event order.

## Push

- Process all direct outgoing edges in list order before visiting descendants.
  Queue direct branches in that order and visit them in reverse order. Within
  each transitive branch, traverse children before the next sibling.
- Clean direct subscribers lose `Visited` and gain `Changed`. An `Unknown`
  non-watcher is promoted to `Changed` before considering `Computing`.
  Transitive clean subscribers lose `Visited` and gain `Unknown`.
- A computing subscriber is marked `Visited | Unknown` only if its cursor is
  non-null and the triggering edge is at or before that cursor. Preserve all
  other state bits. Already-dirty subscribers otherwise stop propagation.
- A direct watcher stops descent even without an invalidation hook. A transitive
  watcher stops descent when the hook exists. Hook calls are synchronous and
  observe the partially updated graph. Do not snapshot the hook across calls.
- Read continuation links after callbacks, preserving callback mutations.
  A thrown hook aborts immediately, keeps completed state changes, releases the
  current stack slice, and leaves an outer reentrant traversal intact.
- `push_iterator_once` changes only direct subscribers lacking `Changed`, clears
  `Unknown`, preserves other bits, and does not walk descendants. The skipping
  variant omits only the supplied edge; a foreign skip traverses the whole list.

## Pull

- A `Changed` parent returns/bubbles a change without inspecting its edge.
  Otherwise inspect incoming dependencies in order, prioritizing `Changed`
  over `Unknown`. Development rejects computing dependencies as cycles.
- Watcher dependency validation is a separate root-oriented operation. It
  validates every committed root dependency, accumulates confirmed changes
  locally, and reuses the existing computing-subscriber cursor protocol to
  record a concurrent invalidation as `Visited` without changing push paths.
- Advance changed dependencies and unknown leaves. Descend into unknown
  dependencies with inputs. Advance ancestors only after a confirmed change.
- A stable result resumes the next sibling. Stable unwinding clears `Unknown`
  only on the nodes visited by that unwind. The root is not recomputed here.
- Callbacks can reenter pull and mutate graph/state. Every callback boundary
  exposes only the active stack slice. On every exit, including exceptions,
  release owned continuations and restore the caller's stack high-water mark.

## Advance

- Reset the incoming cursor, clear `Visited`, set `Computing`, enter tracking,
  and call `compute` as a plain function. Restore the previous consumer before
  cleanup, comparison, propagation, or returning/throwing.
- On callback failure, keep the old payload and collected edges, clear
  `Computing | Unknown`, set `Changed`, report the same error, and rethrow the
  original value. Do not clean up the unvisited suffix after failure.
- On success, clean the unvisited suffix before comparing with `Object.is`.
  Preserve NaN equality and the distinction between +0 and -0. Publish the
  payload only on change; restore the original state with computing/dirty/
  visited bits cleared. Preserve debug/profiling event order.
- Propagate confirmed changes to current outgoing edges, omitting the supplied
  pull-parent edge. Do not notify the parent merely because the computed value
  changed. Do not change the handling of foreign skip edges.

## Retained state and instrumentation

- Node/edge layout, edge identities, list order, versions, current consumer,
  tracking epoch, execution phase and runtime state remain observable.
- Clear popped or aborted stack slots. Nested execution must not overwrite live
  outer continuations. Trim only at an outermost boundary: push retains 512
  slots after success; pull retains at most 256 after either success or failure.
- Development stack statistics, profile counters/topology and debug events are
  part of the comparison. Production must not acquire diagnostic allocations.

## Reproducing the semantic gate

Before changing stages, compile and save an independent reference bundle. Run
from the repository root, where `scripts/` lives:

```sh
pnpm --filter @volynets/reflex-runtime build:ts
node scripts/snapshot-stages.mjs baseline
node scripts/check-stages-semantics.mjs record baseline
```

The committed `test/fixtures/stages-semantics.json` contains frozen SHA-256
trace digests and hashes of the original stage source files. Do not regenerate
it to accept an implementation change. Snapshot names are immutable; use a new
name for each candidate. After compiling a candidate:

```sh
node scripts/snapshot-stages.mjs candidate
node scripts/check-stages-semantics.mjs diff baseline candidate
node scripts/check-stages-semantics.mjs stress baseline candidate
node scripts/check-stages-semantics.mjs verify candidate
node scripts/compare-stages.mjs baseline candidate
node scripts/qualify-stages.mjs baseline candidate wide-dirty-last-4096
```

The qualification command runs the semantic differential, a scenario-local
trace comparison, production timing samples with p75/p95/p99, development
profile counters/topology, stack statistics, and filtered V8 optimization/
deoptimization output for the same named scenario. Its JSON report is written
under `temp/stages/`. It supplements rather than replaces the full differential
suite: the scenario trace is intentionally small, while the semantic gate owns
complete graph-state equivalence.

The standard gate covers 175 scenarios in each of production and development.
The extended gate generates 2,327 scenarios per mode. Both compare operation
results, original computation failures, node flags/payloads, edge identities and
links, runtime registers, debug event order, profile counters/topology and stack
cleanup. It also covers list mutation and hook replacement during push, nested
push/pull failures, all low pull-state combinations, foreign skip edges,
Object.is edge cases, retries, and stacks deeper than the retained capacity.
The verify command needs only a candidate snapshot and the committed digests.
Mismatch details are written to `temp/stages/difference.json`.

## Selected implementation and measurement

The selected push keeps the original two-phase traversal. Its direct watcher
path avoids the no-op production emitter and calls an installed hook directly;
development retains the original instrumentation. The computing-prefix scan
visits four links per loop iteration. Pull separates root policy,
single-edge dirty proof, and the deep continuation machine. Root traversal
loads each dependency/state pair once: clean edges stay in the local root loop,
while dirty edges enter `pullDependencyDirty` and perform the post-proof
reentrancy barrier before reading their continuation.

Experiments that outlined DFS, duplicated the hook-free traversal, merged skip
loops or moved advance side-fanout into a helper were not retained. They either
regressed other workloads or did not justify their additional code.

The benchmark uses a fresh Node process for each scenario
and variant. It alternates baseline/candidate order over fifteen samples, with
10,000 warmup and 20,000 measured passes. `--no-concurrent-recompilation`
removes background optimizing-compiler timing from the measurement; reports
include this flag, the CPU, Node version and every raw timing. Results measure
specific hot paths on the recorded machine, not a universal application speedup.
Unchanged push-once/advance scenarios provide controls for timing variation.
All snapshots and reports live in the ignored `temp/stages/` directory.
