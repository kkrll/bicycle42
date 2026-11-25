// Motion mode, opening and playing: what is open in the dock, and the page's own Animation
// object for it, played, paused and stopped at a frame.

import { adopt, BOOST } from "../page.js";
import { apply, clamp, fromApi, kfIs, M, mq, openScr, parseKf, pathOf, r1, readList, scan, scriptDirty, serialize, splitTop, toApi } from "./model.js";
import { commit, nameProblem, snapshot } from "./edit.js";
import { draw, flash } from "./draw.js";
import { kick } from "../render.js";
import { statesOf, styleRules } from "./states.js";
import { restage } from "./stage.js";
import { openFrames, watch } from "./frames.js";

// ── opening one ──────────────────────────────────────────────────────────────────────────
function baseFor(rs, el) {
  for (const u of M.use.values()) if (u.rs === rs) return u.base;
  return readList(el);
}
export function show(open) {
  // What was stopped at a frame to be looked at goes on from there: nothing stays frozen behind.
  const was = M.open && M.open.kind !== "transition" ? animOf() : null;
  if (was && was.playState === "paused" && !(open && M.open.kind === open.kind && M.open.rs === open.rs && M.open.name === open.name)) {
    was.playbackRate = 1;
    was.play();
  }
  if (M.ro && M.ro.on) M.ro.on = false;
  M.open = open;
  M.key = null;
  M.lanes = [];
  M.held = null;
  M.loopAt = 0;
  if (!open || open.kind === "css") M.ro = null;
  M.snap = snapshot();
  restage(); // (applies: the rules, and where the stage puts what is open now)
  draw();
}
export function openCss(el, nm) {
  const rs = pathOf(el);
  setSel(el);
  if (!M.kf.has(nm)) {
    const rule = M.scan.rules.get(nm);
    const live = el.getAnimations().find((a) => a.animationName === nm);
    if (!rule && !live) {
      // No keyframes by that name: a row drawn before they were renamed, or a name the page's CSS
      // plays and never declares. Opening it would make empty keyframes and attach them.
      const plays = readList(el).some((e) => e.name === nm);
      scan();
      setSel(el);
      show(null);
      if (plays) flash(`The page has no @keyframes ${nm}`);
      return;
    }
    const fr = rule ? parseKf(rule.cssText).frames || [] : fromApi(live.effect.getKeyframes());
    M.kf.set(nm, { name: nm, frames: fr, orig: serialize(nm, fr), isNew: false });
  }
  const k = `${rs}|${nm}`;
  if (!M.use.has(k)) {
    const base = baseFor(rs, el), index = base.findIndex((e) => e.name === nm);
    if (index < 0) return attach(el, nm);
    const { name: _, ...timing } = base[index];
    M.use.set(k, { rs, name: nm, timing, orig: { ...timing }, plays: { how: "asnow", words: "" }, base, index, isNew: false });
  }
  show({ kind: "css", rs, name: nm });
}
/** Keyframes the element does not play yet: a new animation, or ones the page declares and nothing plays. */
function attach(el, nm, timing = { duration: 400, delay: 0, easing: "ease-out", count: "1", direction: "normal", fill: "both" }) {
  const rs = pathOf(el), base = baseFor(rs, el);
  const index = base.length + [...M.use.values()].filter((u) => u.rs === rs && u.isNew).length;
  M.use.set(`${rs}|${nm}`, { rs, name: nm, timing, orig: null, plays: { how: "load", words: "" }, base, index, isNew: true });
  setSel(el);
  show({ kind: "css", rs, name: nm });
  commit();
  seek(0);
  play();
}
/** New keyframes for the selected element: a fade up to start from, under a name that says it
 *  is new (not "fade-up-2", which reads as a copy of the page's own), ready to be renamed. */
