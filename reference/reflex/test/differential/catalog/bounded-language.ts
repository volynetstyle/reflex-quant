export interface BoundedLanguage {
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
};

export const boundedValueDomain = defaultBoundedLanguage.values;
