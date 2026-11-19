// Motion mode, input: the page's pointer and the keys pressed while the page has the keyboard.
// (The dock is the host's: its pointer, fields and keys are the host's own, and come here as
// acts, host.js.)

import { mod, S } from "../state.js";
import { pick } from "../page.js";
import { M, openKf } from "./model.js";
import { position, seek, selectEl, toggle } from "./open.js";
import { removeKey, travel } from "./edit.js";
import { submit } from "./send.js";
import { hostListen } from "./host.js";
import { draw } from "./draw.js";
import { setMode } from "../mode.js";
import { block, isOurs } from "../input.js";
import { kick } from "../render.js";
import { root } from "../mount.js";

// The tag that names the open element on the page, found by mount(): declared here, where it is
// assigned.
export let tagEl = null;

// ── the page's pointer ───────────────────────────────────────────────────────────────────
export function pointerDown(e) {
  if (S.pending) return block(e); // the screenshot is being taken: nothing new until it is
  block(e);
  if (e.button !== 0) return;
  const el = pick(e.clientX, e.clientY);
  if (root.activeElement && root.activeElement.blur) root.activeElement.blur();
  selectEl(el);
}
/** A press let go on the page is kept from it, as the press was. */
export function pointerUp(e) {
  if (!isOurs(e)) block(e);
}
export function pointerMove(e) {
  if (isOurs(e)) {
    if (M.hover) {
      M.hover = null;
      kick();
    }
    return;
  }
  const next = pick(e.clientX, e.clientY);
  if (next !== M.hover) {
    M.hover = next;
    kick();
  }
}

/** Keys while motion mode is on and the page has the keyboard: what the host's dock does with
 *  its own (space plays, ←/→ step, Delete, mod+Z, Enter sends, Esc steps back). */
export function key(e) {
  if (mod(e) && e.key.toLowerCase() === "z") {
    block(e);
    return e.shiftKey ? travel(M.future, M.past) : travel(M.past, M.future);
  }
  if (mod(e) || e.altKey && e.key !== "Enter") return;
  if (e.key === " ") {
    block(e);
    toggle();
    return draw();
  }
  if (e.key === "Enter" && !e.isComposing) {
    block(e);
    return submit(e.altKey);
  }
  if ((e.key === "Delete" || e.key === "Backspace") && M.key && openKf()) {
    block(e);
    return removeKey();
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (!M.open) return;
    block(e);
    return seek((position() ?? M.pos) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01));
  }
  if (e.key === "Escape") {
    block(e);
    if (M.key) {
      M.key = null;
      draw();
    } else if (M.open || M.sel) selectEl(null);
    else setMode("notes");
  }
}

// ── mount ────────────────────────────────────────────────────────────────────────────────
export function mount() {
  tagEl = root.querySelector(".m-tag");
  hostListen(); // the host's dock, when the host draws it
}
