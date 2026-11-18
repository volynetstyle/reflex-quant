# Exact witnesses before indexed enumeration

## Protocol

The reference kernel is identical to `0d37b93`. The indexed-only bundle
from `f9c1422` is the previous performance control. The old
`deep-shuffle` has fan-out nine and the target is the last subscriber.
`SCAN` covers the first eight. Verify separately whether the pair is
cheap to find, whether it was accepted in this execution, and how
expensive the remaining address enumeration is.

1. Use the existing source tail as a positive pair certificate. At
   promotion, mark the unread suffix for a head or tail hit. In the
   marked path, check both endpoints before the existing bounded forward
   scan. Keep cursor hits, stable allocations, node shape and edge shape.
   Prediction at width 4096 for fixed head, fixed tail and mixed head/tail
   is zero indexes. The old tail case should reach ≤0.85 of Quant in two
   independent timing jobs. All local timing controls have a 1.03 gate.
2. Isolate `SKIPPED` as a separate variant and combine it with the source
   tail only after checking each separately. At eight swaps the wide
   work should vanish at 1024, 4096 and 8192. This claim is structural.
3. Run fan-outs 4, 8, 9, 16, 32 and 64 with fixed endpoint, boundary
   and interior ranks. Use stationary random ranks per source and a
   separate mixed head/tail case. Once any interior read is beyond all
   endpoint and prefix certificates, an early same-set permutation
   remains eligible for an index.
4. If there is a residual, measure the same tail-aware kernel first
   with the previous vector and then with learning confined to the
   index transaction. Count total edges and unread edges inside the
   existing traversal. Count completion using the final cursor at the
   current tail, not the identity of the old tail. Capture a candidate
   vector in the third qualifying traversal. Use a global capacity policy
   for production-shaped trials. Repeated random interior has a 0.85
   target relative to the tail-aware control. Local controls retain
   the 1.03 gate.

Use checksummed fresh processes, seven randomized paired rounds, byte
identity for A/A, and separate structural counting. Baseline structural
assertions that pin the old resolver choice must be identified individually
if the new proof changes them. A scope-qualified improvement requires
at least two independent runners. Changes belong to experimental source
copies until reviewed against the contract.

## Comparison cells

`tail-window` adds exactly one predecessor of the source tail. It has a
fixed boundary workload at rank 63/64 and an interior control at 33/64.
`transaction` and `resident` both start from `tail-window`. The old vector
remains in two comparison cells, with and without `tail`. Compare the new
vectors to `tail-window` at the same rank and in the same round. Also retain
the comparison to `tail` specified above. Compare `resident` to `transaction`
to isolate the price of filling and clearing slots. Residency can retain
one live index, with a capacity of 8193 edges, and still has to mark unread
relations each time it starts a new pass.

The resident proof covers replacement on idle overlap, LIFO restoration
when the owner is active, and eviction on failure, membership change and
disposal. Its separate runtime checks reflect the changed internal slot
invariant. The other variants are checked with the original at-rest slot
invariant. A fixed random-rank seed is shared across variants and repeated
jobs. It creates a balanced mix of ranks at each tested width.
