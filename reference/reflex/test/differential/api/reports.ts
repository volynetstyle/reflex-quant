import type { DifferentialError } from "../internal/machine/eval";
import type { BoundedLanguage } from "../catalog/bounded-language";
import type { RecoveryLanguage } from "../catalog/recovery-language";

export interface BoundedExhaustiveReport {
  language: BoundedLanguage;
  canonicalPrograms: number;
  executedPrograms: number;
  executedOperations: number;
  divergences: 0;
}

export interface RecoveryDifferentialReport {
  language: RecoveryLanguage;
  canonicalPrograms: number;
  executedPrograms: number;
  executedOperations: number;
  divergences: number;
  firstDivergence?: DifferentialError;
}
