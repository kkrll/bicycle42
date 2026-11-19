import { isMac } from "../state.js";
import { icon, keyNodes } from "../ui.js";
import { C } from "./state.js";
import { elOf } from "./stamps.js";
import { countEdits } from "./batch.js";
import { editRows, removeEdit } from "./edits.js";
import { select } from "./select.js";
import { dock } from "./cursor.js";
import { syncFields } from "./inspector.js";
import { bar, clsEl, cnote, corner, cssEl, freeEl } from "./mount.js";
import { editKeys, notesKeys } from "./help.js";
import { tellMode } from "../mode.js";
import { root } from "../mount.js";
import { hosted } from "../panel.js";
import { kick } from "../render.js";

// ── the bar ─────────────────────────────────────────────────────────────────────────────────
export function flash(text) {
  C.msg = text;
  drawBar();
  clearTimeout(C.msgTimer);
  C.msgTimer = setTimeout(() => {
    C.msg = "";
    drawBar();
  }, 2600);
}

/** Any change of state takes a refusal off the bar: it must never describe something older. */
export function hush() {
  if (!C.msg) return;
  C.msg = "";
  clearTimeout(C.msgTimer);
  drawBar();
}

/** What the bar says about the batch sent last, while the agent has it. */
export function sentStatus() {
  const b = C.sent[C.sent.length - 1];
  return b ? `Sent · preview stays until ${typeof b.n === "number" ? `note ${b.n}` : "the note"} is done` : "";
}

export function drawBar() {
  if (!bar) return;
  if (hosted("canvas")) kick(); // the host's footer has the bar's part: the view says what changed
  const B = C.draft.B;
  const n = countEdits(B) + (B.sheet.trim() ? 1 : 0);
  const f = root.activeElement;
  const inField = f === clsEl || f === cssEl || f === freeEl;
  const busyNote = f === cnote || !!cnote.value; // words being typed are not covered by a status line
  const msg = !C.on ? ""
    : C.msg || (C.edit ? "Editing text"
    : busyNote && n ? ""
    : C.done || (n ? "" : sentStatus())); // state only: the bar carries no standing instructions (the "?" has the keys)
  tellMode();
  const key = [C.on, n, msg, C.past.length, C.future.length, dock(), inField, C.pop].join("|");
  if (key === bar._key) return;
  bar._key = key;
  const $ = (s) => bar.querySelector(s);
  const s = n === 1 ? "" : "s";
  bar.classList.toggle("canvas", C.on);
  // In notes mode the bar has one thing to say, and only sometimes: edits were left unsent.
  bar.classList.toggle("idle", !C.on && !n);
  bar.style.bottom = `${C.on ? dock() + 10 : 14}px`;
  const count = $(".count");
  count.hidden = !C.on && !n;
  count.disabled = C.on && !n;
  count.firstChild.textContent = C.on ? (n ? `${n} edit${s}` : "No edits") : `${n} unsent edit${s}`;
  count.title = C.on ? (n ? "Show what is in this batch" : "Nothing edited yet") : "Back to edit mode, where these edits can be sent";
  count.classList.toggle("open", C.pop === "list");
  for (const b of [$(".undo"), $(".redo"), $(".reset"), $(".bsend")]) b.hidden = !C.on;
  corner.style.bottom = bar.style.bottom; // the "?" keeps to the bar's row, in the corner
  corner.querySelector(".help").classList.toggle("on", C.pop === "help");
  $(".undo").disabled = !C.past.length;
  $(".redo").disabled = !C.future.length;
  $(".reset").disabled = !n;
  cnote.hidden = !C.on || !!msg;
  const m = $(".bmsg");
  m.hidden = !C.on || !msg;
  m.replaceChildren(keyNodes(msg));
  m.title = msg;
  m.classList.toggle("warn", !!C.msg);
  // The button says which key does the same from where the keyboard is now.
  $(".bsend").title = n ? `Send ${n === 1 ? "this edit" : `these ${n} edits`} as one note (${inField ? (isMac ? "⌘" : "ctrl+") : ""}↵)` : "Nothing to send yet";
  $(".bsend").disabled = !n;
}

// ── the bar's lists: what is in the batch, and the keys ─────────────────────────────────────
const HELP = () => (C.on ? editKeys(isMac) : notesKeys(isMac));

export function setPop(which) {
  C.pop = which === C.pop ? "" : which;
  drawPop();
  drawBar();
}

/** Closes whichever list is open; false when none was. */
export function closePop() {
  if (!C.pop) return false;
  setPop(C.pop);
  return true;
}

export function drawPop() {
  // Two lists, one open at a time: the batch above the bar, the keys above the "?" in the corner.
  const rows = C.pop === "list" ? editRows(true) : [];
  if (C.pop === "list" && !rows.length) C.pop = "";
  const list = bar.querySelector(".pop"), keys = corner.querySelector(".pop");
  list.hidden = C.pop !== "list";
  keys.hidden = C.pop !== "help";
  if (!C.pop) return;
  const pop = C.pop === "help" ? keys : list;
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    x.className = cls;
    if (text !== undefined) x.textContent = text;
    return x;
  };
  if (C.pop === "help")
    pop.replaceChildren(...HELP().map(([k, v]) => {
      const row = el("div", "hrow");
      const hk = el("span", "hk"), hv = el("span", "hv");
      hk.append(keyNodes(k));
      hv.append(keyNodes(v));
      row.append(hk, hv);
      return row;
    }));
  else
    pop.replaceChildren(...rows.map((r) => {
      const row = el("div", "erow");
      const x = el("button", "ex");
      x.type = "button";
      x.innerHTML = icon("x", 12);
      x.title = "Remove this edit";
      x.setAttribute("aria-label", "Remove this edit");
      row.append(el("span", "el", r.label), el("span", "et", `— ${r.text}`), x);
      row.title = `${r.label} — ${r.text}`;
      row.addEventListener("click", (e) => {
        if (x.contains(e.target)) return void removeEdit(r.key);
        if (r.kind === "sheet") {
          // The stylesheet is the batch's, not an element's: it lives under "Global".
          C.pin = true;
          syncFields();
          return freeEl.focus();
        }
        const target = elOf(r.rs);
        if (!target) return;
        select(target);
        target.scrollIntoView({ block: "center", inline: "nearest" });
      });
      return row;
    }));
}

