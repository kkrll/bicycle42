// Motion mode, the host's dock: motion's dock (the list, the open animation's timeline, the note
// and Send) is drawn by the host, when it says it draws it (hosted("motion"), ../panel.js); the
// layer draws none of it, and a host that does not say so has no dock. What the dock shows goes
// to the host as a view (MotionView in ../../protocol-motion.ts), and what is done in it
// (MotionAct) comes back here and calls open.js, edit.js, send.js. Nothing of the page's leaves
// this side: the host's dock is a drawing.
//
// Where a view is wanted: wherever what the dock shows changed (draw, drawList, drawFoot in
// draw.js ask for one), when the dock becomes the host's (syncUi), and when the host asks
// ("resend", after its window reloads).
// Asks within one task are one view, built once the task is done; panel.js sends at most one a
// frame.
//
// The playhead. The playhead moves every frame while something plays. Its position travels in
// the view (`clock`), sent from the layer's frame whenever it changed, and the host draws it as
// it is told: the host does not run a clock of its own between views. A real page's position is
// not a line in time (a delay, repeats, alternate directions, a script's own easing, Loop's pause
// between runs, a page that stalls), so a playhead the host moved by itself would disagree with
// what the page shows. Everything but the clock is built once per change and kept (M.hostBody); a
// frame that only moved the playhead sends the kept body with a new clock.
//
// What goes. panel.js sends the fields of a view that are not the objects that went last, so a
// field that says what it said is to be the object it was. The fields that are words, numbers
// and yes or no are that by themselves. The others are kept here (the M.host… of model.js) and
// handed on while they say the same: the clock; the list's rows, each row and then the whole
// list (a list read from the page again that says the same is not sent again); what is open;
// the names; and the choices, which are the same while what is open sets the same properties.
// A keystroke in the note is then the note's words alone, and a step of a keyframe's drag is
// what is open and the clock. Nothing that went is changed afterwards: a change is a new object.

import { S } from "../state.js";
import { hosted, onAct, sendView } from "../panel.js";
import { draftChanged } from "../draft.js";
import { setMode } from "../mode.js";
import { kick } from "../render.js";
import { apply, clamp, COUNT, DIRECTION, EASINGS, FILL, frames, HOW, M, name, openDirty, openKf, openUse, pathOf, PROPS, r1, RATE_TEXT, RATES, readOnly } from "./model.js";
import { addTrigger, animOf, knownNames, newAnimation, position, removeTrigger, reveal, running, seek, selectEl, setState, toggle, useKf, waiting } from "./open.js";
import { addKey, addLane, commit, cssText, detach, discard, keyInfo, laneOrder, moveKey, playTogether, removeKey, removeLane, rowNow, rows, score, segEase, setCss, setKey, setName, setTiming, sharedBy, timing, travel } from "./edit.js";
import { submit } from "./send.js";
import { draw, flash, sentStatus } from "./draw.js";
import { go, restage } from "./stage.js";
import { record } from "./record.js";

// ── the view ─────────────────────────────────────────────────────────────────────────────
const ROW = ["id", "kind", "text", "aside", "duration", "on", "sub", "last", "off", "running", "dirty"];
/** The rows of the list as the view has them: the rows read from the page (rows in edit.js,
 *  kept) with what the reviewer's state says of each now. A row that says what it said is the
 *  object it was, and so is the list when every row is. */
