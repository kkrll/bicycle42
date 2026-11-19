// Motion mode, the host's dock: when the host draws motion's dock itself (hosted("motion"),
// ../panel.js), the layer draws none. What its dock would show goes to the host as a view
// (MotionView in ../../protocol-motion.ts), and what is done in the host's dock (MotionAct)
// comes back here and calls what the layer's own dock calls: open.js, edit.js, send.js. Nothing
// of the page's leaves this side: the host's dock is a drawing.
//
// Where a view is wanted: everywhere the layer's own dock would be drawn (draw, drawList,
// drawFoot in draw.js ask for one instead of drawing while the dock is the host's), when the
// dock becomes the host's (syncUi), and when the host asks ("resend", after its window reloads).
// Asks within one task are one view, built once the task is done; panel.js sends at most one a
// frame.
//
// The playhead. A view is whole every time, and the playhead moves every frame while something
// plays. Its position travels in the view (`clock`), sent from the layer's frame whenever it
// changed, and the host draws it as it is told: the host does not run a clock of its own between
// views. A real page's position is not a line in time (a delay, repeats, alternate directions, a
// script's own easing, Loop's pause between runs, a page that stalls), so a playhead the host
// moved by itself would disagree with what the page shows. To keep a view cheap to send every
// frame, everything but the clock is built once per change and kept (M.hostBody); a frame that
// only moved the playhead sends the kept body with a new clock.

import { S } from "../state.js";
import { hosted, onAct, sendView } from "../panel.js";
import { draftChanged } from "../draft.js";
import { setMode } from "../mode.js";
import { kick } from "../render.js";
import { apply, clamp, COUNT, DIRECTION, EASINGS, FILL, frames, HOW, M, name, openDirty, openKf, openUse, pathOf, PROPS, r1, RATE_TEXT, RATES, readOnly } from "./model.js";
import { animOf, knownNames, newAnimation, position, reveal, running, seek, selectEl, toggle, useKf } from "./open.js";
import { addKey, addLane, commit, cssText, detach, discard, keyInfo, laneOrder, moveKey, removeKey, removeLane, rows, segEase, setCss, setKey, setName, setTiming, sharedBy, timing, travel } from "./edit.js";
import { submit } from "./send.js";
import { closePop, noteEl, sugHide } from "./input.js";
import { draw, flash, sentStatus } from "./draw.js";

// ── the view ─────────────────────────────────────────────────────────────────────────────
/** The rows of the list, each with an id that names the same thing in the next view: its kind,
 *  the animation it is under, its element, its words. */
