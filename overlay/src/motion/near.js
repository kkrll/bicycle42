// Motion mode, what is in view: the list of what moves starts with what the reviewer is looking
// at, and this says which elements those are.
//
// An element is measured (its box, nothing else of it) when the list is first made with it, and
// is then taken to be where it was: a list made again for an edit, or while something plays in and
// out of the view, keeps its order under the reviewer's hand. All are measured again:
//  - once the reviewer has scrolled, or the view was resized (after it is over, never per frame);
//  - with nothing open, also when the page was looked at again, or was scrolled by opening a row
//    (reveal): while the reviewer steps through the list, the list itself stays.
// On the stage ("Only this") the page is moved and everything else hidden: where things are says
// nothing then, and the order stays until the stage is left.

import { M } from "./model.js";
import { drawList } from "./draw.js";

/** The element's box was in the view when it was measured. */
let seen = new WeakMap();
let timer = 0, from = 0, revealed = -1e9, listening = false;
/** How long without a scroll is the end of one (ms). */
const STILL = 180;

const staged = () => M.isolate && !!M.selRs;
/** All are to be measured again, now (M.nearDue). */
export const nearDue = () => !!M.nearDue && !staged() && (M.nearDue === 2 || !M.open);
const nearOld = (level) => (M.nearDue = Math.max(M.nearDue, level));
/** The page is about to be scrolled to what was opened: that scroll is not the reviewer's. */
export const revealing = () => (revealed = performance.now());
/** Asked of every element of a list that is being put in order, before `near`. */
export function nearAgain() {
  if (!nearDue()) return;
  seen = new WeakMap();
  M.nearDue = 0;
}
export function near(el) {
  if (seen.has(el)) return seen.get(el);
  if (staged()) return nearOld(1), false;
  const r = el.getBoundingClientRect();
  const is = (r.width > 0 || r.height > 0) && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  seen.set(el, is);
  return is;
}

function moved(e) {
  // Something small that scrolls (a strip of pictures, which may scroll by itself) is not the page.
  const t = e.target;
  if (e.type === "scroll" && t instanceof Element && t.clientWidth * t.clientHeight * 2 < window.innerWidth * window.innerHeight) return;
  if (!timer) from = performance.now();
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    nearOld(e.type === "scroll" && revealed > from - 300 ? 1 : 2);
    drawList();
  }, STILL);
}
/** Motion mode was switched on or off. */
export function watchNear(on) {
  if (on === listening) return;
  listening = on;
  const f = on ? "addEventListener" : "removeEventListener";
  document[f]("scroll", moved, { capture: true, passive: true });
  window[f]("resize", moved);
  clearTimeout(timer);
  timer = M.nearDue = 0;
  seen = new WeakMap();
}
