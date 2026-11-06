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
  (`signal`, `computed`, `effect`, `get`, `set`, `dispose`, `batch`,
  `untracked`; a handle is the node itself). Research counters live in
  [`src/instrumentation.ts`](src/instrumentation.ts) and are eliminated from
  the release. The ESM and CJS bundles are each standalone; ESM is about 2 KB gzip.
- **Report:** [research/REPORT.md](research/REPORT.md). **Design log**, one
  counterexample per mechanism: [research/LOG.md](research/LOG.md).
- **Textbook version:** branch
  [`padawan`](https://github.com/volynetstyle/reflex-quant/tree/padawan), the
  same semantics without the engineering (recursive push and pull, one
  exact index, no counters), written as a guided tour. It passes the same
  differential corpus; this branch is its lowering for speed and stack depth.

## Results

- Equal to Reflex's executable spec, with two documented choices applied,
  on all 27,061 bounded and 18,660 recovery programs and on 100,000
  generated ones, with graph integrity checked after every operation.
- Current Reflex is that contract plus three failure-path choices, on the
  same corpus. One of them drops an execution obligation that the contract
  (R2) says survives a failure.
- 23 of 24 mechanism ablations fail a test; the survivor is a constant
  factor only timing sees.
- On CI: within 25 % of the better of Reflex and alien-signals on 14 of 18
  scenarios, faster than both on 8. Reorders allocate nothing.

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
npx vitest run --config vitest.config.ts        # all tests
npx tsc -p tsconfig.json                        # typecheck src
node research/mutants.mjs                       # ablation -> research/mutants.json
node bench/build.mjs                            # bundles: quant, Reflex bf71877, alien-signals
node bench/run.mjs --verify-only                # same answers on all three runtimes
node bench/structure.mjs                        # structural work per step
node bench/run.mjs --rounds 9                   # timing: run it on CI, not locally
node bench/run.mjs --suite mechanisms --only '^push\.'   # one mechanism: read write track push pull effect batch lifecycle
node bench/run.mjs --suite scaling --only '^chain@' --out .cache/bench/s.json && node bench/scaling-report.mjs .cache/bench/s.json
                                                # growth with load: N = 16..4096, log-log slope per runtime
```

CI is split in two workflows. `.github/workflows/ci.yml` runs lint, typecheck/release build and tests as parallel jobs. `.github/workflows/benchmark.yml` builds and checksum-verifies the bundles once, then runs in parallel one timing job per mechanism (`bench/mechanisms.mjs`), the graph scenarios (`bench/scenarios.mjs`) in shards, the structural counters and the edge-churn probe. Each timing job runs all three runtimes on one runner: compare ratios within a job, never times across jobs. The Reflex benchmark baseline is fixed at commit `bf71877`; see `bin/reflex-runtime/README.md` for its provenance.
