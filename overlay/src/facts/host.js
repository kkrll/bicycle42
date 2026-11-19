// ── "This page on this phone": the facts the host's pane shows ──────────────────────────────────
// A pane of the host's beside a phone's page, in a mode with no dock (Preview, Annotate): what the
// page is at the size it is shown at, each fact tied to its element (FactsView in
// ../../protocol-facts.ts). The layer draws no pane of its own for it; it works the facts out and
// does what the host's pane asks (FactsAct): mark every listed element on the page, or one kind
// of them, outline one more strongly, bring it into view, make it a note's selection. Only the
// facts pane asks (Preview, Annotate): beside Edit's and Motion's docks nothing is worked out.
//
// Nothing is worked out unless the pane asks: between its "view" and its "stop" (or the pane no
// longer hosted, or a new document) the page is looked at after it loads, when the window
// resizes, and after it changed, at least SPACING ms apart and in idle time, MAX_ELS elements at
// most. Scrolling only sends the new `scrollY`, at most once a frame (sendView). Review on or
// off: the outlines are the layer's (render.js asks `boxes`), the rest is reading the page.
// An outline of an element that scrolls with the document is drawn in the layer that does too
// (b42-marks): the compositor moves it with the page, in the same frame. One in a scroller of its
// own, or fixed or sticky, is placed in the window every frame, as the other outlines are.
// A change the layer makes itself counts too when it is to the page's elements (canvas mode's
// edits: adopted rules no observer sees, so they say so, onRestyle).

import { S } from "../state.js";
import { line, onRestyle } from "../page.js";
import { hosted, onAct, onHosted, sendView } from "../panel.js";
import { kick } from "../render.js";
import { docHost, hostEl } from "../mount.js";
import { modeOn } from "../mode.js";
import { openCard } from "../notes/card.js";

/** The page is looked at again no sooner than this after the last look (ms). */
const SPACING = 400;
/** Elements looked at in one scan; a page with more says the scan was partial. */
const MAX_ELS = 4000;
/** A finger's size, CSS px (Apple's 44 pt). */
const TAP = 44;
/** Text a phone zooms into when its field takes focus (iOS: under 16 px). */
const ZOOM_PX = 16;
const MAX = { wide: 8, taps: 12, small: 8 };
const FLASH_MS = 1400;

/** Interactive elements: what a finger taps. */
const TAPPABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=combobox],[role=slider],[role=spinbutton]";
/** Fields whose text size decides whether iOS zooms. */
const TEXT_TYPES = new Set(["", "text", "email", "search", "tel", "url", "password", "number", "date", "datetime-local", "month", "time", "week"]);

const F = {
  want: false, // the host's pane is shown
  view: null, // the last view made
  timer: 0, idle: 0, last: -Infinity, // the next look, and when the last one was
  obs: null, // the MutationObserver while wanted
  marks: false, // every listed element is marked on the page (the host's pane asks: "marks")
  kinds: new Map(), // the id of each listed element → its kind ("wide" | "taps" | "small")
  hover: null, hoverKind: "", // the element outlined for the pane's row under the pointer
  kind: "", // the kind whose elements are marked while the pointer is on its count ("kind")
  anchored: new Map(), // a listed element → it scrolls with the document (looked at once a look)
  flash: null, flashKind: "", flashUntil: 0, flashTimer: 0, // the element shown ("show"), and until when
  ids: new WeakMap(), els: new Map(), n: 0, // element ↔ the number the host names it by
};

function idOf(el) {
  let id = F.ids.get(el);
  if (!id) {
    F.ids.set(el, (id = ++F.n));
    F.els.set(id, new WeakRef(el));
    if (F.els.size > 5000) for (const [k, r] of F.els) if (!r.deref()?.isConnected) F.els.delete(k);
  }
  return id;
}
const elOfId = (id) => {
  const el = F.els.get(Number(id))?.deref();
  return el && el.isConnected ? el : null;
};

