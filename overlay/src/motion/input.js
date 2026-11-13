// Motion mode, input: the page's pointer, the timeline's, the small sheet over the dock, clicks,
// fields and keys; the dock's elements found and listened to.

import { mod, S } from "../state.js";
import { pick } from "../page.js";
import { draftChanged } from "../draft.js";
import { apply, clamp, COUNT, curve, DIRECTION, EASINGS, esc, FILL, HOW, M, openKf, openUse, PROPS, r1, RATES, readOnly } from "./model.js";
import { animOf, newAnimation, position, reveal, seek, selectEl, toggle, useKf } from "./open.js";
import { addKey, addLane, commit, detach, discard, keyInfo, laneOrder, moveKey, removeKey, removeLane, setCss, setKey, setName, setTiming, timing, travel } from "./edit.js";
import { submit } from "./send.js";
import { draw, drawFoot, drawLanes, focusLater, keyEditor, typingIn } from "./draw.js";
import { setMode } from "../mode.js";
import { block, isOurs } from "../input.js";
import { kick } from "../render.js";
import { root } from "../mount.js";

// The dock's elements, found by mount(), and what the small sheet hangs from: declared here,
// where they are assigned.
export let dock, listEl, hdEl, tlEl, cssEl, kbEl, ftEl, noteEl, msgEl, popEl, sugEl, tagEl, popAnchor = null;

// ── the page's pointer ───────────────────────────────────────────────────────────────────
export function pointerDown(e) {
  if (S.pending) return block(e); // the screenshot is being taken: nothing new until it is
  if (popEl && !popEl.hidden) closePop();
  block(e);
  if (e.button !== 0) return;
  const el = pick(e.clientX, e.clientY);
  if (root.activeElement && root.activeElement.blur) root.activeElement.blur();
  selectEl(el);
}
/** A press let go on the page is kept from it, as the press was. */
export function pointerUp(e) {
  if (!isOurs(e)) block(e);
}
export function pointerMove(e) {
  if (isOurs(e)) {
    if (M.hover) {
      M.hover = null;
      kick();
    }
    return;
  }
  const next = pick(e.clientX, e.clientY);
  if (next !== M.hover) {
    M.hover = next;
    kick();
  }
}

// ── the timeline's pointer ───────────────────────────────────────────────────────────────
// Click a keyframe (the page shows that frame), drag it, press twice on a lane to add one,
// drag the ruler or an empty lane to scrub.
const spanOf = () => tlEl.querySelector(".m-kspan[data-prop]") || tlEl.querySelector("[data-ruler]");
function atOf(e, free, span) {
  const r = span.getBoundingClientRect(), pad = span.classList.contains("m-kspan") ? 0 : 16;
  const at = clamp(((e.clientX - r.left - pad) / (r.width - 2 * pad)) * 100, 0, 100);
  return free ? r1(at) : Math.round(at / 5) * 5;
}
function tlDown(e) {
  if (e.button || !M.open || e.target.closest("input, button, textarea")) return;
  const grip = e.target.closest(".m-key"), seg = e.target.closest("[data-seg]"), trk = e.target.closest(".m-kspan[data-prop], [data-ruler]");
  const now = performance.now(), l = M.last;
  const twice = !!l && now - l.t < 350 && Math.abs(e.clientX - l.x) < 5 && Math.abs(e.clientY - l.y) < 5;
  M.last = twice ? null : { t: now, x: e.clientX, y: e.clientY };
  const span = spanOf();
  if (!span) return;
  if (twice && !grip && trk && trk.dataset.prop !== undefined && openKf()) {
    e.preventDefault();
    addKey(trk.dataset.prop || null, atOf(e, mod(e), span));
    return focusLater("[data-k=val]");
  }
  if (grip || seg) {
    const at = Number(grip ? grip.dataset.at : seg.dataset.seg), prop = (grip || seg).dataset.prop || null;
    M.key = { at, prop };
    M.drag = grip && !readOnly() ? { type: "key", at, prop, moved: false } : null;
    seek(at / 100);
    draw();
  } else if (trk) {
    M.drag = { type: "scrub" };
    seek(atOf(e, true, span) / 100);
    if (M.key) {
      M.key = null; // a press beside the keyframes lets go of the selected one
      draw();
    }
  } else return;
  if (M.drag) tlEl.setPointerCapture(e.pointerId);
  e.preventDefault();
  tlEl.focus({ preventScroll: true });
}
function tlMove(e) {
  const d = M.drag;
  if (!d) return;
  const span = spanOf();
  if (!span) return;
  if (d.type === "scrub") return seek(atOf(e, true, span) / 100);
  const to = atOf(e, mod(e), span);
  if (to === d.at || !moveKey(d.prop, d.at, to)) return;
  d.at = to;
  M.key = { at: to, prop: d.prop };
  d.moved = true;
  apply();
  seek(to / 100);
  drawLanes();
  if (!typingIn(kbEl)) kbEl.innerHTML = keyEditor();
}
function tlUp() {
  const d = M.drag;
  M.drag = null;
  if (d && d.moved) commit();
}

