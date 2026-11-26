// Motion mode, where a script starts what moves: the file and line of an animate() call, or of
// what draws to a canvas. The page-side trace (../trace.js, among the page's own scripts when
// the host puts it there) answers with the stack of the call as the browser has it: the built
// file's address, line and column. The file the code was written in is said by that file's
// source map, when it has one this origin serves (a dev server's always has), read once for each
// file and only when something of it is opened. Without one the built place is said as it is.
//
// All of it comes from the page: each part is checked, and it is told apart as such in the note.

/** What was found, for each animation or canvas asked about: [{ at: "src/Hero.tsx:42", fn }] */
const found = new WeakMap();
export const sourceFor = (key) => (key && found.get(key)) || null;

let answer = null;
window.addEventListener(
  "b42:from-is",
  (/** @type {CustomEvent} */ e) => {
    e.stopImmediatePropagation();
    answer = e.detail;
  },
  true,
);
/** What the trace says of an element ("canvas", or "animate:<n>"); null when it says nothing
 *  (no trace in this page, or nothing known of it). Answered before dispatchEvent returns. */
export function ask(el, what) {
  answer = null;
  try {
    el.dispatchEvent(new CustomEvent("b42:from", { detail: what, bubbles: true, composed: true }));
  } catch {}
  const text = answer;
  answer = null;
  if (typeof text !== "string" || text.length > 6000) return null;
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

// ── a stack, read ────────────────────────────────────────────────────────────────────────
const MAX = 4;
const FRAME = /^\s*at (?:async )?(?:(.*?) \()?((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/;
const FN = /^[\w$.<>#[\] ]{1,80}$/;
/** The calls of a stack that are in a file, the nearest first: [{ fn, url, line, col }]. */
export function framesOf(stack) {
  const out = [];
  for (const l of String(stack || "").split("\n")) {
    const m = FRAME.exec(l);
    if (!m || m[2].length > 600) continue;
    const fn = (m[1] || "").replace(/^(?:new |Object\.|HTML\w*Element\.)/, "");
    out.push({ fn: FN.test(fn) && fn !== "<anonymous>" ? fn : "", url: m[2], line: +m[3], col: +m[4] });
    if (out.length === MAX) break;
  }
  return out;
}
const clean = (s) => s.replace(/[?#].*$/, "").replace(/[\n\r\t]/g, " ").slice(-200);
/** A built file's place, as it is said when no source map says more: `assets/app.js:1:5231`. */
function built(f) {
  let path = f.url;
  try {
    const u = new URL(f.url);
    if (u.origin === location.origin) path = u.pathname.replace(/^\//, "") || u.pathname;
  } catch {}
  return { at: `${clean(path)}:${f.line}:${f.col}`, ...(f.fn ? { fn: f.fn } : {}) };
}

// ── source maps ──────────────────────────────────────────────────────────────────────────
const MAX_FILE = 12e6, WAIT = 4000;
const maps = new Map(); // a built file's address → Promise<{ map, base } | null>
const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(WAIT) });
  if (!res.ok) throw new Error("not found");
  const text = await res.text();
  if (text.length > MAX_FILE) throw new Error("too long");
  return text;
};
function mapOf(url) {
  if (maps.has(url)) return maps.get(url);
  const p = (async () => {
    if (new URL(url).origin !== location.origin) return null; // (another origin's is not ours to fetch)
    const text = await get(url), i = text.lastIndexOf("sourceMappingURL=");
    if (i < 0) return null;
    const ref = /^[^\s'"*]+/.exec(text.slice(i + 17, i + 17 + MAX_FILE));
    if (!ref) return null;
    let json, base = url;
    if (ref[0].startsWith("data:")) {
      const comma = ref[0].indexOf(","), head = ref[0].slice(0, comma), body = ref[0].slice(comma + 1);
      json = /;base64/i.test(head) ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : decodeURIComponent(body);
    } else {
      base = new URL(ref[0], url).href;
      if (new URL(base).origin !== location.origin) return null;
      json = await get(base);
    }
    const map = JSON.parse(json);
    return map && typeof map.mappings === "string" && Array.isArray(map.sources) ? { map, base } : null;
  })().catch(() => null);
  maps.set(url, p);
  return p;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** What a source map says of a place in the built file (both counted from 1): the index of the
 *  source and the line in it, or null. Its mappings are read from the start up to that line:
 *  each says where it is from the one before. */
export function mapped(mappings, line, col) {
  const want = line - 1, c = col - 1, n = mappings.length;
  let i = 0, ln = 0, gc = 0, src = 0, sl = 0, best = null;
  while (i < n && ln <= want) {
    const ch = mappings.charCodeAt(i);
    if (ch === 59) (ln++, (gc = 0), i++); // ;
    else if (ch === 44) i++; // ,
    else {
      const f = [];
      for (;;) {
        let v = 0, shift = 0, d;
        do {
          d = B64.indexOf(mappings[i++]);
          if (d < 0) return best;
          v += (d & 31) << shift;
          shift += 5;
        } while (d & 32);
        f.push(v & 1 ? -(v >> 1) : v >> 1);
        const next = mappings.charCodeAt(i);
        if (i >= n || next === 59 || next === 44) break;
      }
      gc += f[0];
      if (f.length >= 4) {
        src += f[1];
        sl += f[2];
        // (The last that begins at or before the column; the first of the line when none does.)
        if (ln === want && (gc <= c || !best)) best = { src, line: sl + 1 };
      }
    }
  }
  return best;
}
/** A source's name as a source map has it, as a path of the project where that can be told. */
export function fileOf(source, root, base) {
  let s = String(source || "");
  if (root && !/^[a-z][\w+.-]*:|^\//i.test(s)) s = `${String(root).replace(/\/?$/, "/")}${s}`;
  if (/^[a-z][\w+.-]*:\/\//i.test(s) && !/^(?:https?|file):/i.test(s)) s = s.replace(/^[a-z][\w+.-]*:\/\/[^/]*\//i, ""); // webpack://app/./src/a.ts
  else {
    try {
      const u = new URL(s, base);
      s = u.origin === location.origin || u.protocol === "file:" ? u.pathname : u.href;
    } catch {}
  }
  return clean(s.replace(/^\/+/, "").replace(/^(?:\.\/)+/, "").replace(/^\[project\]\//, ""));
}
async function real(f) {
  const m = await mapOf(f.url);
  const hit = m && mapped(m.map.mappings, f.line, f.col), source = hit && m.map.sources[hit.src];
  if (typeof source !== "string" || !source) return built(f);
  const file = fileOf(source, m.map.sourceRoot, m.base);
  return file ? { at: `${file}:${hit.line}`, ...(f.fn ? { fn: f.fn } : {}) } : built(f);
}

/** Where `key` (an animation, a canvas) was started, from the stack the trace gave: the built
 *  places at once, the written ones when their source maps are read (`then` is told). */
export function trace(key, stack, then) {
  if (found.has(key)) return;
  const frames = framesOf(stack);
  if (!frames.length) return;
  found.set(key, frames.map(built));
  Promise.all(frames.map(real)).then((list) => {
    const was = JSON.stringify(found.get(key));
    found.set(key, list);
    if (JSON.stringify(list) !== was) then();
  }, () => {});
}
