import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const require = createRequire(path.join(root, "package.json"));
function esbuild() {
  try {
    return require("esbuild");
  } catch {
    /* isolated pnpm dependency layout */
  }
  for (let dir = root; ; dir = path.dirname(dir)) {
    const store = path.join(dir, "node_modules", ".pnpm");
    if (existsSync(store))
      for (const name of readdirSync(store).filter((name) =>
        name.startsWith("esbuild@"),
      )) {
        const entry = path.join(
          store,
          name,
          "node_modules",
          "esbuild",
          "lib",
          "main.js",
        );
        if (existsSync(entry)) return require(entry);
      }
    if (path.dirname(dir) === dir)
      throw new Error("installed esbuild unavailable");
  }
}

/** Clean production source: no Vitest root/retirement/allocation instrumentation. */
export async function buildExperimentRuntime(label) {
  const directory = path.join(root, ".cache", "history-experiments", label);
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts"),
    outfile = path.join(directory, "runtime.mjs");
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(root, "src/index.ts").replaceAll("\\", "/"))};\nexport { stackLength, stackHighWater } from ${JSON.stringify(path.join(root, "src/kernel.ts").replaceAll("\\", "/"))};\n`,
  );
  await esbuild().build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    define: { __DEV__: "false", __STATS__: "false" },
    logLevel: "silent",
  });
  if (/__history|retirement integrity/.test(readFileSync(outfile, "utf8")))
    throw new Error("instrumented physical/timing build");
  return {
    directory,
    outfile,
    url: pathToFileURL(outfile).href,
    sha256: createHash("sha256").update(readFileSync(outfile)).digest("hex"),
  };
}

export function scalarGraph(nodes) {
  const ids = new Map(nodes.map((node, index) => [node, index]));
  return nodes.map((node) => {
    const deps = [];
    for (let edge = node.firstDep; edge !== null; edge = edge.nextDep)
      deps.push(ids.get(edge.from));
    return {
      value: typeof node.value === "function" ? "cleanup" : node.value,
      callable: node.fn !== null,
      deps,
    };
  });
}
