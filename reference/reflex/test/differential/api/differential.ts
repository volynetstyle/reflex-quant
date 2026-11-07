import { resetRuntimeContext } from "../../../src";

import { DifferentialError, observationsEqual } from "../internal/machine/eval";
import { ReflexMachine } from "../internal/machine/ReflexMachine";
import { SpecMachine } from "../internal/machine/SpecMachine";
import type {
  DifferentialMismatch,
  DifferentialResult,
  Observation,
  Program,
} from "./types";

export function compare(program: Program): DifferentialResult {
  resetRuntimeContext();

  const expectedMachine = new SpecMachine();
  const actualMachine = new ReflexMachine();
  const expected: Observation[] = [];
  const actual: Observation[] = [];
  let mismatch: DifferentialMismatch | undefined;

  for (
    let operationIndex = 0;
    operationIndex < program.operations.length;
    operationIndex += 1
  ) {
    const operation = program.operations[operationIndex]!;
    const expectedObservation = expectedMachine.execute(operation);
    const actualObservation = actualMachine.execute(operation);

    expected.push(expectedObservation);
    actual.push(actualObservation);

    if (
      mismatch === undefined &&
      !observationsEqual(actualObservation, expectedObservation)
    ) {
      mismatch = {
        operationIndex,
        operation,
        expected: expectedObservation,
        actual: actualObservation,
        prefix: program.operations.slice(0, operationIndex + 1),
      };
    }
  }

  return {
    program,
    expected,
    actual,
    mismatch,
    equivalent: mismatch === undefined,
  };
}

export function assertEquivalent(program: Program): readonly Observation[] {
  const result = compare(program);
  const mismatch = result.mismatch;

  if (mismatch !== undefined) {
    throw new DifferentialError(
      mismatch.operationIndex,
      mismatch.operation,
      mismatch.expected,
      mismatch.actual,
      mismatch.prefix,
    );
  }

  return result.actual;
}
