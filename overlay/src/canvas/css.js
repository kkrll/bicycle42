import { line } from "../page.js";

// ── typed CSS: scanning, checking ───────────────────────────────────────────────────────────
// Not a CSS parser: it only finds where declarations and rule heads start and end, so a rejected
// one can be underlined and a drag can replace `width: …` in place. The browser does the parsing.
const DESCRIPTORS = /^@(font-face|property|counter-style|page|font-palette-values|view-transition|position-try)\b/i;
function scanCss(text) {
  const segs = [];
  const ctx = [];
  let depth = 0, start = 0, paren = 0, ok = true;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? text.length - 1 : j + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    if (ch !== undefined && (paren || (ch !== ";" && ch !== "{" && ch !== "}"))) continue;
    const seg = text.slice(start, i);
    const t = seg.replace(/\/\*[\s\S]*?(\*\/|$)/g, "").trim();
    if (t) {
      const s = start + seg.length - seg.trimStart().length;
      segs.push({ s, e: start + seg.trimEnd().length, text: t, depth, head: ch === "{", raw: ctx.some((c) => DESCRIPTORS.test(c)) });
    }
    start = i + 1;
    if (ch === "{") {
      depth++;
      ctx.push(t);
    } else if (ch === "}") {
      ctx.pop();
      if (--depth < 0) {
        ok = false;
        depth = 0;
      }
    }
  }
  return { segs, balanced: ok && depth === 0 };
}

const declOf = (t) => {
  const m = /^([^:\s]+)\s*:\s*([\s\S]*)$/.exec(t);
  return m ? { prop: m[1].startsWith("--") ? m[1] : m[1].toLowerCase(), value: m[2].trim() } : null;
};
export const supports = (prop, value) => {
  try {
    return CSS.supports(prop, value.replace(/!\s*important\s*$/i, "").trim());
  } catch {
    return false;
  }
};
const short = (s) => (s.length > 28 ? `${s.slice(0, 27)}…` : s);

/** What the browser will not take, as ranges of the text with a reason each. */
export function problems(text, sheet) {
  const { segs, balanced } = scanCss(text);
  const out = [];
  for (const g of segs) {
    if (g.raw || g.text[0] === "@") continue;
    let why = "";
    if (g.head) {
      let fine = true;
      try {
        fine = !sheet || g.depth > 0 || CSS.supports(`selector(${g.text})`);
      } catch {}
      if (!fine) why = `invalid selector “${short(line(g.text))}”`;
    } else if (sheet && g.depth === 0) why = `“${short(line(g.text))}” is outside a rule`;
    else {
      const d = declOf(g.text);
      if (!d || !d.value) why = `“${short(line(g.text))}” is not a declaration`;
      else if (d.prop.startsWith("--")) why = "";
      else if (!/^[a-z-]+$/.test(d.prop) || !supports(d.prop, "initial")) why = `unknown property “${short(d.prop)}”`;
      else if (!supports(d.prop, d.value)) why = `invalid value for ${d.prop}`;
    }
    if (why) out.push({ s: g.s, e: g.e, why });
  }
  if (!balanced) out.push({ s: Math.max(0, text.length - 1), e: text.length, why: "unbalanced braces: the last complete version stays applied" });
  return out;
}

// Asked on every apply (and that runs on every re-render of the page), so the answer is kept.
const balance = new Map();
export const usable = (css, max) => {
  if (!css.trim() || css.length > max) return false;
  let ok = balance.get(css);
  if (ok === undefined) {
    if (balance.size > 200) balance.clear();
    balance.set(css, (ok = scanCss(css).balanced));
  }
  return ok;
};

/** The top-level properties a declaration text sets, for the note's before → after list. */
export function topProps(css) {
  const out = [];
  for (const g of scanCss(css).segs) {
    if (g.depth || g.head) continue;
    const d = declOf(g.text);
    if (d && d.value && d.prop.length <= 100 && (d.prop.startsWith("--") || supports(d.prop, d.value)) && !out.includes(d.prop)) out.push(d.prop);
  }
  return out.slice(0, 40);
}

/** `css` with `prop: value` set: replaced where it is declared at the top level, else added. */
export function setDecl(css, prop, value) {
  let hit = null;
  for (const g of scanCss(css).segs) if (!g.depth && !g.head && declOf(g.text)?.prop === prop) hit = g;
  if (hit) return `${css.slice(0, hit.s)}${prop}: ${value}${css.slice(hit.e)}`;
  const t = css.replace(/\s+$/, "");
  return `${t ? `${/[;}]$/.test(t) ? t : `${t};`}\n` : ""}${prop}: ${value};`;
}

