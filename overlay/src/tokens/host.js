// ── the page's design system: its variables, for the host's view of them ────────────────────────
// A view of the host's in place of the page (TokensView in ../../protocol-tokens.ts). The layer
// draws nothing for it: it reads the variables when the host's view asks ("view", "refresh"), and
// sets a value on the page when the view says so ("set").
//
// Read from the stylesheets' rules, not off an element: a rule says where a variable is declared
// (`:root`, `.dark`, inside a media query) and what is written there (`var(--gray-900)`), which
// the computed style of an element does not. What it comes to is then asked of the root element.
// A stylesheet of another origin has no rules to read: the variables the root element has in
// effect and no rule named are listed all the same, with nowhere to say they are from.
//
// A value the view sets is a rule in a stylesheet of the layer's own, adopted after the page's:
// The view goes at once (putView), not with the next frame as a dock's does: the page is not
// shown while its variables are, and a page that is not shown is given no frames.
// for every selector that declares the variable (so a theme's rule does not win over it), and
// `:root`. It is on the page until it is put back or the document goes.

import { adopt, restyled } from "../page.js";
import { hosted, onAct, onHosted, putView } from "../panel.js";
import { root } from "../mount.js";
import { TOKEN_NAME } from "../canvas/suggest-model.js";
import { colourOf, sizeOf, tokensOf } from "../canvas/tokens.js";

/** Variables listed; a page with more says so. */
const MAX = 2000;
/** Rules read in one look (a stylesheet of a hundred thousand rules is not walked whole). */
const MAX_RULES = 60000;
const MAX_VALUE = 400;
/** Rules listed for one variable. */
const MAX_WHERE = 8;

const T = {
  want: false,
  sheet: null, // the layer's stylesheet of set values
  set: new Map(), // name → the value the reviewer set
  was: new Map(), // name → what it came to before it was set
  scopes: new Map(), // name → the selectors that declare it (plain rules only), as last read
};

const short = (s) => String(s).replace(/\s+/g, " ").trim();

// ── what a value is ─────────────────────────────────────────────────────────────────────────
const KEYWORD = /^(inherit|initial|unset|revert|revert-layer|none|auto|normal)$/i;
/** `0 0% 100%`, `240 5.9% 10%`, `210deg 40% 98% / 0.5`: a colour's numbers, for `hsl()` to wrap. */
const HSL_PARTS = /^-?[\d.]+(deg|turn|rad)?[\s,]+[\d.]+%[\s,]+[\d.]+%(\s*\/\s*[\d.]+%?)?$/;
/** `255 255 255`, `15, 23, 42`: for `rgb()`. */
const RGB_PARTS = /^\d{1,3}[\s,]+\d{1,3}[\s,]+\d{1,3}(\s*\/\s*[\d.]+%?)?$/;
const supports = (prop, v) => {
  try {
    return CSS.supports(prop, v);
  } catch {
    return false;
  }
};

function kindOf(name, value) {
  const v = value.trim();
  // (With a var() still in it, it is anything: every property takes one.)
  if (!v || KEYWORD.test(v) || v.includes("var(")) return { kind: "other" };
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) return { kind: "number", size: Number(v) };
  if (supports("color", v) && !/^(currentcolor)$/i.test(v)) return { kind: "colour" };
  if (HSL_PARTS.test(v) && supports("color", `hsl(${v})`)) return { kind: "colour", css: `hsl(${v})` };
  if (RGB_PARTS.test(v) && /colou?r|rgb|bg|fg|text|ink|surface|brand|primary|accent/i.test(name) && supports("color", `rgb(${v})`)) return { kind: "colour", css: `rgb(${v})` };
  if (/^[+-]?(\d+\.?\d*|\.\d+)m?s$/.test(v)) return { kind: "time" };
  if (/^(cubic-bezier|linear|steps)\(/.test(v) || /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/.test(v)) return { kind: "ease" };
  if (supports("width", v) || supports("margin-left", v)) {
    const size = sizeOf(v, root);
    return Number.isFinite(size) ? { kind: "size", size } : { kind: "size" };
  }
  if (/shadow|elevation/i.test(name) && supports("box-shadow", v)) return { kind: "shadow" };
  if (/font|family|sans|serif|mono|typeface/i.test(name) && supports("font-family", v)) return { kind: "font" };
  if (supports("box-shadow", v) && /\d/.test(v) && /\s/.test(v)) return { kind: "shadow" };
  return { kind: "other" };
}

