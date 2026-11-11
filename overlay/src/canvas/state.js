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
const MAX_EDITS = 40;
const MAX_CSS = 4000;
const MAX_SHEET = 8000;
const MAX_CLASS = 1000;
const MAX_TEXT = 2000;
// Typed declarations must win over the site's rules the way an inline style would, without
// "!important" in what the agent reads: three ids' worth of specificity that matches anything.
const BOOST = ":not(#b42-x#b42-x#b42-x)";
const SKIP = /^(SCRIPT|STYLE|HEAD|LINK|META|TITLE|NOSCRIPT|TEMPLATE|B42-REVIEW)$/;
const COMPUTED = ["display", "flex-direction", "align-items", "justify-content", "gap", "width", "height", "padding", "margin",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "border-radius"];
// Every icon of the layer: inline SVG on a 16px grid, stroked in the text colour. No glyphs.
const ICONS = {
  "chevron-down": '<path d="m4 6 4 4 4-4"/>',
  "chevron-up": '<path d="m4 10 4-4 4 4"/>',
  "chevron-right": '<path d="m6 4 4 4-4 4"/>',
  "chevron-left": '<path d="m10 4-4 4 4 4"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  undo: '<path d="M6 3.5 3 6.5l3 3"/><path d="M3 6.5h6.25a3.25 3.25 0 0 1 0 6.5H7"/>',
  redo: '<path d="m10 3.5 3 3-3 3"/><path d="M13 6.5H6.75a3.25 3.25 0 0 0 0 6.5H9"/>',
  help: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.9 1.9 0 0 1 3.7.6c0 1.2-1.8 1.5-1.8 2.7"/><path d="M8.1 11.7v.1"/>',
  // The Mac's key symbols, drawn: the page's fonts may not have them, and fallbacks draw specks.
  "⌘": '<path d="M6 6V4a2 2 0 1 0-2 2h8a2 2 0 1 0-2-2v8a2 2 0 1 0 2-2H4a2 2 0 1 0 2 2z"/>',
  "⇧": '<path d="M8 2.7 13.3 8h-3v5.3H5.7V8H2.7z"/>',
  "⌥": '<path d="M2 3.3h3.7l4.6 9.4H14M9.7 3.3H14"/>',
  "↵": '<path d="M13.3 3.3v4a2.7 2.7 0 0 1-2.7 2.7H2.7M5.7 7l-3 3 3 3"/>',
};
const icon = (name, size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const KEY_NAMES = { "⌘": "command", "⇧": "shift", "⌥": "option", "↵": "return" };
/** Words with key symbols in them ("↵ send", "⌘Z"), as nodes: the symbols drawn at the size of
 *  the letters, the rest as text (never markup, so any words are safe here). */
function keyNodes(text) {
  const out = document.createDocumentFragment();
  for (const part of String(text).split(/([⌘⇧⌥↵])/)) {
    if (!part) continue;
    if (!KEY_NAMES[part]) {
      out.append(part);
      continue;
    }
    const t = document.createElement("template");
    t.innerHTML = icon(part, 12);
    const svg = t.content.firstChild;
    svg.classList.add("kg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", KEY_NAMES[part]);
    svg.removeAttribute("aria-hidden");
    out.append(svg);
  }
  return out;
}
const newBatch = () => ({ els: {}, sheet: "", ops: [] });
const EMPTY = JSON.stringify(newBatch());
const C = {
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

// The window's scroll and size, read once at the top of each frame (before anything is written).
const VP = { sx: 0, sy: 0, w: 0, h: 0 };
const readView = () => {
  VP.sx = window.scrollX;
  VP.sy = window.scrollY;
  VP.w = window.innerWidth;
  VP.h = window.innerHeight;
};
const num = (s) => parseFloat(s) || 0;
const px = (n) => `${Math.round(n * 100) / 100}px`;
const line = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""); // tabs and line breaks stay
const kids = (P) => [...P.children].filter((c) => c !== hostEl);

/** Where an element is: a path of tags and places from the nearest id. Unlike selectorFor it
 *  uses no class names, so it still matches after the reviewer edits the class list. It says
 *  where, not which: when the page adds a sibling before the element, its path is another one. */
function pathSel(el) {
  const parts = [];
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    if (cur === document.body || cur === document.documentElement) {
      parts.unshift(cur.localName);
      break;
    }
    if (cur.id && unique(`#${CSS.escape(cur.id)}`)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    let seg = CSS.escape(cur.localName);
    const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
    if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
    parts.unshift(seg);
  }
  return parts.join(" > ");
}

// An element with an edit is stamped (an attribute: like the class and text edits a write to
// the DOM, taken off again when no batch names it), and the edit's rules and its key in the
// batch are that stamp. So an edit stays on its element when the page adds, removes or reorders
// the ones around it. The stamp is lost when the page builds the element anew (or reloads):
// then the element is the one where the old one last was, as before. An element with an id of
// its own needs no stamp.
const STAMP = "data-b42e";
const stampSel = (id) => `[${STAMP}="${id}"]`;
const stampOf = (rs) => /^\[data-b42e="([a-z0-9]+)"\]$/.exec(rs)?.[1];
const stampBase = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`; // (a restored draft has stamps of an earlier load)
let stampN = 0;

/** The selector that says which element this is: its stamp if it has one, else its path. */
const stableSel = (el) => (el.hasAttribute(STAMP) ? stampSel(el.getAttribute(STAMP)) : pathSel(el));

/** The same for an element that is being edited: it gets its stamp now. */
function stamp(el) {
  const path = pathSel(el);
  if (!el.hasAttribute(STAMP)) {
    if (el === document.body || el === document.documentElement || (el.id && path === `#${CSS.escape(el.id)}`)) return path;
    el.setAttribute(STAMP, `${stampBase}${(++stampN).toString(36)}`);
  }
  const rs = stampSel(el.getAttribute(STAMP));
  C.paths.set(rs, { path, tag: el.localName });
  C.found.set(rs, el);
  if (el === C.sel) C.selRs = rs;
  return rs;
}

