import { compare } from "./differential";
import type { DifferentialCase, ExplorationReport } from "./types";

export function explore(cases: readonly DifferentialCase[]): ExplorationReport {
  const results = cases.map((candidate) => ({
    case: candidate,
    result: compare(candidate.program),
  }));
  const divergent = results.filter(({ result }) => !result.equivalent).length;

  return {
    total: results.length,
    equivalent: results.length - divergent,
    divergent,
    results,
  };
}
