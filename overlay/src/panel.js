import { send } from "./state.js";

// ── the panes the host draws ────────────────────────────────────────────────────────────────
// Canvas mode's inspector and motion mode's dock are only ever the host's: the layer draws neither
// and makes no room on the page for one. The host says which it draws (Dock in ../protocol.ts);
// for those the mode tells the host what its dock shows (sendView) and does what the host's dock
// asks (onAct). A host that does not say it draws a dock has none. Which docks are hosted is here
// and nowhere else: a mode asks (hosted) wherever it would send a view.
// "facts" (facts/host.js) is a pane of the host's that is no mode's dock: the layer never draws
// it, and only the host's asking makes it work.
const PANES = ["canvas", "motion", "facts"];
const HOSTED = new Set();
/** A pane's handler for what the host's pane asks: name → fn(act). */
const ACTS = {};
/** Told when the list of hosted panes changed: name → fn(). */
const CHANGED = {};
/** The view each pane last asked to send, sent together once a frame; and that frame. */
const WAITING = new Map();
let raf = 0;

/** @param {import("../protocol").Pane} name */
export const hosted = (name) => HOSTED.has(name);

/** From the host's "docks": the whole list. True when it is not what it was. */
export function setHosted(list) {
  const next = (Array.isArray(list) ? list : []).filter((n) => PANES.includes(n));
  if (next.length === HOSTED.size && next.every((n) => HOSTED.has(n))) return false;
  HOSTED.clear();
  for (const n of next) HOSTED.add(n);
  for (const fn of Object.values(CHANGED)) fn();
  return true;
}

/** A mode takes what the host's pane asks of it. One handler a pane.
 *  @param {import("../protocol").Pane} name @param {(act: any) => void} fn */
export function onAct(name, fn) {
  ACTS[name] = fn;
}

/** A pane hears that the list of hosted panes changed (its own may have come or gone).
 *  @param {import("../protocol").Pane} name @param {() => void} fn */
export function onHosted(name, fn) {
  CHANGED[name] = fn;
}

/** From the host's "panel". "ping" is answered here, for every pane. */
export function hostAct(msg) {
  if (!msg || !hosted(msg.panel) || !msg.act) return;
  if (msg.act.type === "ping") return send({ type: "panel", panel: msg.panel, pong: Number(msg.act.id) || 0 });
  if (ACTS[msg.panel]) ACTS[msg.panel](msg.act);
}

/** What a hosted pane shows now: the whole view. Many in one frame send the last one, once.
 *  Nothing is sent for a pane the host does not draw.
 *  @param {import("../protocol").Pane} name @param {any} view */
export function sendView(name, view) {
  if (!hosted(name)) return;
  WAITING.set(name, view);
  if (!raf)
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const [panel, v] of WAITING) send(/** @type {any} */ ({ type: "panel", panel, view: v }));
      WAITING.clear();
    });
}
