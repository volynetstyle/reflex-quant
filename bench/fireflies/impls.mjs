// The same firefly model on each library, written the way that library allows.
// Every impl: make(seedPhases) -> { step(), phases(), lits(), runs }  (runs = user callbacks executed)
export const W = +(process.env.FW || 64), H = +(process.env.FH || 40), N = W * H, DT = 0.01, EPS = 0.2, REF = 30;
export const NB = Array.from({ length: N }, (_, i) => {
  const x = i % W, y = (i / W) | 0;
  return [((y + H - 1) % H) * W + x, ((y + 1) % H) * W + x, y * W + (x + W - 1) % W, y * W + (x + 1) % W];
});

// Shared transition on plain state; returns true if it flashed.
function transition(s, t, incoming) {
  s.phase += (t - s.tick) * DT; s.tick = t;
  if (incoming && t - s.lit > REF) s.phase += incoming;
  if (s.phase >= 1) { s.phase = 0; s.lit = t; return true; }
  return false;
}

// ---------------------------------------------------------------- Quant: computed(prev) + one solver effect
export async function quant(seed) {
  const { computed, effect, get, signal, update } = await import("reflex-quant");
  const o = { runs: 0 };
  const tick = signal(0), pulse = seed.map(() => signal(0));
  const ff = seed.map((p0, i) => computed((prev) => {
    o.runs++;
    const t = get(tick);
    let phase = prev.phase + (t - prev.tick) * DT, lit = prev.lit;
    const inc = get(pulse[i]);
    if (inc) { update(pulse[i], () => 0); if (t - lit > REF) phase += inc; }
    if (phase >= 1) { phase = 0; lit = t; for (const j of NB[i]) update(pulse[j], (x) => x + EPS); }
    if (t === prev.tick && phase === prev.phase && lit === prev.lit) return prev;
    return { tick: t, phase, lit };
  }, { tick: 0, phase: p0, lit: -1e9 }));
  effect(() => { o.runs++; for (const f of ff) get(f); });
  o.step = () => update(tick, (t) => t + 1);
  o.phases = () => ff.map((f) => get(f).phase);
  o.lits = () => ff.map((f) => get(f).lit);
  return o;
}

// Effect-per-firefly ports: state in a closure (the computed may not write), transition + messages in an effect.
function effectPort(api) {
  return (seed) => {
    const o = { runs: 0 };
    const st = seed.map((p) => ({ phase: p, tick: 0, lit: -1e9 }));
    api.setup(() => {
      st.forEach((s, i) => api.effect(() => {
        o.runs++;
        const t = api.read(api.tick);
        const inc = api.read(api.pulse[i]);
        api.untracked(() => {
          if (inc) api.write(api.pulse[i], 0);
          if (transition(s, t, inc)) for (const j of NB[i]) api.write(api.pulse[j], api.peek(api.pulse[j]) + EPS);
        });
      }));
    });
    o.step = () => api.step();
    o.phases = () => st.map((s) => s.phase);
    o.lits = () => st.map((s) => s.lit);
    return o;
  };
}

export async function preact(seed) {
  const m = await import("@preact/signals-core");
  const tick = m.signal(0), pulse = seed.map(() => m.signal(0));
  return effectPort({
    tick, pulse, setup: (f) => f(), effect: m.effect, untracked: m.untracked,
    read: (s) => s.value, peek: (s) => s.peek(), write: (s, v) => (s.value = v),
    step: () => (tick.value = tick.peek() + 1),
  })(seed);
}

export async function vue(seed) {
  const m = await import("@vue/reactivity");
  const tick = m.shallowRef(0), pulse = seed.map(() => m.shallowRef(0));
  return effectPort({
    tick, pulse, setup: (f) => f(), effect: m.effect,
    untracked: (f) => { m.pauseTracking(); try { f(); } finally { m.resetTracking(); } },
    read: (s) => s.value, peek: (s) => { m.pauseTracking(); const v = s.value; m.resetTracking(); return v; }, write: (s, v) => (s.value = v),
    step: () => (tick.value = tick.value + 1),
  })(seed);
}

