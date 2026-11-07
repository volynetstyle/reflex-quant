import { resetRuntimeContext } from "../../src";
import {
  executeDifferential,
  type Expr,
  type NodeId,
  type Op,
} from "./harness";
import {
  defaultBoundedLanguage,
  type BoundedLanguage,
} from "./catalog/bounded-language";
import type { BoundedExhaustiveReport } from "./api/reports";
export { defaultBoundedLanguage, boundedValueDomain } from "./catalog/bounded-language";
export type { BoundedLanguage } from "./catalog/bounded-language";
export type { BoundedExhaustiveReport } from "./api/reports";
import type { QualificationProgram } from "./mutant/mutation-qualification";

/* export interface BoundedLanguage {
  maxProducers: 1 | 2;
  maxComputeds: 0 | 1;
  maxWatchers: 0 | 1;
  maxActions: number;
  values: readonly [false, true];
  expressionDepth: 2;
}

export const defaultBoundedLanguage: BoundedLanguage = {
  maxProducers: 2,
  maxComputeds: 1,
  maxWatchers: 1,
  maxActions: 2,
  values: [false, true],
  expressionDepth: 2,
}; */

/* export interface BoundedExhaustiveReport {
  language: BoundedLanguage;
  canonicalPrograms: number;
  executedPrograms: number;
  executedOperations: number;
  divergences: 0;
} */

interface Topology {
  setup: Op[];
  producers: NodeId[];
  readable: NodeId[];
  activeWatcher: boolean;
}

export function enumerateBoundedPrograms(
  language: BoundedLanguage = defaultBoundedLanguage,
): QualificationProgram[] {
  const canonicalPrograms = new Map<string, readonly Op[]>();

  for (
    let producerCount = 1;
    producerCount <= language.maxProducers;
    producerCount += 1
  ) {
    const producers = Array.from(
      { length: producerCount },
      (_value, index) => "p" + index,
    );

    for (const initialValues of tuples(language.values, producerCount)) {
      const signals: Op[] = producers.map((id, index) => ({
        type: "signal",
        id,
        value: initialValues[index]!,
      }));
      const computedExpressions =
        language.maxComputeds === 0
          ? [undefined]
          : [undefined, ...boundedExpressions(producers)];

      for (const computedExpression of computedExpressions) {
        const computed: Op[] =
          computedExpression === undefined
            ? []
            : [
                {
                  type: "computed",
                  id: "c0",
                  expression: computedExpression,
                },
              ];
        const readable = [
          ...producers,
          ...(computedExpression === undefined ? [] : ["c0"]),
        ];
        const watcherVariants: Array<
          { expression: Expr; cleanup?: Expr } | undefined
        > = [undefined];

        if (language.maxWatchers !== 0) {
          for (const id of readable) {
            watcherVariants.push({ expression: read(id) });
            for (const producer of producers) {
              watcherVariants.push({
                expression: read(id),
                cleanup: read(producer),
              });
            }
          }
        }

        for (const watcher of watcherVariants) {
          const effect: Op[] =
            watcher === undefined
              ? []
              : [
                  {
                    type: "effect",
                    id: "w0",
                    expression: watcher.expression,
                    ...(watcher.cleanup === undefined
                      ? {}
                      : { cleanup: watcher.cleanup }),
                  },
                ];
          const topology: Topology = {
            setup: [...signals, ...computed, ...effect],
            producers,
            readable,
            activeWatcher: watcher !== undefined,
          };

          enumerateActions(
            topology,
            language,
            canonicalPrograms,
            topology.setup,
            0,
          );
        }
      }
    }
  }

  return [...canonicalPrograms.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, program], index) => ({
      name: "bounded-" + index + "-" + stableHash(key),
      program,
    }));
}

export function verifyBoundedEquivalence(
  programs: readonly QualificationProgram[],
  language: BoundedLanguage = defaultBoundedLanguage,
): BoundedExhaustiveReport {
  let executedOperations = 0;

  for (const candidate of programs) {
    resetRuntimeContext();
    executeDifferential(candidate.program);
    executedOperations += candidate.program.length;
  }

  return {
    language,
    canonicalPrograms: programs.length,
    executedPrograms: programs.length,
    executedOperations,
    divergences: 0,
  };
}