// ── what an element is called ───────────────────────────────────────────────────────────────
/** Its own words when they are few (a field's label, placeholder or value stand in), else tag.class. */
function labelOf(el) {
  const tag = el.tagName.toLowerCase();
  let text = el.getAttribute("aria-label") || "";
  if (!text && (tag === "input" || tag === "textarea")) text = el.getAttribute("placeholder") || (el.type === "submit" || el.type === "button" ? el.value : "") || "";
  if (!text && tag === "select") text = el.selectedOptions?.[0]?.text || "";
  if (!text && tag !== "input" && tag !== "textarea" && tag !== "select") text = el.textContent || "";
  if (!text) text = el.getAttribute("title") || el.querySelector?.("img[alt]")?.getAttribute("alt") || "";
  text = line(text);
  if (text && text.length <= 32) return text;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  const name = cls ? `${tag}.${cls}` : el.id ? `${tag}#${el.id}` : tag;
  return text && name === tag ? `${text.slice(0, 31)}…` : name;
}

const item = (el, detail) => ({ id: idOf(el), label: labelOf(el), detail });
const list = (all, max) => ({ items: all.slice(0, max), total: all.length });

// ── the look ────────────────────────────────────────────────────────────────────────────────
/** Shown at all: has a box, and is not hidden by visibility, opacity or content-visibility. */
const shown = (el, r) => r.width > 0 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));

/** A link inside a sentence: shown inline, with other words around it in its block. A finger
 *  can not be given 44 px there without breaking the text (WCAG 2.5.8 leaves it out too). */
function inSentence(el, cs) {
  if (cs.display !== "inline") return false;
  let block = el.parentElement;
  while (block && getComputedStyle(block).display === "inline") block = block.parentElement;
  if (!block) return false;
  const own = line(el.textContent).length;
  return line(block.textContent).length > own + 8;
}

/** What sticks out, what is too small to tap, what zooms: one walk of the document. */
function scan() {
  F.idle = 0;
  F.last = performance.now();
  if (!F.want || !document.body) return;
  const de = document.documentElement;
  const vw = de.clientWidth, sx = window.scrollX;
  /** @type {[Element, number][]} */
  const wide = [];
  const taps = [], small = [];
  let seen = 0, partial = false;
  // Depth first, with what the boxes above say: an element clipped by a box that fits (its
  // overflow is not visible) widens nothing; one whose parent already sticks out is that
  // parent's overflow, not a new one.
  /** @type {[Element, boolean, boolean][]} */
  const stack = [[document.body, false, false]];
  while (stack.length) {
    const [el, clipped, parentOut] = /** @type {[Element, boolean, boolean]} */ (stack.pop());
    if (el === hostEl) continue;
    if (++seen > MAX_ELS) {
      partial = true;
      break;
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const fixed = cs.position === "fixed";
    const out = !clipped && !fixed && r.width > 0 && r.right + sx > vw + 1;
    if (out && !parentOut) wide.push([el, Math.round(r.right + sx - vw)]);
    if (el.matches(TAPPABLE) && shown(el, r)) {
      if ((r.width < TAP - 0.5 || r.height < TAP - 0.5) && !((el.tagName === "A" || el.getAttribute("role") === "link") && inSentence(el, cs)))
        taps.push(item(el, `${Math.round(r.width)} × ${Math.round(r.height)}`));
      const tag = el.tagName;
      if ((tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && TEXT_TYPES.has((el.getAttribute("type") || "").toLowerCase()))) && parseFloat(cs.fontSize) < ZOOM_PX - 0.01)
        small.push(item(el, `${Math.round(parseFloat(cs.fontSize) * 10) / 10} px`));
    }
    // An element that stops what is inside it from widening the page.
    const clips = clipped || fixed || (cs.overflowX !== "visible" && !out);
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") continue; // (an svg's inside is its drawing)
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], clips, out]);
  }
  wide.sort((a, b) => b[1] - a[1]);
  const lists = {
    wide: list(wide.map(([el, px]) => item(el, `+${px} px`)), MAX.wide),
    taps: list(taps, MAX.taps),
    small: list(small, MAX.small),
  };
  F.kinds = new Map();
  for (const k of /** @type {const} */ (["wide", "taps", "small"])) for (const it of lists[k].items) if (!F.kinds.has(it.id)) F.kinds.set(it.id, k);
  F.view = {
    viewport: { w: vw, h: window.innerHeight },
    doc: { w: Math.max(de.scrollWidth, document.body.scrollWidth), h: Math.max(de.scrollHeight, document.body.scrollHeight) },
    scrollY: Math.round(window.scrollY),
    meta: !!document.querySelector('meta[name="viewport" i]'),
    partial,
    marks: F.marks,
    ...lists,
  };
  F.anchored = new Map();
  sendView("facts", F.view);
  if (F.marks) kick(); // (the marks are where the elements are now)
}

