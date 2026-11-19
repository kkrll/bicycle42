import { S } from "../state.js";
import { adopt, BOOST } from "../page.js";
import { C } from "./state.js";
import { shieldEl } from "./mount.js";
import { setRoom } from "../room.js";

// ── the page's cursor, and a drag's live rule ───────────────────────────────────────────────
// In canvas mode the page's cursor is the plain arrow, by one rule that never changes (changing a
// rule that matches every element restyles the whole document). The arrows over a handle or a
// gap come from the layer's own elements; during a drag a shield over the viewport carries the
// cursor. The page is laid out as if the window ended where the dock begins (room.js).
export const dock = () => (C.collapsed ? 30 : C.ph);
export function syncUi() {
  const on = C.on && S.enabled;
  setRoom("canvas", on ? dock() : 0);
  if (!on) {
    if (C.ui) adopt(C.ui, false);
    return;
  }
  if (!C.ui) {
    C.ui = new CSSStyleSheet();
    C.ui.replaceSync("html[data-b42-review], html[data-b42-review] * { cursor: default !important; }");
  }
  adopt(C.ui, true);
}

/** The caret cursor over text being edited in place: a rule for that element only. */
export function editCursor(rs) {
  if (!C.caret) C.caret = new CSSStyleSheet();
  if (rs)
    try {
      C.caret.replaceSync(`${rs}${BOOST}, ${rs}${BOOST} * { cursor: text !important; }`);
    } catch {}
  adopt(C.caret, !!rs);
}

export function shield(cursor) {
  shieldEl.hidden = !cursor;
  if (cursor) shieldEl.style.cursor = cursor;
}

// A drag previews through one rule of its own: written when the drag starts, as
// `width: var(--b42-live-width) !important` on the dragged element's selector, and not changed
// again. Each frame sets only that custom property, inline on the element: a rule changed in an
// adopted sheet restyles the whole document (on a page of a thousand cards, a millisecond and a
// half a frame), an inline property only the element and what is in it. On release the value is
// written into the element's styles (endDrag), the rule goes and the element's style attribute
// is put back as it was.
const VAR = "--b42-live-";
export function liveSet(el, sel, prop, val) {
  if (!C.live) {
    C.live = new CSSStyleSheet();
    C.live.replaceSync("b42-none {}");
  }
  const rule = C.live.cssRules[0];
  if (rule.selectorText !== sel) rule.selectorText = sel;
  adopt(C.live, true);
  if (!rule.style.getPropertyValue(prop)) rule.style.setProperty(prop, `var(${VAR}${prop})`, "important");
  if (C.liveEl && C.liveEl.el !== el) liveDrop();
  if (!C.liveEl) C.liveEl = { el, was: el.getAttribute("style"), ours: null };
  el.style.setProperty(VAR + prop, val);
  C.liveEl.ours = el.getAttribute("style");
}
export function liveEnd() {
  if (!C.live) return;
  adopt(C.live, false);
  C.live.cssRules[0].style.cssText = "";
  liveDrop();
}
/** The element's style attribute as it was before the drag: exactly, unless the page wrote it
 *  meanwhile (then only the drag's own properties are taken out). */
function liveDrop() {
  const l = C.liveEl;
  if (!l) return;
  C.liveEl = null;
  if (l.el.getAttribute("style") === l.ours) {
    if (l.was === null) l.el.removeAttribute("style");
    else l.el.setAttribute("style", l.was);
    return;
  }
  const st = l.el.style;
  for (let i = st.length - 1; i >= 0; i--) if (st[i].startsWith(VAR)) st.removeProperty(st[i]);
}
