// ── draft ───────────────────────────────────────────────────────────────────────────────────
const hasDraft = () => S.sel.length > 0 || S.strokes.length > 0 || !!S.area;

function serializeDraft() {
  const noteDraft = !S.pending && (hasDraft() || !!textarea.value);
  const canvas = Canvas.draft();
  const motion = Motion.draft();
  if (!noteDraft && !canvas && !motion) return null;
  // (Between a send and its "captured", S.sel holds the sent note's outlines: not a draft.)
  return {
    text: textarea.value, targets: (noteDraft ? S.sel : []).map(selectorFor), area: S.area, strokes: S.strokes, template: S.template,
    ...canvas, ...(motion ? { motion } : {}),
  };
}

function draftChanged() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => send({ type: "draft", draft: serializeDraft() }), 120);
}

function restoreDraft(d) {
  if (!d) return;
  S.sel = (d.targets || []).map(q).filter(Boolean);
  S.area = d.area || null;
  S.strokes = d.strokes || [];
  textarea.value = d.text || "";
  setTemplate(S.templates.some((t) => t.name === d.template) ? d.template : null);
  if (hasDraft() || textarea.value) openCard();
  Canvas.restore(d);
  Motion.restore(d.motion);
}

function clearDraft() {
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

// ── note card ───────────────────────────────────────────────────────────────────────────────
function updateCardMeta() {
  what.title = S.sel.length === 1 ? label(S.sel[0]) : "";
  if (S.sel.length === 1) what.textContent = plainLabel(S.sel[0]);
  else if (S.sel.length > 1) what.textContent = `${S.sel.length} elements`;
  else if (S.strokes.length) what.textContent = "drawing";
  else what.textContent = "area";
}

function openCard() {
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
function setHint(why) {
  const hint = card.querySelector(".hint");
  const text = why || "";
  if (hint.textContent === text) return;
  hint.textContent = hint.title = text;
  hint.hidden = !why;
  hint.classList.toggle("warn", !!why);
}

/** The ↵ in the card's corner: lit when Enter would send. */
function drawCardSend() {
  if (!card) return;
  const can = !!(textarea.value.trim() || S.template);
  const b = card.querySelector(".csend");
  if (b.disabled === !can) return;
  b.disabled = !can;
}

function closeCard() {
  S.card = false;
  card.hidden = true;
  setHint("");
  if (root && root.activeElement === textarea) textarea.blur();
}

function autosize() {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
}

// ── templates ───────────────────────────────────────────────────────────────────────────────
// "/" at the start of a note lists kinds of work (variants, accessible, grade, …). Picking one
// puts a chip on the card; whatever is typed after it steers the template, and may be nothing.
function setTemplate(name) {
  S.template = name || null;
  S.menu = null;
  if (!chip) return;
  chip.hidden = !S.template;
  chip.textContent = S.template ? `/${S.template}` : "";
  const t = S.templates.find((x) => x.name === S.template);
  textarea.placeholder = t ? `${t.hint}. A note is optional` : PLACEHOLDER;
  drawCardSend();
  drawMenu();
}

function updateMenu() {
  const m = !S.template && S.templates.length ? /^\/([a-z-]*)$/.exec(textarea.value) : null;
  const found = m ? S.templates.filter((t) => t.name.startsWith(m[1])) : [];
  S.menu = found.length ? found : null;
  S.menuAt = Math.min(S.menuAt, Math.max(0, found.length - 1));
  drawMenu();
}

function drawMenu() {
  if (!menuEl) return;
  menuEl.hidden = !S.menu;
  menuEl.replaceChildren(
    ...(S.menu || []).map((t, i) => {
      const row = document.createElement("div");
      row.className = `opt${i === S.menuAt ? " on" : ""}`;
      const name = document.createElement("span");
      name.className = "opt-name";
      name.textContent = `/${t.name}`;
      const hint = document.createElement("span");
      hint.className = "opt-hint";
      hint.textContent = t.hint;
      row.append(name, hint);
      // mousedown, not click: the textarea must keep the caret.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickTemplate(t);
      });
      return row;
    }),
  );
  kick();
}

function pickTemplate(t) {
  textarea.value = "";
  setTemplate(t.name);
  autosize();
  draftChanged();
  textarea.focus({ preventScroll: true });
}

// ── pasted pictures ─────────────────────────────────────────────────────────────────────────
// A reference to go with the words ("like this"). They are scaled down here, so a full-screen
// screenshot costs the agent no more than the note's own crops, and they are not part of the
// saved draft: a page reload drops them.
const MAX_IMAGES = 4;
const IMAGE_SIDE = 1600;

function setImages(list) {
  S.images = list;
  if (!refs) return;
  refs.replaceChildren(
    ...list.map((im, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ref";
      b.title = "Remove this picture";
      const img = document.createElement("img");
      img.src = im.uri;
      img.alt = `Picture ${i + 1}`;
      b.append(img);
      b.addEventListener("click", () => {
        setImages(S.images.filter((x) => x !== im));
        textarea.focus({ preventScroll: true });
      });
      return b;
    }),
  );
  refs.hidden = !list.length;
  kick();
}

async function addImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; // JPEG has no transparency
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const uri = c.toDataURL("image/jpeg", 0.85);
    if (S.card && S.images.length < MAX_IMAGES) setImages([...S.images, { name: "reference.jpg", uri }]);
  } catch {
    // Not a picture the browser can read: nothing is added.
  }
}

function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault();
  for (const f of files.slice(0, MAX_IMAGES)) void addImage(f);
}

// A stroke's box in document coordinates, worked out once: a stroke is never changed after it
// is drawn (undo drops it whole, a restored draft brings new arrays).
const strokeBox = new WeakMap();
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

function placeCard() {
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

// ── submit ──────────────────────────────────────────────────────────────────────────────────
function submit(background) {
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
    ...(background ? { lane: "bg" } : {}),
    ...(S.images.length ? { images: S.images } : {}),
    ...(S.template ? { template: S.template } : {}),
  };
  setBrush(false);
  dispatch(note);
}

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

