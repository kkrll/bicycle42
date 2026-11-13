// Notes mode: the note card, where it sits, and what it says it is about. (Its listeners are in
// mount.js; the template list and the pictures in templates.js and pictures.js.)

import { isMac, S } from "../state.js";
import { icon } from "../ui.js";
import { bboxOf, docToViewRect, label, plainLabel, rectOf, union } from "../page.js";
import { draftChanged } from "../draft.js";
import { hideSent } from "./sent.js";
import { card, textarea, what } from "./mount.js";
import { kick } from "../render.js";
import { root } from "../mount.js";

// ── note card ───────────────────────────────────────────────────────────────────────────────
export const PLACEHOLDER = "Note…"; // what else the card does (/, a pasted picture) is behind its "?"
// The card's keys: behind its "?", shown while the pointer (or focus) is on it. The card itself
// carries no instructions, only what is being noted and the ↵ that sends it.
export const CARD_KEYS = [
  ["↵", "send"],
  [isMac ? "⌥↵" : "alt+↵", "send, to work in parallel"],
  ["/", "templates"],
  [isMac ? "⌘V" : "ctrl+V", "attach a copied picture"],
  ["↑ ↓", "parent, child (note empty)"],
  [isMac ? "⌘Z" : "ctrl+Z", "undo a stroke"],
  ["esc", "cancel the note"],
];
export let cardAt = null; // where the note card last sat: the "Sent" chip appears there

/** The card's part of the layer. mount.js puts it in its place among the rest; mount() finds it. */
export const CARD_HTML = `<div class="card" hidden><div class="meta"><span class="what"></span><span class="hint" hidden></span>
      <span class="khelp"><button type="button" class="kq" aria-label="Keys" aria-describedby="b42-ckeys">${icon("help", 14)}</button><div class="kpop" id="b42-ckeys" role="tooltip"></div></span></div>
    <button type="button" class="chip" title="Remove the template" hidden></button>
    <div class="cbody"><textarea rows="2" placeholder="${PLACEHOLDER}" spellcheck="false"></textarea>
      <button type="button" class="csend" aria-label="Send" title="Send (↵) · ${isMac ? "⌥" : "alt+"}click to work in parallel" disabled>${icon("↵")}</button></div>
    <div class="menu" hidden></div><div class="refs" hidden></div></div>`;

export function updateCardMeta() {
  what.title = S.sel.length === 1 ? label(S.sel[0]) : "";
  if (S.sel.length === 1) what.textContent = plainLabel(S.sel[0]);
  else if (S.sel.length > 1) what.textContent = `${S.sel.length} elements`;
  else if (S.strokes.length) what.textContent = "drawing";
  else what.textContent = "area";
}

export function openCard() {
  hideSent();
  S.undo = null;
  S.card = true;
  updateCardMeta();
  autosize();
  if (S.enabled) {
    card.hidden = false;
    textarea.focus({ preventScroll: true });
  }
  draftChanged();
  kick();
}

/** Beside the card's title: why the note did not go, until it is changed. Nothing otherwise. */
export function setHint(why) {
  const hint = card.querySelector(".hint");
  const text = why || "";
  if (hint.textContent === text) return;
  hint.textContent = hint.title = text;
  hint.hidden = !why;
  hint.classList.toggle("warn", !!why);
}

/** The ↵ in the card's corner: lit when Enter would send. */
export function drawCardSend() {
  if (!card) return;
  const can = !!(textarea.value.trim() || S.template);
  const b = card.querySelector(".csend");
  if (b.disabled === !can) return;
  b.disabled = !can;
}

export function closeCard() {
  S.card = false;
  card.hidden = true;
  setHint("");
  if (root && root.activeElement === textarea) textarea.blur();
}

export function autosize() {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
}

// A stroke's box in document coordinates, worked out once: a stroke is never changed after it
// is drawn (undo drops it whole, a restored draft brings new arrays).
export const strokeBox = new WeakMap();
function anchorRect() {
  const rects = S.sel.map(rectOf);
  if (S.area) rects.push(docToViewRect(S.area));
  for (const s of S.strokes) {
    let b = strokeBox.get(s);
    if (!b) strokeBox.set(s, (b = bboxOf(s)));
    rects.push(docToViewRect(b));
  }
  return union(rects);
}

export function placeCard() {
  const a = anchorRect();
  if (!a) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = Math.min(380, W - 16);
  const h = card.offsetHeight || 104;
  card.style.width = `${w}px`;
  let top = a.y + a.h + 8;
  if (top + h > H - 8) top = a.y - h - 8;
  if (top < 8) top = Math.min(Math.max(8, a.y + 8), H - h - 8);
  const left = Math.min(Math.max(8, a.x), W - w - 8);
  cardAt = [Math.round(left), Math.round(top)];
  card.style.transform = `translate(${cardAt[0]}px, ${cardAt[1]}px)`;
  // The keys open toward the room: down from a card in the top half, up from one in the bottom.
  const low = top > H / 2;
  if (card._low !== low) card.classList.toggle("low", (card._low = low));
  drawCardSend();
}
