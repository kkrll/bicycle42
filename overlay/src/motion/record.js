// Motion mode, the recorder: what a script does to start the open transition. While it is on the
// reviewer uses the page as it is (the pointer and the keys reach it: input.js asks `recording`),
// and what changes on the element and its parents is noted: a class that came or went, an
// attribute that says something else, a style written by hand. A transition that runs on the
// element then was started by one of the changes just before it.
//
// Which one is not guessed from the time alone. Once recording ends, each is tried, as a named
// trigger is (open.js): the one that changes what ran is it. It becomes a trigger of the element
// (trigger.js), that can be played, undone and sent as one the reviewer typed.

import { M, pathOf } from "./model.js";
import { commit } from "./edit.js";
import { addRecorded, letGo, openEl } from "./open.js";
import { draw, flash } from "./draw.js";
import { restage } from "./stage.js";
import { stateful } from "./trigger.js";

/** How long before a transition the change that started it may have been (ms): the styles are
 *  worked out in the frame after it, and a busy page's frame is long. */
const JUST = 250;
/** Runs kept, and the changes before one (a page that writes a class every frame makes many). */
const MAX_RUNS = 40, MAX_NEAR = 40;

export const recording = () => !!M.rec;

export function record(on) {
  if (!on) return stop();
  const o = M.open, el = openEl();
  if (M.rec || !o || o.kind !== "transition" || !M.ro || !el) return;
  // The page is used as it is: no state of ours is on it, nothing is hidden, nothing is outlined.
  const was = M.ro.on;
  letGo();
  M.hover = null;
  if (M.isolate) {
    M.isolate = false;
    restage();
  }
  const rec = { rs: o.rs, el, changes: /** @type {any[]} */ ([]), from: was ? performance.now() + 60 : 0, runs: /** @type {any[]} */ ([]), off: () => {} };
  const obs = new MutationObserver((list) => {
    const at = performance.now();
    for (const m of list) note(rec, m, at);
  });
  for (let p = el; p; p = p.parentElement) obs.observe(p, { attributes: true, attributeOldValue: true });
  // (On the window, before any listener of the page's can stop it; only the element's own.)
  const ran = (e) => {
    const at = performance.now();
    // (What ran back as our own state went off is not the page's doing.)
    if (e.target !== el || e.pseudoElement || at < rec.from || rec.runs.length >= MAX_RUNS) return;
    for (const m of obs.takeRecords()) note(rec, m, at);
    const a = el.getAnimations().find((x) => x instanceof CSSTransition && x.transitionProperty === e.propertyName);
    const kf = a && /** @type {any} */ (a.effect).getKeyframes();
    // Nearest first.
    rec.runs.push({ at, prop: e.propertyName, kf, near: rec.changes.filter((c) => c.at >= at - JUST).slice(-MAX_NEAR).reverse() });
  };
  window.addEventListener("transitionrun", ran, true);
  document.documentElement.toggleAttribute("data-b42-using", true);
  rec.off = () => {
    obs.disconnect();
    window.removeEventListener("transitionrun", ran, true);
    document.documentElement.toggleAttribute("data-b42-using", false);
  };
  M.rec = rec;
  draw();
}

/** One change, as the triggers it could be. */
function note(rec, m, at) {
  const t = m.target, name = m.attributeName, was = m.oldValue, now = t.getAttribute(name);
  if (was === now) return;
  if (rec.changes.length > 4 * MAX_NEAR) rec.changes.splice(0, 2 * MAX_NEAR);
  const on = t === rec.el ? "" : pathOf(t);
  const put = (x) => rec.changes.push({ at, on, ...x });
  if (name === "class") {
    const a = new Set((was || "").split(/\s+/)), b = new Set((now || "").split(/\s+/));
    for (const c of new Set([...a, ...b])) if (c && a.has(c) !== b.has(c)) put({ kind: "class", name: c });
  } else if (name === "style") put({ kind: "style", name: "style" });
  else if (stateful(name)) put({ kind: "attr", name, value: now ?? was, alt: now === null ? null : was });
}

/** Recording ends with nothing made of it: the element was left, or the mode. */
export function forgetRecording() {
  if (!M.rec) return;
  M.rec.off();
  M.rec = null;
}
function stop() {
  const rec = M.rec;
  if (!rec) return;
  forgetRecording();
  if (!rec.el.isConnected || !M.open || M.open.rs !== rec.rs) return flash("The element is not on the page any more: nothing was recorded");
  if (!rec.runs.length) return flash("This transition did not run while recording");
  const found = new Set();
  let unsaid = false;
  // (The last first: where its values ended is where the page is now.)
  for (const runs of grouped(rec.runs).reverse().slice(0, 6)) {
    const label = addRecorded(runs[0].near, runs);
    if (label) found.add(label);
    else unsaid = true;
  }
  if (!found.size) draw();
  else {
    commit();
    flash(`Recorded ${[...found].join(", ")}`);
  }
  if (unsaid && !found.size) flash("It ran, but no class, attribute or style of it or its parents started it: the pointer or the keyboard may have. Add it as a trigger");
}
/** The runs that started together (a frame's), each a list. */
function grouped(runs) {
  const out = [];
  for (const r of runs) {
    const g = out[out.length - 1];
    if (g && r.at - g[0].at < 30) g.push(r);
    else out.push([r]);
  }
  return out;
}
