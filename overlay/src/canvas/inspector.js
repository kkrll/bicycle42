import { icon } from "../ui.js";
import { line, plainLabel } from "../page.js";
import { C, clean, COMPUTED, MAX_CLASS, MAX_CSS, MAX_SHEET } from "./state.js";
import { entry } from "./stamps.js";
import { problems, setDecl, supports, topProps } from "./css.js";
import { applyAll } from "./apply.js";
import { commit } from "./batch.js";
import { dock, syncUi } from "./cursor.js";
import { drawBar, drawPop, flash, hush } from "./bar.js";
import { reveal, T } from "./tree.js";
import { clsEl, compEl, cssEl, freeEl, insp, ipath } from "./mount.js";
import { kick, pool } from "../render.js";
import { domVersion, root } from "../mount.js";

// ── inspector: classes, element styles, stylesheet, computed ────────────────────────────────
/** Put the batch's text into the fields (never into the one being typed in, unless forced). */
export function syncFields(force) {
  if (!insp) return;
  const el = C.sel && C.sel.isConnected ? C.sel : null;
  const e = el && C.draft.B.els[C.selRs];
  const f = root.activeElement;
  const put = (field, v) => {
    if ((force || f !== field) && field.value !== v) field.value = v;
  };
  put(clsEl, el ? el.getAttribute("class") ?? "" : "");
  put(cssEl, e ? e.css : "");
  put(freeEl, C.draft.B.sheet);
  clsEl.disabled = cssEl.disabled = !el;
  const hint = el ? "No classes · type to add" : "Select an element to edit its classes";
  if (clsEl.placeholder !== hint) clsEl.placeholder = hint;
  // The header has the room: the words are cut where it ends, not at a note's length.
  const name = el ? `${line(plainLabel(el, 80))}${C.marks.get(el)?.includes("hid") ? " · hidden" : ""}` : "Nothing selected";
  if (ipath.textContent !== name) ipath.textContent = name;
  if (force) for (const row of compEl.children) unmarkValue(row);
  drawTabs();
  markAll();
  C.compKey = "";
  if (C.pop === "list" && !C.inPop) {
    C.inPop = true; // (the list measures by switching the draft off and on, which comes back here)
    drawPop();
    C.inPop = false;
  }
  drawBar();
}

function markAll() {
  mark(cssEl, false);
  mark(freeEl, true);
  const long = clsEl.value.length > MAX_CLASS;
  if (clsEl._long !== long) {
    clsEl._long = long;
    clsEl.classList.toggle("bad", long);
    clsEl.title = long ? `Too long: more than ${MAX_CLASS} characters. Not applied` : "";
  }
}

/** Underline what the browser rejects (in a layer under the text) and say why below the box. */
function mark(area, sheet) {
  const text = area.value;
  if (area._marked === text) return;
  area._marked = text;
  const max = sheet ? MAX_SHEET : MAX_CSS;
  const bad = text.length > max ? [] : problems(text, sheet);
  const nodes = [];
  let at = 0;
  for (const b of bad) {
    if (b.s < at) continue;
    nodes.push(text.slice(at, b.s));
    const u = document.createElement("u");
    u.textContent = text.slice(b.s, b.e);
    u.title = b.why;
    nodes.push(u);
    at = b.e;
  }
  nodes.push(`${text.slice(at)}\n`);
  area.previousElementSibling.replaceChildren(...nodes);
  const err = area.parentElement.nextElementSibling;
  const msg = text.length > max ? `Too long: ${text.length} / ${max} characters. Not applied; shorten it before sending`
    : bad.length ? `Not applied: ${bad.slice(0, 3).map((b) => b.why).join(" · ")}${bad.length > 3 ? ` · and ${bad.length - 3} more` : ""}` : "";
  if (err.textContent !== msg) err.textContent = msg;
  err.hidden = !msg;
}

