// Notes mode, drawn: the hover outline, the ink (strokes and areas, the drag's live one) and the
// card's place, one frame at a time. render.js calls these; the outlines of S.sel are its own.

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

/** The ink's part of the layer, under the outlines. mount.js puts it in its place; mount() finds it. */
const INK_HTML = `<svg class="ink" xmlns="${SVG}"><defs>${PENCIL}</defs><g class="areas"></g><g class="strokes" filter="url(#b42-pencil)"></g></svg>`;

// ── one frame ───────────────────────────────────────────────────────────────────────────────
// render.js asks for it in two parts, in the order of its reads and writes: the outline is
// measured with the others, before any is written; the ink and the card come after they are
// written, so the card's height is read once all of the frame's writes are done (a read between
// two writes would cost a second style recalc).

/** Its outline, the hover's (only while notes mode is on), for render.js to draw with the others. */
function outlines(capturing) {
  if (S.enabled && !capturing && !S.drag && modeOn() === "notes" && S.hover && S.hover.isConnected && !S.sel.includes(S.hover))
    return [[rectOf(S.hover), "hover"]];
  return [];
}

/** The rest of its part of a frame: the ink drawn and the card placed. */
function frame(capturing) {
  const d = S.drag;

  // ink: committed strokes, area, and the live drag
  // All of it is drawn in document coordinates, and the whole picture is moved against the
  // scroll by a CSS transform on a compositor layer of its own. So scrolling paints nothing:
  // the layer is drawn once and then only moved, and the pencil grain (noise in the picture's
  // own coordinates) stays put on the page.
  const show = S.enabled || capturing;
  const paths = show ? S.strokes.slice() : [];
  if (d && d.mode === "draw") paths.push(d.pts);
  const sx = VP.sx, sy = VP.sy;
  const areas = [];
  if (show && S.area) areas.push(S.area);
  if (d && d.mode === "area") areas.push({ x: Math.min(d.x0, d.x) + sx, y: Math.min(d.y0, d.y) + sy, w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) });
  const drawn = paths.length + areas.length > 0;
  if (ink._on !== drawn) ink.classList.toggle("on", (ink._on = drawn)); // a layer only while there is ink
  // With nothing drawn, scrolling writes nothing here.
  const inkAt = `${sx}|${sy}`;
  if (drawn && ink._at !== inkAt) {
    ink._at = inkAt;
    ink.style.transform = `translate(${-sx}px, ${-sy}px)`;
  }
  const pathEls = pool(strokesEl, paths.length, () => document.createElementNS(SVG, "path"));
  let redrawn = pathEls.length !== strokesEl._n;
  strokesEl._n = pathEls.length;
  paths.forEach((pts, i) => {
    // A drawn stroke stays as it is, and the one being drawn only grows: the same points and
    // the same count mean the same path. Writing it again would repaint the ink every frame.
    const el = pathEls[i];
    if (el._pts === pts && el._n === pts.length) return;
    el._pts = pts;
    el._n = pts.length;
    el.setAttribute("d", `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}`);
    redrawn = true;
  });
  // The pencil filter is worked out for the strokes' own box, wherever the page is scrolled to
  // (the line is nudged by 2px at most; the margin is for its width and round ends).
  if (redrawn && paths.length) {
    const b = union(paths.map((pts) => (pts === (d && d.pts) ? bboxOf(pts) : strokeBox.get(pts) || strokeBox.set(pts, bboxOf(pts)).get(pts))));
    const key = `${Math.floor(b.x) - 12}|${Math.floor(b.y) - 12}|${Math.ceil(b.w) + 24}|${Math.ceil(b.h) + 24}`;
    if (pencil._key !== key) {
      pencil._key = key;
      const [x, y, w, h] = key.split("|");
      pencil.setAttribute("x", x);
      pencil.setAttribute("y", y);
      pencil.setAttribute("width", w);
      pencil.setAttribute("height", h);
    }
  }
  const rectEls = pool(ink.querySelector(".areas"), areas.length, () => document.createElementNS(SVG, "rect"));
  areas.forEach((r, i) => {
    const el = rectEls[i], key = `${r.x}|${r.y}|${r.w}|${r.h}`;
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