function listed() {
  const base = rows(), was = M.hostRows;
  let same = was.length === base.length;
  const list = base.map((b, i) => {
    const old = was[i];
    if (b.group) {
      if (old && old.group === b.group) return old;
      same = false;
      return { group: b.group };
    }
    const now = rowNow(b), d = now.duration;
    const r = { id: b.id, kind: b.kind, text: b.text, aside: b.aside, duration: typeof d === "number" && Number.isFinite(d) ? Math.round(d) : null,
      on: now.on, sub: !!b.sub, last: !!b.last, off: now.off, running: now.running, dirty: now.dirty };
    if (old && ROW.every((k) => old[k] === r[k])) return old;
    same = false;
    return r;
  });
  M.hostBase = base;
  return same ? was : (M.hostRows = list);
}
/** No list (motion mode is off): the empty one that went last, if one did. */
function unlisted() {
  M.hostBase = [];
  return M.hostRows.length ? (M.hostRows = []) : M.hostRows;
}
const pairs = (map) => Object.entries(map).map(([v, [text, what]]) => [v, text, what || v]);
/** The words of the choices the dock offers: the same in every view, but the properties, which
 *  are those what is open does not set yet (choices below). */
const CHOICES = {
  easings: EASINGS,
  props: PROPS,
  starts: Object.entries(HOW),
  count: pairs(COUNT),
  direction: pairs(DIRECTION),
  fill: pairs(FILL),
  rates: RATES.map((r) => [r, RATE_TEXT[r]]),
};
/** The choices for what is open: the object they were while it sets the same properties. */
function choices(open) {
  const lanes = open ? open.lanes.map((l) => l.prop) : [], is = lanes.join("|");
  if (is !== M.hostLanes || !M.hostChoices) (M.hostLanes = is), (M.hostChoices = { ...CHOICES, props: PROPS.filter((p) => !lanes.includes(p)) });
  return M.hostChoices;
}
/** What the keyframes leave unsaid: where they have no first or last keyframe for a property,
 *  the animation starts from (or ends at) the element's own value, which the browser knows.
 *  { prop: [at 0, at 100] }, a value or undefined each. */
