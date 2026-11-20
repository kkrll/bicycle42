import { kindName, line, treeName } from "../page.js";
import { C, clean, COMPUTED, MAX_CLASS, MAX_CSS, MAX_SHEET } from "./state.js";
import { entry } from "./stamps.js";
import { problems, setDecl, supports, topProps } from "./css.js";
import { applyAll } from "./apply.js";
import { commit, countEdits, redo, reset, undo } from "./batch.js";
import { submitCanvas } from "./send.js";
import { hideSel, select } from "./select.js";
import { draftCopy, dropCopy, duplicateSel } from "./copies.js";
import { editRows, removeEdit } from "./edits.js";
import { elOf } from "./stamps.js";
import { drawBar, flash, hush, sentStatus } from "./bar.js";
import { draftChanged } from "../draft.js";
import { buildRows, dropRows, rowParts, T, toggleRow, treeKey } from "./tree.js";
import { sizeOf, tokenMatch, tokensOf } from "./tokens.js";
import { setMode } from "../mode.js";
import { hosted, onAct, putView } from "../panel.js";
import { active, kick } from "../render.js";
import { domVersion, root } from "../mount.js";

// ── the inspector the host draws ────────────────────────────────────────────────────────────
// Canvas mode's inspector is the host's (panel.js): the page has none of its own. In every
// canvas frame the view (CanvasView in ../../protocol-canvas.ts) is brought up to date and given
// to putView, which sends the fields of it that are not the ones that last went; and what the
// host's inspector asks (CanvasAct) is done here. Nothing of the page's is kept anywhere else:
// the host draws what it is told. Its footer is the batch's bar: the view's `batch` is what it
// says, the acts what its buttons and its note field do. The note's words are the batch's
// (C.note): they go with it, and come back with a refused one.
// A host that does not say it draws the inspector gets no view: canvas mode then works the page
// (selecting, the drags, text in place, the keys) with no inspector at all.
//
// What a frame costs: nothing is made that did not change. putView tells a field that changed by
// its identity, so each field of the view is kept as the object that went until what it was made
// from is something else, and each has its own cheap way to know that:
//  - the two boxes and the class line by their text; the footer by the few values it says; the
//    hovered element by its number (so the pointer moving over the page sends one number);
//  - the tree by the walk it was read from (the DOM changed: a few times a second at most), the
//    rows the host shows and the selection's row;
//  - what is read off the page (the computed values, the page's variables, the header's names,
//    the rows' own words) when the selection, its own attributes or the batch changed, a few
//    times a second while the DOM changes, and once a second whatever happened: the page changes
//    an element without telling anyone. What was read is compared with what went (`keep`), and
//    the object that went is kept when it says the same: a second look at the page sends nothing.
// So a frame in which nothing changed (the wheel over the page) makes no object and stringifies
// nothing, and a view that goes is stringified once, where it is sent.

/** How long a step that waits for "commit" may wait: until it comes. */
const HELD = 3600e3;

const H = {
  first: 0, count: 30, // the rows the host's tree shows
  ids: new WeakMap(), els: new Map(), n: 0, // element ↔ the number the host names it by
  view: null, // the view as it was last given to putView: a field of it is never changed in place
  next: {}, // the fields as they are in this frame, to tell whether any is another than the view's
  selFor: null, // the selection the rows were last placed for (see tree)
  sel: null, selEl: null, // the header's selection, and the element it was made for
  classes: null, // the class line
  comp: [], compKey: "", compOwn: "", compDom: -1, compAt: 0, // the computed section, and what it was read for
  toks: [], read: [], toksAt: 0, // the variables: as sent, as tokens.js read them off the selection
  sizes: new Map(), // a variable's value → its size (tokens.js keeps 500; a design system has more)
  texts: { css: new Map(), sheet: new Map() }, // each box's texts → { text, marks, error }
  text: { css: null, sheet: null }, // and the one each box has now
  tree: null, rows: null, row: -1, rowEl: null, // the tree; the walk it was read from; the selection's row in it, and whose
  marks: null, // the batch's marks the tree and the header were read with
  batch: null, // the footer
  listKey: "", list: [], // the list of the unsent edits, and the batch it was made for
};

/** Plain data that says the same (what a view is made of: arrays, objects, strings, numbers). */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => same(a[k], b[k]));
}
/** What was read again, unless it says what the one that went says: then that one, so putView
 *  sees a field that did not change. */
const keep = (was, now) => (same(was, now) ? was : now);

