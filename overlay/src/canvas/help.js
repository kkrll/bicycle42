// ── the keys and gestures of annotate and edit mode ─────────────────────────────────────────
// What the bar's "?" lists (bar.js), and the host's inspector's when it draws one: pure, no DOM,
// so the host can import it. A Mac writes a chord without "+" (⌘⇧Z), everyone else with it
// (ctrl+shift+Z); "⌘", "⇧", "⌥" and "↵" are drawn as keys where the list is shown.

/** Annotate mode's keys, as [keys, what they do]. @param {boolean} mac @returns {[string, string][]} */
export function notesKeys(mac) {
  const m = mac ? "⌘" : "ctrl+", alt = mac ? "⌥" : "alt+";
  return [
    ["click", `select · ${mac ? "⇧ click" : "shift+click"} adds`],
    ["drag", "select everything in an area"],
    [`${mac ? "⌥ drag" : "alt+drag"}, or the pencil`, "draw · a closed loop selects what it encloses"],
    ["↑ ↓", "parent, child (with the note empty)"],
    ["↵", `send · ${alt}↵ sends in parallel`],
    ["/", "templates"],
    [`${m}Z`, "undo a stroke, or bring back a dropped note"],
    ["esc", "cancel the note, then leave review mode"],
    [`hold ${alt}A`, "peek: the page without the layer"],
    [`${m}U · ${m}P · ${m}O · ${m}I`, "preview · annotate · edit · motion"],
  ];
}

/** Edit mode's keys and gestures, as [keys, what they do]. @param {boolean} mac @returns {[string, string][]} */
export function editKeys(mac) {
  const m = mac ? "⌘" : "ctrl+", sh = mac ? "⇧" : "shift+", alt = mac ? "⌥" : "alt+";
  return [
    ["click", `select · ${mac ? "⌘ click" : "ctrl+click"} through whatever is in the way, again: the one behind`],
    [`↵ · ${sh}↵`, "into the selection, out of it (↑ ↓ too) · ↵ on text edits it"],
    ["drag", "reorder among its siblings"],
    ["drag an edge or corner", `resize · hold ${mac ? "⌘" : "ctrl"} for no snapping`],
    ["drag the space between items", "change the gap"],
    ["drag a padding or margin band", `change it · ${sh.replace("+", "")} both sides`],
    ["double-click text", "edit its words, around what is inside it · ↵ keep, esc revert"],
    ["Delete", "hide the selection · a copy: take it out"],
    [`${m}D`, "duplicate the selection: a copy right after it"],
    ["↑ ↓ in a computed value", `step its number · ${sh.replace("+", "")} 10, ${alt.replace("+", "")} 0.1, ${m.replace("+", "")} 100 · a keyword: the one before, after`],
    ["double-click a number or keyword in the style boxes, then ↑ ↓", "the same there"],
    ["drag a computed value's name", "change its number"],
    ["typing CSS · ctrl Space", "suggestions · ↑ ↓ show on the page, ↵ take, esc put back"],
    ["-- or var( in a value", "the page's variables · on a selected var(--…), ↑ ↓ go along its scale"],
    [`${m}Z · ${m}${sh}Z`, "undo · redo"],
    [`${m}↵`, `send · ↵ in the note · with ${alt.replace("+", "")} in parallel`],
    ["esc", "leave the field, deselect, back to annotate"],
    [`hold ${alt}A`, "peek: the page without the layer, edits on"],
    [`${m}U · ${m}P · ${m}O · ${m}I`, "preview · annotate · edit · motion"],
  ];
}
