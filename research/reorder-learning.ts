// Kernel fragment for the research bundles. The builder inserts it into an
// isolated source copy so it can reuse the ordinary tracker and slot stack.
type ResolverKind = 0 | 1 | 2; // no wide work, mark, slots
type TierExperiment = "observe" | "thread" | "witness";
const experiment = "__EXPERIMENT__" as TierExperiment;
const streak = 3;
const minimum = 32;
const witnessLimit = 8193;

interface Trial {
  consumer: Node;
  kind: ResolverKind;
  lastKind: ResolverKind;
  score: number;
  quiet: number;
  width: number;
  moved: number;
  changed: boolean;
  head: Edge | null;
  tail: Edge | null;
  unread: number;
  witness: Edge[] | null;
  usingWitness: boolean;
}

const trials = new WeakSet<Node>();
let trial: Trial | null = null;

// Preserve the original receiver, including a body with its own .call field.
const invokeBody = Function.prototype.call.bind(Function.prototype.call) as (
  body: NonNullable<Node["fn"]>,
  receiver: Node,
  value: unknown,
) => unknown;

function recordBudget(consumer: Node, kind: 1 | 2): void {
  if (trial?.consumer === consumer) {
    // A marked pass can subsequently escalate to slots.
    if (trial.kind < kind) trial.kind = kind;
    return;
  }
  const body = consumer.fn;
  if (body === null || trials.has(consumer)) return;
  trials.add(consumer);
  if (__STATS__) stats.trainingStarts++;
  const state: Trial = {
    consumer, kind: 0, lastKind: 0, score: 0, quiet: 0, width: 0, moved: 0,
    changed: false, head: null, tail: null, unread: 0, witness: null,
    usingWitness: false,
  };

  function retire(): void {
    if (__STATS__) stats.trainingRetires++;
    trials.delete(consumer);
    state.witness = null;
    if (consumer.fn !== null) consumer.fn = body;
  }

  consumer.fn = (previous: unknown): unknown => {
    const outer = trial;
    const base = top;
    trial = state;
    state.kind = 0;
    state.moved = 0;
    state.changed = false;
    let success = false;
    if (__STATS__) stats.trainingRuns++;
    try {
      if (experiment === "witness" && state.witness !== null) openWitness(state);
      const result = invokeBody(body, consumer, previous);
      success = true;
      return result;
    } finally {
      const last = cursor;
      if (experiment === "thread" && state.head !== null) finishThread(state, last);
      if (experiment === "witness" && state.usingWitness) closeWitness(state, base);
      trial = outer;

      if (!success || consumer.fn === null) retire();
      else if (gradeTrial(state, last) === false) retire();
    }
  };
}

function qualifyingWidth(state: Trial, last: Edge | null): number {
  if (state.kind === 0 || state.changed || state.moved < minimum ||
      last === null || last !== state.consumer.lastDep) return 0;
  const maximum = Math.floor(4 * state.moved / 3);
  if (state.width > 0) return state.width <= maximum ? state.width : 0;

  let width = 0;
  for (let e = state.consumer.firstDep; e !== null; e = e.nextDep) {
    if (__STATS__) stats.trainingVisits++;
    if (++width > maximum) return 0;
  }
  return width;
}

function gradeTrial(state: Trial, last: Edge | null): boolean {
  const width = qualifyingWidth(state, last);
  if (width === 0) {
    if (__STATS__ && state.score === streak) stats.demotions++;
    state.lastKind = 0;
    state.score = 0;
    state.width = 0;
    state.witness = null;
    return ++state.quiet < 2;
  }
  if (__STATS__) stats.qualifyingRuns++;
  state.quiet = 0;
  state.width = width;
  if (state.lastKind !== state.kind) {
    if (__STATS__ && state.score === streak) stats.demotions++;
    state.score = 0;
    state.lastKind = state.kind;
    state.witness = null;
  }
  if (state.score === streak || ++state.score !== streak) return true;
  if (__STATS__) stats.promotions++;
  if (experiment === "witness" && state.kind === 2 && width <= witnessLimit) {
    const edges: Edge[] = [];
    for (let e = state.consumer.firstDep; e !== null; e = e.nextDep) edges.push(e);
    state.witness = edges;
    if (__STATS__) stats.witnessCellsBuilt += width;
  }
  return true;
}

