// Public API: signal, computed, effect, batch, untracked.
import { DIRTY, dispose, node, read, readSignal, write, type Node } from "./kernel";
import { flush, schedule, stop, watcher } from "./host";

export { batch } from "./host";
export { untracked } from "./kernel";

export interface Signal<T> {
  get(): T;
  set(value: T): void;
}

export interface Computed<T> {
  get(): T;
  /** Detach from sources; the node keeps its last value. */
  dispose(): void;
}

class SignalRef<T> implements Signal<T> {
  constructor(private readonly n: Node) {}
  get(): T {
    return readSignal(this.n) as T;
  }
  set(value: T): void {
    write(this.n, value);
    flush();
  }
}

class ComputedRef<T> implements Computed<T> {
  constructor(private readonly n: Node) {}
  get(): T {
    return read(this.n) as T;
  }
  dispose(): void {
    dispose(this.n);
  }
}

export function signal<T>(value: T): Signal<T> {
  return new SignalRef(node(null, value, 0));
}

export function computed<T>(fn: (previous: T | undefined) => T): Computed<T> {
  return new ComputedRef(node(fn as Node["fn"], undefined, DIRTY));
}

/**
 * Runs through the host queue: now, or at the end of the enclosing batch or
 * drain, then after every change it read. Returns the disposer.
 */
export function effect(fn: () => void | (() => void)): () => void {
  const w = watcher(fn, true);
  schedule(w);
  flush();
  return () => stop(w);
}
