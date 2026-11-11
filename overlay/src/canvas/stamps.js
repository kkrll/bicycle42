// ── which element: paths and stamps ─────────────────────────────────────────────────────────
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

