// Inserted into the tail-aware kernel by reorder-exact-build.mjs.
// The only candidate vector is assembled during an ordinary index walk.
const vectorCapacity = 8193;
const useResidency = false;

interface Observation {
  consumer: Node;
  expected: number;
  score: number;
  width: number;
  unread: number;
  tentative: boolean;
  outer: Observation | null;
  tape: Edge[] | null;
}

interface Captured {
  consumer: Node;
  edges: Edge[];
  born: boolean;
}

const observations = new WeakMap<Node, Observation>();
let observing: Observation | null = null;
let reservation: Observation | null = null;
let grant: WeakRef<Captured> | null = null;
let captured: Captured | null = null;
let resident: WeakRef<Captured> | null = null;
const callCaptured = Function.prototype.call.bind(Function.prototype.call) as (
  body: NonNullable<Node["fn"]>, receiver: Node, value: unknown,
) => unknown;

function startObservation(consumer: Node): Observation {
  let state = observations.get(consumer);
  if (state === undefined) {
    state = {
      consumer, expected: consumer.gen, score: 0, width: 0, unread: 0,
      tentative: false, outer: null, tape: null,
    };
    observations.set(consumer, state);
  }
  // A successful non-indexed execution is visible as a gap in generations.
  if (state.expected !== consumer.gen) state.score = 0;
  const fits = state.width <= vectorCapacity;
  state.width = 0;
  state.unread = 0;
  state.tentative = false;
  state.outer = observing;
  observing = state;
  if (state.score === 2 && fits && reservation === null && grant?.deref() === undefined) {
    reservation = state;
    state.tape = [];
  }
  if (__STATS__) stats.observedIndexes++;
  return state;
}

function observeIndexEdge(state: Observation, edge: Edge, unread: boolean, generation: number): void {
  state.width++;
  if (unread) state.unread++;
  if (edge.gen === generation) state.tentative = true;
  if (state.tape === null) return;
  if (state.width > vectorCapacity) {
    state.tape = null;
    reservation = null;
    return;
  }
  state.tape.push(edge);
  if (__STATS__) stats.captureVisits++;
}

function endObservation(state: Observation, last: Edge | null, width: number, ok: boolean): void {
  observing = state.outer;
  state.outer = null;
  const tape = state.tape;
  state.tape = null;
  if (reservation === state) reservation = null;
  const c = state.consumer;
  if (__STATS__) {
    stats.observedWidth += state.width;
    stats.observedUnread += state.unread;
  }
  // The exit walk happens before cut. Width equality excludes new pairs
  // linked since index, and the tentative test excludes earlier births.
  if (!ok || c.fn === null || last === null || last.nextDep !== null ||
      state.tentative || width !== state.width ||
      state.unread < 32 || 4 * state.unread < 3 * state.width) {
    state.score = 0;
    return;
  }
  if (__STATS__) stats.qualifyingIndexes++;
  state.expected = (c.gen + 1) & CounterLimit.Mask;
  if (state.score < 2) state.score++;
  else if (tape !== null) {
    observations.delete(c);
    armCaptured(c, tape);
  }
}

function armCaptured(c: Node, edges: Edge[]): void {
  const body = c.fn!;
  const state: Captured = { consumer: c, edges, born: false };
  grant = new WeakRef(state);
  if (__STATS__) stats.capturedEdges += edges.length;
  c.fn = (previous: unknown): unknown => {
    const outer = captured;
    const base = top;
    const head = c.firstDep;
    const tail = c.lastDep;
    captured = state;
    state.born = false;
    const reuse = useResidency && resident?.deref() === state;
    let ok = false;
    for (const edge of edges) {
      edge.ver = UNREAD;
      if (!reuse) claim(edge.from, edge);
    }
    if (__STATS__) {
      stats.indexes++;
      stats.indexed += edges.length;
      stats.capturedRuns++;
      if (useResidency) {
        if (reuse) stats.residentReuses++;
        else stats.residentFills += edges.length;
      }
    }
    try {
      const result = callCaptured(body, c, previous);
      ok = true;
      return result;
    } finally {
      // Unchanged endpoints are a conservative reason to stop speculating.
      const keep = ok && c.fn !== null && cursor !== null && cursor.nextDep === null &&
        !state.born && (head !== c.firstDep || tail !== c.lastDep);
      if (useResidency && keep && top === base) {
        // The aliases point at unchanged live relations and displaced no
        // slots. exec's ordinary exit can leave them for the next pass.
        resident = grant;
      } else {
        if (useResidency && reuse) resident = null;
        if (state.born) unindex(c, base, cursor, false);
        else {
          for (const edge of edges) edge.from.slot = null;
          if (__STATS__ && useResidency) stats.residentClears += edges.length;
          restoreDisplacedSlots(base);
        }
      }
      captured = outer;
      if (!keep) {
        grant = null;
        if (c.fn !== null) c.fn = body;
        if (__STATS__) stats.capturedRetires++;
      }
    }
  };
}

function evictIdleResident(c: Node): boolean {
  const owner = resident?.deref();
  if (owner === undefined || owner === captured || owner.consumer !== c) return false;
  // An active owner is handled by the ordinary LIFO displacement stack.
  // If the owner is idle, none of its slots is on that stack.
  resident = null;
  for (const edge of owner.edges) edge.from.slot = null;
  if (__STATS__) {
    stats.residentEvictions++;
    stats.residentClears += owner.edges.length;
  }
  return true;
}

function releaseIdleCapture(c: Node): void {
  const owner = grant?.deref();
  if (owner?.consumer !== c || owner === captured) return;
  if (useResidency) evictIdleResident(c);
  grant = null;
  if (__STATS__) stats.capturedRetires++;
}
