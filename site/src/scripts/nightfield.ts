// Night backdrop for the firefly demo: a photo, downscaled to pixel art and recoloured to
// night in the browser, then cached (localStorage) so later visits skip the processing.
export const SW = 256, SH = 176;
export const FIELD_TOP = 0.56; // where the field starts in the photo, as a fraction of height
const KEY = "ff-night-v2";

function nightify(src: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = SW; c.height = SH;
  const x = c.getContext("2d")!;
  x.imageSmoothingQuality = "high";
  x.drawImage(src, 0, 0, SW, SH);
  const img = x.getImageData(0, 0, SW, SH), d = img.data;
  const q = (v: number) => Math.round(v / 6) * 6; // posterize: fewer tones, more pixel-art
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = Math.pow((0.3 * r + 0.59 * g + 0.11 * b) / 255, 1.25);
    // moonlight: luminance mapped onto navy, a little of the original hue kept
    d[i] = q(8 + l * 52 + r * 0.06);
    d[i + 1] = q(12 + l * 66 + g * 0.06);
    d[i + 2] = q(28 + l * 112 + b * 0.05);
  }
  x.putImageData(img, 0, 0);
  return c;
}

/** Resolves to the processed backdrop; from cache when possible. */
export async function loadScene(url: string): Promise<CanvasImageSource> {
  const load = (s: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = s; });
  try {
    const hit = localStorage.getItem(KEY);
    if (hit) return await load(hit);
  } catch { /* storage off or corrupt: rebuild */ }
  const night = nightify(await load(url));
  try { localStorage.setItem(KEY, night.toDataURL("image/png")); } catch { /* quota: fine, just not cached */ }
  return night;
}

