// ── the phone over its page: the home indicator and the screen's bottom corners ─────────────────
// A host that shows the page as a phone's runs it to the screen's bottom edge, as iOS 26's Safari
// does, and cannot draw over it there: what of the phone is over the page is drawn here, as the
// host says ("device", PhoneEdge in ../protocol.ts). It is the phone, not the layer: drawn in
// every mode, Preview too, and through the peek (styles.css); out of every picture (a note's
// capture, through render.js's `capturing`, and a held "frame", which hides the whole layer).
//
// It takes no pointer, so no hit test finds it: a tap under the pill is the page's, and every
// probe of the page that asks what is at a point (elementFromPoint, elementsFromPoint: picking,
// the host's colour probe) passes under it. It is in the layer's shadow root, which no search of
// the document enters (pins, the facts, edit mode's tree), and the layer's own element is passed
// over where the page's elements are walked.
//
// The corners are the page's engine drawing what the host's draws: a box the screen's size with
// the host's border-radius and corner-shape (a squircle, not a circle), and two spread shadows,
// the ring and, under it, what is around the phone. The same shapes in the same engine, so the
// curve, the ring's width along it and its edges are the host's (the app e2e compares the
// pixels). Shadows, not an outline: an outline's width is snapped to whole px, and on a phone
// drawn at 89% the ring is 8.95 of the page's px, drawn 8 (a pixel short of the host's at the
// diagonal); a spread is not. The ring's outer edge is over the colour around it, as the host
// draws it, with no page showing between the two.
//
// The page may be drawn zoomed out (something wider than the phone, or no viewport tag): the
// layer's px are then the page's, not the phone's, and its fixed box the layout viewport. The
// drawing is put on the visual viewport and scaled back to the phone's px.
import { deviceEl } from "./mount.js";

/** @type {import("../protocol").PhoneEdge | null} */
let edge = null;
let capturing = false;
let following = false;

const COLOUR = /^#[0-9a-f]{6}$/i;
const size = (n, max = 400) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
/** A corner-shape the page's engine takes, else a circle's. */
const shapeOf = (s) => (typeof s === "string" && s.length <= 80 && CSS.supports("corner-shape", s) ? s : "round");
/** How far the colour around the phone reaches past the screen: past any window. */
const AROUND_PX = 4000;

/** "device": see HostMessage in ../protocol.ts. Anything it cannot read is nothing to draw.
 *  @param {import("../protocol").PhoneEdge | null} phone */
export function setDevice(phone) {
  edge = null;
  if (phone && typeof phone === "object") {
    const h = phone.home;
    const home = h && size(h.width) && size(h.height, 40) && size(h.bottom, 100) ? { width: h.width, height: h.height, bottom: h.bottom } : undefined;
    const corners = size(phone.radius) && phone.radius > 0 && size(phone.ring, 100) && COLOUR.test(String(phone.ringColour)) && COLOUR.test(String(phone.around));
    if (home || corners) edge = corners ? { radius: phone.radius, shape: shapeOf(phone.shape), ring: phone.ring, ringColour: phone.ringColour, around: phone.around, home } : { radius: 0, home };
  }
  draw();
}

/** Once a frame of the layer's: out of a note's picture while it is taken. */
export function drawDevice(capture) {
  if (capture === capturing) return;
  capturing = capture;
  deviceEl.hidden = !edge || capturing;
}

function draw() {
  const [screen, home] = deviceEl.children;
  deviceEl.hidden = !edge || capturing;
  follow(!!edge);
  if (!edge) return;
  const r = edge.radius;
  screen.hidden = r <= 0;
  if (r > 0)
    for (const [k, v] of [["border-radius", `0 0 ${r}px ${r}px`], ["corner-shape", edge.shape], ["box-shadow", `0 0 0 ${edge.ring}px ${edge.ringColour}, 0 0 0 ${AROUND_PX}px ${edge.around}`]])
      screen.style.setProperty(k, v);
  home.hidden = !edge.home;
  if (edge.home) {
    const { width, height, bottom } = edge.home;
    Object.assign(home.style, { width: `${width}px`, height: `${height}px`, bottom: `${bottom}px`, marginLeft: `${-width / 2}px`, borderRadius: `${height / 2}px` });
  }
  place();
}

/** On the visual viewport, in the phone's px: what is seen of the page, whatever its zoom. */
function place() {
  const v = window.visualViewport;
  if (!v) return;
  const k = v.scale || 1;
  Object.assign(deviceEl.style, {
    left: `${v.offsetLeft}px`,
    top: `${v.offsetTop}px`,
    width: `${v.width * k}px`,
    height: `${v.height * k}px`,
    transform: k === 1 ? "" : `scale(${1 / k})`,
  });
}

function follow(on) {
  const v = window.visualViewport;
  if (!v || on === following) return;
  following = on;
  for (const t of ["resize", "scroll"]) on ? v.addEventListener(t, place, { passive: true }) : v.removeEventListener(t, place);
}
