// ── mode ────────────────────────────────────────────────────────────────────────────────────
/** The brush belongs to notes mode: while it is on, a plain drag draws (what alt+drag always does). */
function setBrush(on) {
  if (S.brush === on) return;
  S.brush = on;
  drawBar();
}

/** The host has the mode switch and the brush: it is told whenever either changes here (a key,
 *  Esc, a note sent, a reload that comes back in edit mode). */
function tellMode() {
  const mode = C.on ? "canvas" : MO.on ? "motion" : "notes", key = `${mode}|${S.brush}`;
  if (C.told === undefined || key === C.told) return; // nothing before the host's first "state"
  C.told = key;
  send({ type: "mode", mode, brush: !!S.brush });
}

/** From the host's switch. The brush belongs to notes mode: switching it on leaves edit mode. */
function hostMode(msg) {
  if (msg.brush === true) {
    setCanvas(false);
    MO.setOn(false);
    return setBrush(true);
  }
  if (msg.mode === "motion") MO.setOn(true);
  else if (msg.mode === "canvas" || msg.mode === "notes") {
    MO.setOn(false);
    setCanvas(msg.mode === "canvas");
  }
  drawBar(); // says the mode, whichever it is now
  if (msg.brush === false) setBrush(false);
}

