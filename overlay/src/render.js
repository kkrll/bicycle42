// ── render ──────────────────────────────────────────────────────────────────────────────────

import { S, send } from "./state.js";
import { findPin, readView, rectOf, toView, VP } from "./page.js";
import * as Notes from "./notes/api.js";
import { drawVariants } from "./variants.js";
import { drawDevice } from "./device.js";
import { hideTip, makePin } from "./sent.js";
import * as Canvas from "./canvas/api.js";
import * as Motion from "./motion/api.js";
import { boxes as factBoxes } from "./facts/host.js";
import { boxes, docBoxes, docHost, domVersion, pinsEl, root } from "./mount.js";

export function pool(container, n, make) {
  while (container.children.length < n) container.appendChild(make());
  while (container.children.length > n) container.lastChild.remove();
  return [...container.children];
}

/** An outline: a fill and four edge strips in a box that paints nothing (styles.css says why). */
function makeBox() {
  const div = document.createElement("div");
  div.innerHTML = `<i class="fill"></i><i class="et"></i><i class="er"></i><i class="eb"></i><i class="el"></i>`;
  return div;
}

/** `end`: the box is in the document's own layer, and this is where the page ends ({ x, y } in
 *  the layer's coordinates). What reaches past the page's last element there makes the page
 *  larger, so an edge at the page's end goes to the device pixel inside the element, not to the
 *  nearest: half a pixel out, at 1.5x or 2x, was one more pixel of the page to scroll, and a page
 *  the facts called a pixel wider than it is. */
function placeBox(div, r, cls, dpr, end = null) {
  // Most frames an outline has not moved: nothing is written then (no restyle for an idle selection).
  const k = `${cls}|${r.x}|${r.y}|${r.w}|${r.h}|${dpr}`;
  if (div._k === k) return;
  div._k = k;
  if (div._cls !== cls) div.className = `box ${(div._cls = cls)}`;
  // Its edges on whole device pixels: a strip that starts part of a pixel in is drawn blurred
  // over two (one bordered box was snapped as a whole).
  const near = (v) => Math.round(v * dpr) / dpr;
  // (Within two pixels of the end: the end as read may be a mark's that was a pixel out. A
  // hundredth of a device pixel is the arithmetic's, not the element's.)
  const far = (v, last) => (last !== undefined && v > last - 2 && near(v) > v ? Math.floor(v * dpr + 0.01) / dpr : near(v));
  const x = near(r.x), y = near(r.y);
  const w = Math.max(0, far(r.x + r.w, end?.x) - x), h = Math.max(0, far(r.y + r.h, end?.y) - y);
  div.style.transform = `translate(${x}px, ${y}px)`;
  div.style.width = `${w}px`;
  div.style.height = `${h}px`;
  // The fill is a 100 px square: scaled, never resized.
  /** @type {HTMLElement} */ (div.firstChild).style.transform = `scale(${w / 100}, ${h / 100})`;
}

/** Where a pin sits: the top-left of the element, or of its text when it holds only text
 *  (a full-width heading would otherwise put the pin at the page edge, far from the words). */
let pinRange = null;
function pinPoint(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  if (el.childElementCount === 0 && el.textContent.trim()) {
    // One Range for all pins and frames: every live Range has to be kept up to date by the
    // browser on each DOM change, so a new one per pin per frame makes the page's own writes slow.
    const range = pinRange || (pinRange = document.createRange());
    range.selectNodeContents(el);
    const t = range.getBoundingClientRect();
    range.setStart(document, 0);
    range.collapse(true);
    if (t.width > 0) return [t.left - 12, t.top - 6];
  }
  // Just outside the top-left corner, so the pin marks the element without covering it.
  return [r.left - 8, r.top - 8];
}

// A pin keeps its place on the page, not in the window: while the document scrolls it is moved
// by the scroll and not measured (each measure is a rect or two and a Range's). It is measured
// again after a DOM change, a resize, a scroll of something inside the page (that moves what is
// in it, and not the document), and at least every PIN_MEASURE_MS for what none of those report
// (a style or a class changed, a CSS animation, an image that loaded). A pin in a fixed or sticky
// box moves on the page as the document scrolls: it is measured every frame.
const PIN_MEASURE_MS = 250;
const FIXED_CHECK_MS = 1000;
let innerScrolls = 0;
let watchingScrolls = false;
const onScroll = (/** @type {Event} */ e) => {
  if (e.target !== document) innerScrolls++;
};

/** Whether el, or a box it is in, is fixed or sticky: then where it is on the page is not where it
 *  stays. Only el and its offset parents are looked at: a fixed or sticky box is positioned, so
 *  any that el is in is one of them (the style of every ancestor of 200 pins is too much to read
 *  four times a second). */
