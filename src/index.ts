// Public API: signal, computed, effect, get, peek, set, update, dispose,
// batch, untracked. A handle is the node itself: nothing is allocated besides
// the node, and handle <-> node conversions are type assertions only (no
// runtime wrapper). Every operation here exposes existing kernel and host
// semantics; none adds state.
import { Flag } from "./flags";
import { depth, drainNow, draining, size, start, stop, watcher } from "./host";
import {
  dispose as detach,
  node,
  peek as refresh,
  read,
  untracked,
  write,
} from "./kernel";
import type { Fn, Node } from "./model";
import type { Computed, Effect, Readable, Signal } from "./types";

export type { Computed, Effect, Readable, Signal } from "./types";
export { batch } from "./host";
export { untracked } from "./kernel";

export function signal<T>(value: T): Signal<T> {
  return node(null, value, 0) as unknown as Signal<T>;
}

/**
 * `fn` receives `prev`, the last successfully committed value: `initial`
 * (or undefined) before the first commit, unchanged by a failed run.
 * Returning `prev` itself is a cutoff: consumers do not rerun, so custom
 * equality is `(prev) => (equal(prev, next) ? prev : next)`.
 */
export function computed<T>(fn: (prev: T | undefined) => T): Computed<T>;
export function computed<T>(fn: (prev: T) => T, initial: T): Computed<T>;
export function computed<T>(
  fn: (prev: T | undefined) => T,
  initial?: T,
): Computed<T> {
  return node(fn as Fn, initial, Flag.Dirty) as unknown as Computed<T>;
}

/** Runs now (or when the enclosing batch or drain ends), then on every change it read. */
export function effect(fn: () => void | (() => void)): Effect {
  const effectNode = watcher(fn, true);

  try {
    start(effectNode);
  } catch (error) {
    stop(effectNode);
    throw error;
  }

  return effectNode as unknown as Effect;
}

/**
 * Kernel `read` itself under the public type: a signal's flags are 0, so one
 * read path serves signals and computeds, and no surface function stands in
 * front of it.
 */
export const get: <T>(source: Readable<T>) => T = read as never;

/** `get` without observation: up to date, but the running consumer does not depend on it. */
export const peek: <T>(source: Readable<T>) => T = refresh as never;

/** Writes, then runs what the write scheduled; a write that woke nothing stops at one load. */
export function set<T>(source: Signal<T>, value: T): void {
  write(source as unknown as Node, value);

  if (size !== 0 && !draining && depth === 0) drainNow();
}

/**
 * `set(source, fn(current))`. An update is a write, not an observation:
 * `fn` runs untracked, so neither `source` nor what `fn` reads becomes a
 * dependency of the running consumer. If `fn` throws, nothing is written.
 */
export function update<T>(source: Signal<T>, fn: (value: T) => T): void {
  set(
    source,
    untracked(() => fn((source as unknown as Node).value as T)),
  );
}

export function dispose(target: Computed<unknown> | Effect): void {
  const targetNode = target as unknown as Node;

  if ((targetNode.flags & Flag.Watch) !== 0) stop(targetNode);
  else detach(targetNode);
}
