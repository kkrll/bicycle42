// Motion mode, sending: the open animation as a note, its rules kept applied until the note is
// done, and what is unsent kept by the host across a reload.

import { S } from "../state.js";
import { adopt, BOOST, describe, editSel, plainLabel, vp } from "../page.js";
import { draftChanged } from "../draft.js";
import { dispatch } from "../sent.js";
import { anyDirty, apply, entryCss, kfDirty, kfIs, M, MAX_KF, mq, ms, openDirty, openKf, openScr, openUse, playsDirty, readList, scan, serialize, svCss, svOf, trCss, trDirty, useDirty } from "./model.js";
import { applyScript, forgetSteps, laid, letGo, openCss, openTransition, readScript, setSel, setState, show } from "./open.js";
import { keysText, sharedBy, snapshot, timing } from "./edit.js";
import { draw, drawFoot, flash } from "./draw.js";
import { seenNow } from "./frames.js";
import { sourceFor } from "./source.js";
import { AFTER, triggerWords, usable } from "./trigger.js";

// ── sending ──────────────────────────────────────────────────────────────────────────────
/** How a script's animation plays, in one line. */
const said = (t) => `animate(): ${ms(t.duration)} ${t.easing}${t.delay ? ` ${ms(t.delay)}` : ""}${t.count !== "1" ? `, ${t.count === "infinite" ? "forever" : `${t.count} times`}` : ""}${t.direction !== "normal" ? `, ${t.direction}` : ""}${t.fill !== "none" ? `, fill ${t.fill}` : ""}`;
/** The open animation, as the note says it (see `Motion` in ../../protocol.ts). */
function payload() {
  const o = M.open, el = mq(o.rs);
  const who = { selector: editSel(el), label: plainLabel(el) };
  if (o.kind === "frames") {
    // Nothing of the page says how it moves: what was seen of it does.
    const { props = [], cycle = null, over = 0 } = seenNow() || {};
    const source = M.ro.canvas ? sourceFor(M.sel) : null;
    return { kind: "frames", name: M.ro.canvas ? "canvas" : "inline-style", ...who, seen: props, over, ...(cycle ? { cycle } : {}), ...(source ? { source } : {}) };
  }
  if (o.kind !== "css") {
    const t = timing();
    const current = o.kind === "transition"
      ? `transition: ${trCss(JSON.parse(M.ro.orig))}`
      : said(M.ro.orig ? JSON.parse(M.ro.orig) : t);
    const out = /** @type {any} */ ({ kind: o.kind, name: o.kind === "transition" ? "transition" : o.name.slice(0, 64), ...who, current: current.slice(0, 400) });
    const sc = openScr(), source = o.kind === "script" ? sourceFor(M.held) : null;
    if (source) out.source = source;
    if (sc && JSON.stringify(sc.timing) !== sc.orig) out.next = said(t).slice(0, 400);
    if (sc && kfIs(sc.frames) !== sc.origKf) {
      // (What they were is left out when it is too long to be taken: what they are is the edit.)
      const from = keysText(JSON.parse(sc.origFrames));
      out.keyframes = { to: keysText(sc.frames), ...(from.length <= MAX_KF ? { from } : {}) };
    }
    if (o.kind === "transition") {
      const mine = M.tr.get(o.rs), st = M.ro.state, v = M.ro.vals;
      if (trDirty(mine)) out.next = `transition: ${trCss(mine.items)}`.slice(0, 400);
      // What switches it, and what changes then: the agent finds the rule by it.
      const values = svOf(o.rs).flatMap((s) => Object.entries(s.vals).map(([prop, x]) => ({ state: s.state.slice(0, 200), prop, from: x.was.slice(0, 120), to: x.to })));
      if (values.length) out.values = values.slice(0, 20);
      // (What a named one changes may be nothing yet, or be many properties: those that move.)
      if (st && v) {
        const t = st.trigger, mine = M.sv.get(`${o.rs}|${st.label}`);
        const end = (p) => (mine && mine.vals[p] ? mine.vals[p].was : v.to[p]); // (as the page has it: what it was changed to is in `values`)
        const moved = laid().map((x) => x.prop).filter((p) => v.from[p] !== end(p)).map((p) => `${p} ${v.from[p]} → ${end(p)}`);
        out.state = `${t ? triggerWords(t, st.off) : st.label}: ${moved.join("; ") || "nothing changes on the page yet"}`.replace(/\s+/g, " ").slice(0, 400);
        if (t) out.stateBy = t.by;
        if (t && AFTER.includes(t.after)) out.stateAfter = t.after;
      }
    }
    return out;
  }
  const u = openUse(), k = openKf();
  const out = /** @type {any} */ ({ kind: "keyframes", name: k.name, ...who, shared: sharedBy() });
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
export function submit(background) {
  if (S.pending) return;
  const o = M.open, el = o && mq(o.rs), words = M.note.trim();
  if (!o || !el) return flash("Open an animation first: click something that moves, or a row of the list");
  if (!openDirty() && !words) return flash("Nothing to send yet: change it, or say what it should do");
  const k = openKf();
  if (k ? serialize(k.name, k.frames).length > MAX_KF : openScr() && keysText(M.ro.frames).length > MAX_KF) return flash("Too long to send: the keyframes are over 4000 characters");
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
    ...(background ? { lane: /** @type {const} */ ("bg") } : {}),
    motion,
  };
  // What it was, until the host takes it; then its rules move to a sheet of their own, and it
  // is no longer unsent.
  M.unsent = { id: note.id, snap: M.snap, past: M.past, future: M.future, words: M.note, open: o, sel: M.sel, ro: M.ro, held: M.held };
  if (o.kind === "css") moveToSent(note.id);
  else if (o.kind === "transition" && openDirty()) moveTransitionToSent(note.id, el);
  else if (o.kind === "script" && openDirty()) moveScriptToSent(note.id);
  M.note = ""; // the line under the timeline says it was sent
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
  M.sent.push({ id, sheet, seen: false, n: null, undo });
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
/** A changed transition's rules (how it runs, what its states change) go into a sheet of their own, as a changed animation's do. */
function moveTransitionToSent(id, el) {
  const rs = M.open.rs, t = M.tr.get(rs), states = svOf(rs), sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync([...(trDirty(t) ? [`${rs}${BOOST} { transition: ${trCss(t.items)}; }`] : []), ...states.map(svCss)].join("\n"));
  } catch {}
  adopt(sheet, true);
  M.sent.push({ id, sheet, seen: false, n: null, undo: [] });
  M.tr.delete(rs);
  for (const s of states) M.sv.delete(`${rs}|${s.label}`);
  M.past = [];
  M.future = [];
  apply();
  M.snap = snapshot();
  openTransition(el); // as the page has it now
  draftChanged();
}
/** A changed script's animation goes on playing as it was sent: there is no rule to take away
 *  when the note is done, so what the animation was before is kept with the note's id. */
