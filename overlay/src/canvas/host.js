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
import { drawBar, flash, sentStatus, setPop } from "./bar.js";
import { cnote } from "./mount.js";
import { draftChanged } from "../draft.js";
import { buildRows, rowParts, T, toggleRow, treeKey } from "./tree.js";
import { drawTabs, follow, FULL, pretty, syncFields } from "./inspector.js";
import { sizeOf, tokenMatch, tokensOf } from "./tokens.js";
import { setMode } from "../mode.js";
import { send } from "../state.js";
import { hosted, onAct } from "../panel.js";
import { active } from "../render.js";
import { domVersion, root } from "../mount.js";

// ── the inspector the host draws ────────────────────────────────────────────────────────────
// When the host draws canvas's inspector itself (panel.js), the layer's own is hidden and this
// file stands in for it: in every frame the layer's inspector would be drawn, the view is made
// (CanvasView in ../../protocol-canvas.ts) and sent when it is not what was sent last; and what
// the host's inspector asks (CanvasAct) is done here by the functions the layer's own fields,
// rows and keys call. Nothing of the page's is kept anywhere else: the host draws what it is told.
// The bar over the page is the inspector's too then: the layer shows none (frame.js), and the
// view's `batch` is what it would say, the acts what its buttons and its note field do. The
// note's words stay the layer's (cnote): they go with the batch, and come back with a refused one.
//
// What the view costs to make is what the layer's inspector costs to draw: the tree is walked
// again when the DOM changed (a few times a second at most), the computed values are read when
// the selection, the batch or its element changed (and once a second), and only the rows the
// host shows are read, a screenful around them.

/** How long a step that waits for "commit" may wait: until it comes (as suggest.js holds one). */
const HELD = 3600e3;

const H = {
  first: 0, count: 30, // the rows the host's tree shows
  ids: new WeakMap(), els: new Map(), n: 0, // element ↔ the number the host names it by
  sent: "", // the last view, as JSON
  selFor: null, // the selection the rows were last placed for (see placeFor)
  comp: [], compKey: "", compOwn: "", compDom: -1, compAt: 0, // the computed section, and what it was read for
  toks: [], read: [], toksAt: 0, // the variables: as sent, as tokens.js read them off the selection
  sizes: new Map(), // a variable's value → its size (tokens.js keeps 500; a design system has more)
  texts: new Map(), // a box's text → { marks, error }
  listKey: "", list: [], // the list of the unsent edits, and the batch it was made for
};

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
/** A canvas frame, with the host's inspector: the view, sent if it changed. False when the host
 *  draws no inspector: the layer draws its own. */
export function hostView() {
  if (!hosted("canvas")) {
    H.sent = "";
    return false;
  }
  const el = C.sel && C.sel.isConnected ? C.sel : null;
  const global = !el || !!C.pin;
  const en = el && C.draft.B.els[C.selRs];
  const tooLong = !!en?.cls && en.cls.to.length > MAX_CLASS;
  computed(el, global);
  const view = {
    force: C.forced,
    sel: el ? { id: idOf(el), label: line(kindName(el)), tag: treeName(el), hidden: !!C.marks.get(el)?.includes("hid") } : null,
    global,
    // (The attribute as it is now, as the layer's class line has it; typing too long to apply
    // never reaches the attribute, so then the typed text is what there is to show.)
    classes: { text: tooLong ? en.cls.to : el ? el.getAttribute("class") ?? "" : "", long: tooLong },
    css: textOf(en ? en.css : "", false),
    sheet: textOf(C.draft.B.sheet, true),
    computed: H.comp,
    tokens: H.toks,
    tree: tree(el),
    batch: batchView(),
  };
  // Sent from here, not through sendView: this already runs once a frame at most, inside the
  // frame, and sendView's own frame would make every answer a frame later than the page.
  const json = JSON.stringify(view);
  if (json !== H.sent) {
    H.sent = json;
    send(/** @type {any} */ ({ type: "panel", panel: "canvas", view }));
  }
  return true;
}

/** What the bar would say (drawBar): the edits, undo and redo, the note, a refusal, the state;
 *  and while the host's list of them is open, the edits themselves. */
