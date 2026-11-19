// Notes mode, drawn: the hover outline, the ink (strokes and areas, the drag's live one) and the
// card's place, one frame at a time. render.js calls these; the outlines of S.sel are its own.

import { S, SVG } from "../state.js";
import { bboxOf, rectOf, union, VP } from "../page.js";
import { placeCard, strokeBox } from "./card.js";
import { ink, pencil, strokesEl } from "./mount.js";
import { modeOn } from "../mode.js";
import { pool } from "../render.js";

// ── ink ─────────────────────────────────────────────────────────────────────────────────────
// Pencil strokes: noise nudges the edge, and a fine paper grain cuts small breaks into the line
// (alpha = 4.4·grain − 1.3), like graphite on paper. Picked in harness/strokes.html.
const PENCIL = `<filter id="b42-pencil" filterUnits="userSpaceOnUse">
  <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="11" result="edge"/>
  <feDisplacementMap in="SourceGraphic" in2="edge" scale="2" xChannelSelector="R" yChannelSelector="G" result="line"/>
  <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="2" result="grain"/>
  <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4.4 0 0 0 -1.3" result="tooth"/>
  <feComposite in="line" in2="tooth" operator="in"/>
</filter>`;

/** The ink's part of the layer, under the outlines. mount.js puts it in its place; mount() finds it.
 *  The stroke being drawn is in .live, under a pencil of its own (frame() says why). */
export const INK_HTML =
  `<svg class="ink" xmlns="${SVG}"><defs>${PENCIL}${PENCIL.replace('id="b42-pencil"', 'id="b42-pencil-live"')}</defs>` +
  `<g class="areas"></g><g class="strokes" filter="url(#b42-pencil)"></g><g class="live" filter="url(#b42-pencil-live)"></g></svg>`;

const pathOf = (pts) => `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}`;

/** A pencil filter worked out for a box of strokes only, wherever the page is scrolled to (the line
 *  is nudged by 2px at most; the margin is for its width and round ends). */
function fit(filter, b) {
  const key = `${Math.floor(b.x) - 12}|${Math.floor(b.y) - 12}|${Math.ceil(b.w) + 24}|${Math.ceil(b.h) + 24}`;
  if (filter._key === key) return;
  filter._key = key;
  const [x, y, w, h] = key.split("|");
  filter.setAttribute("x", x);
  filter.setAttribute("y", y);
  filter.setAttribute("width", w);
  filter.setAttribute("height", h);
}

// ── one frame ───────────────────────────────────────────────────────────────────────────────
// render.js asks for it in two parts, in the order of its reads and writes: the outline is
// measured with the others, before any is written; the ink and the card come after they are
// written, so the card's height is read once all of the frame's writes are done (a read between
// two writes would cost a second style recalc).

/** Its outline, the hover's (only while notes mode is on), for render.js to draw with the others. */
export function outlines(capturing) {
  if (
    S.enabled &&
    !capturing &&
    !S.drag &&
    modeOn() === "notes" &&
    S.hover &&
    S.hover.isConnected &&
    !S.sel.includes(S.hover)
  )
    return [[rectOf(S.hover), "hover"]];
  return [];
}

/** The rest of its part of a frame: the ink drawn and the card placed. */
export function frame(capturing) {
  const d = S.drag;

  // ink: committed strokes, area, and the live drag
  // All of it is drawn in document coordinates, and the whole picture is moved against the
  // scroll by a CSS transform on a compositor layer of its own. So scrolling paints nothing:
  // the layer is drawn once and then only moved, and the pencil grain (noise in the picture's
  // own coordinates) stays put on the page.
  // The stroke being drawn has a pencil of its own, and goes into the others' when the pointer
  // is let go. In theirs, its region would grow with the stroke, and all the ink in it be drawn
  // again through the filter in every frame (measured: 524 ms of raster a second, 168 so). Drawn
  // plain it would cost less (28), but it would change from a smooth line to a pencil one when
  // let go. The two filters are the same and their noise is in page coordinates: nothing moves.
  const show = S.enabled || capturing;
  const paths = show ? S.strokes : [];
  const drawing = d && d.mode === "draw" ? d.pts : null;
  const sx = VP.sx,
    sy = VP.sy;
  const areas = [];
  if (show && S.area) areas.push(S.area);
  if (d && d.mode === "area")
    areas.push({
      x: Math.min(d.x0, d.x) + sx,
      y: Math.min(d.y0, d.y) + sy,
      w: Math.abs(d.x - d.x0),
      h: Math.abs(d.y - d.y0),
    });
  const drawn = paths.length + areas.length > 0 || !!drawing;
  if (ink._on !== drawn) ink.classList.toggle("on", (ink._on = drawn)); // a layer only while there is ink
  // With nothing drawn, scrolling writes nothing here.
  const inkAt = `${sx}|${sy}`;
  if (drawn && ink._at !== inkAt) {
    ink._at = inkAt;
    ink.style.transform = `translate(${-sx}px, ${-sy}px)`;
  }
  // A drawn stroke stays as it is, and the one being drawn only grows: the same points and the
  // same count mean the same path. Writing it again would repaint the ink every frame.
  const write = (el, pts) => {
    if (el._pts === pts && el._n === pts.length) return false;
    el._pts = pts;
    el._n = pts.length;
    el.setAttribute("d", pathOf(pts));
    return true;
  };
  const liveEl = ink._live || (ink._live = ink.querySelector(".live"));
  const [live] = pool(liveEl, drawing ? 1 : 0, () => document.createElementNS(SVG, "path"));
  if (live && write(live, drawing))
    fit(ink._pencil || (ink._pencil = ink.querySelector("#b42-pencil-live")), bboxOf(drawing));
  const pathEls = pool(strokesEl, paths.length, () => document.createElementNS(SVG, "path"));
  let redrawn = pathEls.length !== strokesEl._n;
  strokesEl._n = pathEls.length;
  paths.forEach((pts, i) => {
    if (write(pathEls[i], pts)) redrawn = true;
  });
  if (redrawn && paths.length)
    fit(pencil, union(paths.map((pts) => strokeBox.get(pts) || strokeBox.set(pts, bboxOf(pts)).get(pts))));
  const rectEls = pool(ink.querySelector(".areas"), areas.length, () => document.createElementNS(SVG, "rect"));
  areas.forEach((r, i) => {
    const el = rectEls[i],
      key = `${r.x}|${r.y}|${r.w}|${r.h}`;
    if (el._k === key) return; // (an area that stays is not written again either)
    el._k = key;
    el.setAttribute("x", r.x);
    el.setAttribute("y", r.y);
    el.setAttribute("width", r.w);
    el.setAttribute("height", r.h);
  });

  // card
  if (S.card && S.enabled && !capturing) placeCard();
}
