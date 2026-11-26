// Motion mode, what is drawn in a <canvas>: no rule, no animation object and no inline style
// says that one moves. The page-side trace (../trace.js) counts the drawing calls of each canvas
// while the mode is on; one drawn to several times a second is listed, and opened it is watched
// for a second: how often it is drawn again, with how many calls, by what kind of context, and
// where in the page's scripts the drawing comes from (source.js). Nothing of it can be changed
// here: the note says what it should do, and the agent is told where to look.

import { M, pathOf } from "./model.js";
import { setSel, show } from "./open.js";
import { draw, drawList } from "./draw.js";
import { ask, trace } from "./source.js";

/** How often the canvases are looked at (ms), how many of them at most, how many times a second
 *  one is to be drawn to be listed, and how long an open one is watched (ms). */
const EVERY = 600, MOST = 40, RATE = 4, WATCH = 1000;
let timer = 0, last = new WeakMap();

const tell = (on) => {
  try {
    window.dispatchEvent(new CustomEvent("b42:canvas-watch", { detail: on ? "1" : "0" }));
  } catch {}
};
/** The mode is on or off: the page's canvases are counted, or not any more. */
export function watchCanvases(on) {
  clearInterval(timer);
  timer = 0;
  last = new WeakMap();
  tell(on);
  if (!on) return void M.drawn.clear();
  timer = setInterval(look, EVERY);
}
function look() {
  if (!M.on) return;
  let changed = false;
  for (const el of M.drawn) if (!el.isConnected) changed = M.drawn.delete(el) || changed;
  const all = document.getElementsByTagName("canvas");
  for (let i = 0; i < all.length && i < MOST; i++) {
    const el = all[i];
    if (M.drawn.has(el)) continue;
    const a = ask(el, "canvas");
    if (!a || !(a.at > 0) || !(a.frames >= 0)) continue;
    const was = last.get(el);
    last.set(el, { frames: a.frames, at: a.at });
    if (was && a.at > was.at && ((a.frames - was.frames) / (a.at - was.at)) * 1000 >= RATE) changed = !!M.drawn.add(el);
  }
  if (changed) {
    M.list = null;
    drawList();
  }
}

export function openCanvas(el) {
  setSel(el);
  M.ro = { frames: [], seen: null, canvas: true };
  show({ kind: "frames", rs: pathOf(el), name: "canvas" });
  watchCanvas();
}
/** Watch the open canvas from now on: when it is opened, and when the reviewer asks again. */
export function watchCanvas() {
  const el = M.sel, ro = M.ro;
  if (!el || !ro || !ro.canvas) return;
  const a = ask(el, "canvas");
  if (a && typeof a.stack === "string") trace(el, a.stack, () => M.ro === ro && draw());
  ro.seen = { props: facts(el, null, a), cycle: null, over: 0, watching: true };
  draw();
  setTimeout(() => {
    if (M.ro !== ro || !M.on) return;
    const b = ask(el, "canvas");
    ro.seen = { props: facts(el, a, b), cycle: null, over: a && b && b.at > a.at ? Math.round(b.at - a.at) : WATCH, watching: false };
    draw();
  }, WATCH);
}
const KINDS = ["2d", "webgl", "webgl2", "webgpu", "bitmaprenderer"];
/** What is said of a canvas, between two answers of the trace (or of its size alone). */
function facts(el, a, b) {
  const out = [];
  if (a && b && b.at > a.at) {
    const frames = b.frames - a.frames, calls = b.calls - a.calls, rate = Math.round((frames / (b.at - a.at)) * 1000);
    out.push({ prop: "redrawn", range: frames > 0 ? `${rate} time${rate === 1 ? "" : "s"} a second` : "not while it was watched" });
    if (frames > 0) out.push({ prop: "drawing-calls", range: `about ${Math.round(calls / frames)} each time` });
  }
  const kind = (b || a || {}).kind;
  if (KINDS.includes(kind)) out.push({ prop: "context", range: kind });
  const r = el.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
  out.push({ prop: "size", range: `${w} × ${h}px${el.width !== w || el.height !== h ? `, drawn at ${el.width} × ${el.height}` : ""}` });
  return out;
}
