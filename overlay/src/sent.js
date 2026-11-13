import { CAPTURE_TIMEOUT_MS, S, send } from "./state.js";
import { line, pick } from "./page.js";
import { draftTimer, serializeDraft } from "./draft.js";
import * as Notes from "./notes/api.js";
import * as Canvas from "./canvas/api.js";
import * as Motion from "./motion/api.js";
import { modeOn } from "./mode.js";
import { kick, render } from "./render.js";
import { tip } from "./mount.js";

// ── pin tooltip ─────────────────────────────────────────────────────────────────────────────
const STATUS_WORDS = { queued: "Waiting", working: "Working", done: "Done", failed: "Failed", paused: "Paused (offline)", stopped: "Stopped" };

function showTip(el) {
  const p = el._pin;
  if (!p || !S.enabled || S.drag) return;
  const r = el.getBoundingClientRect();
  tip.replaceChildren();
  const state = document.createElement("div");
  state.className = `tip-state ${p.status || "queued"}`;
  state.textContent = `${p.n} · ${STATUS_WORDS[p.status] || "Waiting"}${p.lane === "bg" ? " · in parallel" : ""}`;
  tip.append(state);
  if (p.note) {
    const words = document.createElement("div");
    words.textContent = p.note;
    tip.append(words);
  }
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(8, top))}px)`;
}

export function hideTip() {
  if (tip && !tip.hidden) tip.hidden = true; // (writing `hidden` again restyles, even unchanged)
}

export function makePin() {
  const el = /** @type {any} */ (document.createElement("div")); // (it carries its pin, as _pin)
  el.addEventListener("mouseenter", () => showTip(el));
  el.addEventListener("mouseleave", hideTip);
  // Clicking a pin shows its note in the app's panel; it never starts a selection.
  el.addEventListener("click", () => el._pin && S.enabled && send({ type: "pin", id: el._pin.id }));
  return el;
}

// ── a note sent ─────────────────────────────────────────────────────────────────────────────
/** A note from any mode goes to the host; finishCapture or refuseCapture follows. */
export function dispatch(note) {
  // Hide the card (and, via S.pending, hover and pins) before the host takes its screenshot.
  Notes.closeCard();
  Notes.hideSent();
  hideTip();
  S.pending = note.id;
  clearTimeout(draftTimer);
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => send({ type: "note", note })));
  setTimeout(() => finishCapture(note.id), CAPTURE_TIMEOUT_MS);
}

/** The host did not take the note ("captured" with ok: false): it must not look sent. Nothing
 *  of a plain note was cleared yet (finishCapture does that), so its card opens again with
 *  the words in it; a canvas batch goes back to being the unsent one. */
export function refuseCapture(id, why) {
  if (!S.pending || S.pending !== id) return;
  S.pending = null;
  S.buffered = null;
  const say = `Not sent: ${typeof why === "string" && why.trim() ? line(why).slice(0, 80) : "the app did not take the note"}`;
  if (S.quiet === id) {
    S.quiet = null;
    if (!Motion.refuse(id, say)) Canvas.refuse(id, say);
  } else Notes.refuse(say);
  kick();
}

export function finishCapture(id) {
  if (!S.pending || S.pending !== id) return;
  S.pending = null;
  Canvas.finish();
  Motion.finish(id);
  if (S.quiet === id) S.quiet = null;
  else Notes.showSent(id);
  S.sel = [];
  Notes.finish();
  send({ type: "draft", draft: serializeDraft() });
  const b = S.buffered;
  S.buffered = null;
  const el = b && pick(b.x, b.y);
  if (el && modeOn() === "canvas") Canvas.select(el);
  else if (el) {
    S.sel = [el];
    Notes.openCard();
  }
  kick();
}

