import {
  currentConsumer,
  defaultContext,
  type ProducerNode,
} from "@runtime/kernel";
import { devRecordReadProducer } from "@runtime/kernel/dev";
import { devAssertNoRuntimeHookReactiveRead } from "@runtime/kernel/execution";
import { resolveTrackedRead } from "@runtime/kernel/stages/tracking";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

/**
 * Read a producer: return its payload and, inside a computation, record the
 * dependency. A producer holds its value directly, so nothing is stabilized.
 */
export function readProducer<T>(node: ProducerNode<T>): T {
  devAssertNoRuntimeHookReactiveRead();

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.read.producer.invoke");

  const value = node.payload;
  const consumer = currentConsumer;

  if (consumer !== null) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.read.producer.track");
    resolveTrackedRead(node, consumer);
  }

  devRecordReadProducer(node, value, defaultContext);

  return value;
}
