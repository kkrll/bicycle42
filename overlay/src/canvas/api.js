// ── on and off ──────────────────────────────────────────────────────────────────────────────
/** Canvas mode's own part of switching it on or off. The switch is setCanvas (mode.js): it
 *  turns the other modes off first. */
function setOn(on) {
  if (on === C.on || !bar) return;
  hush();
  if (C.pop) setPop(C.pop);
  if (on) {
    // A note in progress becomes the start of the canvas session: its element is selected and
    // its words move to the bar's note field. (A drawing or an area has no place here.)
    const el = S.sel.length === 1 ? S.sel[0] : null;
    const words = textarea.value.trim();
    if (S.card || hasDraft()) clearDraft();
    hideSent();
    if (words && !cnote.value) cnote.value = words;
    C.on = true;
    select(el && el.isConnected ? el : null);
  } else {
    endEdit(true);
    cancelDrag();
    if (C.typeTimer) commit();
    select(null);
    C.on = false;
    C.hover = null;
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
  if (was && !C.on && !S.card && !hasDraft()) setCanvas(true);
}

/** Review is switched off: text being edited in place is kept, a drag is dropped. */
function letGo() {
  endEdit(true);
  cancelDrag();
}

// ── what the rest of the overlay sees ───────────────────────────────────────────────────────
const api = {
  get on() {
    return C.on;
  },
  /** A sent batch is switched off for the host's "before" picture: that counts as a capture. */
  get hiding() {
    return C.hide.size > 0;
  },
  html: HTML,
  mount: mountCanvas, setOn, resume: resumeCanvas, letGo, syncUi, drawBar, frame: cvFrame,
  pointerDown: cvDown, pointerMove: cvMove, pointerUp: cvUp, key: cvKey, zoneOf, closePop, select,
  draft, restore: restoreEdits, refuse: unsendCanvas, finish, dropFinished, showEdits, treeChanged, readPathsIfDue,
  /** The event is inside the text being edited in place: the caret is the reviewer's there. */
  inEdit: (e) => !!C.edit && inEdit(e),
  hasEdits: () => C.snap !== EMPTY,
  hasSent: () => C.sent.length > 0,
  busyFrames: () => C.on && (C.sel || C.drag || C.edit),
  // (C.typeTimer: CSS or classes typed but not yet an undo step. Until that pause ends the batch
  // still looks empty and the host has no draft of it: a reload then would lose what was typed.)
  busy: () => !!(C.drag || C.edit || C.typeTimer || C.snap !== EMPTY || (C.on && C.sel)),
};

