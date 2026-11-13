import { icon } from "../ui.js";
import { line, SKIP } from "../page.js";
import { C } from "./state.js";
import { select } from "./select.js";
import { treeEl, trows, tspace } from "./mount.js";
import { kick, pool } from "../render.js";
import { domVersion } from "../mount.js";

// ── inspector: the tree ─────────────────────────────────────────────────────────────────────
// A flat list of the rows that are open, built by walking only the expanded elements, and drawn
// through a window: however large the page, the tree holds a screenful of row elements.
const ROW = 20;
export const T = { open: new WeakSet(), rows: [], ver: -1, at: 0, need: true, scroll: 0, first: -1 };
export const treeKids = (el) => [...el.children].filter((c) => !SKIP.test(c.tagName));
const hasKids = (el) => {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!SKIP.test(c.tagName)) return true;
  return false;
};

function buildRows() {
  const rows = [];
  const walk = (el, depth) => {
    if (rows.length >= 20000) return;
    rows.push({ el, depth });
    if (T.open.has(el)) for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!SKIP.test(c.tagName)) walk(c, depth + 1);
  };
  if (document.body) {
    if (!T.init) T.open.add((T.init = document.body));
    walk(document.body, 0);
  }
  T.rows = rows;
  T.ver = domVersion;
  T.at = performance.now();
}

/** Open the way down to an element and bring its row into view. */
export function reveal(el) {
  for (let a = el.parentElement; a; a = a.parentElement) T.open.add(a);
  buildRows();
  const i = T.rows.findIndex((r) => r.el === el);
  const h = treeHeight();
  // Where to scroll is only noted here. drawTree scrolls, after it has made the pane tall enough
  // for the rows just opened: scrolling first is cut short at the old height by the browser, and
  // the rows were then drawn for a place the pane never reached (a blank pane until touched).
  if (i >= 0 && (i * ROW < T.scroll || (i + 1) * ROW > T.scroll + h)) T.want = Math.max(0, i * ROW - Math.floor(h / 2 / ROW) * ROW);
  T.need = true;
}
const treeHeight = () => Math.max(ROW, C.ph - 31);

export function toggleRow(el, open) {
  if (open ?? !T.open.has(el)) T.open.add(el);
  else T.open.delete(el);
  buildRows();
  T.need = true;
  kick();
}

function makeRow() {
  const row = document.createElement("div");
  row.className = "trow";
  row.innerHTML = `<span class="tw none">${icon("chevron-right", 12)}</span><span class="tt"></span><span class="ti"></span><span class="tc"></span><span class="tx"></span>`;
  return row;
}

export function drawTree() {
  // After DOM changes the list is walked again, but not more often than a few times a second.
  if (T.ver !== domVersion && (T.ver < 0 || performance.now() - T.at > 200)) buildRows();
  else if (!T.need) return;
  T.need = false;
  // The pane's height first, then the scroll, then the window of rows: in that order the
  // window is always the one the pane shows.
  const total = `${T.rows.length * ROW}px`;
  if (tspace.style.height !== total) tspace.style.height = total;
  if (T.want != null) {
    treeEl.scrollTop = T.want;
    T.scroll = treeEl.scrollTop; // what the browser made of it
    T.want = null;
  }
  T.scroll = Math.min(T.scroll, Math.max(0, T.rows.length * ROW - ROW)); // the list got shorter under us
  const first = Math.max(0, Math.floor(T.scroll / ROW) - 2);
  const n = Math.max(0, Math.min(T.rows.length - first, Math.ceil(treeHeight() / ROW) + 4));
  if (T.first !== first) trows.style.transform = `translateY(${(T.first = first) * ROW}px)`;
  const els = pool(trows, n, makeRow);
  for (let i = 0; i < n; i++) {
    const { el, depth } = T.rows[first + i];
    const row = els[i];
    row._el = el;
    // Each part of the row is compared with what it shows and written only when it differs:
    // on a page that changes all the time, a redraw of unchanged rows writes nothing.
    const mark = C.marks.get(el);
    const cls = `trow${el === C.sel ? " on" : ""}${el === C.hover ? " hov" : ""}${mark ? ` ${mark}` : ""}`;
    if (row._cls !== cls) row.className = row._cls = cls;
    if (row._depth !== depth) row.style.paddingLeft = `${4 + (row._depth = depth) * 12}px`;
    const names = (el.getAttribute("class") || "").trim();
    // A short preview of the element's own words (not its children's).
    let words = "";
    for (let c = el.firstChild, k = 0; c && k < 12 && words.length < 40; c = c.nextSibling, k++) if (c.nodeType === 3) words += c.data;
    words = line(words);
    const parts = [
      hasKids(el) ? (T.open.has(el) ? "open" : "shut") : "none",
      el.localName,
      el.id ? `#${el.id}` : "",
      names ? `.${names.split(/\s+/).slice(0, 4).join(".")}`.slice(0, 60) : "",
      words.length > 40 ? `${words.slice(0, 39)}…` : words,
    ];
    const shown = row._parts || (row._parts = []);
    if (shown[0] !== parts[0]) row.firstChild.className = `tw ${(shown[0] = parts[0])}`; // the twisty is an icon, turned by its class
    for (let k = 1; k < 5; k++) if (shown[k] !== parts[k]) row.children[k].textContent = shown[k] = parts[k];
  }
}

export function treeKey(key) {
  const i = T.rows.findIndex((r) => r.el === C.sel);
  const el = C.sel;
  if (i < 0) return void (T.rows[0] && select(T.rows[0].el));
  if (key === "ArrowDown" && T.rows[i + 1]) select(T.rows[i + 1].el);
  else if (key === "ArrowUp" && T.rows[i - 1]) select(T.rows[i - 1].el);
  else if (key === "ArrowRight") {
    if (!T.open.has(el) && hasKids(el)) toggleRow(el, true);
    else if (T.open.has(el) && T.rows[i + 1] && T.rows[i + 1].depth > T.rows[i].depth) select(T.rows[i + 1].el);
  } else if (key === "ArrowLeft") {
    if (T.open.has(el) && hasKids(el)) toggleRow(el, false);
    else if (el !== document.body && el.parentElement) select(el.parentElement);
  }
}

