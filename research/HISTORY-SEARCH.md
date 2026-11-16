# Search strategy: remove one testing assumption at a time

This is a sequence of research domains, not a request for new production
mechanisms. The frozen contract remains the oracle. Each domain must state its
language, admission conditions, explored histories/continuations and bounds.
Results from different domains are reported separately.

| Stage | Assumption challenged | Completion criterion in a stated finite domain | Status |
| --- | --- | --- | --- |
| 1 | One history fully recovers before the next begins | Enumerate all order-preserving operation shuffles; certify exact endpoints; compare every admitted history and explore selected continuation alphabets | Implemented for the LOG 54 domains |
| 2 | Pure callbacks | Independent imperative callback DSL for reads, writes, disposal and nesting in computed/watcher/cleanup; compare composed P5/W3/failure behavior under valid C1 demands | Implemented: 13 witnesses, 60 composed cases and admitted history pairs; found and repaired production F3 defect |
| 3 | Explicit flush | Independent automatic-host model for batching, queue delivery, first-error behavior and watcher construction; histories exercise queue registers and permitted hysteresis | Implemented: actual automatic host, independent Set-queue model, batch/first-error/construction and 1,024-watcher burst histories |
| 4 | Counters far from wrap | Test-only small `ver`/`gen` masks with consistent SETTLE; model versions remain unbounded; several whole cycles explored | Implemented: actual masks 3/7/15; 360 complete words through depth 4 after multi-cycle preludes |
| 5 | Blind selection of representation history | Use internal scar fingerprints only to prioritize spec-equivalent histories; continue until the stated discovery budget saturates | Implemented: feedback-guided bounded genomes; recorded 153 admitted candidates, 34 scars, empirical stagnation stop; 12 continuation words |
| 6 | Trust in the harness | Source-level temporal mutant catalogue, domain-qualified kill scores and distinguishing witnesses | Implemented: 12/12 source seeds killed in named production domains; first differing witness step recorded where available, no globally minimal depth claim |
| 7 | Logical heap is sufficient evidence | Promotion/minor/major collection experiments after graph and retirement audits; release all witness/test-only roots before physical checks | Implemented experiment: 36 endpoint cohorts plus six controls; major reclamation observed, minor-retention attribution inconclusive |
| 8 | Semantic equivalence controls engine cost | Separately measured JIT/shape/value-history experiments with common workloads and repeated warmup | Implemented experiment: five trial groups, three changed prefixes versus fresh; timing and optimization diagnostics in separate children |

Stage 1's domains remain as recorded in LOG 54. Full details, reproduction
commands, the F3 witness and stages 2–8 report links are in
[HISTORY-ADVANCED.md](./HISTORY-ADVANCED.md) and LOG 55. “Implemented” qualifies
the bounded tool/domain, not exhaustiveness over arbitrary programs or a
successful answer to every physical attribution question.

## Rules for moving to the next domain

- Generate equivalence candidates; never assert an algebraic equation merely
  because a transformation has a suggestive name. The spec decides admission.
- Compare each implementation history vertically as well as comparing the
  histories horizontally. An identical wrong result in both worlds is a bug.
- Preserve every implementation path in exhaustive domains. Equal spec states
  may define admissible pairs; they do not authorize pruning future Quant paths.
- A candidate budget or partial BFS level produces an incomplete result. Report
  the actual alphabet, phase sizes, checked paths and completed depth.
- Use implementation fingerprints as search heuristics, never as the semantic
  oracle. Maximal label alternation in LOG 54 is an input-schedule heuristic,
  not the greybox distance metric added in LOG 55.
- Distinguish an intentional adapter fault from a source mutant. Adapter fault
  fixtures validate verdicts and sensitivity; they do not establish a temporal
  mutation score. The separate source catalogue reports seeded, killed,
  surviving, invalid and timed-out mutants and fixes the selected witness domain.

Keep three campaign modes distinct: wide/shallow enumeration, narrow/deep
continuation search, and greybox long-history search. Increasing raw
depth is not a substitute for overlapping different obligations.

## Boundaries of the implemented domains

The original expression callbacks still cannot write or dispose during their
execution, and that adapter still uses explicit flush. Stages 2/3 use a separate
imperative interpreter with program/register state and an independent automatic
host oracle. This bounded language does not admit arbitrary JavaScript. Checkpoint
pair admission requires successful ready states, even though prefix execution
compares failures, open batches and reentrant callbacks along the way.

Both absolute version and generation counters are omitted by semantic
projections. The small-counter experiment uses the same construction and supplies
its own bounded counter-wrap evidence; other negative results cannot inherit a
counter-wrap guarantee from it.

For physical GC, immutable `from`/`to` are an experiment variable, not a reason
to change representation in advance. Controlled histories ask whether aged
retired edges practically add retention through these endpoints when all four
neighbour fields satisfy the retirement protocol. Source/consumer creation
before an edge does not prove a promotion/pretenuring policy. Caller-owned
cached values, callback environments, interpreter maps and witness registries
must be accounted for before attributing collection differences to Quant. In the
recorded experiment the bare WeakRef controls survive every minor request, so
the minor endpoint-retention question remains unanswered.

Engine-history timing is a separate research branch. A persistent cost
difference is not automatically a contract violation; structural envelopes
continue to decide resource/asymptotic correctness.
