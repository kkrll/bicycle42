import { isMac, S } from "../state.js";
import { keyNodes } from "../ui.js";
import { cardAt } from "./card.js";
import { sentEl } from "./mount.js";

// ── "Sent" ──────────────────────────────────────────────────────────────────────────────────
// The card vanishes on Enter. For a moment a chip says the note went, and which number it got,
// where the card was; it never blocks the next click and is gone before the next screenshot.
let sentTimer = 0;
export function showSent(id) {
  if (!cardAt || !S.enabled) return;
  const n = S.pins.find((p) => p.id === id)?.n;
  sentEl.textContent = n ? `Sent · ${n}` : "Sent";
  sentEl.style.transform = `translate(${cardAt[0]}px, ${cardAt[1]}px)`;
  sentEl.hidden = false;
  // Restart the fade when notes come quickly one after another.
  sentEl.style.animation = "none";
  void sentEl.offsetWidth;
  sentEl.style.animation = "";
  clearTimeout(sentTimer);
  S.undo = null;
  sentTimer = setTimeout(hideSent, 1800);
}

export function hideSent() {
  clearTimeout(sentTimer);
  S.undo = null;
  if (sentEl) sentEl.hidden = true;
}

export function offerUndo(draft) {
  if (!cardAt) return;
  sentEl.replaceChildren(keyNodes(`Note dropped · ${isMac ? "⌘" : "ctrl+"}Z brings it back`));
  sentEl.style.transform = `translate(${cardAt[0]}px, ${cardAt[1]}px)`;
  sentEl.hidden = false;
  sentEl.style.animation = "none";
  clearTimeout(sentTimer);
  S.undo = draft;
  sentTimer = setTimeout(hideSent, 5000);
}
