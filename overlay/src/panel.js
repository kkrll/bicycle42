import { send } from "./state.js";

// ── the docks the host draws ────────────────────────────────────────────────────────────────
// Canvas mode's inspector and motion mode's dock are drawn at the bottom of the page, by the
// layer, unless the host says it draws one itself (Dock in ../protocol.ts). For such a dock the
// layer shows none and makes no room for one; the mode tells the host what its dock would show
// (sendView) and does what the host's dock asks (onAct). Which docks are hosted is here and
// nowhere else: a mode asks (hosted) wherever it would show its dock or measure it.
const HOSTED = new Set();
/** A mode's handler for what the host's dock asks: name → fn(act). */
const ACTS = {};
/** The view each dock last asked to send, sent together once a frame; and that frame. */
const WAITING = new Map();
let raf = 0;

/** @param {import("../protocol").Dock} name */
export const hosted = (name) => HOSTED.has(name);

/** From the host's "docks": the whole list. True when it is not what it was. */
export function setHosted(list) {
  const next = (Array.isArray(list) ? list : []).filter((n) => n === "canvas" || n === "motion");
  if (next.length === HOSTED.size && next.every((n) => HOSTED.has(n))) return false;
  HOSTED.clear();
  for (const n of next) HOSTED.add(n);
  return true;
}

/** A mode takes what the host's dock asks of it. One handler a dock.
 *  @param {import("../protocol").Dock} name @param {(act: any) => void} fn */
export function onAct(name, fn) {
  ACTS[name] = fn;
}

/** From the host's "panel". "ping" is answered here, for every dock. */
export function hostAct(msg) {
  if (!msg || !hosted(msg.panel) || !msg.act) return;
  if (msg.act.type === "ping") return send({ type: "panel", panel: msg.panel, pong: Number(msg.act.id) || 0 });
  if (ACTS[msg.panel]) ACTS[msg.panel](msg.act);
}

/** What a hosted dock shows now: the whole view. Many in one frame send the last one, once.
 *  Nothing is sent for a dock the host does not draw.
 *  @param {import("../protocol").Dock} name @param {any} view */
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
