import { S } from "../state.js";
import { draftChanged } from "../draft.js";
import * as Notes from "../notes/api.js";
import { C, EMPTY } from "./state.js";
import { readPathsIfDue, treeChanged } from "./stamps.js";
import { commit, draft, restoreEdits } from "./batch.js";
import { dropFinished, finish, showEdits, unsendCanvas } from "./send.js";
import { select, zoneOf } from "./select.js";
import { cancelDrag, cvDown, cvMove, cvUp } from "./drag.js";
import { endEdit, inEdit as inEditedText } from "./text.js";
import { syncUi } from "./cursor.js";
import { closePop, drawBar, hush, setPop } from "./bar.js";
import { cvKey } from "./keys.js";
import { hostOff, syncFields } from "./host.js";
import { cvFrame } from "./frame.js";
import { bar, HTML, mountCanvas } from "./mount.js";
import { setMode } from "../mode.js";
import { pagePress } from "../input.js";
import { animating, kick } from "../render.js";

// ── on and off ──────────────────────────────────────────────────────────────────────────────
/** Canvas mode's own part of switching it on or off. The switch is setMode (mode.js): it
 *  turns the other modes off first. */
function setOn(on) {
  if (on === C.on || !bar) return;
  hush();
  if (C.pop) setPop(C.pop);
  C.list = false;
  if (on) {
    // A note in progress becomes the start of the canvas session: its element is selected and
    // its words are the batch's note. (A drawing or an area has no place here.)
    const el = S.sel.length === 1 ? S.sel[0] : null;
    const words = Notes.textarea.value.trim();
    if (S.card || Notes.hasDraft()) Notes.clearDraft();
    Notes.hideSent();
    if (words && !C.note) C.note = words;
    C.on = true;
    select(el && el.isConnected ? el : null);
  } else {
    endEdit(true);
    cancelDrag();
    if (C.typeTimer) commit();
    select(null);
    C.on = false;
    C.hover = null;
    hostOff(); // (the tree's rows and the last selection: elements, not to be kept past the mode)
  }
  S.hover = null;
  try {
    sessionStorage.setItem("b42-canvas", on ? "1" : "");
  } catch {}
  syncUi();
  syncFields(true);
  drawBar();
  draftChanged();
  kick();
}

/** After a reload (the agent's own edits cause many) the reviewer is still in canvas mode. */
function resumeCanvas() {
  let was = false;
  try {
    was = sessionStorage.getItem("b42-canvas") === "1";
  } catch {}
  if (was && !C.on && !S.card && !Notes.hasDraft()) setMode("canvas");
}

/** Review is switched off: text being edited in place is kept, a drag is dropped. */
function letGo() {
  endEdit(true);
  cancelDrag();
}

// ── what the rest of the overlay sees ───────────────────────────────────────────────────────
export {
  HTML as html,
  mountCanvas as mount, setOn, resumeCanvas as resume, letGo, syncUi, drawBar, cvFrame as frame,
  cvMove as pointerMove, cvUp as pointerUp, cancelDrag as pointerCancel, cvKey as key, zoneOf, closePop, select,
  draft, restoreEdits as restore, unsendCanvas as refuse, finish, dropFinished, showEdits, treeChanged, readPathsIfDue,
};
export const on = () => C.on;
/** A sent batch is switched off for the host's "before" picture: that counts as a capture. */
export const hiding = () => C.hide.size > 0;
export const pointerDown = (e, z) => pagePress(e) && cvDown(e, z); // after what notes mode does with a press too (input.js)
/** The event is inside the text being edited in place: the caret is the reviewer's there. */
export const inEdit = (e) => !!C.edit && inEditedText(e);
export const hasEdits = () => C.snap !== EMPTY;
export const hasSent = () => C.sent.length > 0;
export const dragging = () => !!C.drag;
/** Frames every display frame: a drag, text being edited in place, or a selection that is being
 *  animated. One that only sits there is drawn on the slow tick, and when something moves. */
export const busyFrames = () => C.on && S.enabled && !!(C.drag || C.edit || (C.sel && animating([C.sel])));
// (C.typeTimer: CSS or classes typed but not yet an undo step. Until that pause ends the batch
// still looks empty and the host has no draft of it: a reload then would lose what was typed.)
export const busy = () => !!(C.drag || C.edit || C.typeTimer || C.snap !== EMPTY || (C.on && C.sel));

