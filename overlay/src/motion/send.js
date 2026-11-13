// Motion mode, sending: the open animation as a note, its rules kept applied until the note is
// done, and what is unsent kept by the host across a reload.

import { S } from "../state.js";
import { adopt, BOOST, describe, editSel, plainLabel, vp } from "../page.js";
import { draftChanged } from "../draft.js";
import { dispatch } from "../sent.js";
import { anyDirty, apply, entryCss, kfDirty, M, MAX_KF, mq, ms, openDirty, openKf, openUse, playsDirty, readList, scan, serialize, useDirty } from "./model.js";
import { letGo, openCss, setSel, show } from "./open.js";
import { sharedBy, snapshot, timing } from "./edit.js";
import { draw, drawFoot, flash } from "./draw.js";
import { noteEl } from "./input.js";

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
export function submit(background) {
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
/** The host did not take the note: the animation is unsent again, with its undo steps and words.
 *  Another note's id (an older one, or a canvas note) changes nothing here. */
export function refuse(id, say) {
  const u = M.unsent;
  if (!u || u.id !== id) return false;
  M.unsent = null;
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
/** Its sheet goes, and the element's other uses have the entry back that it wrote over. */
function dropSent(b) {
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
    } else draw();
  }
}

// ── the draft the host keeps ─────────────────────────────────────────────────────────────
/** What is unsent, for the host to keep across a reload: the edited keyframes and uses only. */
export function draft() {
  const kf = [...M.kf].filter(([, k]) => kfDirty(k));
  const use = [...M.use].filter(([, u]) => useDirty(u) || playsDirty(u));
  const words = noteEl ? noteEl.value : "";
  if (!kf.length && !use.length && !words) return null;
  return { kf, use, ...(words ? { note: words } : {}) };
}
export function restore(d) {
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
