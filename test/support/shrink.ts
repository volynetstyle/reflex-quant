// Greedy operation-level shrinker for three-way verdicts: drop chunks of
// operations (keeping node declarations referenced by the rest) while the
// predicate still holds.
import type { Op, Program } from "../../../reflex-runtime/test/differential/api";

const declares = (op: Op) => op.type === "signal" || op.type === "computed" || op.type === "effect";

function valid(ops: readonly Op[]): boolean {
  const known = new Set<string>();
  const watchers = new Set<string>();
  const uses = (expr: unknown): boolean => {
    if (expr === null || typeof expr !== "object") return true;
    const node = expr as Record<string, unknown>;
    if (node.type === "read" && typeof node.id === "string") return known.has(node.id);
    return Object.values(node).every(uses);
  };
  for (const op of ops) {
    if (op.type === "signal") known.add(op.id);
    else if (op.type === "computed") {
      if (!uses(op.expression)) return false;
      known.add(op.id);
    } else if (op.type === "effect") {
      if (!uses(op.expression) || (op.cleanup && !uses(op.cleanup))) return false;
      watchers.add(op.id);
    } else if (op.type === "set") {
      if (!known.has(op.id)) return false;
    } else if (op.type === "read") {
      if (!known.has(op.id)) return false;
    } else if (op.type === "dispose") {
      if (!watchers.has(op.id)) return false;
    }
  }
  return true;
}

export function shrink(program: Program, holds: (p: Program) => boolean): Program {
  let ops = [...program.operations];
  for (let size = Math.max(1, ops.length >> 1); size >= 1; size = size >> 1) {
    let progress = true;
    while (progress) {
      progress = false;
      for (let start = 0; start + size <= ops.length; start++) {
        const candidate = [...ops.slice(0, start), ...ops.slice(start + size)];
        if (!valid(candidate)) continue;
        if (holds({ id: program.id, operations: candidate })) {
          ops = candidate;
          progress = true;
          break;
        }
      }
    }
  }
  return { id: program.id, operations: ops };
}

export function describeOps(ops: readonly Op[]): string {
  const ex = (x: any): string => {
    switch (x.type) {
      case "constant": return JSON.stringify(x.value);
      case "read": return x.id;
      case "add": return `(${ex(x.left)} + ${ex(x.right)})`;
      case "greaterThan": return `(${ex(x.left)} > ${ex(x.right)})`;
      case "equal": return `(${ex(x.left)} == ${ex(x.right)})`;
      case "multiply": return `(${ex(x.left)} * ${ex(x.right)})`;
      case "if": return `(${ex(x.condition)} ? ${ex(x.then)} : ${ex(x.else)})`;
      case "throw": return `throw ${x.message}`;
    }
    return "?";
  };
  return ops
    .map((op, i) => {
      switch (op.type) {
        case "signal": return `${i}: signal ${op.id} = ${JSON.stringify(op.value)}`;
        case "computed": return `${i}: computed ${op.id} = ${ex(op.expression)}`;
        case "effect": return `${i}: watcher ${op.id} = ${ex(op.expression)}${op.cleanup ? ` cleanup ${ex(op.cleanup)}` : ""}`;
        case "set": return `${i}: set ${op.id} = ${JSON.stringify(op.value)}`;
        default: return `${i}: ${op.type}${"id" in op ? " " + op.id : ""}`;
      }
    })
    .join("\n");
}
