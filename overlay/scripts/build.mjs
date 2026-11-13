// Builds overlay.js, the one classic script a host injects into the page, from src/.
//
//   node scripts/build.mjs [out]    writes overlay.js (or out); overlay.js is not committed
//   import { build } from "./build.mjs"; build()   the text, for the harness server and the app
//
// src/ is ES modules. esbuild starts at src/mount.js, follows the imports and puts every file it
// reaches into one scope, in the order the imports give; nothing is minified, so a line of the
// built script reads as its line in src/ (each file starts with a comment that names it).
// A stylesheet is imported as its text. The result has no imports or exports of its own, so it
// is the body of one function here: a host needs a classic script, and the first statement has
// to be the one that stops a second copy.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

// esbuild is the overlay's own, or the app's: the app's build calls this one, and someone who
// only runs the app has installed the app's packages and not the overlay's.
function esbuild() {
  try {
    return createRequire(import.meta.url)("esbuild");
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err; // installed here and broken: say so, not the app's instead
    return createRequire(path.join(ROOT, "../app/package.json"))("esbuild");
  }
}
const { buildSync } = esbuild();

/** One script from an entry and all it imports. Throws with esbuild's message (a missing file,
 *  a name a file does not export, a write to an imported name). */
function bundle(entry, more) {
  const { outputFiles } = buildSync({
    ...entry,
    bundle: true,
    write: false,
    format: "esm",
    charset: "utf8", // the key symbols and the dashes as they are written, not as escapes
    loader: { ".css": "text" },
    absWorkingDir: ROOT, // the comments that name each file say src/…, wherever the build is run from
    ...more,
  });
  return outputFiles[0].text;
}

/** The overlay. `also` is module code that runs after the overlay's own, with src/ as its
 *  folder: a test puts one of the modules on the page with it. */
export function build(also = "") {
  // (The entry is this one line and not mount.js itself: an entry's exports are kept in the
  // result, and mount.js exports the layer's elements to the other files.)
  const entry = { stdin: { contents: `import "./mount.js";\n${also}\n`, resolveDir: SRC, sourcefile: "entry.js" } };
  // Two files may give a function the same name (three have a `frame`), and one scope then
  // renames all but one. keepNames leaves each function's own name on it: the benchmark counts
  // the overlay's frames by the name of the function asked for.
  const code = bundle(entry, { keepNames: true });
  const protocol = fs.readFileSync(path.join(SRC, "protocol.js"), "utf8").replace(/\n$/, "");
  return `${protocol}\n// Built from src/ by scripts/build.mjs: edit those, not this.\n(() => {\n  "use strict";\n  if (window.__b42) return;\n\n${code}})();\n`;
}

/** The script a host adds among the page's own scripts when the overlay runs in a world apart
 *  from them (src/lookup.js): src/component.js and the listener that answers with it. */
export function buildLookup() {
  return `// Built from src/lookup.js by scripts/build.mjs: edit that, not this.\n(() => {\n  "use strict";\n${bundle({ entryPoints: [path.join(SRC, "lookup.js")] })}})();\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? path.join(ROOT, "overlay.js"));
  fs.writeFileSync(out, build());
  console.log(`built ${path.relative(process.cwd(), out)}`);
}
