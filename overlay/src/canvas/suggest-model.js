// ── suggestions: the pure part ──────────────────────────────────────────────────────────────
// What is at the caret of typed CSS (a property's name, its value, a selector, nothing to
// complete), which names and keywords match what is typed, and in what order. No DOM here:
// suggest.js draws the list and writes the field; test/suggest.test.mjs runs this in node.

/** The keywords every property takes. */
export const WIDE = ["inherit", "initial", "unset", "revert"];

// What a `{` opens, by the words before it. A conditional rule holds what its parent holds;
// @keyframes holds rule heads (its selectors); descriptors are not properties.
const GROUP = /^@(media|supports|layer|container|scope|starting-style|document)\b/i;
const KEYFRAMES = /^@(-webkit-)?keyframes\b/i;
const DESCRIPTORS = /^@(font-face|property|counter-style|page|font-palette-values|view-transition|position-try)\b/i;
/** @type {ReturnType<typeof caretContext>} */
const NONE = Object.freeze({ kind: "none" });
/** @type {ReturnType<typeof caretContext>} */
const SELECTOR = Object.freeze({ kind: "selector" });
const WORD = /[\w.%#-]/; // what a value's token is made of: a keyword, a number with its unit, a hex colour

/** A number (with or without a unit): stepped by the arrows, never completed. */
export const isNumber = (t) => /^[+-]?(\d|\.\d)/.test(t);
/** Something a keyword could start with (or nothing yet). */
const keywordish = (t) => /^-?[a-z_]?[\w-]*$/i.test(t) && !isNumber(t);

/**
 * What the caret is in. `sheet`: the text is a stylesheet (rules), not one element's declarations
 * (which may nest rules with `&`).
 *  - { kind: "name", word, s, e, colon }: a property's name; `word` is what is typed of it (up to
 *    the caret), s…e the whole name in the text, `colon` whether a `:` already follows it;
 *  - { kind: "value", prop, word, s, e, first }: the token of that property's value at the caret
 *    (s === e when there is none yet); `first`: nothing of the value comes before it;
 *  - { kind: "selector" }: a rule's head, or an at-rule's;
 *  - { kind: "none" }: a comment, a string, inside brackets, a custom property, descriptors.
 * Like css.js's scan it is not a parser: it finds where the declaration at the caret starts.
 * @returns {{ kind: string, word?: string, prop?: string, s?: number, e?: number, colon?: boolean, first?: boolean }}
 */
export function caretContext(text, caret, sheet) {
  const stack = [sheet ? "rules" : "decls"];
  let start = 0, paren = 0, colon = -1;
  for (let i = 0; i < caret; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0 || j + 2 > caret) return NONE;
      if (!text.slice(start, i).trim()) start = j + 2; // a comment before the declaration is not part of it
      i = j + 1;
    } else if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
      if (i >= caret) return NONE;
    } else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (paren) continue;
    else if (ch === ":") {
      if (colon < 0) colon = i;
    } else if (ch === ";") {
      start = i + 1;
      colon = -1;
    } else if (ch === "{") {
      const head = text.slice(start, i).trim(), top = stack[stack.length - 1];
      stack.push(top === "raw" || DESCRIPTORS.test(head) ? "raw" : KEYFRAMES.test(head) ? "rules" : GROUP.test(head) ? top : "decls");
      start = i + 1;
      colon = -1;
    } else if (ch === "}") {
      if (stack.length > 1) stack.pop();
      start = i + 1;
      colon = -1;
    }
  }
  const top = stack[stack.length - 1];
  if (paren || top === "raw") return NONE;
  if (top === "rules") return SELECTOR;
  while (start < caret && /\s/.test(text[start])) start++;
  const head = text.slice(start, caret);
  // A nested rule's head: it starts as no property does, or a `{` follows on its line.
  if (/^[&.#:>+~*[@]/.test(head)) return SELECTOR;
  for (let i = caret; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") return SELECTOR;
    if (ch === ";" || ch === "}" || ch === "\n") break;
  }
  if (colon < 0) {
    if (!/^[a-z-]*$/i.test(head) || head.startsWith("--")) return NONE;
    let e = caret;
    while (e < text.length && /[\w-]/.test(text[e])) e++;
    let k = e;
    while (k < text.length && (text[k] === " " || text[k] === "\t")) k++;
    return { kind: "name", word: head.toLowerCase(), s: start, e, colon: text[k] === ":" };
  }
  const prop = text.slice(start, colon).trim().toLowerCase();
  if (!/^-?[a-z][a-z-]*$/.test(prop)) return NONE;
  let s = caret, e = caret;
  while (s > colon + 1 && WORD.test(text[s - 1])) s--;
  while (e < text.length && WORD.test(text[e])) e++;
  if (text[s - 1] === "!") return NONE; // !important
  return { kind: "value", prop, word: text.slice(s, caret).toLowerCase(), s, e, first: !text.slice(colon + 1, s).trim() };
}

/** The same for a field that holds one property's value and nothing else (a computed row).
 *  @returns {ReturnType<typeof caretContext>} */
export function valueContext(prop, text, caret) {
  const lead = `${prop}:`;
  const c = caretContext(lead + text, caret + lead.length, false);
  return c.kind === "value" && c.prop === prop && c.s >= lead.length ? { ...c, s: c.s - lead.length, e: c.e - lead.length } : NONE;
}

/** Whether a list opens for this context: `asked` is ctrl+space, which opens it on nothing typed. */
export function wants(ctx, asked) {
  if (ctx.kind === "name") return asked || !!ctx.word;
  if (ctx.kind !== "value" || !keywordish(ctx.word)) return false;
  return asked || !!ctx.word || !!ctx.first; // right after the colon: every value
}

/** `items` that match what is typed: those that start with it, then those that contain it,
 *  each group in the order given. Nothing typed: all of them. */
export function matches(items, word) {
  const w = word.toLowerCase();
  if (!w) return items.slice();
  const starts = [], has = [];
  for (const it of items) {
    const i = it.indexOf(w);
    if (i === 0) starts.push(it);
    else if (i > 0) has.push(it);
  }
  return starts.concat(has);
}

/** Property names, the most used first (Chrome's weight), then by the alphabet. */
export const propNames = (props) =>
  Object.keys(props).sort((a, b) => props[b].w - props[a].w || (a < b ? -1 : a > b ? 1 : 0));

/** The keywords offered for a property: its own as listed, `auto` and `none` where it takes
 *  them, the CSS-wide ones; all of them asked of `supports(prop, keyword)`. */
export function valuesOf(prop, props, supports) {
  const out = [];
  for (const v of [...(props[prop]?.v ?? []), "auto", "none", ...WIDE]) if (!out.includes(v) && supports(prop, v)) out.push(v);
  return out;
}

/** The keyword after (dir 1) or before (dir -1) `cur` in `values`, around the ends; null when
 *  `cur` is not one of them. */
export function step(values, cur, dir) {
  const i = values.indexOf(cur.toLowerCase());
  return i < 0 ? null : values[(i + dir + values.length) % values.length];
}
