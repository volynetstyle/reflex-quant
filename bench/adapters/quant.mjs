// The quant runtime under the neutral bench API. Same wrapper shape as the
// Reflex adapter (one handle object per signal or computed, one closure per
// effect), so both pay the same adapter cost.
import { batch, computed as c, dispose, effect as e, get, set, signal as s } from "../../src/index.ts";

export const name = "quant";

class SignalRef {
  constructor(node) {
    this.n = node;
  }
  get() {
    return get(this.n);
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
    return get(this.n);
  }
}

export const signal = (value) => new SignalRef(s(value));
export const computed = (fn) => new ComputedRef(c(fn));
export function effect(fn) {
  const w = e(fn);
  return () => dispose(w);
}
export { batch };
