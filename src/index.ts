// Public API: signal, computed, effect, get, set, dispose, batch, untracked.
// A handle is the node itself: nothing is allocated besides the node.
import { DIRTY, WATCH, dispose as detach, node, read, write, type Node } from "./kernel";
import { flush, start, stop, watcher } from "./host";

export { batch } from "./host";
export { untracked } from "./kernel";

// Compile-time brands only. They do not exist at runtime.
declare const SIGNAL: unique symbol;
declare const COMPUTED: unique symbol;
declare const EFFECT: unique symbol;

export interface Signal<T> {
  readonly [SIGNAL]: T;
}

export interface Computed<T> {
  readonly [COMPUTED]: T;
}

export interface Effect {
  readonly [EFFECT]: true;
}

export type Readable<T> = Signal<T> | Computed<T>;

const raw = (handle: unknown): Node => handle as Node;

export function signal<T>(value: T): Signal<T> {
  return node(null, value, 0) as unknown as Signal<T>;
}

export function computed<T>(fn: (prev: T | undefined) => T): Computed<T> {
  return node(fn as Node["fn"], undefined, DIRTY) as unknown as Computed<T>;
}

/** Runs now (or when the enclosing batch or drain ends), then on every change it read. */
export function effect(fn: () => void | (() => void)): Effect {
  const w = watcher(fn, true);
  start(w);
  return w as unknown as Effect;
}

/** A signal's flags are 0, so one read path serves signals and computeds. */
export function get<T>(source: Readable<T>): T {
  return read(raw(source)) as T;
}

export function set<T>(source: Signal<T>, value: T): void {
  write(raw(source), value);
  flush();
}

export function dispose(target: Computed<unknown> | Effect): void {
  const n = raw(target);
  if ((n.flags & WATCH) !== 0) stop(n);
  else detach(n);
}
