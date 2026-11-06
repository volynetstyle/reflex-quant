# Physical cost model: probes

The semantic model is settled by the contract and the ablations. This file
asks the next question: where the CPU bills for the architecture. Each probe
isolates one physical hypothesis, keeps the program fixed, and separates
machine-independent facts (structure, checksums) from timing, which counts
on CI only (`.github/workflows/benchmark.yml`, job `cost`).

```sh
node bench/build.mjs && node bench/cost/build.mjs
node bench/cost/run.mjs regime --rounds 0       # structure only: runs anywhere
node bench/cost/run.mjs <probe> --rounds 9      # timing: CI
```

Every cell (bundle, scenario, flags) runs in a fresh process per round, in
a random order, as `bench/run.mjs` does. Fresh processes also mean that type
feedback from one N never reaches another N: each size is warmed only on its
own shape. Cells that run one scenario on several bundles must agree on the
64-step checksum before they are timed.

## Probes

| Probe | Question | What falsifies it |
| --- | --- | --- |
| `regime` | Does shuffle's cost per N jump between 1k and 4k while its structural work per N stays flat? | Structural work per N rising with N (an algorithmic cause), or the jump absent at finer N. |
| `layout` | Is the cost a placement effect? Same program, same code: control (allocation order, promoted by a full GC), young (no GC before sampling), scattered (retained padding between nodes and between the first pass's edges), scavenged (promoted through scavenges, in the collector's copy order). | Equal times across placements. |
| `decompose` | One shuffle pass against its parts: reads (`peek`), index + unindex, slot lookups, list moves, and lookup + move together. | `full − (reads + index + lookup + move)` near zero: the parts add up, so no interaction. |
| `lower-bound` | Where reverse's constant factor sits. Quant variants with one constant-factor mechanism removed (`bench/cost/build.mjs`): `scan-1`, `no-absent`, `no-prefix-scan`, `index-first-miss`, `no-displaced`, `lean` (the last two together). | A variant far below quant locates the cost in that mechanism; none below it means the cost is in lookup, move and pointer traffic. |
| `leaf` | The fixed cost of `get` / `set`: stages A–E (bare field, flag test, `active` test, kernel `read` / `write`, public API) next to the bench adapters and alien-signals called directly. | The adapter or a single stage carrying most of the gap to alien. |

The lower-bound variants are not proposals. They are exact on the `lb.*`
workloads (one consumer, no nesting), which the runner checks by checksum;
elsewhere they may be wrong. A variant that disagrees on a workload is
excluded from timing and listed in the report.

## Machine-independent results

From `node bench/cost/run.mjs regime --rounds 0` and the probe's checksum
pass (`--verify-only`):

- **Structural work per N is flat from 512 to 8192**, for shuffle and for
  reverse: per pass, ≈ 1.00 lookups, ≈ 1.00 moves and exactly 1.00 indexed
  edges per source; no edge created or removed. A cost per N that grows with
  N is therefore not algorithmic.
- **The work stack is never used** on either workload: its high-water mark is
  0 at every N (one consumer: no displaced slots, no mark or verify walks). A
  growing backing store cannot explain a jump here, so no preallocation
  experiment is needed for these workloads.
- **Quant allocates nothing while sampling shuffle or reverse**: no
  collection runs during the 21 sampling batches (GC profiler, `--gc`;
  checked at N = 1024 and 4096, and for every layout variant at 4096);
  alien-signals runs scavenges at the same time (it relinks on every
  reorder). For quant, GC pauses cannot explain the jump; GC placement still
  can, which is what `layout` measures.
- **The graph takes 250–390 bytes per source** in these programs (nodes,
  edges, adapter handles, permutations), about 0.27 MB at N = 1024 and 1.1 MB
  at N = 4096. A transition between those sizes is where a working set leaves
  a per-core L2 cache on common server CPUs; this is a hypothesis for the
  `layout` and `decompose` timings to confirm or reject, not a result.
- **All six lower-bound variants are exact** on reverse, shuffle and
  insert-one at N = 256, 1024, 4096 (81 cells, no checksum mismatch).

## Timing results: CI run 42252842592 (commit 816acde)

Node 22.23.4 (V8 12.4), 9 rounds. The jobs landed on two CPU models: AMD
EPYC 7763 (Zen 3, 512 KB L2 per core) for `regime`, `decompose`,
`lower-bound`, and AMD EPYC 9V74 (Zen 4, 1 MB L2 per core) for `layout`,
`leaf`. Absolute times compare only within one job.

