// ── input ───────────────────────────────────────────────────────────────────────────────────
const isOurs = (e) => !!hostEl && e.composedPath().includes(hostEl);
const block = (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
};
// What every mode shares is here: the keys that switch review and canvas mode, what is ours, what
// is kept from the page. The rest goes to the handlers of the mode that is on (mode.js).

function onPointerDown(e) {
  if (!S.enabled) return;
  const mode = current();
  const zone = mode.zoneOf ? mode.zoneOf(e) : null; // a handle, an edge or a gap of the canvas selection: ours, but a page gesture
  if (isOurs(e) && !zone) return;
  mode.pointerDown(e, zone);
}

/** A press on the page in notes or canvas mode, before the mode's own part of it (their
 *  pointerDown calls this first). False when that is all there is to it. */
function pagePress(e) {
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

function onPointerMove(e) {
  if (!S.enabled) return;
  current().pointerMove(e);
}

function onPointerUp(e) {
  if (!S.enabled) return;
  current().pointerUp(e);
}

function blockIfActive(e) {
  if (!S.enabled || isOurs(e)) return;
  // While text is edited in place, the mouse works inside it (caret, selection); the page's own
  // handlers still see nothing, and a click still does nothing (no link is followed).
  if (Canvas.inEdit(e) && /^(mousedown|mouseup|selectstart|dblclick)$/.test(e.type)) e.stopImmediatePropagation();
  else block(e);
}

function onKeyDown(e) {
  if (mod(e) && e.shiftKey && e.code === "KeyM") {
    block(e);
    send({ type: "toggle" });
    return;
  }
  if (!S.enabled) return;
  if (mod(e) && !e.shiftKey && !e.altKey && e.code === "KeyE") {
    block(e);
    setMode(modeOn() === "canvas" ? "notes" : "canvas");
    return;
  }
  current().key(e);
}

function setEnabled(on) {
  S.enabled = on;
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

function setPins(pins) {
  const old = new Map(S.pins.map((p) => [p.id, p]));
  S.pins = (pins || []).map((p) => ({ ...p, el: old.get(p.id)?.el }));
  if (Canvas.hasSent()) Canvas.dropFinished();
  if (Motion.hasSent()) Motion.dropFinished();
  kick();
}

