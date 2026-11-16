import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { esbuild, root } from "./experiment-runtime.mjs";

const sourcePath = (file) => path.join(root, file).replaceAll("\\", "/");
const referenceDirectory = path.join(root, ".cache", "temporal-ownership");

export async function buildBoundaryOracle() {
  mkdirSync(referenceDirectory, { recursive: true });
  const entry = path.join(referenceDirectory, "oracle.ts");
  const exports = {
    "test/support/imperative-language.ts": ["ImperativeMachine"],
    "test/support/imperative-spec.ts": ["ImperativeSpec"],
    "test/support/imperative-cases.ts": [
      "imperativeCases",
      "composedCallbackCases",
    ],
    "test/support/temporal-boundaries.ts": ["boundaryPrograms"],
    "test/support/history-retirement.ts": [
      "auditRetiredEdges",
      "instrumentRetirement",
    ],
    "test/support/graph.ts": ["checkGraph"],
  };
  writeFileSync(
    entry,
    Object.entries(exports)
      .map(
        ([file, names]) =>
          `export { ${names.join(", ")} } from ${JSON.stringify(sourcePath(file))};`,
      )
      .join("\n"),
  );
  const outfile = path.join(referenceDirectory, "oracle.mjs");
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
  return {
    outfile,
    oracle: await import(pathToFileURL(outfile).href + "?t=" + Date.now()),
  };
}

export async function buildBoundaryRuntime(
  directory,
  oracle,
  { dev, mask, edits = [] },
) {
  mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts"),
    outfile = path.join(directory, "runtime.mjs");
  writeFileSync(
    entry,
    ["index", "kernel", "host", "graph"]
      .map(
        (name) =>
          `export * as ${name === "index" ? "api" : name} from ${JSON.stringify(sourcePath(`src/${name}.ts`))};`,
      )
      .join("\n"),
  );
  const matched = new Set();
  await esbuild().build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    define: { __DEV__: String(dev), __STATS__: "true" },
    logLevel: "silent",
    plugins: [
      {
        name: "operation-scoped-boundary-audits",
        setup(build) {
          build.onLoad(
            { filter: /[\\/]src[\\/](?:kernel|host|graph)\.ts$/ },
            ({ path: file }) => {
              const name = path.basename(file);
              let code = readFileSync(file, "utf8");
              for (let n = 0; n < edits.length; n++) {
                const edit = edits[n];
                if (edit.file !== name) continue;
                if (edit.offset !== undefined) {
                  if (
                    code.slice(
                      edit.offset,
                      edit.offset + edit.needle.length,
                    ) !== edit.needle
                  )
                    throw new Error(
                      "conditional mutation source offset changed",
                    );
                  code =
                    code.slice(0, edit.offset) +
                    edit.replacement +
                    code.slice(edit.offset + edit.needle.length);
                  matched.add(n);
                  continue;
                }
                const occurrences = code.split(edit.needle).length - 1;
                if (!occurrences || (!edit.all && occurrences !== 1))
                  throw new Error(
                    `invalid mutation anchor ${name}: ${occurrences} matches`,
                  );
                code = edit.all
                  ? code.replaceAll(edit.needle, edit.replacement)
                  : code.replace(edit.needle, edit.replacement);
                matched.add(n);
              }
              if (name === "graph.ts") {
                if (mask)
                  code = code
                    .replace("Mask = 0x3fffffff", `Mask = ${mask}`)
                    .replace("SETTLE = 0x1fffffff", `SETTLE = ${mask >> 1}`);
                code = oracle
                  .instrumentRetirement(code)
                  .replace(
                    "export function createNode(",
                    "function __boundaryCreateNode(",
                  );
                code += `\nexport const __boundaryNodes: Node[] = [];\nexport function createNode(...args: Parameters<typeof __boundaryCreateNode>) { const n = __boundaryCreateNode(...args); __boundaryNodes.push(n); return n; }\n`;
              } else if (name === "kernel.ts") {
                code = code.replace(
                  "export function index(c: Node, next: Edge | null): void {",
                  "export function index(c: Node, next: Edge | null): void {\n  __boundaryScopes.owners.add(c); __boundaryScopes.peak = Math.max(__boundaryScopes.peak, __boundaryScopes.owners.size);",
                );
                code = code.replace(
                  "function unindex(n: Node, base: number): void {",
                  "function unindex(n: Node, base: number): void {\n  __boundaryScopes.owners.delete(n);",
                );
                code = code.replace(
                  "const cell = s.slot;",
                  "const cell = s.slot;\n  if (cell !== null) __boundaryScopes.displaced++;",
                );
                code += `\nexport const __boundaryScopes = { owners: new Set<Node>(), peak: 0, displaced: 0 };\nexport function __boundaryRoots() { return { active, cursor, top, slots: stack.slice() }; }\n`;
              } else {
                code += `\nexport function __boundaryRoots() { return { head, size, hold, mask, spare, calm, slots: queue.slice() }; }\n`;
              }
              return { contents: code, loader: "ts" };
            },
          );
        },
      },
    ],
  });
  if (matched.size !== edits.length)
    throw new Error("mutation did not touch every declared source site");
  return {
    outfile,
    sha256: createHash("sha256").update(readFileSync(outfile)).digest("hex"),
  };
}
