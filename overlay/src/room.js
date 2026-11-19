// ── the room under a dock ───────────────────────────────────────────────────────────────────
// A mode with a dock along the bottom of the window (canvas's inspector, motion's dock) covers the
// last part of the window, and the page is laid out as if the window ended where the dock begins:
//  - the document gets the dock's height as padding at its end, so its last part scrolls out from
//    under the dock;
//  - what the page keeps at the bottom of the window (a cookie bar, a sign-up banner, a chat
//    button, a modal dialog) goes up by as much: a fixed box placed from the bottom of the window
//    gets the dock's height added to its `bottom`. One placed from the top (a header, a sidebar
//    of a set height) stays where it is.
// Both by rules the page adopts, nothing written into the page's elements. The fixed boxes are
// looked for again when elements come or go (at most every LOOK_MS) and when the window or the
// dock changes size; a box that was there all along and only shows now (a class switched, or
// display: none taken off) is fixed already, so it is lifted already.
import { adopt, BOOST, q, selectorFor, SKIP } from "./page.js";
import { treeVersion } from "./mount.js";

const LOOK_MS = 300;
/** The height each mode's dock covers now, 0 when it has none open. */
const docks = { canvas: 0, motion: 0 };
const R = {
  h: 0, // the room given now: the tallest dock
  pad: /** @type {CSSStyleSheet | null} */ (null),
  lift: /** @type {CSSStyleSheet | null} */ (null),
  lifted: 0, // the height the lift sheet adds now
  sels: "", // the lift sheet's selectors, as one list
  text: "",
  tree: -1,
  w: 0,
  vh: 0,
  at: 0,
};
/** A fixed box's selector, kept while it still finds that box (paths are slow to make). */
const selOf = new WeakMap();

/** A mode says how tall its dock is now (0: closed). The page's room follows on the next frame;
 *  the scroll room at once. */
export function setRoom(who, px) {
  docks[who] = px;
  const h = Math.max(docks.canvas, docks.motion);
  if (h === R.h) return;
  R.h = h;
  if (!R.pad) {
    R.pad = new CSSStyleSheet();
    R.pad.replaceSync("html[data-b42-review] { padding-bottom: 0px !important; }");
    R.lift = new CSSStyleSheet();
  }
  if (h) /** @type {CSSStyleRule} */ (R.pad.cssRules[0]).style.setProperty("padding-bottom", `${h}px`, "important");
  adopt(R.pad, !!h);
  R.tree = -1; // the fixed boxes are looked at again on the next frame
  if (!h) {
    adopt(R.lift, false);
    R.lifted = 0;
    R.sels = R.text = "";
  }
}

/** Each frame (render.js): the fixed boxes looked for again when something they depend on
 *  changed. While a capture hides the dock they are where the page puts them: the picture shows
 *  the page as it is (the scroll room stays, or the page would jump). */
export function roomFrame(now, capturing) {
  if (!R.h) return;
  adopt(R.lift, !!R.text && !capturing);
  if (capturing) return;
  if (R.tree === treeVersion && R.w === innerWidth && R.vh === innerHeight) return;
  if (R.tree !== -1 && R.w === innerWidth && R.vh === innerHeight && now - R.at < LOOK_MS) return;
  R.tree = treeVersion;
  R.w = innerWidth;
  R.vh = innerHeight;
  R.at = now;
  liftFixed();
}

function liftFixed() {
  const body = document.body;
  if (!body) return;
  const rules = [];
  const sels = [];
  for (const el of body.getElementsByTagName("*")) {
    if (SKIP.test(el.tagName)) continue; // the layer itself is fixed too
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") continue;
    // A box the lift sheet already moves has that much more in its bottom: what the page gives
    // it is read back by taking it off (taking the sheet away to read it would restyle the page
    // twice and start the box's transitions).
    const ours = R.sels !== "" && el.matches(R.sels);
    if (!ours && el.computedStyleMap().get("bottom") instanceof CSSKeywordValue) continue; // placed from the top
    const own = parseFloat(cs.bottom) - (ours ? R.lifted : 0);
    if (!Number.isFinite(own)) continue;
    let sel = selOf.get(el);
    if (!sel || q(sel) !== el) selOf.set(el, (sel = selectorFor(el)));
    sels.push(sel);
    rules.push(`${sel}${BOOST} { bottom: ${Math.round((own + R.h) * 100) / 100}px !important; }`);
  }
  const text = rules.join("\n");
  if (text !== R.text) {
    try {
      R.lift.replaceSync(text);
      R.text = text;
      R.sels = sels.join(", ");
    } catch {
      R.lift.replaceSync("");
      R.text = R.sels = "";
    }
  }
  R.lifted = R.text ? R.h : 0;
  adopt(R.lift, !!R.text);
}
