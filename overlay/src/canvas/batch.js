// ── the batch: commit, undo, reset, draft ───────────────────────────────────────────────────
const countEdits = (B) =>
  Object.values(B.els).reduce((n, e) => n + (e.css.trim() ? 1 : 0) + (e.cls ? 1 : 0), 0) + B.ops.length;

function prune(B) {
  for (const rs in B.els) {
    const e = B.els[rs];
    if (e.cls && e.cls.to === (e.cls.from ?? "")) delete e.cls;
    if (!e.css.trim() && !e.cls) delete B.els[rs];
  }
}

/** Close an undo step: the batch as it stands becomes the new committed state. */
function commit() {
  clearTimeout(C.typeTimer);
  C.typeTimer = 0;
  hush();
  const B = C.draft.B;
  prune(B);
  const now = JSON.stringify(B);
  if (now !== C.snap) {
    if (countEdits(B) > MAX_EDITS) {
      C.draft.B = JSON.parse(C.snap);
      flash(`${MAX_EDITS} edits is the limit: send these first`);
      syncFields(true);
    } else {
      C.past.push(C.snap);
      if (C.past.length > 200) C.past.shift();
      C.snap = now;
      C.future = [];
    }
  }
  applyAll();
  syncFields();
  draftChanged();
}

function travel(from, to) {
  if (C.typeTimer) commit();
  hush();
  if (!from.length) return;
  to.push(C.snap);
  C.snap = from.pop();
  C.draft.B = JSON.parse(C.snap);
  applyAll();
  syncFields(true);
  draftChanged();
}
const undo = () => travel(C.past, C.future);
const redo = () => travel(C.future, C.past);

function reset() {
  if (C.typeTimer) commit();
  if (C.snap === EMPTY) return;
  C.draft.B = newBatch();
  commit(); // a step like any other: mod+Z brings the edits back
  syncFields(true);
}

function restoreEdits(d) {
  if (!d || C.snap !== EMPTY) return;
  // The words typed for the batch are a draft on their own: they come back with or without edits.
  if (cnote && typeof d.note === "string" && !cnote.value) cnote.value = d.note;
  const B = d.edits;
  if (B && typeof B === "object" && B.els && typeof B.els === "object" && Array.isArray(B.ops)) {
    const paths = d.paths && typeof d.paths === "object" ? d.paths : {};
    for (const rs in paths) {
      const v = paths[rs];
      if (stampOf(rs) && !C.paths.has(rs) && Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") C.paths.set(rs, { path: v[0], tag: v[1] });
    }
    C.draft.B = { els: B.els, sheet: typeof B.sheet === "string" ? B.sheet : "", ops: B.ops };
    C.snap = JSON.stringify(C.draft.B);
    applyAll();
  }
  syncFields(true);
}

/** Where the stamped elements of a batch last were: after a reload their stamps are gone. */
function pathsOf(B) {
  const out = {};
  const add = (x) => {
    const p = x && stampOf(x.rs) && C.paths.get(x.rs);
    if (p) out[x.rs] = [p.path, p.tag];
  };
  for (const rs in B.els) add(B.els[rs]);
  for (const op of B.ops) {
    add(op);
    add(op.parent);
    add(op.before);
  }
  return out;
}

/** The unsent batch and the words typed for it, for the draft the host keeps; null without either. */
function draft() {
  const edits = C.snap !== EMPTY ? C.draft.B : null;
  const words = cnote ? cnote.value : "";
  if (!edits && !words) return null;
  return { ...(edits ? { edits, paths: pathsOf(edits) } : {}), ...(words ? { note: words } : {}) };
}

