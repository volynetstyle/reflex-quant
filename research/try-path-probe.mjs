// Counting build only: establish whether delivery enters the stale branch.
// Never use its instrumented bundle for timings or optimization traces.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { suites } from "../bench/suites.mjs";
const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, ".cache/try-sites");
mkdirSync(dir, { recursive: true });
const host = path.join(root, "src/host.ts");
let text = readFileSync(host, "utf8");
const edit = (from, to) => {
  if (text.split(from).length !== 2)
    throw new Error(`non-unique probe anchor ${from}`);
  text = text.replace(from, to);
};
edit(
  "function deliver(w: Node, flags: Flags): void {",
  "function deliver(w: Node, flags: Flags): void {\n  deliveryProbe.deliveries++;",
);
edit(
  "if ((flags & Flag.Stale) !== 0) {",
  "if ((flags & Flag.Stale) !== 0) {\n    deliveryProbe.stale++;",
);
text += "\nexport const deliveryProbe = { deliveries: 0, stale: 0 };\n";
const outfile = path.join(dir, "path-probe.mjs");
await esbuild.build({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(root, "bench/adapters/quant.mjs"))}; export { deliveryProbe } from ${JSON.stringify(host)};`,
    resolveDir: root,
    loader: "js",
  },
  plugins: [
    {
      name: "counter",
      setup(build) {
        build.onLoad({ filter: /[\\/]src[\\/]host\.ts$/ }, () => ({
          contents: text,
          loader: "ts",
          resolveDir: path.dirname(host),
        }));
      },
    },
  ],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  define: { __DEV__: "false", __STATS__: "false" },
  outfile,
});
const api = await import(pathToFileURL(outfile).href);
const rows = [];
for (const id of ["push.effects-1000", "effect.through-computed"]) {
  const step = suites.mechanisms.find((s) => s.id === id).setup(api);
  api.deliveryProbe.deliveries = api.deliveryProbe.stale = 0;
  for (let i = 1; i <= 64; i++) step(i);
  rows.push({ id, ...api.deliveryProbe });
}
if (rows[0].deliveries !== 64000 || rows[0].stale !== 0 || rows[1].stale !== 64)
  throw new Error(`unexpected path counts: ${JSON.stringify(rows)}`);
writeFileSync(
  path.join(dir, "path-probe.json"),
  JSON.stringify(rows, null, 2) + "\n",
);
console.log(JSON.stringify(rows));
