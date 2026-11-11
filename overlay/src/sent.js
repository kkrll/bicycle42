// ── "Sent" ──────────────────────────────────────────────────────────────────────────────────
// The card vanishes on Enter. For a moment a chip says the note went, and which number it got,
// where the card was; it never blocks the next click and is gone before the next screenshot.
function showSent(id) {
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

function hideSent() {
  clearTimeout(sentTimer);
  S.undo = null;
  if (sentEl) sentEl.hidden = true;
}

function offerUndo(draft) {
  if (!cardAt) return;
  sentEl.replaceChildren(keyNodes(`Note dropped · ${isMac ? "⌘" : "ctrl+"}Z brings it back`));
  sentEl.style.transform = `translate(${cardAt[0]}px, ${cardAt[1]}px)`;
  sentEl.hidden = false;
  sentEl.style.animation = "none";
  clearTimeout(sentTimer);
  S.undo = draft;
  sentTimer = setTimeout(hideSent, 5000);
}

// ── pin tooltip ─────────────────────────────────────────────────────────────────────────────
const STATUS_WORDS = { queued: "Waiting", working: "Working", done: "Done", failed: "Failed", paused: "Paused (offline)", stopped: "Stopped" };

function showTip(el) {
  const p = el._pin;
  if (!p || !S.enabled || S.drag) return;
  const r = el.getBoundingClientRect();
  tip.replaceChildren();
  const state = document.createElement("div");
  state.className = `tip-state ${p.status || "queued"}`;
  state.textContent = `${p.n} · ${STATUS_WORDS[p.status] || "Waiting"}${p.lane === "bg" ? " · in parallel" : ""}`;
  tip.append(state);
  if (p.note) {
    const words = document.createElement("div");
    words.textContent = p.note;
    tip.append(words);
  }
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(8, top))}px)`;
}

function hideTip() {
  if (tip && !tip.hidden) tip.hidden = true; // (writing `hidden` again restyles, even unchanged)
}

function makePin() {
  const el = document.createElement("div");
  el.addEventListener("mouseenter", () => showTip(el));
  el.addEventListener("mouseleave", hideTip);
  // Clicking a pin shows its note in the app's panel; it never starts a selection.
  el.addEventListener("click", () => el._pin && S.enabled && send({ type: "pin", id: el._pin.id }));
  return el;
}

/** The host did not take the note ("captured" with ok: false): it must not look sent. Nothing
 *  of a plain note was cleared yet (finishCapture does that), so its card opens again with
 *  the words in it; a canvas batch goes back to being the unsent one. */
function refuseCapture(id, why) {
  if (!S.pending || S.pending !== id) return;
  S.pending = null;
  S.buffered = null;
  const say = `Not sent: ${typeof why === "string" && why.trim() ? line(why).slice(0, 80) : "the app did not take the note"}`;
  if (S.quiet === id) {
    S.quiet = null;
    if (!MO.refuse(id, say)) unsendCanvas(id, say);
  } else {
    openCard();
    setHint(say);
  }
  kick();
}

function finishCapture(id) {
  if (!S.pending || S.pending !== id) return;
  S.pending = null;
  C.unsent = null;
  MO.finish(id);
  if (S.quiet === id) S.quiet = null;
  else showSent(id);
  S.sel = [];
  S.area = null;
  S.strokes = [];
  textarea.value = "";
  setImages([]);
  setTemplate(null);
  send({ type: "draft", draft: serializeDraft() });
  const b = S.buffered;
  S.buffered = null;
  const el = b && pick(b.x, b.y);
  if (el && C.on) select(el);
  else if (el) {
    S.sel = [el];
    openCard();
  }
  kick();
}

