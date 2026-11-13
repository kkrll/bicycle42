import { S, send } from "../state.js";
import { q } from "../page.js";
import { draftTimer, serializeDraft } from "../draft.js";
import { closeCard, openCard } from "./card.js";
import { setTemplate } from "./templates.js";
import { setImages } from "./pictures.js";
import { textarea } from "./mount.js";
import { kick } from "../render.js";

// ── draft ───────────────────────────────────────────────────────────────────────────────────
// The note in progress: what it is about (S.sel, S.area, S.strokes), its words, its template.
// The draft the host keeps (draft.js) carries it beside canvas mode's and motion mode's parts.
export const hasDraft = () => S.sel.length > 0 || S.strokes.length > 0 || !!S.area;

/** Its part of a draft the host kept: the card opens again when there is a note in it. */
export function restore(d) {
  S.sel = (d.targets || []).map(q).filter(Boolean);
  S.area = d.area || null;
  S.strokes = d.strokes || [];
  textarea.value = d.text || "";
  setTemplate(S.templates.some((t) => t.name === d.template) ? d.template : null);
  if (hasDraft() || textarea.value) openCard();
}

export function clearDraft() {
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
