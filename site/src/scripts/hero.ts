// Live 1-bit hero. A continuous light field is rendered at low resolution and thresholded with a
// 4x4 Bayer matrix, so every pixel is either a dot or black, like print halftone.
// Field = a lit sphere (the signal) + halo + particles it sheds + pulses running along
// dependency edges to orbiting nodes. Pointer tilts the light; a click writes.
// The graph is real: a reflex-quant signal, five computeds, a sum over them and six effects
// run under the dots. Pulses, flashes and the HUD numbers come from what actually executed.
import { computed, effect, get, signal, update } from "reflex-quant";
import { still } from "./util";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const CELL = 3; // canvas pixels per field cell; dot is 2x2 inside

type P = { x: number; y: number; vx: number; vy: number; life: number; max: number };
type Pulse = { edge: number; t: number; hit: number; leg: 0 | 1 };

function start(cv: HTMLCanvasElement) {
  const ctx = cv.getContext("2d")!;
  let W = 0, H = 0, img: ImageData, field = new Float32Array(0);
  let mx = 0.35, my = 0.25, tmx = mx, tmy = my; // light direction source (0..1)
  const parts: P[] = [], pulses: Pulse[] = [], rings: { r: number; a: number }[] = [];
  let fired = new Float32Array(6);
  let inside = false;

  // ---- the real graph: src -> ring[0..4] -> total, one effect on each computed
  const SHAPES = [(v: number) => v, (v: number) => v >> 1, (v: number) => v % 3, (v: number) => v >> 2, (v: number) => v & 1];
  const stat = { writes: 0, runs: 0, cut: 0, fx: 0 };
  const hit = new Uint8Array(6);                      // which effects ran in the last write
  const src = signal(0);
  const ring = SHAPES.map((f) => computed(() => (stat.runs++, f(get(src)))));
  ring.forEach((c, k) => effect(() => { get(c); stat.fx++; hit[k] = 1; }));
  const total = computed(() => { stat.runs++; let n = 0; for (const c of ring) n += get(c); return n; });
  effect(() => { get(total); stat.fx++; hit[5] = 1; });
  stat.runs = stat.fx = 0;                            // do not count construction
  const NODES = 1 + 6 + 6, EDGES = 5 + 5 + 5 + 1;
  const hud = cv.parentElement!.querySelector<HTMLElement>(".hero-hud");
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const showHud = () => {
    if (hud) hud.textContent = `LIVE GRAPH  reflex-quant
WRITE  ${pad(stat.writes, 4)}
RUNS   ${pad(stat.runs, 4)}
CUTOFF ${pad(stat.cut, 4)}
EFFECT ${pad(stat.fx, 4)}
NODES ${NODES}  EDGES ${EDGES}`;
  };
  let t0 = performance.now(), visible = true, raf = 0;

  const resize = () => {
    const r = cv.getBoundingClientRect();
    W = Math.max(60, Math.floor(r.width / CELL)); H = Math.max(40, Math.floor(r.height / CELL));
    cv.width = W * CELL; cv.height = H * CELL;
    img = ctx.createImageData(cv.width, cv.height);
    field = new Float32Array(W * H);
  };

  // Geometry in field cells, recomputed per frame from size.
  const geo = (t: number) => {
    const wide = W > H * 1.3;
    const cx = W * (wide ? 0.66 : 0.5), cy = H * (wide ? 0.42 : 0.3);
    const R = Math.min(W, H) * (wide ? 0.2 : 0.17);
    const nodes = Array.from({ length: 5 }, (_, k) => {
      const a = t * 0.00012 * (k % 2 ? 1 : -1) + (k * Math.PI * 2) / 5;
      const rr = R * (1.9 + 0.35 * Math.sin(k * 1.7));
      return { x: cx + Math.cos(a) * rr * 1.25, y: cy + Math.sin(a) * rr * 0.7, r: R * (0.16 + 0.04 * (k % 3)) };
    });
    nodes.push({ x: cx + R * 0.2, y: cy + R * 2.25, r: R * 0.2 });   // total
    return { cx, cy, R, nodes };
  };

  const spawn = (cx: number, cy: number, R: number, n: number, burst = false) => {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = (burst ? 0.6 : 0.15) + Math.random() * (burst ? 1.2 : 0.35);
      const max = 60 + Math.random() * (burst ? 90 : 160);
      parts.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.05, life: max, max });
    }
    if (parts.length > 2600) parts.splice(0, parts.length - 2600);
  };

  const write = () => {
    hit.fill(0);
    update(src, (v) => v + 1);                                  // the write; everything below is its trace
    stat.writes++;
    for (let k = 0; k < 5; k++) if (!hit[k]) stat.cut++;        // ran, same value: effect not run
    showHud();
    rings.push({ r: 0, a: 1 });
    for (let e = 0; e < 5; e++) pulses.push({ edge: e, t: -e * 0.04, hit: hit[e], leg: 0 });
    const g = geo(performance.now() - t0);
    spawn(g.cx, g.cy, g.R, 320, true);
  };

  const frame = (now: number) => {
    const t = now - t0;
    mx += (tmx - mx) * 0.06; my += (tmy - my) * 0.06;
    const { cx, cy, R, nodes } = geo(t);
    const f = field;
    // light vector from pointer position
    let lx = (mx - 0.5) * 2, ly = (my - 0.5) * 2, lz = 0.9;
    const ln = Math.hypot(lx, ly, lz); lx /= ln; ly /= ln; lz /= ln;
    const breathe = 1 + 0.03 * Math.sin(t * 0.0015);
    const Rb = R * breathe;
    // scan plane sweeping left to right; edges show up near it and near the pointer
    const sx = (((t * 0.00011) % 1.3) - 0.15) * W, pmx = mx * W, pmy = my * H;
    const reveal = (x: number, y: number) =>
      0.75 * Math.exp(-((x - sx) ** 2) / 30) + (inside ? 0.9 * Math.exp(-((x - pmx) ** 2 + (y - pmy) ** 2) / (R * R * 0.9)) : 0);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - cx) / Rb, dy = (y - cy) / Rb, d2 = dx * dx + dy * dy;
        let v: number;
        if (d2 < 1) {
          const z = Math.sqrt(1 - d2);
          const lam = Math.max(0, dx * lx + dy * ly + z * lz);
          // dark core hollow where the "hand" of the light doesn't reach + rim light
          v = 0.08 + 0.95 * lam ** 1.4 + 0.35 * (1 - z) ** 3;
        } else {
          const d = Math.sqrt(d2) - 1;
          v = 0.5 * Math.exp(-d * 4.5) + 0.06 * Math.exp(-d * 1.6);
        }
        const sd = x - sx;
        f[y * W + x] = sd > -4 && sd < 4 ? v * (1 + 0.6 * Math.exp(-sd * sd / 3)) + 0.07 * Math.exp(-sd * sd / 2) : v;
      }
    }
    // nodes: small lit spheres, brighter right after they fire
    nodes.forEach((n, k) => {
      fired[k] *= 0.95;
      const r = n.r * (1 + fired[k] * 0.5);
      const x0 = Math.max(0, (n.x - r * 3) | 0), x1 = Math.min(W - 1, (n.x + r * 3) | 0);
      const y0 = Math.max(0, (n.y - r * 3) | 0), y1 = Math.min(H - 1, (n.y + r * 3) | 0);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = (x - n.x) / r, dy = (y - n.y) / r, d2 = dx * dx + dy * dy;
        const add = d2 < 1 ? 0.25 + 0.6 * Math.max(0, dx * lx + dy * ly + Math.sqrt(1 - d2) * lz) + fired[k] * 0.6
          : (0.25 + fired[k]) * Math.exp(-(Math.sqrt(d2) - 1) * 2.2);
        f[y * W + x] = Math.max(f[y * W + x], add);
      }
      // dependency edges as dots: src -> ring always faintly, ring -> total only when revealed
      const from = k < 5 ? [{ x: cx, y: cy, base: 0.18 }] : nodes.slice(0, 5).map((m) => ({ x: m.x, y: m.y, base: 0 }));
      for (const a of from) {
        const steps = Math.hypot(n.x - a.x, n.y - a.y) | 0;
        for (let s = 0; s < steps; s += 2) {
          const u = s / steps, x = (a.x + (n.x - a.x) * u) | 0, y = (a.y + (n.y - a.y) * u) | 0;
          if (x >= 0 && y >= 0 && x < W && y < H) f[y * W + x] += a.base + reveal(x, y);
        }
      }
    });
    // pulses along edges: a write reaching each dependent
    for (let k = pulses.length - 1; k >= 0; k--) {
      const p = pulses[k]; p.t += 0.018;
      if (p.t >= 1) {
        pulses.splice(k, 1);
        if (p.leg === 0) {
          fired[p.edge] = p.hit ? 1 : 0.3;                       // cutoff: a dim blink, no flash
          if (p.hit) pulses.push({ edge: p.edge, t: 0, hit: hit[5], leg: 1 });
        } else fired[5] = Math.max(fired[5], p.hit ? 1 : 0.3);
        continue;
      }
      if (p.t < 0) continue;
      const a = p.leg === 0 ? { x: cx, y: cy } : nodes[p.edge], n = p.leg === 0 ? nodes[p.edge] : nodes[5], u = p.t;
      const px = a.x + (n.x - a.x) * u, py = a.y + (n.y - a.y) * u;
      for (let y = (py - 3) | 0; y <= py + 3; y++) for (let x = (px - 3) | 0; x <= px + 3; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        f[y * W + x] += 1.2 * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / 3);
      }
    }
    // rings
    for (let k = rings.length - 1; k >= 0; k--) {
      const g = rings[k]; g.r += 1.6; g.a *= 0.975;
      if (g.a < 0.04) { rings.splice(k, 1); continue; }
      const rr = R + g.r;
      for (let a = 0; a < Math.PI * 2; a += 0.6 / rr) {
        const x = (cx + Math.cos(a) * rr) | 0, y = (cy + Math.sin(a) * rr * 0.92) | 0;
        if (x >= 0 && y >= 0 && x < W && y < H) f[y * W + x] += g.a;
      }
    }
    // particles: shed from the lit side, drift and fade
    if (!still) spawn(cx, cy, Rb, 6);
    for (let k = parts.length - 1; k >= 0; k--) {
      const p = parts[k];
      p.x += p.vx; p.y += p.vy; p.vx *= 0.992; p.vy *= 0.992; p.life--;
      if (p.life <= 0) { parts.splice(k, 1); continue; }
      const x = p.x | 0, y = p.y | 0;
      if (x >= 0 && y >= 0 && x < W && y < H) f[y * W + x] += 0.9 * (p.life / p.max);
    }
    // background stars: fixed hash noise
    // dither to dots
    const d = img.data, cw = W * CELL;
    d.fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = f[y * W + x];
      const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      if ((h & 1023) < 2) v += 0.5;
      if (v <= BAYER[(y & 3) * 4 + (x & 3)]) continue;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const o = ((y * CELL + j) * cw + x * CELL + i) * 4;
        d[o] = d[o + 1] = d[o + 2] = 238; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  // ~30 fps: the whole field is recomputed each frame, and dithered dots do not need more
  let odd = false;
  const loop = (now: number) => { if ((odd = !odd)) frame(now); raf = visible && !still ? requestAnimationFrame(loop) : 0; };
  const kick = () => { if (!raf && visible && !still) raf = requestAnimationFrame(loop); };

  resize();
  if (still) for (let k = 0; k < 120; k++) frame(t0 + k * 16); // settle particles into one still frame
  else kick();
  new ResizeObserver(() => { resize(); if (still) frame(performance.now()); }).observe(cv);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; kick(); }).observe(cv);
  const host = cv.parentElement!;
  host.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect();
    tmx = (e.clientX - r.left) / r.width; tmy = (e.clientY - r.top) / r.height; inside = true;
  });
  host.addEventListener("pointerleave", () => { tmx = 0.35; tmy = 0.25; inside = false; });
  host.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a")) return;
    write(); if (still) frame(performance.now());
  });
  showHud();
  setTimeout(write, 900);
  // heartbeat: the graph takes a write every few seconds while it is on screen
  if (!still) setInterval(() => { if (visible && !document.hidden) write(); }, 6000);
}

document.querySelectorAll<HTMLCanvasElement>(".hero-cv").forEach(start);
