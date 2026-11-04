import { observationsEqual } from "../internal/machine/eval";
import { compare } from "./differential";
import type {
  Observation,
  OperationAlignment,
  Program,
  TransformationMismatch,
  TransformationResult,
} from "./types";

export interface TransformationComparison {
  readonly base: Program;
  readonly transformed: Program;
  readonly alignment: readonly OperationAlignment[];
}

/**
 * An alignment must compare something and keep both programs in order: it is
 * non-empty and strictly increasing on both sides. An empty alignment would
 * make both equivalences vacuously true; a crossing one would compare an
 * observation with one from a different point of the history.
 */
function checkAlignment(alignment: readonly OperationAlignment[]): void {
  if (alignment.length === 0)
    throw new RangeError("Transformation alignment is empty");

  for (let index = 1; index < alignment.length; index += 1) {
    const previous = alignment[index - 1]!;
    const pair = alignment[index]!;

    if (pair.base <= previous.base || pair.transformed <= previous.transformed)
      throw new RangeError(
        `Transformation alignment is not strictly increasing at ` +
          `${previous.base} -> ${previous.transformed}, ${pair.base} -> ${pair.transformed}`,
      );
  }
}

/** An observation that can disagree with another one in more than shape. */
const informative = (observation: Observation): boolean =>
  "value" in observation ||
  "error" in observation ||
  observation.effects.length > 0;

export function compareTransformation({
  base,
  transformed,
  alignment,
}: TransformationComparison): TransformationResult {
  checkAlignment(alignment);

  const baseResult = compare(base);
  const transformedResult = compare(transformed);
  const mismatches: TransformationMismatch[] = [];
  let informativePairs = 0;

  for (const pair of alignment) {
    const baseExpected = baseResult.expected[pair.base];
    const transformedExpected = transformedResult.expected[pair.transformed];
    const baseActual = baseResult.actual[pair.base];
    const transformedActual = transformedResult.actual[pair.transformed];

    if (
      baseExpected === undefined ||
      transformedExpected === undefined ||
      baseActual === undefined ||
      transformedActual === undefined
    ) {
      throw new RangeError(
        `Invalid transformation alignment ${pair.base} -> ${pair.transformed}`,
      );
    }

    if (
      informative(baseExpected) ||
      informative(transformedExpected) ||
      informative(baseActual) ||
      informative(transformedActual)
    )
      informativePairs += 1;

    if (!observationsEqual(baseExpected, transformedExpected)) {
      mismatches.push({
        target: "spec",
        baseOperationIndex: pair.base,
        transformedOperationIndex: pair.transformed,
        base: baseExpected,
        transformed: transformedExpected,
      });
    }

    if (!observationsEqual(baseActual, transformedActual)) {
      mismatches.push({
        target: "reflex",
        baseOperationIndex: pair.base,
        transformedOperationIndex: pair.transformed,
        base: baseActual,
        transformed: transformedActual,
      });
    }
  }

  return {
    base: baseResult,
    transformed: transformedResult,
    specEquivalent: !mismatches.some(({ target }) => target === "spec"),
    reflexEquivalent: !mismatches.some(({ target }) => target === "reflex"),
    mismatches,
    informativePairs,
  };
}