### Leaf: the kernel is at alien's floor; the public write pays the host

ns per operation (EPYC 9V74):

| stage | read | write |
| --- | ---: | ---: |
| A bare field (`value`; `Object.is` + store) | 1.10 | 1.10 |
| B + flag test; + version bump | 1.10 | 1.38 |
| C + `active` test (replica); + subscriber loop | 1.39 | 1.38 |
| D kernel `read` / `write` | 1.30 | 1.38 |
| E public `get` / `set` | 1.58 | 2.75 |
| quant through the bench adapter | 1.66 | 2.75 |
| alien called directly / through the adapter | 1.30 / 1.30 | 1.39 / 1.39 |
| Reflex through the adapter | 1.80 | 4.67 |

- **Kernel write = alien write** (1.38 vs 1.39), **kernel read = alien read**
  (1.30 vs 1.30). Versions, the flag test and the subscriber check cost
  nothing measurable beyond a bare field update.
- **`set` adds 1.37 ns, all of it `flush()`**: the host's synchronous
  delivery check (draining, batch depth, queue size) after every write,
  also when nothing was woken. `get` adds 0.28 ns over kernel `read`.
- Stage A is the loop's own floor (load, masked add, loop), so these values
  sit 0.2–0.3 ns above it; the replica stages B and C approximate the
  kernel (C at 1.39 above D at 1.30 shows they are good to about
  0.1–0.3 ns), they are not an exact decomposition.

Alien-signals has no cheaper mutation kernel; it has a cheaper public path
for a write after which nothing runs. The candidates for that path are the
`surface` probe below.

### Regime: the work per N is flat, shuffle's time per N is not

ns per N, and the growth exponent from the previous row (EPYC 7763):

| N | quant shuffle | exp | Reflex shuffle | exp | quant reverse | Reflex reverse |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 512 | 29.4 | — | 19.4 | — | 21.1 | 13.0 |
| 768 | 30.5 | 1.08 | 19.9 | 1.07 | 22.6 | 12.9 |
| 1024 | 32.4 | 1.21 | 20.6 | 1.11 | 21.6 | 12.7 |
| 1536 | 34.6 | 1.16 | 24.1 | 1.39 | 22.0 | 13.0 |
| 2048 | 42.7 | 1.73 | 29.1 | 1.65 | 19.7 | 13.1 |
| 3072 | 57.4 | 1.73 | 33.7 | 1.36 | 20.6 | 13.2 |
| 4096 | 75.3 | 1.95 | 39.0 | 1.51 | 22.9 | 13.3 |
| 6144 | 80.1 | 1.15 | 43.6 | 1.28 | 23.9 | 13.1 |
| 8192 | 89.2 | 1.37 | 46.1 | 1.19 | 23.7 | 13.3 |

- Same structural work per N at every N (above), no collection while
  sampling (alien: 6.3 → 95.2 collections per 1000 steps), no stack.
- **Reverse, with the same 1 lookup, 1 move and 1 indexed edge per source,
  stays flat**; shuffle does not. The bill follows the access pattern, not
  the operations. Reflex shows the same transition at a lower level.
- The knee sits where the graph (270–320 bytes per source) outgrows the
  per-core L2: 512 KB is reached at about 1.6–1.9k sources on the 7763, and
  the exponent rises at 1536 → 2048. On the 9V74 (1 MB L2), `layout`'s
  control rises later, at 2048 → 4096 (28.0, 30.7, 42.4, 61.1 ns/N at 1k,
  2k, 4k, 8k). Consistent with L2 capacity setting the knee; confirming it
  needs both sweeps on one runner type.

### Layout: placement matters, the working set matters more

quant, ratio to control (EPYC 9V74): scattered 1.04 / 1.08 / 1.18 / 1.08 at
1k / 2k / 4k / 8k; young 0.95–1.02; scavenged 1.01–1.06. Reflex: scattered
1.05–1.11, young 0.89–0.92. Spatial locality costs up to 18 %, but control
itself grows 2.2× per N from 1k to 8k: the working set, not the collector's
placement, carries most of the growth. Alien's layout cells are bimodal
(young 0.36–1.02, scavenged 0.39–2.62 of control): collection-dominated and
not interpreted.

### Decompose: additive below the knee, an interaction term above it

ns per N (EPYC 7763):