export function newAnimation() {
  if (!M.sel) return;
  let nm = "new-animation";
  for (let i = 2; nameProblem(nm); i++) nm = `new-animation-${i}`;
  M.kf.set(nm, { name: nm, isNew: true, orig: "", frames: [{ at: 0, ease: "", vals: { opacity: "0", translate: "0 12px" } }, { at: 100, ease: "", vals: { opacity: "1", translate: "0 0" } }] });
  attach(M.sel, nm);
}
/** Every keyframes the selected element could play: the page's, and those made here. */
export const knownNames = () => [...new Set([...M.scan.rules.keys(), ...M.scan.anims.map((a) => a.name), ...M.kf.keys()])]
  .filter((n) => M.kf.has(n) || M.scan.rules.has(n)).sort();
/** Keyframes the page has, played by the selected element too: timed as the first element that
 *  plays them times them, or, when nothing plays them, once over 600ms. */
export function useKf(nm) {
  if (!M.sel) return;
  if (!M.kf.has(nm)) {
    const rule = M.scan.rules.get(nm);
    if (!rule) return;
    const fr = parseKf(rule.cssText).frames || [];
    M.kf.set(nm, { name: nm, frames: fr, orig: serialize(nm, fr), isNew: false });
  }
  const a = M.scan.anims.find((x) => x.name === nm), e = a && readList(a.els[0]).find((x) => x.name === nm);
  const { name: _, ...timing } = e || { duration: 600, delay: 0, easing: "ease-in-out", count: "1", direction: "normal", fill: "none" };
  attach(M.sel, nm, timing);
}
/** A script's animation as changed here, how it plays and its keyframes: written into the
 *  animation itself (there is no rule to write over), and taken out again when it is left unsent.
 *  What is as the page's script made it is not written, unless something else was written there
 *  before: then it is put back as the browser gave it, not as it is shown here (rounded). */
export function applyScript() {
  const a = M.held, sc = openScr();
  if (!sc || !a || !a.effect) return;
  const t = sc.timing, timed = JSON.stringify(t) !== sc.orig, keyed = kfIs(sc.frames) !== sc.origKf;
  try {
    if (timed) a.effect.updateTiming({ duration: +t.duration || 0, delay: +t.delay || 0, easing: t.easing, iterations: t.count === "infinite" ? Infinity : +t.count || 0, direction: t.direction, fill: t.fill });
    else if (sc.timed) a.effect.updateTiming(sc.raw.timing);
    sc.timed = timed;
  } catch {}
  try {
    if (keyed) a.effect.setKeyframes(toApi(sc.frames));
    else if (sc.keyed) a.effect.setKeyframes(sc.raw.frames);
    sc.keyed = keyed;
  } catch {}
}
let readings = 0;
/** A script's animation as it is now: how it plays and its keyframes as they are shown and
 *  changed here, what they were (to say what changed), and both as the browser gives them (`raw`,
 *  to put them back). `id` says which reading an undo step is of. */
export function readScript(a) {
  const t = a.effect.getTiming(), raw = a.effect.getKeyframes(), fr = fromApi(raw);
  // (One that adds to what is under it goes on adding.)
  fr.forEach((f, i) => {
    if (raw[i].composite && raw[i].composite !== "auto") f.composite = raw[i].composite;
  });
  const timing = { duration: +t.duration || 0, delay: t.delay, easing: t.easing, count: t.iterations === Infinity ? "infinite" : String(t.iterations), direction: t.direction, fill: t.fill === "auto" ? "none" : t.fill };
  return { id: ++readings, frames: fr, timing, orig: JSON.stringify(timing), origFrames: JSON.stringify(fr), origKf: kfIs(fr), raw: { timing: t, frames: raw }, timed: false, keyed: false };
}
/** Undo steps of a script's animation that is not open any more change nothing: they go. */
export function forgetSteps(id) {
  const of = `"sc":{"id":${id},`;
  if (![...M.past, ...M.future].some((s) => s.includes(of))) return;
  const rest = (s) => (({ kf, use, tr }) => JSON.stringify([kf, use, tr]))(JSON.parse(s)), now = rest(M.snap);
  for (const list of [M.past, M.future]) {
    list.splice(0, list.length, ...list.map((s) => (s.includes(of) ? JSON.stringify({ ...JSON.parse(s), sc: null }) : s)).filter((s, i, l) => !i || s !== l[i - 1]));
    while (list.length && rest(list[list.length - 1]) === now) list.pop();
  }
}
export function openScript(a) {
  if (openScr() && M.held === a) return draw(); // it is open already: what was changed of it stays
  const el = a.effect.target;
  setSel(el);
  M.ro = readScript(a);
  show({ kind: "script", rs: pathOf(el), name: a.id || "animate()" });
  M.held = a;
}
/** A transition has no keyframes: two values per property and the state that switches them,
 *  found in the page's own rules (states.js). Playing it applies that state's declarations. How
 *  long, how late and how eased is the element's own, and may be changed (M.tr). */
