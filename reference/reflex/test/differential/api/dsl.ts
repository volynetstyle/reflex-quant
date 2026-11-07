import type {
  DifferentialCase,
  Expr,
  NodeId,
  Value,
  Op,
  Program,
} from "./types";

type BinaryExprType = Extract<Expr, { left: Expr; right: Expr }>["type"];

type IdOpType = Extract<Op, { id: NodeId }>["type"];

export interface WatcherOptions {
  readonly cleanup?: Expr;
}

export interface DifferentialCaseDefinition {
  readonly id: string;
  readonly family: string;
  readonly faultModel?: string;
  readonly operations: readonly Op[];
  readonly meta?: Program["meta"];
}

const binary =
  (type: BinaryExprType) =>
  (left: Expr, right: Expr): Expr => ({
    type,
    left,
    right,
  });

const withId =
  <T extends IdOpType>(type: T) =>
  (id: NodeId): Extract<Op, { type: T }> =>
    ({ type, id }) as Extract<Op, { type: T }>;

export const expr = {
  value: (value: Value): Expr => ({ type: "constant", value }),

  read: (id: NodeId): Expr => ({ type: "read", id }),

  add: binary("add"),
  multiply: binary("multiply"),
  equal: binary("equal"),
  greaterThan: binary("greaterThan"),

  when: (condition: Expr, then: Expr, otherwise: Expr): Expr => ({
    type: "if",
    condition,
    then,
    else: otherwise,
  }),

  fail: (message: string): Expr => ({
    type: "throw",
    message,
  }),
};

export const op = {
  signal: (id: NodeId, value: Value): Op => ({
    type: "signal",
    id,
    value,
  }),

  computed: (id: NodeId, expression: Expr): Op => ({
    type: "computed",
    id,
    expression,
  }),

  watcher: (id: NodeId, expression: Expr, options?: WatcherOptions): Op => ({
    type: "effect",
    id,
    expression,
    ...(options?.cleanup !== undefined && { cleanup: options.cleanup }),
  }),

  set: (id: NodeId, value: Value): Op => ({
    type: "set",
    id,
    value,
  }),

  read: withId("read"),
  dispose: withId("dispose"),

  flush: (): Op => ({ type: "flush" }),
  enterBatch: (): Op => ({ type: "enterBatch" }),
  leaveBatch: (): Op => ({ type: "leaveBatch" }),
};

export function defineProgram(
  id: string,
  operations: readonly Op[],
  meta?: Program["meta"],
): Program {
  return {
    id,
    operations,
    ...(meta !== undefined && { meta }),
  };
}

export function defineCase(
  definition: DifferentialCaseDefinition,
): DifferentialCase {
  return {
    id: definition.id,
    family: definition.family,
    ...(definition.faultModel !== undefined && {
      faultModel: definition.faultModel,
    }),
    program: defineProgram(
      definition.id,
      definition.operations,
      definition.meta,
    ),
  };
}
