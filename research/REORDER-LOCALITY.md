# Reconciliation under permutation

## Preregistered interventions

Baseline `0d37b93`. This protocol precedes timing and construction of a
candidate. Compare paired rounds inside each job. A gap inside the A/A range
is inconclusive. Seven fresh processes per cell, five widths from 512 to
8192, production flags, a separate checksum preflight and sampling GC counts.
The kernel's counters are taken in separate processes.

| Hypothesis and observation it could explain | Observation outside its explanatory scope | Intervention and fixed work | Timing prediction and falsifier |
| --- | --- | --- | --- |
| H1. The serial dependency edge chain makes the large shuffled mark/fill expensive. | Lookup alone has no such chain. | Permute edge birth ranks with source ranks fixed. Enumerate precisely the same random edges by next pointer or address vector, with one version store per edge. | At 4096 the random chain costs at least 20% more than the vector. Equality within A/A weakens serial traversal as the primary cause. |
| H2. Scattering slot destinations accounts for the sweep penalty even with ordered edges. | It cannot explain a mark-only slowdown. | Independently permute edge and source birth ranks in a 2×2 design. Each cell performs two identical edge walks and two slot stores per source. | At 4096 source scatter on ordered edges costs at least 10%. A penalty only on the edge axis favors H1. |
| H3. Waiting for source → edge before the neighbor-dependent splice limits overlap. | It cannot explain the isolated pre-pass. | Same source and edge schedules, moves and version stores. Resolve the edge by a direct vector or the source cell. Separately compare one versus 32 queued lookups using identical scratch loops. | At 4096 direct beats indirect by 10% or more. Tile32 beating tile1 by 10% or more supports scheduling sensitivity. Neither comparison measures an individual CPU stall. |
| H4. Translation footprint is sufficient to produce a knee with fixed useful lines. | A sparse arena says little about actual V8 page layout. | Same random schedule and N active lines, packed or one per 4 KiB page, with balanced in-page offsets. No edge chasing, graph branches or stores. | At 4096 sparse/packed exceeds 1.2. Equality weakens this translation-sensitive model. A penalty does not identify the cause in Quant. |
| H5. Code layout, branch outcomes or GC alone account for the apparent regime change. | Identical code can receive different memory schedules. | Same-bundle A/A, GC during samples, intra-function layout contrasts, reverse and shared versus single-edge lookup controls. | If physical interventions at fixed logical work exceed same-job A/A with zero collections, layout/GC alone are insufficient. Branch misses require PMU evidence. |

The current runtime uses tail proofs on reverse and normally marks on
single-consumer shuffle. The original positive residual is from the earlier
slot machine. The current `index-always` research control restores slots
only on an unresolved miss and still has today's tail fast path.

Candidate decision after localization: if either the dependent-walk or
splice intervention succeeds, test reconstruction of the unread suffix
without online intrusive neighbor removal. Prediction against current
Quant: shuffle@4096 ratio ≤0.85, reverse@4096 and every local control ≤1.05.
An improvement on both global families requires reverse ≤0.85 as well.
Retention, observable order and bounded failure recovery are independent gates.

The splice job in [run 44304013295](https://github.com/volynetstyle/reflex-quant/actions/runs/44304013295/job/134800746932)
has finished. At 4096 the seven round medians give 8.46 ns/source with
addresses supplied and 11.08 through the source slot. A/A gives 10.90.
Tile32 and tile1 give 10.38 and 14.48 respectively. These results trigger
the candidate experiment specified above. Use an execution-local vector
of the **old unread suffix**, mark it once, and append each subsequently
observed edge in read order. Count down the remaining old edges. A complete
permutation then requires zero unread-edge inspections at exit. A partial
pass drains the remaining edges in their original order before the existing
success or failure policy runs. Materialize before escalating to slots.
The implementation will charge the vector and its allocation to the candidate.
