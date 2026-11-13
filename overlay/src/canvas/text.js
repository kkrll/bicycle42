import { line } from "../page.js";
import { C } from "./state.js";
import { meta } from "./stamps.js";
import { setText } from "./apply.js";
import { commit } from "./batch.js";
import { editCursor } from "./cursor.js";
import { drawBar, flash } from "./bar.js";
import { kick } from "../render.js";

// ── text, edited in place ───────────────────────────────────────────────────────────────────
// The element itself becomes editable for the moment (plain text only), so the words wrap and
// look exactly as they will. The attribute goes the moment editing ends, whichever way it ends.
export const inEdit = (e) => e.composedPath().includes(C.edit.el);

export function startEdit(el) {
  if (![...el.childNodes].every((n) => n.nodeType === 3) || !el.textContent.trim())
    return flash(el.childElementCount ? "Double-click the words themselves: this has elements inside" : "No text here to edit");
  if (C.typeTimer) commit();
  const ed = { el, from: el.textContent, had: el.getAttribute("contenteditable"), meta: meta(el), onBlur: () => endEdit(true) };
  C.edit = ed;
  el.setAttribute("contenteditable", "plaintext-only");
  el.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
  el.addEventListener("blur", ed.onBlur);
  editCursor(ed.meta.rs);
  drawBar();
  kick();
}

export function endEdit(keep) {
  const ed = C.edit;
  if (!ed) return;
  C.edit = null;
  const el = ed.el;
  el.removeEventListener("blur", ed.onBlur);
  const typed = line(el.textContent);
  if (ed.had === null) el.removeAttribute("contenteditable");
  else el.setAttribute("contenteditable", ed.had);
  if (el.isConnected) {
    // Back to exactly what it was; if the edit is kept, applyAll writes the new words (and
    // remembers the old ones) like any other edit.
    setText(el, ed.from);
    if (document.activeElement === el) el.blur();
    getSelection()?.removeAllRanges();
  }
  if (keep && el.isConnected && typed && typed !== line(ed.from)) {
    const pad = /^(\s*)[\s\S]*?(\s*)$/.exec(ed.from);
    const ops = C.draft.B.ops;
    const old = ops.find((o) => o.kind === "text" && o.rs === ed.meta.rs);
    const op = { kind: "text", ...ed.meta, from: old ? old.from : ed.from, to: pad[1] + typed + pad[2] };
    if (old) ops.splice(ops.indexOf(old), 1);
    if (op.to !== op.from) ops.push(op);
  }
  editCursor(null);
  C.geoKey = "";
  commit();
  drawBar();
}

