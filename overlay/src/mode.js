// ── mode ────────────────────────────────────────────────────────────────────────────────────
// Notes, canvas or motion: one at a time, and the brush only in notes mode. Switching from one
// to another is none of the modes' own business: it is here. (The bar tells the host the mode:
// Canvas.drawBar() calls tellMode.)
let modeTold; // "mode|brush" as the host last heard it; undefined until its first "state"

/** The three modes, each with the same few handlers for the page's pointer and keys (input.js):
 *  pointerDown(e, zone), pointerMove(e), pointerUp(e), key(e); canvas mode also has zoneOf(e).
 *  Canvas and motion mode are switched with setOn; notes mode is what is on when neither is.
 *  A frame and busy() are not routed: canvas mode's bar and unsent batch outlive canvas mode
 *  (notes mode shows them too), so each module draws itself, and says it is busy, whatever is on.
 *  (Notes mode's frame is its ink, its card and the hover; whether it is busy is read in mount.js.) */
const MODES = { notes: Notes, canvas: Canvas, motion: Motion };

/** Which mode is on. Canvas and motion mode each say so of themselves while they switch (the
 *  host is told the mode from inside their setOn), so it is read from them, here and nowhere else. */
const modeOn = () => (Canvas.on ? "canvas" : Motion.on ? "motion" : "notes");
const current = () => MODES[modeOn()];

/** The one switch: the mode that is on goes off, then the brush (it belongs to notes mode), then
 *  the new one comes on. */
function setMode(name) {
  const was = modeOn();
  if (name === was) return;
  if (was !== "notes") MODES[was].setOn(false);
  if (name === "notes") return;
  setBrush(false);
  MODES[name].setOn(true);
}

/** The brush belongs to notes mode: while it is on, a plain drag draws (what alt+drag always does). */
function setBrush(on) {
  if (S.brush === on) return;
  S.brush = on;
  Canvas.drawBar();
}

/** The host has the mode switch and the brush: it is told whenever either changes here (a key,
 *  Esc, a note sent, a reload that comes back in edit mode). */
function tellMode() {
  const mode = modeOn(), key = `${mode}|${S.brush}`;
  if (modeTold === undefined || key === modeTold) return; // nothing before the host's first "state"
  modeTold = key;
  send({ type: "mode", mode, brush: !!S.brush });
}

/** From the host's switch. The brush belongs to notes mode: switching it on leaves edit mode. */
function hostMode(msg) {
  if (msg.brush === true) {
    setMode("notes");
    return setBrush(true);
  }
  if (msg.mode === "notes" || msg.mode === "canvas" || msg.mode === "motion") setMode(msg.mode);
  Canvas.drawBar(); // says the mode, whichever it is now
  if (msg.brush === false) setBrush(false);
}
