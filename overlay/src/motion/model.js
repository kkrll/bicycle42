import { adopt, BOOST, plainLabel, SKIP, unique } from "../page.js";
import { hostEl, root } from "../mount.js";

// ── motion mode ─────────────────────────────────────────────────────────────────────────────
// The reviewer looks at what moves on the page and changes it: an animation's keyframes, and
// how one element plays them (duration, delay, easing, repeats, what starts it). One animation
// is one note. As in canvas mode, previews are rules in a constructed stylesheet the page
// adopts, never inline styles; playback is the browser's own (the Web Animations API pauses and
// seeks the page's animations), so what is seen is what ships. Three rules:
//  - keyframes belong to their name and to every element that plays them; how they are played
//    belongs to each element. So two maps (`kf` by name, `use` by element and name), both plain
//    data: undo is a stack of their JSON, and so is the draft the host keeps;
//  - a sent animation's rules move to a stylesheet of their own, which stays applied until its
//    pin is done, failed or stopped (or the page reloads), as a sent canvas batch does;
//  - the dock (the host's, host.js) is told that data; nothing in it is state of its own but
//    what is open.
// Motion mode is a module: the rest of the overlay sees only its api (in api.js), and its
// names stay out of the canvas code's way.
//
// The files of motion/ share one scope. This one holds the constants, the state M, and the model:
// elements of the page, keyframes as text, how an element plays them, applying, what moves here.
export const EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier(0.2, 0.8, 0.2, 1)", "cubic-bezier(0.34, 1.56, 0.64, 1)", "steps(4, end)"];
export const PROPS = ["opacity", "transform", "translate", "scale", "rotate", "background-color", "color", "border-color", "box-shadow", "filter", "backdrop-filter", "clip-path",
  "width", "height", "max-height", "top", "left", "border-radius", "letter-spacing", "background-position", "stroke-dashoffset"];
// What starts it: the agent wires this up in code; here it plays when Play is pressed.
export const HOW = { asnow: "As now", load: "On load", view: "In view", hover: "On hover", click: "On click", appear: "On appear", scroll: "On scroll" };
// The choices for how it plays, as [label, what it means]; the key is the CSS value.
export const COUNT = { 1: ["Once"], 2: ["2×"], 3: ["3×"], infinite: ["Forever"] };
export const DIRECTION = { normal: ["Forward"], reverse: ["Backward", "From the last keyframe to the first"], alternate: ["Alternate", "Forward, then backward, and so on"],
  "alternate-reverse": ["Alt. reverse", "Backward, then forward, and so on"] };
export const FILL = { none: ["None", "Before it starts and after it ends, the element looks as it does without it"], forwards: ["Hold end", "After it ends, it stays on the last keyframe"],
  backwards: ["Hold start", "During the delay, it waits on the first keyframe"], both: ["Hold both", "Waits on the first keyframe, stays on the last"] };
export const RATES = [1, 0.5, 0.25, 0.1];
export const RATE_TEXT = { 1: "1×", 0.5: "½×", 0.25: "¼×", 0.1: "⅒×" };
export const MAX_KF = 4000; // the keyframes' text, as the host takes it
/** Elements looked at in one scan. A page with more is looked at in part, and says so. */
const MAX_ELS = 4000;
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const r1 = (n) => Math.round(n * 10) / 10;
export const ms = (n) => `${Math.round(n)}ms`;
/** What a scan finds on a page nothing moves on (and what is known of any page while motion mode
 *  is off: nothing). */
