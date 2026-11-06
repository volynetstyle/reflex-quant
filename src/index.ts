// Public API: signal, computed, effect, get, set, dispose, batch, untracked.
// A handle is the node itself: nothing is allocated besides the node, and
// handle <-> node conversions are type assertions only (no runtime wrapper).
import { Flag } from "./flags";
import { flush, start, stop, watcher } from "./host";
import { dispose as detach, node, read, write } from "./kernel";
import type { Fn, Node } from "./model";
import type { Computed, Effect, Readable, Signal } from "./types";

export type { Computed, Effect, Readable, Signal } from "./types";
export { batch } from "./host";
export { untracked } from "./kernel";

export function signal<T>(value: T): Signal<T> {
  return node(null, value, 0) as unknown as Signal<T>;
}

export function computed<T>(fn: (prev: T | undefined) => T): Computed<T> {
  return node(fn as Fn, undefined, Flag.Dirty) as unknown as Computed<T>;
}

/** Runs now (or when the enclosing batch or drain ends), then on every change it read. */
export function effect(fn: () => void | (() => void)): Effect {
  const effectNode = watcher(fn, true);
  start(effectNode);
  return effectNode as unknown as Effect;
}

/** A signal's flags are 0, so one read path serves signals and computeds. */
export function get<T>(source: Readable<T>): T {
  return read(source as unknown as Node) as T;
}

export function set<T>(source: Signal<T>, value: T): void {
  write(source as unknown as Node, value);
  flush();
}

export function dispose(target: Computed<unknown> | Effect): void {
  const targetNode = target as unknown as Node;

  if ((targetNode.flags & Flag.Watch) !== 0) stop(targetNode);
  else detach(targetNode);
}
