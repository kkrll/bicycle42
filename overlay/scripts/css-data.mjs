// Generates src/canvas/css-data.js: Chrome's own list of CSS properties and their keyword values,
// for the Edit mode inspector's autosuggest.
//
//   node scripts/css-data.mjs                                          download both sources and write the file
//   node scripts/css-data.mjs <css_properties.json5> <CSSMetadata.ts>  use local copies (offline)
//
// Re-run it when Electron is upgraded, after changing CHROMIUM_TAG and DEVTOOLS_BRANCH:
//   CHROMIUM_TAG:    the Chromium inside the app's Electron:
//                    ELECTRON_RUN_AS_NODE=1 app/node_modules/.bin/electron -e 'console.log(process.versions.chrome)'
//   DEVTOOLS_BRANCH: "chromium/<build>", where <build> is the third part of that version (152.0.7977.167 -> 7977);
//                    it is a branch of ChromeDevTools/devtools-frontend.
// Sources: Blink's css_properties.json5 (properties and the keywords Blink parses) and DevTools'
// CSSMetadata.ts (extraPropertyValues: hand-kept lists for properties Blink parses in custom code, such as
// align-items; Weight: how popular a property is). Both are BSD-3-Clause: see src/canvas/css-data.NOTICE.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHROMIUM_TAG = "152.0.7977.167";
export const DEVTOOLS_BRANCH = "chromium/7977";

const BLINK_URL = `https://chromium.googlesource.com/chromium/src/+/refs/tags/${CHROMIUM_TAG}/third_party/blink/renderer/core/css/css_properties.json5?format=TEXT`;
const META_URL = `https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/${DEVTOOLS_BRANCH}/front_end/core/sdk/CSSMetadata.ts`;
const OUT = fileURLToPath(new URL("../src/canvas/css-data.js", import.meta.url));

/** The list had about 600 properties when this was written: more than 5% fewer is a broken source, not a new Chrome. */
export const MIN_PROPS = 570;

const skipName = (n) => n.startsWith("-"); // -internal-, -webkit-, -epub-, -alternative-: none is offered
const keepValue = (v) => !v.startsWith("-webkit-");

/** After the string or comment that starts at `i` (or `i` itself, when none does). */
function skip(src, i) {
  const ch = src[i];
  if (ch === '"' || ch === "'") {
    for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
    return i + 1;
  }
  if (ch === "/" && src[i + 1] === "/") {
    const j = src.indexOf("\n", i);
    return j < 0 ? src.length : j;
  }
  if (ch === "/" && src[i + 1] === "*") {
    const j = src.indexOf("*/", i + 2);
    return j < 0 ? src.length : j + 2;
  }
  return i;
}

/** The objects of the json5's `data: [ … ]`, one per property: { text, top }, `top` being the
 *  block without its comments and without what its nested objects hold (a logical_property_group
 *  has a `name` of its own). Found by the brackets, whatever the indentation or the order of keys. */
