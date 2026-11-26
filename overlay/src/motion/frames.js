// Motion mode, what a script moves frame by frame: an element whose inline style is written again
// on every frame. No rule and no animation object says how it moves, so nothing of it can be
// edited here; what can be said is what was seen of it: the properties that change, from where
// to where, and how long one round of it takes when it comes round again. It is watched while it
// is open, on the page's own frames, and only its inline style is read (never a computed one:
// the browser has nothing to work out for it). What was seen is kept as words in M.ro.seen, so a
// view reads nothing of the page.

import { S } from "../state.js";
import { M, pathOf } from "./model.js";
import { setSel, show } from "./open.js";
import { draw } from "./draw.js";
import { watchCanvas } from "./drawn.js";

/** How long it is watched before something is said, and at most (ms): a slow round is seen only
 *  by watching longer, and what was seen so far is said each time the first has passed. */
const FIRST = 1000, MOST = 10000;
const MAX_PROPS = 12, MAX_RANGE = 160, MAX_VALUES = 4;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const short = (s) => (s.length > MAX_RANGE ? `${s.slice(0, MAX_RANGE - 1)}…` : s);
const r2 = (n) => Math.round(n * 100) / 100;

/** What is being watched: the element, the M.ro it is watched for, when each frame was and what
 *  each inline property was then ("" where it was not set). Dropped once it is over. */
let run = null;

export function openFrames(el) {
  setSel(el);
  M.ro = { frames: [], seen: null };
  show({ kind: "frames", rs: pathOf(el), name: "per frame" });
  watch();
}
/** Watch what is open from now on: when it is opened, and when the reviewer asks again (what it
 *  does may have been done to it only then: a scroll, the pointer). */
export function watch() {
  if (!M.open || M.open.kind !== "frames" || !M.sel) return;
  if (M.ro && M.ro.canvas) return watchCanvas();
  const mine = (run = { el: M.sel, ro: M.ro, t: [], vals: new Map(), told: 0 });
  mine.ro.seen = { props: [], cycle: null, over: 0, watching: true };
  draw();
  const step = (now) => {
    // Another is watched, or what was open is left: nothing is read for it any more.
    if (run !== mine) return;
    if (M.ro !== mine.ro || !M.on || !S.enabled || !mine.el.isConnected) {
      run = null;
      mine.ro.seen = { ...mine.ro.seen, watching: false };
      return;
    }
    record(mine, now);
    const over = now - mine.t[0];
    if (over < (mine.told + 1) * FIRST) return requestAnimationFrame(step);
    mine.told = Math.floor(over / FIRST);
    const seen = sum(mine);
    if (seen.cycle !== null || over >= MOST) {
      seen.watching = false;
      run = null;
    } else requestAnimationFrame(step);
    mine.ro.seen = seen;
    draw();
  };
  requestAnimationFrame(step);
}
/** What was seen until now (a note may be sent before anything was said). */
export function seenNow() {
  if (run && run.ro === M.ro && run.t.length > 1) M.ro.seen = sum(run);
  return M.ro && M.ro.seen;
}
function record(w, now) {
  const st = w.el.style, n = w.t.length;
  w.t.push(now);
  for (let i = 0; i < st.length; i++) {
    const p = st[i];
    (w.vals.get(p) || w.vals.set(p, Array(n).fill("")).get(p)).push(st.getPropertyValue(p));
  }
  for (const list of w.vals.values()) if (list.length === n) list.push("");
}

// ── in words ─────────────────────────────────────────────────────────────────────────────
function sum(w) {
  const props = [], rounds = /** @type {number[]} */ ([]); // one for each number that changed, 0 when it was not seen to come round
  for (const [prop, list] of w.vals) {
    if (props.length === MAX_PROPS) break;
    const said = list.filter(Boolean), first = said[0];
    if (!said.some((v) => v !== first) && said.length === list.length) continue; // it did not change
    // The same words with other numbers in them ("translateX(3px)", "translateX(9px)"): the
    // numbers that changed are from the least to the most that was seen.
    const words = first.replace(NUMBER, "#"), nums = said.every((v) => v.replace(NUMBER, "#") === words) ? said.map((v) => (v.match(NUMBER) || []).map(Number)) : [];
    if (nums.length && nums[0].length) {
      let i = 0;
      const ranges = nums[0].map((_, j) => [least(nums.map((x) => x[j])), most(nums.map((x) => x[j]))]);
      props.push({ prop, range: short(first.replace(NUMBER, () => {
        const [a, b] = ranges[i++];
        return r2(a) === r2(b) ? String(r2(a)) : `${r2(a)}…${r2(b)}`;
      })) });
      if (said.length === list.length) ranges.forEach(([a, b], j) => r2(a) !== r2(b) && rounds.push(round(w.t, nums.map((x) => x[j]))));
    } else {
      const all = [...new Set(list.map((v) => v || "not set"))];
      props.push({ prop, range: short(`${all.slice(0, MAX_VALUES).join(", ")}${all.length > MAX_VALUES ? ", …" : ""}`) });
    }
  }
  // It has come round when all of it has: the slowest says how long that takes.
  const cycle = rounds.length && least(rounds) > 0 ? most(rounds) : 0;
  return { props, cycle: cycle ? Math.round(cycle / 10) * 10 : null, over: Math.round(w.t[w.t.length - 1] - w.t[0]), watching: true };
}
// (Not Math.min(...list): a list is as long as it was watched for.)
const least = (l) => l.reduce((a, b) => (b < a ? b : a));
const most = (l) => l.reduce((a, b) => (b > a ? b : a));
/** How long one round is (ms), or 0 when it was not seen to come round: the time from one rise
 *  through the middle to another after which what was seen is what was seen before. */
function round(t, x) {
  const a = least(x), span = most(x) - a, low = a + span * 0.4, high = a + span * 0.6, ups = [];
  let under = x[0] < low;
  for (let i = 1; i < x.length; i++) {
    if (x[i] < low) under = true;
    else if (under && x[i] >= high) {
      ups.push(t[i - 1] + ((high - x[i - 1]) / (x[i] - x[i - 1])) * (t[i] - t[i - 1]));
      under = false;
    }
  }
  const end = t[t.length - 1];
  for (let j = 1; j < ups.length; j++) {
    const long = ups[j] - ups[0];
    if (end - t[0] < long * 1.4) return 0; // too little of a second round to say it is one
    let k = 0, off = 0, n = 0;
    for (let i = 0; i < t.length && t[i] + long <= end; i++) {
      while (k < t.length - 2 && t[k + 1] < t[i] + long) k++;
      const part = (t[i] + long - t[k]) / (t[k + 1] - t[k] || 1);
      off += Math.abs(x[k] + (x[k + 1] - x[k]) * part - x[i]);
      n++;
    }
    if (n && off / n < span * 0.08) {
      const times = Math.floor((ups.length - 1) / j);
      return (ups[times * j] - ups[0]) / times; // over every round seen: a frame more or less matters less
    }
  }
  return 0;
}
