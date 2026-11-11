// ── mode ────────────────────────────────────────────────────────────────────────────────────
// Notes, canvas or motion: one at a time, and the brush only in notes mode. Switching from one
// to another is none of the modes' own business: it is here. (The bar tells the host the mode:
// Canvas.drawBar() calls tellMode.)
let modeTold; // "mode|brush" as the host last heard it; undefined until its first "state"

/** The brush belongs to notes mode: while it is on, a plain drag draws (what alt+drag always does). */
function setBrush(on) {
  if (S.brush === on) return;
  S.brush = on;
  Canvas.drawBar();
}

function setCanvas(on) {
  if (on === Canvas.on) return;
  if (on) MO.setOn(false);
  if (on) setBrush(false);
  Canvas.setOn(on);
}

/** The host has the mode switch and the brush: it is told whenever either changes here (a key,
 *  Esc, a note sent, a reload that comes back in edit mode). */
function tellMode() {
  const mode = Canvas.on ? "canvas" : MO.on ? "motion" : "notes", key = `${mode}|${S.brush}`;
  if (modeTold === undefined || key === modeTold) return; // nothing before the host's first "state"
  modeTold = key;
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
  Canvas.drawBar(); // says the mode, whichever it is now
  if (msg.brush === false) setBrush(false);
}

// motion.js still names canvas mode by what were loose names in the closure: `C.on` and
// `drawBar()` (to tell the host the mode). These two answer for Canvas until it asks Canvas.
const C = {
  get on() {
    return Canvas.on;
  },
};
const drawBar = () => Canvas.drawBar();
