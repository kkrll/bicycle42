// ── input ───────────────────────────────────────────────────────────────────────────────────
const isOurs = (e) => !!hostEl && e.composedPath().includes(hostEl);
const block = (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
};

function onPointerDown(e) {
  if (!S.enabled) return;
  if (MO.on) {
    if (isOurs(e)) return;
    if (S.pending) return block(e); // the screenshot is being taken: nothing new until it is
    return MO.pointerDown(e);
  }
  const zone = C.on ? zoneOf(e) : null; // a handle, an edge or a gap of the canvas selection: ours, but a page gesture
  if (isOurs(e) && !zone) return;
  if (C.pop) setPop(C.pop); // a click on the page closes whichever list is open
  if (C.edit && inEdit(e)) return void e.stopImmediatePropagation(); // the caret goes where it is clicked
  block(e);
  if (e.button !== 0) return;
  if (S.pending) {
    // The host is still taking the previous note's screenshot: hold this click until it's done,
    // so the new outline can't land in that screenshot. (A drag started now is dropped.)
    S.buffered = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    return;
  }
  if (C.on) return cvDown(e, zone);
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

function onPointerMove(e) {
  if (!S.enabled) return;
  if (C.on) return cvMove(e);
  if (MO.on) return MO.pointerMove(e);
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

function onPointerUp(e) {
  if (C.on) return void (S.enabled && cvUp(e));
  if (MO.on) return void (S.enabled && !isOurs(e) && block(e));
  const d = S.drag;
  if (!S.enabled || !d) return;
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

function blockIfActive(e) {
  if (!S.enabled || isOurs(e)) return;
  // While text is edited in place, the mouse works inside it (caret, selection); the page's own
  // handlers still see nothing, and a click still does nothing (no link is followed).
  if (C.edit && inEdit(e) && /^(mousedown|mouseup|selectstart|dblclick)$/.test(e.type)) e.stopImmediatePropagation();
  else block(e);
}

function onKeyDown(e) {
  if (mod(e) && e.shiftKey && e.code === "KeyM") {
    block(e);
    send({ type: "toggle" });
    return;
  }
  if (!S.enabled) return;
  if (mod(e) && !e.shiftKey && !e.altKey && e.code === "KeyE") {
    block(e);
    setCanvas(!C.on);
    return;
  }
  if (C.on) return cvKey(e);
  if (MO.on) return MO.key(e);
  if (e.key === "Escape" && C.pop) {
    block(e);
    setPop(C.pop);
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

function setEnabled(on) {
  S.enabled = on;
  document.documentElement.toggleAttribute("data-b42-review", on);
  pinsEl.classList.toggle("live", on);
  if (!on) {
    S.hover = null;
    S.drag = null;
    card.hidden = true;
    hideTip();
    hideSent();
    endEdit(true);
    cancelDrag();
    setBrush(false);
    MO.letGo(); // the page is used as it is: nothing stays stopped at a frame
  } else if (S.card) {
    card.hidden = false;
    textarea.focus({ preventScroll: true });
  }
  syncUi();
  MO.syncUi();
  kick();
}

function setPins(pins) {
  const old = new Map(S.pins.map((p) => [p.id, p]));
  S.pins = (pins || []).map((p) => ({ ...p, el: old.get(p.id)?.el }));
  if (C.sent.length) dropFinished();
  if (MO.hasSent()) MO.dropFinished();
  kick();
}

