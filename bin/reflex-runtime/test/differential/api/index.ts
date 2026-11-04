export {
  defineCase,
  defineProgram,
  expr,
  op,
  type DifferentialCaseDefinition,
  type WatcherOptions,
} from "./dsl";
export { assertEquivalent, compare } from "./differential";
export { explore } from "./explore";
export {
  compareTransformation,
  type TransformationComparison,
} from "./metamorphic";
export type {
  DifferentialCase,
  DifferentialMismatch,
  DifferentialResult,
  ExplorationReport,
  Value,
  NodeId,
  Expr,
  Op,
  Program,
  Observation,
  EffectEvent,
  Machine,
  OperationAlignment,
  TransformationMismatch,
  TransformationResult,
} from "./types";