export async function solid(seed) {
  const m = await import("solid-js/dist/solid.js");
  const mk = (v) => { const [g, s] = m.createSignal(v); return { g, s }; };
  const tick = mk(0), pulse = seed.map(() => mk(0));
  return effectPort({
    tick, pulse, setup: (f) => m.createRoot(() => f()), effect: (fn) => m.createEffect(fn),
    untracked: (f) => m.untrack(f), read: (s) => s.g(), peek: (s) => m.untrack(s.g), write: (s, v) => s.s(v),
    step: () => tick.s((t) => t + 1),
  })(seed);
}

export async function alien(seed) {
  const m = await import("alien-signals");
  const tick = m.signal(0), pulse = seed.map(() => m.signal(0));
  const untracked = (f) => { const p = m.setActiveSub(undefined); try { return f(); } finally { m.setActiveSub(p); } };
  return effectPort({
    tick, pulse, setup: (f) => f(), effect: m.effect, untracked,
    read: (s) => s(), peek: (s) => untracked(() => s()), write: (s, v) => s(v),
    step: () => tick(untracked(() => tick()) + 1),
  })(seed);
}

// Angular: computed cannot write (NG0600), so watchers with a scheduler that drains a queue.
export async function angular(seed) {
  const m = await import("@angular/core/primitives/signals");
  const mk = (v) => m.createSignal(v)[0];
  const set = (g, v) => m.signalSetFn(g[m.SIGNAL], v);
  const tick = mk(0), pulse = seed.map(() => mk(0));
  const queue = []; let draining = false;
  const flush = () => { if (draining) return; draining = true; for (let h = 0; h < queue.length; h++) queue[h].run(); queue.length = 0; draining = false; };  // FIFO by index: shift() is linear
  const effect = (fn) => { const w = m.createWatch(fn, (w) => queue.push(w), true); w.notify(); flush(); };
  const o = effectPort({
    tick, pulse, setup: (f) => f(), effect, untracked: m.untracked,
    read: (s) => s(), peek: (s) => m.untracked(s), write: (s, v) => set(s, v),
    step: () => { set(tick, m.untracked(tick) + 1); flush(); },
  })(seed);
  return o;
}

// Hand-written baseline: a worklist of fireflies with mail. The least work the model needs.
export async function plain(seed) {
  const o = { runs: 0 };
  const st = seed.map((p) => ({ phase: p, tick: 0, lit: -1e9 }));
  const inbox = new Float64Array(seed.length);
  let t = 0;
  o.step = () => {
    t++;
    const work = [];
    const run = (i) => {
      o.runs++;
      const inc = inbox[i]; inbox[i] = 0;
      if (transition(st[i], t, inc)) for (const j of NB[i]) { if (inbox[j] === 0) work.push(j); inbox[j] += EPS; }
    };
    for (let i = 0; i < st.length; i++) run(i);
    while (work.length) { const i = work.pop(); if (inbox[i] !== 0) run(i); }
  };
  o.phases = () => st.map((s) => s.phase);
  o.lits = () => st.map((s) => s.lit);
  return o;
}

// alien-signals drops a wake-up that arrives while the effect is running (see lost-wakeup.mjs), so
// pulses can stay in an inbox. Correct port: after each tick, re-wake fireflies with mail until none.
export async function alienDrain(seed) {
  const m = await import("alien-signals");
  const tick = m.signal(0), pulse = seed.map(() => m.signal(0));
  const untracked = (f) => { const p = m.setActiveSub(undefined); try { return f(); } finally { m.setActiveSub(p); } };
  const o = effectPort({
    tick, pulse, setup: (f) => f(), effect: m.effect, untracked,
    read: (s) => s(), peek: (s) => untracked(() => s()), write: (s, v) => s(v),
    step: () => {
      tick(untracked(() => tick()) + 1);
      for (let again = true; again;) {
        again = false;
        for (let i = 0; i < pulse.length; i++) if (untracked(() => pulse[i]()) !== 0) { again = true; m.trigger(() => pulse[i]()); }
      }
    },
  })(seed);
  return o;
}