export function openTransition(el) {
  const rs = pathOf(el), cs = getComputedStyle(el);
  setSel(el);
  const col = (p) => splitTop(cs.getPropertyValue(p));
  const props = col("transition-property"), dur = col("transition-duration"), del = col("transition-delay"), ease = col("transition-timing-function");
  const at = (list, i) => list[i % list.length];
  // (Changed here and not sent: what was changed is what it is, and the page's is kept beside it.)
  const mine = M.tr.get(rs);
  const page = props.map((p, i) => ({ prop: p, duration: Math.round(parseFloat(at(dur, i)) * 1000) || 0, delay: Math.round(parseFloat(at(del, i)) * 1000) || 0, easing: at(ease, i) })).filter((x) => x.duration > 0);
  const items = mine ? mine.items : page;
  const moves = (p) => items.some((x) => x.prop === "all" || x.prop === p || p.startsWith(`${x.prop}-`));
  const states = statesOf(el, moves, styleRules());
  M.ro = { items, orig: mine ? mine.orig : JSON.stringify(page), states, state: null, vals: null, frames: [], laneEase: {}, total: 1, on: false };
  setState((states.find((s) => s.label === "hover") || states[0] || { label: "" }).label, el);
  show({ kind: "transition", rs, name: "transition" });
}
/** The state the open transition is looked at in: both ends of each property are read, now and
 *  with the state's declarations applied at once. */
export function setState(label, el = openEl()) {
  const ro = M.ro;
  if (!ro || !ro.states || !el) return;
  const rs = pathOf(el), state = ro.states.find((s) => s.label === label) || null;
  if (ro.on) {
    ro.on = false;
    apply();
  }
  ro.state = state;
  const list = laid();
  const read = () => Object.fromEntries(list.map((x) => [x.prop, getComputedStyle(el).getPropertyValue(x.prop)]));
  const from = read();
  let to = from;
  if (state) {
    const probe = new CSSStyleSheet();
    try {
      probe.replaceSync(`${rs}${BOOST}${BOOST} { ${state.css}; transition: none !important; }`);
      adopt(probe, true);
      to = read();
      // Back as it was with the transition still off, and only then is it allowed again: taken
      // away in one go, the element would run its transition back from the state it never was in.
      probe.replaceSync(`${rs}${BOOST}${BOOST} { transition: none !important; }`);
      getComputedStyle(el).opacity;
    } catch {}
    adopt(probe, false);
    getComputedStyle(el).opacity;
  }
  ro.vals = { from, to };
  layout();
}
/** The properties the open transition has a lane for: `all` is those its state sets. */
function laid() {
  const ro = M.ro;
  const set = ro.state ? ro.state.props.filter((p) => !p.startsWith("--")) : [];
  return ro.state ? ro.items.flatMap((x) => (x.prop === "all" ? set.map((p) => ({ ...x, prop: p })) : [x])) : ro.items;
}
/** The open transition's lanes, from how long and how late each property is. */
export function layout() {
  const ro = M.ro;
  if (!ro || !ro.vals) return;
  const list = laid(), { from, to } = ro.vals;
  const total = Math.max(1, ...list.map((x) => x.delay + x.duration));
  const fr = new Map(), laneEase = {};
  const put = (o, p, v) => ((fr.get(o) || fr.set(o, { at: o, ease: "", vals: {} }).get(o)).vals[p] = v);
  for (const x of list) {
    put(r1(clamp(x.delay / total, 0, 1) * 100), x.prop, from[x.prop] ?? "");
    put(r1(clamp((x.delay + x.duration) / total, 0, 1) * 100), x.prop, to[x.prop] ?? "");
    laneEase[x.prop] = x.easing;
  }
  ro.frames = [...fr.values()].sort((a, b) => a.at - b.at);
  ro.laneEase = laneEase;
  ro.total = total;
}
/** After undo or redo: the open transition is what M.tr says now, or the page's again. */
export function syncTransition() {
  const o = M.open, ro = M.ro;
  if (!o || o.kind !== "transition" || !ro) return;
  const mine = M.tr.get(o.rs);
  ro.items = mine ? mine.items : JSON.parse(ro.orig);
  layout();
}
/** The open script's animation as the page has it (or as it was last sent). */
export function resetScript() {
  const sc = openScr();
  if (!sc) return;
  sc.timing = JSON.parse(sc.orig);
  sc.frames = JSON.parse(sc.origFrames);
  applyScript();
}
export function setSel(el) {
  // A script's animation changed here and left unsent is as the page's script made it again.
  const sc = openScr();
  if (sc) {
    if (scriptDirty()) resetScript();
    forgetSteps(sc.id);
  }
  M.sel = el;
  M.selRs = el ? pathOf(el) : "";
}
/** A click on the page: the element, and with it the first thing that moves it. */
export function selectEl(el) {
  if (!el) {
    setSel(null);
    return show(null);
  }
  const names = readList(el);
  const script = M.scan.scripts.find((a) => a.effect.target === el);
  if (names.length) openCss(el, names[0].name);
  else if (script) openScript(script);
  else if (M.scan.transitions.includes(el)) openTransition(el);
  else if (M.suspects.has(el)) openFrames(el);
  else {
    setSel(el);
    show(null);
  }
}
/** Bring the element into view, and send a ring out from it: the way to find something small
 *  (a 12px spinner) after choosing it in the list. */
