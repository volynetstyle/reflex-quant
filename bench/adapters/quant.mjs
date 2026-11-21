// The quant runtime under the neutral bench API. Same wrapper shape as the
// Reflex adapter (one handle object per signal or computed, one closure per
// effect), so both pay the same adapter cost.
import * as quant from "../../src/index.ts";

// One adapter for both API shapes, so CI can build main with it: read and
// compute where they exist, the unified get of releases up to 1.3.0 otherwise.
const { batch, computed: c, dispose, effect: e, set, signal: s } = quant;
const read = quant.read ?? quant.get;
const compute = quant.compute ?? quant.get;

export const name = "quant";

class SignalRef {
  constructor(node) {
    this.n = node;
  }
  get() {
    return read(this.n);
  }
  set(value) {
    set(this.n, value);
  }
}

class ComputedRef {
  constructor(node) {
    this.n = node;
  }
  get() {
    return compute(this.n);
  }
}

export const signal = (value) => new SignalRef(s(value));
export const computed = (fn) => new ComputedRef(c(fn));
export function effect(fn) {
  const w = e(fn);
  return () => dispose(w);
}
export { batch };
