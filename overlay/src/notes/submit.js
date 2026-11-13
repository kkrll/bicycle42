import { S } from "../state.js";
import { bboxOf, describe, docToViewRect, round, toView, union, vp } from "../page.js";
import { openCard, setHint } from "./card.js";
import { setTemplate } from "./templates.js";
import { setImages } from "./pictures.js";
import { hasDraft } from "./draft.js";
import { textarea } from "./mount.js";
import { dispatch } from "../sent.js";
import { setBrush } from "../mode.js";

// ── submit ──────────────────────────────────────────────────────────────────────────────────
export function submit(background) {
  const text = textarea.value.trim();
  if (!text && !S.template) return;
  if (!hasDraft()) return;
  const targets = S.sel.filter((el) => el.isConnected).map(describe);
  const area = S.area ? round(docToViewRect(S.area)) : null;
  const strokes = S.strokes.map((s) => s.map(toView).map(([x, y]) => [Math.round(x), Math.round(y)]));
  const bounds = union([...targets.map((t) => t.rect), area, ...strokes.map(bboxOf)]);
  const note = {
    id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text,
    url: location.href,
    title: document.title,
    viewport: vp(),
    targets,
    area,
    strokes,
    bounds: bounds && round(bounds),
    time: Date.now(),
    ...(background ? { lane: /** @type {const} */ ("bg") } : {}),
    ...(S.images.length ? { images: S.images } : {}),
    ...(S.template ? { template: S.template } : {}),
  };
  setBrush(false);
  dispatch(note);
}

/** The host did not take the note: its card opens again with the words in it, and says why. */
export function refuse(say) {
  openCard();
  setHint(say);
}

/** A note was taken (this mode's or another's): the words, pictures, template and marks of the
 *  note go. (S.sel, the sent note's outlines whatever made it, goes in finishCapture.) */
export function finish() {
  S.area = null;
  S.strokes = [];
  textarea.value = "";
  setImages([]);
  setTemplate(null);
}
