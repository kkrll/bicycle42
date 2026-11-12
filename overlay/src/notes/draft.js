// ── draft ───────────────────────────────────────────────────────────────────────────────────
const hasDraft = () => S.sel.length > 0 || S.strokes.length > 0 || !!S.area;

function clearDraft() {
  S.sel = [];
  S.area = null;
  S.strokes = [];
  textarea.value = "";
  setImages([]);
  setTemplate(null);
  closeCard();
  clearTimeout(draftTimer);
  send({ type: "draft", draft: serializeDraft() }); // null, unless canvas edits are waiting
  kick();
}
