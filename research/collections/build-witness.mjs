// Counting build only. Instrument the real Quant allocation site in memory;
// neither source files nor production build scripts are changed.
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "../..");
mkdirSync(path.join(root, ".cache/collections"), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, "research/collections/witness.ts")],
  outfile: path.join(root, ".cache/collections/witness.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  define: { __DEV__: "false", __STATS__: "false" },
  plugins: [
    {
      name: "count-real-quant-nodes",
      setup(build) {
        build.onLoad(
          { filter: /[\\/]src[\\/]graph\.ts$/ },
          ({ path: file }) => {
            const text = readFileSync(file, "utf8"),
              parsed = ts.createSourceFile(
                file,
                text,
                ts.ScriptTarget.Latest,
                true,
              );
            const fn = parsed.statements.find(
              (n) =>
                ts.isFunctionDeclaration(n) && n.name?.text === "createNode",
            );
            if (!fn?.body)
              throw new Error("Quant createNode allocation site moved");
            const at = fn.body.getStart(parsed) + 1;
            return {
              contents:
                "export let collectionWitnessNodes = 0;\n" +
                text.slice(0, at) +
                "\ncollectionWitnessNodes++;\n" +
                text.slice(at),
              loader: "ts",
              resolveDir: path.dirname(file),
            };
          },
        );
      },
    },
  ],
});
