import { mod, S, send } from "./state.js";
import * as Notes from "./notes/api.js";
import { hideTip } from "./sent.js";
import * as Canvas from "./canvas/api.js";
import * as Motion from "./motion/api.js";
import { current, setBrush, setMode } from "./mode.js";
import { kick } from "./render.js";
import { hostEl, pinsEl } from "./mount.js";

// ── input ───────────────────────────────────────────────────────────────────────────────────
export const isOurs = (e) => !!hostEl && e.composedPath().includes(hostEl);
export const block = (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
};
// What every mode shares is here: the keys that switch review and canvas mode, what is ours, what
// is kept from the page. The rest goes to the handlers of the mode that is on (mode.js).

export function onPointerDown(e) {
  if (!S.enabled) return;
  const mode = current();
  const zone = mode.zoneOf ? mode.zoneOf(e) : null; // a handle, an edge or a gap of the canvas selection: ours, but a page gesture
  if (isOurs(e) && !zone) return;
  mode.pointerDown(e, zone);
}

/** A press on the page in notes or canvas mode, before the mode's own part of it (their
 *  pointerDown calls this first). False when that is all there is to it. */
export function pagePress(e) {
  Canvas.closePop(); // a click on the page closes whichever list is open
  if (Canvas.inEdit(e)) {
    e.stopImmediatePropagation(); // the caret goes where it is clicked
    return false;
  }
  block(e);
  if (e.button !== 0) return false;
  if (S.pending) {
    // The host is still taking the previous note's screenshot: hold this click until it's done,
    // so the new outline can't land in that screenshot. (A drag started now is dropped.)
    S.buffered = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    return false;
  }
  return true;
}

export function onPointerMove(e) {
  if (!S.enabled) return;
  current().pointerMove(e);
}

export function onPointerUp(e) {
  if (!S.enabled) return;
  current().pointerUp(e);
}

export function blockIfActive(e) {
  if (!S.enabled || isOurs(e)) return;
  // While text is edited in place, the mouse works inside it (caret, selection); the page's own
  // handlers still see nothing, and a click still does nothing (no link is followed).
  if (Canvas.inEdit(e) && /^(mousedown|mouseup|selectstart|dblclick)$/.test(e.type)) e.stopImmediatePropagation();
  else block(e);
}

/** mod+U Preview (review off; pressed again, back to the mode it left), mod+P Annotate, mod+O Edit,
 *  mod+I Motion, mod+shift+P the brush. By the key's place, not its letter: the same keys on any
 *  layout, a Cyrillic one included. (Not mod+1…4: those are a browser's tabs.) */
const MODE_KEYS = { KeyU: "preview", KeyP: "notes", KeyO: "canvas", KeyI: "motion" };

/** The brush, as the host's pencil does it: on, it is notes mode with the brush; off, notes mode. */
function brushKey() {
  if (S.brush) return setBrush(false);
  setMode("notes");
  setBrush(true);
}

export function onKeyDown(e) {
  const want = !mod(e) || e.altKey ? undefined : e.shiftKey ? (e.code === "KeyP" ? "brush" : undefined) : MODE_KEYS[e.code];
  if (want) {
    block(e);
    if (want === "preview") return send({ type: "toggle" });
    if (S.enabled) return want === "brush" ? brushKey() : setMode(want);
    // Review is off: the host turns it on, and the mode follows once it has (setEnabled).
    S.modeAfter = want;
    return send({ type: "toggle", enabled: true });
  }
  if (!S.enabled) return;
  current().key(e);
}

export function setEnabled(on) {
  S.enabled = on;
  if (on && S.modeAfter) S.modeAfter === "brush" ? brushKey() : setMode(S.modeAfter);
  S.modeAfter = null;
  document.documentElement.toggleAttribute("data-b42-review", on);
  pinsEl.classList.toggle("live", on);
  Notes.syncUi();
  if (!on) {
    S.hover = null;
    S.drag = null;
    hideTip();
    Canvas.letGo();
    setBrush(false);
    Motion.letGo(); // the page is used as it is: nothing stays stopped at a frame
  }
  Canvas.syncUi();
  Motion.syncUi();
  kick();
}

export function setPins(pins) {
  const old = new Map(S.pins.map((p) => [p.id, p]));
  S.pins = (pins || []).map((p) => ({ ...p, el: old.get(p.id)?.el }));
  if (Canvas.hasSent()) Canvas.dropFinished();
  if (Motion.hasSent()) Motion.dropFinished();
  kick();
}

