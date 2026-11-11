// ── sending ─────────────────────────────────────────────────────────────────────────────────
const tidy = (e, selector = e.selector) => {
  const out = { selector, tag: e.tag, label: e.label };
  if (e.component) out.component = e.component;
  if (e.repeated) out.repeated = e.repeated;
  return out;
};
const value = (s) => line(s).slice(0, 400);

function submitCanvas(background) {
  if (C.typeTimer) commit();
  if (S.pending) return;
  const B = C.draft.B;
  const entries = Object.values(B.els);
  const css = B.sheet.trim() ? B.sheet : "";
  if (!countEdits(B) && !css) return flash("Nothing to send yet: edit something first");
  if (css.length > MAX_SHEET || entries.some((e) => e.css.length > MAX_CSS || (e.cls && e.cls.to.length > MAX_CLASS)))
    return flash("Too long to send: shorten the text marked in the inspector");
  // (The host takes no longer text: sent as it is, the edit would be dropped there without a word.)
  if (B.ops.some((o) => o.kind === "text" && line(o.to).length > MAX_TEXT))
    return flash(`Too long to send: a text edit holds ${MAX_TEXT} characters at most. Double-click the text to shorten it`);
  const rss = [...new Set([...entries.map((e) => e.rs), ...B.ops.map((o) => o.rs)])];
  const els = rss.map(elOf).filter(Boolean);
  const props = new Map(entries.map((e) => [e.rs, topProps(e.css)]));
  // Elements the new rules match: only where nothing else says where the note is about.
  const matched = [];
  if (!els.length && C.draft.free)
    for (const r of [...C.draft.free.cssRules].slice(0, 20)) {
      const found = r.selectorText ? document.querySelectorAll(r.selectorText) : [];
      for (let i = 0; i < found.length && matched.length < 20; i++) if (found[i] !== hostEl) matched.push(found[i]);
    }
  // Measure with the batch switched off, then on: the note carries both sides.
  const measure = () => {
    const vals = new Map();
    for (const [rs, list] of props) {
      const el = elOf(rs);
      const cs = el && getComputedStyle(el);
      vals.set(rs, list.map((p) => (cs ? value(cs.getPropertyValue(p)) : "")));
    }
    return { vals, rects: [...els, ...matched].map(rectOf) };
  };
  C.draft.id = "measuring";
  C.hide.add("measuring");
  applyAll();
  const before = measure();
  // Each element is reported under the selector it has now, read while the batch is off: the
  // page may have moved it since the edit was made, and its classes are the page's own here.
  const where = new Map();
  const locate = (x) => {
    const el = x && !where.has(x.rs) && elOf(x.rs);
    if (el) where.set(x.rs, editSel(el));
  };
  for (const e of entries) locate(e);
  for (const op of B.ops) {
    locate(op);
    locate(op.parent);
    locate(op.before);
  }
  const sel = (x) => where.get(x.rs) || x.selector;
  C.hide.delete("measuring");
  applyAll();
  const after = measure();

  const edits = [];
  for (const e of entries) {
    if (e.css.trim())
      edits.push({ kind: "style", ...tidy(e, sel(e)), css: e.css,
        changes: props.get(e.rs).map((prop, i) => ({ prop, from: before.vals.get(e.rs)[i], to: after.vals.get(e.rs)[i] })) });
    if (e.cls) edits.push({ kind: "class", ...tidy(e, sel(e)), from: line(e.cls.from), to: line(e.cls.to) });
  }
  for (const op of B.ops) {
    const out = { kind: op.kind, ...tidy(op, sel(op)) };
    if (op.kind === "text") Object.assign(out, { from: line(op.from), to: line(op.to) });
    if (op.kind === "move")
      Object.assign(out, {
        parent: { selector: sel(op.parent), label: op.parent.label, layout: op.parent.layout },
        fromIndex: op.fromIndex, toIndex: op.toIndex,
        before: op.before ? { selector: sel(op.before), label: op.before.label } : null,
      });
    edits.push(out);
  }
  const seen = [...before.rects, ...after.rects].filter((r) => r.w > 0 && r.h > 0);
  const bounds = union(seen);
  const note = {
    id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: cnote.value.trim(),
    url: location.href,
    title: document.title,
    viewport: vp(),
    // Described as they are now, but under the selector they had before this batch's class edits.
    targets: els.map((el) => {
      const rs = stableSel(el);
      const known = B.els[rs] || B.ops.find((o) => o.rs === rs);
      return { ...describe(el), ...(known ? { selector: sel(known) } : {}) };
    }),
    area: null,
    strokes: [],
    bounds: bounds && round(bounds),
    time: Date.now(),
    ...(background ? { lane: "bg" } : {}),
    ...(edits.length ? { edits } : {}),
    ...(css ? { css } : {}),
  };
  // The batch stays applied under the note's id; a new empty draft takes its place.
  C.unsent = { id: note.id, snap: C.snap, past: C.past, future: C.future, note: cnote.value, sel: C.sel };
  C.draft.id = note.id;
  C.sent.push(C.draft);
  C.draft = { id: "draft", B: newBatch() };
  C.snap = EMPTY;
  C.past = [];
  C.future = [];
  cnote.value = "";
  S.quiet = note.id; // no "Sent" chip over the page: the bar says it
  if (C.pop) setPop(C.pop);
  select(null);
  // Outlines for the screenshot: the edited elements, wherever they are in each picture.
  S.sel = els.filter((el, i) => after.rects[i].w > 0 || before.rects[i].w > 0);
  syncFields(true);
  drawBar();
  dispatch(note);
}

