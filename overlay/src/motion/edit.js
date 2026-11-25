// Motion mode, editing: undo, keyframes shared or made the element's own, a keyframe or a lane
// added, moved or removed, the timing, the keyframes as text; and the list's rows, as data.

import { adopt, BOOST, editSel } from "../page.js";
import { kick } from "../render.js";
import { treeVersion } from "../mount.js";
import { draftChanged } from "../draft.js";
import { apiName, apply, DIRECTION, editKf, FILL, frames, HOW, kfDirty, M, MAX_KF, mq, name, openKf, openScr, openUse, parseKf, pathOf, playsDirty, r1, readList, scan, scriptDirty, serialize, splitTop, trCss, trDirty, useDirty } from "./model.js";
import { animOf, applyScript, layout, openCss, openScript, openTransition, resetScript, seek, syncTransition, useKf, useOf } from "./open.js";
import { draw, drawList, flash } from "./draw.js";
import { near, nearAgain, nearDue } from "./near.js";
import { openFrames } from "./frames.js";

// ── undo ─────────────────────────────────────────────────────────────────────────────────
export const snapshot = () => JSON.stringify({ kf: [...M.kf], use: [...M.use], tr: [...M.tr], sc: openScr() && (({ id, timing, frames }) => ({ id, timing, frames }))(M.ro), open: M.open && M.open.kind === "css" ? M.open : null });
export function commit() {
  const now = snapshot();
  if (now !== M.snap) {
    M.past.push(M.snap);
    if (M.past.length > 200) M.past.shift();
    M.snap = now;
    M.future = [];
  }
  apply();
  applyScript();
  scan();
  draw();
  draftChanged();
}
export function travel(from, to) {
  if (!from.length) return;
  to.push(M.snap);
  M.snap = from.pop();
  const s = JSON.parse(M.snap);
  M.kf = new Map(s.kf);
  M.use = new Map(s.use);
  M.tr = new Map(s.tr || []);
  syncTransition();
  // (A step of another reading of it, or of another animation, says nothing of this one.)
  if (openScr() && s.sc && s.sc.id === M.ro.id) {
    M.ro.timing = s.sc.timing;
    M.ro.frames = s.sc.frames;
    applyScript();
  }
  const keep = M.open && M.open.kind !== "css" ? M.open : s.open;
  M.open = keep && (keep.kind !== "css" || M.use.has(`${keep.rs}|${keep.name}`)) ? keep : null;
  M.key = null;
  apply();
  scan();
  draw();
  draftChanged();
}
/** The open animation as the page has it (or as it was last sent): its edits go. */
export function discard() {
  if (M.open && M.open.kind === "transition") {
    M.tr.delete(M.open.rs);
    syncTransition();
    return commit();
  }
  if (openScr()) {
    resetScript();
    M.key = null;
    return commit();
  }
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
  if (k && k.isNew) {
    // made here: they go, unless another element was given them too
    if (![...M.use.values()].some((x) => x.name === k.name)) M.kf.delete(k.name);
  } else if (k) k.frames = parseKf(k.orig).frames;
  if (u.isNew) M.open = null;
  M.key = null;
  commit();
}

// ── shared keyframes ─────────────────────────────────────────────────────────────────────
/** How many elements play the open keyframes. A change to them changes every one. */
export function sharedBy() {
  const k = openKf();
  const a = k && M.scan.anims.find((x) => x.name === k.name);
  return a ? a.els.length : 1;
}
/** The open element gets keyframes of its own: a copy, under a new name, with the changes made
 *  so far; the shared ones go back to what the page has, for the other elements. */
