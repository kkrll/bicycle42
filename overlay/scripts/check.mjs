// Checks the built overlay for names that resolve nowhere. Its pieces share one closure, so such a
// name fails only when its line runs, and a test may never run it.
//
//   node scripts/check.mjs    builds overlay.js to a temporary file, checks it, exits 1 on an error
//
// TypeScript reads the built script as JavaScript and reports the names it cannot find, and the
// ones used before they are declared. It lets any member of an object literal through in a .js
// file, so the members of a module are checked here, with its types: Canvas.nope fails when
// Canvas's api has no nope. Everything else TypeScript says about the script is left out: the
// overlay is not written for it. An error is shown at its line in src/ (the built script names
// each piece where it starts) and at its line in the built file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build, PARTS, MARK } from "./build.mjs";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const OUT = path.join(os.tmpdir(), "b42-check-overlay.js");
const t0 = performance.now();
fs.writeFileSync(OUT, build());

const program = ts.createProgram([OUT], {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
});
const checker = program.getTypeChecker();
const file = program.getSourceFile(OUT);
const errors = []; // [position, message]

// The names TypeScript cannot find, or finds used before their declaration.
for (const d of program.getSemanticDiagnostics(file)) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
  if (/^Cannot find name|used before its declaration/.test(message)) errors.push([d.start, message]);
}

// A module's members: Name.member, where Name is the module's const, needs member in its api.
const modules = new Set(PARTS.filter((p) => typeof p !== "string").map((p) => p.module));
const isModule = (decl) => decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && modules.has(decl.name.text);
(function walk(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && modules.has(node.expression.text)) {
    const decl = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
    const name = node.name.text;
    if (isModule(decl) && !checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), name))
      errors.push([node.name.getStart(file), `${node.expression.text} has no '${name}': its api does not declare it.`]);
  }
  ts.forEachChild(node, walk);
})(file);

// Where a line of the built script is in src/: the piece whose marker is above it, and the line
// in that piece, counting an include("…") as the lines it became.
const built = fs.readFileSync(OUT, "utf8").split("\n");
function where(line, col) {
  for (let m = line - 1; m >= 0; m--) {
    const at = built[m].indexOf(MARK);
    if (at < 0 || built[m].slice(0, at).trim()) continue;
    const name = built[m].slice(at + MARK.length);
    let n = line - m;
    const lines = fs.readFileSync(path.join(SRC, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const inc = lines[i].match(/include\("([^"]+)"\)/);
      const size = inc ? fs.readFileSync(path.join(SRC, inc[1]), "utf8").replace(/\n$/, "").split("\n").length + 2 : 1;
      if (n <= size) return `src/${name}:${i + 1}:${Math.max(1, col - at)}`;
      n -= size;
    }
    return `src/${name} (after its end)`;
  }
  return "(the built script's own lines)";
}

const seconds = ((performance.now() - t0) / 1000).toFixed(1);
if (!errors.length) {
  console.log(`check: no unknown names or module members in ${built.length} lines (${seconds} s)`);
} else {
  errors.sort((a, b) => a[0] - b[0]);
  for (const [pos, message] of errors) {
    const { line, character } = file.getLineAndCharacterOfPosition(pos);
    console.error(`${where(line, character + 1)}  ${message}\n  built: ${OUT}:${line + 1}:${character + 1}`);
  }
  console.error(`check: ${errors.length} error${errors.length > 1 ? "s" : ""} (${seconds} s)`);
  process.exitCode = 1;
}
