// Motion mode, the stage ("Only this"): the open element alone, in the middle of the view and
// large enough to look at, and stepping from one thing that moves to the next.
//
// Alone is model.js's rule (everything else hidden). The stage adds, as rules in the same
// stylesheet (never inline styles):
//  - where and how large: a transform on the body, which leaves the page's layout as it is (its
//    line breaks, its media queries; `zoom` would lay it out again). The element is put in the
//    middle with the whole of its motion in view (its box at several frames of what is open), and
//    a small one is enlarged, a larger one than the view made smaller;
//  - what is behind it: the colour of what it lies on, whose own drawing is hidden with the rest
//    (white words on a dark section would be white on the page's white);
//  - no scrolling, which would take it out of the middle.
// A body with a transform is what its `position: fixed` elements are placed in, so the box is
// measured with a transform that moves nothing already on, and only then is the real one written.

import { BOOST } from "../page.js";
import { apply, clamp, M, mq } from "./model.js";
import { animOf, reveal } from "./open.js";
import { rowNow, rows } from "./edit.js";

/** How much of the view the motion may fill, how long the longer side of a small element is made
 *  (px), and how many times larger at most. */
const FILL = 0.8, WANT = 320, MAX = 4;
const SAMPLES = [0, 0.25, 0.5, 0.75, 0.99999];

/** The box of the element through the whole of what is open: where it is now and at several
 *  frames (the animation is put back where it was before anything is drawn). */
function bounds(el) {
  const rects = [el.getBoundingClientRect()];
  const o = M.open, a = o && o.kind !== "transition" ? animOf() : null;
  // (A script's animation that has ended is left alone: seeking it would end it once more, and
  // its script would hear that.)
  if (a && a.effect && a.currentTime !== null && (o.kind === "css" || a.playState === "running" || a.playState === "paused")) {
    const t = a.effect.getComputedTiming(), was = a.currentTime, dur = +t.duration || 0;
    try {
      for (const p of SAMPLES) {
        a.currentTime = t.delay + p * dur;
        rects.push(el.getBoundingClientRect());
      }
    } catch {}
    try {
      a.currentTime = was;
    } catch {}
  }
  const x = Math.min(...rects.map((r) => r.left)), y = Math.min(...rects.map((r) => r.top));
  return { x, y, w: Math.max(...rects.map((r) => r.right)) - x, h: Math.max(...rects.map((r) => r.bottom)) - y };
}
/** The colour the element lies on: its nearest parent's that has one of its own. "" when that is
 *  the page's own background (the body's and the root's stay as they are). */
function behind(el) {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const c = getComputedStyle(p).backgroundColor, m = /^rgba\(.*,\s*([\d.]+)\)$/.exec(c) || /\/\s*([\d.]+)\s*\)$/.exec(c);
    if ((m ? +m[1] : 1) >= 0.9) return c;
  }
  return "";
}
const rules = (transform, bg) =>
  `:root${BOOST} { overflow: hidden !important;${bg ? ` background: ${bg} !important;` : ""} }\n` +
  `body${BOOST} { transform: ${transform} !important; transform-origin: 0 0 !important; transition: none !important;${bg ? ` background: ${bg} !important;` : ""} }`;

let queued = 0, listening = false;
const again = () => {
  if (queued) return;
  queued = requestAnimationFrame(() => {
    queued = 0;
    restage();
  });
};
function listen(on) {
  if (on === listening) return;
  listening = on;
  const f = on ? "addEventListener" : "removeEventListener";
  window[f]("resize", again);
  document[f]("scroll", again, true);
}

/** The stage as it is to be now: set for the selected element while "Only this" is on, taken
 *  away otherwise. Called wherever one of those changed, and when the view was resized. */
export function restage() {
  const el = M.on && M.isolate && M.selRs ? (M.sel && M.sel.isConnected ? M.sel : mq(M.selRs)) : null;
  listen(!!el);
  if (!el || !document.body) {
    M.stageCss = "";
    return apply();
  }
  const bg = behind(el);
  M.stageCss = rules("translate(0px)", bg);
  apply();
  const r = bounds(el), b = document.body.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  if (r.w > 0 || r.h > 0) {
    const w = Math.max(r.w, 1), h = Math.max(r.h, 1);
    let s = Math.min((FILL * vw) / w, (FILL * vh) / h, clamp(WANT / Math.max(w, h), 1, MAX));
    s = Math.abs(s - 1) < 0.05 ? 1 : Math.round(s * 1000) / 1000;
    // A point p of the body (from its corner b) is drawn at b + s·(p − b) + t: t puts the middle
    // of the box in the middle of the view.
    const tx = Math.round(vw / 2 - b.left - s * (r.x + r.w / 2 - b.left)), ty = Math.round(vh / 2 - b.top - s * (r.y + r.h / 2 - b.top));
    M.stageCss = rules(`translate(${tx}px, ${ty}px) scale(${s})`, bg);
  }
  apply();
}

/** The next thing that moves (by 1) or the one before (−1), opened; round at the ends. Each
 *  element of keyframes several play is one stop (the row of their name is not: it opens the
 *  first of them); keyframes nothing plays are none (opening them puts them on an element). */
export function go(by) {
  const list = rows().filter((r) => !r.group && r.kind !== "unused" && r.kind !== "frames" && (r.sub || r.kind !== "css" || r.els.length === 1) && !rowNow(r).off);
  if (!list.length) return;
  const i = list.findIndex((r) => rowNow(r).on), n = list.length;
  list[i < 0 ? (by > 0 ? 0 : n - 1) : (i + (by > 0 ? 1 : -1) + n) % n].open();
  reveal(M.sel);
}
