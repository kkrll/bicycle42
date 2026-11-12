// ── draft ───────────────────────────────────────────────────────────────────────────────────
let draftTimer = 0;

function serializeDraft() {
  const noteDraft = !S.pending && (hasDraft() || !!textarea.value);
  const canvas = Canvas.draft();
  const motion = Motion.draft();
  if (!noteDraft && !canvas && !motion) return null;
  // (Between a send and its "captured", S.sel holds the sent note's outlines: not a draft.)
  return {
    text: textarea.value, targets: (noteDraft ? S.sel : []).map(selectorFor), area: S.area, strokes: S.strokes, template: S.template,
    ...canvas, ...(motion ? { motion } : {}),
  };
}

function draftChanged() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => send({ type: "draft", draft: serializeDraft() }), 120);
}

function restoreDraft(d) {
  if (!d) return;
  S.sel = (d.targets || []).map(q).filter(Boolean);
  S.area = d.area || null;
  S.strokes = d.strokes || [];
  textarea.value = d.text || "";
  setTemplate(S.templates.some((t) => t.name === d.template) ? d.template : null);
  if (hasDraft() || textarea.value) openCard();
  Canvas.restore(d);
  Motion.restore(d.motion);
}