/** Look again soon: SPACING after the last look at the earliest, when the page is idle. */
function later() {
  if (!F.want || F.timer || F.idle) return;
  F.timer = setTimeout(() => {
    F.timer = 0;
    F.idle = window.requestIdleCallback ? requestIdleCallback(scan, { timeout: 1000 }) : setTimeout(scan, 0);
  }, Math.max(50, F.last + SPACING - performance.now()));
}

function stopLooking() {
  clearTimeout(F.timer);
  if (F.idle) (window.cancelIdleCallback || clearTimeout)(F.idle);
  F.timer = F.idle = 0;
}

// A change of the layer's own (its element, the attributes it sets on the page's root) is no
// change of the page's.
const ours = (r) => r.target === hostEl || (r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every((n) => n === hostEl || n === docHost)) || (r.type === "attributes" && /^data-b42/.test(r.attributeName || ""));
const onMutations = (records) => records.some((r) => !ours(r)) && later();
const onRestyled = () => F.want && later();
const onScroll = (/** @type {Event} */ e) => {
  if (F.hover || F.flash || F.marks || F.kind) kick(); // the outlines in the window follow (a scroller's too)
  if (e.target !== document) return;
  if (!F.view) return;
  const y = Math.round(window.scrollY);
  if (y === F.view.scrollY) return;
  F.view = { ...F.view, scrollY: y };
  sendView("facts", F.view);
};

function start() {
  if (F.want) return later();
  F.want = true;
  F.obs = new MutationObserver(onMutations);
  F.obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  window.addEventListener("resize", later, { passive: true });
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  if (document.readyState !== "complete") window.addEventListener("load", later, { once: true });
  // The first look at once (the pane is waiting for it), the next ones spaced.
  F.last = -Infinity;
  stopLooking();
  scan();
}

function stop() {
  const was = F.want;
  F.want = false;
  F.view = null;
  stopLooking();
  F.obs?.disconnect();
  F.obs = null;
  window.removeEventListener("resize", later);
  window.removeEventListener("scroll", onScroll, { capture: true });
  window.removeEventListener("load", later);
  F.kinds = new Map();
  F.anchored = new Map();
  F.kind = "";
  outline(null);
  if (was) sendView("facts", null);
}

// ── where an outline is drawn ───────────────────────────────────────────────────────────────
const fixedPos = (cs) => cs.position === "fixed" || cs.position === "sticky";
/** The element moves with the document's scroll and nothing else: neither it nor a box it is in
 *  is fixed or sticky or scrolls (or clips) on its own. Its outline can then be drawn in the layer
 *  that scrolls with the document. (The body counts as a scroller only when the root's overflow
 *  is not visible: else the body's overflow is the window's.) */
function anchored(el) {
  let a = F.anchored.get(el);
  if (a !== undefined) return a;
  a = !fixedPos(getComputedStyle(el));
  const de = document.documentElement;
  const rootClips = getComputedStyle(de).overflow !== "visible";
  for (let n = el.parentElement; a && n && n !== de; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (fixedPos(cs) || ((n !== document.body || rootClips) && (cs.overflowX !== "visible" || cs.overflowY !== "visible"))) a = false;
  }
  if (F.anchored.size > 200) F.anchored.clear();
  F.anchored.set(el, a);
  return a;
}

