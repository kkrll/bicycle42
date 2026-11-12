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
//  - the dock is drawn from that data; nothing in it is state of its own but what is open.
// Motion mode is a module: the rest of the overlay sees only its api (in input.js), and its
// names stay out of the canvas code's way.
//
// The files of motion/ share one scope. This one holds the constants, the state M, and the model:
// elements of the page, keyframes as text, how an element plays them, applying, what moves here.
const EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier(0.2, 0.8, 0.2, 1)", "cubic-bezier(0.34, 1.56, 0.64, 1)", "steps(4, end)"];
const PROPS = ["opacity", "transform", "translate", "scale", "rotate", "background-color", "color", "border-color", "box-shadow", "filter", "backdrop-filter", "clip-path",
  "width", "height", "max-height", "top", "left", "border-radius", "letter-spacing", "background-position", "stroke-dashoffset"];
// What starts it: the agent wires this up in code; here it plays when Play is pressed.
const HOW = { asnow: "As now", load: "On load", view: "In view", hover: "On hover", click: "On click", appear: "On appear", scroll: "On scroll" };
// The choices for how it plays, as [label, what it means]; the key is the CSS value.
const COUNT = { 1: ["Once"], 2: ["2×"], 3: ["3×"], infinite: ["Forever"] };
const DIRECTION = { normal: ["Forward"], reverse: ["Backward", "From the last keyframe to the first"], alternate: ["Alternate", "Forward, then backward, and so on"],
  "alternate-reverse": ["Alt. reverse", "Backward, then forward, and so on"] };
const FILL = { none: ["None", "Before it starts and after it ends, the element looks as it does without it"], forwards: ["Hold end", "After it ends, it stays on the last keyframe"],
  backwards: ["Hold start", "During the delay, it waits on the first keyframe"], both: ["Hold both", "Waits on the first keyframe, stays on the last"] };
const RATES = [1, 0.5, 0.25, 0.1];
const RATE_TEXT = { 1: "1×", 0.5: "½×", 0.25: "¼×", 0.1: "⅒×" };
const MAJOR = [50, 100, 200, 250, 500, 1000, 2000, 5000];
const DOCK_H = 360;
const MAX_KF = 4000; // the keyframes' text, as the host takes it
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const r1 = (n) => Math.round(n * 10) / 10;
const ms = (n) => `${Math.round(n)}ms`;
const secs = (n) => `${+(n / 1000).toFixed(2)}s`;
const MI = {
  play: '<path d="M5 3.2v9.6L12.5 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  loop: '<path d="M3 7.5V7a3 3 0 0 1 3-3h7"/><path d="m11 2 2 2-2 2"/><path d="M13 8.5V9a3 3 0 0 1-3 3H3"/><path d="m5 14-2-2 2-2"/>',
  iso: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5"/>',
  reset: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  more: '<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/>',
  link: '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5"/><path d="M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5"/>',
};
const mi = (name, size = 16) => (ICONS[name] ? icon(name, size)
  : `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MI[name]}</svg>`);
// What kind of motion a row is (24 grid, drawn at 16): a keyframe animation is a ball leaving
// echoes; a transition goes from one state to another; a script's ball is in braces; frame by
// frame is three discrete steps; keyframes nothing plays are the ball as an outline.
const K = "currentColor";
const TRAIL = `<rect x="6" y="9" width="12" height="1" rx="0.5" fill="${K}"/><rect x="3.5" y="11.5" width="12" height="1" rx="0.5" fill="${K}"/><rect x="6" y="14" width="12" height="1" rx="0.5" fill="${K}"/>
  <path d="M10 17.3A6.2 6.2 0 0 1 7.12 18C3.74 18 1 15.31 1 12s2.74-6 6.12-6c1.04 0 2.02.25 2.88.7" stroke="${K}"/>
  <path d="M15 17.3c-.86.45-1.84.7-2.88.7-1.81 0-3.44-.77-4.56-2M15 6.7A6.2 6.2 0 0 0 12.13 6c-1.81 0-3.44.77-4.56 2" stroke="${K}"/>`;