function recordMoved(consumer: Node): void {
  if (trial?.consumer === consumer) trial.moved++;
}

function recordBirth(consumer: Node): void {
  if (trial?.consumer === consumer) trial.changed = true;
}

// Vector lookup uses the existing exact slots. Its fixed order need not be
// the logical order: the whole frontier is unread at the call boundary.
function openWitness(state: Trial): void {
  const edges = state.witness!;
  state.kind = 2;
  state.usingWitness = true;
  if (__STATS__) {
    stats.witnessRuns++;
    stats.witnessFillVisits += edges.length;
    stats.indexes++;
    stats.indexed += edges.length;
  }
  for (const e of edges) {
    e.ver = UNREAD;
    claim(e.from, e);
  }
}

function closeWitness(state: Trial, base: number): void {
  state.usingWitness = false;
  // Newly linked edges were claimed and are visible in the ordinary list.
  if (state.changed) {
    if (__STATS__) stats.witnessListClears++;
    return unindex(state.consumer, base);
  }
  const edges = state.witness!;
  if (__STATS__) stats.witnessClearVisits += edges.length;
  for (const e of edges) e.from.slot = null;
  restoreDisplacedSlots(base);
}

function startLearnedThread(
  c: Node, s: Node, e: Edge, last: Edge | null, next: Edge,
): boolean {
  const state = trial;
  if (state?.consumer !== c || state.score !== streak ||
      state.lastKind !== 1 || state.changed) return false;
  state.kind = 1;
  state.head = next;
  state.tail = c.lastDep;
  let count = 0;
  for (let u: Edge | null = next; u !== null; u = u.nextDep) {
    u.ver = UNREAD;
    count++;
  }
  state.unread = count;
  if (__STATS__) {
    stats.threadRuns++;
    stats.sweeps++;
    stats.indexed += count;
  }
  if (last === null) c.firstDep = null;
  else last.nextDep = null;
  c.lastDep = last;
  appendLearned(state, s, e, last);
  return true;
}

function appendLearned(state: Trial, s: Node, e: Edge, last: Edge | null): void {
  if (e.ver !== UNREAD) {
    if (__STATS__) stats.dups++;
    return;
  }
  // Within a prearmed pass the original backward pointer witnesses old
  // adjacency. A long run of adjacent edges scores only its boundary.
  if (e.prevDep !== last) state.moved++;
  e.ver = s.ver;
  if (last === null) state.consumer.firstDep = e;
  else last.nextDep = e;
  e.nextDep = null;
  state.consumer.lastDep = e;
  cursor = e;
  state.unread--;
  if (__STATS__) stats.threadAppends++;
}

function finishThread(state: Trial, last: Edge | null): void {
  const c = state.consumer;
  const boundary = state.head!.prevDep;
  let rest: Edge | null = null;
  if (state.unread !== 0) {
    for (let e = state.tail; e !== boundary; e = e!.prevDep) {
      if (__STATS__) stats.threadOldVisits++;
      if (e!.ver !== UNREAD) continue;
      e!.nextDep = rest;
      rest = e;
    }
  }
  if (last === null) c.firstDep = rest;
  else last.nextDep = rest;
  let prev = boundary;
  for (let e = prev === null ? c.firstDep : prev.nextDep; e !== null; e = e.nextDep) {
    if (__STATS__) stats.threadRepairs++;
    e.prevDep = prev;
    prev = e;
  }
  c.lastDep = prev;
  state.head = null;
  state.tail = null;
  state.unread = 0;
}

function readLearnedThread(
  state: Trial, s: Node, last: Edge | null, first: Edge,
): void {
  const c = state.consumer;
  const head = state.head!;
  const found = head.from === s ? head : pair(first, c);
  if (found === null) return link(c, s, last, null);
  if (found !== undefined) return appendLearned(state, s, found, last);
  finishThread(state, last);
  const next = last === null ? c.firstDep : last.nextDep;
  index(c, next);
  slot(c, s, last, next);
}