function batchView() {
  const B = C.draft.B;
  const n = countEdits(B) + (B.sheet.trim() ? 1 : 0);
  if (!n) C.list = false; // (nothing left to list: it closes, as it opens only with something in it)
  const out = {
    edits: n,
    undo: C.past.length > 0,
    redo: C.future.length > 0,
    note: cnote ? cnote.value : "",
    msg: C.msg,
    status: C.edit ? "Editing text" : C.done || (n ? "" : sentStatus()),
  };
  if (C.list) out.list = list();
  return out;
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

/** A box's text with what the browser would not take, as inspector.js's mark() says it. */
function textOf(text, sheet) {
  let t = H.texts.get(text);
  if (!t) {
    const max = sheet ? MAX_SHEET : MAX_CSS;
    const bad = text.length > max ? [] : problems(text, sheet);
    const error = text.length > max ? `Too long: ${text.length} / ${max} characters. Not applied; shorten it before sending`
      : bad.length ? `Not applied: ${bad.slice(0, 3).map((b) => b.why).join(" · ")}${bad.length > 3 ? ` · and ${bad.length - 3} more` : ""}` : "";
    if (H.texts.size > 50) H.texts.clear();
    H.texts.set(text, (t = { marks: bad.map((b) => ({ s: b.s, e: b.e, why: b.why })), error }));
  }
  return { text, ...t };
}

/** The computed values and the page's variables. The page's own changes are read as drawComputed
 *  reads them (a few times a second at most, and once a second whatever happened); a change of the
 *  batch, the selection or its attributes at once: the host shows what was just written, and the
 *  value it shows until the view has it would otherwise stand for a moment as the old one. The
 *  variables are read again only when the page or the selection changed (or once a second). */
function computed(el, global) {
  const now = performance.now();
  const inline = C.liveEl && C.liveEl.el === el ? C.liveEl.was : el && el.getAttribute("style");
  const own = `${C.selRs}|${global}|${el ? `${el.getAttribute("class")}|${inline}` : ""}`;
  const key = `${own}|${C.rev}`;
  if (key === H.compKey && (domVersion === H.compDom ? now - H.compAt < 1000 : now - H.compAt < 150)) return;
  const fresh = own !== H.compOwn || domVersion !== H.compDom || now - H.toksAt > 1000;
  H.compKey = key;
  H.compOwn = own;
  H.compDom = domVersion;
  H.compAt = now;
  if (!el) {
    H.comp = [];
    if (fresh) {
      H.toks = global ? tokens(document.documentElement) : [];
      H.toksAt = now;
    }
    return;
  }
  const cs = getComputedStyle(el);
  const flex = cs.display.includes("flex"), grid = cs.display.includes("grid");
  const list = COMPUTED.filter((p) => (p === "flex-direction" ? flex : p === "align-items" || p === "justify-content" || p === "gap" ? flex || grid : true));
  const en = C.draft.B.els[C.selRs];
  const mine = en ? topProps(en.css) : [];
  if (fresh) {
    H.read = tokensOf(el);
    H.toks = tokens(global ? document.documentElement : el, global ? null : H.read);
    H.toksAt = now;
  }
  H.comp = list.map((p) => {
    const raw = cs.getPropertyValue(p);
    const t = tokenMatch(p, raw, H.read, root);
    const row = { prop: p, value: pretty(raw) };
    if (t) {
      row.tokens = t.names;
      row.tokenTitle = `The page's variable${t.names.length > 1 ? "s" : ""} with this value${t.others.length ? ` (so ${t.others.length > 1 ? "are" : "is"} ${t.others.join(", ")})` : ""} · click to write ${p}: ${t.names.map((n) => `var(${n})`).join(" ")}`;
    }
    if (mine.some((m) => m === p || m.startsWith(`${p}-`) || p.startsWith(`${m}-`))) row.mine = true;
    return row;
  });
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

/** The rows the host shows, a screenful above and below them, from the tree's open rows. */
function tree(el) {
  // After DOM changes the list is walked again, but not more often than a few times a second.
  if (T.ver !== domVersion && (T.ver < 0 || performance.now() - T.at > 200)) buildRows();
  const rows = T.rows;
  const sel = el ? rows.findIndex((r) => r.el === el) : -1;
  // A new selection out of view: the host brings its row to the middle, and the rows sent are
  // those it will show then (CanvasTree.sel).
  if (el !== H.selFor) {
    H.selFor = el;
    if (sel >= 0 && (sel < H.first || sel >= H.first + H.count)) H.first = Math.max(0, sel - Math.floor(H.count / 2));
  }
  const pad = H.count;
  const a = Math.max(0, Math.min(H.first, rows.length) - pad), b = Math.min(rows.length, H.first + H.count + pad);
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
  return { total: rows.length, first: a, rows: out, sel, hover: C.hover && C.hover.isConnected ? idOf(C.hover) : 0 };
}

// ── what the host's inspector asks ──────────────────────────────────────────────────────────
/** The step waits for "commit" (a suggestion shown, a scrub), as suggest.js holds it. */
function hold() {
  clearTimeout(C.typeTimer);
  C.typeTimer = setTimeout(commit, HELD);
}

/** Typing in one of the host's fields: what the layer's typed() does with its own. */
function typed(a) {
  const v = clean(String(a.text ?? "")).slice(0, 100000);
  if (a.field === "sheet") {
    C.draft.B.sheet = v;
    drawTabs();
  } else {
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

/** A computed value written into Element styles: setValue's way, or liveValue's with `live`. */
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
      H.first = Math.max(0, Math.floor(Number(a.first) || 0));
      H.count = Math.min(200, Math.max(1, Math.floor(Number(a.count) || 1)));
      H.sent = ""; // a host that starts (or starts again) gets the whole view, changed or not
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
      drawTabs();
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
      // The words typed in the host's field: the layer's own field's, as if typed there.
      if (!cnote) return;
      cnote.value = clean(String(a.text ?? "")).replace(/[\r\n]+/g, " ").slice(0, 10000);
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
      if (C.pop) setPop(C.pop);
      else if (C.list) C.list = false;
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
  T.need = true;
  active(); // frames for a moment: the page follows, and the view says what it made of it
}
onAct("canvas", act);
