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

// ── a note sent ─────────────────────────────────────────────────────────────────────────────
function dispatch(note) {
  // Hide the card (and, via S.pending, hover and pins) before the host takes its screenshot.
  closeCard();
  hideSent();
  hideTip();
  S.pending = note.id;
  clearTimeout(draftTimer);
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => send({ type: "note", note })));
  setTimeout(() => finishCapture(note.id), CAPTURE_TIMEOUT_MS);
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
    if (!Motion.refuse(id, say)) Canvas.refuse(id, say);
  } else {
    openCard();
    setHint(say);
  }
  kick();
}

function finishCapture(id) {
  if (!S.pending || S.pending !== id) return;
  S.pending = null;
  Canvas.finish();
  Motion.finish(id);
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
  if (el && modeOn() === "canvas") Canvas.select(el);
  else if (el) {
    S.sel = [el];
    openCard();
  }
  kick();
}

