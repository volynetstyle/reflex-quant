export type Value = number | boolean | string | null;
export type NodeId = string;

export type Expr =
  | { type: "constant"; value: Value }
  | { type: "read"; id: NodeId }
  | {
      type: "add" | "multiply" | "greaterThan" | "equal";
      left: Expr;
      right: Expr;
    }
  | { type: "if"; condition: Expr; then: Expr; else: Expr }
  | { type: "throw"; message: string };

export type Op =
  | { type: "signal"; id: NodeId; value: Value }
  | { type: "computed"; id: NodeId; expression: Expr }
  | { type: "effect"; id: NodeId; expression: Expr; cleanup?: Expr }
  | { type: "set"; id: NodeId; value: Value }
  | { type: "read" | "dispose"; id: NodeId }
  | { type: "flush" | "enterBatch" | "leaveBatch" };

export interface Program {
  readonly id: string;
  readonly operations: readonly Op[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface NormalizedError {
  name: string;
  message: string;
}

export interface EffectEvent {
  effect: NodeId;
  phase: "run" | "cleanup";
  value: Value;
}

export interface Observation {
  value?: Value;
  error?: NormalizedError;
  effects: EffectEvent[];
}

export interface Machine {
  execute(op: Op): Observation;
}

export interface DifferentialCase {
  readonly id: string;
  readonly family: string;
  readonly faultModel?: string;
  readonly program: Program;
}

export interface DifferentialMismatch {
  readonly operationIndex: number;
  readonly operation: Op;
  readonly expected: Observation;
  readonly actual: Observation;
  readonly prefix: readonly Op[];
}

export interface DifferentialResult {
  readonly program: Program;
  readonly expected: readonly Observation[];
  readonly actual: readonly Observation[];
  readonly mismatch: DifferentialMismatch | undefined;
  readonly equivalent: boolean;
}

export interface ExplorationReport {
  readonly total: number;
  readonly equivalent: number;
  readonly divergent: number;
  readonly results: readonly {
    readonly case: DifferentialCase;
    readonly result: DifferentialResult;
  }[];
}

export interface OperationAlignment {
  readonly base: number;
  readonly transformed: number;
}

export interface TransformationMismatch {
  readonly target: "spec" | "reflex";
  readonly baseOperationIndex: number;
  readonly transformedOperationIndex: number;
  readonly base: Observation;
  readonly transformed: Observation;
}

export interface TransformationResult {
  readonly base: DifferentialResult;
  readonly transformed: DifferentialResult;
  readonly specEquivalent: boolean;
  readonly reflexEquivalent: boolean;
  readonly mismatches: readonly TransformationMismatch[];
  /**
   * Aligned pairs where some side observed a value, an error or an effect.
   * Zero means the relation compared only empty observations.
   */
  readonly informativePairs: number;
}
