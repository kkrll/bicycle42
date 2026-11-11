// Motion mode's interface pieces. Each draw function writes HTML with data attributes; wire()
// listens for them once, on the whole document, so a piece can be drawn anywhere (the dock, a
// popover) and still work. dock.js calls them from its redraw().
import { createMotion, esc, r1, clamp, mod, curvePoints, EASINGS, PROPS, HOW, COUNT, DIRECTION, FILL } from "./core.js";
export { esc };

const ICONS = {
  play: '<path d="M5 3.2v9.6L12.5 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  loop: '<path d="M3 7.5V7a3 3 0 0 1 3-3h7"/><path d="m11 2 2 2-2 2"/><path d="M13 8.5V9a3 3 0 0 1-3 3H3"/><path d="m5 14-2-2 2-2"/>',
  iso: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5"/>',
  undo: '<path d="M5.5 9 2.5 6l3-3"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H7"/>',
  reset: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  link: '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5"/><path d="M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5"/>',
  x: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
  more: '<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/>',
};
export const icon = (name, size = 16) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
export const curve = (easing, size = 28) => `<svg class="cv" viewBox="0 0 ${size} ${size}" aria-hidden="true"><polyline points="${curvePoints(easing, size, size, 6)}" fill="none" stroke="#fffaa0" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const RATES = [1, 0.5, 0.25, 0.1];
const RATE_TEXT = { 1: "1×", 0.5: "½×", 0.25: "¼×", 0.1: "⅒×" };

/** The page under review, in `el` (class "page"), with the sheet over it that takes the pointer. */
export function mountPage(el, redraw) {
  el.classList.add("page");
  el.innerHTML = `<iframe title="Page under review"></iframe><div class="shield"><div class="rowboxes"></div><div class="box hover" hidden></div>
    <div class="box cur" hidden></div><div class="tag" hidden></div></div>`;
  const ui = { view: "keys", redraw: () => redraw() };
  const mo = createMotion(el.querySelector("iframe"), (what) => (what === "list" ? redraw("list") : redraw()));
  const shield = el.querySelector(".shield");
  const under = (e) => {
    const r = shield.getBoundingClientRect();
    return mo.at(e.clientX - r.left, e.clientY - r.top);
  };
  shield.addEventListener("mousemove", (e) => (mo.M.hover = under(e)));
  shield.addEventListener("mouseleave", () => (mo.M.hover = null));
  shield.addEventListener("click", (e) => mo.select(under(e)));
  shield.addEventListener("wheel", (e) => mo.win && mo.win.scrollBy(e.deltaX, e.deltaY), { passive: true });
  ui.boxes = [el.querySelector(".box.hover"), el.querySelector(".box.cur")];
  ui.tag = el.querySelector(".tag");
  ui.rowBoxes = el.querySelector(".rowboxes");
  ui.rowEls = null; // the elements of the list row under the pointer
  /** Bring the element into the page's view, and send a ring out from it once: the way to find
   *  something small (a 12px spinner) after choosing it in the list. */
  ui.reveal = (target) => {
    if (!target || !target.isConnected) return;
    const r = target.getBoundingClientRect(), h = mo.win.innerHeight, w = mo.win.innerWidth;
    if (r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    const box = ui.boxes[1];
    box.classList.remove("find");
    void box.offsetWidth;
    box.classList.add("find");
  };
  return { mo, ui };
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────
// What kind of motion a row is, as an icon (24 grid, drawn at 16). A keyframe animation is a
// ball leaving echoes; a transition goes from one state to another; a script's ball is in braces;
// frame by frame is three discrete steps; keyframes nothing plays are the ball as an outline.
const C = "currentColor";
const BALL_TRAIL = `<rect x="6" y="9" width="12" height="1" rx="0.5" fill="${C}"/><rect x="3.5" y="11.5" width="12" height="1" rx="0.5" fill="${C}"/><rect x="6" y="14" width="12" height="1" rx="0.5" fill="${C}"/>
  <path d="M10 17.2972C9.14213 17.7457 8.16248 18 7.12225 18C3.74102 18 1 15.3137 1 12C1 8.68629 3.74102 6 7.12225 6C8.16248 6 9.14213 6.25425 10 6.70281" stroke="${C}"/>
  <path d="M15.0036 17.2972C14.1457 17.7457 13.1661 18 12.1258 18C10.3126 18 8.68353 17.2275 7.5625 16M15.0036 6.70281C14.1457 6.25425 13.1661 6 12.1258 6C10.3126 6 8.68353 6.7725 7.5625 8" stroke="${C}"/>`;
const KIND = {
  css: `${BALL_TRAIL}<circle cx="18" cy="12" r="5.5" fill="${C}" stroke="${C}"/>`,
  unused: `${BALL_TRAIL}<circle cx="18" cy="12" r="5.5" fill="var(--panel, #161617)" stroke="${C}"/>`,
  transition: `<circle cx="7.5" cy="12" r="5.5" stroke="${C}"/><circle cx="16.5" cy="12" r="5.5" fill="${C}" stroke="${C}"/>`,
  script: `<path d="M6 5.5c-1.7 0-2.5.8-2.5 2.5v1.5c0 1.3-.7 2.5-2 2.5 1.3 0 2 1.2 2 2.5V16c0 1.7.8 2.5 2.5 2.5M18 5.5c1.7 0 2.5.8 2.5 2.5v1.5c0 1.3.7 2.5 2 2.5-1.3 0-2 1.2-2 2.5V16c0 1.7-.8 2.5-2.5 2.5" stroke="${C}" stroke-linecap="round"/><circle cx="12" cy="12" r="4" fill="${C}"/>`,
  frames: `<circle cx="4.5" cy="12" r="3" stroke="${C}"/><circle cx="12" cy="12" r="3" stroke="${C}"/><circle cx="19.5" cy="12" r="3" fill="${C}" stroke="${C}"/>`,
};
const KIND_TITLE = { css: "Keyframes", unused: "Keyframes nothing plays", transition: "Transition", script: "Script (animate())", frames: "Moved by a script, frame by frame" };
export const kindIcon = (kind, size = 16) => `<svg class="kind" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${KIND[kind] || KIND.css}</svg>`;

// ── the list rows ────────────────────────────────────────────────────────────────────────────────
/** opts.label: the element beside the name. opts.dur: the duration on the right. */
export function drawList(el, mo, opts = {}) {
  const { label = true, dur = true } = opts;
  const rows = mo.list();
  el._rows = rows;
  el.dataset.list = "";
  el.innerHTML = rows.map((r, i) => r.group ? `<div class="l-grp">${esc(r.group)}</div>`
    : `<div class="l-it k-${r.kind}${r.on ? " on" : ""}${r.sub ? " sub" : ""}${r.sub && !(rows[i + 1] && rows[i + 1].sub) ? " last" : ""}${r.off ? " off" : ""}${r.running ? " run" : ""}" data-row="${i}"
      title="${r.sub ? "" : `${KIND_TITLE[r.kind]}${r.running ? ", playing" : ""}`}">
      ${r.sub ? "" : kindIcon(r.kind)}<span class="nm">${esc(r.sub ? r.label : r.name)}</span>
      <span class="ex">${label && !r.sub ? esc(r.label) : ""}</span>${r.dirty ? '<i class="ed"></i>' : ""}
      ${dur && r.duration !== null && r.duration !== undefined ? `<span class="du">${Math.round(r.duration)}</span>` : ""}</div>`).join("");
}

// ── the timeline's pointer ──────────────────────────────────────────────────────────────────
/** Pointer on a timeline: click a keyframe (the page shows that frame), drag it, press twice on
 *  a lane to add one, drag the ruler or an empty lane to scrub. Any layout's lanes work here if
 *  they use these attributes: [data-ruler], .trk[data-prop], .key[data-at], [data-seg].
 *  opts.span(e) may give the element whose width is 0…100% (default: the ruler). */
export function wireLanes(tl, mo, redraw, opts = {}) {
  let drag = null, last = null;
  const spanOf = (e) => (opts.span && opts.span(e)) || tl.querySelector("[data-ruler]");
  const atOf = (e, free, span) => {
    const r = span.getBoundingClientRect(), pad = parseFloat(getComputedStyle(span).getPropertyValue("--pad")) || 0;
    const at = clamp(((e.clientX - r.left - pad) / (r.width - 2 * pad)) * 100, 0, 100);
    return free ? r1(at) : Math.round(at / 5) * 5;
  };
  tl.addEventListener("pointerdown", (e) => {
    if (e.button || !mo.M.open || e.target.closest("input, button, select, textarea")) return;
    const key = e.target.closest(".key:not(.imp)"), segEl = e.target.closest("[data-seg]"), seg = segEl && (e.target.tagName === "SPAN" || segEl.dataset.click !== undefined) ? segEl : null, trk = e.target.closest(".trk[data-prop], [data-ruler]");
    const now = performance.now();
    const twice = !!last && now - last.t < 350 && Math.abs(e.clientX - last.x) < 5 && Math.abs(e.clientY - last.y) < 5;
    last = twice ? null : { t: now, x: e.clientX, y: e.clientY };
    const span = spanOf(e);
    if (!span) return;
    if (twice && !key && trk && trk.dataset.prop !== undefined && mo.openKf()) {
      e.preventDefault();
      mo.addKey(trk.dataset.prop || null, atOf(e, mod(e), span));
      return focusLater("[data-k=val]");
    }
    if (key || seg) {
      const at = Number(key ? key.dataset.at : seg.dataset.seg), prop = (key || seg).dataset.prop || null;
      mo.selectKey(at, prop);
      drag = key && !mo.readOnly() ? { type: "key", at, prop, moved: false, span } : null;
      mo.seek(at / 100);
      redraw();
    } else if (trk) {
      drag = { type: "scrub", span };
      mo.seek(atOf(e, true, span) / 100);
      if (mo.M.key) {
        mo.selectKey(null); // a press beside the keyframes lets go of the selected one
        redraw();
      }
    } else return;
    if (drag) tl.setPointerCapture(e.pointerId);
    e.preventDefault();
    tl.focus({ preventScroll: true });
  });
  tl.addEventListener("pointermove", (e) => {
    const d = drag;
    if (!d) return;
    if (d.type === "scrub") {
      if (!d.span.isConnected) d.span = spanOf(e);
      return mo.seek(atOf(e, true, d.span) / 100);
    }
    if (!d.span.isConnected) d.span = spanOf(e); // the lanes were drawn again under the pointer
    const to = atOf(e, mod(e), d.span);
    if (to === d.at || !mo.moveKey(d.prop, d.at, to)) return;
    d.at = to;
    mo.selectKey(to, d.prop);
    d.moved = true;
    mo.apply();
    mo.seek(to / 100);
    redraw();
  });
  const end = () => {
    const d = drag;
    drag = null;
    if (d && d.moved) mo.commit();
  };
  tl.addEventListener("pointerup", end);
  tl.addEventListener("pointercancel", end);
}
const focusLater = (sel) =>
  setTimeout(() => {
    const f = document.querySelector(sel);
    if (f && !f.disabled) f.select ? f.select() : f.focus();
  }, 0);

// ── transport ────────────────────────────────────────────────────────────────────────────────
/** Play, and the time. */
export function transport(mo) {
  const o = mo.M.open, tr = o && o.kind === "transition";
  return `<button class="btn ic play" data-act="play" ${o ? "" : "disabled"} title="${tr ? "Switch the state" : "Play (space)"}">${icon(mo.running() ? "pause" : "play")}</button><span class="time" data-time="now"></span>`;
}
/** Speed, repeat and isolate: how it is looked at, not part of it. */
export function extras(mo) {
  const M = mo.M;
  return `<button class="btn" data-act="rate" title="Speed while looking">${RATE_TEXT[M.rate]}</button>
    <button class="btn ic${M.loop ? " on" : ""}" data-act="loop" title="Repeat while looking">${icon("loop")}</button>
    <button class="btn ic${M.isolate ? " on" : ""}" data-act="iso" ${M.sel ? "" : "disabled"} title="Show only this element">${icon("iso")}</button>`;
}
/** Undo and put-back, for a header. */
export function edits(mo) {
  return `<button class="btn ic" data-act="undo" ${mo.M.past.length ? "" : "disabled"} title="Undo (mod+Z)">${icon("undo")}</button>
    <button class="btn ic" data-act="discard" ${mo.dirty() ? "" : "disabled"} title="Put back as the page has it">${icon("reset")}</button>`;
}
/** The Keyframes | CSS switch. */
export function viewSwitch(ui) {
  const b = (v, text) => `<button data-act="view" data-v="${v}" class="${ui.view === v ? "on" : ""}">${text}</button>`;
  return `<div class="segm" role="tablist">${b("keys", "Keyframes")}${b("css", "CSS")}</div>`;
}
// ── timing ───────────────────────────────────────────────────────────────────────────────────
/** Fields of how it plays. which: any of duration, delay, easing, count, direction, fill, how. */
export function timingFields(mo, which = ["duration", "delay", "easing"], opts = {}) {
  const t = mo.timing();
  if (!t) return "";
  const ro = mo.readOnly() ? "disabled" : "", u = mo.openUse(), lab = (s) => (opts.labels === false ? "" : `<span>${s}</span>`);
  const count = { ...COUNT, ...(COUNT[t.count] ? {} : { [t.count]: [`${t.count}×`] }) };
  const how = u ? Object.fromEntries(Object.entries(HOW).filter(([k]) => !(u.isNew && k === "asnow")).map(([k, v]) => [k, [v]])) : {};
  // a choice of a few: chips, one click each
  const chips = (key, label, map, cur) => `<div class="tchips"><span>${label}</span><div class="chips" data-tkey="${key}">${Object.entries(map).map(([v, [text, what]]) =>
    `<button class="chip${String(cur) === v ? " on" : ""}" data-act="tset" data-v="${esc(v)}" ${ro} title="${esc(what ? `${what} (${v})` : v)}">${esc(text)}</button>`).join("")}</div></div>`;
  const f = {
    duration: `<label class="tf">${lab("Duration")}<input class="fld num" data-t="duration" value="${Math.round(t.duration)}" inputmode="numeric" ${ro}><span class="unit">ms</span></label>`,
    delay: `<label class="tf">${lab("Delay")}<input class="fld num" data-t="delay" value="${Math.round(t.delay)}" inputmode="numeric" ${ro}><span class="unit">ms</span></label>`,
    easing: `<label class="tf">${lab("Easing")}<input class="fld ease" data-t="easing" list="m-easings" value="${esc(t.easing)}" spellcheck="false" ${ro}>${opts.curve === false ? "" : curve(t.easing)}</label>`,
    count: chips("count", "Repeat", count, t.count),
    direction: chips("direction", "Direction", DIRECTION, t.direction),
    fill: chips("fill", "Fill", FILL, t.fill),
    how: u ? chips("how", "Starts", how, u.plays.how) : "",
  };
  return which.map((w) => f[w]).join("");
}

// ── the selected keyframe ────────────────────────────────────────────────────────────────────
export function keyEditor(mo) {
  const k = mo.keyInfo();
  if (!k) return "";
  const ro = k.ro ? "disabled" : "";
  return `<div class="keyed">
    <input class="fld num" data-k="at" value="${r1(k.at)}" ${ro}><span class="unit">%</span>
    ${k.prop === null ? `<span class="p">${Object.keys(k.f.vals).length} properties</span><span style="flex: 1"></span>`
      : `<span class="p">${esc(k.prop)}</span><input class="fld val" data-k="val" value="${esc(k.value)}" spellcheck="false" autocomplete="off" ${ro}>`}
    ${k.last ? "" : `<input class="fld ease" data-k="ease" list="m-easings" value="${esc(k.ease)}" placeholder="${esc(k.dflt)}" spellcheck="false" ${ro}><button class="btn ic cvb" data-act="kease" ${ro} title="Easing">${curve(k.ease || k.dflt)}</button>`}
    ${ro ? "" : `<button class="btn ic" data-act="rmkey" title="Delete (⌫)">${icon("trash")}</button>`}</div>`;
}

// ── the text ─────────────────────────────────────────────────────────────────────────────────
export function drawCss(el, mo) {
  const area = el.querySelector("textarea");
  if (area && document.activeElement === area) return;
  const ro = !mo.openKf();
  el.innerHTML = `<textarea data-css spellcheck="false" autocomplete="off" ${ro ? "readonly" : ""}>${esc(mo.cssText())}</textarea><div class="err" data-csserr hidden></div>`;
}

// ── a small sheet over everything ────────────────────────────────────────────────────────────
let popEl = null;
export function openPop(anchor, html, place = "above") {
  closePop();
  popEl = document.createElement("div");
  popEl.className = "pop";
  popEl.innerHTML = html;
  document.body.append(popEl);
  const r = anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
  popEl.style.left = `${clamp(r.right - w, 8, innerWidth - w - 8)}px`;
  const above = place === "above" ? r.top - h - 8 >= 8 : r.bottom + 8 + h > innerHeight - 8;
  popEl.style.top = `${clamp(above ? r.top - h - 8 : r.bottom + 8, 8, innerHeight - h - 8)}px`;
  popEl._anchor = anchor;
  return popEl;
}
export function closePop() {
  if (popEl) popEl.remove();
  popEl = null;
}
addEventListener("pointerdown", (e) => popEl && !popEl.contains(e.target) && !(popEl._anchor && popEl._anchor.contains(e.target)) && closePop(), true);

/** The easings to choose from for the selected keyframe, each drawn as its curve. */
export function easeMenu(anchor, mo, place = "below") {
  const k = mo.keyInfo();
  if (!k) return;
  const cur = k.ease || k.dflt;
  const pop = openPop(anchor, `<div class="ez">${[...new Set([cur, ...EASINGS])].map((e) => `<button data-ez="${esc(e)}" class="${e === cur ? "on" : ""}">${curve(e, 22)}${esc(e)}</button>`).join("")}</div>`, place);
  pop.addEventListener("click", (e) => {
    const x = e.target.closest("[data-ez]");
    if (!x) return;
    mo.setKey("ease", x.dataset.ez, true);
    closePop();
  });
}

// ── one listener for all of it ───────────────────────────────────────────────────────────────
/** Clicks on [data-act], fields [data-t] [data-k] [data-addp] [data-css], the list's rows, keys,
 *  and the frame loop. redraw() is the layout's. */
export function wire(mo, ui, redraw, opts = {}) {
  const typingIn = () => {
    const a = document.activeElement;
    return a && /^(INPUT|TEXTAREA)$/.test(a.tagName) ? a : null;
  };
  ui.typingIn = typingIn;
  document.addEventListener("click", (e) => {
    const row = e.target.closest("[data-row]");
    if (row) {
      const r = row.closest("[data-list]")._rows[row.dataset.row];
      if (r && !r.off) {
        r.open();
        ui.reveal(mo.M.sel);
      }
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const M = mo.M, act = b.dataset.act;
    if (act === "play") mo.toggle();
    else if (act === "rate") mo.setRate(RATES[(RATES.indexOf(M.rate) + 1) % RATES.length]);
    else if (act === "loop") mo.setLoop(!M.loop);
    else if (act === "iso") mo.setIsolate(!M.isolate);
    else if (act === "undo") return mo.undo();
    else if (act === "discard") return mo.discard();
    else if (act === "new") return mo.newAnimation();
    else if (act === "rmkey") return mo.removeKey();
    else if (act === "rmlane") return mo.removeLane(b.dataset.prop);
    else if (act === "detach") return mo.detach();
    else if (act === "tset") {
      // a chip: set, and mark it in its row here (it may be in a popover the redraw does not reach)
      const row = b.closest("[data-tkey]");
      mo.setTiming(row.dataset.tkey, b.dataset.v, true);
      for (const c of row.children) c.classList.toggle("on", c === b);
      return;
    }
    else if (act === "view") ui.view = b.dataset.v;
    else if (act === "kease") return easeMenu(b, mo);
    else if (opts.act && opts.act(act, b, e) !== false) return;
    redraw();
  });
  document.addEventListener("pointerover", (e) => {
    const row = e.target.closest && e.target.closest("[data-row]");
    const r = row && row.closest("[data-list]")._rows[row.dataset.row];
    ui.rowEls = r && r.els && r.els.length ? r.els : null;
  });
  const field = (e, done) => {
    const f = e.target;
    if (f.dataset.t !== undefined) {
      const ok = mo.setTiming(f.dataset.t, f.value, done);
      f.classList.toggle("bad", !ok);
      if (ok && !done) redraw("typing");
    } else if (f.dataset.k !== undefined) {
      const ok = mo.setKey(f.dataset.k, f.value, done);
      f.classList.toggle("bad", !ok);
      if (ok && !done) redraw("typing");
    } else if (f.dataset.addp !== undefined && done && f.value.trim()) {
      if (!mo.addLane(f.value)) f.classList.add("bad");
      else focusLater("[data-k=val]");
    }
  };
  document.addEventListener("input", (e) => {
    if (e.target.dataset.css !== undefined) {
      const why = mo.setCss(e.target.value), err = e.target.parentElement.querySelector("[data-csserr]");
      if (err) (err.hidden = !why), (err.textContent = why);
      return redraw("typing");
    }
    field(e, e.target.tagName === "SELECT");
  });
  document.addEventListener("change", (e) => e.target.tagName !== "SELECT" && e.target.dataset.css === undefined && field(e, true));
  document.addEventListener("focusout", (e) => e.target.dataset && e.target.dataset.css !== undefined && mo.commit());

  const onKey = (e) => {
    const t = e.target, typing = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    if (typing) {
      if (e.key === "Escape" || (e.key === "Enter" && t.tagName === "INPUT")) t.blur();
      // Esc in a keyframe's field is done with that keyframe too (and closes its bubble)
      if (e.key === "Escape" && t.dataset.k !== undefined) {
        mo.selectKey(null);
        redraw();
      }
      return;
    }
    if (mod(e) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      return e.shiftKey ? mo.redo() : mo.undo();
    }
    if (mod(e) || e.altKey) return;
    if (e.key === " ") {
      e.preventDefault();
      mo.toggle();
      return redraw();
    }
    if ((e.key === "Delete" || e.key === "Backspace") && mo.M.key && mo.openKf()) return mo.removeKey();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      return mo.seek((mo.position() ?? mo.M.pos) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01));
    }
    if (e.key === "Escape") {
      closePop();
      if (mo.M.key) {
        mo.selectKey(null);
        redraw();
      } else mo.select(null);
    }
  };
  addEventListener("keydown", onKey);
  mo.onPageKey(onKey);

  // the lists a field offers
  const dl = document.createElement("div");
  dl.innerHTML = `<datalist id="m-easings">${EASINGS.map((x) => `<option value="${x}">`).join("")}</datalist><datalist id="m-props">${PROPS.map((x) => `<option value="${x}">`).join("")}</datalist>`;
  document.body.append(dl);

  // every frame: the playhead, the time, the play button, the outlines
  let playing = null;
  const place = (box, el) => {
    if (!el || !el.isConnected) return void (box.hidden = true);
    const r = el.getBoundingClientRect();
    box.hidden = false;
    box.style.transform = `translate(${r.left - 3}px, ${r.top - 3}px)`;
    box.style.width = `${r.width + 6}px`;
    box.style.height = `${r.height + 6}px`;
  };
  (function tick() {
    requestAnimationFrame(tick);
    if (!mo.doc) return;
    mo.frame();
    const p = mo.position(), total = mo.total(), run = mo.running();
    for (const el of document.querySelectorAll("[data-time]")) {
      const now = p === null ? 0 : Math.round(p * total);
      const text = !mo.M.open ? "" : `${now}`;
      if (el._t !== text) el.textContent = el._t = text;
    }
    const tr = mo.M.open && mo.M.open.kind === "transition" ? mo.M.ro.on : null;
    const state = `${run}|${tr}`;
    if (playing !== state) {
      playing = state;
      for (const b of document.querySelectorAll("[data-act=play]")) {
        b.innerHTML = icon(run ? "pause" : "play");
        b.classList.toggle("on", !!tr);
      }
    }
    // The selection stays marked while it plays, by its corners only, so the motion is not covered.
    place(ui.boxes[1], mo.M.sel);
    ui.boxes[1].classList.toggle("run", run);
    place(ui.boxes[0], mo.M.hover && mo.M.hover !== mo.M.sel ? mo.M.hover : null);
    // its name, on a tag over its top left corner (under it when there is no room above)
    const sel = mo.M.sel, tag = ui.tag;
    if (!sel || !sel.isConnected) tag.hidden = true;
    else {
      const text = mo.label(sel);
      if (tag._t !== text) tag.textContent = tag._t = text;
      const r = sel.getBoundingClientRect();
      tag.hidden = false;
      tag.style.transform = `translate(${Math.max(0, r.left - 3)}px, ${r.top - 3 - 20 >= 0 ? r.top - 3 - 20 : r.bottom + 5}px)`;
    }
    // the elements of the list row under the pointer
    const want = ui.rowEls ? ui.rowEls.filter((x) => x !== sel) : [];
    while (ui.rowBoxes.children.length < want.length) ui.rowBoxes.insertAdjacentHTML("beforeend", '<div class="box row"></div>');
    [...ui.rowBoxes.children].forEach((b, i) => place(b, want[i] || null));
    if (opts.frame) opts.frame(p, total, run);
  })();
}
