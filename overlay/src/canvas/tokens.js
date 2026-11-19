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
const colours = new Map();
const probeIn = (host) => {
  if (!probe) {
    probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;contain:strict";
  }
  if (probe.parentNode !== host) host.appendChild(probe);
  return probe;
};
/** A value's size, to put a scale in order: px for a length (`.5rem`, `calc(4px * 3)`), the number
 *  for a plain number, NaN for anything else. Measured on a hidden element of the layer's own,
 *  so the page is not written to; `rem` is the page's (the layer is in its document). */
export function sizeOf(value, host) {
  let n = sizes.get(value);
  if (n !== undefined) return n;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value)) n = Number(value);
  else {
    probeIn(host);
    probe.style.marginLeft = "";
    probe.style.marginLeft = value; // (a margin: negative lengths and calc() are taken)
    n = probe.style.marginLeft && !/%/.test(value) ? parseFloat(getComputedStyle(probe).marginLeft) : NaN;
  }
  if (sizes.size > 500) sizes.clear();
  sizes.set(value, n);
  return n;
}

/** A value as a colour the way getComputedStyle writes one (`rgb(42, 109, 244)`), "" when it is
 *  none. Resolved on the same hidden element, so `#2a6df4`, `oklch(…)` and `royalblue` compare. */
export function colourOf(value, host) {
  let c = colours.get(value);
  if (c !== undefined) return c;
  c = "";
  if (!/^(inherit|initial|unset|revert|revert-layer|currentcolor)$/i.test(value)) {
    probeIn(host);
    probe.style.color = "";
    probe.style.color = value;
    if (probe.style.color) c = getComputedStyle(probe).color;
  }
  if (colours.size > 500) colours.clear();
  colours.set(value, c);
  return c;
}

// ── which variable a computed value is ──────────────────────────────────────────────────────
// A computed row says `padding 16px`; when the page has a variable of that size, the row names it
// (`--space-4`): the page is on its scale there, and a click writes it as var(--space-4). Equal
// sizes are common (16px is a spacing, a font size and a radius), so a length or a number only
// counts under a name of its kind; a colour is specific enough under any name, but one of its
// kind still comes first.
const KIND = {
  gap: /space|spacing|gap|gutter|size|^--s-?\d|^--sp-?\d/i,
  padding: /space|spacing|pad|inset|gutter|size|^--s-?\d|^--sp-?\d/i,
  margin: /space|spacing|margin|gutter|size|^--s-?\d|^--sp-?\d/i,
  width: /size|width|container|space|spacing/i,
  height: /size|height|space|spacing/i,
  "font-size": /font|text|size|fs/i,
  "line-height": /leading|line|lh/i,
  "letter-spacing": /tracking|letter|spacing/i,
  "border-radius": /radius|radii|rounded|round/i,
  "font-weight": /weight|font/i,
  "font-family": /font|family|sans|serif|mono/i,
  color: /colou?r|text|fg|ink|brand|primary|accent/i,
  "background-color": /colou?r|bg|background|surface|brand|primary|accent/i,
};
const LOCAL = /\d(?:em|ex|ch|lh|ic|cap)\b|currentcolor|light-dark\(|\dcq(?:[whib]|min|max)\b/i;
const PLAIN = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const family = (v) =>
  v
    .replace(/["']/g, "")
    .replace(/\s*,\s*/g, ",")
    .trim()
    .toLowerCase();
const byName = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** The page's variables a computed value is made of: `padding: 8px 16px` with --space-2: .5rem
 *  and --space-4: 16px is ["--space-2", "--space-4"]. Null unless every part is one. `others`
 *  are the names that would do as well, for the tooltip. */
export function tokenMatch(prop, computed, toks, host) {
  const kind = KIND[prop];
  // (Sizes and colours are resolved on the layer's hidden element: one that depends on the element
  // it is used on, 1.5em or currentColor, would be the layer's there, not the page's.)
  toks = toks.filter((t) => !LOCAL.test(t.value));
  if (!kind || !toks.length) return null;
  const v = computed.trim();
  let parts, same;
  if (prop === "color" || prop === "background-color") {
    if (!v || v === "rgba(0, 0, 0, 0)") return null;
    parts = [v];
    same = (t, x) => colourOf(t.value, host) === x;
  } else if (prop === "font-family") {
    parts = [family(v)];
    same = (t, x) => kind.test(t.name) && family(t.value) === x;
  } else if (prop === "font-weight") {
    if (!PLAIN.test(v)) return null;
    parts = [v];
    same = (t, x) => kind.test(t.name) && PLAIN.test(t.value) && Number(t.value) === Number(x);
  } else {
    parts = v.split(/\s+/);
    if (parts.length > 4 || !parts.every((x) => /^-?(\d+\.?\d*|\.\d+)px$/.test(x))) return null;
    same = (t, x) =>
      kind.test(t.name) && !PLAIN.test(t.value) && Math.abs(sizeOf(t.value, host) - parseFloat(x)) < 0.05;
  }
  const best = new Map(),
    others = new Set();
  for (const x of new Set(parts)) {
    // (a colour: one named for colours first)
    const found = toks
      .filter((t) => same(t, x))
      .map((t) => t.name)
      .sort((a, b) => Number(kind.test(b)) - Number(kind.test(a)) || byName(a, b));
    if (!found.length) return null;
    best.set(x, found[0]);
    found.slice(1, 4).forEach((n) => others.add(n));
  }
  const names = parts.map((x) => best.get(x));
  return { names, others: [...others].filter((n) => !names.includes(n)) };
}