function inFixed(el) {
  for (let n = el; n; n = "offsetParent" in n ? n.offsetParent : n.parentElement) { // (an svg element has none)
    const pos = getComputedStyle(n).position;
    if (pos === "fixed" || pos === "sticky") return true;
  }
  return false;
}

/** Where a found pin is in the window this frame: measured, or moved by the scroll since it was. */
function pinAt(p, now) {
  let m = p.measured;
  const changed = !m || m.el !== p.el || m.dom !== domVersion || m.w !== VP.w || m.h !== VP.h;
  if (changed || m.fixed || m.scrolls !== innerScrolls || now - m.t >= PIN_MEASURE_MS) {
    const at = pinPoint(p.el);
    // Whether it is fixed is looked at again after a change to the page, or once a second (a
    // class that makes a box sticky is not a DOM change); not with every measure.
    const check = changed || !m.at || now - m.ft >= FIXED_CHECK_MS;
    const fixed = !!at && (check ? inFixed(p.el) : m.fixed);
    m = p.measured = { el: p.el, at: at && !fixed ? [at[0] + VP.sx, at[1] + VP.sy] : at, fixed, ft: check ? now : m.ft,
      dom: domVersion, scrolls: innerScrolls, w: VP.w, h: VP.h, t: now };
  }
  return m.at && (m.fixed ? m.at : [m.at[0] - VP.sx, m.at[1] - VP.sy]);
}

/** The layer that scrolls with the document: put in it the first time it has outlines to show
 *  (`want`), emptied when it has none (the facts pane's "stop" takes it out: facts/host.js), so a
 *  row pointed at and left is no change to the page's tree. Where its origin is in the window
 *  now, or null when it shows nothing. */
function docLayer(want) {
  if (!want) {
    if (docBoxes.firstChild) pool(docBoxes, 0, makeBox);
    return null;
  }
  if (docHost.parentNode !== document.documentElement) document.documentElement.appendChild(docHost);
  const o = docHost.getBoundingClientRect();
  return { x: o.left, y: o.top };
}

export function render() {
  if (!root) return;
  readView();
  // A batch hidden for the host's "before" picture counts as a capture: no chrome in that picture.
  const capturing = !!S.pending || Canvas.hiding();
  drawDevice(capturing);
  drawVariants(capturing);
  const canvasBoxes = Canvas.frame(capturing);
  const motionBoxes = Motion.frame(capturing);

  // boxes: hover, the note's outlines (in its screenshot, whichever mode made it), canvas,
  // motion, and the host's facts pane (review on or off)
  const items = Notes.outlines(capturing);
  if (S.enabled || capturing) for (const el of S.sel) if (el.isConnected) items.push([rectOf(el), "sel"]);
  if (canvasBoxes) items.push(...canvasBoxes);
  if (motionBoxes) items.push(...motionBoxes);
  // The facts pane's outlines of elements that scroll with the document go in the layer that
  // scrolls with it (they do not trail a scroll by a frame); those in a scroller of their own, or
  // fixed or sticky, are placed in the window with the rest, every frame they move.
  const facts = factBoxes(capturing);
  const onDoc = [];
  if (facts) for (const f of facts) (f[2] ? onDoc : items).push(f);
  const origin = docLayer(onDoc.length > 0);
  const dpr = window.devicePixelRatio || 1;
  if (boxes._dpr !== dpr) boxes.style.setProperty("--dp", `${1 / (boxes._dpr = dpr)}px`);
  const divs = pool(boxes, items.length, makeBox);
  items.forEach(([r, cls], i) => placeBox(divs[i], r, cls, dpr));
  if (origin) {
    if (docBoxes._dpr !== dpr) docBoxes.style.setProperty("--dp", `${1 / (docBoxes._dpr = dpr)}px`);
    const docDivs = pool(docBoxes, onDoc.length, makeBox);
    const de = document.documentElement;
    const end = { x: de.scrollWidth, y: de.scrollHeight };
    onDoc.forEach(([r, cls], i) => placeBox(docDivs[i], { x: r.x - origin.x, y: r.y - origin.y, w: r.w, h: r.h }, cls, dpr, end));
  }

  // notes mode's ink and card: after the boxes are written (notes/frame.js says why)
  Notes.frame(capturing);

  const now = performance.now();
  Canvas.readPathsIfDue(now);
  pins(capturing, now, dpr);
}

/** The pins: drawn in Annotate, Edit and Motion; Preview is the page alone, so with review off
 *  there are none, nothing is looked for or measured, and where they are is not told again (the
 *  host keeps what it was last told). */
