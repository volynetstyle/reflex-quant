import type { ReactiveEdge } from "./edge";
import { isPayload } from "./node.dev";

export type ComputeFn<T> = (() => T) | undefined;

export type WatcherCleanup = () => void;
export type WatcherResult = void | WatcherCleanup;

declare const reactiveNodeRole: unique symbol;

type NodeRole<Role extends "producer" | "consumer" | "watcher"> = {
  readonly [reactiveNodeRole]: Role;
};

class ReactiveNode<T = unknown, C extends ComputeFn<T> = ComputeFn<T>> {
  state = 0;

  firstOut: ReactiveEdge | null = null;
  lastOut: ReactiveEdge | null = null;

  firstIn: ReactiveEdge | null = null;
  lastIn: ReactiveEdge | null = null;
  /**
   * While Computing: the tracking frontier, null or an incoming edge. While
   * not: null, the residual incoming edge of the last pass, or an outgoing
   * hint for the pair lookup (INV-H, graph/hint.ts).
   *
   * Phase-dependent tracking edge:
   * Computing -> accepted incoming frontier
   * idle      -> retained incoming edge or outgoing lookup hint
   */
  tailIn: ReactiveEdge | null = null;

  compute: C;
  payload: T;

  constructor(payload: T, compute: C, state: number) {
    if (__DEV__ && !isPayload(payload)) {
      throw new TypeError(
        `[ReactiveNode(constructor)]: payload must be primitive, function, array, or plain object, but not a ${typeof payload}`,
      );
    }

    // JIT: seeds the `state` field with Smi representation for the node map.
    // Not a correctness guard; every later store is an Int32 bit expression,
    // so the field never generalizes to Double or Tagged.
    this.state = state | 0;
    this.compute = compute;
    this.payload = payload;
  }
}

export type ProducerNode<T = unknown> = ReactiveNode<T, undefined> &
  NodeRole<"producer">;

export type ConsumerNode<T = unknown> = ReactiveNode<T, () => T> &
  NodeRole<"consumer">;

export type WatcherNode = ReactiveNode<
  WatcherResult,
  ComputeFn<WatcherResult>
> &
  NodeRole<"watcher">;

export default ReactiveNode;
