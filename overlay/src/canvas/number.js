// ── numbers in typed CSS: the one at the caret, and a step of it ────────────────────────────
// No DOM here: text in, ranges and text out (test/number.test.mjs). Like css.js it is not a CSS
// parser; it finds where a declaration's value is and what in it is a number with a unit.

/** Functions whose numbers are a colour's channels (left alone), or not numbers at all. */
const OPAQUE = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|device-cmyk|url)$/i;
const NUM = /(?:\d+(?:\.(\d+))?|\.(\d+))/y;
const EXP = /e[+-]?\d+/iy; // `1e3`: a number, but which of its digits a step means is anyone's guess
const UNIT = /(?:%|[a-z]+)/iy;
const IDENT = /-?(?:[a-z_]|[^\x00-\x7f]|-(?=[-a-z_]))[\w-]*/iy;

// What a `{` opens, by the words before it. A conditional rule holds what its parent holds;
// @keyframes holds rule heads (its selectors); descriptors are not properties.
const GROUP = /^@(media|supports|layer|container|scope|starting-style|document)\b/i;
const KEYFRAMES = /^@(-webkit-)?keyframes\b/i;
const DESCRIPTORS = /^@(font-face|property|counter-style|page|font-palette-values|view-transition|position-try)\b/i;
/** What the `{` after `head` opens, inside a block that holds `top`: "rules" (what comes next is
 *  a selector), "decls" (declarations, and nested rules) or "raw" (an at-rule's descriptors). */
export const opens = (head, top) =>
  top === "raw" || DESCRIPTORS.test(head) ? "raw" : KEYFRAMES.test(head) ? "rules" : GROUP.test(head) ? top : "decls";

/** A line that starts a declaration: `name:`. */
export const NAME = /^\s*(?:--[\w-]*|[a-z-]+)\s*:/i;
/** Whether the line under `above` goes on with its value (`transition: a 1s,⏎ b 2s`): only after
 *  a comma, the colon or an open bracket. Any other line is a declaration of its own, also when
 *  the one above it has no `;` yet. (suggest-model.js reads typed CSS by the same rule.) */
export const continues = (above) => /[,:(]\s*$/.test(above);

/** The numbers of a value, in order: [{ start, end, value, unit, dp }] (dp: the decimals it is
 *  written with). Not the digits of a colour (`#a0b0c0`, `rgb(…)`), of a name (`h1`, `--step-2`),
 *  of a string, a url or a comment; and not a number with an exponent (`1e3`, `1.5e2px`). */
export function numbers(text, from = 0, to = text.length) {
  const out = [];
  for (let i = from; i < to; ) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? to : j + 2;
    } else if (ch === '"' || ch === "'") {
      for (i++; i < to && text[i] !== ch; i++) if (text[i] === "\\") i++;
      i++;
    } else if (ch === "#") {
      for (i++; i < to && /[\w-]/.test(text[i]); ) i++; // a hex colour (or an id): its digits are not a number
    } else {
      IDENT.lastIndex = i;
      const id = IDENT.exec(text);
      if (id) {
        i += id[0].length;
        if (text[i] === "(" && OPAQUE.test(id[0])) i = closing(text, i, to) + 1;
        continue;
      }
      // A sign belongs to the number only where a value can start (`0 -4px`, not `10px-4px`).
      const signed = (ch === "-" || ch === "+") && (i === from || /[\s(,/:]/.test(text[i - 1]));
      NUM.lastIndex = signed ? i + 1 : i;
      const m = NUM.exec(text);
      if (!m || NUM.lastIndex > to) {
        i++;
        continue;
      }
      let end = NUM.lastIndex;
      EXP.lastIndex = end;
      if (EXP.exec(text)) {
        UNIT.lastIndex = EXP.lastIndex;
        i = UNIT.exec(text) ? UNIT.lastIndex : EXP.lastIndex;
        continue;
      }
      UNIT.lastIndex = end;
      const u = UNIT.exec(text);
      const unit = u && UNIT.lastIndex <= to ? u[0] : "";
      end += unit.length;
      out.push({ start: i, end, value: Number(text.slice(i, end - unit.length)), unit, dp: (m[1] || m[2] || "").length });
      i = end;
    }
  }
  return out;
}

