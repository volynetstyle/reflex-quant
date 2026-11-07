export type ProducerComparator<T> = (a: T, b: T) => boolean;

export { compare } from "@runtime/kernel/stages/stabilization/advance";