const KIND = {
  css: `${TRAIL}<circle cx="18" cy="12" r="5.5" fill="${K}" stroke="${K}"/>`,
  unused: `${TRAIL}<circle cx="18" cy="12" r="5.5" fill="#161617" stroke="${K}"/>`,
  transition: `<circle cx="7.5" cy="12" r="5.5" stroke="${K}"/><circle cx="16.5" cy="12" r="5.5" fill="${K}" stroke="${K}"/>`,
  script: `<path d="M6 5.5c-1.7 0-2.5.8-2.5 2.5v1.5c0 1.3-.7 2.5-2 2.5 1.3 0 2 1.2 2 2.5V16c0 1.7.8 2.5 2.5 2.5M18 5.5c1.7 0 2.5.8 2.5 2.5v1.5c0 1.3.7 2.5 2 2.5-1.3 0-2 1.2-2 2.5V16c0 1.7-.8 2.5-2.5 2.5" stroke="${K}" stroke-linecap="round"/><circle cx="12" cy="12" r="4" fill="${K}"/>`,
  frames: `<circle cx="4.5" cy="12" r="3" stroke="${K}"/><circle cx="12" cy="12" r="3" stroke="${K}"/><circle cx="19.5" cy="12" r="3" fill="${K}" stroke="${K}"/>`,
};
const KIND_TITLE = { css: "Keyframes", unused: "Keyframes nothing plays", transition: "Transition", script: "Script (animate())", frames: "Moved by a script, frame by frame" };
const kindIcon = (kind) => `<svg class="m-kind" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">${KIND[kind] || KIND.css}</svg>`;

const M = {
  on: false,
  sel: null, selRs: "", hover: null,
  kf: new Map(), // name → { name, frames: [{ at, ease, vals: { prop: value } }], orig, isNew }
  use: new Map(), // "selector|name" → { rs, name, timing, orig, plays: { how, words }, base, index, isNew, from? }
  open: null, // what is open: { kind: "css" | "script" | "transition", rs, name }
  ro: null, // for the two kinds that are only read: { frames, timing?, laneEase?, state?, total?, on?, items? }
  key: null, // the selected keyframe: { at, prop } (prop null: the whole keyframe)
  lanes: [], // the properties, in the order their lanes were first drawn
  T: 0, // the open animation's duration in ms (at least 1), as the timeline was last drawn: the playhead's time
  isolate: false, rate: 1, loop: false, loopAt: 0, pos: 0,
  past: [], future: [], snap: "",
  held: null, // the page's Animation object for what is open
  scan: { anims: [], unused: [], transitions: [], scripts: [], rules: new Map() },
  suspects: new Set(), // elements whose inline style changes many times a second
  sheet: null, // the unsent edits, as rules
  // [{ id, sheet, seen, n, undo: [{ x, index, entry }] }]: applied until the pin is done. seen:
  // its pin has been listed; n: the pin's number, null until it has one; undo: the element's
  // other uses x whose base had this one's entry written in at index, and the entry they had.
  sent: [],
  unsent: null, // what the animation being sent was, until the host takes it
  view: "keys", // the timeline, or the keyframes as text
  rowEls: null, // the elements of the list row under the pointer
  drag: null, last: null, findUntil: 0, obs: null, ui: null,
  msg: "", msgTimer: 0, done: "", doneTimer: 0,
};
let dock, listEl, hdEl, tlEl, cssEl, kbEl, ftEl, noteEl, msgEl, popEl, sugEl, tagEl, popAnchor = null;