function moveScriptToSent(id) {
  M.sent.push({ id, sheet: null, seen: false, n: null, undo: [], script: { a: M.held, raw: M.ro.raw } });
  M.ro = readScript(M.held); // as it plays now
  M.past = [];
  M.future = [];
  M.snap = snapshot();
}
/** A sent script's animation is as it was before that note, if the page still has it. Another
 *  note sent of it since stays on top of it, and what it was before that one is what it was
 *  before this one now; so do unsent changes of it, of which only those are kept that were made
 *  since (how it plays, its keyframes). */
function putBackScript(b) {
  const { a, raw } = b.script;
  const later = M.sent.slice(M.sent.indexOf(b) + 1).find((x) => x.script && x.script.a === a);
  if (later) return void (later.script.raw = raw);
  if (!a.effect || !a.effect.target || !a.effect.target.isConnected) return;
  try {
    a.effect.updateTiming(raw.timing);
    a.effect.setKeyframes(raw.frames);
  } catch {}
  const was = openScr();
  if (!was || M.held !== a) return;
  const now = readScript(a);
  if (JSON.stringify(was.timing) !== was.orig) now.timing = was.timing;
  if (kfIs(was.frames) !== was.origKf) now.frames = was.frames;
  M.ro = now;
  if (M.key && !now.frames.some((f) => f.at === M.key.at && (M.key.prop === null || M.key.prop in f.vals))) M.key = null;
  forgetSteps(was.id);
  M.snap = snapshot();
  applyScript();
}
/** The host did not take the note: the animation is unsent again, with its undo steps and words.
 *  Another note's id (an older one, or a canvas note) changes nothing here. */
