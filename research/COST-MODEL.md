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

## Timing results

Pending the CI job `cost`. Local single-round runs only checked that every
probe and report works; per SPEC they are not evidence.