// ── a small sheet over the dock ──────────────────────────────────────────────────────────
function openPop(anchor, html) {
  popEl.innerHTML = html;
  popEl.hidden = false;
  popAnchor = anchor;
  const r = anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
  popEl.style.left = `${clamp(r.right - w, 8, innerWidth - w - 8)}px`;
  popEl.style.top = `${clamp(r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8, 8, innerHeight - h - 8)}px`;
}
export function closePop() {
  if (popEl) popEl.hidden = true;
  popAnchor = null;
}
function morePop(b) {
  const t = timing(), u = openUse(), ro = readOnly() ? "disabled" : "";
  const count = { ...COUNT, ...(COUNT[t.count] ? {} : { [t.count]: [`${t.count}×`] }) };
  const how = u ? Object.fromEntries(Object.entries(HOW).filter(([k]) => !(u.isNew && k === "asnow")).map(([k, v]) => [k, [v]])) : {};
  const chips = (tkey, lab, map, cur) => `<div class="m-tchips"><span>${lab}</span><div class="m-chips" data-tkey="${tkey}">${Object.entries(map).map(([v, [text, what]]) =>
    `<button type="button" class="m-chip${String(cur) === v ? " on" : ""}" data-m="tset" data-v="${esc(v)}" ${ro} title="${esc(what ? `${what} (${v})` : v)}">${esc(text)}</button>`).join("")}</div></div>`;
  openPop(b, chips("count", "Repeat", count, t.count) + chips("direction", "Direction", DIRECTION, t.direction) + chips("fill", "Fill", FILL, t.fill) +
    (u ? chips("how", "Starts", how, u.plays.how) : ""));
}
function easePop(b) {
  const k = keyInfo();
  if (!k) return;
  const cur = k.ease || k.dflt;
  openPop(b, `<div class="m-ez">${[...new Set([cur, ...EASINGS])].map((e) => `<button type="button" data-m="ez" data-v="${esc(e)}" class="${e === cur ? "on" : ""}">${curve(e)}${esc(e)}</button>`).join("")}</div>`);
}

