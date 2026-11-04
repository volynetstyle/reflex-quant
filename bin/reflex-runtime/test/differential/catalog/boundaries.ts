import type { Op } from "../api";
import { expr, op } from "../api";

/**
 * Behavior the kernel deliberately does not provide. A boundary is not a
 * divergence: SpecRuntime and Reflex agree on every witness, and the witness
 * pins that agreement so neither side starts modelling the policy silently.
 */
export interface ContractBoundary {
  id: string;
  boundary: string;
  consequence: string;
  rule: string;
  decided: string;
  program: readonly Op[];
}

const { signal, computed, watcher, set, flush } = op;

const failingComputed = computed(
  "c",
  expr.when(expr.read("gate"), expr.fail("boom"), expr.value(1)),
);

const F18 = {
  boundary: "failed speculative reads / retry policy",
  consequence:
    "A watcher is not re-entered automatically when a dependency it never successfully observed later becomes readable.",
  rule: "R3: failure does not create new reactive evidence",
  decided:
    "2026-11-01, replacing C4 (2026-10-28): retry after a failed read is userspace policy",
} as const;

export const contractBoundaries: readonly ContractBoundary[] = [
  {
    id: "F18-initial-attempt",
    ...F18,
    program: [
      signal("gate", true),
      failingComputed,
      watcher("w", expr.read("c")),
      flush(),
      set("gate", false),
      flush(),
    ],
  },
  {
    id: "F18-new-branch",
    ...F18,
    program: [
      signal("sel", false),
      signal("gate", true),
      failingComputed,
      watcher("w", expr.when(expr.read("sel"), expr.read("c"), expr.value(0))),
      flush(),
      set("sel", true),
      flush(),
      set("gate", false),
      flush(),
    ],
  },
];
