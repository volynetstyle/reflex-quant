// P5 witnesses shared by the semantic test (values, executions) and the
// structural test (which repeat path each one reaches). Each program reads a
// source, changes it once in the same execution, and reads it again.
import { computed, get, set, signal, type Computed, type Signal } from "../../src/index";

/** a, b, (a := 2), a: the second read of a is a repeat found by the prefix scan. */
export function prefixRepeat(): Computed<number> {
  const a = signal(1);
  const b = signal(10);
  let wrote = false;
  return computed(() => {
    const x = get(a) + get(b);
    if (!wrote) {
      wrote = true;
      set(a, 2);
    }
    return x + get(a);
  });
}

export interface FoundRepeat {
  c: Computed<number>;
  /** Set to 1 to start the reversed pass that writes and rereads. */
  tick: Signal<number>;
  runs(): number;
}

/**
 * Twenty-four sources read in order, then the middle one first and the rest
 * from both ends inward: no bounded scan of the reader's list finds the
 * middle one, so the pass marks its suffix (one reader) or indexes it
 * (another reader subscribed first), and its last read repeats the first one
 * after a write, a repeat found through the subscribers or the slot. The
 * values are 0..10 and 11 on the middle one (sum 66).
 */
export function foundRepeat(indexed: boolean): FoundRepeat {
  const n = 24;
  const mid = n / 2;
  const ps = Array.from({ length: n }, (_, i) => signal(i < 11 ? i : i === mid ? 11 : 0));
  const order = [mid, ...Array.from({ length: n - mid - 1 }, (_, i) => n - 1 - i), ...Array.from({ length: mid }, (_, i) => mid - 1 - i)];
  if (indexed) get(computed(() => ps.reduce((s, p) => s + get(p), 0)));
  const tick = signal(0);
  let wrote = false;
  let runs = 0;
  const c = computed(() => {
    runs++;
    let sum = 0;
    if (get(tick) === 0) {
      for (const p of ps) sum += get(p);
      return sum;
    }
    for (const i of order) sum += get(ps[i]!);
    if (!wrote) {
      wrote = true;
      set(ps[mid]!, 100);
    }
    return sum + get(ps[mid]!);
  });
  return { c, tick, runs: () => runs };
}
