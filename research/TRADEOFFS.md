# Trade-offs of LOG 47–49 under load

Each of LOG 47 (deferred skipped edge, tail scan), LOG 48 (ring queue) and
LOG 49 (source-side absence, `near` split) accepted a cost somewhere. This
note measures each cost along the axis where it could grow, so that "+10 % on
one probe" can be read as either a constant or a trend.

**Probes:** `bench/tradeoffs.mjs` (`--suite tradeoffs`), 9 families, 50
cells; checksums equal on quant, Reflex and alien-signals.
**Versions:** old main `80c5b47` (before LOG 47/48), main `3b83deb` (LOG 47
+ 48), LOG 49 (`perf/source-absence`).
**Structure:** kernel counters per step (64 steps after 32), machine
independent. **Timing:** local, Node 22.23.5, i5-1235U, 5–7 rounds, a fresh
process per cell; ratios, not CI evidence.

## Summary

| compromise | axis | structure, new vs old | time, LOG 49 / old | trend |
| --- | --- | --- | --- | --- |
| absent source, > 2 subscribers (`link-fanout`) | readers N = 16..4096 | identical | 1.13–1.22 | flat: ~6 ns per relink; at Reflex parity (Reflex 1.17–1.23) |
| absent source, 3 subscribers, long list (`replace-all-k3`) | sources N = 16..1024 | identical | 1.16–1.26 | flat: tail scan + `near` call per read |
| absent source, ≤ 2 subscribers (`replace-all-k1`, `link-subs` S ≤ 2) | N, S | no lookup | 0.51–0.64 | flat win |
| adjacent swap = 2 misses (`swaps`) | swaps per pass k = 1..256, L = 1024 | 2k misses, was k | 0.93 → 1.07 → 1.09 → 1.27 → **1.56** | **grows with k**: ~17 ns per swap, was ~4 |
| > TAIL skipped edges read back oldest first (`swaps-nested`) | nesting k = 1..128 | k = 3..8: one mark sweep (~380 edges per step), was k misses | 1.01, 1.13, **1.18–1.21** (k = 3..8), 1.11–1.14 | bounded: one linear sweep per pass; from k = 32 every version marks |
| move by d (`move-earlier`, `move-later`) | d = 1..256 | ≤ 2 misses, was d + 1 per two passes | 0.83–1.0 | old grows with d, new flat |
| ring give-back (`burst-waves`) | wave W = 256..16384, then 4 waves of 1 | (host) | 0.55–0.70 vs old; **1.18–1.47 vs the ring without give-back** | **grows with W**: every burst regrows the ring |
| small waves (`burst-waves` W = 256) | | (host) | 1.14–1.16 | constant, also without give-back |

Pre-existing, not from LOG 47–49: an absent source with more than SCAN
subscribers read by a long list (`link-subs` S ≥ 8) indexes the pass (34
edges walked per step) on every version; Reflex is 0.71–0.77 of quant there.

## Families

**link-fanout** (N readers switch between a and b). LOG 49's source check
costs three loads that prove nothing once a source has three or more
subscribers, and the scans then cost a call. Per step: old 0.69, 2.58,
10.9, 44.2, 185 µs; LOG 49 0.79, 3.15, 12.9, 50.7, 209 µs. The ratio does
not move with N.

**replace-all** (one reader switches between two sets of N sources, each
with K other readers). K = 1: proven absent from the source, 0.54–0.64 of
old at every N. K = 3: the tail scan and the `near` call on every read,
1.16–1.26 of old at every N (main alone: 1.10–1.18).

**swaps** (k disjoint adjacent swaps per pass in 1,024 sources). The only
LOG 47 cost whose ratio grows with load. A swap is two misses: the first
pays the failed tail scan in `miss`, the call to `near`, the one-hop find
and `skipDep`; the second finds the deferred edge at the very end. Per swap
~17 ns against ~4 ns before. At k = 256 quant is 1.8x Reflex (was 1.2x).

**swaps-nested** (a window of 2k read odd positions first, then even).
After three skips the oldest deferred edge is no longer within TAIL (2) of
the end, so the pass marks its suffix: one walk of the suffix where k
misses used to do. Bounded by one sweep per pass. TAIL = 8 removes the
sweep up to k = 8 (1.05–1.19) but costs every miss that the tail does not
settle: replace-all-k3 1.33–1.42, swaps@256 1.75. Rejected.

**move-earlier / move-later** (one source moved d places, alternating
with the plain order). Old: d + 1 misses per two passes (the move back is a
move later by d). New: at most 2, independent of d. From d = 16 every
version marks one pass in two (the forward scan cannot reach); the cost of
that is the same everywhere.

**burst-waves** (a write reaching W effects, then four writes reaching one).
Every small drain gives the ring back (taken < capacity / 4), so every big
wave doubles it again from KEEP, copying. Without the give-back: W = 1,024
0.82 of the ring with it, W = 4,096 0.74, W = 16,384 0.68; at Reflex parity
or better (0.41 vs 0.41, 0.39 vs 0.48 of old). Steady waves
(`fan-out-effects`) do not pay it. Small waves cost about 3 ns more per
delivery than the old linear queue, with or without give-back.

## What the data asks for

1. **Swaps** (growing): make the first miss of a swap cheap or make a swap
   one miss again. The tail scan stands before the one-hop test only so that
   short lists do not cascade (LOG 47); a one-hop test first, then the
   tail, is the candidate. A swap could also stay one miss if a skipped
   edge were deferred only when it blocks a second read (a skip marker on
   the edge).
2. **Ring give-back** (growing): shrink with hysteresis in drains, not on
   the first small drain, so alternating bursts keep their ring while a
   one-off burst is still given back.
3. **Absent sources with 3+ subscribers** (flat, 13–26 %): the price of
   LOG 47's tail and LOG 49's split. Acceptable unless a cheaper proof of
   absence for many subscribers appears.
4. **Nested skips past TAIL** (bounded): leave as is; TAIL = 8 costs more
   than it saves.

## After LOG 50

The two growing costs were taken back; nothing else moved beyond spread
(local, Node 22, ratio to the pre-LOG 47 kernel, 5–7 rounds).

| family | LOG 49 | LOG 50 | Reflex |
| --- | ---: | ---: | ---: |
| swaps@1..256 | 1.08, 1.10, 1.10, 1.27, 1.61 | 1.02, 1.00, 0.97, 1.01, 1.04 | 0.86–0.92 |
| burst-waves@1024..16384 | 0.67, 0.54, 0.63 | 0.56, 0.41, 0.44 | 0.56, 0.42, 0.51 |
| swaps-nested@3 / @4 / @8 | 1.24 / 1.06 / 1.23 | 1.06 / 0.99 / 1.19 | |
| rotate-256, insert-one-256 | 0.42, 0.60 | 0.42, 0.64 | |
| reverse@64, @1024 | 0.89, 0.86 | 0.92, 0.90 | |

A swap is one miss again and pays neither the tail scan nor a call; a
rotation or a deletion is two misses instead of one, independent of the
list. Nested skips past TAIL mark the pass from k = 6 (LOG 49: k = 3; before
LOG 47: k = 9), bounded by one sweep. A reversed read pays one more failed
comparison (the one-past-`next` test now stands before the tail scan).
Unchanged and flat: absent sources with three or more subscribers
(`link-fanout`, `replace-all-k3`, 1.12–1.28), small effect waves (LOG 48,
about 3 ns per delivery).