function enumerateActions(
  topology: Topology,
  language: BoundedLanguage,
  programs: Map<string, readonly Op[]>,
  program: readonly Op[],
  actionCount: number,
): void {
  const key = canonicalProgramKey(program, topology.producers);
  if (!programs.has(key)) programs.set(key, program);

  if (actionCount === language.maxActions) return;

  const actions: Array<{ operation: Op; activeWatcher: boolean }> = [
    { operation: { type: "flush" }, activeWatcher: topology.activeWatcher },
  ];

  for (const id of topology.producers) {
    for (const value of language.values) {
      actions.push({
        operation: { type: "set", id, value },
        activeWatcher: topology.activeWatcher,
      });
    }
  }

  for (const id of topology.readable) {
    actions.push({
      operation: { type: "read", id },
      activeWatcher: topology.activeWatcher,
    });
  }

  if (topology.activeWatcher) {
    actions.push({
      operation: { type: "dispose", id: "w0" },
      activeWatcher: false,
    });
  }

  for (const action of actions) {
    enumerateActions(
      { ...topology, activeWatcher: action.activeWatcher },
      language,
      programs,
      [...program, action.operation],
      actionCount + 1,
    );
  }
}

function boundedExpressions(producers: readonly NodeId[]): Expr[] {
  const expressions: Expr[] = producers.map(read);

  for (let left = 0; left < producers.length; left += 1) {
    for (let right = left; right < producers.length; right += 1) {
      expressions.push({
        type: "equal",
        left: read(producers[left]!),
        right: read(producers[right]!),
      });
    }
  }

  for (const condition of producers) {
    for (const whenTrue of producers) {
      for (const whenFalse of producers) {
        expressions.push({
          type: "if",
          condition: read(condition),
          then: read(whenTrue),
          else: read(whenFalse),
        });
      }
    }
  }

  return expressions;
}

function tuples<T>(values: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  const suffixes = tuples(values, size - 1);
  return values.flatMap((value) =>
    suffixes.map((suffix) => [value, ...suffix]),
  );
}

function canonicalProgramKey(
  program: readonly Op[],
  producers: readonly NodeId[],
): string {
  const identity = serializeProgram(program);
  if (producers.length !== 2) return identity;

  const swapped = program.map((operation) =>
    renameOperation(
      operation,
      new Map([
        ["p0", "p1"],
        ["p1", "p0"],
      ]),
    ),
  );
  const declarationCount = swapped.findIndex(
    (operation) => operation.type !== "signal",
  );
  const split = declarationCount === -1 ? swapped.length : declarationCount;
  const normalized = [
    ...swapped.slice(0, split).sort((left, right) => {
      const leftId = "id" in left ? left.id : "";
      const rightId = "id" in right ? right.id : "";
      return leftId.localeCompare(rightId);
    }),
    ...swapped.slice(split),
  ];
  const renamed = serializeProgram(normalized);
  return identity < renamed ? identity : renamed;
}

function renameOperation(
  operation: Op,
  names: ReadonlyMap<string, string>,
): Op {
  const id = "id" in operation ? (names.get(operation.id) ?? operation.id) : "";

  switch (operation.type) {
    case "signal":
      return { ...operation, id };
    case "computed":
      return {
        ...operation,
        id,
        expression: renameExpression(operation.expression, names),
      };
    case "effect":
      return {
        ...operation,
        id,
        expression: renameExpression(operation.expression, names),
        ...(operation.cleanup === undefined
          ? {}
          : { cleanup: renameExpression(operation.cleanup, names) }),
      };
    case "set":
    case "read":
    case "dispose":
      return { ...operation, id };
    case "flush":
    case "enterBatch":
    case "leaveBatch":
      return operation;
  }
}

function renameExpression(
  expression: Expr,
  names: ReadonlyMap<string, string>,
): Expr {
  switch (expression.type) {
    case "constant":
    case "throw":
      return expression;
    case "read":
      return { ...expression, id: names.get(expression.id) ?? expression.id };
    case "if":
      return {
        type: "if",
        condition: renameExpression(expression.condition, names),
        then: renameExpression(expression.then, names),
        else: renameExpression(expression.else, names),
      };
    default:
      return {
        type: expression.type,
        left: renameExpression(expression.left, names),
        right: renameExpression(expression.right, names),
      };
  }
}

function serializeProgram(program: readonly Op[]): string {
  return JSON.stringify(program, (_key, value: unknown) => {
    if (typeof value !== "number") return value;
    if (Number.isNaN(value)) return "<NaN>";
    if (Object.is(value, -0)) return "<-0>";
    return value;
  });
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function read(id: NodeId): Expr {
  return { type: "read", id };
}
