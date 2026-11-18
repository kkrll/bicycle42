// ── numbers in typed CSS: the one at the caret, and a step of it ────────────────────────────
// No DOM here: text in, ranges and text out (test/number.test.mjs). Like css.js it is not a CSS
// parser; it finds where a declaration's value is and what in it is a number with a unit.

/** Functions whose numbers are a colour's channels (left alone), or not numbers at all. */
const OPAQUE = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|device-cmyk|url)$/i;
const NUM = /(?:\d+(?:\.\d+)?|\.\d+)/y;
const UNIT = /(?:%|[a-z]+)/iy;
const IDENT = /-?(?:[a-z_]|[^\x00-\x7f]|-(?=[-a-z_]))[\w-]*/iy;

/** The numbers of a value, in order: [{ start, end, value, unit }]. Not the digits of a colour
 *  (`#a0b0c0`, `rgb(…)`), of a name (`h1`, `--step-2`), of a string, a url or a comment. */
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
      UNIT.lastIndex = end;
      const u = UNIT.exec(text);
      const unit = u && UNIT.lastIndex <= to ? u[0] : "";
      end += unit.length;
      out.push({ start: i, end, value: Number(text.slice(i, end - unit.length)), unit });
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
 *  continues the declaration above it (`transition: a 1s,⏎ b 2s`). */
function valueAt(text, caret, sheet) {
  let depth = 0, start = 0, paren = 0, end = -1, last = "";
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
    start = i + 1;
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
  }
  if (end < 0 || last === "{" || (sheet && depth === 0)) return null;
  const NAME = /^\s*(?:--[\w-]*|[a-z-]+)\s*:/i;
  // The caret's line, inside the segment.
  const ls = Math.max(start, text.lastIndexOf("\n", caret - 1) + 1);
  const nl = text.indexOf("\n", caret);
  const le = nl < 0 || nl > end ? end : nl;
  const own = NAME.exec(text.slice(ls, le));
  if (own) return caret >= ls + own[0].length ? [ls + own[0].length, le] : null;
  // A line of its own with no name: a value only when the lines above it, back to the last one
  // that has a name, belong to a declaration.
  for (let s = ls; s > start; ) {
    const e = s - 1;
    s = Math.max(start, text.lastIndexOf("\n", e - 1) + 1);
    if (NAME.test(text.slice(s, e))) return [ls, le];
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

/** The token moved by `delta`, as text: its unit kept, at most two decimals, no trailing zeros. */
export function step(token, delta) {
  const n = Math.round((token.value + delta) * 100) / 100;
  return `${n === 0 ? 0 : n}${token.unit}`; // (no "-0")
}

/** How far one press of ↑ goes: 1; shift 10; alt 0.1; ctrl or ⌘ 100. */
export const stepSize = ({ shift = false, alt = false, mod = false }) => (mod ? 100 : shift ? 10 : alt ? 0.1 : 1);