function idOf(el) {
  let id = H.ids.get(el);
  if (!id) {
    H.ids.set(el, (id = ++H.n));
    H.els.set(id, new WeakRef(el));
    // Rows the host has seen are named here; a long session on a page that re-renders leaves
    // many behind, so the ones whose element is gone are let go now and then.
    if (H.els.size > 20000) for (const [k, r] of H.els) if (!r.deref()?.isConnected) H.els.delete(k);
  }
  return id;
}
const elOfId = (id) => {
  const el = H.els.get(Number(id))?.deref();
  return el && el.isConnected ? el : null;
};
const selId = () => (C.sel && C.sel.isConnected ? idOf(C.sel) : 0);

// ── the view ────────────────────────────────────────────────────────────────────────────────
/** The batch's text changed by something other than the host's typing (undo, a drag, a value
 *  set, a new selection): the host's fields take the view's text then (`force`). */
export function syncFields(force) {
  if (force) C.forced++;
  drawBar();
}

/** The batch's text changed under the reviewer's hands: the page follows within a frame, and the
 *  undo step closes when they pause (unless `held`: a drag closes its own when it ends). */
export function follow(held) {
  hush();
  clearTimeout(C.typeTimer);
  C.typeTimer = held ? 0 : setTimeout(commit, 700);
  // The key press itself only stores the text. Applying happens in the next frame; on a page
  // where applying is slow (measured: the restyle it causes is forced and timed), it waits for a
  // short pause in the typing instead of running on every frame.
  if (!C.typeRaf)
    C.typeRaf = requestAnimationFrame(() => {
      C.typeRaf = 0;
      clearTimeout(C.slowTimer);
      if (C.slow) C.slowTimer = setTimeout(applyTimed, 100);
      else applyTimed();
    });
  kick();
}

function applyTimed() {
  const t0 = performance.now();
  applyAll();
  void getComputedStyle(document.documentElement).opacity; // the restyle happens now, not later, so it can be timed
  C.slow = performance.now() - t0 > 8;
}

/** Computed values as a designer reads them: colours as hex, lengths to a tenth of a pixel. */
const pretty = (v) =>
  v.replace(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/g, (_, r, g, b, a) =>
    `#${[r, g, b].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}${a === undefined ? "" : Math.round(Number(a) * 255).toString(16).padStart(2, "0")}`)
    .replace(/(-?\d+\.\d\d+)px/g, (_, x) => `${Math.round(Number(x) * 10) / 10}px`);

const FULL = "This element's styles are full: shorten them first";

const FIELDS = ["force", "sel", "global", "classes", "css", "sheet", "computed", "tokens", "tree", "hover", "batch"];

/** The mode is left: the elements kept here to tell what changed are let go, with the tree's
 *  rows (as those, they would keep what the page throws away afterwards). The view that went
 *  stays: it is words and numbers, and what the host has until the mode is back. */
export function hostOff() {
  dropRows();
  H.selFor = H.selEl = H.rowEl = H.rows = H.sel = null;
  H.row = -1;
}

/** A canvas frame: the view as it is now, given to putView (which sends what changed of it, and
 *  the whole of it to a host that has none). Nothing when the host draws no inspector. */
export function hostView() {
  if (!hosted("canvas")) return;
  const el = C.sel && C.sel.isConnected ? C.sel : null;
  const global = !el || !!C.pin;
  const en = el && C.draft.B.els[C.selRs];
  // (The batch's marks are a new list whenever the batch was applied: the rows' dots and the
  // header's "hidden" are read with them.)
  const read = computed(el, global) || C.marks !== H.marks;
  H.marks = C.marks;
  if (read || el !== H.selEl) {
    H.selEl = el;
    H.sel = keep(H.sel, el ? { id: idOf(el), label: line(kindName(el)), tag: treeName(el), hidden: !!C.marks.get(el)?.includes("hid") } : null);
  }
  const n = H.next;
  n.force = C.forced;
  n.sel = H.sel;
  n.global = global;
  n.classes = classes(el, en);
  n.css = textOf(en ? en.css : "", "css");
  n.sheet = textOf(C.draft.B.sheet, "sheet");
  n.computed = H.comp;
  n.tokens = H.toks;
  n.tree = tree(el, read);
  n.hover = C.hover && C.hover.isConnected ? idOf(C.hover) : 0;
  n.batch = batchView();
  let v = H.view;
  for (let i = 0; v && i < FIELDS.length; i++) if (n[FIELDS[i]] !== v[FIELDS[i]]) v = null;
  if (!v) H.view = { ...n };
  // Put from here, not through sendView: this already runs once a frame at most, inside the
  // frame, and sendView's own frame would make every answer a frame later than the page. (Put in
  // every frame, changed or not: putView is the one that knows what the host has, and a host that
  // has just taken the pane gets the whole view from it though nothing here changed.)
  putView("canvas", H.view);
}

