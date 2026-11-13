// Notes mode, input: the page's pointer (hover, click, shift+click, an area, a drawing) and the
// keys of the note card. (The draft, the card and the rest of notes mode are beside it in notes/.)

import { DRAG_PX, mod, S, send } from "../state.js";
import { elementsIn, pick, strokeTargets, toView } from "../page.js";
import { draftChanged, restoreDraft, serializeDraft } from "../draft.js";
import { autosize, openCard, updateCardMeta } from "./card.js";
import { drawMenu, pickTemplate, setTemplate, updateMenu } from "./templates.js";
import { setImages } from "./pictures.js";
import { clearDraft, hasDraft } from "./draft.js";
import { submit } from "./submit.js";
import { hideSent, offerUndo } from "./sent.js";
import { textarea } from "./mount.js";
import * as Canvas from "../canvas/api.js";
import { setBrush } from "../mode.js";
import { block, isOurs, pagePress } from "../input.js";
import { kick } from "../render.js";

// ── the page's pointer ───────────────────────────────────────────────────────────────────
export function pointerDown(e) {
  if (!pagePress(e)) return;
  S.drag = {
    x0: e.clientX,
    y0: e.clientY,
    x: e.clientX,
    y: e.clientY,
    mode: null,
    alt: e.altKey || S.brush, // the host's brush: a plain drag draws, as alt+drag does
    shift: e.shiftKey,
    pts: [[e.clientX + window.scrollX, e.clientY + window.scrollY]],
  };
}

export function pointerMove(e) {
  const d = S.drag;
  if (!d) {
    const next = isOurs(e) ? null : pick(e.clientX, e.clientY);
    if (next !== S.hover) {
      S.hover = next;
      kick();
    }
    return;
  }
  block(e);
  d.x = e.clientX;
  d.y = e.clientY;
  if (!d.mode && Math.hypot(d.x - d.x0, d.y - d.y0) > DRAG_PX) d.mode = d.alt ? "draw" : "area";
  if (d.mode === "draw") {
    const [lx, ly] = toView(d.pts[d.pts.length - 1]);
    if (Math.hypot(d.x - lx, d.y - ly) > 2) d.pts.push([d.x + window.scrollX, d.y + window.scrollY]);
  }
  kick();
}

export function pointerUp(e) {
  const d = S.drag;
  if (!d) return;
  block(e);
  S.drag = null;
  if (d.mode === "draw" && d.pts.length >= 2) {
    S.strokes.push(d.pts);
    if (!S.sel.length) S.sel = strokeTargets(d.pts);
    openCard();
    return;
  }
  if (d.mode === "area") {
    const r = { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
    if (r.w >= 6 && r.h >= 6) {
      const inside = elementsIn(r);
      S.sel = d.shift ? [...new Set([...S.sel, ...inside])] : inside;
      S.area = { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.w, h: r.h };
      openCard();
      return;
    }
  }
  const el = pick(d.x0, d.y0);
  if (!el) return;
  if (d.shift) {
    const i = S.sel.indexOf(el);
    if (i >= 0) S.sel.splice(i, 1);
    else S.sel.push(el);
  } else {
    S.sel = [el];
    S.area = null;
  }
  if (hasDraft()) openCard();
  else clearDraft();
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────
function walk(dir) {
  const el = S.sel[0];
  if (!el) return;
  let next = null;
  if (dir === "up") {
    next = el.parentElement;
    if (next === document.body || next === document.documentElement) next = null;
  } else {
    const kids = [...el.children];
    next = kids.find((k) => {
      const r = k.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) || kids[0] || null;
  }
  if (!next) return;
  S.sel = [next];
  S.area = null;
  updateCardMeta();
  draftChanged();
  kick();
}

export function key(e) {
  if (e.key === "Escape" && Canvas.closePop()) {
    block(e);
    return;
  }
  if (e.key === "Escape") {
    block(e);
    if (S.menu) {
      // First Esc closes the template list and keeps the selection.
      textarea.value = "";
      updateMenu();
      autosize();
    } else if (S.card || hasDraft()) {
      // Typed words are not thrown away on a slip: for a few seconds mod+Z brings the note back.
      const kept = textarea.value.trim() ? { ...serializeDraft(), images: S.images } : null;
      clearDraft();
      setBrush(false);
      if (kept) offerUndo(kept);
    }
    else send({ type: "toggle", enabled: false });
    return;
  }
  if (S.undo && mod(e) && !e.shiftKey && e.key.toLowerCase() === "z") {
    block(e);
    const d = S.undo;
    hideSent();
    restoreDraft(d);
    setImages(d.images || []);
    return;
  }
  if (!S.card) return;
  if (S.menu) {
    // The template list is open: arrows move in it, Enter or Tab picks, Esc (above) cancels.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      block(e);
      S.menuAt = (S.menuAt + (e.key === "ArrowDown" ? 1 : S.menu.length - 1)) % S.menu.length;
      drawMenu();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
      block(e);
      pickTemplate(S.menu[S.menuAt]);
      return;
    }
  }
  if (e.key === "Backspace" && S.template && !textarea.value) {
    block(e);
    setTemplate(null);
    draftChanged();
    return;
  }
  const empty = !textarea.value;
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && S.sel.length === 1 && (empty || e.altKey)) {
    block(e);
    walk(e.key === "ArrowUp" ? "up" : "down");
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    block(e);
    submit(e.altKey);
    return;
  }
  if (mod(e) && !e.shiftKey && e.key.toLowerCase() === "z" && S.strokes.length && empty) {
    block(e);
    S.strokes.pop();
    if (!hasDraft()) clearDraft();
    else {
      updateCardMeta();
      draftChanged();
    }
    kick();
  }
}
