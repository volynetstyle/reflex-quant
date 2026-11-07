## Pull Stabilization

Reflex uses a **single-load, edge-local pull algorithm** to determine whether a
consumer must recompute.

The algorithm separates three responsibilities:

- **dependency state** tells us whether a branch requires stabilization;
- **dependency proof** stabilizes exactly one causal branch;
- **consumer policy** decides whether the accumulated evidence requires recomputation.

This keeps traversal mechanics independent from consumer state and makes every
user-code execution boundary explicit.

### Dependency proof

```text
PULL-DIRTY-DEPENDENCY(edge, dependency, observedState):

    if observedState contains CHANGED:
        return ADVANCE(dependency, edge)

    firstInput ← dependency.firstInput

    if firstInput exists:
        return PULL-BRANCH(
            parentEdge = edge,
            node       = dependency,
            firstEdge  = firstInput
        )

    return ADVANCE(dependency, edge)
```

A dirty dependency therefore has only three semantic cases:

```text
                     dirty dependency
                           │
               ┌───────────┴───────────┐
               │                       │
            CHANGED                 UNKNOWN
               │                       │
            advance          ┌─────────┴─────────┐
                             │                   │
                           leaf                branch
                             │                   │
                          advance              descend
```

`observedState` is the state already loaded by the caller. The proof does not
reload it.

This gives the dispatch a stable meaning:

```text
CHANGED          → advance
UNKNOWN + leaf   → advance
UNKNOWN + inputs → descend
```

The operation may execute user code. Its return boundary is therefore a
**reentrancy barrier**.

---

### Consumer policy

```text
SHOULD-RECOMPUTE(node, firstEdge):

    if node contains CHANGED:
        return true

    edge ← firstEdge

    loop:
        dependency ← edge.source
        state      ← dependency.state      // single state load

        assert dependency is not COMPUTING

        if state contains DIRTY:

            if PULL-DIRTY-DEPENDENCY(edge, dependency, state):
                return true

            // Dirty stabilization may have executed user code.
            // Re-observe root execution evidence after the barrier.
            if node contains CHANGED:
                return true

        next ← edge.nextInput

        if next does not exist:
            remove UNKNOWN from node
            return false

        edge ← next
```

Conceptually:

```text
                         root
                          │
                    already CHANGED?
                    ┌─────┴─────┐
                   yes          no
                    │            │
                  true       inspect edge
                                 │
                         load dependency state
                                 │
                       ┌─────────┴─────────┐
                       │                   │
                     clean               dirty
                       │                   │
                       │             stabilize branch
                       │                   │
                       │          ┌────────┴────────┐
                       │        changed           stable
                       │          │                 │
                       │        true        reentrant root
                       │                         CHANGED?
                       │                    ┌───────┴───────┐
                       │                   yes              no
                       │                    │                │
                       │                  true          next edge
                       │                                     │
                       └─────────────────────────────────────┘

                           no remaining edges
                                  │
                       stable dependency frontier
                                  │
                          clear root UNKNOWN
                                  │
                                false
```

### Core invariants

**Single-load dispatch**

```text
dependency.state is observed once per edge and that observation determines
the complete stabilization path for that dependency.
```

**Edge-local proof**

```text
PULL-DIRTY-DEPENDENCY answers only:

    "Did this dependency branch prove a semantic change?"

It does not decide consumer policy.
```

**Explicit reentrancy**

```text
clean edge
    → no user code
    → no reentrancy barrier

dirty proof
    → may execute user code
    → root state must be observed again
```

**Stable-frontier discharge**

```text
UNKNOWN may be removed from the consumer only after every dependency edge
has produced a stable proof.
```

**Short-circuit propagation**

```text
the first dependency that proves change terminates the scan.
```

The resulting kernel is intentionally small:

```text
observe → classify → stabilize → validate reentrancy → continue
```

Traversal complexity lives in branch stabilization. Consumer policy remains a
small state machine over edge-local proofs.