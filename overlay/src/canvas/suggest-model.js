// ── suggestions: the pure part ──────────────────────────────────────────────────────────────
// What is at the caret of typed CSS (a property's name, its value, a selector, nothing to
// complete), which names and keywords match what is typed, and in what order. No DOM here:
// suggest.js draws the list and writes the field; test/suggest.test.mjs runs this in node.

import { continues, NAME, opens } from "./number.js";

/** The keywords every property takes. */
export const WIDE = ["inherit", "initial", "unset", "revert"];

/** CSS's named colours, all 148, and `transparent`: Chrome's list of a property's keywords has
 *  none of them (`color` has `currentcolor` only), so they are offered wherever a colour goes. */
export const COLOURS = `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue
  lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
  mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
  mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
  seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal
  thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
  transparent`
  .trim()
  .split(/\s+/);

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
 *  - { kind: "value", prop, word, s, e, first, inVar }: the token of that property's value at the
 *    caret (s === e when there is none yet); `first`: nothing of the value comes before it;
 *    `inVar`: the caret is in a `var(` (s…e the whole of it, `word` the name typed in it);
 *  - { kind: "selector" }: a rule's head, or an at-rule's;
 *  - { kind: "none" }: a comment, a string, inside brackets, a custom property, descriptors.
 * Like css.js's scan it is not a parser: it finds where the declaration at the caret starts.
 * @returns {{ kind: string, word?: string, prop?: string, s?: number, e?: number, colon?: boolean, first?: boolean, inVar?: boolean }}
 */
export function caretContext(text, caret, sheet) {
  const stack = [sheet ? "rules" : "decls"];
  let start = 0,
    paren = 0,
    colon = -1;
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
      const head = text.slice(start, i).trim(),
        top = stack[stack.length - 1];
      stack.push(opens(head, top));
      start = i + 1;
      colon = -1;
    } else if (ch === "}") {
      if (stack.length > 1) stack.pop();
      start = i + 1;
      colon = -1;
    }
  }
  const top = stack[stack.length - 1];
  // Inside brackets nothing is completed but the name in a `var(`, the innermost of them.
  const inVar = paren && top !== "raw" ? /var\(\s*(--[\w-]*)?$/i.exec(text.slice(start, caret)) : null;
  if ((paren && !inVar) || top === "raw") return NONE;
  if (top === "rules") return SELECTOR;
  // The declaration starts on the last line that begins with `name:`, as number.js has it: a
  // line without one goes on with the value above only after a comma, the colon or a bracket;
  // otherwise it is a new declaration, also when the one above has no `;` yet (`color: red⏎al`).
  for (let s = Math.max(start, text.lastIndexOf("\n", caret - 1) + 1), e = caret; s > start;) {
    const own = NAME.exec(text.slice(s, e));
    const pe = s - 1,
      ps = Math.max(start, text.lastIndexOf("\n", pe - 1) + 1);
    if (own || !continues(text.slice(ps, pe))) {
      start = s;
      colon = own ? s + own[0].length - 1 : -1;
      break;
    }
    e = pe;
    s = ps;
  }
  while (start < caret && /\s/.test(text[start])) start++;
  const head = text.slice(start, caret);
  // A nested rule's head: it starts as no property does, or a `{` follows on its line.
  if (/^[&.#:>+~*[@]/.test(head)) return SELECTOR;
  for (let i = caret; i < text.length; i++) {
    const ch = text[i];
    // (A `{` in a comment or a string after the caret opens nothing.)
    if (ch === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) break;
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
      continue;
    }
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
  if (inVar) {
    // The whole `var(--name)` is what an item replaces: up to its `)` when it has one already.
    const s = caret - inVar[0].length;
    let e = caret;
    while (e < text.length && /[\w-]/.test(text[e])) e++;
    const close = /^\s*\)/.exec(text.slice(e));
    if (close) e += close[0].length;
    return { kind: "value", prop, word: inVar[1] || "", s, e, first: !text.slice(colon + 1, s).trim(), inVar: true };
  }
  let s = caret,
    e = caret;
  while (s > colon + 1 && WORD.test(text[s - 1])) s--;
  while (e < text.length && WORD.test(text[e])) e++;
  if (text[s - 1] === "!") return NONE; // !important
  return {
    kind: "value",
    prop,
    word: text.slice(s, caret).toLowerCase(),
    s,
    e,
    first: !text.slice(colon + 1, s).trim(),
  };
}

/** The same for a field that holds one property's value and nothing else (a computed row).
 *  @returns {ReturnType<typeof caretContext>} */
export function valueContext(prop, text, caret) {
  const lead = `${prop}:`;
  const c = caretContext(lead + text, caret + lead.length, false);
  return c.kind === "value" && c.prop === prop && c.s >= lead.length
    ? { ...c, s: c.s - lead.length, e: c.e - lead.length }
    : NONE;
}

/** Whether a list opens for this context: `asked` is ctrl+space, which opens it on nothing typed. */
export function wants(ctx, asked) {
  if (ctx.kind === "name") return asked || !!ctx.word;
  if (ctx.kind === "value" && ctx.inVar) return true; // `var(`: the page's variables, at once
  if (ctx.kind !== "value" || !keywordish(ctx.word)) return false;
  return asked || !!ctx.word || !!ctx.first; // right after the colon: every value
}

/** `items` that match what is typed: those that start with it, then those that contain it,
 *  each group in the order given. Nothing typed: all of them. */
export function matches(items, word) {
  const w = word.toLowerCase();
  if (!w) return items.slice();
  const starts = [],
    has = [];
  for (const it of items) {
    const i = it.toLowerCase().indexOf(w); // (a variable's name may have capitals)
    if (i === 0) starts.push(it);
    else if (i > 0) has.push(it);
  }
  return starts.concat(has);
}

/** Property names, the most used first (Chrome's weight), then by the alphabet. */
export const propNames = (props) =>
  Object.keys(props).sort((a, b) => props[b].w - props[a].w || (a < b ? -1 : a > b ? 1 : 0));

/** The keywords offered for a property: its own as listed, `auto` and `none` where it takes
 *  them, the named colours where it takes a colour, the CSS-wide ones; all of them asked of
 *  `supports(prop, keyword)`. (A colour: `red` and `#f00` both. `red` alone is also a font's
 *  name, an animation's, a grid area's.) */
export function valuesOf(prop, props, supports) {
  const out = [];
  const add = (v) => {
    if (!out.includes(v) && supports(prop, v)) out.push(v);
  };
  for (const v of [...(props[prop]?.v ?? []), "auto", "none"]) add(v);
  if (supports(prop, "red") && supports(prop, "#f00")) for (const c of COLOURS) if (!out.includes(c)) out.push(c);
  WIDE.forEach(add);
  return out;
}

/** Whether the token of `ctx` (a value's, in `text`) is all of its value: `auto`, not the
 *  `auto` of `0 auto`. Only then can a CSS-wide keyword stand in its place (`margin: 0 revert`
 *  is nothing). `!important` is not part of the value. */
export function alone(text, ctx) {
  if (!ctx.first) return false;
  const rest = /^[^;}\n]*/.exec(text.slice(ctx.e))[0];
  return !rest.replace(/!\s*important\s*$/i, "").trim();
}

