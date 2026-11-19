import { C } from "./state.js";
import { elOf, freshStamp, meta, STAMP, stampSel } from "./stamps.js";
import { commit } from "./batch.js";
import { flash } from "./bar.js";
import { select } from "./select.js";
import { syncFields } from "./host.js";
import { hostEl } from "../mount.js";

// ── duplicate: a copy of an element, right after it ─────────────────────────────────────────
// The one edit that adds to the page's tree. The copy is the element as the page shows it then
// (cloned, with the class and text edits written into it), stamped with a stamp of its own that
// the edit carries, so edits made on the copy are keyed to it as to any element. It is the
// batch's: taken out when the edit is undone, hidden with its batch, put back after its source
// when the page re-renders it away, and gone when the note is done (the agent's copy is then the
// real one). The style edits of the source show on it too (applyAll lists both in one rule), its
// own come after them and win.

/** Make the page hold the copies the batches ask for, after their sources. True when it changed. */
export function syncCopies() {
  const want = new Map();
  C.copyRs = new Set();
  for (const b of [...C.sent, C.draft])
    for (const op of b.B.ops)
      if (op.kind === "duplicate") {
        C.copyRs.add(op.copy);
        if (!C.hide.has(b.id)) want.set(op.copy, op);
      }
  let changed = false;
  for (const [rs, node] of C.copies) {
    if (want.has(rs)) continue;
    if (node.isConnected) {
      node.remove();
      changed = true;
    }
    if (!C.copyRs.has(rs)) C.copies.delete(rs); // (one only hidden is kept, edits and all, to come back)
  }
  const mine = new Set(C.copies.values());
  for (const [rs, op] of want) {
    let node = C.copies.get(rs);
    const src = elOf(op.rs);
    if (node && node.isConnected && (!src || node.parentElement === src.parentElement)) continue;
    if (!src || !src.parentElement || src === hostEl) continue;
    if (!node) {
      node = src.cloneNode(true);
      const id = /^\[data-b42e="([a-z0-9]+)"\]$/.exec(rs)[1];
      for (const x of node.querySelectorAll(`[${STAMP}]`)) x.removeAttribute(STAMP);
      // (Ids are the source's: two of one would make #id name both, and its edits land on the
      // copy too. Radios keep a group of their own, or a checked one unchecks the source's.)
      for (const x of [node, ...node.querySelectorAll("[id]")]) x.removeAttribute("id");
      for (const x of node.querySelectorAll("input[type=radio][name]")) x.setAttribute("name", `${x.getAttribute("name")}~${id}`);
      node.removeAttribute("contenteditable");
      node.setAttribute(STAMP, id);
      C.copies.set(rs, node);
      mine.add(node);
    }
    let at = src;
    while (at.nextElementSibling && mine.has(at.nextElementSibling)) at = at.nextElementSibling;
    at.after(node);
    C.found.set(rs, node);
    changed = true;
  }
  return changed;
}

/** The copy an element is, or is inside: its stamp, or "". */
export function copyAround(el) {
  let best = "", depth = Infinity;
  for (const [rs, node] of C.copies) {
    if (!node.isConnected || !node.contains(el)) continue;
    let d = 0;
    for (let x = el; x !== node; x = x.parentElement) d++;
    if (d < depth) [best, depth] = [rs, d];
  }
  return best;
}

/** mod+D: a copy of the selection, right after it, and the copy selected. */
export function duplicateSel() {
  const src = C.sel;
  if (!src) return;
  if (src === document.body || !src.parentElement || src.parentElement === document.documentElement) return flash("This element can't be duplicated");
  const op = { kind: "duplicate", ...meta(src), copy: stampSel(freshStamp()) };
  C.draft.B.ops.push(op);
  commit(); // (applyAll makes the copy)
  const node = C.copies.get(op.copy);
  if (node && node.isConnected) select(node);
}

/** Take out of the unsent batch what is in the given copies: the edits made in them, and the
 *  copies made of them or of something in them (and so on). For a copy deleted, and for one that
 *  goes with its note: left in, such an edit would be found again by a place that is no more.
 *  How many edits went. */
export function dropInside(rss) {
  const B = C.draft.B, gone = new Set(rss);
  const nodes = () => [...gone].map((r) => C.copies.get(r)).filter(Boolean);
  const inside = (x) => {
    if (!x) return false;
    if (gone.has(x)) return true;
    const el = elOf(x) || C.found.get(x); // (in a copy that is out with its batch: still in it)
    return !!el && nodes().some((n) => n.contains(el));
  };
  for (let more = true; more; ) {
    more = false;
    for (const o of B.ops)
      if (o.kind === "duplicate" && !gone.has(o.copy) && inside(o.rs)) {
        gone.add(o.copy);
        more = true;
      }
  }
  const n0 = B.ops.length + Object.keys(B.els).length;
  B.ops = B.ops.filter((o) => !(o.kind === "duplicate" && gone.has(o.copy)) && !inside(o.rs) && !inside(o.parent && o.parent.rs));
  for (const k in B.els) if (inside(k)) delete B.els[k];
  if (C.sel && nodes().some((n) => n.contains(C.sel))) select(null);
  return n0 - B.ops.length - Object.keys(B.els).length;
}

/** Delete on a copy this batch made, or × on its row: the copy goes, with what was edited in it. */
export function dropCopy(rs) {
  dropInside([rs]);
  commit();
  syncFields(true);
}

/** Whether a copy is one the unsent batch made (Delete takes it out rather than hiding it). */
export const draftCopy = (rs) => C.draft.B.ops.some((o) => o.kind === "duplicate" && o.copy === rs);