function implied() {
  const out = {}, a = M.open && M.open.kind === "css" ? animOf() : null;
  if (!a || !a.effect || !a.effect.getKeyframes) return out;
  const kebab = (s) => (s.startsWith("--") ? s : s === "cssFloat" ? "float" : s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
  try {
    for (const kf of a.effect.getKeyframes()) {
      const end = kf.computedOffset === 0 ? 0 : kf.computedOffset === 1 ? 1 : -1;
      if (end < 0) continue;
      for (const p in kf) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) (out[kebab(p)] || (out[kebab(p)] = []))[end] = String(kf[p]);
    }
  } catch {}
  return out;
}
function openView() {
  const o = M.open;
  if (!o) return null;
  const t = timing(), k = openKf(), u = openUse(), fr = frames(), ki = keyInfo(), unsaid = k ? implied() : {};
  const T = o.kind === "transition" ? M.ro.total : Math.max(1, +t.duration || 0);
  return {
    kind: o.kind,
    name: o.kind === "transition" ? "transition" : o.name,
    readOnly: readOnly(),
    timed: true,
    states: o.kind === "transition" ? M.ro.states.map((s) => s.label) : [],
    state: o.kind === "transition" && M.ro.state ? M.ro.state.label : null,
    triggers: o.kind === "transition" ? M.ro.states.filter((s) => s.trigger).map((s) => s.label) : [],
    above: o.kind === "transition" ? M.ro.above : [],
    recording: !!M.rec,
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
      const keys = own.map((f) => ({ at: f.at, value: String(f.vals[p]) })), eases = own.slice(0, -1).map((f) => segEase(f.at, p));
      const [from, to] = unsaid[p] || [];
      if (own.length && own[0].at > 0 && from !== undefined) (keys.unshift({ at: 0, value: from, implied: true }), eases.unshift(String(t.easing)));
      if (own.length && own[own.length - 1].at < 100 && to !== undefined) (keys.push({ at: 100, value: to, implied: true }), eases.push(segEase(own[own.length - 1].at, p)));
      return { prop: p, keys, eases };
    }),
    key: ki && { at: ki.at, prop: ki.prop, value: ki.value === null || ki.value === undefined ? null : String(ki.value), ease: ki.ease, dflt: ki.dflt, last: ki.last, editable: ki.editable, props: Object.keys(ki.f.vals).length },
    score: score().map(({ id, text, name, delay, duration, on }) => ({ id, text, name, delay, duration, on })),
    css: cssText(),
    cssError: M.cssWhy,
    dirty: openDirty(),
  };
}
/** Everything but the clock. */
function body() {
  const on = M.on && S.enabled;
  // What is open is built each time (from M alone: it is small) and kept when it says the same.
  const open = on ? openView() : null, openIs = open ? JSON.stringify(open) : "";
  if (openIs !== M.hostOpenIs) (M.hostOpen = open), (M.hostOpenIs = openIs);
  const names = on && M.sel && !M.open ? knownNames() : [];
  if (names.length !== M.hostNames.length || names.some((n, i) => n !== M.hostNames[i])) M.hostNames = names;
  return {
    on,
    rows: on ? listed() : unlisted(),
    partial: on && M.scan.partial,
    sel: on && M.sel ? name(M.sel) : null,
    open: M.hostOpen,
    names: M.hostNames,
    view: M.view,
    rate: M.rate,
    loop: M.loop,
    isolate: M.isolate,
    backdrop: M.stageLook,
    undo: M.past.length > 0,
    redo: M.future.length > 0,
    note: M.note,
    msg: M.msg,
    status: M.done || (M.open && openDirty() ? "" : sentStatus()),
    choices: choices(M.hostOpen),
  };
}
const clockNow = () => (M.on && S.enabled ? { pos: (() => {
  const p = position();
  return p === null ? null : Math.round(p * 10000) / 10000;
})(), playing: running(), on: !!(M.ro && M.ro.on), wait: (() => {
  const w = waiting();
  return w === null ? null : Math.round(w * 1000) / 1000;
})() } : { pos: null, playing: false, on: false, wait: null });
const clockKey = (c) => `${c.pos}|${c.playing}|${c.on}|${c.wait}`;
function out() {
  if (!hosted("motion")) return;
  if (!M.hostBody) M.hostBody = body();
  const clock = clockNow(), is = clockKey(clock);
  if (is !== M.hostClock || !M.hostClockIs) (M.hostClock = is), (M.hostClockIs = clock);
  sendView("motion", { ...M.hostBody, clock: M.hostClockIs });
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
  if (!hosted("motion") || M.hostQueued || clockKey(clockNow()) === M.hostClock) return;
  out();
}
/** The dock became the host's, or was given back, or the mode or review was switched. */
export function hostSync() {
  if (hosted("motion")) return wantView();
  M.rowEls = null; // no dock: no row of it under the pointer
  unlisted(); // and none of the page's elements kept for its list
}

// ── what is done in the host's dock ──────────────────────────────────────────────────────
/** The row of the last view with this id, as read from the page (its elements, what opens it). */
const row = (id) => M.hostBase[M.hostRows.findIndex((r) => !r.group && r.id === id)];
const str = (v) => String(v ?? "");
const ACTS = {
  row(a) {
    const r = row(a.id);
    if (!r || rowNow(r).off) return;
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
    restage();
    draw();
  },
  backdrop(a) {
    if (!M.isolate || !M.sel || (a.value !== "light" && a.value !== "dark")) return;
    M.stageBg = a.value;
    restage();
    draw();
  },
  together() {
    if (playTogether()) draw();
  },
  state(a) {
    if (!M.open || M.open.kind !== "transition") return;
    setState(str(a.value));
    draw();
  },
  trigger(a) {
    if (!addTrigger(str(a.text), str(a.on))) draw();
  },
  record: (a) => record(!!a.on),
  untrigger: (a) => removeTrigger(str(a.value)),
  go: (a) => go(+a.by < 0 ? -1 : 1),
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
  // A keyframe pressed, dragged and let go, the host's dock measuring where.
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
    // (An implied key is not a keyframe: the page shows that frame, and nothing is selected.)
    if (!frames().some((f) => f.at === at && (prop === null || prop in f.vals))) return seek(at / 100);
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
  // dropped for the last that was.
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
    M.note = str(a.text);
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
