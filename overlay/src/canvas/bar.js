import { isMac } from "../state.js";
import { keyNodes } from "../ui.js";
import { C } from "./state.js";
import { countEdits } from "./batch.js";
import { bar, corner } from "./mount.js";
import { notesKeys } from "./help.js";
import { tellMode } from "../mode.js";
import { hosted } from "../panel.js";
import { kick } from "../render.js";

// ── what the batch's footer says, and notes mode's chip ─────────────────────────────────────
// The host's inspector has the footer: how many edits, undo, redo, Reset, the note and Send, and
// a line for what could not be done (C.msg, for a moment) or what happened to the note sent last.
// The view says all of it (host.js), so a change of any of it is a frame for the view.
// On the page, in notes mode only: the chip that says edits were left unsent (a click goes back
// to edit mode, where they can be sent), and the "?" in the corner with notes mode's keys.
export function flash(text) {
  C.msg = text;
  drawBar();
  clearTimeout(C.msgTimer);
  C.msgTimer = setTimeout(() => {
    C.msg = "";
    drawBar();
  }, 2600);
}

/** Any change of state takes a refusal off the footer: it must never describe something older. */
export function hush() {
  if (!C.msg) return;
  C.msg = "";
  clearTimeout(C.msgTimer);
  drawBar();
}

/** What the footer says about the batch sent last, while the agent has it. */
export function sentStatus() {
  const b = C.sent[C.sent.length - 1];
  return b ? `Sent · preview stays until ${typeof b.n === "number" ? `note ${b.n}` : "the note"} is done` : "";
}

export function drawBar() {
  if (!bar) return;
  if (hosted("canvas")) kick(); // the host's footer: the view says what changed
  tellMode();
  const B = C.draft.B;
  const n = countEdits(B) + (B.sheet.trim() ? 1 : 0);
  const key = `${C.on}|${n}|${C.pop}`;
  if (key === bar._key) return;
  bar._key = key;
  bar.classList.toggle("idle", C.on || !n);
  bar.querySelector(".cn").textContent = `${n} unsent edit${n === 1 ? "" : "s"}`;
  corner.querySelector(".help").classList.toggle("on", C.pop === "help");
}

// ── notes mode's keys, over the "?" ─────────────────────────────────────────────────────────
export function setPop(which) {
  C.pop = which === C.pop ? "" : which;
  drawPop();
  drawBar();
}

/** Closes the keys list; false when it was not open. */
export function closePop() {
  if (!C.pop) return false;
  setPop(C.pop);
  return true;
}

function drawPop() {
  const pop = corner.querySelector(".pop");
  pop.hidden = C.pop !== "help";
  if (pop.hidden) return;
  pop.replaceChildren(...notesKeys(isMac).map(([k, v]) => {
    const row = document.createElement("div");
    row.className = "hrow";
    const hk = document.createElement("span"), hv = document.createElement("span");
    hk.className = "hk";
    hv.className = "hv";
    hk.append(keyNodes(k));
    hv.append(keyNodes(v));
    row.append(hk, hv);
    return row;
  }));
}