function elOf(rs) {
  let el = C.found.get(rs);
  const id = stampOf(rs);
  if (el && el.isConnected) {
    // (Taken off when nothing named it any more; an undo, or a refused note, names it again.)
    if (id && el.getAttribute(STAMP) !== id) el.setAttribute(STAMP, id);
    return el;
  }
  el = q(rs);
  if (!el && id) {
    const p = C.paths.get(rs);
    const at = p && q(p.path);
    if (at && at !== hostEl && at.localName === p.tag && !at.hasAttribute(STAMP)) {
      at.setAttribute(STAMP, id);
      el = at;
    }
  }
  if (el) C.found.set(rs, el);
  else C.found.delete(rs);
  return el;
}

/** Where each stamped element is now, for the day the page builds it anew. Read after the page
 *  changed its tree, while the element is still there: one that just went keeps its last place. */
function readPaths() {
  C.pathsDirty = false;
  C.pathsAt = performance.now();
  let changed = false;
  for (const [rs, el] of C.found) {
    if (!stampOf(rs) || !el.isConnected) continue;
    const path = pathSel(el), p = C.paths.get(rs);
    if (p && p.path === path) continue;
    C.paths.set(rs, { path, tag: el.localName });
    changed = true;
  }
  if (C.sel && C.sel.isConnected) C.selRs = stableSel(C.sel);
  if (changed && C.snap !== EMPTY) draftChanged(); // the draft carries the paths (see serializeDraft)
}

/** What every edit says about its element (the wire names), plus `rs` for our own use. */
function meta(el) {
  const m = { selector: editSel(el), rs: stamp(el), tag: el.tagName.toLowerCase(), label: line(plainLabel(el)) };
  const c = component(el);
  if (c) m.component = line(c.name);
  const cls = el.getAttribute("class");
  const n = el.parentElement ? kids(el.parentElement).filter((k) => k.tagName === el.tagName && k.getAttribute("class") === cls).length : 1;
  if (n > 1) m.repeated = n;
  C.found.set(m.rs, el);
  return m;
}

function entry(el) {
  const els = C.draft.B.els;
  return (el.hasAttribute(STAMP) && els[stampSel(el.getAttribute(STAMP))]) || els[stamp(el)] || (els[stamp(el)] = { ...meta(el), css: "" });
}

