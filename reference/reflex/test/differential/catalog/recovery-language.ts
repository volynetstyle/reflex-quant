export interface RecoveryLanguage {
  maxContinuationActions: 4;
  values: readonly [false, true];
}

export const defaultRecoveryLanguage: RecoveryLanguage = {
  maxContinuationActions: 4,
  values: [false, true],
};
