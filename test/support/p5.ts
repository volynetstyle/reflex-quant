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
 * Twelve sources read in order, then reversed: the reversed pass misses at
 * once, so it marks its suffix (one reader) or indexes it (another reader
 * subscribed first), and its last read repeats the first one after a write,
 * a repeat found through the subscribers or the slot.
 */
export function foundRepeat(indexed: boolean): FoundRepeat {
  const n = 12;
  const ps = Array.from({ length: n }, (_, i) => signal(i));
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
    for (let i = n - 1; i >= 0; i--) sum += get(ps[i]!);
    if (!wrote) {
      wrote = true;
      set(ps[n - 1]!, 100);
    }
    return sum + get(ps[n - 1]!);
  });
  return { c, tick, runs: () => runs };
}
