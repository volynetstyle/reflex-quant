// The same starting phases for every runtime (Park-Miller, seed 7).
import { N } from "./impls.mjs";
export function seed() {
  let r = 7;
  return Array.from({ length: N }, () => (r = (r * 16807) % 2147483647) / 2147483647);
}
export const ALL = ["quant", "preact", "vue", "solid", "angular", "alienDrain"];
