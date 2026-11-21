import { isMac, mod } from "../state.js";
import { C } from "./state.js";
import { redo, undo } from "./batch.js";
import { submitCanvas } from "./send.js";
import { cvWalk, hideSel, select } from "./select.js";
import { draftCopy, dropCopy, duplicateSel } from "./copies.js";
import { cancelDrag } from "./drag.js";
import { endEdit, hasWords, startEdit } from "./text.js";
import { flash } from "./bar.js";
import { setMode } from "../mode.js";
import { block } from "../input.js";

// ── keys ────────────────────────────────────────────────────────────────────────────────────
// The page's keys in canvas mode. The inspector's are the host's: what they do comes as acts
// (host.js).
export function cvKey(e) {
  if (C.edit) {
    if (e.key === "Enter" && !e.isComposing) {
      block(e);
      endEdit(true);
    } else if (e.key === "Escape") {
      block(e);
      endEdit(false);
    } else e.stopImmediatePropagation(); // typing: the page's handlers never see it
    return;
  }
  if (e.key === "Escape") {
    block(e);
    if (C.drag) cancelDrag();
    else if (C.sel) select(null);
    else setMode("notes");
    return;
  }
  if (e.key === "Enter" && !e.isComposing) {
    // As in Figma: Enter goes into the selection, shift+Enter out of it; where there is no
    // further in, the element's words are edited. So Enter alone never sends: mod+Enter does,
    // here as in the inspector's fields.
    block(e);
    if (mod(e)) submitCanvas(e.altKey);
    else if (!C.sel) flash(`Enter goes into the selection: ${isMac ? "⌘" : "ctrl+"}Enter sends`);
    else if (!cvWalk(e.shiftKey) && !e.shiftKey && hasWords(C.sel)) startEdit(C.sel);
    return;
  }
  if (mod(e) && !e.altKey && e.key.toLowerCase() === "z") {
    block(e);
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && C.sel) {
    block(e);
    // (a copy this batch made is taken out, not hidden: it was never the page's)
    if (draftCopy(C.selRs)) dropCopy(C.selRs);
    else hideSel();
    return;
  }
  if (mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "d" && C.sel) {
    block(e);
    duplicateSel();
    return;
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && C.sel) {
    block(e);
    cvWalk(e.key === "ArrowUp");
    return;
  }
  e.stopImmediatePropagation();
}
