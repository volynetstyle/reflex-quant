import {
  CONSUMER_INITIAL_STATE,
  PRODUCER_INITIAL_STATE,
  ReactiveNode,
  WATCHER_INITIAL_STATE,
  type ConsumerNode,
  type ProducerNode,
  type WatcherCleanup,
  type WatcherNode,
  type WatcherResult,
} from "@runtime/kernel";
import { defaultContext } from "@runtime/kernel/config";
import { devRecordNodeCreated } from "@runtime/kernel/dev";

/**
 * A watcher callback. It may return a cleanup, run before the next run or on
 * disposal.
 */
export type WatcherFn = () => void | WatcherCleanup;

/** A producer: a mutable source holding `payload`. */
export const createProducer = <T>(payload: T): ProducerNode<T> => {
  const node = new ReactiveNode<T>(
    payload,
    undefined,
    PRODUCER_INITIAL_STATE,
  ) as ProducerNode<T>;
  devRecordNodeCreated(node, defaultContext);
  return node;
};

/**
 * A computed consumer over `callback`, a side-effect-free derivation. It
 * computes on its first read, caches the result and recomputes only when a
 * dependency changed.
 */
export const createConsumer = <T>(callback: () => T): ConsumerNode<T> => {
  const node = new ReactiveNode<T>(
    undefined as T,
    callback,
    CONSUMER_INITIAL_STATE,
  ) as ConsumerNode<T>;
  devRecordNodeCreated(node, defaultContext);
  return node;
};

/**
 * A watcher: a terminal consumer for side effects. The runtime marks it dirty
 * and notifies the host; the host decides when `runWatcher` executes it.
 */
export const createWatcher = (callback: WatcherFn): WatcherNode => {
  const node = new ReactiveNode<WatcherResult>(
    undefined,
    callback,
    WATCHER_INITIAL_STATE,
  ) as WatcherNode;
  devRecordNodeCreated(node, defaultContext);
  return node;
};
