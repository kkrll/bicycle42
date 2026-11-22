import { S, send, VERSION } from "./state.js";
import { vp } from "./page.js";
import { restoreDraft } from "./draft.js";
import * as Notes from "./notes/api.js";
import { finishCapture, refuseCapture } from "./sent.js";
import { hostFrame, showPin } from "./picture.js";
import * as Canvas from "./canvas/api.js";
import * as Motion from "./motion/api.js";
import { hostMode, retellMode } from "./mode.js";
import { hostAct, setHosted } from "./panel.js";
import { blockIfActive, endPeek, isOurs, LEFT_FOR_US, leftForUs, onKeyDown, onKeyUp, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, OURS_ONLY, oursOnly, setEnabled, setPins } from "./input.js";
import { active, kick, moved } from "./render.js";
import { setDevice } from "./device.js";
import STYLES from "./styles.css"; // its text: the build loads a stylesheet as a string

// ── mount ───────────────────────────────────────────────────────────────────────────────────
// The layer's own elements, made by mount(). A file can only assign what it declares, so they
// are here and not with the rest of the state; every other file reads them.
export let hostEl, root, boxes, pinsEl, cursorStyle, tip, variantsEl, variantStyle;
// The phone over a phone's page (device.js): first in the layer, so all the layer's own is drawn over it.
export let deviceEl;
// Outlines that move with the page and not with the window: a second element of the layer's, in
// the document's flow (absolute at its origin, not fixed, not in the top layer), so the compositor
// scrolls them with what they outline in the same frame. Put in the document the first time it
// has something to show (docLayer in render.js), taken out when the facts pane stops.
export let docHost, docBoxes;
export let domVersion = 0; // bumped on every DOM mutation; pins re-search only when it changes
export let treeVersion = 0; // bumped when elements are added or removed (not for a text): variant groups are looked for again

// The layer has to be the topmost thing on the page and has to take typing, whatever the page
// shows. Two browser rules decide where it sits:
//  - the top layer (modal dialogs, popovers) paints over every z-index, so the layer is a
//    popover itself, and the popover shown last is on top;
//  - a modal dialog makes everything outside it inert (no focus, no typing), so while one is
//    open the layer lives inside it.
function seat() {
  const modals = document.querySelectorAll("dialog:modal");
  const home = modals.length ? modals[modals.length - 1] : document.documentElement;
  const typing = root.activeElement === Notes.textarea;
  if (hostEl.parentNode !== home) home.appendChild(hostEl); // moving it also takes it out of the top layer
  try {
    if (hostEl.showPopover && !hostEl.matches(":popover-open")) hostEl.showPopover();
  } catch {
    // Not connected yet, or no popover support: it stays a fixed layer with the top z-index.
  }
  if ((typing || (S.card && S.enabled)) && root.activeElement !== Notes.textarea) Notes.textarea.focus({ preventScroll: true });
}

function raise() {
  if (!hostEl.isConnected || !hostEl.showPopover) return;
  const typing = root.activeElement === Notes.textarea;
  try {
    if (hostEl.matches(":popover-open")) hostEl.hidePopover();
    hostEl.showPopover();
  } catch {}
  if (typing) Notes.textarea.focus({ preventScroll: true });
}

/** A mutation record that adds or removes an element (a text node coming or going is a text). */
const addsOrRemoves = (r) => r.type === "childList" && [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1);