/** The class line. (The attribute as it is now; typing too long to apply never reaches the
 *  attribute, so then the typed text is what there is to show.) */
function classes(el, en) {
  const long = !!en?.cls && en.cls.to.length > MAX_CLASS;
  const text = long ? en.cls.to : el ? el.getAttribute("class") ?? "" : "";
  const c = H.classes;
  return c && c.text === text && c.long === long ? c : (H.classes = { text, long });
}

/** What the footer says: the edits, undo and redo, the note, a refusal, the state; and while
 *  the host's list of them is open, the edits themselves. */
function batchView() {
  const B = C.draft.B;
  const n = countEdits(B) + (B.sheet.trim() ? 1 : 0);
  if (!n) C.list = false; // (nothing left to list: it closes, as it opens only with something in it)
  const undo = C.past.length > 0, redo = C.future.length > 0;
  const status = C.edit ? "Editing text" : C.done || (n ? "" : sentStatus());
  const rows = C.list ? list() : undefined;
  const b = H.batch;
  if (b && b.edits === n && b.undo === undo && b.redo === redo && b.note === C.note && b.msg === C.msg && b.status === status && b.list === rows) return b;
  const out = { edits: n, undo, redo, note: C.note, msg: C.msg, status };
  if (rows) out.list = rows;
  return (H.batch = out);
}

/** The unsent edits in words. Each is measured with the batch off and on, so they are made again
 *  only when the batch changed, and only while the host shows them. */
function list() {
  const key = `${JSON.stringify(C.draft.B)}|${C.rev}`;
  if (key !== H.listKey) {
    H.listKey = key;
    H.list = editRows(true).map((r) => {
      const el = r.rs && elOf(r.rs);
      return { key: r.key, label: r.label, text: r.text, ...(el && el.isConnected ? { id: idOf(el) } : {}) };
    });
  }
  return H.list;
}

/** A box's text ("css": Element styles, "sheet": the stylesheet) with what the browser would not
 *  take: the ranges to underline, and the line under the box. The same text is not the same in
 *  the two boxes (a bare declaration is Element styles' whole point and outside a rule in the
 *  stylesheet), so what was made of one is kept by box. A box whose text is what it was is the
 *  object it was. */
function textOf(text, box) {
  const now = H.text[box];
  if (now && now.text === text) return now;
  const known = H.texts[box];
  let t = known.get(text);
  if (!t) {
    const sheet = box === "sheet";
    const max = sheet ? MAX_SHEET : MAX_CSS;
    const bad = text.length > max ? [] : problems(text, sheet);
    const error = text.length > max ? `Too long: ${text.length} / ${max} characters. Not applied; shorten it before sending`
      : bad.length ? `Not applied: ${bad.slice(0, 3).map((b) => b.why).join(" · ")}${bad.length > 3 ? ` · and ${bad.length - 3} more` : ""}` : "";
    if (known.size > 50) known.clear();
    known.set(text, (t = { text, marks: bad.map((b) => ({ s: b.s, e: b.e, why: b.why })), error }));
  }
  return (H.text[box] = t);
}

/** The computed values and the page's variables. The page changes an element's look without
 *  changing the tree (a class or an inline style set by its script: the agent's edit, hot-reloaded,
 *  is often just that), so the selection's own two attributes are part of the key; the page's own
 *  changes are read a few times a second at most, and once a second whatever happened (a
 *  stylesheet swapped, a class on a parent); a change of the batch, the selection or its attributes
 *  at once: the host shows what was just written, and the value it shows until the view has it
 *  would otherwise stand for a moment as the old one. (A drag's own property in the style
 *  attribute is not the page's change: the attribute as it was before the drag counts.) The
 *  variables are read again only when the page or the selection changed (or once a second).
 *  True when the page was read now: the rest of the view that is read off the page (the header's
 *  names, the rows' words) is read with it. What was read and says what the last one said is the
 *  last one still. */
