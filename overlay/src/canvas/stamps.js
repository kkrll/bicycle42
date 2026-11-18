import { component, editSel, line, plainLabel, q, unique } from "../page.js";
import { draftChanged } from "../draft.js";
import { C, EMPTY, kids } from "./state.js";
import { hostEl } from "../mount.js";

// ── which element: paths and stamps ─────────────────────────────────────────────────────────
/** Where an element is: a path of tags and places from the nearest id. Unlike selectorFor it
 *  uses no class names, so it still matches after the reviewer edits the class list. It says
 *  where, not which: when the page adds a sibling before the element, its path is another one. */
function pathSel(el) {
  const parts = [];
  const ours = copyNodes(); // (the copies are not counted: a path says where in the page's own tree)
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
    const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName && (c === cur || !ours.has(c))) : [];
    if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
    parts.unshift(seg);
  }
  return parts.join(" > ");
}

const copyNodes = () => new Set(C.copies.values());

/** Where an element is, to be found by when its stamp is lost: its path, or, inside a copy, the
 *  copy's stamp and the child indices down from it (`[data-b42e="…"] >> 0 2`): the page's tree
 *  has no such place, so a path there would name whatever is where the copy was once it goes.
 *  "" for a copy itself, which is found by its stamp only (see copies.js). */
function placeOf(el) {
  let cp = null;
  for (const [rs, n] of C.copies) if (n.contains(el) && (!cp || cp[1].contains(n))) cp = [rs, n];
  if (!cp) return pathSel(el);
  if (cp[1] === el) return "";
  const ix = [];
  for (let x = el; x !== cp[1]; x = x.parentElement) ix.unshift([...x.parentElement.children].indexOf(x));
  return `${cp[0]} >> ${ix.join(" ")}`;
}

/** The element at a place placeOf wrote: copies are not counted, as there. */
function atPlace(place) {
  const m = /^(\[data-b42e="[a-z0-9]+"\]) >> ([\d ]+)$/.exec(place);
  if (m) {
    let x = C.copies.get(m[1]);
    if (!x || !x.isConnected) return null;
    for (const i of m[2].split(" ")) x = x && x.children[+i];
    return x || null;
  }
  const ours = copyNodes();
  if (!ours.size) return q(place);
  const segs = place.split(" > ");
  let x = segs[0] === "body" ? document.body : segs[0] === "html" ? document.documentElement : q(segs[0]);
  for (const seg of segs.slice(1)) {
    if (!x) return null;
    const [, tag, n] = /^(.*?)(?::nth-of-type\((\d+)\))?$/.exec(seg);
    x = [...x.children].filter((c) => !ours.has(c) && CSS.escape(c.localName) === tag)[(Number(n) || 1) - 1];
  }
  return x || null;
}

// An element with an edit is stamped (an attribute: like the class and text edits a write to
// the DOM, taken off again when no batch names it), and the edit's rules and its key in the
// batch are that stamp. So an edit stays on its element when the page adds, removes or reorders
// the ones around it. The stamp is lost when the page builds the element anew (or reloads):
// then the element is the one where the old one last was, as before. An element with an id of
// its own needs no stamp.
export const STAMP = "data-b42e";
export const stampSel = (id) => `[${STAMP}="${id}"]`;
export const stampOf = (rs) => /^\[data-b42e="([a-z0-9]+)"\]$/.exec(rs)?.[1];
const stampBase = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`; // (a restored draft has stamps of an earlier load)
let stampN = 0;
/** A stamp no element has yet (a copy's, see copies.js). */
export const freshStamp = () => `${stampBase}${(++stampN).toString(36)}`;

/** The selector that says which element this is: its stamp if it has one, else its path. */
export const stableSel = (el) => (el.hasAttribute(STAMP) ? stampSel(el.getAttribute(STAMP)) : pathSel(el));

/** The same for an element that is being edited: it gets its stamp now. */
export function stamp(el) {
  if (!el.hasAttribute(STAMP)) {
    if (el === document.body || el === document.documentElement || (el.id && unique(`#${CSS.escape(el.id)}`))) return pathSel(el);
    el.setAttribute(STAMP, freshStamp());
  }
  const rs = stampSel(el.getAttribute(STAMP));
  const path = placeOf(el);
  if (path) C.paths.set(rs, { path, tag: el.localName });
  C.found.set(rs, el);
  if (el === C.sel) C.selRs = rs;
  return rs;
}

export function elOf(rs) {
  let el = C.found.get(rs);
  const id = stampOf(rs);
  if (el && el.isConnected) {
    // (Taken off when nothing named it any more; an undo, or a refused note, names it again.
    // The selection's key goes with it, or Element styles reads the path's empty entry.)
    if (id && el.getAttribute(STAMP) !== id) {
      el.setAttribute(STAMP, id);
      if (el === C.sel) C.selRs = rs;
    }
    return el;
  }
  // (one in a copy that is out of the page with its batch comes back with it: in its place now is
  // the element the copy was made from, or the one after it)
  if (el && C.copies.size) for (const node of C.copies.values()) if (!node.isConnected && node.contains(el)) return null;
  el = q(rs);
  // (a copy is never found by where it was: in its place now may be the element it copies)
  if (!el && id && !C.copyRs.has(rs)) {
    const p = C.paths.get(rs);
    const at = p && atPlace(p.path);
    if (at && at !== hostEl && at.localName === p.tag && !at.hasAttribute(STAMP)) {
      at.setAttribute(STAMP, id);
      if (at === C.sel) C.selRs = rs;
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
    const path = placeOf(el), p = C.paths.get(rs);
    if (!path || (p && p.path === path)) continue;
    C.paths.set(rs, { path, tag: el.localName });
    changed = true;
  }
  if (C.sel && C.sel.isConnected) C.selRs = stableSel(C.sel);
  if (changed && C.snap !== EMPTY) draftChanged(); // the draft carries the paths (see draft)
}

/** The page changed its tree (the layer's own observer says so): the paths are read now, or,
 *  while the page keeps changing, in a frame soon after (readPathsIfDue). */
export function treeChanged(records) {
  if ((C.found.size || C.sel) && records.some((r) => r.type === "childList")) {
    if (performance.now() - C.pathsAt > 50) readPaths();
    else C.pathsDirty = true;
  }
}

export function readPathsIfDue(now) {
  if (C.pathsDirty && now - C.pathsAt > 50) readPaths();
}

/** What every edit says about its element (the wire names), plus `rs` for our own use. */
export function meta(el) {
  const m = { selector: editSel(el), rs: stamp(el), tag: el.tagName.toLowerCase(), label: line(plainLabel(el)) };
  const c = component(el);
  if (c) m.component = line(c.name);
  const cls = el.getAttribute("class");
  const n = el.parentElement ? kids(el.parentElement).filter((k) => k.tagName === el.tagName && k.getAttribute("class") === cls).length : 1;
  if (n > 1) m.repeated = n;
  C.found.set(m.rs, el);
  return m;
}

export function entry(el) {
  const els = C.draft.B.els;
  return (el.hasAttribute(STAMP) && els[stampSel(el.getAttribute(STAMP))]) || els[stamp(el)] || (els[stamp(el)] = { ...meta(el), css: "" });
}