// ── elements of the page ─────────────────────────────────────────────────────────────────
const mq = (rs) => {
  try {
    return rs ? document.querySelector(rs) : null;
  } catch {
    return null;
  }
};
/** A path from the body: no class names, so it also names the elements our own rules are for. */
function pathOf(el) {
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
const name = (el, short = false) => {
  if (!el) return "(gone)";
  const s = plainLabel(el, 28);
  const i = s.indexOf(" · ");
  if (i > 0) return short ? s.slice(i + 3) : s;
  // No words: its first class says more than "Block" does.
  const cls = (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\s+/)[0];
  return cls ? (short ? `.${cls}` : `${s} · .${cls}`) : s;
};
const splitTop = (s, sep = ",") => {
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
function parseKf(text) {
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
function serialize(nm, frames) {
  const body = frames.map((f) => {
    const d = Object.entries(f.vals).map(([p, v]) => `${p}: ${v};`);
    if (f.ease) d.push(`animation-timing-function: ${f.ease};`);
    return `  ${r1(f.at)}% { ${d.join(" ")} }`;
  });
  return `@keyframes ${nm} {\n${body.join("\n")}\n}`;
}
/** Keyframes as the Web Animations API gives them (a script's, or a stylesheet we may not read). */
function fromApi(list) {
  const kebab = (s) => (s === "cssFloat" ? "float" : s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
  return list.map((k) => {
    const vals = {};
    for (const p in k) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) vals[kebab(p)] = String(k[p]);
    return { at: r1(k.computedOffset * 100), ease: k.easing && k.easing !== "linear" ? k.easing : "", vals };
  });
}
function entryCss(e) {
  const out = [e.name, ms(e.duration)];
  if (e.easing !== "ease") out.push(e.easing);
  if (e.delay) out.push(ms(e.delay));
  if (String(e.count) !== "1") out.push(e.count);
  if (e.direction !== "normal") out.push(e.direction);
  if (e.fill !== "none") out.push(e.fill);
  return out.join(" ");
}
/** The easing as an SVG polyline's points in a w×h box, sampled from the browser, so steps()
 *  and linear() draw as they are. */
function curvePoints(easing, w, h, pad) {
  try {
    const fx = new KeyframeEffect(null, null, { duration: 100, easing, fill: "both" });
    const a = new Animation(fx, document.timeline);
    a.pause();
    const pts = [];
    for (let i = 0; i <= 30; i++) {
      a.currentTime = (i / 30) * 99.999;
      pts.push(`${(pad + (i / 30) * (w - 2 * pad)).toFixed(1)},${(h - pad - (fx.getComputedTiming().progress || 0) * (h - 2 * pad)).toFixed(1)}`);
    }
    a.cancel();
    return pts.join(" ");
  } catch {
    return "";
  }
}
const curve = (easing) => `<svg class="m-cv" viewBox="0 0 28 28" aria-hidden="true"><polyline points="${curvePoints(easing, 28, 28, 6)}" fill="none" stroke="#fffaa0" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

// ── how an element plays its animations ──────────────────────────────────────────────────
function readList(el) {
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
const kfDirty = (k) => !!k && (k.isNew || serialize(k.name, k.frames) !== k.orig);
const useDirty = (u) => !!u && (u.isNew || !!u.from || JSON.stringify(u.timing) !== JSON.stringify(u.orig));
const playsDirty = (u) => !!u && (u.plays.how !== "asnow" || !!u.plays.words.trim());
const openKf = () => (M.open && M.open.kind === "css" ? M.kf.get(M.open.name) : null);
const openUse = () => (M.open && M.open.kind === "css" ? M.use.get(`${M.open.rs}|${M.open.name}`) : null);
const frames = () => (openKf() ? openKf().frames : M.ro ? M.ro.frames : []);
const readOnly = () => !!M.open && M.open.kind !== "css";
/** Anything unsent: an edit, or how it starts. */
const anyDirty = () => [...M.kf.values()].some(kfDirty) || [...M.use.values()].some((u) => useDirty(u) || playsDirty(u));
/** The open animation has something to send. */
const openDirty = () => {
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
  if (M.on && M.ro && M.ro.on && M.ro.state) out.push(`${M.open.rs}${BOOST} { ${M.ro.state.css} }`);
  if (M.on && M.isolate && M.selRs) out.push(`body *:not(${M.selRs}, ${M.selRs} *) { visibility: hidden !important; }`, `${M.selRs} { visibility: visible !important; }`);
  return out.join("\n");
}
function apply() {
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
function scan() {
  const rules = new Map(); // name → the @keyframes rule that wins (the last one)
  const walk = (list) => {
    for (const r of list) {
      if (r instanceof CSSKeyframesRule) rules.set(r.name, r);
      else if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const s of document.styleSheets) {
    try {
      walk(s.cssRules);
    } catch {} // another origin's stylesheet: its animations are still read, through the API
  }
  for (const b of M.sent) walk(b.sheet.cssRules); // what was sent is what the page plays now
  const anims = new Map(), transitions = [];
  const all = document.body ? document.body.getElementsByTagName("*") : [];
  for (let i = 0; i < all.length && i < 4000; i++) {
    const el = all[i];
    if (el === hostEl || SKIP.test(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.animationName !== "none") for (const nm of splitTop(cs.animationName)) (anims.get(nm) || anims.set(nm, []).get(nm)).push(el);
    if (cs.transitionProperty !== "none" && splitTop(cs.transitionDuration).some((d) => parseFloat(d) > 0)) transitions.push(el);
  }
  const live = document.getAnimations();
  const running = new Set(live.filter((a) => a.playState === "running" && a.animationName).map((a) => a.animationName));
  M.scan = {
    rules,
    anims: [...anims].map(([nm, els]) => ({ name: nm, els, running: running.has(nm) })),
    unused: [...rules.keys()].filter((n) => !anims.has(n)),
    transitions,
    scripts: live.filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect && a.effect.target && a.effect.target.getRootNode() !== root),
  };
}