function mount() {
  if (hostEl && hostEl.isConnected) return;
  hostEl = document.createElement("b42-review");
  hostEl.setAttribute("popover", "manual");
  hostEl.setAttribute("style", "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block");
  root = hostEl.attachShadow({ mode: "open" });
  // The peek's end first, before any mode's listeners: edit mode stops every keyup of the page's
  // at the window (canvas/mount.js), and the peek must still hear its keys let go. Let go
  // somewhere else, no keyup comes here at all: the window's blur ends it then.
  window.addEventListener("keyup", onKeyUp, { capture: true, passive: false });
  window.addEventListener("blur", (e) => e.target === window && endPeek());
  document.addEventListener("visibilitychange", endPeek);
  root.innerHTML = `<style>${STYLES}</style>
    <div class="device" hidden><i class="dv-screen"></i><i class="dv-home"></i></div>
    ${Notes.inkHtml}
    <div class="boxes"></div><div class="pins"></div>
    ${Notes.cardHtml}
    <div class="variants"></div><div class="tip" hidden></div><div class="sent" hidden></div>
    ${Canvas.html}
    <div class="m-tag" hidden></div>`;
  deviceEl = root.querySelector(".device");
  boxes = root.querySelector(".boxes");
  docHost = document.createElement("b42-marks");
  docHost.setAttribute("style", "all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;display:block");
  const docRoot = docHost.attachShadow({ mode: "open" });
  docRoot.innerHTML = `<style>${STYLES}</style><div class="boxes doc"></div>`;
  docBoxes = docRoot.querySelector(".boxes");
  pinsEl = root.querySelector(".pins");
  Notes.mount();
  variantsEl = root.querySelector(".variants");
  variantStyle = document.createElement("style");
  (document.head || document.documentElement).appendChild(variantStyle);
  tip = root.querySelector(".tip");
  Canvas.mount();
  Motion.mount();
  seat();

  // A change to the page may have removed the layer, closed it (an element taken out of the
  // document leaves the top layer) or opened or closed a modal dialog: seat it again then.
  // Any other change leaves it where it is, and the document is not searched for dialogs.
  new MutationObserver((records) => {
    if (!hostEl.isConnected || (hostEl.showPopover && !hostEl.matches(":popover-open")) || records.some((r) => r.type === "attributes")) seat();
    // (Before any batch is applied again: this observer was made first, so it is told first.)
    Canvas.treeChanged(records);
    domVersion++;
    const tree = records.some(addsOrRemoves);
    if (tree) treeVersion++;
    // With review off there is nothing to follow (Preview draws no pins); a variant group that
    // came or went still needs its one frame, which hides all but the chosen option, review on or off.
    if (S.enabled) moved();
    else if (tree) kick();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributeFilter: ["open"] });
  // Something of the page's entered the top layer after us: go back on top of it.
  window.addEventListener(
    "toggle",
    (/** @type {any} */ e) => {
      if (e.target !== hostEl && e.newState === "open" && e.target.matches?.("[popover], dialog")) raise();
    },
    true,
  );
  // A focus trap (the page's modal pulling focus back into itself) must not see focus enter the
  // note card, or it takes the caret away.
  for (const t of ["focusin", "focusout"])
    window.addEventListener(t, (e) => isOurs(e) && e.stopImmediatePropagation(), true);

  cursorStyle = document.createElement("style");
  cursorStyle.textContent = "html[data-b42-review], html[data-b42-review] * { cursor: crosshair !important; }";
  (document.head || document.documentElement).appendChild(cursorStyle);

  const opts = { capture: true, passive: false };
  window.addEventListener("pointerdown", onPointerDown, opts);
  window.addEventListener("pointermove", onPointerMove, opts);
  window.addEventListener("pointerup", onPointerUp, opts);
  window.addEventListener("pointercancel", onPointerCancel, opts);
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "dragstart", "selectstart", "touchstart"])
    window.addEventListener(t, blockIfActive, opts);
  window.addEventListener("keydown", onKeyDown, opts);
  window.addEventListener("scroll", moved, { capture: true, passive: true });
  window.addEventListener("resize", moved, { passive: true });
  for (const type of ["pointerdown", "pointermove", "pointerup", "keydown", "keyup", "wheel"])
    window.addEventListener(type, active, { capture: true, passive: true });

  // Last, so that what is above has seen the event: the layer's own UI is not the page's to see.
  for (const t of OURS_ONLY) window.addEventListener(t, oursOnly, opts);
  for (const t of LEFT_FOR_US) window.addEventListener(t, leftForUs, true);

  send({ type: "ready", url: location.href, viewport: vp() });
}

window.__b42 = {
  version: VERSION,
  busy: () => !!(S.card || S.pending || S.drag || Notes.hasDraft() || Canvas.busy() || Motion.busy()),
  receive(msg) {
    if (typeof msg === "string") msg = /** @type {import("../protocol").HostMessage} */ (JSON.parse(msg));
    if (!root) return;
    switch (msg.type) {
      case "state":
        if (Array.isArray(msg.templates)) S.templates = msg.templates.filter((t) => t && typeof t.name === "string");
        setEnabled(!!msg.enabled);
        if (msg.pins) setPins(msg.pins);
        if (msg.draft && !Notes.hasDraft() && !Canvas.hasEdits()) restoreDraft(msg.draft);
        Canvas.resume();
        Motion.resume();
        retellMode();
        break;
      case "mode":
        hostMode(msg);
        break;
      case "enabled":
        setEnabled(!!msg.enabled);
        break;
      case "pins":
        setPins(msg.pins);
        break;
      case "captured":
        if (msg.ok === false) refuseCapture(msg.id, msg.why);
        else finishCapture(msg.id);
        break;
      case "edits":
        Canvas.showEdits(msg);
        break;
      case "frame":
        hostFrame(msg);
        break;
      case "show":
        showPin(msg.id);
        break;
      case "docks":
        // A dock the host draws from now on, or gives back: its views start or stop. (The layer
        // has no dock of its own for either mode.)
        if (!setHosted(msg.hosted)) break;
        Motion.syncUi();
        Canvas.drawBar(); // (the host's inspector, if it is one now, is told the batch in the next frame)
        kick();
        break;
      case "panel":
        hostAct(msg);
        break;
      case "device":
        setDevice(msg.phone);
        break;
    }
  },
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
else mount();
