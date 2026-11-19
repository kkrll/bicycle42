import { line, SKIP } from "../page.js";
import { C } from "./state.js";
import { select } from "./select.js";
import { kick } from "../render.js";
import { domVersion } from "../mount.js";

// ── the tree ────────────────────────────────────────────────────────────────────────────────
// A flat list of the rows that are open, built by walking only the expanded elements. The host's
// inspector draws it (host.js sends the rows it shows, and a screenful around them).
export const T = { open: new WeakSet(), rows: [], ver: -1, at: 0 };
export const treeKids = (el) => [...el.children].filter((c) => !SKIP.test(c.tagName));
const hasKids = (el) => {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!SKIP.test(c.tagName)) return true;
  return false;
};

export function buildRows() {
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

/** Open the way down to an element. (The host brings its row into view: host.js.) */
export function reveal(el) {
  for (let a = el.parentElement; a; a = a.parentElement) T.open.add(a);
  buildRows();
}

export function toggleRow(el, open) {
  if (open ?? !T.open.has(el)) T.open.add(el);
  else T.open.delete(el);
  buildRows();
  kick();
}

/** What a row says: its twisty ("open", "shut", "none"), the tag, `#id`, `.classes` and a short
 *  preview of the element's own words (not its children's). */
export function rowParts(el) {
  const names = (el.getAttribute("class") || "").trim();
  let words = "";
  for (let c = el.firstChild, k = 0; c && k < 12 && words.length < 40; c = c.nextSibling, k++) if (c.nodeType === 3) words += c.data;
  words = line(words);
  return [
    hasKids(el) ? (T.open.has(el) ? "open" : "shut") : "none",
    el.localName,
    el.id ? `#${el.id}` : "",
    names ? `.${names.split(/\s+/).slice(0, 4).join(".")}`.slice(0, 60) : "",
    words.length > 40 ? `${words.slice(0, 39)}…` : words,
  ];
}

/** An arrow on the host's tree: up and down the rows, right opens or goes in, left closes or goes out. */
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
