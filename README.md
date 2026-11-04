# reflex-quant

An experiment: derive the smallest reactive runtime that the invariants of
[Reflex](https://github.com/volynetstyle/Reflex) imply, from its semantic
contract and executable spec rather than from its implementation, and
measure what is left.

- **Production code:** three files, [`src/kernel.ts`](src/kernel.ts) (graph,
  tracking, invalidation, validation), [`src/host.ts`](src/host.ts)
  (watcher lifecycle, queue, batch), [`src/index.ts`](src/index.ts)
  (`signal`, `computed`, `effect`, `get`, `set`, `dispose`, `batch`,
  `untracked`; a handle is the node itself). About 2 KB gzip.
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
src/        kernel.ts, host.ts, index.ts
test/       differential (spec, contract spec, Reflex, quant), tracking,
            semantics, structural bounds; tools/ (QUANT_TOOLS=1)
bench/      scenarios, adapters, build, timing (CI only), structure counters
research/   REPORT.md, LOG.md, mutants.mjs (ablation), versions/ (v0-v3)
```

## Running

The tests compare against Reflex's own spec harness and source, so this
repository lives inside a Reflex checkout, at
`packages/reflex-runtime-quant` (the local name), with the workspace
installed (`pnpm install` at the Reflex root). From this directory:

```sh
npx vitest run --config vitest.config.ts        # all tests
npx tsc -p tsconfig.json                        # typecheck src
node research/mutants.mjs                       # ablation -> research/mutants.json
node bench/build.mjs                            # bundles: quant, Reflex bf71877, alien-signals
node bench/run.mjs --verify-only                # same answers on all three runtimes
node bench/structure.mjs                        # structural work per step
node bench/run.mjs --rounds 9                   # timing: run it on CI, not locally
```

CI (`.github/workflows/experiment.yml`) checks out Reflex at the compared
commit, places this repository at `packages/reflex-runtime-quant`, and
runs the tests, the counters and the timing in one job.
