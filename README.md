# reflex-quant — padawan (textbook branch)

The smallest reactive runtime that the invariants of
[Reflex](https://github.com/volynetstyle/Reflex) imply, written to be read.
This branch keeps the semantics of `main` and drops its engineering.

The whole idea:

```text
push says "maybe"                        STALE, marked down the subscriber lists
versions say "actually"                  source.ver against edge.ver
an execution makes a new observation     edges re-read in order, under a cursor
a generation commits dependency history  node.gen against edge.gen
```

- [`src/kernel.ts`](src/kernel.ts): graph, recursive push and pull, tracking
  (cursor, then one exact index through source slots; nested indexes chain
  through `edge.slotPrev`), failure by generations.
- [`src/host.ts`](src/host.ts): watcher lifecycle, FIFO queue, batch.
- [`src/index.ts`](src/index.ts): `signal`, `computed`, `effect`, `get`,
  `set`, `dispose`, `batch`, `untracked`.

What `main` adds on top, without changing any observation: iterative push
and pull over one work stack, bounded scans and absence proofs before
indexing, direct-DIRTY writes, WOKEN watchers, an unqueued first effect run,
SMI-masked counters, research counters, benchmarks and mutant ablation.
Recursion here means a very deep chain overflows the JS stack.

## Results

Equal to Reflex's executable spec, with two documented choices applied, on
all 27,061 bounded and 18,660 recovery programs and on 100,000 generated
ones, with graph integrity checked after every operation.

## Running

The tests compare against Reflex's own spec harness and source, so this
repository lives inside a Reflex checkout, at
`packages/reflex-runtime-quant`, with the workspace installed (`pnpm install`
at the Reflex root). From this directory:

```sh
npx vitest run --config vitest.config.ts        # differential corpus + semantics
QUANT_RUNS=100000 npx vitest run --config vitest.config.ts
npx tsc -p tsconfig.json                        # typecheck src
```

The design log and report in `research/` describe `main`.
