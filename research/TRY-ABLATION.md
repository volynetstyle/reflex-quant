# Removing exception handling: local ablation

This is an exploratory measurement, not CI performance evidence and not an
admissible replacement for the runtime. The experiment removes every
`try/catch` and `try/finally` from an isolated copy of `src`; it leaves
the normal-execution statements in place and discards the recovery paths.
The now-unused `fail` helper and `unlinkSub` import are removed so the copy
still typechecks. The production runtime and its contract remain unchanged;
the isolated ablated copy intentionally violates the error-recovery guarantees.

## Method and limitations

- 2026-11-14, Node v25.2.0, V8 14.1.146.11-node.13, 12th Gen Intel(R) Core(TM) i5-1235U, win32 10.0.19045 x64.
- [try-ablation.mjs](try-ablation.mjs) builds both versions with the same
  production flags as `bench/build.mjs`. The baseline bundle was verified
  byte-for-byte equal to that script's Quant bundle.
- All 44 workloads produced matching checksums for both versions over 64 steps. Each
  measurement runs `bench/worker.mjs` in a fresh process: at least 300 ms
  warm-up, followed by the median of 21 calibrated batches. Five rounds run
  both versions in shuffled order.
- Values below are median nanoseconds per step, with the minimum and maximum
  round values in parentheses. Positive change means slower without handling.
  Raw samples are in `.cache/try-ablation/results.json` after the run.
- The equally weighted geometric mean of the 44 ratios is 0.36%
  slower without handling. In 43 of 44 cases the five-round ranges overlap;
  ranges are descriptive, not a significance test. These local results do not
  establish a general speedup or regression; controlled CI measurements are
  needed for performance claims.

To repeat (this regenerates only the experimental copy and cache):

```powershell
node research/try-ablation.mjs --rounds 5
```

## Correctness

Both source trees typecheck. On the original runtime, the semantic test file
passes 42/42 in development and 36/36 in production (six development-only
tests are skipped). Isolated tests against the altered copy expose violations:

- F1: after a computed throws, its next read reports `Cycle detected` rather
  than retrying. The same test passes against the original production runtime.
- F5: a failing watcher prevents a later queued watcher from running; a failing
  batch body also prevents a deferred watcher from running.
- W5: a throwing first effect run leaves a subscription in the graph.

These witnesses show that this ablation does not satisfy Quant's contract.
They do not prove that `try/catch` is the only possible implementation of
those guarantees.

## Graph scenarios

| Scenario               |   Before, ns/step (range) | Without handling, ns/step (range) | Change |
| ---------------------- | ------------------------: | --------------------------------: | -----: |
| static.read-clean      |    1100.9 (1065.0–1137.6) |            1137.1 (1068.0–1159.5) |  +3.3% |
| static.chain-100       |    1875.1 (1812.9–1901.6) |            1839.1 (1778.8–1950.8) |  -1.9% |
| stable.wide-8          |          59.0 (55.7–61.8) |                  57.9 (56.4–60.2) |  -1.9% |
| stable.wide-256        |    1162.8 (1088.2–1322.4) |            1189.0 (1161.9–1269.5) |  +2.3% |
| diamond.8x8            |    1684.7 (1623.1–1751.8) |            1641.5 (1598.9–1684.1) |  -2.6% |
| fan-in.1024            |    4769.2 (4271.7–5077.3) |            4658.4 (4185.4–4963.2) |  -2.3% |
| fan-out.effects-1000   | 17360.1 (15894.6–18799.4) |         17480.5 (15816.9–18307.8) |  +0.7% |
| fan-out.computeds-1000 | 22310.0 (21657.0–22967.0) |         23642.2 (21871.7–25350.6) |  +6.0% |
| branch.switch-100      |    4957.8 (4856.2–5345.1) |            4959.5 (4714.4–5134.2) |  +0.0% |
| edit.insert-one-256    |    1184.9 (1146.2–1316.7) |            1216.1 (1163.0–1348.1) |  +2.6% |
| reorder.reverse-8      |       110.2 (106.9–119.1) |               111.7 (110.1–119.7) |  +1.4% |
| reorder.rotate-256     |    1114.3 (1073.2–1267.6) |            1144.8 (1045.3–1391.6) |  +2.7% |
| value-sort.256x32      | 52396.5 (43414.1–55548.8) |         55532.8 (45100.8–56463.7) |  +6.0% |
| replace-half.256       |    3247.8 (2994.3–3319.3) |            3273.5 (3049.5–3650.3) |  +0.8% |
| shared-chaotic.64x32   | 34359.8 (31233.8–36551.4) |         33056.4 (32001.2–33675.6) |  -3.8% |
| long-reorder.256       |    3474.1 (3164.9–3843.9) |            3722.7 (3298.6–3924.7) |  +7.2% |
| batch.writes-32        |       329.9 (301.9–336.4) |               348.3 (294.3–352.8) |  +5.6% |
| lifecycle.mount-100    | 11855.8 (10538.3–12292.4) |         11776.9 (11385.9–12925.6) |  -0.7% |