// ── values written out with no variable ─────────────────────────────────────────────────────
/** The properties whose literal values count, and as what. */
const LOOSE = new Map();
for (const p of ["color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke", "text-decoration-color", "caret-color"]) LOOSE.set(p, "colour");
for (const p of ["padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "row-gap", "column-gap"]) LOOSE.set(p, "space");
for (const p of ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"]) LOOSE.set(p, "radius");
LOOSE.set("font-size", "text");
/** A variable's name says it is of that kind. */
const FAMILY = {
  space: /space|spacing|gap|gutter|pad|inset|size|^--s-?\d|^--sp-?\d/i,
  radius: /radius|radii|round/i,
  text: /font|text|fs|type/i,
};
const LENGTH = /^(\d+\.?\d*|\.\d+)(px|rem)$/;
const MAX_LOOSE = 60;

/** What a literal value is, to count it under: a colour as the engine writes it, a size in px.
 *  "" for what is not counted (a keyword, something see-through, a hairline, a pill's radius). */
function looseKey(kind, value) {
  if (kind === "colour") {
    if (/^(transparent|currentcolor|inherit|initial|unset|revert|none)$/i.test(value)) return "";
    const c = colourOf(value, root);
    return c && !/^rgba\(.*,\s*0\)$/.test(c) ? c : "";
  }
  if (!LENGTH.test(value)) return "";
  const px = sizeOf(value, root);
  if (!Number.isFinite(px) || px < 2 || (kind === "radius" && px >= 100)) return "";
  return String(Math.round(px * 100) / 100);
}

// ── the look ────────────────────────────────────────────────────────────────────────────────
const USES = /var\(\s*(--[a-zA-Z0-9_-]+)/g;

/** Every readable rule of the page: fn(rule, context), `context` the at-rules it is inside
 *  ("@media (min-width: 40rem)"). Returns how many stylesheets could not be read. */
function walkRules(fn) {
  let seen = 0, unread = 0;
  const walk = (list, context) => {
    for (let i = 0; i < list.length && seen < MAX_RULES; i++) {
      const r = list[i];
      seen++;
      if (r.type === CSSRule.IMPORT_RULE) {
        try {
          if (r.styleSheet) walk(r.styleSheet.cssRules, context);
        } catch {
          unread++;
        }
        continue;
      }
      let inner = context;
      if (r.type === CSSRule.MEDIA_RULE) inner = `${context}@media ${short(r.conditionText || r.media?.mediaText || "")} `;
      else if (r.type === CSSRule.SUPPORTS_RULE) inner = `${context}@supports ${short(r.conditionText || "")} `;
      else if (typeof CSSContainerRule !== "undefined" && r instanceof CSSContainerRule) inner = `${context}@container ${short(r.conditionText || "")} `;
      if (r.style) fn(r, context);
      if (r.cssRules?.length) walk(r.cssRules, inner);
    }
  };
  const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
  for (const s of sheets) {
    const owner = /** @type {any} */ (s.ownerNode);
    if (s === T.sheet || owner?.closest?.("b42-review")) continue;
    try {
      walk(s.cssRules, "");
    } catch {
      unread++; // another origin's: no rules to read
    }
  }
  return unread;
}

/** The selector a nested rule (`&:hover` inside `.card`) is for, as far as it reads. */
function selectorOf(rule) {
  let sel = rule.selectorText || "";
  for (let p = rule.parentRule; p && sel.includes("&"); p = p.parentRule) if (p.selectorText) sel = sel.replaceAll("&", p.selectorText);
  return short(sel);
}

function look() {
  if (!T.want) return;
  const found = new Map(); // name → { where, uses }
  const loose = new Map(); // kind and value → { kind, key, rules, said, where }
  const entry = (name) => {
    let e = found.get(name);
    if (!e) found.set(name, (e = { where: [], uses: 0, sels: [] }));
    return e;
  };
  const unread = walkRules((rule, context) => {
    const style = rule.style;
    let text = "";
    if (rule.type === CSSRule.STYLE_RULE) {
      let sel = "";
      const once = new Set(); // a value counts once a rule, on however many sides it is
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        const kind = LOOSE.get(name);
        if (kind) {
          const value = short(style.getPropertyValue(name));
          if (!value || value.includes("var(")) continue;
          const key = looseKey(kind, value);
          if (!key || once.has(`${kind} ${key}`)) continue;
          once.add(`${kind} ${key}`);
          let l = loose.get(`${kind} ${key}`);
          if (!l) loose.set(`${kind} ${key}`, (l = { kind, key, rules: 0, said: new Map(), where: [] }));
          l.rules++;
          l.said.set(value, (l.said.get(value) || 0) + 1);
          if (l.where.length < 3) l.where.push((context + (sel ||= selectorOf(rule))).slice(0, 80));
          continue;
        }
        if (!name.startsWith("--") || name.startsWith("--tw-") || !TOKEN_NAME.test(name)) continue;
        const value = short(style.getPropertyValue(name));
        if (!value || value.length > MAX_VALUE) continue;
        sel ||= selectorOf(rule);
        const e = entry(name);
        if (e.where.length < MAX_WHERE) e.where.push({ scope: (context + sel).slice(0, 160), value });
        if (!context && e.sels.length < MAX_WHERE) e.sels.push(sel);
      }
    } else if (typeof CSSPropertyRule !== "undefined" && rule instanceof CSSPropertyRule) return;
    try {
      text = style.cssText;
    } catch {
      return;
    }
    if (!text.includes("var(")) return;
    const names = new Set();
    for (const m of text.matchAll(USES)) names.add(m[1]);
    for (const name of names) if (found.has(name) || TOKEN_NAME.test(name)) entry(name).uses++;
  });
  // What the root element has in effect: the value each comes to, and the variables no readable
  // rule declared.
  const rootEl = document.documentElement;
  const cs = getComputedStyle(rootEl);
  const bodyCs = document.body ? getComputedStyle(document.body) : null;
  for (const { name } of tokensOf(rootEl)) entry(name);
  T.scopes = new Map();
  const tokens = [];
  let partial = false;
  for (const name of [...found.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    const e = found.get(name);
    // (Used and never declared: another origin's, or a typo. Not a variable of the page's to list.)
    let value = short(cs.getPropertyValue(name)) || (bodyCs ? short(bodyCs.getPropertyValue(name)) : "");
    const local = !value;
    // A component's own: what it comes to on the first element one of its rules is for.
    if (local) {
      for (const sel of e.sels) {
        let el = null;
        try {
          el = document.querySelector(sel);
        } catch {}
        if (el && !el.closest("b42-review")) value = short(getComputedStyle(el).getPropertyValue(name));
        if (value) break;
      }
      value ||= e.where[0]?.value || "";
    }
    if (!value || value.length > MAX_VALUE) continue;
    if (tokens.length >= MAX) {
      partial = true;
      break;
    }
    T.scopes.set(name, e.sels);
    /** @type {any} */
    const t = { name, ...kindOf(name, value), value, where: e.where, uses: e.uses };
    if (local) t.local = true;
    if (T.set.has(name)) {
      t.set = T.set.get(name);
      t.was = T.was.get(name) ?? "";
    }
    tokens.push(t);
  }
  putView("tokens", { tokens, loose: looseOf(loose, tokens), unread, partial });
}

/** The literal values worth saying: those a variable already says, and those written often
 *  enough to want one (a size only where the page has a scale of its kind). */
function looseOf(loose, tokens) {
  const colours = new Map(), sizes = { space: new Map(), radius: new Map(), text: new Map() };
  const put = (map, key, name) => void (map.get(key) || map.set(key, []).get(key)).push(name);
  for (const t of tokens) {
    if (t.local || t.set !== undefined) continue;
    if (t.kind === "colour") {
      const c = colourOf(t.css || t.value, root);
      if (c) put(colours, c, t.name);
    } else if (t.kind === "size" && Number.isFinite(t.size)) {
      for (const k of ["space", "radius", "text"]) if (FAMILY[k].test(t.name)) put(sizes[k], String(Math.round(t.size * 100) / 100), t.name);
    }
  }
  const out = [];
  for (const l of loose.values()) {
    const names = (l.kind === "colour" ? colours.get(l.key) : sizes[l.kind].get(l.key)) || [];
    const scale = l.kind === "colour" || sizes[l.kind].size > 0;
    if (!names.length && (!scale || l.rules < (l.kind === "colour" ? 2 : 3))) continue;
    const value = [...l.said].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ kind: l.kind, value, rules: l.rules, where: l.where, tokens: names.sort((a, b) => a.length - b.length).slice(0, 4) });
  }
  return out.sort((a, b) => b.rules - a.rules).slice(0, MAX_LOOSE);
}

// ── a value set from the view ───────────────────────────────────────────────────────────────
function write() {
  if (!T.set.size) {
    if (T.sheet) adopt(T.sheet, false);
    return;
  }
  T.sheet ||= new CSSStyleSheet();
  const rules = [];
  for (const [name, value] of T.set) {
    const sels = [...new Set([":root", ...(T.scopes.get(name) || [])])];
    for (const sel of sels) rules.push(`${sel}{${name}:${value} !important}`);
  }
  // (One rule at a time: a selector the parser will not take loses its own rule, not the rest.)
  T.sheet.replaceSync("");
  for (const r of rules) {
    try {
      T.sheet.insertRule(r, T.sheet.cssRules.length);
    } catch {}
  }
  adopt(T.sheet, true);
}

function setValue(name, value) {
  if (typeof name !== "string" || !TOKEN_NAME.test(name) || typeof value !== "string") return;
  value = short(value).slice(0, MAX_VALUE);
  // (Nothing that would end the declaration, or the rule.)
  if (/[;{}]/.test(value)) return;
  if (!value) {
    T.set.delete(name);
    T.was.delete(name);
  } else {
    if (!T.set.has(name)) {
      const cs = getComputedStyle(document.documentElement);
      T.was.set(name, short(cs.getPropertyValue(name)));
    }
    T.set.set(name, value);
  }
  write();
  restyled();
  look();
}

function act(a) {
  switch (a?.type) {
    case "view":
      T.want = true;
      return look();
    case "refresh":
      return look();
    case "stop":
      if (!T.want) return;
      T.want = false;
      return putView("tokens", null);
    case "set":
      return setValue(a.name, a.value);
    case "reset":
      T.set.clear();
      T.was.clear();
      write();
      restyled();
      return look();
  }
}
onAct("tokens", act);
// As the facts: a host whose view is up hears that nothing is read yet (null), and asks.
onHosted("tokens", () => {
  if (!hosted("tokens")) T.want = false;
  else if (!T.want) putView("tokens", null);
});