function computed(el, global) {
  const now = performance.now();
  const inline = C.liveEl && C.liveEl.el === el ? C.liveEl.was : el && el.getAttribute("style");
  const own = `${C.selRs}|${global}|${el ? `${el.getAttribute("class")}|${inline}` : ""}`;
  const key = `${own}|${C.rev}`;
  if (key === H.compKey && (domVersion === H.compDom ? now - H.compAt < 1000 : now - H.compAt < 150)) return false;
  const fresh = own !== H.compOwn || domVersion !== H.compDom || now - H.toksAt > 1000;
  H.compKey = key;
  H.compOwn = own;
  H.compDom = domVersion;
  H.compAt = now;
  if (!el) {
    H.comp = keep(H.comp, []);
    if (fresh) {
      H.toks = keep(H.toks, global ? tokens(document.documentElement) : []);
      H.toksAt = now;
    }
    return true;
  }
  const cs = getComputedStyle(el);
  const flex = cs.display.includes("flex"), grid = cs.display.includes("grid");
  const list = COMPUTED.filter((p) => (p === "flex-direction" ? flex : p === "align-items" || p === "justify-content" || p === "gap" ? flex || grid : true));
  const en = C.draft.B.els[C.selRs];
  const mine = en ? topProps(en.css) : [];
  if (fresh) {
    H.read = tokensOf(el);
    H.toks = keep(H.toks, tokens(global ? document.documentElement : el, global ? null : H.read));
    H.toksAt = now;
  }
  H.comp = keep(H.comp, list.map((p) => {
    const raw = cs.getPropertyValue(p);
    const t = tokenMatch(p, raw, H.read, root);
    const row = { prop: p, value: pretty(raw) };
    if (t) {
      row.tokens = t.names;
      row.tokenTitle = `The page's variable${t.names.length > 1 ? "s" : ""} with this value${t.others.length ? ` (so ${t.others.length > 1 ? "are" : "is"} ${t.others.join(", ")})` : ""} · click to write ${p}: ${t.names.map((n) => `var(${n})`).join(" ")}`;
    }
    if (mine.some((m) => m === p || m.startsWith(`${p}-`) || p.startsWith(`${m}-`))) row.mine = true;
    return row;
  }));
  return true;
}

/** The page's variables for the suggestions, each with its size when it is one (for ↑/↓ along
 *  its scale: measured here, where `rem` is the page's). */
function tokens(el, read) {
  return (read || tokensOf(el)).map(({ name, value }) => {
    let n = H.sizes.get(value);
    if (n === undefined) {
      if (H.sizes.size > 5000) H.sizes.clear();
      H.sizes.set(value, (n = sizeOf(value, root)));
    }
    return Number.isFinite(n) ? { name, value, size: n } : { name, value };
  });
}

/** The rows the host shows, a screenful above and below them, from the tree's open rows. The
 *  one that went, while it is of the same walk, the same rows and the same selection, and the
 *  page was not read again (`read`: the rows' words are the page's). */
function tree(el, read) {
  // After DOM changes the list is walked again, but not more often than a few times a second.
  if (T.ver !== domVersion && (T.ver < 0 || performance.now() - T.at > 200)) buildRows();
  const rows = T.rows;
  const walked = rows !== H.rows;
  // (The selection's row is looked for in a new walk, or for a new selection: not in every frame.)
  if (walked || el !== H.rowEl) {
    H.rowEl = el;
    H.row = el ? rows.findIndex((r) => r.el === el) : -1;
  }
  H.rows = rows;
  const sel = H.row;
  // A new selection out of view: the host brings its row to the middle, and the rows sent are
  // those it will show then (CanvasTree.sel).
  if (el !== H.selFor) {
    H.selFor = el;
    if (sel >= 0 && (sel < H.first || sel >= H.first + H.count)) H.first = Math.max(0, sel - Math.floor(H.count / 2));
  }
  const pad = H.count;
  const a = Math.max(0, Math.min(H.first, rows.length) - pad), b = Math.min(rows.length, H.first + H.count + pad);
  const t = H.tree;
  if (t && !read && !walked && t.first === a && t.rows.length === b - a && t.sel === sel) return t;
  const out = [];
  for (let i = a; i < b; i++) {
    const { el: e, depth } = rows[i];
    const [kids, tag, idName, cls, text] = rowParts(e);
    const row = { id: idOf(e), depth, tag, idName, cls, text, kids };
    const mark = C.marks.get(e);
    if (mark?.includes("ed")) row.ed = true;
    if (mark?.includes("hid")) row.hid = true;
    out.push(row);
  }
  return (H.tree = keep(t, { total: rows.length, first: a, rows: out, sel }));
}

