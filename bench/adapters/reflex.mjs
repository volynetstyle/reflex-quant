// The Reflex runtime (production bundle of the compared commit) under the
// neutral bench API, with the smallest host the runtime needs: a FIFO queue
// fed by onNodeInvalidated with claim-based deduplication, drained after each
// write outside a batch, as the quant host does.
import * as rt from "./runtime.mjs";
export const name = "reflex";

const queue = [];
let depth = 0;
let flushing = false;

rt.resetRuntimeContext();
rt.configureRuntimeContext({
  hooks: {
    onNodeInvalidated(node) {
      if (rt.claimWatcherSchedule(node)) queue.push(node);
    },
  },
});

function flush() {
  if (flushing || depth !== 0 || queue.length === 0) return;
  flushing = true;
  let failed = false;
  let first;
  try {
    for (let i = 0; i < queue.length; i++) {
      const w = queue[i];
      rt.releaseWatcherSchedule(w);
      try {
        rt.runWatcher(w);
      } catch (error) {
        if (!failed) first = error;
        failed = true;
      }
    }
  } finally {
    queue.length = 0;
    flushing = false;
  }
  if (failed) throw first;
}

class SignalRef {
  constructor(node) {
    this.n = node;
  }
  get() {
    return rt.readProducer(this.n);
  }
  set(value) {
    rt.writeProducer(this.n, value);
    flush();
  }
}

class ComputedRef {
  constructor(node) {
    this.n = node;
  }
  get() {
    return rt.readConsumer(this.n);
  }
}

export const signal = (value) => new SignalRef(rt.createProducer(value));
export const computed = (fn) => new ComputedRef(rt.createConsumer(fn));

export function effect(fn) {
  const w = rt.createWatcher(fn);
  if (rt.claimWatcherSchedule(w)) queue.push(w);
  flush();
  return () => rt.disposeWatcher(w);
}

export function batch(fn) {
  depth++;
  try {
    return fn();
  } finally {
    if (--depth === 0) flush();
  }
}
