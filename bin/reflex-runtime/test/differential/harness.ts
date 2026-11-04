export { SpecMachine } from "./internal/machine/SpecMachine";
export { ReflexMachine } from "./internal/machine/ReflexMachine";
export {
  DifferentialError,
  observationsEqual,
  evaluate,
  normalizeError,
  format,
} from "./internal/machine/eval";
export type {
  Value,
  NodeId,
  Expr,
  Op,
  NormalizedError,
  EffectEvent,
  Observation,
  Machine,
} from "./api/types";

import type { Op, Observation } from "./api/types";
import { assertEquivalent } from "./api/differential";

export function executeDifferential(program: readonly Op[]): Observation[] {
  return [...assertEquivalent({ id: "legacy", operations: program })];
}
