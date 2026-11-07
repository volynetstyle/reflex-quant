import { resetRuntimeContext } from "../../src";
import {
  DifferentialError,
  executeDifferential,
  type Expr,
  type Op,
} from "./harness";
import type { QualificationProgram } from "./mutant/mutation-qualification";
import {
  defaultRecoveryLanguage,
  type RecoveryLanguage,
} from "./catalog/recovery-language";
import type { RecoveryDifferentialReport } from "./api/reports";
export { defaultRecoveryLanguage } from "./catalog/recovery-language";
export type { RecoveryLanguage } from "./catalog/recovery-language";
export type { RecoveryDifferentialReport } from "./api/reports";

/* export interface RecoveryLanguage {
  maxContinuationActions: 4;
  values: readonly [false, true];
}

export const defaultRecoveryLanguage: RecoveryLanguage = {
  maxContinuationActions: 4,
  values: [false, true],
}; */

/* export interface RecoveryDifferentialReport {
  language: RecoveryLanguage;
  canonicalPrograms: number;
  executedPrograms: number;
  executedOperations: number;
  divergences: number;
  firstDivergence?: DifferentialError;
} */

/**
 * Enumerates continuations from a deliberately primed watcher/computed graph.
 * The computed has one failing branch and one previously committed branch.
 * No mutant identity participates in generation.
 */
export function enumerateRecoveryPrograms(
  language: RecoveryLanguage = defaultRecoveryLanguage,
): QualificationProgram[] {
  const programs = new Map<string, readonly Op[]>();

  for (const throwWhenConditionIs of language.values) {
    const safeCondition = !throwWhenConditionIs;
    for (const fallbackValue of language.values) {
      for (const cleanupDependency of [
        undefined,
        "condition",
        "fallback",
      ] as const) {
        const failure: Expr = {
          type: "throw",
          message: "bounded failure",
        };
        const fallback: Expr = { type: "read", id: "fallback" };
        const expression: Expr = {
          type: "if",
          condition: { type: "read", id: "condition" },
          then: throwWhenConditionIs ? failure : fallback,
          else: throwWhenConditionIs ? fallback : failure,
        };
        const setup: Op[] = [
          { type: "signal", id: "condition", value: safeCondition },
          { type: "signal", id: "fallback", value: fallbackValue },
          { type: "computed", id: "computed", expression },
          {
            type: "effect",
            id: "watcher",
            expression: { type: "read", id: "computed" },
            ...(cleanupDependency === undefined
              ? {}
              : {
                  cleanup: {
                    type: "read",
                    id: cleanupDependency,
                  } as Expr,
                }),
          },
          { type: "flush" },
        ];

        enumerateContinuations(setup, 0, language, programs);
      }
    }
  }

  return [...programs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, program], index) => ({
      name: "recovery-" + index + "-" + stableHash(key),
      program,
    }));
}

export function exploreRecoveryDifferential(
  programs: readonly QualificationProgram[],
  language: RecoveryLanguage = defaultRecoveryLanguage,
): RecoveryDifferentialReport {
  let executedOperations = 0;
  let divergences = 0;
  let firstDivergence: DifferentialError | undefined;

  for (const candidate of programs) {
    resetRuntimeContext();
    try {
      executeDifferential(candidate.program);
    } catch (error) {
      if (!(error instanceof DifferentialError)) throw error;
      divergences += 1;
      firstDivergence ??= error;
    }
    executedOperations += candidate.program.length;
  }
  return {
    language,
    canonicalPrograms: programs.length,
    executedPrograms: programs.length,
    executedOperations,
    divergences,
    ...(firstDivergence === undefined ? {} : { firstDivergence }),
  };
}

function enumerateContinuations(
  program: readonly Op[],
  actionCount: number,
  language: RecoveryLanguage,
  programs: Map<string, readonly Op[]>,
): void {
  const key = JSON.stringify(program);
  if (!programs.has(key)) programs.set(key, program);
  if (actionCount === language.maxContinuationActions) return;

  const actions: Op[] = [{ type: "read", id: "computed" }, { type: "flush" }];

  for (const id of ["condition", "fallback"] as const) {
    for (const value of language.values) {
      actions.push({ type: "set", id, value });
    }
  }

  for (const action of actions) {
    enumerateContinuations(
      [...program, action],
      actionCount + 1,
      language,
      programs,
    );
  }
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
