import { Flag } from "../../src/graph";
// Structural checks over the quant graph. Failures throw plain Errors with
// indices and counts only: never hand a node or edge to an assertion library
// (inspecting one walks the whole cyclic graph).
import { stats } from "../../src/kernel";
import type { Edge, Node } from "../../src/graph";

export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function deps(n: Node): Node[] {
  const out: Node[] = [];
  for (let e = n.deps; e !== null; e = e.next) out.push(e.from);
  return out;
}

export function subs(n: Node): Node[] {
  const out: Node[] = [];
  for (let e = n.subs; e !== null; e = e.nextSub) out.push(e.to);
  return out;
}

/** Positions of `nodes` in `pool`, for assertions that never print nodes. */
export function indices(nodes: readonly Node[], pool: readonly Node[]): number[] {
  return nodes.map((n) => pool.indexOf(n));
}

export function edgeCount(nodes: readonly Node[]): number {
  let count = 0;
  for (const n of nodes) for (let e = n.deps; e !== null; e = e.next) count++;
  return count;
}

/**
 * Integrity of the whole graph reachable from `nodes` at rest:
 * - both lists are consistent doubly linked lists;
 * - every edge is in exactly one deps list and one subs list, of its own ends;
 * - one relation per (source, consumer) pair;
 * - no pass is running, no slot cell is left behind;
 * - freshness: a live node that is neither STALE nor DIRTY has only clean
 *   sources, and every relation carries its source's current version, so a
 *   read at rest cannot return a value its sources have moved past (P3).
 *   It holds for a program that keeps the preconditions (C1, SPEC).
 */
export function checkGraph(nodes: readonly Node[], label = "graph"): void {
  const all = new Set<Node>();
  const visit = (n: Node) => {
    if (all.has(n)) return;
    all.add(n);
    for (let e = n.deps; e !== null; e = e.next) visit(e.from);
    for (let e = n.subs; e !== null; e = e.nextSub) visit(e.to);
  };
  nodes.forEach(visit);
  const list = [...all];
  const id = (n: Node) => list.indexOf(n);
  const inDeps = new Set<Edge>();
  const inSubs = new Set<Edge>();
  for (const n of list) {
    check((n.flags & Flag.Busy) === 0, `${label}: node ${id(n)} still Flag.Busy`);
    check(n.slot === null, `${label}: node ${id(n)} has a slot cell at rest`);
    const seen = new Set<Node>();
    let prev: Edge | null = null;
    for (let e = n.deps; e !== null; e = e.next) {
      check(e.to === n, `${label}: deps edge of ${id(n)} points to ${id(e.to)}`);
      check(e.prev === prev, `${label}: broken prevDep in ${id(n)}`);
      check(!seen.has(e.from), `${label}: duplicate relation ${id(e.from)} -> ${id(n)}`);
      check(!inDeps.has(e), `${label}: edge in two deps lists`);
      seen.add(e.from);
      inDeps.add(e);
      prev = e;
    }
    prev = null;
    for (let e = n.subs; e !== null; e = e.nextSub) {
      check(e.from === n, `${label}: subs edge of ${id(n)} comes from ${id(e.from)}`);
      check(e.prevSub === prev, `${label}: broken prevSub in ${id(n)}`);
      check(!inSubs.has(e), `${label}: edge in two subs lists`);
      inSubs.add(e);
      prev = e;
    }
    check(n.lastSub === prev, `${label}: lastSub of ${id(n)} is not its last edge`);
    if (n.fn !== null && (n.flags & (Flag.Stale | Flag.Dirty)) === 0) {
      for (let e = n.deps; e !== null; e = e.next) {
        const f = e.from.flags;
        check((f & (Flag.Stale | Flag.Dirty)) === 0, `${label}: clean node ${id(n)} has an invalidated source ${id(e.from)}`);
        check(e.ver === e.from.ver, `${label}: clean node ${id(n)} holds a stale version of source ${id(e.from)}`);
      }
    }
  }
  check(inDeps.size === inSubs.size, `${label}: ${inDeps.size} deps edges vs ${inSubs.size} subs edges`);
  for (const e of inDeps) check(inSubs.has(e), `${label}: edge ${id(e.from)} -> ${id(e.to)} missing from subs`);
}

export function resetStats(): void {
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}

export function snapshotStats(): typeof stats {
  return { ...stats };
}
