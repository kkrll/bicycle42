// ── "This page on this phone": the facts the host's pane shows ──────────────────────────────────
// A pane of the host's beside a phone's page, in a mode with no dock (Preview, Annotate): what the
// page is at the size it is shown at, each fact tied to its element (FactsView in
// ../../protocol-facts.ts). The layer draws no pane of its own for it; it works the facts out and
// does what the host's pane asks (FactsAct): outline an element, bring it into view, make it a
// note's selection.
//
// Nothing is worked out unless the pane asks: between its "view" and its "stop" (or the pane no
// longer hosted, or a new document) the page is looked at after it loads, when the window
// resizes, and after it changed, at least SPACING ms apart and in idle time, MAX_ELS elements at
// most. Scrolling only sends the new `scrollY`, at most once a frame (sendView). Review on or
// off: the outline is the layer's (render.js asks `boxes`), the rest is reading the page.

import { S } from "../state.js";
import { line } from "../page.js";
import { hosted, onAct, onHosted, sendView } from "../panel.js";
import { kick } from "../render.js";
import { hostEl } from "../mount.js";
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
  hover: null, // the element outlined for the pane's row under the pointer
  flash: null, flashUntil: 0, flashTimer: 0, // the element shown ("show"), and until when
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
        taps.push(item(el, `${Math.round(r.width)} x ${Math.round(r.height)}`));
      const tag = el.tagName;
      if ((tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && TEXT_TYPES.has((el.getAttribute("type") || "").toLowerCase()))) && parseFloat(cs.fontSize) < ZOOM_PX - 0.01)
        small.push(item(el, `${Math.round(parseFloat(cs.fontSize) * 10) / 10}px`));
    }
    // An element that stops what is inside it from widening the page.
    const clips = clipped || fixed || (cs.overflowX !== "visible" && !out);
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") continue; // (an svg's inside is its drawing)
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], clips, out]);
  }
  wide.sort((a, b) => b[1] - a[1]);
  F.view = {
    viewport: { w: vw, h: window.innerHeight },
    doc: { w: Math.max(de.scrollWidth, document.body.scrollWidth), h: Math.max(de.scrollHeight, document.body.scrollHeight) },
    scrollY: Math.round(window.scrollY),
    meta: !!document.querySelector('meta[name="viewport" i]'),
    partial,
    wide: list(wide.map(([el, px]) => item(el, `+${px} px`)), MAX.wide),
    taps: list(taps, MAX.taps),
    small: list(small, MAX.small),
  };
  sendView("facts", F.view);
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
const ours = (r) => r.target === hostEl || (r.type === "attributes" && /^data-b42/.test(r.attributeName || ""));
const onMutations = (records) => records.some((r) => !ours(r)) && later();
const onScroll = () => {
  if (F.hover || F.flash) kick(); // the outline follows
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
  window.addEventListener("scroll", onScroll, { passive: true });
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
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("load", later);
  outline(null);
  if (was) sendView("facts", null);
}

// ── the outline ────────────────────────────────────────────────────────────────────────────
function outline(el) {
  if (el === F.hover) return;
  F.hover = el;
  kick();
}

/** The layer's outlines for the pane (render.js): the row under the pointer, the one just shown. */
export function boxes(capturing) {
  if (capturing || (!F.hover && !F.flash)) return null;
  const out = [];
  const flashing = F.flash && F.flash.isConnected && performance.now() < F.flashUntil ? F.flash : null;
  if (!flashing) F.flash = null;
  for (const [el, cls] of [[flashing, "fx flash"], [F.hover !== flashing ? F.hover : null, "fx"]]) {
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width || r.height) out.push([{ x: r.left, y: r.top, w: r.width, h: r.height }, cls]);
  }
  return out;
}

function show(el) {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  F.flash = el;
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

// ── what the host's pane asks ───────────────────────────────────────────────────────────────
function act(a) {
  if (!a || typeof a !== "object") return;
  switch (a.type) {
    case "view":
      return start();
    case "stop":
      return stop();
    case "refresh":
      if (!F.want) return;
      stopLooking();
      return scan();
    case "hover":
      return outline(a.id === null || a.id === undefined ? null : elOfId(a.id));
    case "show": {
      const el = elOfId(a.id);
      return el && show(el);
    }
    case "note": {
      const el = elOfId(a.id);
      return el && note(el);
    }
  }
}
onAct("facts", act);

// A document starts with its pane not hosted; once it is, the host is told nothing is being
// worked out (a view of null), and a host whose pane is up asks again ("view"). Given back, the
// pane stops.
onHosted("facts", () => {
  if (!hosted("facts")) return stop();
  if (!F.want) sendView("facts", null);
});
