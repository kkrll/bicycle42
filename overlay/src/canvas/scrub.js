import { C } from "./state.js";
import { commit } from "./batch.js";
import { applyAll } from "./apply.js";
import { liveValue, syncFields, unmarkValue } from "./inspector.js";
import { numberAt, step } from "./number.js";

// ── scrubbing: a drag on a computed row's name changes the value's number ───────────────────
// One unit a pixel (shift: ten, alt: a tenth). Under three pixels it is still a click, which
// copies the line as it always did. The whole drag is one undo step; Esc puts the value back.
const SLOP = 3;
/** The drag: { btn, row, id, x, last, acc, on, text, token } (on: past the first three pixels). */
let D = null;

const firstNumber = (text) => numberAt(text || "", 0, { first: true });

/** Make the name of a computed row a handle for its value. */
export function scrubbable(btn) {
  btn.addEventListener("pointerdown", (e) => {
    btn._scrubbed = false;
    const row = btn.parentElement;
    if (e.button !== 0 || !C.sel || !firstNumber(row._v)) return; // (no number: nothing to scrub)
    btn.setPointerCapture(e.pointerId);
    D = { btn, row, id: e.pointerId, x: e.clientX, last: e.clientX, acc: 0, on: false, text: "", token: null };
  });
  btn.addEventListener("pointermove", (e) => {
    const d = D;
    if (!d || d.btn !== btn || e.pointerId !== d.id) return;
    if (!d.on) {
      if (Math.abs(e.clientX - d.x) < SLOP) return;
      if (C.typeTimer) commit(); // what was typed before is a step of its own
      d.text = d.row._v; // (read now: the press may have blurred a field, which wrote its value)
      d.token = firstNumber(d.text);
      if (!d.token || !C.sel) return void end();
      d.on = true;
      btn.style.cursor = "ew-resize"; // the pointer is captured, so this is the cursor wherever it goes
    }
    d.acc += (e.clientX - d.last) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    d.last = e.clientX;
    liveValue(d.row.lastChild, d.text.slice(0, d.token.start) + step(d.token, d.acc) + d.text.slice(d.token.end), true);
  });
  const up = () => {
    const d = D;
    if (!d || d.btn !== btn) return;
    end();
    if (!d.on) return; // a click: it copies the line
    settle(d);
    commit();
  };
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  // The click that ends a drag is not a click on the name. (On the button itself, so before the
  // list's own listener for it.)
  btn.addEventListener("click", (e) => {
    if (btn._scrubbed) e.stopPropagation();
    btn._scrubbed = false;
  });
}

function end() {
  const d = D;
  D = null;
  d.btn.style.cursor = "";
  d.btn._scrubbed = d.on;
  if (d.btn.hasPointerCapture(d.id)) d.btn.releasePointerCapture(d.id);
}

/** The field shows what the page has again (a value the browser refused was never written). */
function settle(d) {
  const field = d.row.lastChild;
  if (d.row._bad) field.value = d.row._v;
  unmarkValue(d.row);
  C.compKey = "";
}

/** Esc during a drag: the value from before it. False when no drag is under way. */
export function cancelScrub() {
  const d = D;
  if (!d || !d.on) return false;
  end();
  C.draft.B = JSON.parse(C.snap); // nothing was committed since the drag began
  applyAll();
  d.row._bad = false;
  d.row.lastChild.classList.remove("bad");
  d.row.lastChild.value = d.row.lastChild.title = d.row._v = d.text;
  syncFields(true);
  return true;
}
