import { S } from "../state.js";
import { keyNodes } from "../ui.js";
import { draftChanged } from "../draft.js";
import { autosize, CARD_KEYS, drawCardSend, setHint } from "./card.js";
import { setTemplate, updateMenu } from "./templates.js";
import { onPaste } from "./pictures.js";
import { submit } from "./submit.js";
import { hideSent } from "./sent.js";
import { root } from "../mount.js";

// ── mount ───────────────────────────────────────────────────────────────────────────────────
// Notes mode's elements, found by mount(): declared here, where they are assigned.
export let ink, strokesEl, pencil; // the ink (frame.js)
export let card, what, refs, textarea, chip, menuEl; // the note card (card.js)
export let sentEl; // the "Sent" chip (sent.js)

/** Its elements in the layer (mount.js puts its markup in place first), and their listeners. */
export function mount() {
  ink = root.querySelector(".ink");
  strokesEl = ink.querySelector(".strokes");
  pencil = ink.querySelector("#b42-pencil");
  card = root.querySelector(".card");
  what = root.querySelector(".what");
  textarea = root.querySelector(".card textarea");
  refs = root.querySelector(".refs");
  chip = root.querySelector(".chip");
  menuEl = root.querySelector(".menu");
  sentEl = root.querySelector(".sent");

  // Keys typed into the card must not reach the page's own shortcuts.
  for (const t of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut"]) card.addEventListener(t, (e) => e.stopPropagation());
  textarea.addEventListener("paste", onPaste);
  card.querySelector(".kpop").replaceChildren(...CARD_KEYS.map(([k, v]) => {
    const row = document.createElement("div");
    row.className = "krow";
    const kk = document.createElement("span");
    kk.className = "kk";
    kk.append(keyNodes(k));
    const kv = document.createElement("span");
    kv.className = "kv";
    kv.textContent = v;
    row.append(kk, kv);
    return row;
  }));
  // Neither button takes the caret from the note: the words stay where they were being typed.
  for (const b of card.querySelectorAll(".kq, .csend")) b.addEventListener("mousedown", (e) => e.preventDefault());
  // ↵ as a button: the same as the key. The host admits a note after a real click as after Enter.
  card.querySelector(".csend").addEventListener("click", (e) => {
    submit(e.altKey);
    if (S.card) textarea.focus({ preventScroll: true });
  });
  chip.addEventListener("click", () => {
    setTemplate(null);
    draftChanged();
    textarea.focus({ preventScroll: true });
  });
  textarea.addEventListener("input", () => {
    setHint("");
    drawCardSend();
    updateMenu();
    autosize();
    draftChanged();
  });
}

/** Review on or off: the card shows again, with the caret in it, or it and the chip are hidden. */
export function syncUi() {
  if (!S.enabled) {
    card.hidden = true;
    hideSent();
  } else if (S.card) {
    card.hidden = false;
    textarea.focus({ preventScroll: true });
  }
}
