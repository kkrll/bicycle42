// Motion mode, opening and playing: what is open in the dock, and the page's own Animation
// object for it, played, paused and stopped at a frame.

import { adopt, BOOST } from "../page.js";
import { apply, clamp, fromApi, M, mq, parseKf, pathOf, r1, readList, scan, serialize, splitTop } from "./model.js";
import { commit, nameProblem, snapshot } from "./edit.js";
import { draw, flash } from "./draw.js";
import { kick } from "../render.js";
import { statesOf, styleRules } from "./states.js";
import { restage } from "./stage.js";
import { above, drop, isOn, keep, namedStates, parseTrigger, put, wears } from "./trigger.js";
import { forgetRecording } from "./record.js";

// ── opening one ──────────────────────────────────────────────────────────────────────────
function baseFor(rs, el) {
  for (const u of M.use.values()) if (u.rs === rs) return u.base;
  return readList(el);
}
export function show(open) {
  // What was stopped at a frame to be looked at goes on from there: nothing stays frozen behind.
  const was = M.open && M.open.kind !== "transition" ? animOf() : null;
  if (M.rec && !(open && open.kind === "transition" && open.rs === M.rec.rs)) forgetRecording();
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
/** How a script's animation plays, as changed here: written into the animation itself (there is
 *  no rule to write over), and taken out again when it is left unsent. */
export function applyScript(timing = M.ro && M.ro.timing) {
  const a = M.held;
  if (!a || !a.effect || !a.effect.updateTiming || !timing) return;
  try {
    a.effect.updateTiming({ duration: +timing.duration || 0, delay: +timing.delay || 0, easing: timing.easing, iterations: timing.count === "infinite" ? Infinity : +timing.count || 0, direction: timing.direction, fill: timing.fill });
  } catch {}
}
export const scriptDirty = () => !!M.open && M.open.kind === "script" && !!M.ro && !!M.ro.orig && JSON.stringify(M.ro.timing) !== M.ro.orig;
export function openScript(a) {
  const el = a.effect.target;
  setSel(el);
  const t = a.effect.getTiming();
  M.ro = { orig: "", frames: fromApi(a.effect.getKeyframes()), timing: { duration: +t.duration || 0, delay: t.delay, easing: t.easing, count: t.iterations === Infinity ? "infinite" : String(t.iterations), direction: t.direction, fill: t.fill === "auto" ? "none" : t.fill } };
  M.ro.orig = JSON.stringify(M.ro.timing);
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
  if (M.ro && M.ro.on) {
    // (What is on the page of the one that was open goes before this one is read.)
    M.ro.on = false;
    apply();
  }
  M.ro = { items, orig: mine ? mine.orig : JSON.stringify(page), moves, above: above(el), states: [], trigIs: "", state: null, vals: null, frames: [], laneEase: {}, total: 1, on: false };
  readStates(el, rs);
  setState(firstState(), el);
  show({ kind: "transition", rs, name: "transition" });
}
/** The states of the open transition: those the page's rules say, and those the reviewer named (a
 *  named one is in the place of one found that is called the same). */
function readStates(el, rs) {
  const ro = M.ro, rules = styleRules(), named = namedStates(el, rs, ro.moves, rules);
  ro.states = [...statesOf(el, ro.moves, rules).filter((s) => !named.some((n) => n.label === s.label)), ...named];
  ro.trigIs = JSON.stringify(M.trig.get(rs) || []);
}
/** The state looked at first: the one that is, else hover, else the first. */
const firstState = (want = "") => (M.ro.states.find((s) => s.label === want) || M.ro.states.find((s) => s.label === "hover") || M.ro.states[0] || { label: "" }).label;
/** What the reviewer says switches the open transition, typed (`.open`, `[data-state=open]`,
 *  `:hover`), on the element or the parent at `on`: a state of it, looked at at once. */
export function addTrigger(text, on) {
  const o = M.open, el = openEl();
  if (!o || o.kind !== "transition" || !M.ro || !el) return false;
  const t = parseTrigger(text);
  if (typeof t === "string") return flash(t);
  const at = on ? mq(on) : el;
  if (!at || (on && (at === el || !at.contains(el)))) return flash("That parent is not on the page any more");
  const label = keep(o.rs, { ...t, on: on || "", by: "named" });
  if (!label) return flash("Six triggers at most: take one away first");
  readStates(el, o.rs);
  setState(label, el);
  commit();
  if (still()) flash(`${label} changes nothing here: Play shows nothing, but the note will name it`);
  return true;
}
export function removeTrigger(label) {
  const o = M.open, el = openEl(), was = M.ro && M.ro.state ? M.ro.state.label : "";
  if (!o || o.kind !== "transition" || !M.ro || !el || !drop(o.rs, label)) return;
  readStates(el, o.rs);
  setState(firstState(was), el);
  commit();
}
/** What a recording found to have started the open transition: the first of these changes that,
 *  tried, changes what ran; else those made to one element together (a class taken off and another
 *  put on). What it is called as a state, or "". */
export function addRecorded(changes, runs) {
  const o = M.open, el = openEl(), props = [...new Set(runs.map((r) => r.prop))];
  if (!el) return "";
  const read = () => props.map((p) => getComputedStyle(el).getPropertyValue(p)).join("|");
  const does = (t) => {
    const { from, to } = ends(el, { trigger: t, css: "" }, read);
    return from !== to;
  };
  const plain = ({ at: _, ...t }) => t;
  const worn = ["class", "attr"].flatMap((k) => changes.filter((c) => c.kind === k)).map(plain), seen = new Set(), tries = [];
  for (const t of worn) {
    const id = `${t.on}|${t.kind}|${t.name}`;
    if (seen.has(id)) continue; // (a nearer one of it is there)
    seen.add(id);
    tries.push(t);
  }
  let t = tries.slice(0, 8).find(does);
  for (const on of t ? [] : new Set(tries.map((x) => x.on))) {
    const [first, ...and] = tries.filter((x) => x.on === on).slice(0, 6);
    if (and.length && does({ ...first, and })) t = { ...first, and };
    if (t) break;
  }
  if (!t && changes.some((c) => c.kind === "style")) {
    const vals = {}, camel = (p) => (p.startsWith("--") ? p : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
    for (const r of runs) if (r.kf && r.kf.length > 1) vals[r.prop] = [String(r.kf[0][camel(r.prop)]), String(r.kf[r.kf.length - 1][camel(r.prop)])];
    if (Object.keys(vals).length) t = { kind: "style", name: "style", on: "", vals };
  }
  const label = t ? keep(o.rs, { ...t, by: "recorded" }) : "";
  if (!label) return "";
  readStates(el, o.rs);
  setState(label, el);
  return label;
}
/** The open state's two ends are the same. */
const still = () => !!M.ro && !!M.ro.vals && laid().every((x) => M.ro.vals.from[x.prop] === M.ro.vals.to[x.prop]);
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
  // (A trigger says nothing of its properties: which of all there are change is seen once it is on.)
  const t = state && state.trigger, at = t && wears(t) ? mq(t.on || rs) : null, look = at && ro.items.some((x) => x.prop === "all") ? everything : null;
  const read = () => (look ? look(el) : Object.fromEntries(laid().map((x) => [x.prop, getComputedStyle(el).getPropertyValue(x.prop)])));
  if (at) state.off = isOn(t, at); // (on now: the state is without it)
  if (state) ro.vals = ends(el, state, read);
  else {
    const now = read();
    ro.vals = { from: now, to: now };
  }
  if (look) state.props = differs(ro.vals.from, ro.vals.to);
  layout();
}
/** What `read` says of `el` now, and in the state. Nothing is left of it, and nothing moves for it. */
function ends(el, state, read) {
  const t = state.trigger, rs = pathOf(el), at = wears(t) ? mq(t.on || rs) : null, probe = new CSSStyleSheet();
  // (What a trigger changes is not only the element: nothing anywhere may move.)
  const hold = at ? `*${BOOST}, *${BOOST}::before, *${BOOST}::after { transition: none !important; }` : `${rs}${BOOST}${BOOST} { transition: none !important; }`;
  let from = null, to = null, undo = null;
  try {
    probe.replaceSync(hold);
    adopt(probe, true);
    from = read(); // (with the transition off: where it is, not where it is on its way from)
    if (at) undo = put(t, at);
    else probe.replaceSync(`${rs}${BOOST}${BOOST} { ${state.css}; transition: none !important; }`);
    to = read();
    // Back as it was with the transition still off, and only then is it allowed again: taken
    // away in one go, the element would run its transition back from the state it never was in.
  } catch {}
  if (undo) undo();
  try {
    probe.replaceSync(hold);
    getComputedStyle(el).opacity;
    if (at) document.getAnimations(); // (the whole page's styles, worked out while nothing may move)
  } catch {}
  adopt(probe, false);
  getComputedStyle(el).opacity;
  from = from ?? read();
  return { from, to: to ?? from };
}
/** Every property of the element, as it is. */
function everything(el) {
  const cs = getComputedStyle(el), out = {};
  for (let i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]);
  return out;
}
// Said twice (a logical name for the same side), worked out from another, or not moved between values.
const ECHO = /^(--|-webkit-|block-size|inline-size|(min|max)-(block|inline)-size|inset-|(margin|padding|border)-(block|inline)|border-(start|end)-|overflow-(block|inline)|perspective-origin|transform-origin|transition|animation|display$|content-visibility)/;
/** The properties that are not the same in both, without those that only follow the colour. */
function differs(from, to) {
  const all = Object.keys(from).filter((p) => from[p] !== to[p] && !ECHO.test(p));
  const ink = all.includes("color");
  return all.filter((p) => !(ink && p !== "color" && /color$/.test(p) && from[p] === from.color && to[p] === to.color)).slice(0, 12);
}
/** The properties the open transition has a lane for: `all` is those its state sets. */
export function laid() {
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
  const el = openEl();
  if (!el || JSON.stringify(M.trig.get(o.rs) || []) === ro.trigIs) return layout();
  // A trigger came back or went: it is looked at again, or what was looked at before it.
  const was = ro.states.map((s) => s.label);
  readStates(el, o.rs);
  const back = ro.states.find((s) => s.trigger && !was.includes(s.label));
  setState(firstState(back ? back.label : ro.state ? ro.state.label : ""), el);
}
export function setSel(el) {
  // A script's animation changed here and left unsent plays as the page's script made it again.
  if (scriptDirty()) {
    M.ro.timing = JSON.parse(M.ro.orig);
    applyScript();
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
export function openEl() {
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
const backward = (t) => t.direction === "reverse" || t.direction === "alternate-reverse";
export function play() {
  if (M.open && M.open.kind === "transition") return flip();
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
  if (M.rec) return flash("Recording: do it on the page, then Stop");
  if (!M.ro.state) return flash("Nothing in the page’s CSS says what changes this: add what triggers it, or say in the note what it should do");
  M.ro.on = !M.ro.on;
  apply();
  const el = openEl();
  if (!el) return;
  getComputedStyle(el).opacity;
  // (A trigger moves more than the element: all of it at the speed chosen.)
  for (const a of M.worn ? M.worn.at.getAnimations({ subtree: true }) : el.getAnimations()) if (a instanceof CSSTransition) a.playbackRate = M.rate;
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
  forgetRecording();
  const a = M.open && M.open.kind !== "transition" ? animOf() : null;
  if (a && a.playState === "paused") {
    a.playbackRate = 1;
    a.play();
  }
  if (!M.ro || !M.ro.on) return;
  // The state goes off, a trigger with it, and what runs back for it is at its end at once: the
  // page is used, or its screenshot taken, as it was.
  const before = new Set(document.getAnimations());
  M.ro.on = false;
  apply();
  for (const x of document.getAnimations()) if (x instanceof CSSTransition && !before.has(x)) x.finish();
}
