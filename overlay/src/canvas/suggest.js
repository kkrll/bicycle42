import { line } from "../page.js";
import { C, clean, MAX_CSS } from "./state.js";
import { CSS_PROPS } from "./css-data.js";
import { caretContext, isNumber, matches, propNames, step, valueContext, valuesAt, valuesOf, wants, WIDE } from "./suggest-model.js";
import { entry } from "./stamps.js";
import { setDecl, supports } from "./css.js";
import { applyAll } from "./apply.js";
import { commit } from "./batch.js";
import { picked, readValue, setValue, syncFields, typed, unmarkValue } from "./inspector.js";

// ── the inspector's suggestions ─────────────────────────────────────────────────────────────
// As Chrome's Styles pane has them: property names while a name is typed, the property's
// keywords while its value is, in Element styles, in the stylesheet (never in a selector) and in
// a computed row (values only: the row is its property). The list is the layer's own, in its
// shadow root, and made of Chrome's property list (css-data.js) and what CSS.supports says:
// nothing of the page's is in it. suggest-model.js is the part without a DOM.
//
// Moving through a list of values shows each on the page, as typing it would. Until the list
// closes that is not an undo step: the step's timer is held, and closes with Enter (the value
// stays) or Escape (what was typed is back), so a look through the list is one step at most.

const ROWS = 8; // rows of the list in view; the rest scrolls
const HELD = 3600e3; // the undo step waits this long while the list is looked through: until it closes

let cssEl, freeEl, compEl, listEl;
/** The open list. `field` is null when it is closed. */
const L = {
  field: null,
  kind: "", // "name" | "value"
  prop: "", // the property whose values these are
  items: [],
  on: 0, // the highlighted item
  s: 0, e: 0, // the token in the field that an item replaces
  colon: false, // a name that already has its colon: only the name is replaced
  live: false, // an item is being shown on the page in place of what was typed
  typed: "", caret: 0, // what was typed there, and where the caret was: Escape puts them back
  css: "", // (a computed row) the element's styles before the first item was shown
  was: "", // (a computed row) the value the row had then
  raf: 0,
};

const isVal = (f) => !!f && !!f.classList && f.classList.contains("cval");
const ours = (f) => !!f && (f === cssEl || f === freeEl || isVal(f));
const take = (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
  return true;
};

let names; // the properties this browser takes (Chrome's list has what is behind its flags too)
const values = new Map(); // property → its keywords, asked of the browser once
function valuesFor(prop) {
  let v = values.get(prop);
  if (!v) values.set(prop, (v = valuesOf(prop, CSS_PROPS, supports)));
  return v;
}
const colours = new Map(); // keyword → whether it is a colour (for its swatch)
function isColour(kw) {
  let c = colours.get(kw);
  if (c === undefined) colours.set(kw, (c = kw !== "currentcolor" && !WIDE.includes(kw) && supports("color", kw)));
  return c;
}

/** @returns {ReturnType<typeof caretContext>} */
function contextOf(f) {
  if (isVal(f)) {
    const p = f.parentElement._p;
    // (A row focused by the keyboard has its whole value selected: its end is the caret.)
    return p ? valueContext(p, f.value, f.selectionEnd ?? f.value.length) : { kind: "none" };
  }
  if (f.selectionStart !== f.selectionEnd) return { kind: "none" };
  return caretContext(f.value, f.selectionStart, f === freeEl);
}

/** The undo step closes `ms` after now (inspector.js's typed() sets the same timer). */
function stepIn(ms) {
  clearTimeout(C.typeTimer);
  C.typeTimer = setTimeout(commit, ms);
}

// ── the list ────────────────────────────────────────────────────────────────────────────────
/** Open the list for what is at the caret, or change what it shows; close it when there is
 *  nothing to offer. `asked`: by ctrl+space, which opens it on nothing typed too. */
function show(f, asked) {
  const ctx = contextOf(f);
  if (!wants(ctx, asked)) return close();
  // (A name is asked of the browser as css.js's problems() asks it: what is offered is never flagged.)
  const all = ctx.kind === "name" ? (names ||= propNames(CSS_PROPS).filter((n) => supports(n, "initial"))) : valuesAt(valuesFor(ctx.prop), f.value, ctx);
  const items = matches(all, ctx.word);
  // (The one thing it could offer is what is typed already: Enter is then the field's own.)
  if (!items.length || (!asked && items.length === 1 && items[0] === ctx.word)) return close();
  if (L.field && L.field !== f) close();
  L.field = f;
  L.kind = ctx.kind;
  L.prop = ctx.prop || "";
  L.items = items;
  L.on = 0;
  L.s = ctx.s;
  L.e = ctx.e;
  L.colon = !!ctx.colon;
  L.live = false;
  draw();
}

