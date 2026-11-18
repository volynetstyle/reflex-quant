# Selective witness on the slot path

Preregistered after CI [44387697094](https://github.com/volynetstyle/reflex-quant/actions/runs/44387697094).
The initial vector ran at 0.779 and 0.778 of Quant on `deep-shuffle@4096`.
It also trained ordinary first-subscriber consumers even though those
consumers could never install the vector. Remove that unnecessary observation.

Keep the same thresholds, warm-up, per-consumer cap, and witness vector.
Enroll only on slot indexing with an unread suffix. Count old moves
at the successful slot hit. Keep `begin` and `take` identical to Quant,
as well as `read` and `exec`. No vector or probation can be granted by
the first-subscriber mark alone. The independent `SKIPPED` probe stays
outside this comparison.

Compare two independent seven-round jobs per workload group with the
ordinary Quant and a byte-identical A/A. Keep the first vector as a control
on deep, mixed, and private shuffle. Predictions fixed before implementation:

- At `deep-shuffle@4096`, indexed-only witness ≤0.85 of Quant in both repeats.
- At `lb.shuffle@4096` and `mixed@512`, indexed-only witness ≤1.05
  in both repeats and no first-subscriber enrollment.
- Each local timing control ≤1.05. The untrained stable and sparse path
  shows no additional frontier work. Report same-bundle A/A noise.

Admission remains specific to measured regimes. Use the full existing
contract suites and the trained-state graph witnesses.