export function reveal(el) {
  if (!el || !el.isConnected) return;
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  M.findUntil = performance.now() + 1400;
  kick();
}

// ── playing ──────────────────────────────────────────────────────────────────────────────
/** The element what is open is on. That is the selection, while it is in the page and its path
 *  is the open one's: then the page is not searched for it. Playing asks this several times a
 *  frame, and a search by a path of nth-of-type steps reads every sibling on the way down. */
function openEl() {
  const o = M.open;
  if (!o) return null;
  return M.sel && M.sel.isConnected && M.selRs === o.rs ? M.sel : mq(o.rs);
}
/** The page's own Animation object for what is open. One that ended without holding its last
 *  frame is no longer listed by the element, but the object still plays: it is kept. */
export function animOf() {
  const o = M.open, el = openEl();
  if (!el || o.kind === "transition") return null;
  if (o.kind === "script") return M.held;
  const a = el.getAnimations().find((x) => x.animationName === o.name);
  if (a) return (M.held = a);
  return M.held && M.held.effect && M.held.effect.target === el ? M.held : null;
}
/** Nothing to hold on to (it ended before it was opened): its animations start again, by
 *  switching them off and on in one go. */
function revive() {
  const o = M.open, el = openEl();
  if (!el || o.kind !== "css") return null;
  const off = new CSSStyleSheet();
  try {
    off.replaceSync(`${o.rs}${BOOST}${BOOST} { animation: none !important; }`);
    adopt(off, true);
    getComputedStyle(el).animationName;
  } catch {}
  adopt(off, false);
  getComputedStyle(el).animationName;
  return animOf();
}
/** It plays along a scroll, not along time: its place is a part of the scroll (a percentage),
 *  and a time in ms is refused by the browser. */
export const scrolled = (a) => !!a && !!a.timeline && typeof DocumentTimeline !== "undefined" && !(a.timeline instanceof DocumentTimeline);
/** Where in one run (0…1) the keyframes are at `p`: a script may ease the whole of it, which CSS
 *  does not (there each keyframe eases to the next). Looked for on an animation of nothing. */
