import { S, send } from "./state.js";
import { selectorFor } from "./page.js";
import * as Notes from "./notes/api.js";
import * as Canvas from "./canvas/api.js";
import * as Motion from "./motion/api.js";

// ── draft ───────────────────────────────────────────────────────────────────────────────────
// The draft the host keeps, so a reload loses nothing: one for all three modes, the note in
// progress with canvas mode's unsent batch and motion mode's unsent animations beside it.
export let draftTimer = 0;

export function serializeDraft() {
  const noteDraft = !S.pending && (Notes.hasDraft() || !!Notes.textarea.value);
  const canvas = Canvas.draft();
  const motion = Motion.draft();
  if (!noteDraft && !canvas && !motion) return null;
  // (Between a send and its "captured", S.sel holds the sent note's outlines: not a draft.)
  return {
    text: Notes.textarea.value, targets: (noteDraft ? S.sel : []).map(selectorFor), area: S.area, strokes: S.strokes, template: S.template,
    ...canvas, ...(motion ? { motion } : {}),
  };
}

export function draftChanged() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => send({ type: "draft", draft: serializeDraft() }), 120);
}

export function restoreDraft(d) {
  if (!d) return;
  Notes.restore(d);
  Canvas.restore(d);
  Motion.restore(d.motion);
}
