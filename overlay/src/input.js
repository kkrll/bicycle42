import { mod, S, send } from "./state.js";
import * as Notes from "./notes/api.js";
import { hideTip } from "./sent.js";
import * as Canvas from "./canvas/api.js";
import * as Motion from "./motion/api.js";
import { current, setBrush, setMode } from "./mode.js";
import { kick } from "./render.js";
import { docHost, hostEl, pinsEl } from "./mount.js";

// ── input ───────────────────────────────────────────────────────────────────────────────────
export const isOurs = (e) => !!hostEl && e.composedPath().includes(hostEl);
export const block = (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
};

// ── the layer's own UI, kept from the page ──────────────────────────────────────────────────
// A press on the note card is, to the page, a press on <b42-review>: outside its dialog, which
// closes at it. So the page is not told of the pointer on the layer's own UI at all, or of focus in it. The event
// stops at the window, before any listener of the page's (a capturing one on the document too),
// and the layer's elements get a copy that does not leave the shadow root. What the browser
// does at the event itself (the caret, focus, a button's click) is not a listener and still
// happens; a copy cancelled by the layer cancels it.
export const OURS_ONLY = [
  "pointerdown", "pointerup", "pointercancel", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave",
  "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave",
  "click", "dblclick", "auxclick", "contextmenu",
  "focus", "blur", // (focusin and focusout have no listener in the layer: mount.js stops them, with no copy)
]; // prettier-ignore
export function oursOnly(e) {
  if (!isOurs(e)) return;
  e.stopImmediatePropagation();
  /** @type {any} */
  const init = {};
  for (const k in e) init[k] = e[k]; // (an event's fields are its prototype's: a spread has none of them)
  init.composed = false;
  const copy = new /** @type {any} */ (e.constructor)(e.type, init);
  if (!e.composedPath()[0].dispatchEvent(copy)) e.preventDefault();
}

// The other half: the pointer or focus leaving something of the page's for the layer. A field
// that lost focus to the note card, a menu the pointer left for it: the page would close or
// take focus back (a dialog's focus trap does), and the note would be about another state.
// (Coming back, the page is told as ever. Text edited in place is the layer's own business on
// the page's element: it ends at that blur.)
export const LEFT_FOR_US = ["focusout", "blur", "pointerout", "pointerleave", "mouseout", "mouseleave"];
export function leftForUs(e) {
  if (e.relatedTarget === hostEl && !isOurs(e) && !Canvas.inEdit(e)) e.stopImmediatePropagation();
}

// What every mode shares is here: the keys that switch review and canvas mode, what is ours, what
// is kept from the page. The rest goes to the handlers of the mode that is on (mode.js).

export function onPointerDown(e) {
  if (!S.enabled) return;
  if (S.peek) return block(e);
  const mode = /** @type {any} */ (current()); // (only canvas mode has a zoneOf)
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
  if (!S.enabled || S.peek) return; // the page's own hover, while the layer is out of sight
  current().pointerMove(e);
}

export function onPointerUp(e) {
  if (!S.enabled) return;
  if (S.peek) return block(e);
  current().pointerUp(e);
}

/** The browser took the pointer away (a system gesture, the window losing it): a canvas drag
 *  is undone, as Escape does, and a note's stroke, area or press is dropped. */
export function onPointerCancel(e) {
  if (!S.enabled) return;
  const mode = /** @type {any} */ (current()); // (motion mode has none: its release only blocks)
  if (mode.pointerCancel) mode.pointerCancel();
  else mode.pointerUp(e);
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

// ── the peek: alt+A held ────────────────────────────────────────────────────────────────────
// While alt+A is held the layer is out of sight and the page is shown as it is now, unsent edits
// included. Nothing else changes: not the mode, not the selection or the note, not the focus
// (the layer is made transparent, not hidden, so a focused field keeps its caret), and the host
// is not told. The pointer's hover reaches the page; a press does not, since it would be an
// alt+click there. By the key's place (KeyA), like the mode keys. (A, not a letter a menu of the
// app's window starts with: on Linux and Windows the menu bar may take alt+its letter.) Letting go of either key ends
// it, and so does the window losing focus, since then no keyup comes.
const isPeekKey = (e) => e.code === "KeyA" && e.altKey && !mod(e) && !e.shiftKey;

function startPeek() {
  // Not in the middle of a drag: what the drag draws would go on out of sight.
  if (S.peek || S.drag || Canvas.dragging() || Motion.busy()) return;
  S.peek = true;
  S.hover = null;
  hostEl.toggleAttribute("data-peek", true); // the layer's own elements let the pointer through (styles.css)
  hostEl.style.setProperty("opacity", "0", "important"); // (inline, over the element's all:initial)
  docHost.style.setProperty("opacity", "0", "important");
  hideTip();
}

export function endPeek() {
  if (!S.peek) return;
  S.peek = false;
  hostEl.toggleAttribute("data-peek", false);
  hostEl.style.removeProperty("opacity");
  docHost.style.removeProperty("opacity");
  kick();
}

export function onKeyUp(e) {
  if (!S.peek || (e.code !== "KeyA" && e.key !== "Alt")) return;
  block(e); // (an alt let go alone would otherwise show the window's menu bar on Linux and Windows)
  endPeek();
}

export function onKeyDown(e) {
  if (S.peek) return block(e); // nothing is typed or switched out of sight
  if (S.enabled && isPeekKey(e)) {
    block(e);
    if (!e.repeat) startPeek();
    return;
  }
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
  if (!on) endPeek();
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

