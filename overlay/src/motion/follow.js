// Motion mode, edits that stay with their element. An edit is kept under the element's path
// (`body > main > div:nth-of-type(2)`), and its preview is a rule with that path for a selector.
// A page that puts an element in before it (a banner, a list that grows) makes the path another
// element's: the preview would jump to that one, and the note would name it.
//
// So the element each path was read from is remembered, and when the page's tree has changed
// every path is read again from its element. One that is somewhere else now has everything kept
// under it moved there: the unsent edits, the triggers, what is open, the steps of undo, and the
// selectors of what was sent and is still a preview. An element the page has taken out (a
// framework that draws it again) is not followed: its path is the best there is, and is read
// again from whatever is there.

import { treeVersion } from "../mount.js";
import { apply, M, mq, pathOf } from "./model.js";
import { draftChanged } from "../draft.js";

/** path → the element it was read from */
let from = new Map();
let seenTree = -1, busy = false;

/** Every path something is kept under. */
function paths() {
  const out = new Set();
  for (const u of M.use.values()) out.add(u.rs);
  for (const rs of M.tr.keys()) out.add(rs);
  for (const v of M.sv.values()) out.add(v.rs);
  for (const [rs, list] of M.trig) {
    out.add(rs);
    for (const t of list) if (t.on) out.add(t.on);
  }
  if (M.open && M.open.rs) out.add(M.open.rs);
  if (M.selRs) out.add(M.selRs);
  if (M.rec) out.add(M.rec.rs);
  out.delete("");
  return out;
}
/** A step of undo (or what is kept now, as one), with its paths said anew. */
function moved(s, swap) {
  const use = (s.use || []).map(([, u]) => [`${swap(u.rs)}|${u.name}`, { ...u, rs: swap(u.rs) }]);
  const tr = (s.tr || []).map(([, v]) => [swap(v.rs), { ...v, rs: swap(v.rs) }]);
  const sv = (s.sv || []).map(([, v]) => [`${swap(v.rs)}|${v.label}`, { ...v, rs: swap(v.rs), sel: typeof v.sel === "string" ? swap(v.sel) : v.sel }]);
  const one = (t) => ({ ...t, ...(t.on ? { on: swap(t.on) } : {}), ...(Array.isArray(t.and) ? { and: t.and.map(one) } : {}) });
  const trig = (s.trig || []).map(([rs, list]) => [swap(rs), list.map(one)]);
  return { ...s, use, tr, sv, trig, open: s.open && s.open.rs ? { ...s.open, rs: swap(s.open.rs) } : s.open };
}
const step = (text, swap) => {
  try {
    return JSON.stringify(moved(JSON.parse(text), swap));
  } catch {
    return text;
  }
};

/** Every frame of the mode: the paths that are new are read from, and after a change of the
 *  page's tree those whose element is somewhere else are moved there. True when any was. */
export function follow() {
  if (busy || !M.on) return false;
  let any = false;
  if (seenTree !== treeVersion) {
    seenTree = treeVersion;
    any = shift();
  }
  const all = paths();
  for (const rs of from.keys()) if (!all.has(rs)) from.delete(rs);
  for (const rs of all) {
    if (from.has(rs)) continue;
    const el = mq(rs);
    if (el) from.set(rs, new WeakRef(el));
  }
  return any;
}
/** The mode is off: nothing is followed. */
export function unfollow() {
  from = new Map();
  seenTree = -1;
}

function shift() {
  const to = new Map();
  for (const [rs, ref] of from) {
    const el = ref.deref();
    // (Gone: not followed, and read again from what is at its path.)
    if (!el || !el.isConnected) {
      from.delete(rs);
      continue;
    }
    const now = pathOf(el);
    if (now !== rs) to.set(rs, now);
  }
  if (!to.size) return false;
  // All at once (two that changed places are not said twice), the longest first: what is in one
  // that moved has moved with it.
  const olds = [...to.keys()].sort((a, b) => b.length - a.length);
  const find = new RegExp(`(?:${olds.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "g");
  const swap = (text) => (text ? text.replace(find, (m) => to.get(m)) : text);

  const now = moved({ use: [...M.use], tr: [...M.tr], sv: [...M.sv], trig: [...M.trig], open: M.open }, swap);
  M.use = new Map(now.use);
  M.tr = new Map(now.tr);
  M.sv = new Map(now.sv);
  M.trig = new Map(now.trig);
  M.open = now.open;
  if (M.sel && M.sel.isConnected) M.selRs = pathOf(M.sel);
  else M.selRs = swap(M.selRs);
  if (M.rec) M.rec.rs = swap(M.rec.rs);
  const st = M.ro && M.ro.state;
  if (st && typeof st.sel === "string") st.sel = swap(st.sel);
  M.snap = M.snap && step(M.snap, swap);
  M.past = M.past.map((s) => step(s, swap));
  M.future = M.future.map((s) => step(s, swap));
  // What was sent and is still a preview: its rules are said of where the element is now.
  for (const b of M.sent) {
    try {
      for (const r of b.sheet ? b.sheet.cssRules : []) if (r instanceof CSSStyleRule) r.selectorText = swap(r.selectorText);
    } catch {}
  }
  from = new Map([...from].map(([rs, ref]) => [to.get(rs) || rs, ref]));
  busy = true;
  try {
    apply();
    draftChanged();
  } finally {
    busy = false;
  }
  return true;
}
