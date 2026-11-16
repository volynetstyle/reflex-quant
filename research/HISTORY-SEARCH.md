# Search strategy: remove one testing assumption at a time

This is a sequence of research domains, not a request for new production
mechanisms. The frozen contract remains the oracle. Each domain must state its
language, admission conditions, explored histories/continuations and bounds.
Results from different domains are reported separately.

| Stage | Assumption challenged | Completion criterion in a stated finite domain | Status |
| --- | --- | --- | --- |
| 1 | One history fully recovers before the next begins | Enumerate all order-preserving operation shuffles; certify exact endpoints; compare every admitted history and explore selected continuation alphabets | Implemented for the LOG 54 domains |
| 2 | Pure callbacks | Independent imperative callback DSL for reads, writes, disposal and nesting in computed/watcher/cleanup; compare composed P5/W3/failure behavior under valid C1 demands | Pending |
| 3 | Explicit flush | Independent automatic-host model for batching, queue delivery, first-error behavior and watcher construction; histories exercise queue registers and permitted hysteresis | Pending |
| 4 | Counters far from wrap | Test-only small `ver`/`gen` masks with consistent SETTLE; model versions remain unbounded; several whole cycles explored | Pending |
| 5 | Blind selection of representation history | Use internal scar fingerprints only to prioritize spec-equivalent histories; continue until the stated discovery budget saturates | Pending |
| 6 | Trust in the harness | Source-level temporal mutant catalogue, domain-qualified kill scores and distinguishing depths | Pending; cross-cutting across all stages |
| 7 | Logical heap is sufficient evidence | Promotion/minor/major collection experiments after graph and retirement audits; release all witness/test-only roots before physical checks | Pending |
| 8 | Semantic equivalence controls engine cost | Separately measured JIT/shape/value-history experiments with common workloads and repeated warmup | Pending |

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
  not the future greybox distance metric.
- Distinguish an intentional adapter fault from a source mutant. Current fault
  fixtures validate verdicts and sensitivity; they do not establish a temporal
  mutation score. Future mutation work must report seeded, killed, surviving,
  invalid and out-of-domain mutants explicitly.

Keep three campaign modes distinct: wide/shallow enumeration, narrow/deep
continuation search, and future greybox long-history search. Increasing raw
depth is not a substitute for overlapping different obligations.

## Boundaries that remain after stage 1

The current expression callbacks still cannot write or dispose during their own
execution, and the adapter still uses explicit flush. Stage 2 needs an independent
imperative interpreter and program/register state in the projection; arbitrary
JavaScript callbacks would destroy that boundary. Stage 3 needs a real host
oracle: the existing interpreter's flush loop is not an automatic scheduler or
an implementation of the host's F5/W5 obligations.

Both absolute version and generation counters are omitted by current projections.
No counter-wrap claim follows from their bounded results. Small counters must be
an instrumented version of the same construction, not an unrelated mini-runtime.

For physical GC, immutable `from`/`to` are an experiment variable, not a reason
to change representation in advance. Controlled histories must ask whether aged
retired edges practically add retention through these endpoints when all four
neighbour fields satisfy the retirement protocol. Source/consumer creation
before an edge does not prove a promotion/pretenuring policy. Caller-owned
cached values, callback environments, interpreter maps and witness registries
must be accounted for before attributing collection differences to Quant.

Engine-history timing remains a separate research branch. A persistent cost
difference is not automatically a contract violation; structural envelopes
continue to decide resource/asymptotic correctness.
