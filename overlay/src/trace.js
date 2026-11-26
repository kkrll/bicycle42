// Where the page's scripts start what moves. Part of the lookup (lookup.js): it runs among the
// page's own scripts, before them, because only there is the call seen as it is made.
//
//  - element.animate(): the call is remembered with the animation it made (an Error is kept,
//    whose stack is only written out when it is asked for), so Motion mode can say the file and
//    line of an animation it finds playing.
//  - a <canvas>: nothing of the page says that one is drawn to, or how often. While Motion mode
//    asks for it (and only then: these are the calls a game makes thousands of in a frame), the
//    drawing calls of its contexts are counted for each canvas, with where the first came from.
//
// The overlay asks with "b42:from" on the element (detail: "animate:<n>", the n-th of the
// element's animations a script made; or "canvas") and is answered with "b42:from-is" before
// dispatchEvent returns; "b42:canvas-watch" (detail "1" or "0") starts and ends the counting.

/** How many lines of a stack are answered with (the first is ours, and left out). */
const LINES = 8;
const lines = (err) => {
  try {
    return String(err.stack || "").split("\n").slice(2, 2 + LINES).join("\n").slice(0, 4000);
  } catch {
    return "";
  }
};

// ── animate() ────────────────────────────────────────────────────────────────────────────
const born = new WeakMap();
const animate = Element.prototype.animate;
if (typeof animate === "function")
  Element.prototype.animate = {
    animate(keyframes, options) {
      const a = animate.apply(this, arguments);
      try {
        born.set(a, new Error());
      } catch {}
      return a;
    },
  }.animate;

// ── canvases ─────────────────────────────────────────────────────────────────────────────
/** canvas → { calls, frames, last, kind, err }: how many drawing calls, in how many frames of
 *  the page, since the counting began. */
let drawn = new WeakMap();
let frame = 0, ticking = 0;
const restore = [];
const DRAWS = {
  CanvasRenderingContext2D: ["clearRect", "fillRect", "strokeRect", "fill", "stroke", "fillText", "strokeText", "drawImage", "putImageData"],
  WebGLRenderingContext: ["clear", "drawArrays", "drawElements"],
  WebGL2RenderingContext: ["clear", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"],
  GPUCanvasContext: ["getCurrentTexture"],
  ImageBitmapRenderingContext: ["transferFromImageBitmap"],
};
const KIND = { CanvasRenderingContext2D: "2d", WebGLRenderingContext: "webgl", WebGL2RenderingContext: "webgl2", GPUCanvasContext: "webgpu", ImageBitmapRenderingContext: "bitmaprenderer" };

function counted(proto, name, kind) {
  const was = proto[name];
  if (typeof was !== "function") return;
  proto[name] = {
    [name]() {
      try {
        const c = this.canvas;
        let s = drawn.get(c);
        if (!s) drawn.set(c, (s = { calls: 0, frames: 0, last: -1, kind, err: new Error() }));
        s.calls++;
        if (s.last !== frame) (s.last = frame), s.frames++;
      } catch {}
      return was.apply(this, arguments);
    },
  }[name];
  restore.push(() => (proto[name] = was));
}
function watch(on) {
  if (on === !!ticking) return;
  if (!on) {
    cancelAnimationFrame(ticking);
    ticking = 0;
    while (restore.length) restore.pop()();
    drawn = new WeakMap();
    return;
  }
  for (const [type, names] of Object.entries(DRAWS)) {
    const proto = window[type] && window[type].prototype;
    if (proto) for (const name of names) counted(proto, name, KIND[type]);
  }
  const tick = () => {
    frame++;
    ticking = requestAnimationFrame(tick);
  };
  ticking = requestAnimationFrame(tick);
}

// ── asked ────────────────────────────────────────────────────────────────────────────────
window.addEventListener(
  "b42:canvas-watch",
  (/** @type {CustomEvent} */ e) => {
    e.stopImmediatePropagation();
    watch(e.detail === "1");
  },
  true,
);
window.addEventListener(
  "b42:from",
  (/** @type {CustomEvent} */ e) => {
    e.stopImmediatePropagation();
    const el = /** @type {any} */ (e.composedPath()[0]), what = String(e.detail || "");
    if (!el || el.nodeType !== 1) return;
    let out = null;
    try {
      if (what === "canvas") {
        const s = drawn.get(el);
        if (s) out = { calls: s.calls, frames: s.frames, at: performance.now(), kind: s.kind, stack: lines(s.err) };
      } else if (what.startsWith("animate:")) {
        const a = el.getAnimations().filter((x) => !(x instanceof CSSAnimation) && !(x instanceof CSSTransition))[+what.slice(8)];
        const err = a && born.get(a);
        if (err) out = { stack: lines(err) };
      }
    } catch {}
    if (out) el.dispatchEvent(new CustomEvent("b42:from-is", { detail: JSON.stringify(out), bubbles: true, composed: true }));
  },
  true,
);
