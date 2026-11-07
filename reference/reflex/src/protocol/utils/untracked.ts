import { currentConsumer, setCurrentConsumer } from "@runtime/kernel";

/**
 * Run `fn` with dependency tracking off: reads inside it record no edges.
 * The active computation is restored on exit, including a throw.
 */
export function untracked<T>(fn: () => T): T {
  const prev = currentConsumer;
  setCurrentConsumer(null);

  try {
    return fn();
  } finally {
    setCurrentConsumer(prev);
  }
}
