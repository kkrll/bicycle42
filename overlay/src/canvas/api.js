// ── on and off ──────────────────────────────────────────────────────────────────────────────
function setCanvas(on) {
  if (on === C.on || !bar) return;
  if (on) MO.setOn(false);
  if (on) setBrush(false);
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

