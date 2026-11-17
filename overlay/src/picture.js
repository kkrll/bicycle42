// ── for the host: a picture of the page alone, and a pin brought into view ───────────────────
// The host asks by message and never writes into the page itself: what the layer is made of
// (its element, how a pin finds its place) is known here only.
import { S, send } from "./state.js";
import { findPin, vp } from "./page.js";
import { hostEl } from "./mount.js";

/** A host that never gives the page back must not leave it without the layer, or somewhere else. */
const HOLD_MS = 5000;
let held = /** @type {{ at: [number, number] | null, timer: any } | null} */ (null);

function release() {
  if (!held) return;
  clearTimeout(held.timer);
  const at = held.at;
  held = null;
  hostEl.style.removeProperty("visibility");
  if (at) window.scrollTo({ left: at[0], top: at[1], behavior: "instant" });
}

/** "frame": see HostMessage in ../protocol.ts.
 *  @param {Extract<import("../protocol").HostMessage, { type: "frame" }>} msg */
export function hostFrame(msg) {
  if (msg.hold === true) {
    // The whole layer, not only its chrome: this picture is of the page as the agent left it.
    // (Held twice, the place to go back to is the first one's.)
    const at = held ? held.at : null;
    if (held) clearTimeout(held.timer);
    held = { at, timer: setTimeout(release, HOLD_MS) };
    hostEl.style.setProperty("visibility", "hidden", "important");
    const to = msg.scroll;
    if (Array.isArray(to) && Number.isFinite(to[0]) && Number.isFinite(to[1])) {
      if (!held.at) held.at = [window.scrollX, window.scrollY];
      window.scrollTo({ left: to[0], top: to[1], behavior: "instant" });
    }
  } else if (msg.hold === false) release();
  let told = false;
  const tell = () => {
    if (told) return;
    told = true;
    send({ type: "frame-shown", id: msg.id, viewport: vp() });
  };
  requestAnimationFrame(() => requestAnimationFrame(tell));
  setTimeout(tell, 400); // frames may not come (a hidden window): the host waits a second at most
}

/** "show": the pin's place, a third of the window down. */
export function showPin(id) {
  const p = S.pins.find((x) => x.id === id);
  if (!p) return;
  if ((p.selector || p.text) && !(p.el && p.el.isConnected)) p.el = findPin(p);
  const r = p.el && p.el.isConnected ? p.el.getBoundingClientRect() : null;
  const y = r && (r.width || r.height) ? r.top + window.scrollY : p.at ? p.at[1] : null;
  if (typeof y !== "number" || !Number.isFinite(y)) return;
  window.scrollTo({ top: Math.max(0, y - window.innerHeight / 3), behavior: "smooth" });
}
