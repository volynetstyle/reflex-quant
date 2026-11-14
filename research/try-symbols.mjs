// Map actual minified bundle functions back to host symbols for V8 filters.
// source-map-js is already pinned in this repository's dependency lockfile.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
const { SourceMapConsumer } = createRequire(import.meta.url)("source-map-js");
const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, ".cache/try-sites");
const { variants } = JSON.parse(
  readFileSync(path.join(dir, "sites.json"), "utf8"),
);
const symbols = {};
const required = process.argv[2]?.split(",") ?? ["deliver", "drain"];
for (const variant of variants) {
  const file = path.join(dir, variant.name, "index.mjs");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const map = new SourceMapConsumer(
    JSON.parse(readFileSync(file + ".map", "utf8")),
  );
  const functions = {};
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name) continue;
    const pos = source.getLineAndCharacterOfPosition(
      node.name.getStart(source),
    );
    const original = map.originalPositionFor({
      line: pos.line + 1,
      column: pos.character,
    });
    if (original.name && /\/(host|kernel)\.ts$/.test(original.source ?? "")) {
      functions[original.name] = {
        name: node.name.text,
        source: original.source,
        line: original.line,
        column: original.column,
      };
    }
  }
  for (const name of required)
    if (!functions[name])
      throw new Error(`${variant.name}: no mapping for ${name}`);
  symbols[variant.name] = functions;
}
writeFileSync(
  path.join(dir, "symbols.json"),
  JSON.stringify(symbols, null, 2) + "\n",
);
console.log(JSON.stringify(symbols, null, 2));
