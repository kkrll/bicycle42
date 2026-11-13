import { mod } from "../state.js";
import * as Notes from "../notes/api.js";
import { C } from "./state.js";
import { commit, redo, undo } from "./batch.js";
import { submitCanvas } from "./send.js";
import { cvWalk, hideSel, select } from "./select.js";
import { cancelDrag } from "./drag.js";
import { endEdit } from "./text.js";
import { setPop } from "./bar.js";
import { treeKey } from "./tree.js";
import { setValue, unmarkValue } from "./inspector.js";
import { clsEl, insp, treeEl } from "./mount.js";
import { setMode } from "../mode.js";
import { block } from "../input.js";
import { root } from "../mount.js";

// ── keys ────────────────────────────────────────────────────────────────────────────────────
export function cvKey(e) {
  const f = root.activeElement;
  const area = f && f.tagName === "TEXTAREA" && f !== Notes.textarea ? f : null; // an inspector text area
  const field = area || (f && f.tagName === "INPUT" ? f : null);
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
  const val = f && f.classList.contains("cval") ? f : null; // a computed value being edited
  const tab = f && f.classList.contains("tab") ? f : null;
  if (e.key === "Escape") {
    block(e);
    if (C.drag) cancelDrag();
    else if (C.pop) setPop(C.pop);
    else if (val) {
      val.value = val.parentElement._v; // back to what it was
      unmarkValue(val.parentElement);
      val.blur();
    } else if (field || f === treeEl || tab) f.blur();
    else if (C.sel) select(null);
    else setMode("notes");
    return;
  }
  if (e.key === "Enter" && !e.isComposing) {
    // In the inspector Enter is a new line (or, in the class line, "done"); mod+Enter sends.
    if (tab && !mod(e)) return void e.stopImmediatePropagation(); // the switch works as a button does
    if (area || f === clsEl || val ? mod(e) : !e.shiftKey) {
      block(e);
      if (val) setValue(val);
      submitCanvas(e.altKey);
    } else if (f === clsEl) {
      block(e);
      commit();
    } else if (val) {
      block(e);
      setValue(val);
    } else e.stopImmediatePropagation();
    return;
  }
  if (tab && (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    if (e.key === " ") return void e.stopImmediatePropagation();
    block(e);
    const other = insp.querySelector(e.key === "ArrowLeft" ? ".t-el" : ".t-gl");
    if (!other.disabled) {
      other.focus();
      other.click();
    }
    return;
  }
  if (val && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    block(e);
    const up = e.key === "ArrowUp";
    if (e.altKey) {
      // alt+↑/↓ nudges the first number of the value by 1 (with shift: 10) and writes it.
      val.value = val.value.replace(/-?\d*\.?\d+/, (m) => String(Math.round((Number(m) + (up ? 1 : -1) * (e.shiftKey ? 10 : 1)) * 100) / 100));
      setValue(val);
    } else {
      const row = up ? val.parentElement.previousElementSibling : val.parentElement.nextElementSibling;
      if (row) {
        row.lastChild.focus();
        row.lastChild.select();
      }
    }
    return;
  }
  if (mod(e) && !e.altKey && e.key.toLowerCase() === "z") {
    block(e);
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (area && e.key === "Tab" && !e.shiftKey && !mod(e)) {
    block(e);
    area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
    area.dispatchEvent(new Event("input"));
    return;
  }
  if (field) return void e.stopImmediatePropagation();
  if (f === treeEl && /^Arrow/.test(e.key)) {
    block(e);
    treeKey(e.key);
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && C.sel) {
    block(e);
    hideSel();
    return;
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && C.sel) {
    block(e);
    cvWalk(e.key === "ArrowUp");
    return;
  }
  e.stopImmediatePropagation();
}

