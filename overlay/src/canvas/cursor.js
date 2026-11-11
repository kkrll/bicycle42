// ── the page's cursor, and a drag's live rule ───────────────────────────────────────────────
// In canvas mode the page's cursor is the plain arrow, by one rule that never changes (changing a
// rule that matches every element restyles the whole document). The arrows over a handle or a
// gap come from the layer's own elements; during a drag a shield over the viewport carries the
// cursor. The second rule gives the page room to scroll its last part out from under the dock.
const dock = () => (C.collapsed ? 30 : C.ph);
function syncUi() {
  if (!(C.on && S.enabled)) {
    if (C.ui) adopt(C.ui, false);
    return;
  }
  if (!C.ui) {
    C.ui = new CSSStyleSheet();
    C.ui.replaceSync("html[data-b42-review], html[data-b42-review] * { cursor: default !important; } html[data-b42-review] { padding-bottom: 0px !important; }");
  }
  adopt(C.ui, true);
  const room = `${dock()}px`;
  if (room !== C.room) C.ui.cssRules[1].style.setProperty("padding-bottom", (C.room = room), "important");
}

/** The caret cursor over text being edited in place: a rule for that element only. */
function editCursor(rs) {
  if (!C.caret) C.caret = new CSSStyleSheet();
  if (rs)
    try {
      C.caret.replaceSync(`${rs}${BOOST}, ${rs}${BOOST} * { cursor: text !important; }`);
    } catch {}
  adopt(C.caret, !!rs);
}

function shield(cursor) {
  shieldEl.hidden = !cursor;
  if (cursor) shieldEl.style.cursor = cursor;
}

// A drag previews through one rule of its own, changed in place each frame; on release the
// value is written into the element's styles and the rule goes.
function liveSet(sel, prop, val) {
  if (!C.live) {
    C.live = new CSSStyleSheet();
    C.live.replaceSync("b42-none {}");
  }
  const rule = C.live.cssRules[0];
  if (rule.selectorText !== sel) rule.selectorText = sel;
  adopt(C.live, true);
  if (val == null) rule.style.removeProperty(prop);
  else rule.style.setProperty(prop, val, "important");
}
function liveEnd() {
  if (!C.live) return;
  adopt(C.live, false);
  C.live.cssRules[0].style.cssText = "";
}

