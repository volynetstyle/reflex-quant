# AGENTS.md

Quant is the minimal runtime that **follows from the Quant contract** (invariants and structural bounds in [SPEC.md](SPEC.md)). This is the research framing; do not break it.

## Inclusion criterion

A mechanism enters the core only if, without it:

1. the semantic contract is violated, **or**
2. a provable structural/asymptotic problem arises.

If neither is shown, the mechanism is not included.

## Not a valid reason

- "Alien Signals supports it."
- "Vue uses it."
- "It's convenient."

That is collecting other runtimes' solutions, not minimizing. It turns derivation into imitation.

## Consequence

`effectScope`, nested ownership, `trigger()`, transactional pending writes and the like may be good designs, but they answer **different questions**. Do not add them to Quant until it is shown that the contract or the asymptotics break without them.

## Details

The contract itself and full rules (invariants, layer boundaries, admission checklist, optimizations vs. conventions, change classification, research workflow) are in [SPEC.md](SPEC.md).