const nothing = () => ({ anims: [], unused: [], idle: [], transitions: [], trRules: [], scripts: [], rules: new Map(), partial: false });
export const M = {
  on: false,
  sel: null, selRs: "", hover: null,
  kf: new Map(), // name → { name, frames: [{ at, ease, vals: { prop: value } }], orig, isNew }
  tr: new Map(), // an element's transition as changed here: selector → { rs, items: [{ prop, duration, delay, easing }], orig: the page's items, as JSON }
  use: new Map(), // "selector|name" → { rs, name, timing, orig, plays: { how, words }, base, index, isNew, from? }
  open: null, // what is open: { kind: "css" | "script" | "transition" | "frames", rs, name }
  ro: null, // for the kinds that are not rules: { frames, timing?, laneEase?, state?, total?, on?, items?, seen?; a script's: see readScript }
  key: null, // the selected keyframe: { at, prop } (prop null: the whole keyframe)
  lanes: [], // the properties, in the order their lanes were first drawn
  isolate: false, rate: 1, loop: false, loopAt: 0, pos: 0,
  stageBg: "", // the stage's backdrop as chosen ("light" or "dark"; "": the page's own), and which of the two is shown
  stageLook: "light",
  stageCss: "", // where the isolated element is put and what is behind it, as rules (stage.js)
  past: [], future: [], snap: "",
  held: null, // the page's Animation object for what is open
  // What moves on the page, as last looked at; it holds the page's elements, so it is kept only
  // while motion mode is on (forget).
  scan: nothing(),
  suspects: new Set(), // elements whose inline style changes many times a second (while they are in the page)
  list: null, listTree: -1, // the list's rows as read from the page, kept until it is looked at again or elements came or went (edit.js: rows)
  sheet: null, // the unsent edits, as rules
  // [{ id, sheet, seen, n, undo: [{ x, index, entry }] }]: applied until the pin is done. seen:
  // its pin has been listed; n: the pin's number, null until it has one; undo: the element's
  // other uses x whose base had this one's entry written in at index, and the entry they had.
  sent: [],
  unsent: null, // what the animation being sent was, until the host takes it
  view: "keys", // the timeline, or the keyframes as text
  rowEls: null, // the elements of the list row under the pointer
  drag: null, findUntil: 0, obs: null,
  msg: "", msgTimer: 0, done: "", doneTimer: 0,
  note: "", // the words that go with the open animation, as typed in the host's dock
  // The host's dock (host.js): the view without its clock as last built (null: to be built
  // again), a view asked for in this task, why the keyframes' text is not keyframes. And the
  // fields of the view that are objects, as last built, to be the next view's too when they say
  // the same (a field that is the same object is not sent again): the clock (and what it says,
  // as text), the list's rows (and the rows read from the page they were made from, by index:
  // what "row" and "hover" name), what is open (and what it says, as text), the names, the choices (and the properties of what
  // is open they were made for).
  hostBody: null, hostQueued: false, cssWhy: "",
  hostClock: "", hostClockIs: null, hostRows: [], hostBase: [], hostOpen: null, hostOpenIs: "", hostNames: [], hostChoices: null, hostLanes: "",
};

// ── elements of the page ─────────────────────────────────────────────────────────────────
export const mq = (rs) => {
  try {
    return rs ? document.querySelector(rs) : null;
  } catch {
    return null;
  }
};
/** A path from the body: no class names, so it also names the elements our own rules are for. */
export function pathOf(el) {
  const parts = [];
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    if (cur === document.body || cur === document.documentElement) {
      parts.unshift(cur.localName);
      break;
    }
    if (cur.id && unique(`#${CSS.escape(cur.id)}`)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    let seg = CSS.escape(cur.localName);
    const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
    if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
    parts.unshift(seg);
  }
  return parts.join(" > ");
}
/** "Heading · Ship calmer…", or with short only the words (the kind when there are none). */
export const name = (el, short = false) => {
  if (!el) return "(gone)";
  const s = plainLabel(el, 28);
  const i = s.indexOf(" · ");
  if (i > 0) return short ? s.slice(i + 3) : s;
  // No words: its first class says more than "Block" does.
  const cls = (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\s+/)[0];
  return cls ? (short ? `.${cls}` : `${s} · .${cls}`) : s;
};
export const splitTop = (s, sep = ",") => {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === sep && !depth) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
};

