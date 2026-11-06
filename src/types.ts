// Public handles: compile-time brands over the node, which is the runtime
// handle. Variance is explicit: reading is covariant, a signal is also
// written, so it is invariant.
declare const READ: unique symbol;
declare const WRITE: unique symbol;
declare const COMPUTED: unique symbol;
declare const EFFECT: unique symbol;

/** Anything `get` accepts. */
export interface Readable<out T> {
  readonly [READ]: T;
}

export interface Signal<in out T> extends Readable<T> {
  readonly [WRITE]: (value: T) => void;
}

export interface Computed<out T> extends Readable<T> {
  readonly [COMPUTED]: true;
}

export interface Effect {
  readonly [EFFECT]: true;
}
