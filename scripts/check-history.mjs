// Strict test-oracle check without importing the historical Reflex runtime.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const fromVitest = createRequire(require.resolve("vitest/package.json"));
const config = ts.readConfigFile(
  path.join(root, "tsconfig.json"),
  ts.sys.readFile,
);
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
  );
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const options = {
  ...parsed.options,
  declaration: false,
  isolatedDeclarations: false,
  noEmit: true,
  types: ["node"],
  typeRoots: [
    path.dirname(path.dirname(fromVitest.resolve("@types/node/package.json"))),
  ],
};
const files = [
  "src/globals.d.ts",
  "test/history-reentrant.test.ts",
  "test/history-counter-wrap.test.ts",
  "test/history-greybox.test.ts",
  "test/history-temporal-witnesses.test.ts",
].map((file) => path.join(root, file));
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(files, options));
if (diagnostics.length)
  process.stdout.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
else
  process.stdout.write(
    "strict imperative/host/counter/greybox oracle typecheck passed\n",
  );
process.exitCode = diagnostics.length ? 1 : 0;
