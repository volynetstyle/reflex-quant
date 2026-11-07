import type { Op, Observation, Expr, NodeId, Value } from "../../api";
import type { NormalizedError } from "../../api/types";

export class DifferentialError extends Error {
  constructor(
    readonly operationIndex: number,
    readonly operation: Op,
    readonly expected: Observation,
    readonly actual: Observation,
    readonly prefix: readonly Op[],
  ) {
    super(
      `Differential mismatch at operation ${operationIndex}: ${format(operation)}\n` +
        `expected ${format(expected)}\n` +
        `actual   ${format(actual)}`,
    );

    this.name = "DifferentialError";
  }
}

/**
 * Observation equality: the arbiter of every differential verdict. It is an
 * equivalence relation (reflexive, symmetric, transitive) that distinguishes
 * a change of any observed field, including the presence of `value` and
 * `error` (runtime.observation-comparator.test.ts).
 */
export function observationsEqual(
  left: Observation,
  right: Observation,
): boolean {
  if ("value" in left !== "value" in right) return false;

  if ("value" in left && !Object.is(left.value, right.value)) {
    return false;
  }

  if ("error" in left !== "error" in right) return false;

  // Both sides are read, so an error on either side alone is a difference.
  if (
    left.error?.name !== right.error?.name ||
    left.error?.message !== right.error?.message
  ) {
    return false;
  }

  if (left.effects.length !== right.effects.length) {
    return false;
  }

  return left.effects.every((event, index) => {
    const other = right.effects[index];

    return (
      other !== undefined &&
      event.effect === other.effect &&
      event.phase === other.phase &&
      Object.is(event.value, other.value)
    );
  });
}

// Shared deliberately: expression semantics are outside the differential boundary.
export function evaluate(
  expression: Expr,
  readNode: (id: NodeId) => Value,
): Value {
  switch (expression.type) {
    case "constant":
      return expression.value;

    case "read":
      return readNode(expression.id);

    case "if":
      return evaluate(expression.condition, readNode)
        ? evaluate(expression.then, readNode)
        : evaluate(expression.else, readNode);

    case "add":
      return (
        Number(evaluate(expression.left, readNode)) +
        Number(evaluate(expression.right, readNode))
      );

    case "multiply":
      return (
        Number(evaluate(expression.left, readNode)) *
        Number(evaluate(expression.right, readNode))
      );

    case "greaterThan":
      return (
        Number(evaluate(expression.left, readNode)) >
        Number(evaluate(expression.right, readNode))
      );

    case "equal":
      return Object.is(
        evaluate(expression.left, readNode),
        evaluate(expression.right, readNode),
      );

    case "throw":
      throw new Error(expression.message);
  }
}

export function normalizeError(error: unknown): NormalizedError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "ThrownValue", message: String(error) };
}

export function format(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "number") return item;

    if (Number.isNaN(item)) return "<NaN>";
    if (item === Infinity) return "<Infinity>";
    if (item === -Infinity) return "<-Infinity>";
    if (Object.is(item, -0)) return "<-0>";

    return item;
  });
}