// ── keyframes as text ────────────────────────────────────────────────────────────────────
// Not a CSS parser: it finds the keyframe blocks and cuts their declarations, and the browser
// says whether a value is one. Shorthands stay as they were typed.
export function parseKf(text) {
  const t = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
  const m = /@keyframes\s+([^\s{]+)\s*\{/.exec(t);
  if (!m) return { error: "No @keyframes rule" };
  const at = new Map();
  let i = m.index + m[0].length, closed = false;
  while (i < t.length) {
    const open = t.indexOf("{", i), close = t.indexOf("}", i);
    if (close >= 0 && (open < 0 || close < open)) {
      closed = true;
      break;
    }
    if (open < 0) break;
    const end = t.indexOf("}", open);
    if (end < 0) return { error: "A brace is open" };
    const offsets = t.slice(i, open).split(",").map((s) => s.trim()).map((s) => (s === "from" ? 0 : s === "to" ? 100 : /^\d*\.?\d+%$/.test(s) ? parseFloat(s) : NaN));
    if (!offsets.length || offsets.some((o) => !(o >= 0 && o <= 100))) return { error: `“${t.slice(i, open).trim().slice(0, 24)}” is not a keyframe` };
    for (const o of offsets) {
      const f = at.get(o) || at.set(o, { at: o, ease: "", vals: {} }).get(o);
      for (const d of splitTop(t.slice(open + 1, end), ";")) {
        const c = d.indexOf(":");
        if (c < 1) return { error: `“${d.slice(0, 24)}” is not a declaration` };
        const prop = d.slice(0, c).trim().toLowerCase(), value = d.slice(c + 1).trim();
        if (prop === "animation-timing-function") f.ease = value;
        else if (value) f.vals[prop] = value;
      }
    }
    i = end + 1;
  }
  if (!closed) return { error: "A brace is open" };
  return { name: m[1], frames: [...at.values()].sort((a, b) => a.at - b.at) };
}
export function serialize(nm, frames) {
  const body = frames.map((f) => {
    const d = Object.entries(f.vals).map(([p, v]) => `${p}: ${v};`);
    if (f.ease) d.push(`animation-timing-function: ${f.ease};`);
    return `  ${r1(f.at)}% { ${d.join(" ")} }`;
  });
  return `@keyframes ${nm} {\n${body.join("\n")}\n}`;
}
/** Keyframes as the Web Animations API gives them (a script's, or a stylesheet we may not read). */
export function fromApi(list) {
  const kebab = (s) => (s.startsWith("--") ? s : s === "cssFloat" ? "float" : s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
  return list.map((k) => {
    const vals = {};
    for (const p in k) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) vals[kebab(p)] = String(k[p]);
    return { at: r1(k.computedOffset * 100), ease: k.easing && k.easing !== "linear" ? k.easing : "", vals };
  });
}
/** A property's name as the Web Animations API has it. */
export const apiName = (p) => (p.startsWith("--") ? p : p === "float" ? "cssFloat" : p === "offset" ? "cssOffset" : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
/** …and the keyframes as it takes them: fromApi's way back. */
export const toApi = (list) => list.map((f) => ({ ...Object.fromEntries(Object.entries(f.vals).map(([p, v]) => [apiName(p), v])), offset: f.at / 100, easing: f.ease || "linear", ...(f.composite ? { composite: f.composite } : {}) }));
/** Keyframes of a script's animation, to be compared: what order a keyframe's properties were
 *  set in is not a difference. */
export const kfIs = (list) => JSON.stringify(list.map((f) => [f.at, f.ease, f.composite || "", Object.entries(f.vals).sort()]));
export function entryCss(e) {
  const out = [e.name, ms(e.duration)];
  if (e.easing !== "ease") out.push(e.easing);
  if (e.delay) out.push(ms(e.delay));
  if (String(e.count) !== "1") out.push(e.count);
  if (e.direction !== "normal") out.push(e.direction);
  if (e.fill !== "none") out.push(e.fill);
  return out.join(" ");
}

// ── how an element plays its animations ──────────────────────────────────────────────────
export function readList(el) {
  const cs = getComputedStyle(el);
  const names = splitTop(cs.animationName);
  if (names.length === 1 && names[0] === "none") return [];
  const col = (p) => splitTop(cs.getPropertyValue(p));
  const dur = col("animation-duration"), del = col("animation-delay"), ease = col("animation-timing-function"), n = col("animation-iteration-count"),
    dir = col("animation-direction"), fill = col("animation-fill-mode");
  const at = (list, i) => list[i % list.length];
  return names.map((nm, i) => ({ name: nm, duration: Math.round(parseFloat(at(dur, i)) * 1000) || 0, delay: Math.round(parseFloat(at(del, i)) * 1000) || 0,
    easing: at(ease, i), count: at(n, i), direction: at(dir, i), fill: at(fill, i) }));
}
export const kfDirty = (k) => !!k && (k.isNew || serialize(k.name, k.frames) !== k.orig);
export const useDirty = (u) => !!u && (u.isNew || !!u.from || JSON.stringify(u.timing) !== JSON.stringify(u.orig));
export const trDirty = (t) => !!t && JSON.stringify(t.items) !== t.orig;
export const trCss = (items) => items.map((x) => `${x.prop} ${ms(x.duration)} ${x.easing}${x.delay ? ` ${ms(x.delay)}` : ""}`).join(", ");
export const playsDirty = (u) => !!u && (u.plays.how !== "asnow" || !!u.plays.words.trim());
export const openKf = () => (M.open && M.open.kind === "css" ? M.kf.get(M.open.name) : null);
export const openUse = () => (M.open && M.open.kind === "css" ? M.use.get(`${M.open.rs}|${M.open.name}`) : null);
export const frames = () => (openKf() ? openKf().frames : M.ro ? M.ro.frames : []);
/** The open script's animation as read from the page and changed here (readScript in open.js). */
export const openScr = () => (M.open && M.open.kind === "script" && M.ro && M.ro.raw ? M.ro : null);
/** What is open that has keyframes to change: a rule's, or those of a script's animation. */
export const editKf = () => openKf() || openScr();
export const scriptDirty = () => {
  const sc = openScr();
  return !!sc && (JSON.stringify(sc.timing) !== sc.orig || kfIs(sc.frames) !== sc.origKf);
};
export const readOnly = () => !!M.open && M.open.kind !== "css" && !openScr();
/** Anything unsent: an edit, or how it starts. */
export const anyDirty = () => [...M.kf.values()].some(kfDirty) || [...M.use.values()].some((u) => useDirty(u) || playsDirty(u)) || [...M.tr.values()].some(trDirty);
/** The open animation has something to send. */
export const openDirty = () => {
  if (M.open && M.open.kind === "transition") return trDirty(M.tr.get(M.open.rs));
  if (M.open && M.open.kind === "script") return scriptDirty();
  const u = openUse();
  return !!u && (useDirty(u) || playsDirty(u) || kfDirty(openKf()));
};

// ── applying ─────────────────────────────────────────────────────────────────────────────
// Everything changed and not sent, as one stylesheet text. A `@keyframes` of the same name in an
// adopted sheet wins over the page's own, and the animation that is running (or paused at a
// frame) takes the new keyframes without starting over: that is what makes editing live.
function rulesText() {
  const out = [];
  for (const k of M.kf.values()) if (kfDirty(k)) out.push(serialize(k.name, k.frames));
  const by = new Map();
  for (const u of M.use.values()) if (useDirty(u)) (by.get(u.rs) || by.set(u.rs, []).get(u.rs)).push(u);
  for (const [rs, list] of by) {
    // The whole list is written, with only these animations' entries replaced: the element's
    // other animations keep playing.
    const entries = list[0].base.map((e) => ({ ...e }));
    for (const u of list) entries[u.index] = { name: u.name, ...u.timing };
    out.push(`${rs}${BOOST} { animation: ${entries.filter(Boolean).map(entryCss).join(", ")}; }`);
  }
  for (const t of M.tr.values()) if (trDirty(t)) out.push(`${t.rs}${BOOST} { transition: ${trCss(t.items)}; }`);
  if (M.on && M.ro && M.ro.on && M.ro.state) out.push(`${M.open.rs}${BOOST} { ${M.ro.state.css} }`);
  if (M.on && M.isolate && M.selRs) out.push(`body *:not(${M.selRs}, ${M.selRs} *) { visibility: hidden !important; }`, `${M.selRs} { visibility: visible !important; }`, M.stageCss);
  return out.join("\n");
}
export function apply() {
  const text = rulesText();
  if (!M.sheet) {
    if (!text) return;
    M.sheet = new CSSStyleSheet();
  }
  // The unsent edits come after every sent one: they are newer.
  adopt(M.sheet, false);
  adopt(M.sheet, !!text);
  if (text === M.sheet._text) return;
  M.sheet._text = text;
  try {
    M.sheet.replaceSync(text);
  } catch {}
}

// ── what moves on this page ──────────────────────────────────────────────────────────────
/** Motion mode is off: none of the page's elements are kept for it. A page that goes on
 *  re-rendering would otherwise have its old elements held here for as long as it lives. */
export function forget() {
  M.scan = nothing();
  M.suspects.clear();
  M.list = null;
}
/** Keyframes no element plays now, in two: those a rule of the page plays (`idle`, with the
 *  rule's selector: on hover, in a state, on a ::before, on an element not in the page yet), and
 *  those nothing speaks of (`unused`). A name set in a custom property (`--animate-draw: draw
 *  700ms`) is played by the rule whose animation reads that property. */
function idleOrUnused(names, says) {
  const idle = [], unused = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const n of names) {
    const word = `(?<![\\w-])${esc(n)}(?![\\w-])`;
    const direct = new RegExp(`(?:^|;)\\s*animation(?:-name)?\\s*:[^;]*${word}`), viaVar = new RegExp(`(?:^|;)\\s*(--[\\w-]+)\\s*:[^;]*${word}`);
    let on = "";
    for (const [sel, t] of says) {
      if (direct.test(t)) on = sel;
      else {
        const m = viaVar.exec(t);
        if (!m) continue;
        const reads = new RegExp(`(?:^|;)\\s*animation(?:-name)?\\s*:[^;]*var\\(\\s*${esc(m[1])}(?![\\w-])`);
        const by = says.find(([, x]) => reads.test(x));
        if (by) on = by[0];
      }
      if (on) break;
    }
    if (on) idle.push({ name: n, on });
    else unused.push(n);
  }
  return { idle, unused };
}
/** Looks at the page (while motion mode is on: off, there is no one to look for). */
export function scan() {
  if (!M.on) return forget();
  const rules = new Map(); // name → the @keyframes rule that wins (the last one)
  const says = []; // [selector, declarations] of the rules that speak of an animation or set a custom property
  const trRules = []; // the selectors of the rules that declare a transition, in the page's order
  const walk = (list) => {
    for (const r of list) {
      if (r instanceof CSSKeyframesRule) rules.set(r.name, r);
      else {
        if (r.selectorText && r.style) {
          const t = r.style.cssText;
          if (t.includes("animation") || t.includes("--")) says.push([r.selectorText, t]);
          if (t.includes("transition")) trRules.push(r.selectorText);
        }
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
      }
    }
  };
  for (const s of document.styleSheets) {
    try {
      walk(s.cssRules);
    } catch {} // another origin's stylesheet: its animations are still read, through the API
  }
  for (const b of M.sent) walk(b.sheet.cssRules); // what was sent is what the page plays now
  const anims = new Map(), transitions = []; // anims: name → the elements that play it (a Set, in the order found)
  const plays = (nm, el) => (anims.get(nm) || anims.set(nm, new Set()).get(nm)).add(el);
  const all = document.body ? document.body.getElementsByTagName("*") : [];
  // A very large page is looked at in part: each element costs a computed style.
  const partial = all.length > MAX_ELS;
  for (let i = 0; i < all.length && i < MAX_ELS; i++) {
    const el = all[i];
    if (el === hostEl || SKIP.test(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.animationName !== "none") for (const nm of splitTop(cs.animationName)) plays(nm, el);
    if (cs.transitionProperty !== "none" && splitTop(cs.transitionDuration).some((d) => parseFloat(d) > 0)) transitions.push(el);
  }
  const live = /** @type {any[]} */ (document.getAnimations());
  // Past where the look stopped, what plays now (or holds a frame) is still found: the page lists
  // its animations whatever its size. What is left out there is what has ended and holds
  // nothing, and transitions; so keyframes no element was seen to play are not known to be
  // unused (`partial`, which the list and the dock say).
  if (partial)
    for (const a of live) {
      const el = a instanceof CSSAnimation && a.effect && !(/** @type {any} */ (a.effect).pseudoElement) ? /** @type {any} */ (a.effect).target : null;
      if (el && el.isConnected && el.getRootNode() === document && !SKIP.test(el.tagName)) plays(a.animationName, el);
    }
  const running = new Set(live.filter((a) => a.playState === "running" && a.animationName).map((a) => a.animationName));
  M.list = null; // the list is of the page as it was looked at before
  M.scan = {
    rules,
    partial,
    anims: [...anims].map(([nm, els]) => ({ name: nm, els: [...els], running: running.has(nm) })),
    // (A page looked at in part: what was not seen to play is one list, as no more is known of it.)
    ...idleOrUnused([...rules.keys()].filter((n) => !anims.has(n)), partial ? [] : says),
    transitions,
    trRules,
    scripts: live.filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect && a.effect.target && a.effect.target.getRootNode() !== root),
  };
}
