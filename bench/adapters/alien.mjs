// alien-signals under the neutral bench API.
import { computed as c, effect as e, endBatch, signal as s, startBatch } from "alien-signals";
export const name = "alien";
export function signal(value) {
  const node = s(value);
  return { get: node, set: node };
}
export function computed(fn) {
  return { get: c(fn) };
}
export const effect = e;
export function batch(fn) {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}
