// ── icons and keys ──────────────────────────────────────────────────────────────────────────
// Every icon of the layer: inline SVG on a 16px grid, stroked in the text colour. No glyphs.
export const ICONS = {
  "chevron-down": '<path d="m4 6 4 4 4-4"/>',
  "chevron-up": '<path d="m4 10 4-4 4 4"/>',
  "chevron-right": '<path d="m6 4 4 4-4 4"/>',
  "chevron-left": '<path d="m10 4-4 4 4 4"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  undo: '<path d="M6 3.5 3 6.5l3 3"/><path d="M3 6.5h6.25a3.25 3.25 0 0 1 0 6.5H7"/>',
  redo: '<path d="m10 3.5 3 3-3 3"/><path d="M13 6.5H6.75a3.25 3.25 0 0 0 0 6.5H9"/>',
  help: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.9 1.9 0 0 1 3.7.6c0 1.2-1.8 1.5-1.8 2.7"/><path d="M8.1 11.7v.1"/>',
  // The Mac's key symbols, drawn: the page's fonts may not have them, and fallbacks draw specks.
  "⌘": '<path d="M6 6V4a2 2 0 1 0-2 2h8a2 2 0 1 0-2-2v8a2 2 0 1 0 2-2H4a2 2 0 1 0 2 2z"/>',
  "⇧": '<path d="M8 2.7 13.3 8h-3v5.3H5.7V8H2.7z"/>',
  "⌥": '<path d="M2 3.3h3.7l4.6 9.4H14M9.7 3.3H14"/>',
  "↵": '<path d="M13.3 3.3v4a2.7 2.7 0 0 1-2.7 2.7H2.7M5.7 7l-3 3 3 3"/>',
};
export const icon = (name, size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const KEY_NAMES = { "⌘": "command", "⇧": "shift", "⌥": "option", "↵": "return" };
/** Words with key symbols in them ("↵ send", "⌘Z"), as nodes: the symbols drawn at the size of
 *  the letters, the rest as text (never markup, so any words are safe here). */
export function keyNodes(text) {
  const out = document.createDocumentFragment();
  for (const part of String(text).split(/([⌘⇧⌥↵])/)) {
    if (!part) continue;
    if (!KEY_NAMES[part]) {
      out.append(part);
      continue;
    }
    const t = document.createElement("template");
    t.innerHTML = icon(part, 12);
    const svg = /** @type {Element} */ (t.content.firstChild);
    svg.classList.add("kg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", KEY_NAMES[part]);
    svg.removeAttribute("aria-hidden");
    out.append(svg);
  }
  return out;
}

