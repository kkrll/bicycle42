// Builds overlay.js, the one classic script a host injects into the page, from src/.
//
//   node scripts/build.mjs [out]    writes overlay.js (or out); overlay.js is not committed
//   import { build } from "./build.mjs"; build()   the text, for the harness server and the app
//
// The pieces in PARTS are joined, in order, inside one closure, and share its scope: a piece uses
// what the pieces before it declared (and, inside functions, what any piece declares).
// An entry { module, files } is a module: its files share a scope of their own inside the closure,
// and the rest of the overlay sees only the object its files declare as `api`, under `module`.
// include("name") in a piece becomes the text of src/name as a template literal (styles.css).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/** The protocol (a comment) comes first, outside the closure; then these, in this order. */
export const PARTS = [
  "state.js", // the host bridge, the transient state, the elements of the layer
  "ui.js", // the layer's icons, and words with key symbols drawn in them
  "page.js", // geometry, element identity, picking, the rules previews adopt
  "notes.js", // notes mode: the draft, the card, templates, pictures, submit
  "variants.js", // the page's own variants, switched from a small bar
  "sent.js", // after a note is sent: the chip, undo, the pins' tooltip, the host's answer
  {
    module: "Canvas", // canvas mode: the page's real elements edited, the batch sent as one note
    files: [
      "canvas/state.js", // its rules, its limits and its state
      "canvas/stamps.js", // which element an edit is on, after the page re-renders or reloads
      "canvas/css.js", // typed CSS: where declarations start and end, what the browser rejects
      "canvas/apply.js", // the batches shown on the page: adopted rules, DOM writes put back exactly
      "canvas/batch.js", // the unsent batch: commit, undo, reset, its draft
      "canvas/send.js", // a batch sent as one note, given back when refused, dropped when done
      "canvas/select.js", // the selection, what can be grabbed around it, hide, parent and child
      "canvas/drag.js", // drags: resize, gap, reorder
      "canvas/text.js", // text edited in place
      "canvas/cursor.js", // the page's cursor and room under the dock, a drag's live rule
      "canvas/bar.js", // the bar: the batch's count and actions, messages, the two lists
      "canvas/keys.js", // its keys
      "canvas/tree.js", // the inspector's tree of the page's elements
      "canvas/inspector.js", // the inspector's fields: classes, element styles, stylesheet, computed
      "canvas/frame.js", // one frame: the drag's write, the selection's geometry, the drawing
      "canvas/mount.js", // its elements in the layer, and their listeners
      "canvas/api.js", // on and off, and what the rest of the overlay sees
    ],
  },
  "motion.js", // motion mode (the module MO): what moves on the page, one animation per note
  "mode.js", // which mode is on: the host's switch, the brush
  "input.js", // the page's pointer and keys, routed to the mode
  "render.js", // outlines, strokes and pins, one frame at a time
  "mount.js", // the shadow root, the host's API
];

const read = (name) => fs.readFileSync(path.join(SRC, name), "utf8").replace(/\n$/, "");
const indent = (text, n) => text.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

function piece(name) {
  return read(name).replace(/^( *)(.*)include\("([^"]+)"\)(.*)$/gm, (_, ind, before, file, after) => {
    const text = read(file);
    if (/[`\\]|\$\{/.test(text)) throw new Error(`${file}: no \`, \\ or \${ in an included file`);
    return `${ind}${before}\`\n${indent(text, ind.length + 2)}\n${ind}\`${after}`;
  });
}

export function build() {
  const body = PARTS.map((p) =>
    typeof p === "string"
      ? piece(p)
      : `const ${p.module} = (() => {\n${p.files.map((f) => indent(piece(f), 2)).join("\n")}\n  return api;\n})();\n`,
  ).join("\n");
  return `${read("protocol.js")}\n// Built from src/ by scripts/build.mjs: edit those, not this.\n(() => {\n  "use strict";\n  if (window.__b42) return;\n\n${indent(body, 2)}\n})();\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? path.join(ROOT, "overlay.js"));
  fs.writeFileSync(out, build());
  console.log(`built ${path.relative(process.cwd(), out)}`);
}
