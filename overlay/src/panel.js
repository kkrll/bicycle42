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
/** The view the host has of each pane, as far as the layer knows: the one that last went. */
const SENT = new Map();

/** @param {import("../protocol").Pane} name */
export const hosted = (name) => HOSTED.has(name);

/** From the host's "docks": the whole list. True when it is not what it was. */
export function setHosted(list) {
  const next = (Array.isArray(list) ? list : []).filter((n) => PANES.includes(n));
  if (next.length === HOSTED.size && next.every((n) => HOSTED.has(n))) return false;
  HOSTED.clear();
  for (const n of next) HOSTED.add(n);
  // A pane given back is forgotten: hosted again, it starts with the whole view.
  for (const n of [...SENT.keys()]) if (!HOSTED.has(n)) SENT.delete(n);
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

/** From the host's "panel". "ping" and "whole" are answered here, for every pane. */
export function hostAct(msg) {
  if (!msg || !hosted(msg.panel) || !msg.act) return;
  if (msg.act.type === "ping") return send({ type: "panel", panel: msg.panel, pong: Number(msg.act.id) || 0 });
  if (msg.act.type === "whole") return whole(msg.panel);
  if (ACTS[msg.panel]) ACTS[msg.panel](msg.act);
}

/** The host has lost its view of a pane (it got a part with nothing to put it in): the one it
 *  should have goes again, whole. Nothing when none ever went. */
function whole(name) {
  if (!SENT.has(name)) return;
  const v = SENT.get(name);
  SENT.delete(name);
  putView(name, v);
}

/** What a hosted pane shows now, sent at once: the whole view the first time, and after that
 *  only its fields that are not the ones that last went (`part`), or nothing when all are. A
 *  field is compared by identity, never read: a pane that keeps the object it sent for what did
 *  not change sends none of it again, and one that builds everything anew sends everything, as
 *  before. So a view that went is never changed in place: a change is a new object. A view with
 *  other fields than the last, and no view (null), go whole.
 *  @param {import("../protocol").Pane} name @param {any} view */
export function putView(name, view) {
  if (!hosted(name)) return;
  const had = SENT.has(name), was = SENT.get(name);
  SENT.set(name, view);
  if (had && was === view) return;
  const keys = view ? Object.keys(view) : [];
  if (!view || !was || keys.length !== Object.keys(was).length || !keys.every((k) => k in was)) return send(/** @type {any} */ ({ type: "panel", panel: name, view }));
  const changed = keys.filter((k) => view[k] !== was[k]);
  if (!changed.length) return;
  if (changed.length === keys.length) return send(/** @type {any} */ ({ type: "panel", panel: name, view }));
  send(/** @type {any} */ ({ type: "panel", panel: name, part: Object.fromEntries(changed.map((k) => [k, view[k]])) }));
}

/** What a hosted pane shows now, sent with the frame (putView says what goes). Many in one
 *  frame send the last one, once. Nothing is sent for a pane the host does not draw.
 *  @param {import("../protocol").Pane} name @param {any} view */
export function sendView(name, view) {
  if (!hosted(name)) return;
  WAITING.set(name, view);
  if (!raf)
    raf = requestAnimationFrame(() => {
      raf = 0;
      const waiting = [...WAITING];
      WAITING.clear();
      for (const [panel, v] of waiting) putView(panel, v);
    });
}
