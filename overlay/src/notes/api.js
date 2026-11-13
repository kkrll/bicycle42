import { CARD_HTML, closeCard, openCard } from "./card.js";
import { setTemplate } from "./templates.js";
import { clearDraft, hasDraft, restore } from "./draft.js";
import { finish, refuse } from "./submit.js";
import { hideSent, showSent } from "./sent.js";
import { frame, INK_HTML, outlines } from "./frame.js";
import { key, pointerDown, pointerMove, pointerUp } from "./input.js";
import { mount, syncUi, textarea } from "./mount.js";

// ── what the rest of the overlay sees ───────────────────────────────────────────────────────
// Notes mode has no setOn: it is on when canvas and motion mode are off (mode.js).
const api = {
  /** The card's text field: where the note's words are typed, and the caret is kept. */
  get textarea() {
    return textarea;
  },
  inkHtml: INK_HTML, cardHtml: CARD_HTML, mount, syncUi, outlines, frame,
  pointerDown, pointerMove, pointerUp, key,
  /** A note in progress: something on the page is selected, framed or drawn for it. */
  hasDraft,
  clearDraft, restore, openCard, closeCard, setTemplate,
  showSent, hideSent, refuse, finish,
};
