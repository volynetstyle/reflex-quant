import {
  defaultContext,
  enterPropagationScope,
  abortPropagationScope,
  leavePropagationScope,
  emitSettledIfIdle,
  propagationScopeDepth,
  type ProducerNode,
} from "@runtime/kernel";
import { devRecordWriteProducer } from "@runtime/kernel/dev";
import { push_iterator } from "@runtime/kernel/stages/propagation/push_iterator";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

/**
 * `Object.is` semantics as strict comparisons, for the write path only.
 * TurboFan specializes these from this site's feedback, where `Object.is`
 * with operands of unknown type calls the SameValue builtin. Recompute
 * keeps `compare`: a comparator shared with it would share one feedback
 * vector and inlining budget across both paths.
 */
function sameWrittenValue(a: unknown, b: unknown): boolean {
  return a === b
    ? a !== 0 || 1 / (a as number) === 1 / (b as number)
    : a !== a && b !== b;
}

/**
 * Write a producer. An equal write (`Object.is`) returns without effect. A
 * changed write commits the payload, then invalidates synchronously: direct
 * subscribers become `Changed`, transitive ones `Unknown`, watchers are
 * reported through `onNodeInvalidated`. No computed callback runs here.
 * Contract, including a throwing hook: docs/RUNTIME.md, "Producers".
 */
export function writeProducer<T>(node: ProducerNode<T>, value: T): void {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.write.invoke");

  const prev = node.payload;

  if (sameWrittenValue(prev, value) === true) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.write.value.same");
    devRecordWriteProducer(node, false, value, prev, undefined, defaultContext);
    return;
  }

  node.payload = value;

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.write.value.changed");
  devRecordWriteProducer(node, true, value, prev, undefined, defaultContext);

  const firstOut = node.firstOut;

  if (firstOut === null) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.write.subscribers.empty");

    if (propagationScopeDepth === 0) emitSettledIfIdle();
    return;
  }

  if (propagationScopeDepth !== 0) {
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.write.propagation.nested",
      );

    push_iterator(firstOut);
    return;
  }

  // The outermost write owns the propagation scope; a throw unwinds it.
  enterPropagationScope();
  try {
    push_iterator(firstOut);
  } catch (error) {
    abortPropagationScope();
    throw error;
  }
  leavePropagationScope();
}
