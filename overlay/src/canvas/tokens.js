import { TOKEN_NAME } from "./suggest-model.js";

// ── the page's variables (design tokens) ────────────────────────────────────────────────────
// Read off the selected element: Chrome lists every custom property in effect on an element in
// its computed style, with the `var()`s in its value already put in. So these are the ones that
// reach this element (a theme's, a component's own, those of a media query that holds now),
// whichever stylesheet they come from, and nothing else of the page is read.

const MAX = 2000; // a page with more is not one whose tokens anyone picks from a list
const MAX_VALUE = 200;

/** The variables in effect on `el`: [{ name, value }] by name. Only names TOKEN_NAME takes. */
export function tokensOf(el) {
  if (!el || !el.isConnected) return [];
  const cs = getComputedStyle(el);
  const out = [];
  for (let i = cs.length - 1; i >= 0 && out.length < MAX; i--) {
    const name = cs[i];
    // (Tailwind's own `--tw-*` are its plumbing, on every element, not a design's tokens.)
    if (!name.startsWith("--") || name.startsWith("--tw-") || !TOKEN_NAME.test(name)) continue;
    const value = cs.getPropertyValue(name).trim();
    if (value && value.length <= MAX_VALUE && !/[\n\r]/.test(value)) out.push({ name, value });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

let probe = null;
const sizes = new Map();
/** A value's size, to put a scale in order: px for a length (`.5rem`, `calc(4px * 3)`), the number
 *  for a plain number, NaN for anything else. Measured on a hidden element of the layer's own,
 *  so the page is not written to; `rem` is the page's (the layer is in its document). */
export function sizeOf(value, host) {
  let n = sizes.get(value);
  if (n !== undefined) return n;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value)) n = Number(value);
  else {
    if (!probe) {
      probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;contain:strict";
    }
    if (probe.parentNode !== host) host.appendChild(probe);
    probe.style.marginLeft = "";
    probe.style.marginLeft = value; // (a margin: negative lengths and calc() are taken)
    n = probe.style.marginLeft && !/%/.test(value) ? parseFloat(getComputedStyle(probe).marginLeft) : NaN;
  }
  if (sizes.size > 500) sizes.clear();
  sizes.set(value, n);
  return n;
}
