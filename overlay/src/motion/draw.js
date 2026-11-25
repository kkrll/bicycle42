// Motion mode, the mode and what is drawn: switched on and off, the dock (the host's: host.js)
// told what to show, and every frame the playhead's clock, the tag and the outlines on the page.

import { S } from "../state.js";
import { rectOf } from "../page.js";
import { hostFrame, hostSync, wantView } from "./host.js";
import * as Notes from "../notes/api.js";
import * as Canvas from "../canvas/api.js";
import { apply, forget, M, mq, name, scan } from "./model.js";
import { animOf, letGo, running, selectEl, show } from "./open.js";
import { snapshot } from "./edit.js";
import { tagEl } from "./input.js";
import { modeOn, setMode } from "../mode.js";
import { kick } from "../render.js";
import { restage } from "./stage.js";
import { watchNear } from "./near.js";

// ── mode ─────────────────────────────────────────────────────────────────────────────────
/** Motion mode's own part of switching it on or off. The switch is setMode (mode.js): it
 *  turns the other modes off first. */
export function setOn(on) {
  if (on === M.on || !tagEl) return;
  if (on) {
    M.on = true;
    // A note in progress becomes the start: its element is looked at.
    const el = S.sel.length === 1 ? S.sel[0] : null;
    if (S.card || Notes.hasDraft()) Notes.clearDraft();
    Notes.hideSent();
    S.hover = null;
    watchSuspects(true);
    watchNear(true);
    scan();
    M.snap = snapshot();
    if (el && el.isConnected) selectEl(el);
    else if (M.open && !mq(M.open.rs)) show(null);
    else draw();
  } else {
    letGo();
    M.isolate = false;
    restage();
    M.drag = null;
    M.hover = null;
    M.rowEls = null;
    watchSuspects(false);
    watchNear(false);
    M.on = false;
    forget();
    apply();
  }
  try {
    sessionStorage.setItem("b42-motion", on ? "1" : "");
  } catch {}
  syncUi();
  Canvas.drawBar(); // the host hears the mode
  kick();
}
/** After a reload (the agent's own edits cause many) the reviewer is still in motion mode. */
export function resume() {
  let was = false;
  try {
    was = sessionStorage.getItem("b42-motion") === "1";
  } catch {}
  if (was && modeOn() === "notes" && !S.card && !Notes.hasDraft()) setMode("motion");
}
/** The mode or review was switched, or the host's docks changed: the host's dock hears it. (The
 *  dock is the host's, beside the page: the page needs no room for it.) */
export const syncUi = () => hostSync();
/** What no stylesheet and no animation object accounts for: an inline style rewritten many
 *  times a second. It cannot be edited here, but the list can say it is there. Only while it is
 *  in the page: a toast a script slid in and took out again is no longer listed, and not kept
 *  (the count per element is the element's own, and goes with it). */
function watchSuspects(on) {
  if (M.obs) M.obs.disconnect();
  M.obs = null;
  if (!on || !document.body) return;
  const seen = new WeakMap();
  M.obs = new MutationObserver((list) => {
    const now = performance.now();
    let removed = false, changed = false;
    for (const m of list) {
      if (m.type === "childList") {
        if (m.removedNodes.length) removed = true;
        continue;
      }
      const c = seen.get(m.target) || seen.set(m.target, { n: 0, t: now }).get(m.target);
      if (now - c.t > 1000) (c.n = 0), (c.t = now);
      if (++c.n === 20 && !M.suspects.has(m.target)) {
        M.suspects.add(m.target);
        changed = true;
      }
    }
    // (After the counting: one moved and taken out in the same breath is not left in.)
    if (removed && M.suspects.size) for (const el of M.suspects) if (!el.isConnected) changed = M.suspects.delete(el) || changed;
    if (changed) {
      M.list = null;
      drawList();
    }
  });
  M.obs.observe(document.body, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────
// The dock is the host's (host.js): "drawn" is a view for it, once this task is done. A host
// that does not draw one gets none.
export function draw() {
  if (!tagEl || !M.on) return;
  wantView();
  kick();
}
export function drawList() {
  if (M.on) wantView();
}
/** What the line under the timeline says while the last animation sent is a preview. */
export function sentStatus() {
  const b = M.sent[M.sent.length - 1];
  return b ? `Sent · preview stays until ${b.n !== null ? `note ${b.n}` : "the note"} is done` : "";
}
/** The line under the timeline, the note and Send: in the view. */
export const drawFoot = () => wantView();
/** A message on the line under the timeline, for a moment. */
export function flash(text) {
  M.msg = text;
  drawFoot();
  clearTimeout(M.msgTimer);
  M.msgTimer = setTimeout(() => {
    M.msg = "";
    drawFoot();
  }, 2600);
}

// ── one frame ────────────────────────────────────────────────────────────────────────────
/** Every frame: Loop's repeat, the playhead's clock for the host's dock, the tag and the
 *  outlines on the page. */
export function frame(capturing) {
  if (!tagEl) return null;
  const on = M.on && S.enabled && !capturing;
  // (Nothing is written that is already so: an idle layer changes nothing, frame after frame.)
  const hide = (el, h) => el.hidden !== h && (el.hidden = h);
  if (!on) {
    hide(tagEl, true);
    return null;
  }
  // repeat, while Loop is on
  const a = M.open && M.open.kind !== "transition" ? animOf() : null;
  if (a && M.loop && a.playState === "finished") {
    const now = performance.now();
    if (!M.loopAt) M.loopAt = now + 400;
    else if (now > M.loopAt) {
      M.loopAt = 0;
      a.currentTime = 0;
      a.play();
    }
  }
  const run = running();
  hostFrame();
  // outlines: the element under the pointer, the list row's elements, the open one
  const out = [];
  if (M.hover && M.hover !== M.sel && M.hover.isConnected) out.push([rectOf(M.hover), "hover"]);
  // (On the stage the others are hidden: no outline of what is not there to see.)
  if (!(M.isolate && M.sel)) for (const el of M.rowEls || []) if (el !== M.sel && el.isConnected) out.push([rectOf(el), "mrow"]);
  const sel = M.sel;
  if (sel && sel.isConnected) {
    const r = rectOf(sel);
    // While it plays, only its corners: the motion is not covered.
    out.push([{ x: Math.round(r.x - 3), y: Math.round(r.y - 3), w: Math.round(r.w + 6), h: Math.round(r.h + 6) }, `${run ? "mcorn" : "csel"}${performance.now() < M.findUntil ? " mfind" : ""}`]);
    const text = name(sel);
    if (tagEl._t !== text) tagEl.textContent = tagEl._t = text;
    hide(tagEl, false);
    const y = r.y - 3 - 20 >= 0 ? r.y - 3 - 20 : r.y + r.h + 5;
    const at = `${Math.max(0, Math.round(r.x - 3))}|${Math.round(y)}`;
    if (tagEl._at !== at) {
      tagEl._at = at;
      tagEl.style.transform = `translate(${Math.max(0, Math.round(r.x - 3))}px, ${Math.round(y)}px)`;
    }
  } else hide(tagEl, true);
  return out;
}
/** More frames are needed: something plays, is dragged, or a ring is going out. */
export const busyFrames = () => M.on && S.enabled && (running() || !!M.drag || performance.now() < M.findUntil || !!(M.ro && M.ro.on));
