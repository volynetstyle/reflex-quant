# reflex-quant

An experiment: derive the smallest known reactive runtime implied by a
frozen contract (semantic invariants and structural bounds, see
[SPEC.md](SPEC.md)), and measure what is left. The contract was extracted
from the executable spec of [Reflex](https://github.com/volynetstyle/Reflex)
(provenance in [research/REPORT.md](research/REPORT.md)); it does not follow
later changes of Reflex.

- **Production code:** [`src/model.ts`](src/model.ts) and [`src/types.ts`](src/types.ts)
  (internal and public types), [`src/flags.ts`](src/flags.ts) (flag layout),
  [`src/graph.ts`](src/graph.ts) (local graph operations),
  [`src/tracking.ts`](src/tracking.ts) (dependency resolution),
  [`src/kernel.ts`](src/kernel.ts) (execution context, stack-dependent tracking,
  invalidation and validation), [`src/host.ts`](src/host.ts)
  (watcher lifecycle, queue, batch), [`src/index.ts`](src/index.ts)
  (`signal`, `computed`, `effect`, `get`, `peek`, `set`, `update`, `dispose`,
  `batch`, `untracked`; a handle is the node itself; see [Surface](#surface)).
  Research counters live in
  [`src/instrumentation.ts`](src/instrumentation.ts) and are eliminated from
  the release, as are development diagnostics (`__DEV__`), which a separate
  development build keeps ([Development build](#development-build)). The ESM
  and CJS bundles are each standalone; ESM is about 2.2 KB gzip.
- **Report:** [research/REPORT.md](research/REPORT.md). **Design log**, one
  counterexample per mechanism: [research/LOG.md](research/LOG.md).
- **Textbook version:** branch
  [`padawan`](https://github.com/volynetstyle/reflex-quant/tree/padawan), the
  same semantics without the engineering (recursive push and pull, one
  exact index, no counters), written as a guided tour. It passes the same
  differential corpus; this branch is its lowering for speed and stack depth.

## Example

A computation depends on exactly what its last run read, so dependencies
change from run to run:

```ts
import { computed, effect, get, set, signal } from "reflex-quant";

const full = signal(false);
const first = signal("Ada");
const last = signal("Lovelace");
const name = computed(() => (get(full) ? `${get(first)} ${get(last)}` : get(first)));

effect(() => console.log(get(name))); // "Ada"        name reads full, first
set(last, "Byron");                   // nothing runs: last was not read
set(full, true);                      // "Ada Byron"  name now reads last too
set(full, false);                     // "Ada"        last is dropped again
set(last, "King");                    // nothing runs
```

When a computation reads the same sources in a different order, its
existing relations are moved, not rebuilt: with 256 sources rotated every
pass (`reorder.rotate-256`), quant creates and removes no relations per
pass, where alien-signals relinks 255 (`node bench/structure.mjs`).

## Results

- Equal to Reflex's executable spec, with three documented choices applied,
  on all 27,061 bounded and 18,660 recovery programs and on 100,000
  generated ones, with graph integrity checked after every operation.
- Current Reflex is that contract plus three failure-path choices, on the
  same corpus. One of them drops an execution obligation that the contract
  (R2) says survives a failure.
- All 34 mechanism ablations fail a test: 25 a semantic test, 8 only a
  structural bound or a representation test (the work an optimization saves, counted), 1 only a
  sibling-order test (a convention). The 7 ablations of the development
  diagnostic (C1) fail a test of the development build.
- On CI (run 42287159440): within 25 % of the better of Reflex and
  alien-signals on all 18 scenarios, at or ahead of it on 8; geometric mean
  0.97 of the better one, 0.95 of Reflex, 0.42 of alien-signals. Reorders
  allocate nothing. Reflex remains faster on every reorder scenario
  (quant 1.14–1.24 of it). The suite is this project's own; per-scenario
  numbers are in research/REPORT.md (Q6), the trajectory over every CI run
  in research/HISTORY.md.

## Surface

Every operation exposes semantics the kernel and host already have; none adds
a field, a flag or a branch on a hot path ([research/LOG.md](research/LOG.md) item 26).

```ts
const a = signal(1);
const total = computed((prev) => prev + get(a), 0); // prev: last committed value
get(total);                                         // refresh and observe
peek(total);                                        // refresh, do not observe
set(a, 2);
update(a, (v) => v + 1);                            // untracked fn, then set
dispose(total);                                     // detach; the value stays readable
```

- `computed(fn, initial?)`: `prev` is the last **successfully committed** value
  (`initial` before the first commit; a failed run leaves it unchanged). It
  advances per execution, not per write: writes coalesced by a batch or by
  laziness are one step. Returning `prev` itself is a cutoff, so custom
  equality needs no comparator: `(prev) => (equal(prev, next) ? prev : next)`.
  Sources keep `Object.is`.
- `peek(x)`: `get` without its tracking half; equal to
  `untracked(() => get(x))`, without the closure.
- `update(s, fn)`: a write, not an observation. `fn` runs untracked, so
  neither `s` nor what `fn` reads becomes a dependency of the running
  consumer; if `fn` throws, nothing is written.
- `effect(fn)`: if the call throws, it returns no handle and leaves nothing
  live; a cleanup its run returned has already run.

### Development build

Bundlers that resolve the `development` export condition, and Node with
`--conditions=development`, load `dist/index.development.js` (or `.cjs`). It
diagnoses a precondition that the production build does not check (SPEC C1):
a read or a validation that reaches a computed whose evaluation is in
progress throws `Cycle detected`, instead of answering with the computed's
previous value. Such a demand comes from a cycle, or from a write inside a
computed whose synchronous effects read back into it. The production build
pays nothing for the diagnosis; the release check verifies the split.

## Layout

```text
src/        types, model, flags, graph, tracking, kernel, host, instrumentation, surface
test/       differential (spec, contract spec, Reflex, quant), tracking,
            semantics, structural bounds; tools/ (QUANT_TOOLS=1)
bench/      scenarios, adapters, build, timing (CI only), structure counters
research/   REPORT.md, LOG.md, mutants.mjs (ablation), versions/ (v0-v3)
```

## Running

For development, use Node.js 20.19 or later in the 20.x line, 22.13 or later in the 22.x line, or 24+ and npm (the published library supports Node.js 18+). Install this repository's dependencies with `npm ci`; the Reflex sources, spec harness and fixed production baseline used by the tests and benchmarks are included in `bin/reflex-runtime` and do not require a Reflex checkout. From this directory:

```sh
npm run lint                                    # lint production TypeScript
npm run format:check                            # check production formatting
npm run format                                  # format production code and tool config
npm run build && npm run check                  # standalone release and declarations
npx vitest run --config vitest.config.ts        # all tests, development build
npm run test:production                         # the same suite, production build
npx tsc -p tsconfig.json                        # typecheck src
node research/mutants.mjs                       # ablation -> research/mutants.json
node bench/build.mjs                            # bundles: quant, Reflex bf71877, alien-signals
node bench/run.mjs --verify-only                # same answers on all three runtimes
node bench/structure.mjs                        # structural work per step
node bench/run.mjs --rounds 9                   # timing: run it on CI, not locally
node bench/run.mjs --suite mechanisms --only '^push\.'   # one mechanism: read write track push pull effect batch lifecycle
node bench/run.mjs --suite scaling --only '^chain@' --out .cache/bench/s.json && node bench/scaling-report.mjs .cache/bench/s.json
                                                # growth with load: N = 16..4096, log-log slope per runtime
node bench/cost/build.mjs && node bench/cost/run.mjs regime --rounds 0
                                                # cost-model probes (research/COST-MODEL.md); timing on CI
```

CI is split in two workflows. `.github/workflows/ci.yml` runs lint, typecheck/release build and tests as parallel jobs. `.github/workflows/benchmark.yml` builds and checksum-verifies the bundles once, then runs in parallel one timing job per mechanism (`bench/mechanisms.mjs`), the graph scenarios (`bench/scenarios.mjs`) in shards, the structural counters and the edge-churn probe. Each timing job runs all three runtimes on one runner: compare ratios within a job, never times across jobs. The Reflex benchmark baseline is fixed at commit `bf71877`; see `bin/reflex-runtime/README.md` for its provenance.