function listed() {
  const seen = new Map();
  let under = "";
  return rows().map((r) => {
    if (r.group) return r;
    if (!r.sub) under = r.text;
    let id = `${r.kind}|${r.sub ? under : ""}|${r.els && r.els.length === 1 ? pathOf(r.els[0]) : ""}|${r.text}`;
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id += `#${n}`;
    return { ...r, id };
  });
}
const pairs = (map) => Object.entries(map).map(([v, [text, what]]) => [v, text, what || v]);
function openView() {
  const o = M.open;
  if (!o) return null;
  const t = timing(), k = openKf(), u = openUse(), fr = frames(), ki = keyInfo();
  const T = Math.max(1, +t.duration || 0);
  M.T = T; // (the layer's own playhead reads it too, should the dock come back)
  return {
    kind: o.kind,
    name: o.kind === "transition" ? "transition" : o.name,
    readOnly: readOnly(),
    renamable: !!(k && k.isNew),
    removable: !!(u && u.isNew),
    shared: sharedBy(),
    from: (u && u.from) || null,
    timing: { duration: Math.round(+t.duration || 0), delay: Math.round(+t.delay || 0), easing: String(t.easing), count: String(t.count), direction: String(t.direction), fill: String(t.fill) },
    starts: u ? u.plays.how : null,
    T,
    frames: fr.map((f) => f.at),
    lanes: laneOrder().map((p) => {
      const own = fr.filter((f) => p in f.vals);
      return { prop: p, keys: own.map((f) => ({ at: f.at, value: String(f.vals[p]) })), eases: own.slice(0, -1).map((f) => segEase(f.at, p)) };
    }),
    key: ki && { at: ki.at, prop: ki.prop, value: ki.value === null || ki.value === undefined ? null : String(ki.value), ease: ki.ease, dflt: ki.dflt, last: ki.last, props: Object.keys(ki.f.vals).length },
    css: cssText(),
    cssError: M.cssWhy,
    dirty: openDirty(),
  };
}
/** Everything but the clock. */
function body() {
  const on = M.on && S.enabled;
  const list = on ? listed() : [];
  M.hostRows = list;
  const open = on ? openView() : null;
  const lanes = open ? open.lanes.map((l) => l.prop) : [];
  return {
    on,
    rows: list.map((r) => (r.group ? { group: r.group }
      : { id: r.id, kind: r.kind, text: r.text, aside: r.aside || "", duration: typeof r.duration === "number" && Number.isFinite(r.duration) ? Math.round(r.duration) : null,
        on: !!r.on, sub: !!r.sub, last: !!r.last, off: !!r.off, running: !!r.running, dirty: !!r.dirty })),
    sel: on && M.sel ? name(M.sel) : null,
    open,
    names: on && M.sel && !M.open ? knownNames() : [],
    view: M.view,
    rate: M.rate,
    loop: M.loop,
    isolate: M.isolate,
    undo: M.past.length > 0,
    redo: M.future.length > 0,
    note: noteEl ? noteEl.value : "",
    msg: M.msg,
    status: M.done || (M.open && openDirty() ? "" : sentStatus()),
    choices: {
      easings: EASINGS,
      props: PROPS.filter((p) => !lanes.includes(p)),
      starts: Object.entries(HOW),
      count: pairs(COUNT),
      direction: pairs(DIRECTION),
      fill: pairs(FILL),
      rates: RATES.map((r) => [r, RATE_TEXT[r]]),
    },
  };
}
const clockNow = () => (M.on && S.enabled ? { pos: (() => {
  const p = position();
  return p === null ? null : Math.round(p * 10000) / 10000;
})(), playing: running(), on: !!(M.ro && M.ro.on) } : { pos: null, playing: false, on: false });
const clockKey = (c) => `${c.pos}|${c.playing}|${c.on}`;
function out() {
  if (!hosted("motion")) return;
  if (!M.hostBody) M.hostBody = body();
  const clock = clockNow();
  M.hostClock = clockKey(clock);
  sendView("motion", { ...M.hostBody, clock });
}
/** The dock is to be drawn again: one view, once this task is done. */
export function wantView() {
  if (!hosted("motion")) return;
  M.hostBody = null;
  if (M.hostQueued) return;
  M.hostQueued = true;
  queueMicrotask(() => {
    M.hostQueued = false;
    out();
  });
}
/** From the layer's frame: the playhead moved, or it started or stopped playing. */
export function hostFrame() {
  if (M.hostQueued || clockKey(clockNow()) === M.hostClock) return;
  out();
}
/** The dock became the host's, or was given back, or the mode or review was switched. */
export function hostSync() {
  const h = hosted("motion");
  if (h !== M.hosted) {
    M.hosted = h;
    if (h) {
      closePop();
      sugHide();
      M.rowEls = null;
    } else if (M.on) draw(); // the layer's own dock is drawn again, as it is now
  }
  if (h) wantView();
}