function inTime(easing, p) {
  if (easing === "linear" || p <= 0 || p >= 1) return p;
  try {
    const fx = new KeyframeEffect(null, null, { duration: 1000, easing, fill: "both" }), a = new Animation(fx, document.timeline);
    a.pause();
    let from = 0, to = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (from + to) / 2;
      a.currentTime = mid * 1000;
      if (fx.getComputedTiming().progress < p) from = mid;
      else to = mid;
    }
    a.cancel();
    return to;
  } catch {
    return p;
  }
}
const backward = (t) => t.direction === "reverse" || t.direction === "alternate-reverse";
export function play() {
  if (M.open && M.open.kind === "transition") return flip();
  if (M.open && M.open.kind === "frames") return watch(); // there is nothing to play: it is looked at again
  const a = animOf() || revive();
  if (!a) return;
  a.playbackRate = M.rate;
  if (a.playState === "finished") a.currentTime = 0;
  a.play();
  kick();
}
export function pause() {
  const a = animOf();
  if (a) a.pause();
}
export const running = () => {
  if (!M.open || M.open.kind === "transition") return false;
  const a = animOf();
  return !!a && a.playState === "running";
};
export const toggle = () => (M.open && M.open.kind === "transition" ? flip() : running() ? pause() : play());
/** Show the frame at `p` (0…1 along the keyframes) and stay there. */
export function seek(p) {
  const a = animOf() || revive();
  M.pos = p = clamp(p, 0, 1);
  if (!a) return;
  if (M.open.kind === "script") p = inTime(a.effect.getTiming().easing, p);
  if (scrolled(a)) {
    try {
      a.pause();
      a.currentTime = /** @type {any} */ (CSS).percent(Math.min(backward(a.effect.getComputedTiming()) ? 1 - p : p, 0.99999) * 100);
    } catch {}
    return kick();
  }
  const t = a.effect.getComputedTiming(), dur = +t.duration || 0;
  a.pause();
  // Just short of the end: at the end itself an animation that does not hold its last frame shows nothing.
  a.currentTime = t.delay + Math.min(backward(t) ? 1 - p : p, 0.99999) * dur;
  kick();
}
/** A transition: switch its state on or off, and the page runs it. */
function flip() {
  if (!M.ro) return;
  if (!M.ro.state) return flash("Nothing in the page’s CSS says what changes this: do it on the page, and say in the note what it should do");
  M.ro.on = !M.ro.on;
  apply();
  const el = openEl();
  if (!el) return;
  getComputedStyle(el).opacity;
  for (const a of el.getAnimations()) if (a instanceof CSSTransition) a.playbackRate = M.rate;
  kick();
}
export function position() {
  const o = M.open, el = openEl();
  if (!el) return null;
  if (o.kind === "transition") {
    const ts = el.getAnimations().filter((a) => a instanceof CSSTransition);
    if (!ts.length) return M.ro.on ? 1 : 0;
    const t = Math.max(...ts.map((a) => a.currentTime || 0)) / M.ro.total;
    return clamp(M.ro.on ? t : 1 - t, 0, 1);
  }
  const a = animOf();
  if (!a) return null;
  const p = a.effect.getComputedTiming().progress;
  return p === null ? null : p;
}
/** How far through its delay what is open is (0…1), while it waits to start; null when it does
 *  not wait. */
export function waiting() {
  const o = M.open;
  if (!o || o.kind === "transition") return null;
  const a = animOf();
  if (!a || !a.effect || scrolled(a) || a.playState !== "running") return null;
  const t = a.effect.getComputedTiming(), at = +a.currentTime;
  return t.delay > 0 && at >= 0 && at < t.delay ? at / t.delay : null;
}
/** What was paused to be looked at plays again, and nothing is switched on for it: leaving
 *  motion mode leaves the page moving as it does (with the unsent edits). */
export function letGo() {
  const a = M.open && M.open.kind !== "transition" ? animOf() : null;
  if (a && a.playState === "paused") {
    a.playbackRate = 1;
    a.play();
  }
  if (M.ro && M.ro.on) M.ro.on = false;
}
