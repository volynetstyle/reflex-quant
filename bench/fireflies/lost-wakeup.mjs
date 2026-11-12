// Minimal case: A's effect writes into B's inbox; B's effect answers by writing into A's inbox
// while A's effect is still running. Is A run again to read it?
const libs = {
  async alien() { const m = await import("alien-signals"); const un = (f) => { const p = m.setActiveSub(undefined); try { return f(); } finally { m.setActiveSub(p); } }; return { signal: m.signal, effect: m.effect, un, read: (s) => s(), write: (s, v) => s(v), peek: (s) => un(() => s()) }; },
  async preact() { const m = await import("@preact/signals-core"); return { signal: m.signal, effect: m.effect, un: m.untracked, read: (s) => s.value, write: (s, v) => (s.value = v), peek: (s) => s.peek() }; },
  async quant() { const m = await import("reflex-quant"); return { signal: m.signal, effect: m.effect, un: m.untracked, read: m.get, write: m.set, peek: m.peek }; },
};
for (const [name, make] of Object.entries(libs)) {
  const { signal, effect, un, read, write, peek } = await make();
  const tick = signal(0), inA = signal(0), inB = signal(0);
  let got = 0, answered = false;
  effect(() => { const t = read(tick), inc = read(inA); un(() => { if (inc) { got += inc; write(inA, 0); } if (t === 1 && !inc) write(inB, peek(inB) + 1); }); });
  effect(() => { read(tick); const inc = read(inB); un(() => { if (inc) { write(inB, 0); if (!answered) { answered = true; write(inA, peek(inA) + 0.2); } } }); });
  write(tick, 1);
  console.log(name.padEnd(7), `A received ${got}; left unread in A's inbox: ${peek(inA)}`);
}
