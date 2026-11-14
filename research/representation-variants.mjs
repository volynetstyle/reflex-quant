// One independent representation change per area. No new graph state,
// node/edge allocations, per-operation closures, semantic obligations or API.
import ts from "typescript";

function changeFunction(text, name, edit) {
  const source = ts.createSourceFile(
    "variant.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const node = source.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (!node) throw new Error(`missing function ${name}`);
  const result = edit(node.getText(source), node, source);
  return text.slice(0, node.getStart(source)) + result + text.slice(node.end);
}

function once(text, from, to) {
  if (text.split(from).length !== 2)
    throw new Error(`non-unique representation anchor: ${from.slice(0, 80)}`);
  return text.replace(from, to);
}

function coldCatch(text, name, helper, parameters, argumentsText) {
  return changeFunction(text, name, (body, node, source) => {
    const attempt = node.body.statements.find(ts.isTryStatement);
    const block = attempt?.catchClause?.block;
    if (!block || block.statements.at(-1)?.getText(source) !== "throw error;")
      throw new Error(`${name}: unexpected catch`);
    const recovery = block.statements
      .slice(0, -1)
      .map((s) => s.getText(source))
      .join("\n");
    const replaced = once(
      body,
      block.getText(source),
      `{\n    ${helper}(${argumentsText});\n    throw error;\n  }`,
    );
    return `${replaced}\n\nfunction ${helper}(${parameters}): void {\n${recovery}\n}`;
  });
}

export const representationVariants = [
  {
    name: "drain-direct",
    ids: [],
    area: "deliver-drain",
    hypothesis:
      "Duplicate the direct, awake, live, no-cleanup path inside drain; retain deliver for every other case.",
    transform(file, text) {
      if (file !== "host.ts") return text;
      return changeFunction(text, "drain", (body) =>
        once(
          body,
          "deliver(queuedWatcher, queuedWatcher.flags & ~Flag.Queued);",
          `const flags = queuedWatcher.flags & ~Flag.Queued;
      if ((flags & Flag.Wake) === Flag.Woken && queuedWatcher.fn !== null && typeof queuedWatcher.value !== "function") {
        queuedWatcher.flags = flags & ~Flag.Wake;
        exec(queuedWatcher);
      } else {
        deliver(queuedWatcher, flags);
      }`,
        ),
      );
    },
  },
  {
    name: "exec-recovery",
    ids: [],
    area: "exec",
    hypothesis:
      "Move only failure context restoration and fail() into a cold helper; successful execution adds no call.",
    transform(file, text) {
      return file === "kernel.ts"
        ? coldCatch(
            text,
            "exec",
            "recoverExec",
            "n: Node, base: number, prev: Node | null, prevCursor: Edge | null",
            "n, base, prev, prevCursor",
          )
        : text;
    },
  },
  {
    name: "miss-tail",
    ids: [],
    area: "tracking-miss",
    hypothesis:
      "Keep the immediate-successor skip in miss; move the later bounded tail scan and near fallback out of that branch.",
    transform(file, text) {
      if (file !== "kernel.ts") return text;
      return changeFunction(text, "miss", (body, node, source) => {
        const branch = node.body.statements.find(
          (s) =>
            ts.isIfStatement(s) &&
            s.expression.getText(source) === "next !== null",
        );
        if (!branch || !ts.isBlock(branch.thenStatement))
          throw new Error("miss: missing suffix branch");
        const statements = branch.thenStatement.statements;
        if (statements[2]?.getText(source) !== "let budget = TAIL;")
          throw new Error("miss: tail shape changed");
        const tail = statements
          .slice(2)
          .map((s) => s.getText(source))
          .join("\n");
        const helperBody = once(tail, "e = c.lastDep!;", "let e = c.lastDep!;");
        const start = statements[2].getFullStart() - node.getStart(source);
        const end = branch.thenStatement.end - 1 - node.getStart(source);
        return (
          body.slice(0, start) +
          "\n    return missTail(c, s, last, next, first);\n  " +
          body.slice(end) +
          `\n\nfunction missTail(c: Node, s: Node, last: Edge | null, next: Edge, first: Edge): void {\n${helperBody}\n  near(c, s, last, next, first);\n}`
        );
      });
    },
  },
  {
    name: "verify-recovery",
    ids: [],
    area: "verify-pull",
    hypothesis:
      "Move the existing failed-validation unwind into a helper; keep the same iterative validator and catch boundary.",
    transform(file, text) {
      return file === "kernel.ts"
        ? coldCatch(
            text,
            "verify",
            "recoverVerify",
            "n: Node, base: number",
            "n, base",
          )
        : text;
    },
  },
];

export const representationWorkloads = {
  "drain-direct": [
    ["mechanisms", "push.effects-1000"],
    ["scenarios", "fan-out.effects-1000"],
    ["mechanisms", "effect.through-computed"],
    ["mechanisms", "lifecycle.effect-mount-dispose"],
    ["mechanisms", "batch.coalesce-64"],
  ],
  "exec-recovery": [
    ["mechanisms", "pull.recompute-chain-100"],
    ["mechanisms", "push.effects-1000"],
    ["mechanisms", "track.stable-64"],
    ["mechanisms", "pull.diamond-1000"],
    ["mechanisms", "lifecycle.effect-mount-dispose"],
  ],
  "miss-tail": [
    ["scenarios", "reorder.rotate-256"],
    ["scenarios", "reorder.reverse-8"],
    ["mechanisms", "track.fresh-after-reorder-64"],
    ["mechanisms", "track.stable-64"],
    ["mechanisms", "track.swap-32"],
  ],
  "verify-recovery": [
    ["mechanisms", "pull.validate-wide-256"],
    ["mechanisms", "push.chain-cutoff-100"],
    ["mechanisms", "pull.recompute-chain-100"],
    ["mechanisms", "pull.diamond-1000"],
    ["scenarios", "static.read-clean"],
  ],
};
