import { line } from "../page.js";
import { C } from "./state.js";
import { elOf } from "./stamps.js";
import { topProps } from "./css.js";
import { applyAll, splitRules } from "./apply.js";
import { commit } from "./batch.js";
import { value } from "./send.js";
import { dropCopy } from "./copies.js";
import { syncFields } from "./inspector.js";

// ── the unsent batch in plain words ─────────────────────────────────────────────────────────
// The host's footer counts the edits; its count opens this list (CanvasBatch.list in
// ../../protocol-canvas.ts): one row per edit, what it is on and what it does, and a button that
// takes that one edit out. A row's `key` names its edit for the act that removes it.

/** Computed values of every property an element's styles set, with the draft off and on. */
function changesFor(entries) {
  const props = new Map(entries.map((e) => [e.rs, topProps(e.css)]));
  const read = () => {
    const vals = new Map();
    for (const [rs, list] of props) {
      const el = elOf(rs);
      const cs = el && getComputedStyle(el);
      vals.set(rs, list.map((p) => (cs ? value(cs.getPropertyValue(p)) : "")));
    }
    return vals;
  };
  C.draft.id = "measuring";
  C.hide.add("measuring");
  applyAll();
  const before = read();
  C.hide.delete("measuring");
  C.draft.id = "draft";
  applyAll();
  const after = read();
  return new Map(entries.map((e) => [e.rs, props.get(e.rs).map((prop, i) => ({ prop, from: before.get(e.rs)[i], to: after.get(e.rs)[i] }))]));
}

/** The batch's edits, one row each: { key, kind, rs, label, op }. With `words`, each with its
 *  `text` too, which measures the page with the batch off and on. */
export function editRows(words) {
  const B = C.draft.B, entries = Object.values(B.els);
  /** @type {Array<{ key: string, kind: string, rs: string, label: string, text: string, op?: any }>} */
  const rows = [];
  const changes = words ? changesFor(entries.filter((e) => e.css.trim())) : new Map();
  const bare = (v) => v.replace(/(\d)px\b/g, "$1");
  for (const e of entries) {
    if (e.css.trim()) {
      const list = changes.get(e.rs) || [];
      const text = list.length
        ? list.slice(0, 3).map((c) => `${c.prop} ${bare(c.from)} → ${bare(c.to)}`).join(", ") + (list.length > 3 ? `, and ${list.length - 3} more` : "")
        : line(e.css).slice(0, 60);
      rows.push({ key: `css ${e.rs}`, kind: "style", rs: e.rs, label: e.label, text });
    }
    if (e.cls) rows.push({ key: `cls ${e.rs}`, kind: "class", rs: e.rs, label: e.label, text: `class “${line(e.cls.from)}” → “${line(e.cls.to)}”` });
  }
  B.ops.forEach((op, i) =>
    rows.push({ key: `op ${i} ${op.kind} ${op.rs}`, kind: op.kind, rs: op.kind === "duplicate" ? op.copy : op.rs, label: op.label, op,
      text: op.kind === "hide" ? "hidden" : op.kind === "duplicate" ? "duplicated" : op.kind === "move" ? `moved from place ${op.fromIndex + 1} to ${op.toIndex + 1}` : `text “${line(op.from)}” → “${line(op.to)}”` }));
  if (B.sheet.trim()) {
    const k = splitRules(B.sheet).length;
    rows.push({ key: "sheet", kind: "sheet", rs: "", label: "Stylesheet", text: `${k} rule${k === 1 ? "" : "s"}` });
  }
  return rows;
}

/** One edit out of the batch, by its row's key: an undo step like any other (mod+Z brings it back).
 *  False when the batch has no such edit (any more). */
export function removeEdit(key) {
  if (C.typeTimer) commit();
  const row = editRows(false).find((r) => r.key === key);
  if (!row) return false;
  const B = C.draft.B;
  if (row.kind === "style") B.els[row.rs].css = "";
  else if (row.kind === "class") delete B.els[row.rs].cls;
  else if (row.kind === "sheet") B.sheet = "";
  else if (row.kind === "duplicate") {
    dropCopy(row.op.copy); // (with what was edited in the copy)
    return true;
  } else B.ops.splice(B.ops.indexOf(row.op), 1);
  commit();
  syncFields(true);
  return true;
}
