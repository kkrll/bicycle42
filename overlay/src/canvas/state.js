import { hostEl } from "../mount.js";

// ── canvas mode ─────────────────────────────────────────────────────────────────────────────
// The reviewer edits the page's real elements and sends the batch as one note. Three rules:
//  - one source of truth per element: its "Element styles" text. Typing writes it, and so do the
//    resize and gap drags (a drag makes `width: 400px;` appear there);
//  - previews never write the page's inline styles. Styles, order and hiding are rules in
//    constructed stylesheets (adopted by the document, so they leave no node behind and survive
//    a framework re-render); class and text edits have to write the DOM, so they are recorded
//    with their original value, re-applied when the page re-renders, and put back exactly;
//    the one other write is the stamp that says which element an edit is on (see stamp()), and
//    during a drag one custom property in the dragged element's style, which its rule reads
//    (cursor.js says why; the attribute is put back as it was when the drag ends);
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
  applied: new Map(), // Element → { cls?: original class attribute, text?: { run: { from, was } }, its words before } written by us
  found: new Map(), // stable selector → Element
  paths: new Map(), // an element's stamp (as a selector) → { path, tag }: where it last was
  pathsDirty: false, pathsAt: 0,
  moves: {}, // the stylesheet of `order` rules, shared by all batches
  orders: new Map(), // parent selector → the `order` rules last worked out for it
  marks: new Map(), // Element → "ed" | "hid" | "ed hid": what the tree marks
  copies: new Map(), // a copy's stamp (as a selector) → the copy, made by a "duplicate" edit (copies.js)
  copyRs: new Set(), // the stamps of every copy a batch names
  note: "", // the words typed for the batch in the host's footer: they go with it, and come back with a refused one
  pop: "", // notes mode's keys list, open over its "?" ("help"), or not
  list: false, // the host's list of the unsent edits is open (host.js)
  done: "", // what happened to the last sent batch, shown for a few seconds
  r: null, // the selection's rect in the last frame
  drag: null,
  zone: null,
  geo: null,
  geoKey: "",
  edit: null, // text being edited in place
  trail: null, // the element the walk out (shift+Enter, ↑) started from: Enter and ↓ go back in to it
  deep: null, // the last mod+click: { el, x, y }; another at that place selects what is behind
  mod: false, // the mod key is held over the page: the hover is what a mod+click would select
  rev: 0,
  px: 0, py: 0, moved: false, over: false, last: null,
  drawn: false, msg: "", msgTimer: 0, typeTimer: 0, typeRaf: 0, hideTimer: 0,
  forced: 0, // counts the fields' text put in by force (syncFields(true)): the host's inspector takes it then (host.js)
};

export const num = (s) => parseFloat(s) || 0;
export const px = (n) => `${Math.round(n * 100) / 100}px`;
export const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""); // tabs and line breaks stay
export const kids = (P) => [...P.children].filter((c) => c !== hostEl);