const stray = (i) => new Error(`css_properties.json5: "data" holds something that is not an object, at ${i}`);
function blocks(src) {
  const at = /\bdata:\s*\[/.exec(src);
  if (!at) throw new Error('css_properties.json5 has no "data: ["');
  const out = [];
  const open = []; // the brackets open inside the block
  let start = -1, top = "";
  const own = () => !open.includes("{"); // not inside a nested object
  for (let i = at.index + at[0].length; i < src.length; i++) {
    const j = skip(src, i);
    const ch = src[i];
    if (j > i) {
      if (ch !== "/" && start < 0) throw stray(i);
      if (ch !== "/" && own()) top += src.slice(i, j);
      i = j - 1;
      continue;
    }
    if (start < 0) {
      if (ch === "]") return out; // the end of data
      if (ch === "{") {
        start = i;
        top = "";
      } else if (!/[\s,]/.test(ch)) throw stray(i);
    } else if (ch === "{" || ch === "[") {
      if (own()) top += ch;
      open.push(ch);
    } else if (ch === "}" || ch === "]") {
      if (!open.length) {
        out.push({ text: src.slice(start, i + 1), top });
        start = -1;
      } else {
        open.pop();
        if (own()) top += ch;
      }
    } else if (own()) top += ch;
  }
  throw new Error("css_properties.json5: data's bracket never closes");
}

const NAME_LINE = /^\s*name:\s*"/gm;

/** Blink's json5: property → its keywords. Descriptors that are no property (`src`, `syntax`,
 *  `unicode-range`: is_property: false) are left out; what Chrome has behind a flag is not, and
 *  suggest.js asks the browser which names it takes. Throws when a block was not understood:
 *  every `name: "…"` line of the file must be one block's own name or inside one. */
function parseBlink(src) {
  const props = new Map();
  let seen = 0;
  for (const { text, top } of blocks(src)) {
    const names = [...top.matchAll(/(?<![\w"])name:\s*"([^"]+)"/g)];
    if (names.length !== 1) throw new Error(`css_properties.json5: a block with ${names.length} names:\n${text.slice(0, 200)}`);
    seen += (text.match(NAME_LINE) || []).length;
    const name = names[0][1];
    if (skipName(name) || /(?<![\w"])is_property:\s*false\b/.test(top)) continue;
    // (devtools_keywords is Blink's own override of keywords for DevTools; typedom_keywords is neither.)
    const m = /(?<![\w"])devtools_keywords:\s*\[(.*?)\]/s.exec(top) || /(?<![\w"])keywords:\s*\[(.*?)\]/s.exec(top);
    props.set(name, m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []);
  }
  const all = (src.match(NAME_LINE) || []).length;
  if (seen !== all) throw new Error(`css_properties.json5 has ${all} "name:" lines, but the blocks read hold ${seen}: its layout changed, and properties would be dropped`);
  return props;
}

/** The text of the array literal that opens `const <name> = new Map...`. */
function tsMap(src, name) {
  const start = src.indexOf(`const ${name} = new Map`);
  if (start < 0) throw new Error(`CSSMetadata.ts has no "const ${name} = new Map"`);
  const open = src.indexOf("[", start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error(`unterminated array for ${name}`);
}

function parseMeta(src) {
  const extra = new Map();
  for (const m of tsMap(src, "extraPropertyValues").matchAll(/\[\s*'([^']+)',\s*new Set\(\[(.*?)\]\)/gs)) {
    extra.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  const weight = new Map();
  for (const m of tsMap(src, "Weight").matchAll(/\['([^']+)',\s*(\d+)\]/g)) weight.set(m[1], Number(m[2]));
  return { extra, weight };
}

/** @returns {Record<string, { v: string[], w: number }>} */
export function merge(blinkSrc, metaSrc) {
  const blink = parseBlink(blinkSrc);
  const { extra, weight } = parseMeta(metaSrc);
  const out = {};
  for (const name of [...new Set([...blink.keys(), ...extra.keys()])].filter((n) => !skipName(n)).sort()) {
    const v = [...new Set([...(blink.get(name) ?? []), ...(extra.get(name) ?? [])].filter(keepValue))];
    out[name] = { v, w: weight.get(name) ?? 0 };
  }
  return out;
}

/** The number of properties; throws when there are too few to be Chrome's list. */
export function enough(props) {
  const n = Object.keys(props).length;
  if (n < MIN_PROPS) throw new Error(`only ${n} properties (fewer than ${MIN_PROPS}): nothing written`);
  return n;
}

export function render(props) {
  const lines = Object.entries(props).map(([k, p]) => `  ${JSON.stringify(k)}: { v: ${JSON.stringify(p.v)}, w: ${p.w} },`);
  return `// Generated by overlay/scripts/css-data.mjs from Chromium ${CHROMIUM_TAG} (css_properties.json5) and
// Chrome DevTools ${DEVTOOLS_BRANCH} (CSSMetadata.ts: extraPropertyValues, Weight). Do not edit.
// Both sources are BSD-3-Clause; their copyright notices and licence text are in css-data.NOTICE.
/** @type {Record<string, { v: string[], w: number }>} property → its keyword values and its popularity weight (0 when unranked). */
export const CSS_PROPS = {
${lines.join("\n")}
};
`;
}

async function get(url, base64) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const text = await res.text();
  return base64 ? Buffer.from(text, "base64").toString("utf8") : text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [blinkPath, metaPath] = process.argv.slice(2);
  const blinkSrc = blinkPath ? readFileSync(blinkPath, "utf8") : await get(BLINK_URL, true);
  const metaSrc = metaPath ? readFileSync(metaPath, "utf8") : await get(META_URL, false);
  const props = merge(blinkSrc, metaSrc);
  const n = enough(props);
  writeFileSync(OUT, render(props));
  const withValues = Object.values(props).filter((p) => p.v.length).length;
  console.log(`wrote ${OUT}: ${n} properties, ${withValues} with values`);
}