// ── the outline ────────────────────────────────────────────────────────────────────────────
function outline(el, kind = "") {
  if (el === F.hover) return;
  F.hover = el;
  F.hoverKind = kind;
  kick();
}

/** The layer's outlines for the pane (render.js): with marks on, a quiet one on each listed
 *  element in its kind's tone (`fx mk k-taps`); while the pointer is on a kind's count, that
 *  kind's, marks on or off (`fx mk lit k-taps`); the row under the pointer and the one just shown,
 *  strong (`fx k-taps`, `fx flash k-taps`). None in a note's screenshot. Each is [rect in the
 *  window, class, whether it scrolls with the document (`anchored`)]. */
export function boxes(capturing) {
  const marking = F.marks && F.want && F.view;
  if (capturing || (!F.hover && !F.flash && !marking && !F.kind)) return null;
  const out = [];
  const flashing = F.flash && F.flash.isConnected && performance.now() < F.flashUntil ? F.flash : null;
  if (!flashing) F.flash = null;
  const put = (el, cls) => {
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.width || r.height) out.push([{ x: r.left, y: r.top, w: r.width, h: r.height }, cls, anchored(el)]);
  };
  if (marking || F.kind)
    for (const [id, k] of F.kinds) {
      const lit = k === F.kind;
      if (!lit && !marking) continue;
      const el = elOfId(id);
      if (el && el !== F.hover && el !== flashing) put(el, lit ? `fx mk lit k-${k}` : `fx mk k-${k}`);
    }
  const kindOf = (el) => {
    const k = el === F.hover ? F.hoverKind : F.flashKind;
    return k ? ` k-${k}` : "";
  };
  if (flashing) put(flashing, `fx flash${kindOf(flashing)}`);
  if (F.hover && F.hover !== flashing) put(F.hover, `fx${kindOf(F.hover)}`);
  return out;
}

function show(el, kind = "") {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  F.flash = el;
  F.flashKind = kind;
  F.flashUntil = performance.now() + FLASH_MS;
  clearTimeout(F.flashTimer);
  F.flashTimer = setTimeout(kick, FLASH_MS + 20); // the flash's end: drawn without it
  kick();
}

/** As a click on it in notes mode: the element is the note's selection and the card opens. */
function note(el) {
  if (!S.enabled || modeOn() !== "notes" || S.pending || S.drag) return;
  el.scrollIntoView({ block: "center", inline: "nearest" });
  outline(null);
  S.sel = [el];
  S.area = null;
  openCard();
}

/** Marks on or off: drawn (or taken away) at once, and the view says which. */
function setMarks(on) {
  if (on === F.marks) return;
  F.marks = on;
  kick();
  if (F.want && F.view) sendView("facts", (F.view = { ...F.view, marks: on }));
}

// ── what the host's pane asks ───────────────────────────────────────────────────────────────
function act(a) {
  if (!a || typeof a !== "object") return;
  switch (a.type) {
    case "view":
      if (typeof a.marks === "boolean") setMarks(a.marks);
      return start();
    case "marks":
      return setMarks(!!a.on);
    case "stop":
      return stop();
    case "refresh":
      if (!F.want) return;
      stopLooking();
      return scan();
    case "kind": {
      const k = a.kind === "wide" || a.kind === "taps" || a.kind === "small" ? a.kind : "";
      if (k === F.kind) return;
      F.kind = k;
      return kick();
    }
    case "hover":
      return a.id === null || a.id === undefined ? outline(null) : outline(elOfId(a.id), F.kinds.get(Number(a.id)) || "");
    case "show": {
      const el = elOfId(a.id);
      return el && show(el, F.kinds.get(Number(a.id)) || "");
    }
    case "note": {
      const el = elOfId(a.id);
      return el && note(el);
    }
  }
}
onAct("facts", act);
onRestyle(onRestyled);

// A document starts with its pane not hosted; once it is, the host is told nothing is being
// worked out (a view of null), and a host whose pane is up asks again ("view"). Given back, the
// pane stops.
onHosted("facts", () => {
  if (!hosted("facts")) return stop();
  if (!F.want) sendView("facts", null);
});