/** Where the bracket opened at `i` closes (or the end, when it does not). */
function closing(text, i, to) {
  let depth = 0;
  for (; i < to; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < to && text[i] !== ch; i++) if (text[i] === "\\") i++;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return to;
}

/** The part of typed CSS around `caret` that is a declaration's value: [from, to), or null in a
 *  selector, a property name, an at-rule's head, a comment, or (in a stylesheet) outside a rule.
 *  A value ends at `;`, `}` or the end of its line; a line that does not start with `name:`
 *  continues the declaration above it where that ends with a comma (`transition: a 1s,⏎ b 2s`). */
function valueAt(text, caret, sheet) {
  const stack = [sheet ? "rules" : "decls"]; // what the blocks around the caret hold
  let start = 0, paren = 0, end = -1, last = "";
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      const close = j < 0 ? text.length : j + 2;
      if (caret > i && caret < close) return null; // in the comment
      i = close - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    if (ch !== undefined && (paren || (ch !== ";" && ch !== "{" && ch !== "}"))) continue;
    if (caret <= i) {
      end = i;
      last = ch;
      break;
    }
    if (ch === "{") stack.push(opens(text.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, "").trim(), stack[stack.length - 1]));
    else if (ch === "}" && stack.length > 1) stack.pop();
    start = i + 1;
  }
  // (Where a rule's head is expected, `li:nth-child(2)` is a selector, with its `{` or without.)
  if (end < 0 || last === "{" || stack[stack.length - 1] === "rules") return null;
  // The caret's line, inside the segment.
  const ls = Math.max(start, text.lastIndexOf("\n", caret - 1) + 1);
  const nl = text.indexOf("\n", caret);
  const le = nl < 0 || nl > end ? end : nl;
  const own = NAME.exec(text.slice(ls, le));
  if (own) return caret >= ls + own[0].length ? [ls + own[0].length, le] : null;
  // A line of its own with no name: a value only when it goes on from the lines above it, back
  // to one that has a name.
  for (let s = ls; s > start; ) {
    const e = s - 1;
    s = Math.max(start, text.lastIndexOf("\n", e - 1) + 1);
    const above = text.slice(s, e);
    if (!continues(above)) return null;
    if (NAME.test(above)) return [ls, le];
  }
  return null;
}

/** The number the caret is in or touches: { start, end, value, unit }, or null.
 *  context: "value" (the text is one value), "css" (declarations, as in Element styles) or
 *  "sheet" (rules). With a selection (`to`), only a number that holds all of it. With `first`,
 *  the first number of the value when the caret is on none (for "value"). */
export function numberAt(text, caret, { context = "value", to = caret, first = false } = {}) {
  let range = [0, text.length];
  if (context !== "value") {
    const v = valueAt(text, caret, context === "sheet");
    if (!v || to > v[1]) return null;
    range = v;
  }
  const all = numbers(text, range[0], range[1]);
  // Touching two (`1px` then, with nothing between, another): the one the caret is at the start of.
  const hit = all.filter((t) => t.start <= caret && to <= t.end).pop();
  return hit || (first && all[0]) || null;
}

/** The token moved by `delta`, as text: its unit kept, two decimals at most or as many as it
 *  was written with (`0.333333` + 1 is `1.333333`, `0.001s` + 1 is `1.001s`), no trailing zeros. */
export function step(token, delta) {
  const s = (token.value + delta).toFixed(Math.min(Math.max(2, token.dp || 0), 12));
  const n = s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  return `${Number(n) === 0 ? "0" : n}${token.unit}`; // (no "-0")
}

/** How far one press of ↑ goes: 1; shift 10; alt 0.1; ctrl or ⌘ 100. */
export const stepSize = ({ shift = false, alt = false, mod = false }) => (mod ? 100 : shift ? 10 : alt ? 0.1 : 1);
