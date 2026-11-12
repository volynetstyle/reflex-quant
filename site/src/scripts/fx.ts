// Site-wide depth: a small virtual camera, blocks that come into focus, a scroll rail.
// Progressive: without it (or with reduced motion) the page is the plain document.
// Cost: the pointer never touches the root. --mx/--my go only onto the elements that use them
// (backdrop, hero, tilted figures in view), so a mouse move restyles a handful of nodes.
import { still } from "./util";

const root = document.documentElement;
const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
const camera = new Set<HTMLElement>(document.querySelectorAll<HTMLElement>(".bg, .hero"));

if (!still && fine) {
  let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
  const tick = () => {
    x += (tx - x) * 0.08; y += (ty - y) * 0.08;
    const sx = x.toFixed(3), sy = y.toFixed(3);
    for (const el of camera) { el.style.setProperty("--mx", sx); el.style.setProperty("--my", sy); }
    raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.002 ? requestAnimationFrame(tick) : 0;
  };
  addEventListener("pointermove", (e) => {
    tx = (e.clientX / innerWidth) * 2 - 1; ty = (e.clientY / innerHeight) * 2 - 1;
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
}

// Focus: blocks sit slightly back until they enter the reading band. Figures with drawings or
// canvases also tilt with the camera while in view; text blocks never tilt, so they stay crisp.
if (!still && "IntersectionObserver" in window) {
  root.classList.add("fx");
  document.querySelectorAll<SVGGeometryElement>(".dg :is(line, path).dg-l").forEach((l, k) => {
    l.setAttribute("pathLength", "1");
    l.style.setProperty("--d", `${(k % 12) * 45}ms`);
  });
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      const el = e.target as HTMLElement;
      el.classList.toggle("in", e.isIntersecting);
      if (e.isIntersecting) el.classList.add("seen");
      if (el.classList.contains("tilt")) e.isIntersecting ? camera.add(el) : camera.delete(el);
    }
  }, { rootMargin: "-10% 0px -6% 0px" });
  document.querySelectorAll<HTMLElement>("article :is(figure, pre, .pg, .cols, .stats, .callout, table)").forEach((b) => {
    if (b.parentElement?.closest("figure, .pg")) return;
    b.classList.add("fxb");
    if (b.matches("figure:not(.strip)") && !b.querySelector("pre, table")) b.classList.add("tilt");
    io.observe(b);
  });
}

// Rail: scroll progress along the top edge (a transform, so it never triggers layout).
const rail = document.querySelector<HTMLElement>(".rail");
if (rail) {
  let queued = false;
  const set = () => {
    queued = false;
    const max = root.scrollHeight - innerHeight;
    rail.style.setProperty("--p", max > 0 ? (scrollY / max).toFixed(4) : "0");
  };
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(set); } };
  addEventListener("scroll", ask, { passive: true });
  addEventListener("resize", ask, { passive: true });
  set();
}
