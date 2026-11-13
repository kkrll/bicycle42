import { hostEl } from "../mount.js";

// ── canvas mode ─────────────────────────────────────────────────────────────────────────────
// The reviewer edits the page's real elements and sends the batch as one note. Three rules:
//  - one source of truth per element: its "Element styles" text. Typing writes it, and so do the
//    resize and gap drags (a drag makes `width: 400px;` appear there);
//  - previews never write the page's inline styles. Styles, order and hiding are rules in
//    constructed stylesheets (adopted by the document, so they leave no node behind and survive
//    a framework re-render); class and text edits have to write the DOM, so they are recorded
//    with their original value, re-applied when the page re-renders, and put back exactly;
//    the one other write is the stamp that says which element an edit is on (see stamp());
//  - the batch is plain data ({ els, sheet, ops }), so undo is a stack of snapshots, the draft is
//    the batch itself, and a sent batch is the same object with a note id.
export const MAX_EDITS = 40;
export const MAX_CSS = 4000;
export const MAX_SHEET = 8000;
export const MAX_CLASS = 1000;
export const MAX_TEXT = 2000;
export const COMPUTED = ["display", "flex-direction", "align-items", "justify-content", "gap", "width", "height", "padding", "margin",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "border-radius"];
export const newBatch = () => ({ els: {}, sheet: "", ops: [] });
export const EMPTY = JSON.stringify(newBatch());
export const C = {
  on: false,
  sel: null, // the selected element
  selRs: "", // its stable selector: its key in the batch, and how it is found again after a re-render
  hover: null,
  draft: { id: "draft", B: newBatch() }, // the unsent batch (+ its two stylesheets, made on demand)
  sent: [], // batches already sent, still applied as previews: [{ id, B, seen }]
  hide: new Set(), // ids of sent batches switched off for a "before" picture
  unsent: null, // what the batch being sent was, until the host takes it: { id, snap, past, future, note, sel }
  snap: EMPTY, // the draft batch as last committed; past and future are the undo stacks
  past: [],
  future: [],
  applied: new Map(), // Element → { cls?: original class attribute, text?: original text } written by us
  found: new Map(), // stable selector → Element
  paths: new Map(), // an element's stamp (as a selector) → { path, tag }: where it last was
  pathsDirty: false, pathsAt: 0,
  moves: {}, // the stylesheet of `order` rules, shared by all batches
  orders: new Map(), // parent selector → the `order` rules last worked out for it
  marks: new Map(), // Element → "ed" | "hid" | "ed hid": what the tree marks
  pop: "", // the list open above the bar: "list" (the batch), "help" (the keys) or none
  done: "", // what happened to the last sent batch, shown for a few seconds
  r: null, // the selection's rect in the last frame
  drag: null,
  zone: null,
  geo: null,
  geoKey: "",
  edit: null, // text being edited in place
  rev: 0,
  px: 0, py: 0, moved: false, over: false, last: null,
  drawn: false, msg: "", msgTimer: 0, typeTimer: 0, typeRaf: 0, hideTimer: 0,
  ph: 300, collapsed: false, compKey: "", compAt: 0,
};
try {
  const p = JSON.parse(sessionStorage.getItem("b42-inspector") || "{}");
  if (p.h > 0) C.ph = p.h;
  C.collapsed = !!p.c;
} catch {}

export const num = (s) => parseFloat(s) || 0;
export const px = (n) => `${Math.round(n * 100) / 100}px`;
export const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""); // tabs and line breaks stay
export const kids = (P) => [...P.children].filter((c) => c !== hostEl);

