export type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

export type ReactivePayload =
  | Primitive
  | Function
  | readonly ReactivePayload[]
  | { readonly [key: string]: ReactivePayload };

export function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  );
}

export function isPayload(value: unknown): value is ReactivePayload {
  if (isPrimitive(value)) return true;
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;

  const stack: unknown[] = [value];
  const visited = new WeakSet<object>();

  while (stack.length !== 0) {
    const current = stack.pop();

    if (isPrimitive(current)) continue;
    if (typeof current === "function") continue;
    if (typeof current !== "object" || current === null) {
      return false;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        stack.push(current[i]);
      }
      continue;
    }

    const proto = Object.getPrototypeOf(current);

    if (proto !== Object.prototype && proto !== null) {
      return false;
    }

    const record = current as Record<string, unknown>;

    for (const key in record) {
      stack.push(record[key]);
    }
  }

  return true;
}