function pins(capturing, now, dpr) {
  if (!S.enabled) {
    if (pinsEl.firstChild) pool(pinsEl, 0, makePin);
    hideTip();
    if (watchingScrolls) {
      watchingScrolls = false;
      window.removeEventListener("scroll", onScroll, { capture: true });
      innerScrolls++; // (a scroll inside the page while unwatched: every pin is measured again)
    }
    return;
  }
  const visible = [];
  const unplaced = [];
  if (S.pins.length && !watchingScrolls) {
    watchingScrolls = true;
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  }
  for (const p of S.pins) {
    let at = null;
    let approx = false;
    if (p.selector || p.text) {
      // Search again only after the DOM changed (a text search is too heavy for every frame).
      // The first search after an element goes is immediate, and so is the next (a re-render
      // often removes and adds in two steps); a pin that stays missing on a page that keeps
      // changing is then looked for less and less often, down to once a second.
      if ((!p.el || !p.el.isConnected) && p.searched !== domVersion && now >= (p.retryAt || 0)) {
        p.searched = domVersion;
        p.el = findPin(p);
        p.misses = p.el ? 0 : (p.misses || 0) + 1;
        p.retryAt = p.misses > 1 ? now + Math.min(1000, 16 * 2 ** (p.misses - 1)) : 0;
      }
      if (p.el && p.el.isConnected) at = pinAt(p, now);
    }
    if (!at && p.at) {
      at = toView(p.at);
      approx = !!(p.selector || p.text);
    }
    if (!at || approx) unplaced.push(p.id);
    if (at && !capturing) visible.push([p, at, approx]);
  }
  const pinEls = pool(pinsEl, visible.length, makePin);
  if (!visible.length) hideTip();
  visible.forEach(([p, [x, y], approx], i) => {
    const el = pinEls[i];
    el._pin = p;
    // On whole device pixels: a pin is a layer, drawn once and then moved, and a layer moved by
    // part of a pixel is shown blurred.
    const cx = Math.round(Math.min(Math.max(10, x), VP.w - 10) * dpr) / dpr;
    const cy = Math.round(Math.min(Math.max(10, y), VP.h - 10) * dpr) / dpr;
    // Most frames nothing moved: don't touch the DOM for a pin that looks the same.
    const drawn = `${p.n}|${p.status}|${p.lane}|${approx}|${cx}|${cy}`;
    if (el._drawn === drawn) return;
    el._drawn = drawn;
    // While the page scrolls only the place changes: the class and the number are left alone.
    const cls = `pin ${p.status || "queued"}${p.lane === "bg" ? " bg" : ""}${approx ? " approx" : ""}`;
    const num = String(p.n ?? "");
    if (el._cls !== cls) el.className = el._cls = cls;
    if (el._num !== num) el.textContent = el._num = num;
    el.style.transform = `translate(${cx}px, ${cy}px)`;
  });
  const key = unplaced.join(",");
  if (key !== S.unplaced) {
    S.unplaced = key;
    send({ type: "pins-placement", unplaced });
  }
}

// Draw every frame only while the reviewer is doing something, for half a second after the page
// changed or scrolled (outlines must follow the layout as it moves), during a capture or a drag,
// and while what is selected is being animated. A selection or a note that only sits there is
// no reason: then the layer redraws on the slow tick, which covers what nothing reports (late
// images, a style the page's script set), so it costs a few redraws a second, not sixty. With
// review off nothing is drawn at all, pins or not: input, scroll and DOM changes ask for nothing.
const IDLE_TICK_MS = 250;
const ACTIVE_MS = 500;
let idleTimer = 0;
let lastInput = 0;
let raf = 0; // the frame asked for, 0 when none is
export function active() {
  // With review off, input asks for nothing (and there are no pins: Preview draws none).
  if (!S.enabled) return;
  lastInput = performance.now();
  kick();
}
/** The page changed or scrolled under the layer. With review on, as input does: frames for the
 *  next half second. With review off, nothing (no pins are drawn then). */
export function moved() {
  if (S.enabled) active();
}
/** A CSS animation or transition (or one the page's script started) is running on one of the
 *  elements, on an ancestor of one or inside one (a panel opening in a selected card resizes
 *  the card): its outline has to follow it every frame. One list for
 *  the whole document, read only when nothing else keeps the frames going. */
export function animating(els) {
  if (!els.some((el) => el && el.isConnected)) return false;
  for (const a of document.getAnimations()) {
    const t = a.playState === "running" && a.effect && /** @type {KeyframeEffect} */ (a.effect).target;
    if (t && els.some((el) => el && (t.contains(el) || el.contains(t)))) return true;
  }
  return false;
}
function frame() {
  raf = 0;
  render();
  // Through kick(): something in render() may have asked for the next frame already, and a
  // second request here would start a second chain (two renders a frame until the selection goes).
  if (S.drag || S.pending || Canvas.busyFrames() || Motion.busyFrames() || performance.now() - lastInput < ACTIVE_MS || (S.enabled && animating(S.sel)))
    kick();
  else if (S.enabled && !idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      kick();
    }, IDLE_TICK_MS);
}

export function kick() {
  if (!raf && root) raf = requestAnimationFrame(frame);
}

