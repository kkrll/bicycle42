import { S } from "../state.js";
import { icon } from "../ui.js";
import { C } from "./state.js";
import { cursorOf } from "./select.js";
import { checkEdit, guardEdit } from "./text.js";
import { drawBar, setPop } from "./bar.js";
import { setMode } from "../mode.js";
import { isOurs } from "../input.js";
import { root } from "../mount.js";

// ── mount ───────────────────────────────────────────────────────────────────────────────────
// Its part of the layer: the grab elements around the selection, and in notes mode the chip that
// says edits were left unsent and the "?" in the corner. The inspector and its footer are the
// host's (host.js). mount.js puts it in its place among the rest; mountCanvas finds them.
export const HTML = `<div class="cv" hidden><div class="band" hidden></div>
      <div class="hit" hidden><div class="gzs"></div><div class="eg" hidden></div><div class="eg" hidden></div><div class="eg" hidden></div><div class="eg" hidden></div>
        <div class="hd" hidden></div><div class="hd" hidden></div><div class="hd" hidden></div><div class="hd" hidden></div></div>
      <div class="ghost" hidden></div><div class="ins" hidden></div><div class="lab dim" hidden></div><div class="lab live" hidden></div>
      <div class="shield" hidden></div></div>
    <div class="bar idle" hidden><button type="button" class="count" title="Back to edit mode, where these edits can be sent"><span class="cn"></span></button></div>
    <div class="corner" hidden><div class="pop" hidden></div><button type="button" class="help" title="Keys and gestures" aria-label="Keys and gestures">${icon("help")}</button></div>`;

export let corner, bar, cv, bandEl, ghostEl, insEl, labEl, dimEl, handles, edges, hitEl, gzEl, shieldEl;

export function mountCanvas() {
  bar = root.querySelector(".bar");
  corner = root.querySelector(".corner");
  cv = root.querySelector(".cv");
  [bandEl, ghostEl, insEl, labEl, dimEl] = [".band", ".ghost", ".ins", ".lab.live", ".lab.dim"].map((s) => cv.querySelector(s));
  hitEl = cv.querySelector(".hit");
  gzEl = cv.querySelector(".gzs");
  shieldEl = cv.querySelector(".shield");
  handles = [...cv.querySelectorAll(".hd")];
  edges = [...cv.querySelectorAll(".eg")];
  // What each grab element means, and its cursor: corners (top-left, top-right, bottom-left,
  // bottom-right), then edges (top, right, bottom, left).
  handles.forEach((el, i) => (el._z = { t: "resize", hx: i % 2 ? 1 : -1, hy: i > 1 ? 1 : -1 }));
  edges.forEach((el, i) => (el._z = { t: "resize", hx: i === 1 ? 1 : i === 3 ? -1 : 0, hy: i === 0 ? -1 : i === 2 ? 1 : 0 }));
  for (const el of [...handles, ...edges]) el.style.cursor = cursorOf(el._z);

  // Keys and clicks on the chip and the "?" must not reach the page's own handlers. (The same
  // for the mouse on the grab elements around the selection.)
  for (const box of [bar, corner, cv])
    for (const t of ["keydown", "keyup", "keypress", "click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel"])
      box.addEventListener(t, (e) => e.stopPropagation());
  bar.querySelector(".count").addEventListener("click", () => setMode("canvas"));
  corner.querySelector(".help").addEventListener("click", () => setPop("help"));

  // While text is edited in place, or the pointer works the canvas, the page's own handlers
  // must not see the typing. (keydown has its own path: keys.js.)
  for (const t of ["keyup", "keypress", "beforeinput", "input", "paste", "cut", "copy", "compositionstart", "compositionupdate", "compositionend"])
    window.addEventListener(t, (e) => {
      if (!S.enabled || !C.on || isOurs(e)) return;
      // (text edited in place keeps the elements inside it: text.js)
      if (t === "beforeinput") guardEdit(e);
      else if (t === "input") checkEdit();
      e.stopImmediatePropagation();
    }, true);
  drawBar();
}