// ── what is done in the host's dock ──────────────────────────────────────────────────────
const row = (id) => M.hostRows.find((r) => !r.group && r.id === id);
const str = (v) => String(v ?? "");
const ACTS = {
  row(a) {
    const r = row(a.id);
    if (!r || r.off) return;
    r.open();
    reveal(M.sel);
  },
  hover(a) {
    const r = a.id ? row(a.id) : null;
    M.rowEls = r && r.els && r.els.length ? r.els : null;
    kick();
  },
  escape() {
    if (M.key) {
      M.key = null;
      draw();
    } else if (M.open || M.sel) selectEl(null);
    else setMode("notes");
  },
  back: () => selectEl(null),
  view(a) {
    if (a.view !== "keys" && a.view !== "css") return;
    M.cssWhy = ""; // the text being typed is done (see "css")
    M.view = a.view;
    commit();
  },
  timing(a) {
    setTiming(str(a.what), str(a.value), !!a.done);
    draw();
  },
  rate(a) {
    if (!RATES.includes(a.rate)) return;
    M.rate = a.rate;
    const an = animOf();
    if (an) an.playbackRate = M.rate;
    draw();
  },
  loop(a) {
    M.loop = !!a.on;
    M.loopAt = 0;
    draw();
  },
  isolate(a) {
    M.isolate = !!a.on && !!M.sel;
    apply();
    draw();
  },
  undo: () => travel(M.past, M.future),
  redo: () => travel(M.future, M.past),
  discard: () => discard(),
  play() {
    toggle();
    draw();
  },
  seek(a) {
    if (M.open && Number.isFinite(+a.p)) seek(+a.p);
  },
  step(a) {
    if (M.open && Number.isFinite(+a.by)) seek((position() ?? M.pos) + clamp(+a.by, -1, 1));
  },
  // A keyframe pressed, dragged and let go: what the timeline's pointer does in the layer's own
  // dock (tlDown, tlMove, tlUp in input.js), with the host's dock measuring where.
  select(a) {
    if (!M.open) return;
    if (!a.key) {
      if (M.key) {
        M.key = null;
        draw();
      }
      return;
    }
    const at = r1(clamp(+a.key.at || 0, 0, 100)), prop = a.key.prop ? str(a.key.prop) : null;
    M.key = { at, prop };
    M.drag = a.grab && !readOnly() ? { type: "key", at, prop, moved: false } : null;
    seek(at / 100);
    draw();
  },
  drag(a) {
    const d = M.drag, to = r1(clamp(+a.to || 0, 0, 100));
    if (!d || d.type !== "key" || to === d.at || !moveKey(d.prop, d.at, to)) return;
    d.at = to;
    M.key = { at: to, prop: d.prop };
    d.moved = true;
    apply();
    seek(to / 100);
    draw();
  },
  drop() {
    const d = M.drag;
    M.drag = null;
    if (d && d.moved) commit();
    else draw();
  },
  addKey(a) {
    if (openKf()) addKey(a.prop ? str(a.prop) : null, r1(clamp(+a.at || 0, 0, 100)));
  },
  key(a) {
    if (a.what === "val" || a.what === "ease" || a.what === "at") setKey(a.what, str(a.value), !!a.done);
    draw();
  },
  removeKey() {
    if (M.key && openKf()) removeKey();
  },
  addLane(a) {
    const p = str(a.prop).trim().toLowerCase();
    if (!p || addLane(p)) return;
    flash(laneOrder().includes(p) ? `${p} has a lane already` : `${p.slice(0, 40)} is not a property that can be animated here`);
  },
  removeLane(a) {
    removeLane(str(a.prop));
  },
  // The keyframes as text: each keystroke is shown on the page when it is keyframes, and why not
  // when it is not; leaving the field is one undo step, and text that is not keyframes is
  // dropped for the last that was (as the layer's own text field does).
  css(a) {
    M.cssWhy = setCss(str(a.text));
    if (a.done) {
      M.cssWhy = "";
      commit();
    } else draw();
  },
  name(a) {
    setName(str(a.value), !!a.done);
    draw();
  },
  new: () => newAnimation(),
  use: (a) => useKf(str(a.name)),
  detach: () => detach(),
  note(a) {
    if (!noteEl) return;
    noteEl.value = str(a.text);
    draftChanged();
    draw();
  },
  send: (a) => submit(!!a.background),
  resend: () => wantView(),
};
/** Listens to the host's dock (mount() calls it once). */
export function hostListen() {
  onAct("motion", (a) => {
    const f = a && Object.prototype.hasOwnProperty.call(ACTS, a.type) ? ACTS[a.type] : null;
    if (!f) return;
    // Motion mode off: nothing to do in its dock but say so.
    if (!(M.on && S.enabled) && a.type !== "resend") return wantView();
    f(a);
  });
}
