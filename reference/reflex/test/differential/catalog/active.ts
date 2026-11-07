import type { Observation, Op } from "../api";

export interface ActiveDivergence {
  id: string;
  boundary: string;
  severity: "high" | "critical";
  consequence: string;
  discoveredBy: string;
  operationIndex: number;
  expected: Observation;
  actual: Observation;
  program: readonly Op[];
}

/**
 * Known, unfixed SpecRuntime/Reflex mismatches. Empty: F18 was reclassified
 * as a contract boundary on 2026-11-01 (catalog/boundaries.ts).
 */
export const activeDivergences: readonly ActiveDivergence[] = [];
