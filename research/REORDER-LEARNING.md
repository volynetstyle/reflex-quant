# Per-consumer learning for dependency reorder

## Preregistered experiment

Baseline `3f297b7`. Use isolated source copies and the same production benchmark
adapters as the previous reorder study. The source of `read` and `exec` must be
byte-identical before bundling, and an original A/A bundle controls for process
noise. The unchanged source cannot guarantee identical optimized V8 code. See
[the earlier physical experiments](./REORDER-LOCALITY.md).

Start observing a consumer after its first expensive suffix mark or slot index.
This event can install a callback wrapper whose first measurement starts on the
next invocation. Count old unread edges recovered by the resolver after the
bounded proofs have failed. A qualifying run finishes successfully, keeps the
same set of relations, recovers at least 32 old edges and has `4k ≥ 3d`. Determine
the frontier size with an exit walk capped by `floor(4k/3)` only when all cheaper
tests qualify. Once a width is known, an unchanged set certifies the same width.
Three consecutive qualifying passes in the same resolver class arm the next
execution. One nonqualifying pass disarms, two remove the wrapper. Failure drops
the observation immediately. This selects dense same-set permutations. It
deliberately treats a large but well-ordered tail run as a cheap proof.

| Variant | Intervention | Predicted result |
| --- | --- | --- |
| Observer | Wrap and score suspected consumers, retaining the ordinary resolver | Virgin stable cases install zero observers. One-off and `swaps-nested@8` arm zero specialized passes. Local families remain within 5% of Quant. |
| Learned reconstruction | Arm the previous array-free backward-thread reconstruction for the next execution. Open it only at a first-subscriber mark. | Private `shuffle@4096` median ≤0.95 of Quant in both repetitions, stable and `swaps-nested@8` ≤1.05. The earlier 15% target still governs a production speedup. |
| Selective witness | For repeatedly indexed consumers retain one vector of exact edges. In the next run use that vector to fill and clear ordinary slots in the same order. Keep the ordinary online relocation. | Indexed `deep-shuffle@4096` median ≤0.90 of Quant in both repetitions. A settled private shuffle retains zero vector cells. Stable and `swaps-nested@8` ≤1.05. |

The witness vector is capped at 8,193 edges per admitted consumer. A nonqualifying
execution discards it. For unchanged membership, vector order can remain fixed
as the actual dependency list changes. The insertion of a new relation cancels
the vector-only cleanup path. The ordinary full-list slot cleanup can then reach
every slot. A failed or disposed consumer also drops learning state. Include
phase changes, failures, nested active slots and self-disposal in the checks.

Measure fresh processes, independent shuffled rounds and A/A within each job.
Test short and wide stability, sparse edits, repeated budget exhaustion,
private shuffle, deep shared shuffle, and a process that runs both stable and
chaotic consumers. Report useful, wasted and retained work independently of
time. Compare the first pass after a phase change separately from steady state.
