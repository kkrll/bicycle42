// Motion mode, editing: undo, keyframes shared or made the element's own, a keyframe or a lane
// added, moved or removed, the timing, the keyframes as text; and the list's rows, as data.

import { editSel } from "../page.js";
import { draftChanged } from "../draft.js";
import { apply, DIRECTION, FILL, frames, HOW, kfDirty, M, MAX_KF, mq, ms, name, openKf, openUse, parseKf, pathOf, playsDirty, r1, readList, scan, serialize, splitTop, useDirty } from "./model.js";
import { animOf, openCss, openScript, openTransition, seek, useKf } from "./open.js";
import { draw, drawList, flash } from "./draw.js";

// ── undo ─────────────────────────────────────────────────────────────────────────────────
export const snapshot = () => JSON.stringify({ kf: [...M.kf], use: [...M.use], open: M.open && M.open.kind === "css" ? M.open : null });
export function commit() {
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
export function travel(from, to) {
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
export function discard() {
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
export function moveKey(prop, from, to) {
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
export function addKey(prop, at) {
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
export function removeKey() {
  const k = openKf(), selKey = M.key;
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
export function removeLane(prop) {
  const k = openKf();
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
  const ro = o.kind !== "css";
  const t = timing();
  const ease = (M.ro && M.ro.laneEase && selKey.prop ? M.ro.laneEase[selKey.prop] : f.ease) || "";
  return { f, at: f.at, prop: selKey.prop, value: selKey.prop ? f.vals[selKey.prop] : null, ease, dflt: t ? t.easing : "", last: f.at >= 100 || o.kind === "transition", ro };
}
/** One field of the selected keyframe: "val", "ease" or "at". False when the browser says no. */
export function setKey(what, v, done) {
  const k = openKf(), selKey = M.key;
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
  return own || (t ? t.easing : "");
}

// ── timing ───────────────────────────────────────────────────────────────────────────────
export function timing() {
  const o = M.open;
  if (!o) return null;
  if (o.kind === "css") return openUse().timing;
  if (o.kind === "script") return M.ro.timing;
  return { duration: M.ro.total, delay: 0, easing: M.ro.items.length ? M.ro.items[0].easing : "ease", count: "1", direction: "normal", fill: "none" };
}
/** One field of the timing, or of what starts it ("how"). False when the value is not one. */
export function setTiming(what, v, done) {
  const u = openUse();
  if (!u) return false;
  if (what === "how") {
    if (!HOW[v]) return false;
    u.plays.how = v;
  } else {
    let val = String(v).trim(), ok = true;
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
    apply();
    if (paused) seek(M.pos);
  }
  if (done) commit();
  return true;
}

// ── the text ─────────────────────────────────────────────────────────────────────────────
export function cssText() {
  const k = openKf();
  if (k) return serialize(k.name, k.frames);
  if (M.ro && M.open.kind === "script") return serialize(M.open.name, M.ro.frames);
  if (M.ro && M.open.kind === "transition") return `${editSel(M.sel)} {\n  transition: ${M.ro.items.map((x) => `${x.prop} ${ms(x.duration)} ${x.easing}`).join(",\n    ")};\n}`;
  return "";
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
export function rows() {
  const found = M.scan, o = M.open, out = [];
  const timingOf = (el, nm) => {
    const u = M.use.get(`${pathOf(el)}|${nm}`);
    return u ? u.timing : readList(el).find((x) => x.name === nm) || null;
  };
  const dirtyUse = (el, nm) => {
    const u = M.use.get(`${pathOf(el)}|${nm}`);
    return useDirty(u) || playsDirty(u);
  };
  if (found.anims.length) out.push({ group: "Animations" });
  for (const a of found.anims) {
    const k = M.kf.get(a.name), one = a.els.length === 1, mine = o && o.kind === "css" && o.name === a.name;
    const t = one ? timingOf(a.els[0], a.name) : null;
    out.push({ kind: "css", els: a.els, text: a.name, aside: one ? name(a.els[0], true) : `${a.els.length} elements`, running: a.running,
      dirty: kfDirty(k) || (one && dirtyUse(a.els[0], a.name)), on: mine && one, duration: t ? t.duration : null, open: () => openCss(a.els[0], a.name) });
    if (!one)
      a.els.forEach((el, j) => {
        const t2 = timingOf(el, a.name);
        out.push({ kind: "css", els: [el], sub: true, last: j === a.els.length - 1, text: name(el, true), aside: "", dirty: dirtyUse(el, a.name),
          on: mine && o.rs === pathOf(el), duration: t2 ? t2.duration : null, open: () => openCss(el, a.name) });
      });
  }
  if (found.transitions.length) out.push({ group: "Transitions" });
  for (const el of found.transitions) {
    const cs = getComputedStyle(el);
    out.push({ kind: "transition", els: [el], text: name(el, true), aside: cs.transitionProperty, on: o && o.kind === "transition" && o.rs === pathOf(el),
      duration: Math.max(...splitTop(cs.transitionDuration).map((d) => parseFloat(d) * 1000)), open: () => openTransition(el) });
  }
  if (found.scripts.length || M.suspects.size) out.push({ group: "Scripts" });
  for (const a of found.scripts)
    out.push({ kind: "script", els: [a.effect.target], text: a.id || "animate()", aside: name(a.effect.target, true), running: a.playState === "running",
      on: o && o.kind === "script" && M.held === a, duration: +a.effect.getTiming().duration || 0, open: () => openScript(a) });
  for (const el of M.suspects)
    if (el.isConnected) out.push({ kind: "frames", els: [el], text: name(el, true), aside: "per frame", running: true, off: true, duration: null, open: () => {} });
  if (found.unused.length) out.push({ group: "Unused" });
  for (const n of found.unused) out.push({ kind: "unused", els: [], text: n, aside: "", off: !M.sel, duration: null, open: () => useKf(n) });
  return out;
}
