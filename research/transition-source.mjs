import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { root } from "./experiment-runtime.mjs";

const require = createRequire(path.join(root, "package.json"));
export const ts = require("typescript");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const compact = (text) => text.replace(/\s+/g, " ").trim();
const scoped = {
  "kernel.exec": ["prev", "prevCursor", "base", "value"],
  "kernel.untracked": ["prev"],
  "kernel.mark": ["base"],
  "kernel.verify": ["base"],
  "kernel.claim": ["cell"],
  "host.deliver": ["cleanup"],
  "host.stop": ["cleanup"],
  "host.drain": ["queuedWatcher", "first", "failed"],
  "host.batch": ["value"],
};
export function productionSource(overrides = {}) {
  const config = ts.readConfigFile(
    path.join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const host = ts.createCompilerHost(parsed.options),
    read = host.readFile.bind(host);
  host.readFile = (file) => overrides[path.basename(file)] ?? read(file);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host),
    checker = program.getTypeChecker();
  const files = program
    .getSourceFiles()
    .filter(
      (f) =>
        f.fileName
          .replaceAll("\\", "/")
          .startsWith(path.join(root, "src").replaceAll("\\", "/") + "/") &&
        !f.isDeclarationFile,
    );
  const moduleName = (f) => path.basename(f.fileName, ".ts");
  const unalias = (s) =>
    s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  const unwrap = (n) => {
    while (
      n &&
      (ts.isAsExpression(n) ||
        ts.isNonNullExpression(n) ||
        ts.isParenthesizedExpression(n) ||
        ts.isSatisfiesExpression(n))
    )
      n = n.expression;
    return n;
  };
  const nearest = (n) => {
    for (let p = n.parent; p; p = p.parent)
      if (ts.isFunctionLike(p) && p.body) return p;
    return undefined;
  };
  const functionName = (n) =>
    `${moduleName(n.getSourceFile())}.${n.name?.getText() ?? `callback@${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1}`}`;
  const declaration = (s) =>
    unalias(s)?.declarations?.find(
      (d) => ts.isFunctionDeclaration(d) && d.body,
    ) ?? unalias(s)?.valueDeclaration;
  const functions = new Map();
  for (const f of files)
    for (const s of f.statements)
      if (ts.isFunctionDeclaration(s) && s.body)
        functions.set(functionName(s), s);
  function resolve(expr, seen = new Set()) {
    expr = unwrap(expr);
    if (!expr) return { kind: "unknown" };
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr))
      return { kind: "internal", node: expr, id: functionName(expr) };
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === "fn")
      return { kind: "callback", id: "node.fn" };
    const text = expr.getText();
    if (text === "Object.is") return { kind: "intrinsic", id: text };
    const s = unalias(checker.getSymbolAtLocation(expr));
    const d = declaration(s);
    if (
      d &&
      ts.isFunctionDeclaration(d) &&
      d.body &&
      files.includes(d.getSourceFile())
    )
      return { kind: "internal", node: d, id: functionName(d) };
    if (d && ts.isParameter(d))
      return { kind: "callback", id: d.name.getText() };
    if (d && ts.isVariableDeclaration(d)) {
      if (
        moduleName(d.getSourceFile()) === "kernel" &&
        d.name.getText() === "wake"
      )
        return {
          kind: "internal",
          node: functions.get("host.wake"),
          id: "host.wake",
          dispatch: "onWake registration",
        };
      if (seen.has(d)) return { kind: "unknown", id: text };
      seen.add(d);
      if (d.initializer) return resolve(d.initializer, seen);
    }
    return { kind: "unknown", id: text };
  }
  function bool(n) {
    n = unwrap(n);
    if (!n) return undefined;
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(n) && ["__DEV__", "__STATS__"].includes(n.text))
      return false;
    if (
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const b = bool(n.operand);
      return b === undefined ? undefined : !b;
    }
    if (ts.isBinaryExpression(n)) {
      const a = bool(n.left),
        b = bool(n.right);
      if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return a === false || b === false
          ? false
          : a === true
            ? b
            : b === true
              ? a
              : undefined;
      if (n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        return a === true || b === true
          ? true
          : a === false
            ? b
            : b === false
              ? a
              : undefined;
    }
    return undefined;
  }
  function children(n, visit) {
    if (ts.isTypeNode(n)) return;
    if (ts.isIfStatement(n)) {
      visit(n.expression);
      const b = bool(n.expression);
      if (b !== false) visit(n.thenStatement);
      if (b !== true && n.elseStatement) visit(n.elseStatement);
      return;
    }
    if (ts.isConditionalExpression(n)) {
      visit(n.condition);
      const b = bool(n.condition);
      if (b !== false) visit(n.whenTrue);
      if (b !== true) visit(n.whenFalse);
      return;
    }
    if (
      ts.isBinaryExpression(n) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
      ].includes(n.operatorToken.kind)
    ) {
      visit(n.left);
      const b = bool(n.left);
      if (
        !(
          b === false &&
          n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) &&
        !(b === true && n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      )
        visit(n.right);
      return;
    }
    ts.forEachChild(n, visit);
  }
  const entry = files.find((f) => moduleName(f) === "index"),
    api = [],
    exportedBindings = [];
  for (const s of checker.getExportsOfModule(
    checker.getSymbolAtLocation(entry),
  )) {
    const d = declaration(s);
    if (!d) continue;
    const r = ts.isFunctionDeclaration(d)
      ? resolve(d.name)
      : ts.isVariableDeclaration(d)
        ? resolve(d.initializer)
        : undefined;
    if (r?.kind === "internal") {
      api.push({ name: s.name, entry: r.id });
      if (ts.isVariableDeclaration(d)) exportedBindings.push(d);
    } else if (
      d &&
      [
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.FunctionDeclaration,
      ].includes(d.kind)
    )
      throw new Error(`Unclassified public value ${s.name}`);
  }
  const reachable = new Map(),
    globals = new Map(),
    calls = [],
    unknownCalls = [],
    queue = api.map((a) => functions.get(a.entry));
  // An unused binding may still have an observable initializer. Reachability
  // from API values alone must not erase module-startup calls or stores.
  const hasStartupEffect = (n) => {
    if (ts.isFunctionLike(n) || ts.isTypeNode(n)) return false;
    if (
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isDeleteExpression(n) ||
      ts.isAwaitExpression(n) ||
      (ts.isBinaryExpression(n) &&
        ts.isAssignmentOperator(n.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
          n.operator,
        ))
    )
      return true;
    let found = false;
    children(n, (child) => {
      if (hasStartupEffect(child)) found = true;
    });
    return found;
  };
  const topExpressions = files.flatMap((f) =>
    f.statements.filter(
      (s) =>
        !ts.isFunctionDeclaration(s) &&
        !ts.isEnumDeclaration(s) &&
        !ts.isImportDeclaration(s) &&
        !ts.isExportDeclaration(s) &&
        hasStartupEffect(s),
    ),
  );
  const scheduleGlobal = (d) => {
    const id = `${moduleName(d.getSourceFile())}.${d.name.getText()}`;
    if (!globals.has(id)) {
      globals.set(id, d);
      queue.push(d);
    }
  };
  exportedBindings.forEach(scheduleGlobal);
  const visited = new Set(),
    walkedReach = new Set();
  function walkReach(n) {
    if (!n || walkedReach.has(n)) return;
    walkedReach.add(n);
    if (ts.isFunctionLike(n) && n.body) reachable.set(functionName(n), n);
    if (ts.isIdentifier(n)) {
      const d = declaration(checker.getSymbolAtLocation(n));
      if (
        d &&
        ts.isVariableDeclaration(d) &&
        !nearest(d) &&
        files.includes(d.getSourceFile())
      )
        scheduleGlobal(d);
    }
    if (ts.isCallExpression(n)) {
      const owner = nearest(n)
        ? functionName(nearest(n))
        : `${moduleName(n.getSourceFile())}.<init>`;
      const expr = unwrap(n.expression);
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === "fill" &&
        checker.isArrayType(checker.getTypeAtLocation(expr.expression))
      )
        calls.push({
          owner,
          kind: "intrinsic-write",
          target: "Array.fill",
          line:
            n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line +
            1,
        });
      else {
        const r = resolve(expr);
        const site = {
          owner,
          kind: r.kind,
          target: r.id,
          line:
            n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line +
            1,
          ...(r.id === "kernel.onWake"
            ? { registrationTarget: resolve(n.arguments[0]).id }
            : {}),
        };
        calls.push(site);
        if (r.kind === "internal") queue.push(r.node);
        else if (r.kind === "unknown") unknownCalls.push(site);
      }
    }
    if (
      ts.isNewExpression(n) &&
      n.expression.getText() !== "Array" &&
      n.expression.getText() !== "Error"
    )
      unknownCalls.push({
        owner: nearest(n) ? functionName(nearest(n)) : "init",
        kind: "new",
        target: n.expression.getText(),
      });
    children(n, walkReach);
  }
  queue.push(...topExpressions);
  while (queue.length) {
    const n = queue.shift();
    if (!n || visited.has(n)) continue;
    visited.add(n);
    if (ts.isFunctionLike(n)) {
      reachable.set(functionName(n), n);
      walkReach(n.body);
    } else walkReach(n);
  }
  const sites = [],
    locals = [],
    unknownWrites = [];
  function typeName(n) {
    const t = checker.getTypeAtLocation(n);
    const name = t.aliasSymbol?.name ?? t.getSymbol()?.name;
    if (name === "Node" || name === "Edge") return name;
    if (checker.isArrayType(t) || name === "WorkStack") return "array";
    return undefined;
  }
  function targetKind(n, owner) {
    n = unwrap(n);
    if (ts.isIdentifier(n)) {
      const d = declaration(checker.getSymbolAtLocation(n));
      if (d && (ts.isVariableDeclaration(d) || ts.isParameter(d))) {
        if (!nearest(d))
          return {
            kind: "persistent",
            target: `${moduleName(d.getSourceFile())}.${d.name.getText()}`,
          };
        if (scoped[owner]?.includes(n.text))
          return { kind: "scoped-owner", target: `${owner}.${n.text}` };
        return { kind: "local", target: n.text };
      }
    }
    if (ts.isPropertyAccessExpression(n)) {
      const t = typeName(n.expression);
      if (t)
        return {
          kind: "persistent",
          target: `${t}.${n.name.text}`,
          base: n.expression.getText(),
        };
    }
    if (ts.isElementAccessExpression(n)) {
      const t = typeName(n.expression);
      if (t === "array")
        return {
          kind: "persistent",
          target: "array.cell",
          base: n.expression.getText(),
        };
    }
    return { kind: "unknown", target: n.getText() };
  }
  function emit(n, target, operation, expression = n) {
    const f = n.getSourceFile(),
      owner = nearest(n) ? functionName(nearest(n)) : `${moduleName(f)}.<init>`;
    const site = {
      file: `src/${path.basename(f.fileName)}`,
      owner,
      line: f.getLineAndCharacterOfPosition(n.getStart()).line + 1,
      offset: n.getStart(),
      operation,
      ...target,
      text: compact(expression.getText()),
      _node: expression,
    };
    if (target.kind === "local") {
      locals.push(site);
      return;
    }
    if (target.kind === "unknown") unknownWrites.push(site);
    sites.push(site);
  }
  function walkWrites(n) {
    if (
      ts.isBinaryExpression(n) &&
      ts.isAssignmentOperator(n.operatorToken.kind)
    )
      emit(
        n,
        targetKind(n.left, nearest(n) ? functionName(nearest(n)) : "init"),
        "assign",
        n,
      );
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        n.operator,
      )
    )
      emit(
        n,
        targetKind(n.operand, nearest(n) ? functionName(nearest(n)) : "init"),
        "update",
        n,
      );
    if (ts.isVariableDeclaration(n) && n.initializer)
      emit(
        n,
        targetKind(n.name, nearest(n) ? functionName(nearest(n)) : "init"),
        "initialize",
        n,
      );
    if (ts.isCatchClause(n) && n.variableDeclaration)
      emit(
        n.variableDeclaration,
        { kind: "scoped-owner", target: `${functionName(nearest(n))}.error` },
        "exception-capture",
        n.variableDeclaration,
      );
    if (
      ts.isParameter(n) &&
      scoped[functionName(nearest(n))]?.includes(n.name.getText())
    )
      emit(
        n,
        {
          kind: "scoped-owner",
          target: `${functionName(nearest(n))}.${n.name.getText()}`,
        },
        "parameter-bind",
        n,
      );
    if (ts.isObjectLiteralExpression(n)) {
      const context = checker.getContextualType(n),
        name = context?.aliasSymbol?.name ?? context?.getSymbol()?.name;
      if (name === "Node" || name === "Edge")
        for (const p of n.properties) {
          if (
            !ts.isPropertyAssignment(p) &&
            !ts.isShorthandPropertyAssignment(p)
          ) {
            unknownWrites.push({
              file: n.getSourceFile().fileName,
              text: p.getText(),
            });
            continue;
          }
          emit(
            p,
            {
              kind: "persistent",
              target: `${name}.${p.name.getText()}`,
              base: "fresh",
            },
            "object-initialize",
            p,
          );
        }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "fill"
    )
      emit(
        n,
        {
          kind: "persistent",
          target: "array.bulk-fill",
          base: n.expression.expression.getText(),
        },
        "bulk-fill",
        n,
      );
    if (ts.isDeleteExpression(n))
      emit(n, { kind: "unknown", target: n.expression.getText() }, "delete", n);
    children(n, walkWrites);
  }
  for (const n of reachable.values()) {
    for (const p of n.parameters) walkWrites(p);
    walkWrites(n.body);
  }
  for (const n of globals.values()) walkWrites(n);
  for (const n of topExpressions) walkWrites(n);
  // Nested expressions are reached both via a containing closure and its call.
  const unique = new Map();
  for (const s of sites) unique.set(`${s.file}:${s.offset}:${s.target}`, s);
  const occurrences = new Map();
  const writes = [...unique.values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset)
    .map((s) => {
      const stem = `${s.owner}|${s.operation}|${s.target}`,
        count = (occurrences.get(stem) ?? 0) + 1;
      occurrences.set(stem, count);
      return { ...s, id: `${stem}|${count}`, sha256: hash(s.text) };
    });
  const constantEnvironmentSha256 = hash(
    files
      .flatMap((f) =>
        f.statements
          .filter(ts.isEnumDeclaration)
          .map((n) => compact(n.getText())),
      )
      .join("\n"),
  );
  return {
    api: api.sort((a, b) => a.name.localeCompare(b.name)),
    constantEnvironmentSha256,
    reachable: [...reachable.keys()].sort(),
    globals: [...globals.keys()].sort(),
    functionNodes: Object.fromEntries(reachable),
    closureParents: Object.fromEntries(
      [...reachable]
        .filter(([, n]) => nearest(n))
        .map(([name, n]) => [name, functionName(nearest(n))]),
    ),
    bodyHashes: Object.fromEntries(
      [...reachable].map(([name, n]) => [
        name,
        hash(compact(n.body.getText())),
      ]),
    ),
    calls,
    unknownCalls,
    unknownWrites,
    writes,
    locals,
    sourceSha256: hash(
      files
        .map(
          (f) =>
            `${path.basename(f.fileName)}\n${f.text.replaceAll("\r\n", "\n")}`,
        )
        .join("\n"),
    ),
    checker,
    program,
    bool,
    children,
    unwrap,
    resolve,
  };
}

if (process.argv[1]?.endsWith("transition-source.mjs")) {
  const inventory = productionSource();
  console.log(
    JSON.stringify(
      {
        api: inventory.api,
        reachable: inventory.reachable,
        globals: inventory.globals,
        unknownCalls: inventory.unknownCalls,
        unknownWrites: inventory.unknownWrites.map(({ _node, ...s }) => s),
        writes: inventory.writes.map(({ _node, ...s }) => s),
      },
      null,
      2,
    ),
  );
}