function draw() {
  const colour = L.kind === "value";
  listEl.replaceChildren(...L.items.map((it, i) => {
    const row = document.createElement("div");
    row.className = i === L.on ? "sg on" : "sg";
    row.id = `b42-sg-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === L.on));
    if (colour && isColour(it)) row.appendChild(document.createElement("i")).style.background = it;
    row.append(it); // text, never markup
    return row;
  }));
  listEl.setAttribute("aria-label", L.kind === "name" ? "CSS properties" : `Values of ${L.prop}`);
  listEl.scrollTop = 0;
  if (listEl.hidden) {
    listEl.style.visibility = "hidden"; // until it is placed, in the next frame
    listEl.hidden = false;
  }
  if (isVal(L.field)) L.field.setAttribute("aria-expanded", "true"); // (a combobox; a text area is none, and has no such state)
  L.field.setAttribute("aria-activedescendant", `b42-sg-${L.on}`);
  place();
}

/** Under the caret (a text area: where the token starts) or under the field (a computed row);
 *  above it when there is no room below. In the next frame: the layer under a text area that
 *  says where its letters are is brought up to date in the frame after a key. */
function place() {
  if (L.raf) return;
  L.raf = requestAnimationFrame(() => {
    L.raf = 0;
    const f = L.field;
    if (!f) return;
    const box = f.getBoundingClientRect();
    let left = box.left, top = box.top, bottom = box.bottom;
    const at = isVal(f) ? null : caretRect(f, L.s);
    if (at) {
      left = at.left;
      // (a line scrolled out of the box: the list stays at the box's edge)
      top = Math.min(Math.max(at.top, box.top), box.bottom);
      bottom = Math.min(Math.max(at.bottom, box.top), box.bottom);
    }
    const w = listEl.offsetWidth, h = listEl.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const y = bottom + 3 + h <= vh - 4 ? bottom + 3 : top - 3 - h >= 4 ? top - 3 - h : Math.max(4, vh - 4 - h);
    const x = Math.max(4, Math.min(left - (at ? 12 : 8), vw - 4 - w)); // (less the padding: the rows' text starts where the token does)
    listEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    listEl.style.visibility = "";
  });
}

/** Where the letter at `offset` of a text area is, read from the layer under it that mirrors
 *  its text (inspector.js's mark()). Null when the layer does not have that text (yet). */
function caretRect(area, offset) {
  const layer = area.previousElementSibling;
  if (!layer || layer.textContent !== `${area.value}\n`) return null;
  const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let n, left = offset;
  while ((n = walk.nextNode())) {
    const len = n.nodeValue.length;
    if (left < len) {
      const r = document.createRange();
      r.setStart(n, left);
      r.setEnd(n, left + 1);
      const rect = r.getClientRects()[0] || r.getBoundingClientRect();
      return rect && (rect.height || rect.width) ? rect : null;
    }
    left -= len;
  }
  return null;
}

function highlight(i) {
  const n = L.items.length;
  const to = ((i % n) + n) % n;
  const was = listEl.children[L.on], row = listEl.children[to];
  if (was) {
    was.classList.remove("on");
    was.setAttribute("aria-selected", "false");
  }
  L.on = to;
  row.classList.add("on");
  row.setAttribute("aria-selected", "true");
  L.field.setAttribute("aria-activedescendant", row.id);
  // Into view, by the list's own scroll only (scrollIntoView may move the page under the layer).
  const top = /** @type {HTMLElement} */ (row).offsetTop, h = /** @type {HTMLElement} */ (row).offsetHeight;
  if (top < listEl.scrollTop + 4) listEl.scrollTop = top - 4;
  else if (top + h > listEl.scrollTop + listEl.clientHeight - 4) listEl.scrollTop = top + h - listEl.clientHeight + 4;
  if (L.kind === "value") preview(L.items[to]);
}

/** Close the list. What the field holds stays as it is (see revert). */
function close() {
  const f = L.field;
  if (!f) return;
  L.field = null;
  listEl.hidden = true;
  listEl.replaceChildren();
  if (isVal(f)) f.setAttribute("aria-expanded", "false");
  f.removeAttribute("aria-activedescendant");
  if (L.live) stepIn(700); // what was shown stays: an edit like one typed
  L.live = false;
}

// ── writing ─────────────────────────────────────────────────────────────────────────────────
/** A computed row's value on the page as it stands in the field, without closing an undo step
 *  (setValue does the same and closes one). What the browser does not take is not written. */
function writeValue(f) {
  const row = f.parentElement, p = row._p, v = line(clean(f.value));
  if (!C.sel || !p || !v || !supports(p, v)) return;
  const en = entry(C.sel);
  const css = setDecl(en.css, p, v);
  if (css.length > MAX_CSS) return;
  en.css = css;
  unmarkValue(row);
  applyAll();
  syncFields();
}

/** `text` in place of the token, the caret after it, and the page told as typing tells it. */
function put(f, s, e, text) {
  f.setRangeText(text, s, e, "end");
  if (isVal(f)) writeValue(f);
  else typed(f);
}

/** Show the highlighted value on the page, in place of what was typed. */
function preview(v) {
  const f = L.field;
  if (!L.live) {
    L.live = true;
    L.typed = f.value.slice(L.s, L.e);
    L.caret = f.selectionEnd;
    L.css = (isVal(f) && C.draft.B.els[C.selRs]?.css) || "";
    L.was = isVal(f) ? f.parentElement._v || "" : "";
  }
  if (isVal(f)) {
    // A row's own value, come to on the way through the list, is not a change: nothing is declared for it.
    f.setRangeText(v, L.s, L.e, "end");
    if (line(clean(f.value)) === L.was) restore();
    else writeValue(f);
  } else put(f, L.s, L.e, v);
  L.e = L.s + v.length;
  stepIn(HELD);
}

/** Escape: what was typed is back, in the field and on the page. */
function revert() {
  const f = L.field;
  if (!L.live) return;
  L.live = false;
  f.setRangeText(L.typed, L.s, L.e, "end");
  f.setSelectionRange(L.caret, L.caret);
  if (!isVal(f)) typed(f);
  else restore();
  stepIn(700); // (nothing changed since the last step: none is made)
}

/** (A computed row.) The element's styles as they were before the list showed anything. */
function restore() {
  if (!C.sel) return;
  entry(C.sel).css = L.css;
  unmarkValue(L.field.parentElement);
  applyAll();
  syncFields();
}

function accept(i) {
  const f = L.field, item = L.items[i], s = L.s, e = L.e;
  if (!f || item === undefined) return;
  if (L.kind === "name") {
    const colon = L.colon;
    close();
    f.setRangeText(colon ? item : `${item}: `, s, e, "end");
    typed(f);
    if (!colon) show(f, true); // its values, at once
    return;
  }
  L.live = false;
  close();
  f.setRangeText(item, s, e, "end");
  if (isVal(f)) {
    readValue(f.parentElement); // (what the page has now: shown already, setValue finds nothing new to write)
    setValue(f);
    commit(); // (…and the step is closed here)
  } else {
    typed(f);
    commit();
  }
}

/** ↑/↓ on a keyword with the list closed: the property's keyword before or after it, live.
 *  In a computed row the keyword the caret is in. In a text box, where the arrows move the
 *  caret from line to line, only a keyword that is selected (all of it or a part: a double
 *  click); the new one is selected in its place, so the next press goes on from it. */
function cycle(f, dir) {
  const area = !isVal(f);
  let ctx;
  if (area) {
    const [a, b] = picked(f);
    if (a === b) return false;
    ctx = caretContext(f.value, b, f === freeEl);
    if (ctx.kind !== "value" || a < ctx.s || b > ctx.e) return false; // (more than one token: the keys are the field's)
  } else ctx = contextOf(f);
  if (ctx.kind !== "value") return false;
  const token = f.value.slice(ctx.s, ctx.e);
  if (!token || isNumber(token)) return false;
  // (Beside other tokens the CSS-wide keywords are no value: `margin: 0 auto` never becomes `0 revert`.)
  const next = step(valuesAt(valuesFor(ctx.prop), f.value, ctx), token, dir);
  if (!next) return false;
  if (area) {
    f.setRangeText(next, ctx.s, ctx.e, "select");
    typed(f);
  } else put(f, ctx.s, ctx.e, next);
  stepIn(700); // a run of presses is one step
  return true;
}

// ── keys ────────────────────────────────────────────────────────────────────────────────────
/** A key in an inspector field, before keys.js does anything with it. True when it was taken
 *  (and stopped): the list's keys while it is open; ctrl+space; ↑/↓ on a keyword (in a text box:
 *  on a selected one). False for everything else, ↑/↓ on a number among it (keys.js steps those). */
export function suggestKey(e, field) {
  if (!ours(field) || e.isComposing) return false;
  const k = e.key, plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  const arrow = k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0;
  if (L.field && L.field !== field) close();
  if (L.field) {
    if (arrow && plain && !e.shiftKey) {
      highlight(L.on + arrow);
      return take(e);
    }
    if ((k === "PageDown" || k === "PageUp") && plain && !e.shiftKey) {
      const to = L.on + (k === "PageDown" ? ROWS : -ROWS);
      highlight(Math.max(0, Math.min(L.items.length - 1, to)));
      return take(e);
    }
    if ((k === "Enter" || k === "Tab") && plain && !e.shiftKey) {
      // In a text box, Enter after a whole keyword that longer ones start with (`flex`, with
      // `inline-flex` under it) is the new line it is everywhere else: there is nothing to take.
      if (k === "Enter" && !isVal(field) && L.kind === "value" && !L.live && L.on === 0 && field.value.slice(L.s, L.e).toLowerCase() === L.items[0]) {
        close();
        return false;
      }
      accept(L.on);
      return take(e);
    }
    if (k === "Escape") {
      revert();
      close();
      return take(e);
    }
    // The caret is about to move, or the key is the field's own (mod+Enter sends): the list
    // goes, what it showed stays.
    // (With mod: undo and the like change the text under the list. A modifier alone is no key yet.
    // ↑/↓ get here with shift, which selects: the highlight is moved by the plain ones only.)
    if ((!plain && !/^(Control|Meta|Alt|Shift)$/.test(k)) || /^(Enter|Tab|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(k)) close();
    return false;
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Space" || k === " ")) {
    show(field, true);
    return take(e);
  }
  if (arrow && plain && !e.shiftKey && cycle(field, arrow)) return take(e);
  return false;
}

// ── the fields ──────────────────────────────────────────────────────────────────────────────
function onInput(e) {
  const f = e.target;
  if (!ours(f) || e.isComposing) return;
  // Typing opens the list; anything else that changes the text (a deletion, a paste, undo, a
  // value written by a key) only changes a list that is open.
  const t = e.inputType;
  const typing = t === "insertText" || t === "insertCompositionText" || t === "insertReplacementText";
  if (!typing && L.field !== f) return;
  if (L.live) {
    L.live = false; // typed on top of a value being shown: that value is what was typed now
    stepIn(700);
  }
  show(f, false);
}

function onBlur(e) {
  if (L.field !== e.target) return;
  const live = L.live;
  L.live = false;
  close();
  if (live) commit(); // the value being shown stays, as one step
}

/** Wire the suggestions to the inspector's fields: the two text areas and the computed rows
 *  (which are re-used from row to row, so their events are caught on their list). */
export function attachSuggest(els) {
  ({ cssEl, freeEl, compEl } = els);
  const root = /** @type {ShadowRoot} */ (compEl.getRootNode());
  listEl = root.querySelector(".sug");
  const mark = (f) => {
    if (f.hasAttribute("aria-autocomplete")) return;
    // A computed value is a combobox, open or not. A text area cannot be one (aria-expanded
    // means nothing on it): it says that a list may pop up, which one, and the item in it.
    // (The list and the fields are in the one shadow root, so the ids are found.)
    f.setAttribute("aria-autocomplete", "list");
    f.setAttribute("aria-controls", listEl.id);
    if (isVal(f)) {
      f.setAttribute("role", "combobox");
      f.setAttribute("aria-expanded", "false");
    } else f.setAttribute("aria-haspopup", "listbox");
  };
  for (const a of [cssEl, freeEl]) {
    mark(a);
    a.addEventListener("input", onInput);
    a.addEventListener("blur", onBlur);
    a.addEventListener("mousedown", close); // the caret goes elsewhere
  }
  compEl.addEventListener("input", onInput);
  // (focus and blur do not bubble: caught on the way down)
  compEl.addEventListener("focus", (e) => isVal(e.target) && mark(e.target), true);
  compEl.addEventListener("blur", onBlur, true);
  compEl.addEventListener("mousedown", (e) => isVal(e.target) && close());
  // The list is not in the inspector (which would cut it off), so it keeps its own events from
  // the page, as the inspector does. A press on an item takes it, and leaves the focus alone.
  for (const t of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel"]) listEl.addEventListener(t, (e) => e.stopPropagation());
  listEl.addEventListener("mousedown", (/** @type {MouseEvent} */ e) => {
    e.preventDefault();
    const row = /** @type {Element} */ (e.target).closest(".sg");
    if (row && e.button === 0) accept([...listEl.children].indexOf(row));
  });
  // The field moved under the list (its column scrolled, the panel resized): the list follows.
  cssEl.closest(".insp").addEventListener("scroll", () => L.field && place(), { capture: true, passive: true });
  window.addEventListener("resize", () => L.field && place(), { passive: true });
}