// ── a field's list ───────────────────────────────────────────────────────────────────────
// The property and easing fields offer their values in a list of our own: a datalist's popup is
// the system's, drawn in its own type and size, over the timeline, wherever the browser puts it.
const SUGGEST = { props: () => PROPS.filter((p) => !laneOrder().includes(p)), ease: () => EASINGS };
export let sug = null; // what is listed: { f: the field, items, i: the one marked (Enter picks it), -1 for none }
/** List what the field offers: all of it when it gets the caret, what matches once it is typed in. */
function sugShow(f, typed) {
  const all = SUGGEST[f.dataset.sug] ? SUGGEST[f.dataset.sug]() : [];
  const q = typed ? f.value.trim().toLowerCase() : "";
  // what starts with the words first, then what has them anywhere
  const items = q ? [...all.filter((x) => x.toLowerCase().startsWith(q)), ...all.filter((x) => !x.toLowerCase().startsWith(q) && x.toLowerCase().includes(q))] : all;
  if (f.disabled || !items.length || (items.length === 1 && items[0] === f.value.trim())) return sugHide();
  const i = q ? 0 : items.indexOf(f.value.trim());
  sug = { f, items, i };
  const ease = f.dataset.sug === "ease";
  sugEl.innerHTML = items.map((x, j) => `<div class="m-sg${j === i ? " on" : ""}" data-sg="${j}" role="option" aria-selected="${j === i}">${ease ? curve(x) : ""}<span>${esc(x)}</span></div>`).join("");
  sugEl.hidden = false;
  const r = f.getBoundingClientRect(), w = Math.max(r.width, ease ? 240 : 180);
  sugEl.style.width = `${w}px`;
  sugEl.style.left = `${clamp(r.left, 8, innerWidth - w - 8)}px`;
  const h = sugEl.offsetHeight; // the dock is at the bottom: above the field, where there is room
  sugEl.style.top = `${r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6}px`;
  sugMark(i);
}
export function sugHide() {
  sug = null;
  if (sugEl) sugEl.hidden = true;
}
function sugMark(i) {
  sug.i = i;
  for (const el of sugEl.children) {
    const on = Number(el.dataset.sg) === i;
    el.classList.toggle("on", on);
    el.setAttribute("aria-selected", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  }
}
/** The value goes into the field, and is done: the same as typing it and pressing Enter. */
function sugPick(i) {
  const f = sug.f, v = sug.items[i];
  sugHide();
  f.value = v;
  f.classList.remove("bad");
  onField({ target: f }, true);
  if (f.dataset.sug === "ease" && f.isConnected) f.blur();
}
/** ↑/↓ mark, Enter picks the one marked, Esc closes the list (and the next Esc leaves the field). */
function sugKey(e) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    block(e);
    const n = sug.items.length;
    sugMark(sug.i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (sug.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    return true;
  }
  if (e.key === "Enter" && sug.i >= 0 && !mod(e) && !e.isComposing) {
    block(e);
    sugPick(sug.i);
    return true;
  }
  if (e.key === "Escape") {
    block(e);
    sugHide();
    return true;
  }
  if (e.key === "Tab") sugHide();
  return false;
}

// ── clicks, fields and keys ──────────────────────────────────────────────────────────────
function onClick(e) {
  const row = e.target.closest("[data-row]");
  if (row) {
    const r = listEl._rows[row.dataset.row];
    if (r && !r.off) {
      r.open();
      reveal(M.sel);
    }
    return;
  }
  const b = e.target.closest("[data-m]");
  if (!b || b.disabled) return;
  const act = b.dataset.m;
  if (act === "play") toggle();
  else if (act === "rate") {
    M.rate = RATES[(RATES.indexOf(M.rate) + 1) % RATES.length];
    const a = animOf();
    if (a) a.playbackRate = M.rate;
  } else if (act === "loop") (M.loop = !M.loop), (M.loopAt = 0);
  else if (act === "iso") {
    M.isolate = !M.isolate;
    apply();
  } else if (act === "undo") return travel(M.past, M.future);
  else if (act === "discard") return discard();
  else if (act === "new") return newAnimation();
  else if (act === "use") return useKf(b.dataset.v);
  else if (act === "rmkey") return removeKey();
  else if (act === "rmlane") return removeLane(b.dataset.prop);
  else if (act === "detach") return detach();
  else if (act === "view") {
    // The text being typed is done (a hidden field loses the caret without a word, so it would
    // never say so itself): it is one undo step, and the list follows a new name.
    const a = root.activeElement;
    if (a && a.dataset && a.dataset.css !== undefined) a.blur();
    M.view = b.dataset.v;
  }
  else if (act === "more") return popAnchor === b ? closePop() : morePop(b);
  else if (act === "kease") return popAnchor === b ? closePop() : easePop(b);
  else if (act === "ez") {
    setKey("ease", b.dataset.v, true);
    return closePop();
  } else if (act === "tset") {
    // a chip: set, and marked in its row here (the popover is not drawn again)
    const row2 = b.closest("[data-tkey]");
    setTiming(row2.dataset.tkey, b.dataset.v, true);
    for (const c of row2.children) c.classList.toggle("on", c === b);
    return;
  } else if (act === "send") return submit(e.altKey);
  draw();
}
function onField(e, done) {
  const f = e.target;
  if (f === noteEl) return drawFoot();
  if (f.dataset.sug !== undefined && !done) sugShow(f, true);
  if (f.dataset.name !== undefined) {
    const ok = setName(f.value, done);
    f.classList.toggle("bad", !ok);
    if (done && !ok) {
      // what was typed is not a name it can have: the one it has comes back
      f.value = M.open ? M.open.name : f.value;
      f.classList.remove("bad");
    }
    return;
  }
  if (f.dataset.css !== undefined) {
    const why = setCss(f.value), err = f.parentElement.querySelector(".m-err");
    if (err) (err.hidden = !why), (err.textContent = why);
    if (!why) drawFoot();
    return;
  }
  if (f.dataset.t !== undefined) {
    const ok = setTiming(f.dataset.t, f.value, done);
    f.classList.toggle("bad", !ok);
    if (ok && !done) drawLanes();
  } else if (f.dataset.k !== undefined) {
    const ok = setKey(f.dataset.k, f.value, done);
    f.classList.toggle("bad", !ok);
    if (ok && !done) drawLanes();
  } else if (f.dataset.addp !== undefined && done && f.value.trim()) {
    if (!addLane(f.value)) f.classList.add("bad");
    else {
      // The timeline was not drawn while this field had the caret: now, with the new lane (the
      // field goes, emptied first so its leaving says nothing), and the caret in its value.
      f.value = "";
      drawLanes();
      focusLater("[data-k=val]");
    }
  }
}
/** Keys while motion mode is on. Typing in the dock's fields never reaches the page. */
export function key(e) {
  const f = root.activeElement;
  const field = f && /^(INPUT|TEXTAREA)$/.test(f.tagName) && (dock.contains(f) || popEl.contains(f)) ? f : null;
  if (field) {
    if (sug && sug.f === field && sugKey(e)) return;
    if (e.key === "Enter" && !e.isComposing && (field.tagName === "INPUT" || mod(e))) {
      block(e);
      if (field === noteEl || mod(e)) return submit(e.altKey);
      field.blur(); // its change event makes the undo step
      return;
    }
    if (e.key === "Escape") {
      block(e);
      field.blur();
      // Esc in a keyframe's field is done with that keyframe too.
      if (field.dataset.k !== undefined) {
        M.key = null;
        draw();
      }
      return;
    }
    e.stopImmediatePropagation(); // typing: the page's handlers never see it
    return;
  }
  if (mod(e) && e.key.toLowerCase() === "z") {
    block(e);
    return e.shiftKey ? travel(M.future, M.past) : travel(M.past, M.future);
  }
  if (mod(e) || e.altKey && e.key !== "Enter") return;
  if (e.key === " ") {
    block(e);
    toggle();
    return draw();
  }
  if (e.key === "Enter" && !e.isComposing) {
    block(e);
    return submit(e.altKey);
  }
  if ((e.key === "Delete" || e.key === "Backspace") && M.key && openKf()) {
    block(e);
    return removeKey();
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (!M.open) return;
    block(e);
    return seek((position() ?? M.pos) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01));
  }
  if (e.key === "Escape") {
    block(e);
    if (popEl && !popEl.hidden) closePop();
    else if (M.key) {
      M.key = null;
      draw();
    } else if (M.open || M.sel) selectEl(null);
    else setMode("notes");
  }
}