/** The host refused the note: its batch is the unsent one again, with its undo steps and its
 *  words, and the bar says why. Anything typed since (the Global box and the note field stay
 *  usable while the answer is awaited) is added to it, not lost. */
function unsendCanvas(id, say) {
  const u = C.unsent;
  C.unsent = null;
  const i = C.sent.findIndex((b) => b.id === id);
  if (i < 0 || !u || u.id !== id) return flash(say);
  if (C.typeTimer) commit();
  const b = C.sent.splice(i, 1)[0];
  const later = C.draft;
  C.hide.delete(id);
  for (const k of ["gen", "free"]) if (later[k]) adopt(later[k], false);
  b.id = "draft";
  b.seen = b.n = undefined;
  for (const rs in later.B.els) {
    const e = later.B.els[rs], old = b.B.els[rs];
    if (!old) b.B.els[rs] = e;
    else {
      if (e.css.trim()) old.css = old.css.trim() ? `${old.css}\n${e.css}` : e.css;
      if (e.cls) old.cls = { from: old.cls ? old.cls.from : e.cls.from, to: e.cls.to };
    }
  }
  b.B.ops.push(...later.B.ops);
  if (later.B.sheet.trim()) b.B.sheet = b.B.sheet.trim() ? `${b.B.sheet}\n${later.B.sheet}` : later.B.sheet;
  C.draft = b;
  C.snap = u.snap;
  C.past = u.past;
  C.future = u.future;
  cnote.value = [u.note, cnote.value].filter((w) => w.trim()).join(" ");
  S.sel = []; // the outlines that were for the screenshot
  commit(); // what was added since, if anything, is one more undo step
  select(u.sel && u.sel.isConnected ? u.sel : null);
  syncFields(true);
  flash(say);
}

/** A sent batch is a preview until the agent is finished with its note. */
function dropFinished() {
  let changed = false;
  C.sent = C.sent.filter((b) => {
    const p = S.pins.find((x) => x.id === b.id);
    if (p) b.seen = b.n = p.n || true;
    const over = p ? p.status === "done" || p.status === "failed" || p.status === "stopped" : b.seen;
    if (!over) return true;
    changed = true;
    C.hide.delete(b.id);
    for (const k of ["gen", "free"]) if (b[k]) adopt(b[k], false);
    // Done: the agent's own change is (or is about to be) in the page, so the class and text we
    // wrote are left for it to replace. Failed or stopped: they are put back (by applyAll).
    if (p && p.status === "done") {
      for (const rs in b.B.els) if (b.B.els[rs].cls) forget(rs, "cls");
      for (const op of b.B.ops) if (op.kind === "text") forget(op.rs, "text");
    }
    // Say what just happened to the preview, for a few seconds, where the reviewer is looking.
    const name = typeof b.n === "number" ? `Note ${b.n}` : "Note";
    C.done = !p ? `${name} removed · preview removed` : p.status === "done" ? `${name} done · preview removed` : `${name} ${p.status} · edits put back`;
    clearTimeout(C.doneTimer);
    C.doneTimer = setTimeout(() => {
      C.done = "";
      drawBar();
    }, 4000);
    return false;
  });
  if (changed) applyAll();
  drawBar();
}

function forget(rs, k) {
  const el = elOf(rs);
  const st = el && C.applied.get(el);
  if (st) delete st[k];
}

function showEdits(msg) {
  const b = C.sent.find((x) => x.id === msg.id);
  if (b) {
    if (msg.show === false) C.hide.add(b.id);
    else C.hide.delete(b.id);
    applyAll();
    // A host that never asks for them back must not leave the page without its chrome.
    clearTimeout(C.hideTimer);
    if (C.hide.size)
      C.hideTimer = setTimeout(() => {
        C.hide.clear();
        applyAll();
      }, 5000);
  }
  let told = false;
  const tell = () => {
    if (told) return;
    told = true;
    send({ type: "edits-shown", id: msg.id, show: msg.show });
  };
  requestAnimationFrame(() => requestAnimationFrame(tell));
  setTimeout(tell, 400); // frames may not come (a hidden window): the host waits a second at most
}