## Mechanism scenarios

| Scenario                       |   Before, ns/step (range) | Without handling, ns/step (range) | Change |
| ------------------------------ | ------------------------: | --------------------------------: | -----: |
| read.signal                    |       377.7 (359.5–388.0) |               393.7 (390.1–435.5) |  +4.2% |
| read.computed-clean            |    1131.9 (1070.1–1143.0) |            1083.3 (1060.1–1125.5) |  -4.3% |
| write.no-subscribers           |    1659.9 (1641.5–1795.2) |            1667.5 (1521.4–2217.4) |  +0.5% |
| write.same-value               |       326.3 (301.1–381.6) |               322.4 (302.3–330.4) |  -1.2% |
| track.stable-1                 |          16.1 (15.8–16.7) |                  16.0 (14.9–16.8) |  -0.8% |
| track.stable-64                |       241.3 (226.7–264.3) |               248.0 (230.6–252.3) |  +2.8% |
| track.duplicate-64             |       175.4 (173.2–179.2) |               181.0 (174.8–203.9) |  +3.2% |
| track.swap-1                   |          45.9 (43.4–46.9) |                  45.5 (44.6–46.4) |  -0.8% |
| track.swap-32                  |       692.4 (618.5–695.2) |               633.9 (625.2–711.6) |  -8.4% |
| track.fresh-after-reorder-64   |    2274.7 (2120.5–2340.4) |            2214.8 (2164.8–2509.2) |  -2.6% |
| track.link-shared-1            |          58.9 (53.2–59.0) |                  60.3 (55.1–67.8) |  +2.4% |
| track.link-fanout-256          | 12290.2 (12008.7–12709.3) |         12138.8 (11478.9–13107.0) |  -1.2% |
| track.replace-all-256          |    6497.6 (5730.8–6948.2) |            6770.3 (6136.4–7051.9) |  +4.2% |
| track.new-sources-64           |    4161.4 (3998.2–4307.4) |            4200.4 (3859.1–5313.5) |  +0.9% |
| push.chain-cutoff-100          |       815.5 (778.9–835.2) |               790.7 (741.7–845.8) |  -3.0% |
| push.effects-1000              | 17399.8 (16637.2–18515.6) |         16518.5 (16107.3–17782.8) |  -5.1% |
| pull.recompute-chain-100       |    1652.2 (1604.6–1785.1) |            1606.5 (1546.5–1671.6) |  -2.8% |
| pull.validate-wide-256         |      924.3 (699.4–1113.3) |              988.1 (753.5–1086.8) |  +6.9% |
| pull.diamond-1000              | 19416.0 (17648.6–20024.2) |         18220.9 (17859.2–18819.5) |  -6.2% |
| effect.rerun-1                 |          22.8 (22.3–23.4) |                  22.9 (22.6–23.1) |  +0.4% |
| effect.through-computed        |          42.5 (40.3–46.7) |                  42.4 (40.5–43.9) |  -0.2% |
| batch.coalesce-64              |       556.0 (517.4–704.3) |               553.0 (513.9–600.1) |  -0.6% |
| batch.empty                    |    2552.5 (2428.8–2769.8) |            2574.0 (2471.3–2636.9) |  +0.8% |
| lifecycle.signal-create        |    1177.3 (1114.5–1455.7) |            1179.0 (1083.2–1289.1) |  +0.1% |
| lifecycle.computed-create      |    3499.4 (3448.0–4158.5) |            3616.0 (3338.8–4295.9) |  +3.3% |
| lifecycle.effect-mount-dispose |    4910.9 (4585.4–5565.3) |            4926.2 (4622.7–5976.8) |  +0.3% |
