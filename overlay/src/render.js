// ── render ──────────────────────────────────────────────────────────────────────────────────

function pool(container, n, make) {
  while (container.children.length < n) container.appendChild(make());
  while (container.children.length > n) container.lastChild.remove();
  return [...container.children];
}

function placeBox(div, r, cls) {
  // Most frames an outline has not moved: nothing is written then (no restyle for an idle selection).
  const k = `${cls}|${r.x}|${r.y}|${r.w}|${r.h}`;
  if (div._k === k) return;
  div._k = k;
  div.className = `box ${cls}`;
  div.style.transform = `translate(${r.x}px, ${r.y}px)`;
  div.style.width = `${r.w}px`;
  div.style.height = `${r.h}px`;
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

function render() {
  if (!root) return;
  readView();
  // A batch hidden for the host's "before" picture counts as a capture: no chrome in that picture.
  const capturing = !!S.pending || Canvas.hiding;
  drawVariants(capturing);
  const canvasBoxes = Canvas.frame(capturing);
  const motionBoxes = Motion.frame(capturing);

  // boxes: hover, the note's outlines (in its screenshot, whichever mode made it), canvas, motion
  const items = Notes.outlines(capturing);
  if (S.enabled || capturing) for (const el of S.sel) if (el.isConnected) items.push([rectOf(el), "sel"]);
  if (canvasBoxes) items.push(...canvasBoxes);
  if (motionBoxes) items.push(...motionBoxes);
  const divs = pool(boxes, items.length, () => document.createElement("div"));
  items.forEach(([r, cls], i) => placeBox(divs[i], r, cls));

  // notes mode's ink and card: after the boxes are written (notes/frame.js says why)
  Notes.frame(capturing);

  // pins
  const visible = [];
  const unplaced = [];
  const now = performance.now();
  Canvas.readPathsIfDue(now);
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
      if (p.el && p.el.isConnected) at = pinPoint(p.el);
    }
    if (!at && p.at) {
      at = toView(p.at);
      approx = !!(p.selector || p.text);
    }
    if (!at || approx) unplaced.push(p.id);
    if (at && !capturing) visible.push([p, at, approx]);
  }
  const pinEls = pool(pinsEl, visible.length, makePin);
  const dpr = window.devicePixelRatio || 1;
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

// Draw every frame only while a note is being made or the reviewer is doing something (outlines
// must follow the layout as it moves). Otherwise the layer redraws when something says it may
// have moved: DOM changes, scroll, resize. A slow tick covers what none of those report (CSS
// animations, late-loading images), so idle pins cost a few redraws a second, not sixty.
const IDLE_TICK_MS = 250;
const ACTIVE_MS = 500;
let idleTimer = 0;
let lastInput = 0;
function active() {
  lastInput = performance.now();
  kick();
}
function frame() {
  raf = 0;
  render();
  // Through kick(): something in render() may have asked for the next frame already, and a
  // second request here would start a second chain (two renders a frame until the selection goes).
  if (S.card || S.sel.length || S.drag || S.pending || Canvas.busyFrames() || Motion.busyFrames() || performance.now() - lastInput < ACTIVE_MS)
    kick();
  else if ((S.enabled || S.pins.length) && !idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      kick();
    }, IDLE_TICK_MS);
}

function kick() {
  if (!raf && root) raf = requestAnimationFrame(frame);
}