export function refuse(id, say) {
  const u = M.unsent;
  if (!u || u.id !== id) return false;
  M.unsent = null;
  const i = M.sent.findIndex((b) => b.id === id);
  if (i >= 0) {
    dropSent(M.sent[i]);
    M.sent.splice(i, 1);
  }
  const s = JSON.parse(u.snap);
  M.kf = new Map(s.kf);
  M.use = new Map(s.use);
  M.tr = new Map(s.tr || []);
  M.sv = new Map(s.sv || []);
  M.trig = new Map(s.trig || []);
  M.snap = u.snap;
  M.past = u.past;
  M.future = u.future;
  M.note = [u.words, M.note].filter((w) => w.trim()).join(" ");
  S.sel = [];
  apply();
  scan();
  setSel(u.sel && u.sel.isConnected ? u.sel : mq(u.open.rs)); // (what was opened since is left, as it is when another is opened)
  M.open = u.open;
  M.held = null;
  if (u.open.kind !== "css") M.ro = u.ro;
  if (u.open.kind === "script") {
    M.held = u.held;
    applyScript();
  }
  if (u.open.kind === "transition" && M.sel) openTransition(M.sel); // with what was changed, which is unsent again
  draw();
  draftChanged();
  flash(say);
  return true;
}
/** Its sheet goes, and the element's other uses have the entry back that it wrote over. */
function dropSent(b) {
  if (b.script) return putBackScript(b);
  adopt(b.sheet, false);
  for (const { x, index, entry } of b.undo) if (x.base[index]) x.base[index] = entry;
}
export function finish(id) {
  if (M.unsent && M.unsent.id === id) M.unsent = null;
  if (S.quiet === id) S.sel = [];
}
/** A sent animation is a preview until the agent is finished with its note. */
export function dropFinished() {
  let changed = false;
  M.sent = M.sent.filter((b) => {
    const p = S.pins.find((x) => x.id === b.id);
    if (p) {
      b.seen = true;
      b.n = typeof p.n === "number" ? p.n : null;
    }
    const over = p ? p.status === "done" || p.status === "failed" || p.status === "stopped" : b.seen;
    if (!over) return true;
    changed = true;
    dropSent(b);
    const nm = b.n !== null ? `Note ${b.n}` : "Note";
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
    } else if (o && o.kind === "transition" && el && !M.tr.has(o.rs) && !svOf(o.rs).length) {
      // (The state the reviewer chose stays chosen: a note done elsewhere is no reason to go back to the first.)
      const was = M.ro && M.ro.state ? M.ro.state.label : "";
      openTransition(el);
      if (was && M.ro.state && M.ro.state.label !== was && M.ro.states.some((x) => x.label === was)) {
        setState(was, el);
        draw();
      }
    } else draw();
  }
}

// ── the draft the host keeps ─────────────────────────────────────────────────────────────
/** What is unsent, for the host to keep across a reload: the edited keyframes and uses only. */
export function draft() {
  const kf = [...M.kf].filter(([, k]) => kfDirty(k));
  const use = [...M.use].filter(([, u]) => useDirty(u) || playsDirty(u));
  const tr = [...M.tr].filter(([, t]) => trDirty(t));
  const words = M.note, trig = [...M.trig], sv = [...M.sv];
  if (!kf.length && !use.length && !tr.length && !sv.length && !trig.length && !words) return null;
  return { kf, use, ...(tr.length ? { tr } : {}), ...(sv.length ? { sv } : {}), ...(trig.length ? { trig } : {}), ...(words ? { note: words } : {}) };
}
const okValues = (s) => !!s && ["rs", "label", "state", "sel"].every((k) => typeof s[k] === "string") && !!s.vals && Object.entries(s.vals).every(([p, v]) => !!v && typeof v.was === "string" && typeof v.to === "string" && CSS.supports(p, v.to));
export function restore(d) {
  if (!d || typeof d !== "object" || anyDirty()) return;
  try {
    const kf = (Array.isArray(d.kf) ? d.kf : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && Array.isArray(e[1].frames));
    const use = (Array.isArray(d.use) ? d.use : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && e[1].timing && Array.isArray(e[1].base));
    M.kf = new Map(kf);
    M.use = new Map(use);
    M.tr = new Map((Array.isArray(d.tr) ? d.tr : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && Array.isArray(e[1].items) && typeof e[1].orig === "string"));
    M.sv = new Map((Array.isArray(d.sv) ? d.sv : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && okValues(e[1])));
    M.trig = new Map((Array.isArray(d.trig) ? d.trig : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && Array.isArray(e[1])).map(([rs, list]) => [rs, list.filter(usable)]).filter((e) => e[1].length));
    if (typeof d.note === "string" && !M.note) M.note = d.note;
    M.snap = snapshot();
    apply();
  } catch {
    M.kf = new Map();
    M.use = new Map();
  }
}
