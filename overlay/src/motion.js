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
// Everything here is in one closure: its names stay out of the canvas code's way.
const MO = (() => {
  const EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier(0.2, 0.8, 0.2, 1)", "cubic-bezier(0.34, 1.56, 0.64, 1)", "steps(4, end)"];
  const PROPS = ["opacity", "transform", "translate", "scale", "rotate", "background-color", "color", "box-shadow", "filter", "clip-path", "width", "height", "border-radius", "letter-spacing"];
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
    isolate: false, rate: 1, loop: false, loopAt: 0, pos: 0,
    past: [], future: [], snap: "",
    held: null, // the page's Animation object for what is open
    scan: { anims: [], unused: [], transitions: [], scripts: [], rules: new Map() },
    suspects: new Set(), // elements whose inline style changes many times a second
    sheet: null, // the unsent edits, as rules
    sent: [], // [{ id, sheet, seen, n, undo: [{ rs, index, entry }] }]: applied until the pin is done
    unsent: null, // what the animation being sent was, until the host takes it
    view: "keys", // the timeline, or the keyframes as text
    rowEls: null, // the elements of the list row under the pointer
    drag: null, last: null, findUntil: 0, obs: null, ui: null,
    msg: "", msgTimer: 0, done: "", doneTimer: 0,
  };
  let dock, listEl, hdEl, tlEl, cssEl, kbEl, ftEl, noteEl, msgEl, popEl, tagEl, popAnchor = null;

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

  // ── opening one ──────────────────────────────────────────────────────────────────────────
  function baseFor(rs, el) {
    for (const u of M.use.values()) if (u.rs === rs) return u.base;
    return readList(el);
  }
  function show(open) {
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
  function openCss(el, nm) {
    const rs = pathOf(el);
    setSel(el);
    if (!M.kf.has(nm)) {
      const rule = M.scan.rules.get(nm);
      const live = el.getAnimations().find((a) => a.animationName === nm);
      const fr = rule ? parseKf(rule.cssText).frames || [] : live ? fromApi(live.effect.getKeyframes()) : [];
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
  function newAnimation() {
    if (!M.sel) return;
    let nm = "fade-up";
    for (let i = 2; M.kf.has(nm) || M.scan.rules.has(nm); i++) nm = `fade-up-${i}`;
    M.kf.set(nm, { name: nm, isNew: true, orig: "", frames: [{ at: 0, ease: "", vals: { opacity: "0", translate: "0 12px" } }, { at: 100, ease: "", vals: { opacity: "1", translate: "0 0" } }] });
    attach(M.sel, nm);
  }
  function tryUnused(nm) {
    if (!M.sel) return;
    if (!M.kf.has(nm)) {
      const fr = parseKf(M.scan.rules.get(nm).cssText).frames || [];
      M.kf.set(nm, { name: nm, frames: fr, orig: serialize(nm, fr), isNew: false });
    }
    attach(M.sel, nm, { duration: 600, delay: 0, easing: "ease-in-out", count: "1", direction: "normal", fill: "none" });
  }
  function openScript(a) {
    const el = a.effect.target, t = a.effect.getTiming();
    setSel(el);
    M.ro = { frames: fromApi(a.effect.getKeyframes()), timing: { duration: +t.duration || 0, delay: t.delay, easing: t.easing, count: t.iterations === Infinity ? "infinite" : String(t.iterations), direction: t.direction, fill: t.fill === "auto" ? "none" : t.fill } };
    show({ kind: "script", rs: pathOf(el), name: a.id || "animate()" });
    M.held = a;
  }
  /** A transition has no keyframes: two values per property and the state that switches them,
   *  found in the page's own rules (`.primary:hover`). Playing it applies that rule. */
  function openTransition(el) {
    const rs = pathOf(el), cs = getComputedStyle(el);
    setSel(el);
    const col = (p) => splitTop(cs.getPropertyValue(p));
    const props = col("transition-property"), dur = col("transition-duration"), del = col("transition-delay"), ease = col("transition-timing-function");
    const at = (list, i) => list[i % list.length];
    let state = null;
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
  function setSel(el) {
    M.sel = el;
    M.selRs = el ? pathOf(el) : "";
  }
  /** A click on the page: the element, and with it the first thing that moves it. */
  function selectEl(el) {
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
  function reveal(el) {
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight - DOCK_H || r.right < 0 || r.left > window.innerWidth) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    M.findUntil = performance.now() + 1400;
    kick();
  }

  // ── playing ──────────────────────────────────────────────────────────────────────────────
  /** The page's own Animation object for what is open. One that ended without holding its last
   *  frame is no longer listed by the element, but the object still plays: it is kept. */
  function animOf() {
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
  function play() {
    if (M.open && M.open.kind === "transition") return flip();
    const a = animOf() || revive();
    if (!a) return;
    a.playbackRate = M.rate;
    if (a.playState === "finished") a.currentTime = 0;
    a.play();
    kick();
  }
  function pause() {
    const a = animOf();
    if (a) a.pause();
  }
  const running = () => {
    if (!M.open || M.open.kind === "transition") return false;
    const a = animOf();
    return !!a && a.playState === "running";
  };
  const toggle = () => (M.open && M.open.kind === "transition" ? flip() : running() ? pause() : play());
  /** Show the frame at `p` (0…1 along the keyframes) and stay there. */
  function seek(p) {
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
  function position() {
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
  function letGo() {
    const a = M.open && M.open.kind !== "transition" ? animOf() : null;
    if (a && a.playState === "paused") {
      a.playbackRate = 1;
      a.play();
    }
    if (M.ro && M.ro.on) M.ro.on = false;
  }

  // ── undo ─────────────────────────────────────────────────────────────────────────────────
  const snapshot = () => JSON.stringify({ kf: [...M.kf], use: [...M.use], open: M.open && M.open.kind === "css" ? M.open : null });
  function commit() {
    const now = snapshot();
    if (now !== M.snap) {
      M.past.push(M.snap);
      if (M.past.length > 200) M.past.shift();
      M.snap = now;
      M.future = [];
    }
    apply();
    scan();
    draw();
    draftChanged();
  }
  function travel(from, to) {
    if (!from.length) return;
    to.push(M.snap);
    M.snap = from.pop();
    const s = JSON.parse(M.snap);
    M.kf = new Map(s.kf);
    M.use = new Map(s.use);
    const keep = M.open && M.open.kind !== "css" ? M.open : s.open;
    M.open = keep && (keep.kind !== "css" || M.use.has(`${keep.rs}|${keep.name}`)) ? keep : null;
    M.key = null;
    apply();
    scan();
    draw();
    draftChanged();
  }
  /** The open animation as the page has it (or as it was last sent): its edits go. */
  function discard() {
    let u = openUse(), k = openKf();
    if (!u) return;
    if (u.from) {
      // its own keyframes go; it plays the shared ones again
      M.kf.delete(k.name);
      M.use.delete(`${u.rs}|${u.name}`);
      u.name = M.open.name = u.from;
      delete u.from;
      M.use.set(`${u.rs}|${u.name}`, u);
      M.held = null;
      k = openKf();
    }
    if (u.isNew) M.use.delete(`${u.rs}|${u.name}`);
    else {
      u.timing = { ...u.orig };
      u.plays = { how: "asnow", words: "" };
    }
    if (k && k.isNew) M.kf.delete(k.name);
    else if (k) k.frames = parseKf(k.orig).frames;
    if (u.isNew) M.open = null;
    M.key = null;
    commit();
  }

  // ── shared keyframes ─────────────────────────────────────────────────────────────────────
  /** How many elements play the open keyframes. A change to them changes every one. */
  function sharedBy() {
    const k = openKf();
    const a = k && M.scan.anims.find((x) => x.name === k.name);
    return a ? a.els.length : 1;
  }
  /** The open element gets keyframes of its own: a copy, under a new name, with the changes made
   *  so far; the shared ones go back to what the page has, for the other elements. */
  function detach() {
    const u = openUse(), k = openKf();
    if (!u || !k || sharedBy() < 2) return;
    let nm = `${k.name}-2`;
    for (let i = 3; M.kf.has(nm) || M.scan.rules.has(nm); i++) nm = `${k.name}-${i}`;
    M.kf.set(nm, { name: nm, frames: JSON.parse(JSON.stringify(k.frames)), orig: "", isNew: true });
    if (!k.isNew) k.frames = parseKf(k.orig).frames;
    M.use.delete(`${u.rs}|${u.name}`);
    u.from = u.name;
    u.name = nm;
    M.use.set(`${u.rs}|${nm}`, u);
    M.open.name = nm;
    M.held = null;
    const p = M.pos;
    commit();
    seek(p);
  }

  // ── editing keyframes ────────────────────────────────────────────────────────────────────
  function moveKey(prop, from, to) {
    const k = openKf();
    if (!k) return false;
    const F = k.frames, a = F.find((f) => f.at === from);
    let b = F.find((f) => f.at === to);
    if (!a || from === to) return false;
    if (prop === null) {
      if (b) return false;
      a.at = to;
    } else {
      if (b && prop in b.vals) return false;
      if (!b) F.push((b = { at: to, ease: "", vals: {} }));
      b.vals[prop] = a.vals[prop];
      delete a.vals[prop];
      if (!Object.keys(a.vals).length) {
        if (a.ease && !b.ease) b.ease = a.ease;
        F.splice(F.indexOf(a), 1);
      }
    }
    F.sort((x, y) => x.at - y.at);
    return true;
  }
  /** A new keyframe where a lane was pressed twice. It takes the value the animation has at that
   *  moment, so adding one changes nothing until it is edited; a transform comes back from the
   *  browser as a matrix, which nobody wants to edit, so there the keyframe before is copied. */
  function addKey(prop, at) {
    const k = openKf(), el = mq(M.open && M.open.rs);
    if (!k || !el) return;
    let f = k.frames.find((x) => x.at === at);
    const props = prop === null ? laneOrder() : [prop];
    seek(at / 100);
    const cs = getComputedStyle(el);
    for (const p of props) {
      if (f && p in f.vals) continue;
      let v = cs.getPropertyValue(p).replace(/-?\d*\.\d{4,}/g, (n) => String(Math.round(n * 1000) / 1000));
      if (/^matrix/.test(v) || !v) {
        const before = k.frames.filter((x) => x.at <= at && p in x.vals).pop() || k.frames.find((x) => p in x.vals);
        v = before ? before.vals[p] : v || "initial";
      }
      if (!f) k.frames.push((f = { at, ease: "", vals: {} }));
      f.vals[p] = v;
    }
    k.frames.sort((x, y) => x.at - y.at);
    M.key = { at, prop };
    commit();
  }
  function removeKey() {
    const k = openKf(), key = M.key;
    if (!k || !key) return;
    const f = k.frames.find((x) => x.at === key.at);
    if (!f) return;
    if (key.prop === null) k.frames.splice(k.frames.indexOf(f), 1);
    else {
      delete f.vals[key.prop];
      if (!Object.keys(f.vals).length) k.frames.splice(k.frames.indexOf(f), 1);
    }
    M.key = null;
    commit();
  }
  function addLane(prop) {
    const k = openKf(), el = mq(M.open && M.open.rs);
    prop = prop.trim().toLowerCase();
    if (!k || !el || !prop || !CSS.supports(prop, "initial") || laneOrder().includes(prop)) return false;
    const now = getComputedStyle(el).getPropertyValue(prop) || "initial";
    const v = /^matrix/.test(now) ? "none" : now;
    for (const at of [0, 100]) {
      let f = k.frames.find((x) => x.at === at);
      if (!f) k.frames.push((f = { at, ease: "", vals: {} }));
      f.vals[prop] = v;
    }
    k.frames.sort((x, y) => x.at - y.at);
    M.key = { at: 100, prop };
    commit();
    seek(1);
    return true;
  }
  function removeLane(prop) {
    const k = openKf();
    if (!k) return;
    for (const f of k.frames) delete f.vals[prop];
    k.frames = k.frames.filter((f) => Object.keys(f.vals).length);
    M.key = null;
    commit();
  }
  /** The lanes keep their place while keyframes are dragged past each other. */
  function laneOrder() {
    const have = new Set(frames().flatMap((f) => Object.keys(f.vals)));
    M.lanes = M.lanes.filter((p) => have.has(p));
    for (const p of have) if (!M.lanes.includes(p)) M.lanes.push(p);
    return M.lanes;
  }
  function keyInfo() {
    const key = M.key, o = M.open;
    if (!key || !o) return null;
    const f = frames().find((x) => x.at === key.at);
    if (!f) return null;
    const ro = o.kind !== "css";
    const t = timing();
    const ease = (M.ro && M.ro.laneEase && key.prop ? M.ro.laneEase[key.prop] : f.ease) || "";
    return { f, at: f.at, prop: key.prop, value: key.prop ? f.vals[key.prop] : null, ease, dflt: t ? t.easing : "", last: f.at >= 100 || o.kind === "transition", ro };
  }
  /** One field of the selected keyframe: "val", "ease" or "at". False when the browser says no. */
  function setKey(what, v, done) {
    const k = openKf(), key = M.key;
    if (!k || !key) return false;
    const fr = k.frames.find((x) => x.at === key.at);
    if (!fr) return false;
    v = String(v).trim();
    let ok = true;
    if (what === "val") {
      ok = v !== "" && v.length <= 400 && CSS.supports(key.prop, v);
      if (ok) fr.vals[key.prop] = v;
    } else if (what === "ease") {
      ok = v === "" || CSS.supports("animation-timing-function", v);
      if (ok) fr.ease = v;
    } else if (what === "at") {
      const to = r1(Number(v));
      ok = v !== "" && to >= 0 && to <= 100;
      if (ok && done && moveKey(key.prop, key.at, to)) key.at = to;
    }
    if (!ok) return false;
    apply();
    if (done) {
      commit();
      seek(M.key ? M.key.at / 100 : M.pos);
    }
    return true;
  }
  function segEase(at, prop) {
    const f = frames().find((x) => x.at === at);
    const own = M.ro && M.ro.laneEase ? M.ro.laneEase[prop] : f ? f.ease : "";
    const t = timing();
    return own || (t ? t.easing : "");
  }

  // ── timing ───────────────────────────────────────────────────────────────────────────────
  function timing() {
    const o = M.open;
    if (!o) return null;
    if (o.kind === "css") return openUse().timing;
    if (o.kind === "script") return M.ro.timing;
    return { duration: M.ro.total, delay: 0, easing: M.ro.items.length ? M.ro.items[0].easing : "ease", count: "1", direction: "normal", fill: "none" };
  }
  /** One field of the timing, or of what starts it ("how"). False when the value is not one. */
  function setTiming(key, v, done) {
    const u = openUse();
    if (!u) return false;
    if (key === "how") {
      if (!HOW[v]) return false;
      u.plays.how = v;
    } else {
      let val = String(v).trim(), ok = true;
      if (key === "duration" || key === "delay") {
        ok = val !== "" && Number.isFinite(Number(val)) && Math.abs(Number(val)) <= 600000 && (key === "delay" || Number(val) >= 0);
        val = Number(val);
      } else if (key === "easing") ok = CSS.supports("animation-timing-function", val);
      else if (key === "count") ok = val === "infinite" || (Number(val) >= 0 && Number.isFinite(Number(val)));
      else if (key === "direction") ok = !!DIRECTION[val];
      else if (key === "fill") ok = !!FILL[val];
      else ok = false;
      if (!ok) return false;
      const paused = (animOf() || {}).playState === "paused";
      u.timing[key] = val;
      apply();
      if (paused) seek(M.pos);
    }
    if (done) commit();
    return true;
  }

  // ── the text ─────────────────────────────────────────────────────────────────────────────
  function cssText() {
    const k = openKf();
    if (k) return serialize(k.name, k.frames);
    if (M.ro && M.open.kind === "script") return serialize(M.open.name, M.ro.frames);
    if (M.ro && M.open.kind === "transition") return `${editSel(M.sel)} {\n  transition: ${M.ro.items.map((x) => `${x.prop} ${ms(x.duration)} ${x.easing}`).join(",\n    ")};\n}`;
    return "";
  }
  function setCss(text) {
    const k = openKf();
    if (!k) return "";
    if (text.length > MAX_KF) return `Too long: ${MAX_KF} characters at most`;
    const p = parseKf(text);
    let why = p.error;
    if (!why && p.name !== k.name && !k.isNew) why = `The name stays “${k.name}”`;
    if (!why) {
      const bad = p.frames.flatMap((f) => Object.entries(f.vals).filter(([pr, v]) => !pr.startsWith("--") && !CSS.supports(pr, v)).map(([pr]) => pr));
      if (bad.length) why = `Not a value for ${bad[0]}`;
    }
    if (why) return why;
    if (p.name !== k.name && k.isNew) rename(k, p.name);
    k.frames = p.frames;
    if (M.key && !k.frames.some((f) => f.at === M.key.at && (M.key.prop === null || M.key.prop in f.vals))) M.key = null;
    apply();
    return "";
  }
  function rename(k, nm) {
    if (!/^-?[a-zA-Z_][\w-]{0,60}$/.test(nm) || M.kf.has(nm) || M.scan.rules.has(nm)) return;
    M.kf.delete(k.name);
    for (const [key, u] of [...M.use])
      if (u.name === k.name) {
        M.use.delete(key);
        u.name = nm;
        M.use.set(`${u.rs}|${nm}`, u);
      }
    if (M.open.name === k.name) M.open.name = nm;
    k.name = nm;
    M.kf.set(nm, k);
    M.held = null;
  }

  // ── the list ─────────────────────────────────────────────────────────────────────────────
  function rows() {
    const S2 = M.scan, o = M.open, out = [];
    const timingOf = (el, nm) => {
      const u = M.use.get(`${pathOf(el)}|${nm}`);
      return u ? u.timing : readList(el).find((x) => x.name === nm) || null;
    };
    const dirtyUse = (el, nm) => {
      const u = M.use.get(`${pathOf(el)}|${nm}`);
      return useDirty(u) || playsDirty(u);
    };
    if (S2.anims.length) out.push({ group: "Animations" });
    for (const a of S2.anims) {
      const k = M.kf.get(a.name), one = a.els.length === 1, mine = o && o.kind === "css" && o.name === a.name;
      const t = one ? timingOf(a.els[0], a.name) : null;
      out.push({ kind: "css", els: a.els, name: a.name, label: one ? name(a.els[0], true) : `${a.els.length} elements`, running: a.running,
        dirty: kfDirty(k) || (one && dirtyUse(a.els[0], a.name)), on: mine && one, duration: t ? t.duration : null, open: () => openCss(a.els[0], a.name) });
      if (!one)
        a.els.forEach((el, j) => {
          const t2 = timingOf(el, a.name);
          out.push({ kind: "css", els: [el], sub: true, last: j === a.els.length - 1, name: a.name, label: name(el, true), dirty: dirtyUse(el, a.name),
            on: mine && o.rs === pathOf(el), duration: t2 ? t2.duration : null, open: () => openCss(el, a.name) });
        });
    }
    if (S2.transitions.length) out.push({ group: "Transitions" });
    for (const el of S2.transitions) {
      const cs = getComputedStyle(el);
      out.push({ kind: "transition", els: [el], name: name(el, true), label: cs.transitionProperty, on: o && o.kind === "transition" && o.rs === pathOf(el),
        duration: Math.max(...splitTop(cs.transitionDuration).map((d) => parseFloat(d) * 1000)), open: () => openTransition(el) });
    }
    if (S2.scripts.length || M.suspects.size) out.push({ group: "Scripts" });
    for (const a of S2.scripts)
      out.push({ kind: "script", els: [a.effect.target], name: a.id || "animate()", label: name(a.effect.target, true), running: a.playState === "running",
        on: o && o.kind === "script" && M.held === a, duration: +a.effect.getTiming().duration || 0, open: () => openScript(a) });
    for (const el of M.suspects)
      if (el.isConnected) out.push({ kind: "frames", els: [el], name: name(el, true), label: "per frame", running: true, off: true, duration: null, open: () => {} });
    if (S2.unused.length) out.push({ group: "Unused" });
    for (const n of S2.unused) out.push({ kind: "unused", els: [], name: n, label: "", off: !M.sel, duration: null, open: () => tryUnused(n) });
    return out;
  }

  // ── sending ──────────────────────────────────────────────────────────────────────────────
  /** The open animation, as the note says it (see `Motion` in app/src/main/review.ts). */
  function payload() {
    const o = M.open, el = mq(o.rs);
    const who = { selector: editSel(el), label: plainLabel(el) };
    if (o.kind !== "css") {
      const t = timing();
      const current = o.kind === "transition"
        ? `transition: ${M.ro.items.map((x) => `${x.prop} ${ms(x.duration)} ${x.easing}${x.delay ? ` ${ms(x.delay)}` : ""}`).join(", ")}${M.ro.state ? ` (on ${M.ro.state.pseudo})` : ""}`
        : `animate(): ${ms(t.duration)} ${t.easing}${t.delay ? ` ${ms(t.delay)}` : ""}${t.count !== "1" ? `, ${t.count === "infinite" ? "forever" : `${t.count} times`}` : ""}${t.direction !== "normal" ? `, ${t.direction}` : ""}`;
      return { kind: o.kind, name: o.kind === "transition" ? "transition" : o.name.slice(0, 64), ...who, current: current.slice(0, 400) };
    }
    const u = openUse(), k = openKf();
    const out = { kind: "keyframes", name: k.name, ...who, shared: sharedBy() };
    if (u.isNew) out.isNew = true;
    if (u.from) out.from = u.from;
    if (useDirty(u)) out.animation = { to: entryCss({ name: u.name, ...u.timing }), ...(u.isNew ? {} : { from: entryCss({ name: u.from || u.name, ...u.orig }) }) };
    if (kfDirty(k)) out.keyframes = { to: serialize(k.name, k.frames), ...(k.isNew ? {} : { from: k.orig }) };
    if (!u.isNew)
      out.changes = ["duration", "delay", "easing", "count", "direction", "fill"].filter((p) => String(u.timing[p]) !== String(u.orig[p]))
        .map((p) => ({ prop: p, from: p === "duration" || p === "delay" ? ms(u.orig[p]) : String(u.orig[p]), to: p === "duration" || p === "delay" ? ms(u.timing[p]) : String(u.timing[p]) }));
    if (u.plays.how !== "asnow") out.starts = u.plays.how;
    return out;
  }
  function submit(background) {
    if (S.pending) return;
    const o = M.open, el = o && mq(o.rs), words = noteEl.value.trim();
    if (!o || !el) return flash("Open an animation first: click something that moves, or a row of the list");
    if (!openDirty() && !words) return flash("Nothing to send yet: change it, or say what it should do");
    const k = openKf();
    if (k && serialize(k.name, k.frames).length > MAX_KF) return flash("Too long to send: the keyframes are over 4000 characters");
    letGo(); // the screenshot shows the element as it plays, not stopped at a frame
    const motion = payload();
    const target = describe(el);
    const note = {
      id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: words,
      url: location.href,
      title: document.title,
      viewport: vp(),
      targets: [target],
      area: null,
      strokes: [],
      bounds: target.rect,
      time: Date.now(),
      ...(background ? { lane: "bg" } : {}),
      motion,
    };
    // What it was, until the host takes it; then its rules move to a sheet of their own, and it
    // is no longer unsent.
    M.unsent = { id: note.id, snap: M.snap, past: M.past, future: M.future, words: noteEl.value, open: o, sel: M.sel };
    if (o.kind === "css") moveToSent(note.id);
    noteEl.value = "";
    noteEl.blur(); // the line under the timeline says it was sent
    S.quiet = note.id; // no "Sent" chip over the page: the dock's line says it
    S.sel = [el]; // its outline, in the screenshot
    draw();
    dispatch(note);
  }
  /** The open animation's rules go into a sheet of their own, under the note's id; the draft
   *  keeps everything else. */
  function moveToSent(id) {
    const u = openUse(), k = openKf();
    const out = [];
    if (kfDirty(k)) out.push(serialize(k.name, k.frames));
    const entry = { name: u.name, ...u.timing };
    const undo = [];
    if (useDirty(u)) {
      const entries = u.base.map((e) => ({ ...e }));
      entries[u.index] = entry;
      out.push(`${u.rs}${BOOST} { animation: ${entries.filter(Boolean).map(entryCss).join(", ")}; }`);
      // The element's other unsent animations are written over this one's entry: they must
      // write it as sent, and put it back if the note comes to nothing.
      for (const x of M.use.values())
        if (x !== u && x.rs === u.rs) {
          undo.push({ x, index: u.index, entry: x.base[u.index] });
          x.base = x.base.slice();
          x.base[u.index] = entry;
        }
    }
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(out.join("\n"));
    } catch {}
    adopt(sheet, true);
    M.sent.push({ id, sheet, seen: false, undo });
    M.use.delete(`${u.rs}|${u.name}`);
    if (![...M.use.values()].some((x) => x.name === k.name)) M.kf.delete(k.name);
    M.past = [];
    M.future = [];
    M.held = null;
    apply(); // after the sent sheet: the unsent edits stay on top
    scan();
    // Open again, as the page plays it now.
    const el = mq(u.rs);
    M.snap = snapshot();
    if (el && readList(el).some((e) => e.name === u.name)) openCss(el, u.name);
    else show(null);
    draftChanged();
  }
  /** The host did not take the note: the animation is unsent again, with its undo steps and words. */
  function refuse(id, say) {
    const u = M.unsent;
    M.unsent = null;
    if (!u || u.id !== id) return false;
    const i = M.sent.findIndex((b) => b.id === id);
    if (i >= 0) dropSent(M.sent.splice(i, 1)[0]);
    const s = JSON.parse(u.snap);
    M.kf = new Map(s.kf);
    M.use = new Map(s.use);
    M.snap = u.snap;
    M.past = u.past;
    M.future = u.future;
    noteEl.value = [u.words, noteEl.value].filter((w) => w.trim()).join(" ");
    S.sel = [];
    apply();
    scan();
    M.open = u.open;
    M.held = null;
    setSel(u.sel && u.sel.isConnected ? u.sel : mq(u.open.rs));
    draw();
    draftChanged();
    flash(say);
    return true;
  }
  function dropSent(b) {
    adopt(b.sheet, false);
    for (const { x, index, entry } of b.undo) if (x.base[index] && x.base[index].name === (b.undo[0] && x.base[index].name)) x.base[index] = entry;
  }
  function finish(id) {
    if (M.unsent && M.unsent.id === id) M.unsent = null;
    if (S.quiet === id) S.sel = [];
  }
  /** A sent animation is a preview until the agent is finished with its note. */
  function dropFinished() {
    let changed = false;
    M.sent = M.sent.filter((b) => {
      const p = S.pins.find((x) => x.id === b.id);
      if (p) b.seen = b.n = p.n || true;
      const over = p ? p.status === "done" || p.status === "failed" || p.status === "stopped" : b.seen;
      if (!over) return true;
      changed = true;
      dropSent(b);
      const nm = typeof b.n === "number" ? `Note ${b.n}` : "Note";
      M.done = !p ? `${nm} removed · preview removed` : p.status === "done" ? `${nm} done · preview removed` : `${nm} ${p.status} · preview removed`;
      clearTimeout(M.doneTimer);
      M.doneTimer = setTimeout(() => {
        M.done = "";
        drawFoot();
      }, 4000);
      return false;
    });
    drawFoot(); // a note's number is known now: the line says it
    if (!changed) return;
    apply();
    scan();
    if (M.on) {
      // what is open is read again, as the page plays it now
      const o = M.open, el = o && mq(o.rs);
      if (o && o.kind === "css" && el && !M.use.has(`${o.rs}|${o.name}`) && readList(el).some((e) => e.name === o.name)) {
        M.kf.delete(o.name);
        openCss(el, o.name);
      } else draw();
    }
  }

  // ── the draft the host keeps ─────────────────────────────────────────────────────────────
  /** What is unsent, for the host to keep across a reload: the edited keyframes and uses only. */
  function draft() {
    const kf = [...M.kf].filter(([, k]) => kfDirty(k));
    const use = [...M.use].filter(([, u]) => useDirty(u) || playsDirty(u));
    const words = noteEl ? noteEl.value : "";
    if (!kf.length && !use.length && !words) return null;
    return { kf, use, ...(words ? { note: words } : {}) };
  }
  function restore(d) {
    if (!d || typeof d !== "object" || anyDirty()) return;
    try {
      const kf = (Array.isArray(d.kf) ? d.kf : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && Array.isArray(e[1].frames));
      const use = (Array.isArray(d.use) ? d.use : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && e[1].timing && Array.isArray(e[1].base));
      M.kf = new Map(kf);
      M.use = new Map(use);
      if (noteEl && typeof d.note === "string" && !noteEl.value) noteEl.value = d.note;
      M.snap = snapshot();
      apply();
    } catch {
      M.kf = new Map();
      M.use = new Map();
    }
  }

  // ── mode ─────────────────────────────────────────────────────────────────────────────────
  function setOn(on) {
    if (on === M.on || !dock) return;
    closePop();
    if (on) {
      if (C.on) setCanvas(false);
      setBrush(false);
      M.on = true;
      // A note in progress becomes the start: its element is looked at.
      const el = S.sel.length === 1 ? S.sel[0] : null;
      if (S.card || hasDraft()) clearDraft();
      hideSent();
      S.hover = null;
      watchSuspects(true);
      scan();
      M.snap = snapshot();
      if (el && el.isConnected) selectEl(el);
      else if (M.open && !mq(M.open.rs)) show(null);
      else draw();
    } else {
      letGo();
      M.isolate = false;
      M.drag = null;
      M.hover = null;
      M.rowEls = null;
      watchSuspects(false);
      M.on = false;
      apply();
    }
    try {
      sessionStorage.setItem("b42-motion", on ? "1" : "");
    } catch {}
    syncUi();
    drawBar(); // the host hears the mode
    kick();
  }
  /** After a reload (the agent's own edits cause many) the reviewer is still in motion mode. */
  function resume() {
    let was = false;
    try {
      was = sessionStorage.getItem("b42-motion") === "1";
    } catch {}
    if (was && !M.on && !C.on && !S.card && !hasDraft()) setOn(true);
  }
  /** Room for the dock: the page can scroll its last part out from under it. */
  function syncUi() {
    if (!(M.on && S.enabled)) {
      if (M.ui) adopt(M.ui, false);
      return;
    }
    if (!M.ui) {
      M.ui = new CSSStyleSheet();
      M.ui.replaceSync(`html[data-b42-review] { padding-bottom: ${DOCK_H}px !important; }`);
    }
    adopt(M.ui, true);
  }
  /** What no stylesheet and no animation object accounts for: an inline style rewritten many
   *  times a second. It cannot be edited here, but the list can say it is there. */
  function watchSuspects(on) {
    if (M.obs) M.obs.disconnect();
    M.obs = null;
    if (!on || !document.body) return;
    const seen = new Map();
    M.obs = new MutationObserver((list) => {
      const now = performance.now();
      for (const m of list) {
        const c = seen.get(m.target) || seen.set(m.target, { n: 0, t: now }).get(m.target);
        if (now - c.t > 1000) (c.n = 0), (c.t = now);
        if (++c.n === 20 && !M.suspects.has(m.target)) {
          M.suspects.add(m.target);
          drawList();
        }
      }
    });
    M.obs.observe(document.body, { attributes: true, attributeFilter: ["style"], subtree: true });
  }
  function flash(text) {
    M.msg = text;
    drawFoot();
    clearTimeout(M.msgTimer);
    M.msgTimer = setTimeout(() => {
      M.msg = "";
      drawFoot();
    }, 2600);
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────────
  const typingIn = (el) => {
    const a = root.activeElement;
    return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && el.contains(a);
  };
  function draw() {
    if (!dock || !M.on) return;
    drawList();
    drawHead();
    const css = M.view === "css" && !!M.open;
    tlEl.hidden = css;
    cssEl.hidden = !css;
    if (css) drawCss();
    else if (!typingIn(tlEl)) drawLanes();
    if (!typingIn(kbEl)) kbEl.innerHTML = css ? "" : keyEditor();
    kbEl.hidden = !kbEl.innerHTML.trim();
    drawFoot();
    kick();
  }
  function drawList() {
    if (!dock || !M.on) return;
    const list = rows();
    listEl._rows = list;
    listEl.innerHTML = list.map((r, i) => r.group ? `<div class="m-grp">${esc(r.group)}</div>`
      : `<div class="m-it k-${r.kind}${r.on ? " on" : ""}${r.sub ? " sub" : ""}${r.last ? " last" : ""}${r.off ? " off" : ""}${r.running ? " run" : ""}" data-row="${i}"
        title="${r.sub ? "" : `${KIND_TITLE[r.kind]}${r.running ? ", playing" : ""}`}">${r.sub ? "" : kindIcon(r.kind)}<span class="m-nm">${esc(r.sub ? r.label : r.name)}</span>
        <span class="m-ex">${r.sub ? "" : esc(r.label)}</span>${r.dirty ? '<i class="m-ed"></i>' : ""}
        ${r.duration !== null && r.duration !== undefined ? `<span class="m-du">${Math.round(r.duration)}</span>` : ""}</div>`).join("") ||
      `<div class="m-none">Nothing moves on this page</div>`;
  }
  function timingFields() {
    const t = timing(), ro = readOnly() ? "disabled" : "";
    return `<label class="m-tf"><span>Duration</span><input class="m-fld num" data-t="duration" value="${Math.round(t.duration)}" inputmode="numeric" ${ro}><span class="m-unit">ms</span></label>
      <label class="m-tf"><span>Delay</span><input class="m-fld num" data-t="delay" value="${Math.round(t.delay)}" inputmode="numeric" ${ro}><span class="m-unit">ms</span></label>
      <label class="m-tf"><span>Easing</span><input class="m-fld ease" data-t="easing" list="b42-m-easings" value="${esc(t.easing)}" spellcheck="false" ${ro}>${curve(t.easing)}</label>`;
  }
  function drawHead() {
    if (typingIn(hdEl)) return;
    const o = M.open;
    hdEl.hidden = !o;
    if (!o) return void (hdEl.innerHTML = "");
    const b = (v, t) => `<button type="button" data-m="view" data-v="${v}" class="${M.view === v ? "on" : ""}">${t}</button>`;
    hdEl.innerHTML = `<div class="m-seg" role="tablist">${b("keys", "Keyframes")}${b("css", "CSS")}</div><div class="m-timing">${timingFields()}</div>
      <button type="button" class="m-btn ic" data-m="more" title="More">${mi("more")}</button><span class="m-sp"></span>
      <div class="m-tools"><button type="button" class="m-btn" data-m="rate" title="Speed while looking">${RATE_TEXT[M.rate]}</button>
        <button type="button" class="m-btn ic${M.loop ? " on" : ""}" data-m="loop" title="Repeat while looking">${mi("loop")}</button>
        <button type="button" class="m-btn ic${M.isolate ? " on" : ""}" data-m="iso" ${M.sel ? "" : "disabled"} title="Show only this element">${mi("iso")}</button></div>
      <div class="m-tools"><button type="button" class="m-btn ic" data-m="undo" ${M.past.length ? "" : "disabled"} title="Undo (${isMac ? "⌘" : "ctrl+"}Z)">${mi("undo")}</button>
        <button type="button" class="m-btn ic" data-m="discard" ${openDirty() ? "" : "disabled"} title="Put back as the page has it">${mi("reset")}</button></div>`;
  }
  function laneBars(p) {
    const fr = frames().filter((f) => p in f.vals), key = M.key, out = [];
    if (!fr.length) return "";
    const on = (f) => key && key.at === f.at && (key.prop === p || key.prop === null);
    if (fr.length === 1) out.push(`<i class="m-sb solo${on(fr[0]) ? " on" : ""}" style="--fa: ${fr[0].at / 100}; --fb: ${fr[0].at / 100}; --l: -10px; --r: 10px"></i>`);
    // The outer ends of a lane's bars reach past its first and last keyframes, so those grips sit
    // inside them; where two bars meet, a gap holds the grip they share.
    fr.forEach((f, i) => {
      const next = fr[i + 1];
      if (!next) return;
      const ease = segEase(f.at, p), flat = f.vals[p] === next.vals[p];
      out.push(`<i class="m-sb${on(f) ? " on" : ""}${flat ? " flat" : ""}" data-seg="${f.at}" data-prop="${esc(p)}" title="${esc(ease)}"
        style="--fa: ${f.at / 100}; --fb: ${next.at / 100}; --l: ${i === 0 ? -10 : 3}px; --r: ${i === fr.length - 2 ? 10 : -3}px"></i>`);
    });
    for (const f of fr) out.push(`<i class="m-key m-gr${on(f) ? " on" : ""}" style="--at: ${f.at / 100}" data-at="${f.at}" data-prop="${esc(p)}" title="${esc(f.vals[p])}"></i>`);
    return out.join("");
  }
  function drawLanes() {
    const o = M.open;
    tlEl.classList.toggle("ro", readOnly());
    if (!o) {
      tlEl.innerHTML = `<div class="m-empty">${M.sel ? `<div>Nothing moves this</div><button type="button" class="m-btn m-new" data-m="new">${mi("plus")}New animation</button>` : "<div>Click something on the page, or a row of the list</div>"}</div>`;
      return;
    }
    const ro = readOnly(), key = M.key, fr = frames(), T = Math.max(1, +timing().duration || 0);
    M.T = T;
    const major = MAJOR.find((m) => T / m <= 7) || 5000, minor = major / 5;
    const ticks = [];
    for (let n = 0; n <= T + 0.5; n += minor) {
      const big = Math.round(n / minor) % 5 === 0;
      ticks.push(`<i class="m-tick${big ? " big" : ""}" style="--at: ${n / T}">${big ? `<b>${secs(n)}</b>` : ""}</i>`);
    }
    // the whole keyframes, under the ruler: one grabs every property at that moment
    const whole = fr.map((f) => `<i class="m-key wk${key && key.at === f.at && key.prop === null ? " on" : ""}" style="--at: ${f.at / 100}" data-at="${f.at}" data-prop=""></i>`).join("");
    const tr = o.kind === "transition";
    const html = [`<div class="m-lrow m-ruler"><div class="m-lab"><button type="button" class="m-btn ic play" data-m="play" title="${tr ? "Switch the state" : "Play (space)"}">${mi(running() ? "pause" : "play")}</button><span class="m-time"></span></div>
      <div class="m-trk" data-ruler>${ticks.join("")}${whole}</div></div>`];
    // the band: the keyframes' name, and who else plays them
    const n = sharedBy(), u = openUse(), nm = tr ? "transition" : o.name;
    const note = n > 1 ? `<span class="m-shared" title="These keyframes are played by ${n} elements: a change to them changes all of them. Duration, delay and easing are this element's own.">${mi("link", 14)}${n} elements</span>
        <button type="button" class="m-btn m-own" data-m="detach" title="Copy the keyframes for this element only; the others keep them as they are">Only this one</button>`
      : u && u.from ? `<span class="m-shared">Own copy of <b>${esc(u.from)}</b></span>` : "";
    const lanes = laneOrder();
    const rowsHtml = lanes.map((p) => `<div class="m-lrow m-lane${key && key.prop === p ? " kon" : ""}"><div class="m-lab"><span title="${esc(p)}">${esc(p)}</span>${ro ? "" : `<button type="button" class="m-btn ic m-x" data-m="rmlane" data-prop="${esc(p)}" title="Remove">${icon("x", 14)}</button>`}</div>
        <div class="m-trk"><div class="m-trk m-kspan" data-prop="${esc(p)}">${laneBars(p)}</div></div></div>`);
    html.push(`<div class="m-lanes"><div class="m-bands"><i class="m-band"></i></div>
      <div class="m-lrow m-ghead"><div class="m-lab">${kindIcon(tr ? "transition" : o.kind === "script" ? "script" : "css")}<b>${esc(nm)}</b></div><div class="m-trk">${note}</div></div>
      ${rowsHtml.join("")}</div>`);
    if (!ro) html.push(`<div class="m-addp"><input class="m-fld" data-addp list="b42-m-props" placeholder="+ Property" spellcheck="false" autocomplete="off"></div>`);
    html.push(`<div class="m-phl"><div class="m-flag" hidden><b></b></div></div>`);
    tlEl.innerHTML = html.join("");
    tlEl._play = null;
  }
  function keyEditor() {
    const k = keyInfo();
    if (!k) return "";
    const ro = k.ro ? "disabled" : "";
    return `<div class="m-keyed"><input class="m-fld num" data-k="at" value="${r1(k.at)}" ${ro}><span class="m-unit">%</span>
      ${k.prop === null ? `<span class="m-p">${Object.keys(k.f.vals).length} properties</span><span class="m-sp"></span>`
        : `<span class="m-p">${esc(k.prop)}</span><input class="m-fld val" data-k="val" value="${esc(k.value)}" spellcheck="false" autocomplete="off" ${ro}>`}
      ${k.last ? "" : `<input class="m-fld ease" data-k="ease" list="b42-m-easings" value="${esc(k.ease)}" placeholder="${esc(k.dflt)}" spellcheck="false" ${ro}><button type="button" class="m-btn ic m-cvb" data-m="kease" ${ro} title="Easing">${curve(k.ease || k.dflt)}</button>`}
      ${ro ? "" : `<button type="button" class="m-btn ic" data-m="rmkey" title="Delete (⌫)">${mi("trash")}</button>`}</div>`;
  }
  function drawCss() {
    const area = cssEl.querySelector("textarea");
    if (area && root.activeElement === area) return;
    cssEl.innerHTML = `<textarea data-css spellcheck="false" autocomplete="off" ${openKf() ? "" : "readonly"}>${esc(cssText())}</textarea><div class="m-err" hidden></div>`;
  }
  /** The note that goes with the open animation, and Send; or what the line has to say. */
  function sentStatus() {
    const b = M.sent[M.sent.length - 1];
    return b ? `Sent · preview stays until ${typeof b.n === "number" ? `note ${b.n}` : "the note"} is done` : "";
  }
  function drawFoot() {
    if (!ftEl) return;
    const o = M.open, can = !!o && (openDirty() || !!noteEl.value.trim());
    const busy = root.activeElement === noteEl || !!noteEl.value;
    const msg = M.msg || (busy ? "" : M.done || (o && openDirty() ? "" : sentStatus()));
    noteEl.hidden = !!msg;
    noteEl.placeholder = o ? (o.kind === "css" ? "Note… (optional)" : "Say what it should do…") : "Note…";
    msgEl.hidden = !msg;
    msgEl.textContent = msg;
    msgEl.classList.toggle("warn", !!M.msg);
    const go = ftEl.querySelector(".m-go");
    go.disabled = !can;
    go.title = can ? "Send this animation to the agent (↵)" : o ? "Change it, or say what it should do, first" : "Open an animation first";
  }

  // ── one frame ────────────────────────────────────────────────────────────────────────────
  /** Every frame: the playhead, the time, the play button, the outlines on the page. */
  function frame(capturing) {
    if (!dock) return null;
    const on = M.on && S.enabled && !capturing;
    if (dock._shown !== on) {
      dock.hidden = !(dock._shown = on);
      if (!on) closePop();
    }
    // (Nothing is written that is already so: an idle layer changes nothing, frame after frame.)
    const hide = (el, h) => el.hidden !== h && (el.hidden = h);
    if (!on) {
      hide(tagEl, true);
      return null;
    }
    // repeat, while Loop is on
    const a = M.open && M.open.kind !== "transition" ? animOf() : null;
    if (a && M.loop && a.playState === "finished") {
      const now = performance.now();
      if (!M.loopAt) M.loopAt = now + 400;
      else if (now > M.loopAt) {
        M.loopAt = 0;
        a.currentTime = 0;
        a.play();
      }
    }
    const run = running(), p = position();
    const flag = tlEl.querySelector(".m-flag");
    if (flag && M.T) {
      hide(flag, p === null);
      if (p !== null) {
        flag.style.setProperty("--x", p.toFixed(4));
        const text = secs(Math.round(p * M.T));
        if (flag.firstChild.textContent !== text) flag.firstChild.textContent = text;
      }
    }
    const time = tlEl.querySelector(".m-time");
    if (time) {
      const text = p === null ? "" : String(Math.round(p * M.T));
      if (time.textContent !== text) time.textContent = text;
    }
    const state = `${run}|${M.ro && M.ro.on}`;
    const pb = tlEl.querySelector(".play");
    if (pb && pb._s !== state) {
      pb._s = state;
      pb.innerHTML = mi(run ? "pause" : "play");
      pb.classList.toggle("on", !!(M.ro && M.ro.on));
    }
    // outlines: the element under the pointer, the list row's elements, the open one
    const out = [];
    if (M.hover && M.hover !== M.sel && M.hover.isConnected) out.push([rectOf(M.hover), "hover"]);
    for (const el of M.rowEls || []) if (el !== M.sel && el.isConnected) out.push([rectOf(el), "mrow"]);
    const sel = M.sel;
    if (sel && sel.isConnected) {
      const r = rectOf(sel);
      // While it plays, only its corners: the motion is not covered.
      out.push([{ x: Math.round(r.x - 3), y: Math.round(r.y - 3), w: Math.round(r.w + 6), h: Math.round(r.h + 6) }, `${run ? "mcorn" : "csel"}${performance.now() < M.findUntil ? " mfind" : ""}`]);
      const text = name(sel);
      if (tagEl._t !== text) tagEl.textContent = tagEl._t = text;
      hide(tagEl, false);
      const y = r.y - 3 - 20 >= 0 ? r.y - 3 - 20 : r.y + r.h + 5;
      const at = `${Math.max(0, Math.round(r.x - 3))}|${Math.round(y)}`;
      if (tagEl._at !== at) {
        tagEl._at = at;
        tagEl.style.transform = `translate(${Math.max(0, Math.round(r.x - 3))}px, ${Math.round(y)}px)`;
      }
    } else hide(tagEl, true);
    return out;
  }
  /** More frames are needed: something plays, is dragged, or a ring is going out. */
  const busyFrames = () => M.on && S.enabled && (running() || !!M.drag || performance.now() < M.findUntil || !!(M.ro && M.ro.on));

  // ── the page's pointer ───────────────────────────────────────────────────────────────────
  function pointerDown(e) {
    if (popEl && !popEl.hidden) closePop();
    block(e);
    if (e.button !== 0) return;
    const el = pick(e.clientX, e.clientY);
    if (root.activeElement && root.activeElement.blur) root.activeElement.blur();
    selectEl(el);
  }
  function pointerMove(e) {
    if (isOurs(e)) {
      if (M.hover) {
        M.hover = null;
        kick();
      }
      return;
    }
    const next = pick(e.clientX, e.clientY);
    if (next !== M.hover) {
      M.hover = next;
      kick();
    }
  }

  // ── the timeline's pointer ───────────────────────────────────────────────────────────────
  // Click a keyframe (the page shows that frame), drag it, press twice on a lane to add one,
  // drag the ruler or an empty lane to scrub.
  const spanOf = () => tlEl.querySelector(".m-kspan[data-prop]") || tlEl.querySelector("[data-ruler]");
  function atOf(e, free, span) {
    const r = span.getBoundingClientRect(), pad = span.classList.contains("m-kspan") ? 0 : 16;
    const at = clamp(((e.clientX - r.left - pad) / (r.width - 2 * pad)) * 100, 0, 100);
    return free ? r1(at) : Math.round(at / 5) * 5;
  }
  function tlDown(e) {
    if (e.button || !M.open || e.target.closest("input, button, textarea")) return;
    const key = e.target.closest(".m-key"), seg = e.target.closest("[data-seg]"), trk = e.target.closest(".m-kspan[data-prop], [data-ruler]");
    const now = performance.now(), l = M.last;
    const twice = !!l && now - l.t < 350 && Math.abs(e.clientX - l.x) < 5 && Math.abs(e.clientY - l.y) < 5;
    M.last = twice ? null : { t: now, x: e.clientX, y: e.clientY };
    const span = spanOf();
    if (!span) return;
    if (twice && !key && trk && trk.dataset.prop !== undefined && openKf()) {
      e.preventDefault();
      addKey(trk.dataset.prop || null, atOf(e, mod(e), span));
      return focusLater("[data-k=val]");
    }
    if (key || seg) {
      const at = Number(key ? key.dataset.at : seg.dataset.seg), prop = (key || seg).dataset.prop || null;
      M.key = { at, prop };
      M.drag = key && !readOnly() ? { type: "key", at, prop, moved: false } : null;
      seek(at / 100);
      draw();
    } else if (trk) {
      M.drag = { type: "scrub" };
      seek(atOf(e, true, span) / 100);
      if (M.key) {
        M.key = null; // a press beside the keyframes lets go of the selected one
        draw();
      }
    } else return;
    if (M.drag) tlEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    tlEl.focus({ preventScroll: true });
  }
  function tlMove(e) {
    const d = M.drag;
    if (!d) return;
    const span = spanOf();
    if (!span) return;
    if (d.type === "scrub") return seek(atOf(e, true, span) / 100);
    const to = atOf(e, mod(e), span);
    if (to === d.at || !moveKey(d.prop, d.at, to)) return;
    d.at = to;
    M.key = { at: to, prop: d.prop };
    d.moved = true;
    apply();
    seek(to / 100);
    drawLanes();
    if (!typingIn(kbEl)) kbEl.innerHTML = keyEditor();
  }
  function tlUp() {
    const d = M.drag;
    M.drag = null;
    if (d && d.moved) commit();
  }
  const focusLater = (sel) =>
    setTimeout(() => {
      const f = dock.querySelector(sel);
      if (f && !f.disabled) f.select ? f.select() : f.focus();
    }, 0);

  // ── a small sheet over the dock ──────────────────────────────────────────────────────────
  function openPop(anchor, html) {
    popEl.innerHTML = html;
    popEl.hidden = false;
    popAnchor = anchor;
    const r = anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
    popEl.style.left = `${clamp(r.right - w, 8, innerWidth - w - 8)}px`;
    popEl.style.top = `${clamp(r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8, 8, innerHeight - h - 8)}px`;
  }
  function closePop() {
    if (popEl) popEl.hidden = true;
    popAnchor = null;
  }
  function morePop(b) {
    const t = timing(), u = openUse(), ro = readOnly() ? "disabled" : "";
    const count = { ...COUNT, ...(COUNT[t.count] ? {} : { [t.count]: [`${t.count}×`] }) };
    const how = u ? Object.fromEntries(Object.entries(HOW).filter(([k]) => !(u.isNew && k === "asnow")).map(([k, v]) => [k, [v]])) : {};
    const chips = (key, lab, map, cur) => `<div class="m-tchips"><span>${lab}</span><div class="m-chips" data-tkey="${key}">${Object.entries(map).map(([v, [text, what]]) =>
      `<button type="button" class="m-chip${String(cur) === v ? " on" : ""}" data-m="tset" data-v="${esc(v)}" ${ro} title="${esc(what ? `${what} (${v})` : v)}">${esc(text)}</button>`).join("")}</div></div>`;
    openPop(b, chips("count", "Repeat", count, t.count) + chips("direction", "Direction", DIRECTION, t.direction) + chips("fill", "Fill", FILL, t.fill) +
      (u ? chips("how", "Starts", how, u.plays.how) : ""));
  }
  function easePop(b) {
    const k = keyInfo();
    if (!k) return;
    const cur = k.ease || k.dflt;
    openPop(b, `<div class="m-ez">${[...new Set([cur, ...EASINGS])].map((e) => `<button type="button" data-m="ez" data-v="${esc(e)}" class="${e === cur ? "on" : ""}">${curve(e)}${esc(e)}</button>`).join("")}</div>`);
  }

  // ── clicks, fields and keys ──────────────────────────────────────────────────────────────
  function onClick(e) {
    const row = e.target.closest("[data-row]");
    if (row) {
      const r = listEl._rows[row.dataset.row];
      if (r && !r.off) {
        r.open();
        reveal(M.sel);
      }
      return;
    }
    const b = e.target.closest("[data-m]");
    if (!b || b.disabled) return;
    const act = b.dataset.m;
    if (act === "play") toggle();
    else if (act === "rate") {
      M.rate = RATES[(RATES.indexOf(M.rate) + 1) % RATES.length];
      const a = animOf();
      if (a) a.playbackRate = M.rate;
    } else if (act === "loop") (M.loop = !M.loop), (M.loopAt = 0);
    else if (act === "iso") {
      M.isolate = !M.isolate;
      apply();
    } else if (act === "undo") return travel(M.past, M.future);
    else if (act === "discard") return discard();
    else if (act === "new") return newAnimation();
    else if (act === "rmkey") return removeKey();
    else if (act === "rmlane") return removeLane(b.dataset.prop);
    else if (act === "detach") return detach();
    else if (act === "view") M.view = b.dataset.v;
    else if (act === "more") return popAnchor === b ? closePop() : morePop(b);
    else if (act === "kease") return popAnchor === b ? closePop() : easePop(b);
    else if (act === "ez") {
      setKey("ease", b.dataset.v, true);
      return closePop();
    } else if (act === "tset") {
      // a chip: set, and marked in its row here (the popover is not drawn again)
      const row2 = b.closest("[data-tkey]");
      setTiming(row2.dataset.tkey, b.dataset.v, true);
      for (const c of row2.children) c.classList.toggle("on", c === b);
      return;
    } else if (act === "send") return submit(e.altKey);
    draw();
  }
  function onField(e, done) {
    const f = e.target;
    if (f === noteEl) return drawFoot();
    if (f.dataset.css !== undefined) {
      const why = setCss(f.value), err = f.parentElement.querySelector(".m-err");
      if (err) (err.hidden = !why), (err.textContent = why);
      if (!why) drawFoot();
      return;
    }
    if (f.dataset.t !== undefined) {
      const ok = setTiming(f.dataset.t, f.value, done);
      f.classList.toggle("bad", !ok);
      if (ok && !done) drawLanes();
    } else if (f.dataset.k !== undefined) {
      const ok = setKey(f.dataset.k, f.value, done);
      f.classList.toggle("bad", !ok);
      if (ok && !done) drawLanes();
    } else if (f.dataset.addp !== undefined && done && f.value.trim()) {
      if (!addLane(f.value)) f.classList.add("bad");
      else focusLater("[data-k=val]");
    }
  }
  /** Keys while motion mode is on. Typing in the dock's fields never reaches the page. */
  function key(e) {
    const f = root.activeElement;
    const field = f && /^(INPUT|TEXTAREA)$/.test(f.tagName) && (dock.contains(f) || popEl.contains(f)) ? f : null;
    if (field) {
      if (e.key === "Enter" && !e.isComposing && (field.tagName === "INPUT" || mod(e))) {
        block(e);
        if (field === noteEl || mod(e)) return submit(e.altKey);
        field.blur(); // its change event makes the undo step
        return;
      }
      if (e.key === "Escape") {
        block(e);
        field.blur();
        // Esc in a keyframe's field is done with that keyframe too.
        if (field.dataset.k !== undefined) {
          M.key = null;
          draw();
        }
        return;
      }
      e.stopImmediatePropagation(); // typing: the page's handlers never see it
      return;
    }
    if (mod(e) && e.key.toLowerCase() === "z") {
      block(e);
      return e.shiftKey ? travel(M.future, M.past) : travel(M.past, M.future);
    }
    if (mod(e) || e.altKey && e.key !== "Enter") return;
    if (e.key === " ") {
      block(e);
      toggle();
      return draw();
    }
    if (e.key === "Enter" && !e.isComposing) {
      block(e);
      return submit(e.altKey);
    }
    if ((e.key === "Delete" || e.key === "Backspace") && M.key && openKf()) {
      block(e);
      return removeKey();
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (!M.open) return;
      block(e);
      return seek((position() ?? M.pos) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01));
    }
    if (e.key === "Escape") {
      block(e);
      if (popEl && !popEl.hidden) closePop();
      else if (M.key) {
        M.key = null;
        draw();
      } else if (M.open || M.sel) selectEl(null);
      else setOn(false);
    }
  }

  // ── mount ────────────────────────────────────────────────────────────────────────────────
  function mount() {
    dock = root.querySelector(".m-dock");
    listEl = dock.querySelector(".m-list");
    hdEl = dock.querySelector(".m-hd");
    tlEl = dock.querySelector(".m-tl");
    cssEl = dock.querySelector(".m-css");
    kbEl = dock.querySelector(".m-kb");
    ftEl = dock.querySelector(".m-ft");
    noteEl = dock.querySelector(".m-note");
    msgEl = dock.querySelector(".m-msg");
    popEl = root.querySelector(".m-pop");
    tagEl = root.querySelector(".m-tag");
    root.querySelector(".m-lists").innerHTML = `<datalist id="b42-m-easings">${EASINGS.map((x) => `<option value="${x}">`).join("")}</datalist><datalist id="b42-m-props">${PROPS.map((x) => `<option value="${x}">`).join("")}</datalist>`;
    for (const el of [dock, popEl]) {
      el.addEventListener("click", onClick);
      el.addEventListener("input", (e) => onField(e, false));
      el.addEventListener("change", (e) => onField(e, true));
      // Keys typed into the dock must not reach the page's own shortcuts.
      for (const t of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut"]) el.addEventListener(t, (e) => e.stopPropagation());
    }
    dock.addEventListener("focusout", (e) => {
      if (e.target.dataset && e.target.dataset.css !== undefined) commit();
      if (e.target === noteEl) {
        drawFoot();
        draftChanged();
      }
    });
    noteEl.addEventListener("focus", drawFoot);
    // A button keeps the caret where it was (the note, a value being typed).
    dock.addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
    listEl.addEventListener("pointerover", (e) => {
      const row = e.target.closest("[data-row]");
      const r = row && listEl._rows[row.dataset.row];
      M.rowEls = r && r.els && r.els.length ? r.els : null;
      kick();
    });
    listEl.addEventListener("pointerleave", () => {
      M.rowEls = null;
      kick();
    });
    tlEl.addEventListener("pointerdown", tlDown);
    tlEl.addEventListener("pointermove", tlMove);
    tlEl.addEventListener("pointerup", tlUp);
    tlEl.addEventListener("pointercancel", tlUp);
  }

  return {
    get on() {
      return M.on;
    },
    mount, setOn, resume, syncUi, letGo, frame, busyFrames, key, pointerDown, pointerMove, submit, refuse, finish, dropFinished, draft, restore,
    hasSent: () => M.sent.length > 0,
    busy: () => !!M.drag,
    /** For tests: the engine's state and a few actions. */
    debug: { M, seek, play, pause, position, select: selectEl, openCss, setTiming, setKey, rows },
  };
})();