// ── what the host's inspector asks ──────────────────────────────────────────────────────────
/** The step waits for "commit" (a suggestion shown on the page, a scrub). */
function hold() {
  clearTimeout(C.typeTimer);
  C.typeTimer = setTimeout(commit, HELD);
}

/** Typing in one of the host's fields: the field's whole text. */
function typed(a) {
  const v = clean(String(a.text ?? "")).slice(0, 100000);
  if (a.field === "sheet") C.draft.B.sheet = v;
  else {
    if (!C.sel || Number(a.id) !== selId()) return; // typed for a selection that is gone
    const e = entry(C.sel);
    if (a.field === "css") e.css = v;
    else if (a.field === "classes")
      // "From" is the attribute as this batch found it (the page's own, or what an earlier batch left).
      e.cls = { from: e.cls ? e.cls.from : C.sel.getAttribute("class"), to: v.replace(/\s+/g, " ") };
    else return;
  }
  follow();
  if (a.hold) hold();
}

/** A computed value written into Element styles: an undo step, or with `live` as typing is. */
function value(a) {
  if (!C.sel || Number(a.id) !== selId()) return;
  const p = String(a.prop ?? ""), v = line(clean(String(a.value ?? "")));
  if (!COMPUTED.includes(p) || !v || !supports(p, v)) return;
  const en = entry(C.sel);
  const css = setDecl(en.css, p, v);
  if (css.length > MAX_CSS) {
    if (a.live) commit();
    return flash(FULL);
  }
  en.css = css;
  if (a.live) {
    follow();
    if (a.hold) hold();
  } else {
    commit();
    syncFields(true);
  }
}

function act(a) {
  if (!a || typeof a !== "object" || !C.on) return;
  switch (a.type) {
    case "tree":
      // (Only the rows: a host that starts, or starts again, and has no view asks for the whole
      // one, "whole", which panel.js answers for every pane with the view as it last went.)
      H.first = Math.max(0, Math.floor(Number(a.first) || 0));
      H.count = Math.min(200, Math.max(1, Math.floor(Number(a.count) || 1)));
      break;
    case "open": {
      const el = elOfId(a.id);
      if (el) toggleRow(el, typeof a.open === "boolean" ? a.open : undefined);
      break;
    }
    case "select": {
      const el = elOfId(a.id);
      if (el && el !== C.sel) select(el);
      if (el && a.show) el.scrollIntoView({ block: "center", inline: "nearest" });
      break;
    }
    case "edits":
      C.list = !!a.open && countEdits(C.draft.B) + (C.draft.B.sheet.trim() ? 1 : 0) > 0;
      break;
    case "unedit":
      removeEdit(String(a.key ?? ""));
      break;
    case "hover": {
      const el = a.id ? elOfId(a.id) : null;
      if (el !== C.hover) C.hover = el;
      break;
    }
    case "walk":
      if (/^Arrow(Up|Down|Left|Right)$/.test(a.key)) treeKey(a.key);
      break;
    case "global":
      C.pin = !!a.on;
      break;
    case "text":
      typed(a);
      break;
    case "value":
      value(a);
      break;
    case "commit":
      commit();
      break;
    case "revert":
      // Nothing was committed since the scrub began: the batch as it was then.
      clearTimeout(C.typeTimer);
      C.typeTimer = 0;
      C.draft.B = JSON.parse(C.snap);
      applyAll();
      syncFields(true);
      break;
    case "undo":
      undo();
      break;
    case "reset":
      reset();
      break;
    case "note":
      // The words typed in the host's field: the batch's.
      C.note = clean(String(a.text ?? "")).replace(/[\r\n]+/g, " ").slice(0, 10000);
      draftChanged();
      drawBar();
      break;
    case "redo":
      redo();
      break;
    case "send":
      submitCanvas(!!a.bg);
      break;
    case "escape":
      if (C.list) C.list = false;
      else if (C.sel) select(null);
      else setMode("notes");
      break;
    case "hide":
      // (a copy this batch made is taken out, not hidden: it was never the page's)
      if (C.sel && draftCopy(C.selRs)) dropCopy(C.selRs);
      else if (C.sel) hideSel();
      break;
    case "duplicate":
      if (C.sel) duplicateSel();
      break;
    default:
      return;
  }
  active(); // frames for a moment: the page follows, and the view says what it made of it
}
onAct("canvas", act);