/** `values` as they can be offered at `ctx`: without the CSS-wide ones beside other tokens. */
export const valuesAt = (values, text, ctx) => (alone(text, ctx) ? values : values.filter((v) => !WIDE.includes(v)));

/** The keyword after (dir 1) or before (dir -1) `cur` in `values`, around the ends; null when
 *  `cur` is not one of them. */
export function step(values, cur, dir) {
  const i = values.indexOf(cur.toLowerCase());
  return i < 0 ? null : values[(i + dir + values.length) % values.length];
}

// ── the page's variables (design tokens) ────────────────────────────────────────────────────
// They are the page's, so only a name made of plain letters, digits, `-` and `_` is used (the
// host and the prompt take no other), and a name or a value is only ever text in the list.

/** A custom property's name that can be offered: `--space-4`. */
export const TOKEN_NAME = /^--[a-zA-Z0-9_-]{1,60}$/;

/** The `var(--name)` that holds a…b of `text` (a caret: a === b), or null. Only the plain form:
 *  one with a fallback (`var(--x, 4px)`) is not a step on a scale. */
export function varToken(text, a, b) {
  for (let s = text.lastIndexOf("var(", a); s >= 0 && s > a - 70; s = text.lastIndexOf("var(", s - 1)) {
    const m = /^var\(\s*(--[a-zA-Z0-9_-]{1,60})\s*\)/.exec(text.slice(s, s + 80));
    if (m && b <= s + m[0].length) return { s, e: s + m[0].length, name: m[1] };
    if (s === 0) break;
  }
  return null;
}

/** The scale a token is a step of: its name without the last part (`--space-4` → `--space-`,
 *  `--radius-lg` → `--radius-`). "" for a name with no parts (`--brand`): it is on no scale. */
export const family = (name) => {
  const f = name.replace(/[^-]+$/, "");
  return f.length > 2 && f !== name ? f : "";
};

const natural = new Intl.Collator("en", { numeric: true }).compare;

/** The names on `name`'s scale, smallest first: those of its family whose value `fits` the
 *  property, ordered by `size` (px, or a plain number) when all of them have one, else by name
 *  (`gray-50` before `gray-100`). `tokens`: [{ name, value }]. Empty when it is on none. */
export function scaleOf(tokens, name, fits, size) {
  const f = family(name);
  if (!f) return [];
  const on = tokens.filter((t) => t.name.startsWith(f) && !t.name.slice(f.length).includes("-") && fits(t.value));
  if (!on.some((t) => t.name === name)) return [];
  const sized = on.map((t) => ({ name: t.name, n: size(t.value) }));
  const all = sized.every((t) => Number.isFinite(t.n));
  sized.sort((x, y) => (all ? x.n - y.n : 0) || natural(x.name, y.name));
  return sized.map((t) => t.name);
}

/** A property's values with the page's variables among them: after its own keywords, before
 *  the named colours and the CSS-wide ones (`vars`: `var(--x)` items). */
export function withVars(values, vars) {
  if (!vars.length) return values;
  let i = values.findIndex((v) => WIDE.includes(v) || COLOURS.includes(v));
  if (i < 0) i = values.length;
  return [...values.slice(0, i), ...vars, ...values.slice(i)];
}