export function detach() {
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
/** A keyframe made here: it adds to what is under it when the one it is like does. */
const newFrame = (at, like) => ({ at, ease: "", vals: {}, ...(like && like.composite ? { composite: like.composite } : {}) });
export function moveKey(prop, from, to) {
  const k = editKf();
  if (!k) return false;
  const F = k.frames, a = F.find((f) => f.at === from);
  let b = F.find((f) => f.at === to);
  if (!a || from === to) return false;
  if (prop === null) {
    if (b) return false;
    a.at = to;
  } else {
    if (b && prop in b.vals) return false;
    if (!b) F.push((b = newFrame(to, a)));
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
export function addKey(prop, at) {
  const k = editKf(), el = mq(M.open && M.open.rs);
  if (!k || !el) return;
  let f = k.frames.find((x) => x.at === at);
  const props = prop === null ? laneOrder() : [prop];
  seek(at / 100);
  const cs = getComputedStyle(el);
  for (const p of props) {
    if (f && p in f.vals) continue;
    let v = cs.getPropertyValue(p).replace(/-?\d*\.\d{4,}/g, (/** @type {any} */ n) => String(Math.round(n * 1000) / 1000));
    if (/^matrix/.test(v) || !v || k.frames.some((x) => x.composite)) {
      const before = k.frames.filter((x) => x.at <= at && p in x.vals).pop() || k.frames.find((x) => p in x.vals);
      v = before ? before.vals[p] : v || "initial";
    }
    if (!f) k.frames.push((f = newFrame(at, k.frames[0])));
    f.vals[p] = v;
  }
  k.frames.sort((x, y) => x.at - y.at);
  M.key = { at, prop };
  commit();
}
export function removeKey() {
  const k = editKf(), selKey = M.key;
  if (!k || !selKey) return;
  const f = k.frames.find((x) => x.at === selKey.at);
  if (!f) return;
  if (selKey.prop === null) k.frames.splice(k.frames.indexOf(f), 1);
  else {
    delete f.vals[selKey.prop];
    if (!Object.keys(f.vals).length) k.frames.splice(k.frames.indexOf(f), 1);
  }
  M.key = null;
  commit();
}
export function addLane(prop) {
  const k = editKf(), el = mq(M.open && M.open.rs);
  prop = prop.trim().toLowerCase();
  if (!k || !el || !prop || !CSS.supports(prop, "initial") || laneOrder().includes(prop)) return false;
  const now = getComputedStyle(el).getPropertyValue(prop) || "initial";
  const v = /^matrix/.test(now) ? "none" : now;
  for (const at of [0, 100]) {
    let f = k.frames.find((x) => x.at === at);
    if (!f) k.frames.push((f = newFrame(at, k.frames[0])));
    f.vals[prop] = v;
  }
  k.frames.sort((x, y) => x.at - y.at);
  M.key = { at: 100, prop };
  commit();
  seek(1);
  return true;
}
export function removeLane(prop) {
  const k = editKf();
  if (!k) return;
  for (const f of k.frames) delete f.vals[prop];
  k.frames = k.frames.filter((f) => Object.keys(f.vals).length);
  M.key = null;
  commit();
}
/** The lanes keep their place while keyframes are dragged past each other. */
export function laneOrder() {
  const have = new Set(frames().flatMap((f) => Object.keys(f.vals)));
  M.lanes = M.lanes.filter((p) => have.has(p));
  for (const p of have) if (!M.lanes.includes(p)) M.lanes.push(p);
  return M.lanes;
}
export function keyInfo() {
  const selKey = M.key, o = M.open;
  if (!selKey || !o) return null;
  const f = frames().find((x) => x.at === selKey.at);
  if (!f) return null;
  const ro = !editKf();
  const t = timing();
  const ease = (M.ro && M.ro.laneEase && selKey.prop ? M.ro.laneEase[selKey.prop] : f.ease) || "";
  return { f, at: f.at, prop: selKey.prop, value: selKey.prop ? f.vals[selKey.prop] : null, ease, dflt: o.kind === "script" ? "linear" : t ? t.easing : "", last: f.at >= 100 || o.kind === "transition", ro };
}
/** One field of the selected keyframe: "val", "ease" or "at". False when the browser says no. */
export function setKey(what, v, done) {
  const k = editKf(), selKey = M.key;
  if (!k || !selKey) return false;
  const fr = k.frames.find((x) => x.at === selKey.at);
  if (!fr) return false;
  v = String(v).trim();
  let ok = true;
  if (what === "val") {
    ok = v !== "" && v.length <= 400 && CSS.supports(selKey.prop, v);
    if (ok) fr.vals[selKey.prop] = v;
  } else if (what === "ease") {
    ok = v === "" || CSS.supports("animation-timing-function", v);
    if (ok) fr.ease = v;
  } else if (what === "at") {
    const to = r1(Number(v));
    ok = v !== "" && to >= 0 && to <= 100;
    if (ok && done && moveKey(selKey.prop, selKey.at, to)) selKey.at = to;
  }
  if (!ok) return false;
  apply();
  applyScript();
  if (done) {
    commit();
    seek(M.key ? M.key.at / 100 : M.pos);
  }
  return true;
}
export function segEase(at, prop) {
  const f = frames().find((x) => x.at === at);
  const own = M.ro && M.ro.laneEase ? M.ro.laneEase[prop] : f ? f.ease : "";
  const t = timing();
  // (A script's easing is of the whole run, and between its keyframes it goes in a straight line:
  // of two keyframes that is the one stretch.)
  if (!own && openScr() && frames().length > 2) return "linear";
  return own || (t ? t.easing : "");
}

// ── timing ───────────────────────────────────────────────────────────────────────────────
export function timing() {
  const o = M.open;
  if (!o) return null;
  if (o.kind === "css") return openUse().timing;
  if (o.kind === "script") return M.ro.timing;
  if (o.kind === "frames") return { duration: (M.ro.seen && M.ro.seen.cycle) || 0, delay: 0, easing: "linear", count: "1", direction: "normal", fill: "none" };
  // A transition's is its properties': the longest, the earliest, the first's easing.
  const it = M.ro.items;
  return { duration: it.length ? Math.max(...it.map((x) => x.duration)) : 0, delay: it.length ? Math.min(...it.map((x) => x.delay)) : 0, easing: it.length ? it[0].easing : "ease", count: "1", direction: "normal", fill: "none" };
}
/** One field of the timing, or of what starts it ("how"). False when the value is not one. */
export function setTiming(what, v, done) {
  if (M.open && M.open.kind === "transition") return setTransition(what, v, done);
  const sc = openScr();
  const u = sc || openUse();
  if (!u) return false;
  if (what === "how") {
    if (sc) return false;
    if (!HOW[v]) return false;
    u.plays.how = v;
  } else {
    let val = /** @type {any} */ (String(v).trim()), ok = true;
    if (what === "duration" || what === "delay") {
      ok = val !== "" && Number.isFinite(Number(val)) && Math.abs(Number(val)) <= 600000 && (what === "delay" || Number(val) >= 0);
      val = Number(val);
    } else if (what === "easing") ok = CSS.supports("animation-timing-function", val);
    else if (what === "count") ok = val === "infinite" || (Number(val) >= 0 && Number.isFinite(Number(val)));
    else if (what === "direction") ok = !!DIRECTION[val];
    else if (what === "fill") ok = !!FILL[val];
    else ok = false;
    if (!ok) return false;
    const paused = (animOf() || {}).playState === "paused";
    u.timing[what] = val;
    if (sc) applyScript();
    else apply();
    if (paused) seek(M.pos);
  }
  if (done) commit();
  return true;
}

/** A transition's duration, delay or easing: of all its properties at once (one that differs
 *  from the others is said in the note). */
function setTransition(what, v, done) {
  const ro = M.ro, rs = M.open.rs;
  let val = /** @type {any} */ (String(v).trim()), ok;
  if (what === "duration" || what === "delay") {
    ok = val !== "" && Number.isFinite(Number(val)) && Math.abs(Number(val)) <= 600000 && (what === "delay" || Number(val) >= 0);
    val = Number(val);
  } else ok = what === "easing" && CSS.supports("transition-timing-function", val);
  if (!ok || !ro) return false;
  const mine = M.tr.get(rs) || M.tr.set(rs, { rs, items: JSON.parse(JSON.stringify(ro.items)), orig: ro.orig }).get(rs);
  // (Its delay is the earliest property's: the others keep how much later they are.)
  const first = Math.min(...mine.items.map((x) => x.delay));
  for (const x of mine.items) x[what] = what === "delay" ? x.delay + val - first : val;
  ro.items = mine.items;
  if (!trDirty(mine)) M.tr.delete(rs);
  layout();
  apply();
  if (done) commit();
  return true;
}

// ── the text ─────────────────────────────────────────────────────────────────────────────
export function cssText() {
  const k = openKf();
  if (k) return serialize(k.name, k.frames);
  if (M.ro && M.open.kind === "script") return animateText();
  if (M.ro && M.open.kind === "transition") return `${editSel(M.sel)} {\n  transition: ${trCss(M.ro.items).replace(/, /g, ",\n    ")};\n}`;
  return "";
}
/** A script's keyframes as animate() takes them. */
export const keysText = (list) => `[\n${list.map((f) => {
  const q = (v) => JSON.stringify(String(v));
  return `  { ${[`offset: ${r1(f.at) / 100}`, ...Object.entries(f.vals).map(([p, v]) => `${p.startsWith("--") ? q(p) : apiName(p)}: ${q(v)}`), ...(f.ease ? [`easing: ${q(f.ease)}`] : []), ...(f.composite ? [`composite: ${q(f.composite)}`] : [])].join(", ")} }`;
}).join(",\n")}\n]`;
/** A script's animation as the call that would make it: rebuilt from the animation as it runs,
 *  not the page's source (which nothing in the page leads back to), and it says so. */
function animateText() {
  const t = M.ro.timing, q = (v) => JSON.stringify(String(v));
  const opts = [`duration: ${Math.round(+t.duration || 0)}`];
  if (t.delay) opts.push(`delay: ${Math.round(t.delay)}`);
  if (t.easing && t.easing !== "linear") opts.push(`easing: ${q(t.easing)}`);
  if (String(t.count) !== "1") opts.push(`iterations: ${t.count === "infinite" ? "Infinity" : t.count}`);
  if (t.direction !== "normal") opts.push(`direction: ${q(t.direction)}`);
  if (t.fill !== "none") opts.push(`fill: ${q(t.fill)}`);
  return `// A script's animation, written out from the animation as it runs.\n// The page's own code may say it another way (a library, a helper).\nelement.animate(${keysText(M.ro.frames)}, { ${opts.join(", ")} })`;
}

// ── what moves together ──────────────────────────────────────────────────────────────────
/** The open animation among its neighbours: every keyframe animation of the elements in the
 *  open element's parent (a row of cards that come in one after another; a line that draws and
 *  the head that appears when it has), each with when it starts and how long it lasts, as edited
 *  here. Empty when it moves alone. */
export function score() {
  const o = M.open, home = M.sel && M.sel.parentElement;
  if (!o || o.kind !== "css" || !home) return [];
  const out = [];
  rows(); // (read again if the page changed; and its order, not the list's, which starts with what is in view)
  for (const r of M.found) {
    if (r.group || r.kind !== "css" || r.els.length !== 1 || !r.path || !home.contains(r.els[0])) continue;
    // (As the list read it from the page, or as changed here: nothing of the page is read for a view.)
    const u = M.use.get(`${r.path}|${r.name}`), e = u ? u.timing : r;
    if (e.duration === null || out.some((x) => x.id === r.id)) continue;
    out.push({ id: r.id, path: r.path, text: name(r.els[0], true), name: r.name, delay: Math.round(+e.delay || 0), duration: Math.round(+e.duration || 0), on: rowNow(r).on });
    if (out.length === 12) break;
  }
  return out.length > 1 ? out : [];
}
/** One of them starts later or earlier (its bar dragged): its delay, as the Delay field changes
 *  the open one's, of an animation that need not be open. */
export function setStagger(id, v, done) {
  const x = score().find((s) => s.id === id), el = x && mq(x.path);
  if (!el) return false;
  if (x.on) return setTiming("delay", v, done);
  const u = M.use.get(`${x.path}|${x.name}`) || useOf(el, x.name), val = Number(v);
  if (!u || !Number.isFinite(val) || Math.abs(val) > 600000) return false;
  u.timing.delay = val;
  apply();
  if (done) commit();
  return true;
}
/** They all start again, together: each after its own delay, as on the page when it loads. */
export function playTogether() {
  const sc = score();
  if (!sc.length || !M.sel) return false;
  const off = new CSSStyleSheet();
  try {
    off.replaceSync(`${[...new Set(sc.map((x) => `${x.path}${BOOST}${BOOST}`))].join(", ")} { animation: none !important; }`);
    adopt(off, true);
    getComputedStyle(M.sel).animationName;
  } catch {}
  adopt(off, false);
  getComputedStyle(M.sel).animationName;
  M.held = null;
  for (const x of sc) {
    const el = mq(x.path);
    for (const a of el ? el.getAnimations() : []) if (/** @type {any} */ (a).animationName) a.playbackRate = M.rate;
  }
  kick();
  return true;
}

export function setCss(text) {
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
  const renamed = p.name !== k.name;
  if (renamed && (why = nameProblem(p.name))) return why;
  if (renamed) rename(k, p.name);
  k.frames = p.frames;
  if (M.key && !k.frames.some((f) => f.at === M.key.at && (M.key.prop === null || M.key.prop in f.vals))) M.key = null;
  apply();
  if (renamed) {
    // The list is drawn from what the page plays: under the old name, a row would open nothing.
    scan();
    drawList();
  }
  return "";
}
/** Why `nm` cannot be the open keyframes' new name, or "". */
export function nameProblem(nm) {
  if (!/^-?[a-zA-Z_][\w-]{0,60}$/.test(nm)) return "A name is letters, digits, - and _, and starts with a letter";
  if (M.kf.has(nm) || M.scan.rules.has(nm) || M.scan.anims.some((a) => a.name === nm)) return `“${nm}” is taken`;
  return "";
}
function rename(k, nm) {
  if (nameProblem(nm)) return false;
  M.kf.delete(k.name);
  for (const [id, u] of [...M.use])
    if (u.name === k.name) {
      M.use.delete(id);
      u.name = nm;
      M.use.set(`${u.rs}|${nm}`, u);
    }
  if (M.open.name === k.name) M.open.name = nm;
  k.name = nm;
  M.kf.set(nm, k);
  M.held = null;
  return true;
}
/** The name typed in the band, for keyframes made here. */
export function setName(v, done) {
  const k = openKf(), nm = String(v).trim();
  if (!k || !k.isNew) return false;
  if (nm === k.name) return true;
  const why = nameProblem(nm);
  if (why) {
    if (done) flash(why);
    return false;
  }
  if (!done) return true;
  rename(k, nm);
  commit();
  return true;
}

// ── the list ─────────────────────────────────────────────────────────────────────────────
// A row says `text`, and smaller beside it `aside`: an animation's name and what plays it, or,
// for what has no name (a transition, a script's frames), the element and what moves. A row
// under a group of elements says only its element.
//
// A row is made in two parts. What is read from the page (`rows`: what moves, its elements,
// their paths and words, the duration the page's CSS gives) costs a look at every sibling for a
// path and a computed style for a duration, for each row; so it is read once per look at the
// page and kept (M.list: scan() drops it, and so does an element a script moves coming or
// going, and any element coming into the page or leaving it). Its order is worked out apart
// (inViewFirst), from the rows as read (M.found). What the reviewer's own state says of a row (`rowNow`: it is open, it has unsent
// edits, its duration as edited) is worked out from M alone, for every view. A view for a
// keystroke or a step of a drag then reads nothing of the page for its list.
/** The rows as read from the page, each with an `id` that names the same thing in the next
 *  list (its kind, the animation it is under, its element, its words), its elements (`els`), the
 *  one element's path (`path`, "" when it is not of one element) and what opens it (`open`). */
export function rows() {
  // (An element put into the page or taken out of it moves the paths of those after it, and a
  // path is what an element's edits are kept under: the list is read again then.)
  const kept = M.list && M.listTree === treeVersion;
  if (kept && !nearDue()) return M.list;
  if (!kept) M.found = listOf(M.scan);
  return (M.list = inViewFirst(M.found));
}
/** The rows of what a look at the page found, in the page's order. */
function listOf(found) {
  M.listTree = treeVersion;
  const out = /** @type {any[]} */ ([]);
  /** How the page's CSS has one element play one animation, as far as a row says it. */
  const played = (el, nm) => {
    const e = readList(el).find((x) => x.name === nm);
    return { path: pathOf(el), duration: e ? e.duration : null, delay: e ? e.delay : 0 };
  };
  if (found.anims.length) out.push({ group: "Animations" });
  for (const a of found.anims) {
    const one = a.els.length === 1;
    out.push({ kind: "css", name: a.name, els: a.els, text: a.name, aside: one ? name(a.els[0], true) : `${a.els.length} elements`, running: a.running,
      ...(one ? played(a.els[0], a.name) : { path: "", duration: null }), open: () => openCss(a.els[0], a.name) });
    if (!one)
      a.els.forEach((el, j) => {
        out.push({ kind: "css", name: a.name, els: [el], sub: true, last: j === a.els.length - 1, text: name(el, true), aside: "", ...played(el, a.name), open: () => openCss(el, a.name) });
      });
  }
  if (found.transitions.length) out.push({ group: "Transitions" });
  // Elements that change the same way (the same properties, as long, as eased, as late) are one
  // row, named by the rule that says so, with its elements under it: a page whose every link
  // has `transition: color` is one line, not a line a link.
  const same = new Map();
  for (const el of found.transitions) {
    const cs = getComputedStyle(el), is = `${cs.transitionProperty}|${cs.transitionDuration}|${cs.transitionTimingFunction}|${cs.transitionDelay}`;
    const g = same.get(is) || same.set(is, { els: [], props: cs.transitionProperty, duration: Math.max(...splitTop(cs.transitionDuration).map((d) => parseFloat(d) * 1000)) }).get(is);
    g.els.push(el);
  }
  for (const g of same.values()) {
    const one = (el, more) => ({ kind: "transition", els: [el], path: pathOf(el), text: name(el, true), duration: g.duration, open: () => openTransition(el), ...more });
    if (g.els.length === 1) {
      out.push(one(g.els[0], { aside: g.props }));
      continue;
    }
    let by = "";
    for (const sel of found.trRules) {
      try {
        if (g.els[0].matches(sel)) by = sel;
      } catch {}
    }
    by = by.replace(/\s+/g, " ");
    out.push({ kind: "transition", els: g.els, path: "", text: by ? (by.length > 44 ? `${by.slice(0, 43)}…` : by) : g.props, aside: `${g.els.length} elements · ${g.props}`, duration: g.duration, open: () => openTransition(g.els[0]) });
    g.els.forEach((el, j) => out.push(one(el, { sub: true, last: j === g.els.length - 1, aside: "" })));
  }
  if (found.scripts.length || M.suspects.size) out.push({ group: "Scripts" });
  for (const a of found.scripts)
    out.push({ kind: "script", anim: a, els: [a.effect.target], path: pathOf(a.effect.target), text: a.id || "animate()", aside: name(a.effect.target, true),
      duration: +a.effect.getTiming().duration || 0, open: () => openScript(a) });
  for (const el of M.suspects)
    if (el.isConnected) out.push({ kind: "frames", els: [el], path: pathOf(el), text: name(el, true), aside: "per frame", duration: null, open: () => openFrames(el) });
  // Keyframes a rule of the page plays, though no element does now: in a state, on a ::before.
  if (found.idle.length) out.push({ group: "Not playing now" });
  for (const x of found.idle) out.push({ kind: "unused", els: [], path: "", text: x.name, aside: x.on.length > 60 ? `${x.on.slice(0, 59)}…` : x.on, duration: null, open: () => useKf(x.name) });
  // (A page looked at in part: what no element was seen to play may be played further down.)
  if (found.unused.length) out.push({ group: found.partial ? "Not seen playing" : "Unused" });
  for (const n of found.unused) out.push({ kind: "unused", els: [], path: "", text: n, aside: "", duration: null, open: () => useKf(n) });
  const seen = new Map();
  let under = "";
  for (const r of out) {
    if (r.group) continue;
    if (!r.sub) under = r.text;
    const id = `${r.kind}|${r.sub ? under : ""}|${r.path}|${r.text}`, n = seen.get(id) || 0;
    seen.set(id, n + 1);
    r.id = n ? `${id}#${n}` : id;
  }
  return out;
}
/** The list, what is in view first: under "In view" whatever moves there (its icon says what kind
 *  it is), then the rest under its groups, which say they are elsewhere. Keyframes several
 *  elements play, and elements that change the same way, stay together: in view when one of them
 *  is, those first. A page all in view, or not at all, is one list. What no element plays is of
 *  no place. */
function inViewFirst(list) {
  nearAgain();
  const all = [], here = [], there = [];
  let group = null, under = null, elsewhere = false;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.group) {
      all.push((group = r));
      continue;
    }
    let unit = [r];
    while (list[i + 1] && list[i + 1].sub) unit.push(list[++i]);
    const is = r.els.some(near);
    if (unit.length > 1) {
      const subs = unit.slice(1), first = [...subs.filter((x) => near(x.els[0])), ...subs.filter((x) => !near(x.els[0]))];
      first.forEach((x, j) => (x.last = j === first.length - 1));
      r.open = first[0].open; // pressed, the row of them all opens the first
      unit = [r, ...first];
    }
    all.push(...unit);
    if (is) {
      here.push(...unit);
      continue;
    }
    if (group !== under) there.push((under = group) && r.els.length ? { group: `${group.group} elsewhere` } : group);
    if (r.els.length) elsewhere = true;
    there.push(...unit);
  }
  return here.length && elsewhere ? [{ group: "In view" }, ...here, ...there] : all;
}
/** What the reviewer's state says of a row of the list now: it is what is open (`on`), it has
 *  unsent edits (`dirty`), how long it lasts (as edited here, else as the page has it), there is
 *  nothing to open (`off`), it plays (`running`). Nothing of the page is read for it, but whether
 *  a script's animation is running. */
export function rowNow(r) {
  const o = M.open, now = { on: false, dirty: false, duration: r.duration, off: false, running: !!r.running };
  if (r.kind === "css") {
    // (Keyframes several elements play: the row of the name is no one element's, the rows under it are.)
    const u = r.path ? M.use.get(`${r.path}|${r.name}`) : undefined, own = useDirty(u) || playsDirty(u);
    const mine = !!o && o.kind === "css" && o.name === r.name;
    now.on = mine && (r.sub ? o.rs === r.path : r.els.length === 1);
    now.dirty = r.sub ? own : kfDirty(M.kf.get(r.name)) || own;
    if (u) now.duration = u.timing.duration;
  } else if (r.kind === "transition") {
    now.on = !!o && o.kind === "transition" && !!r.path && o.rs === r.path;
    const t = r.path ? M.tr.get(r.path) : null;
    now.dirty = r.path ? trDirty(t) : r.els.some((el) => trDirty(M.tr.get(pathOf(el))));
    if (t && trDirty(t)) now.duration = Math.max(...t.items.map((x) => x.duration));
  }
  else if (r.kind === "script") {
    now.on = !!o && o.kind === "script" && M.held === r.anim;
    now.dirty = now.on && scriptDirty();
    now.running = r.anim.playState === "running";
  } else if (r.kind === "frames") {
    now.on = !!o && o.kind === "frames" && M.sel === r.els[0];
    now.running = true;
  } else if (r.kind === "unused") now.off = !M.sel;
  return now;
}