| N | reads | index | lookup | move | lookup + move together | full | sum | full − sum |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 256 | 3.06 | 5.78 | 4.15 | 8.22 | 9.80 | 23.01 | 21.21 | 1.81 |
| 1024 | 3.24 | 10.31 | 5.31 | 8.18 | 11.90 | 26.94 | 27.04 | −0.10 |
| 4096 | 4.64 | 25.47 | 4.92 | 9.70 | 21.91 | 59.21 | 44.73 | 14.48 |

At 1024 the pass is exactly the sum of its parts. At 4096 the index sweep
grows 2.5× (two walks over the source set in list order, which is random in
memory), lookups stay flat, moves grow 19 %, and an interaction term of
14.5 ns/N (24 % of the pass) appears; lookup and move together go from 1.6
cheaper than apart to 7.3 dearer.

### Lower bound: no constant-factor mechanism explains the gap to Reflex

Ratio to quant (EPYC 7763):

| workload | N | scan-1 | no-absent | no-prefix-scan | index-first-miss | no-displaced | lean | Reflex |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| reverse | 256 | 0.97 | 1.00 | 0.97 | 1.02 | 0.97 | 0.96 | 0.62 |
| reverse | 1024 | 1.00 | 0.99 | 0.95 | 0.97 | 0.99 | 0.92 | 0.57 |
| reverse | 4096 | 0.91 | 0.88 | 0.88 | 0.89 | 0.90 | 0.88 | 0.56 |
| insert-one | 256 | 1.00 | 1.00 | 1.00 | 1.65 | 1.01 | 1.68 | 0.96 |
| insert-one | 1024 | 1.00 | 1.00 | 1.00 | 1.77 | 1.00 | 1.79 | 0.94 |

- **The 0.88–0.91 at N = 4096 is the noise of the quant cell, not mechanism
  cost.** That cell is bimodal (round medians: reverse 20.9..23.9, shuffle
  64.4..81.9, insert-one 11.2..15.2 ns/N), and every variant's median sits at
  its lower mode, including `no-displaced`, which removes code that never
  runs here (stack high-water 0), and `scan-1`, which changes one constant
  in otherwise identical bytes. At 256 and 1024 the variants stay within
  0.92–1.02 on reverse and shuffle. The constant-factor mechanisms explain at most a few percent of
  reverse; Reflex is at 0.56–0.62. The difference is in the representation
  (index sweep, lookup through the source, intrusive move), not in branches.
  The next run carries `identity` (the same bytes as quant) to measure the
  cell noise directly.
- **The cheap front end is what keeps local edits at Reflex's level**:
  without it (`index-first-miss`, `lean`) insert-one is 1.65–1.79× slower,
  while quant is at 10.8 ns/N against Reflex's 10.1 at N = 1024. Tracking has
  two regimes: cursor and bounded exact proofs for local edits, the index for
  global reorders. Neither replaces the other.

### Model so far

| workload | what quant pays | relative position |
| --- | --- | --- |
| stable reads, local edits | cursor, bounded exact proofs | Reflex level |
| global ordered reorder (reverse) | index + lookup + move per source | constant ≈ 1.6–1.8× Reflex, flat in N |
| global chaotic reorder, small working set | the same, additive | constant |
| global chaotic reorder, working set beyond L2 | index sweep and lookup/move interaction | locality-bound; Reflex hits the same wall later and lower |
| leaf read / write in the kernel | field access, version, flag test | alien level |
| public `set` | + the host's delivery check | +1.37 ns per write |

## Surface A/B (pending CI)

Adopted: `set` and `update` test the queue at the call site (LOG 27). The
probe `surface` measures that release (`current`) against the alternatives
(`surfaceVariants` in `bench/cost/build.mjs`): `flush-call` (the previous
`set`: write, then `flush()`), `size-first` (the previous `set` with
`flush`'s guard reordered, queue first: the guard order alone), `commit`
(the same guard inside one host function), `get-alias` (`get` is kernel
`read` under the public type). Each passes the 62 tests against its source
copy and the probe's checksums. The probe times leaf `get`/`set` and the
mechanisms where a write has work to deliver (effect.rerun-1,
effect.through-computed, batch.coalesce-64, push.effects-1000), so a win on
the empty path cannot hide a loss on the full one. The release should stay
if, over repeated CI runs, it is no slower than `flush-call` beyond the
`current` cell's own spread on the full paths.
