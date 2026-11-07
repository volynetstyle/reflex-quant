import type { RuntimeDiagnosticJson } from "./diagnostics.types";

export function toDiagnosticJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): RuntimeDiagnosticJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return String(value);
  }
  if (value === undefined) return "[undefined]";
  if (depth >= 6) return "[truncated]";
  if (seen.has(value)) return "[circular]";

  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 200)
      .map((item) => toDiagnosticJson(item, seen, depth + 1));
  }

  const result: Record<string, RuntimeDiagnosticJson> = {};
  for (const key of Object.keys(value as object).slice(0, 200)) {
    result[key] = toDiagnosticJson(
      (value as Record<string, unknown>)[key],
      seen,
      depth + 1,
    );
  }
  return result;
}
