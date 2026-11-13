// Motion mode, opening and playing: what is open in the dock, and the page's own Animation
// object for it, played, paused and stopped at a frame.

import { adopt, BOOST } from "../page.js";
import { apply, clamp, DOCK_H, fromApi, M, mq, parseKf, pathOf, r1, readList, scan, serialize, splitTop } from "./model.js";
import { commit, nameProblem, snapshot } from "./edit.js";
import { draw, flash, focusLater } from "./draw.js";
import { kick } from "../render.js";

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
  apply();
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
  focusLater("[data-name]");
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
export function openScript(a) {
  const el = a.effect.target, t = a.effect.getTiming();
  setSel(el);
  M.ro = { frames: fromApi(a.effect.getKeyframes()), timing: { duration: +t.duration || 0, delay: t.delay, easing: t.easing, count: t.iterations === Infinity ? "infinite" : String(t.iterations), direction: t.direction, fill: t.fill === "auto" ? "none" : t.fill } };
  show({ kind: "script", rs: pathOf(el), name: a.id || "animate()" });
  M.held = a;
}
/** A transition has no keyframes: two values per property and the state that switches them,
 *  found in the page's own rules (`.primary:hover`). Playing it applies that rule. */
export function openTransition(el) {
  const rs = pathOf(el), cs = getComputedStyle(el);
  setSel(el);
  const col = (p) => splitTop(cs.getPropertyValue(p));
  const props = col("transition-property"), dur = col("transition-duration"), del = col("transition-delay"), ease = col("transition-timing-function");
  const at = (list, i) => list[i % list.length];
  let state = /** @type {any} */ (null);
  const walk = (list) => {
    for (const r of list) {
      if (r.cssRules && r.cssRules.length && !r.selectorText) walk(r.cssRules);
      if (!r.selectorText) continue;
      for (const s of splitTop(r.selectorText)) {
        const m = /:(hover|focus-visible|focus-within|focus|active)\b/.exec(s);
        if (!m) continue;
        try {
          if (el.matches(s.replace(m[0], ""))) state = { pseudo: m[0], css: r.style.cssText, props: [...r.style] };
        } catch {}
      }
    }
  };
  for (const s of document.styleSheets) {
    try {
      walk(s.cssRules);
    } catch {}
  }
  let items = props.map((p, i) => ({ prop: p, duration: parseFloat(at(dur, i)) * 1000, delay: parseFloat(at(del, i)) * 1000, easing: at(ease, i) })).filter((x) => x.duration > 0);
  if (state) items = items.flatMap((x) => (x.prop === "all" ? state.props.map((p) => ({ ...x, prop: p })) : [x]));
  const total = Math.max(1, ...items.map((x) => x.delay + x.duration));
  // Both ends of each property: read now, and with the state's declarations applied at once.
  const read = () => Object.fromEntries(items.map((x) => [x.prop, getComputedStyle(el).getPropertyValue(x.prop)]));
  const from = read();
  let to = from;
  if (state) {
    const probe = new CSSStyleSheet();
    try {
      probe.replaceSync(`${rs}${BOOST}${BOOST} { ${state.css}; transition: none !important; }`);
      adopt(probe, true);
      to = read();
    } catch {}
    adopt(probe, false);
    getComputedStyle(el).opacity; // settled before the transition is allowed again
  }
  const fr = new Map(), laneEase = {};
  const put = (o, p, v) => ((fr.get(o) || fr.set(o, { at: o, ease: "", vals: {} }).get(o)).vals[p] = v);
  for (const x of items) {
    put(r1((x.delay / total) * 100), x.prop, from[x.prop]);
    put(r1(((x.delay + x.duration) / total) * 100), x.prop, to[x.prop]);
    laneEase[x.prop] = x.easing;
  }
  M.ro = { frames: [...fr.values()].sort((a, b) => a.at - b.at), laneEase, state, total, on: false, items };
  show({ kind: "transition", rs, name: "transition" });
}
export function setSel(el) {
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
  if (r.bottom < 0 || r.top > window.innerHeight - DOCK_H || r.right < 0 || r.left > window.innerWidth) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  M.findUntil = performance.now() + 1400;
  kick();
}

// ── playing ──────────────────────────────────────────────────────────────────────────────
/** The page's own Animation object for what is open. One that ended without holding its last
 *  frame is no longer listed by the element, but the object still plays: it is kept. */
export function animOf() {
  const o = M.open, el = o && mq(o.rs);
  if (!el || o.kind === "transition") return null;
  if (o.kind === "script") return M.held;
  const a = el.getAnimations().find((x) => x.animationName === o.name);
  if (a) return (M.held = a);
  return M.held && M.held.effect && M.held.effect.target === el ? M.held : null;
}
/** Nothing to hold on to (it ended before it was opened): its animations start again, by
 *  switching them off and on in one go. */
function revive() {
  const o = M.open, el = o && mq(o.rs);
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
  const t = a.effect.getComputedTiming(), dur = +t.duration || 0;
  a.pause();
  // Just short of the end: at the end itself an animation that does not hold its last frame shows nothing.
  a.currentTime = t.delay + Math.min(backward(t) ? 1 - p : p, 0.99999) * dur;
  kick();
}
/** A transition: switch its state on or off, and the page runs it. */
function flip() {
  if (!M.ro || !M.ro.state) return;
  M.ro.on = !M.ro.on;
  apply();
  const el = mq(M.open.rs);
  if (!el) return;
  getComputedStyle(el).opacity;
  for (const a of el.getAnimations()) if (a instanceof CSSTransition) a.playbackRate = M.rate;
  kick();
}
export function position() {
  const o = M.open, el = o && mq(o.rs);
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