/** Typing: the page follows within a frame; the undo step closes when the typing pauses. */
export function typed(field) {
  const v = clean(field.value);
  if (v !== field.value) {
    const at = field.selectionStart - (field.value.length - v.length);
    field.value = v;
    field.setSelectionRange(at, at);
  }
  const B = C.draft.B;
  if (field === freeEl) {
    B.sheet = v;
    drawTabs();
  }
  else if (!C.sel) return;
  else if (field === cssEl) entry(C.sel).css = v;
  else {
    const e = entry(C.sel);
    // "From" is the attribute as this batch found it (the page's own, or what an earlier batch left).
    e.cls = { from: e.cls ? e.cls.from : C.sel.getAttribute("class"), to: v.replace(/\s+/g, " ") };
  }
  hush();
  clearTimeout(C.typeTimer);
  C.typeTimer = setTimeout(commit, 700);
  // The key press itself only stores the text. Marking and applying happen in the next frame;
  // on a page where applying is slow (measured: the restyle it causes is forced and timed), it
  // waits for a short pause in the typing instead of running on every frame.
  if (!C.typeRaf)
    C.typeRaf = requestAnimationFrame(() => {
      C.typeRaf = 0;
      markAll();
      clearTimeout(C.slowTimer);
      if (C.slow) C.slowTimer = setTimeout(applyTimed, 100);
      else applyTimed();
    });
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

export function drawComputed() {
  const el = C.sel;
  const now = performance.now();
  // The page changes an element's look without changing the tree: a class or an inline style
  // set by its script (the agent's edit, hot-reloaded, is often just that). domVersion does not
  // count those, so the selection's own two attributes are part of the key; and once a second
  // the values are read again whatever happened (a stylesheet swapped, a class on a parent).
  const attrs = el && el.isConnected ? `${el.getAttribute("class")}|${el.getAttribute("style")}` : "";
  const key = `${C.selRs}|${C.rev}|${domVersion}|${C.collapsed}|${attrs}`;
  if ((key === C.compKey && now - C.compAt < 1000) || now - C.compAt < 150) return;
  C.compKey = key;
  C.compAt = now;
  const live = el && el.isConnected && !C.collapsed;
  // The class line shows the attribute as it is now, unless it is being typed in: typing on
  // top of an old list would record the page's newer classes as removed.
  if (live && root.activeElement !== clsEl) {
    const cls = el.getAttribute("class") ?? "";
    if (clsEl.value !== cls) {
      clsEl.value = cls;
      markAll();
    }
  }
  const cs = live ? getComputedStyle(el) : null;
  const flex = live && cs.display.includes("flex"), grid = live && cs.display.includes("grid");
  // Only what can apply: the flex and grid properties show when the element is one.
  const list = !live ? [] : COMPUTED.filter((p) => (p === "flex-direction" ? flex : p === "align-items" || p === "justify-content" || p === "gap" ? flex || grid : true));
  const e = live && C.draft.B.els[C.selRs];
  const mine = e ? topProps(e.css) : [];
  const rows = pool(compEl, list.length, () => {
    const row = document.createElement("div");
    row.className = "crow";
    // The name copies the line into Element styles; the value is a field that writes it there.
    // (Tab goes from value to value: the names are out of the tab order.)
    row.innerHTML = '<button type="button" class="cp" tabindex="-1" title="Copy into Element styles"></button><input class="cval" type="text" spellcheck="false" autocomplete="off">';
    return row;
  });
  const focused = root.activeElement;
  list.forEach((p, i) => {
    const row = rows[i], field = row.lastChild;
    const v = pretty(cs.getPropertyValue(p));
    // In the accent colour: what this batch has changed on this element.
    const changed = mine.some((m) => m === p || m.startsWith(`${p}-`) || p.startsWith(`${m}-`));
    if (row._p !== p) {
      row.firstChild.textContent = row._p = p;
      field.setAttribute("aria-label", p);
    }
    row._v = v;
    // A value being typed, or one marked as rejected, is the reviewer's: it is left alone.
    if (field !== focused && !row._bad && field.value !== v) field.value = field.title = v;
    if (row._m !== changed) row.classList.toggle("mine", (row._m = changed));
  });
}

export const unmarkValue = (row) => {
  if (!row._bad) return;
  row._bad = false;
  row.lastChild.classList.remove("bad");
  row.lastChild.title = row._v || "";
};

/** A computed value was edited: write `prop: value;` into Element styles (the way a drag does),
 *  unless the browser would not take it; then it is marked, like rejected CSS, and not written. */
export function setValue(field) {
  const row = field.parentElement, p = row._p, v = line(clean(field.value));
  if (!C.sel || !p) return;
  if (!v || v === row._v) {
    field.value = row._v;
    return unmarkValue(row);
  }
  if (!supports(p, v)) {
    row._bad = true;
    field.classList.add("bad");
    field.title = `invalid value for ${p}: not written`;
    return;
  }
  unmarkValue(row);
  const en = entry(C.sel);
  const css = setDecl(en.css, p, v);
  const full = css.length > MAX_CSS;
  if (!full) en.css = css;
  commit();
  syncFields(true);
  if (full) flash("This element's styles are full: shorten them first");
}

/** Element | Global: the selection's own styles, or the batch's stylesheet. Without a selection
 *  there is only Global; with one it is Element, unless the reviewer chose Global themselves. */
export function drawTabs() {
  const el = C.sel && C.sel.isConnected ? C.sel : null;
  const global = !el || C.pin;
  const tEl = insp.querySelector(".t-el"), tGl = insp.querySelector(".t-gl");
  const key = `${!!el}|${global}|${!!C.draft.B.sheet.trim()}`;
  if (key === tEl._key) return;
  tEl._key = key;
  tEl.disabled = !el;
  tEl.title = el ? "Classes, styles and computed values of the selection" : "Select an element";
  tEl.classList.toggle("on", !global);
  tGl.classList.toggle("on", global);
  tEl.setAttribute("aria-selected", String(!global));
  tGl.setAttribute("aria-selected", String(global));
  insp.querySelector(".p-el").hidden = global;
  insp.querySelector(".p-gl").hidden = !global;
  tGl.querySelector(".dot").hidden = !C.draft.B.sheet.trim(); // rules are waiting in there
}

export function setPanel(h, collapsed, settled = true) {
  const opened = C.collapsed && !collapsed;
  C.ph = Math.round(Math.min(Math.max(h, 140), Math.max(140, window.innerHeight * 0.7)));
  C.collapsed = collapsed;
  insp.style.height = `${dock()}px`;
  insp.classList.toggle("shut", collapsed);
  const fold = insp.querySelector(".ifold");
  if (fold._shut !== collapsed) {
    fold._shut = collapsed;
    fold.innerHTML = icon(collapsed ? "chevron-up" : "chevron-down");
    fold.title = collapsed ? "Open the inspector" : "Collapse the inspector";
    fold.setAttribute("aria-label", fold.title);
  }
  // Folded, the tree is not displayed and loses its scroll: opened again, the selection is
  // brought back into view (or the old place, with nothing selected).
  if (opened) {
    T.want = T.scroll;
    if (C.sel) {
      T.scroll = -1e9;
      reveal(C.sel);
    }
  }
  T.need = true;
  if (settled) syncUi(); // the page's scroll room follows when the drag is over, not during it
  drawBar();
  kick();
}