// ── mount ────────────────────────────────────────────────────────────────────────────────
export function mount() {
  dock = root.querySelector(".m-dock");
  listEl = dock.querySelector(".m-list");
  hdEl = dock.querySelector(".m-hd");
  tlEl = dock.querySelector(".m-tl");
  cssEl = dock.querySelector(".m-css");
  kbEl = dock.querySelector(".m-kb");
  ftEl = dock.querySelector(".m-ft");
  noteEl = dock.querySelector(".m-note");
  msgEl = dock.querySelector(".m-msg");
  popEl = root.querySelector(".m-pop");
  sugEl = root.querySelector(".m-sug");
  tagEl = root.querySelector(".m-tag");
  // A press in the list keeps the caret in the field; a click picks.
  sugEl.addEventListener("mousedown", (e) => e.preventDefault());
  sugEl.addEventListener("click", (e) => {
    const o = e.target.closest("[data-sg]");
    if (o && sug) sugPick(Number(o.dataset.sg));
  });
  for (const el of [dock, popEl]) {
    el.addEventListener("click", onClick);
    el.addEventListener("input", (e) => onField(e, false));
    el.addEventListener("change", (e) => onField(e, true));
    // Keys typed into the dock must not reach the page's own shortcuts.
    for (const t of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut"]) el.addEventListener(t, (e) => e.stopPropagation());
  }
  // focus and blur, caught on the way down: focusin and focusout coming from the page or going to
  // it are stopped at the window (mount.js), so a field left for the page would never say so.
  dock.addEventListener("focus", (e) => {
    if (e.target.dataset && e.target.dataset.sug !== undefined) sugShow(e.target, false);
  }, true);
  dock.addEventListener("blur", (e) => {
    if (sug && e.target === sug.f) sugHide();
    if (e.target.dataset && e.target.dataset.css !== undefined) commit();
    if (e.target === noteEl) {
      drawFoot();
      draftChanged();
    }
  }, true);
  noteEl.addEventListener("focus", drawFoot);
  // A button keeps the caret where it was (the note, a value being typed).
  dock.addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
  listEl.addEventListener("pointerover", (e) => {
    const row = e.target.closest("[data-row]");
    const r = row && listEl._rows[row.dataset.row];
    M.rowEls = r && r.els && r.els.length ? r.els : null;
    kick();
  });
  listEl.addEventListener("pointerleave", () => {
    M.rowEls = null;
    kick();
  });
  tlEl.addEventListener("pointerdown", tlDown);
  tlEl.addEventListener("pointermove", tlMove);
  tlEl.addEventListener("pointerup", tlUp);
  tlEl.addEventListener("pointercancel", tlUp);
}
