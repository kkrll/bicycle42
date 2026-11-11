// ── geometry helpers ────────────────────────────────────────────────────────────────────────
const vp = () => ({
  w: window.innerWidth,
  h: window.innerHeight,
  dpr: window.devicePixelRatio || 1,
  scrollX: Math.round(window.scrollX),
  scrollY: Math.round(window.scrollY),
});
const toView = ([x, y]) => [x - window.scrollX, y - window.scrollY];
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
const union = (rects) => {
  const rs = rects.filter(Boolean);
  if (!rs.length) return null;
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  const r = Math.max(...rs.map((r) => r.x + r.w));
  const b = Math.max(...rs.map((r) => r.y + r.h));
  return { x, y, w: r - x, h: b - y };
};
const bboxOf = (pts) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
const docToViewRect = (r) => r && { x: r.x - window.scrollX, y: r.y - window.scrollY, w: r.w, h: r.h };

// The window's scroll and size, read once at the top of each frame (before anything is written).
const VP = { sx: 0, sy: 0, w: 0, h: 0 };
const readView = () => {
  VP.sx = window.scrollX;
  VP.sy = window.scrollY;
  VP.w = window.innerWidth;
  VP.h = window.innerHeight;
};

// ── element identity ────────────────────────────────────────────────────────────────────────
const unique = (sel) => {
  try {
    return document.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
};
const q = (sel) => {
  if (!sel) return null;
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
};
const SKIP = /^(SCRIPT|STYLE|HEAD|LINK|META|TITLE|NOSCRIPT|TEMPLATE|B42-REVIEW)$/;

/** One step of a selector path: tag, up to two classes, and its place among siblings of its tag. */
function segment(cur) {
  const tag = cur.tagName.toLowerCase();
  const classes = (typeof cur.className === "string" ? cur.className : "")
    .split(/\s+/)
    .filter((c) => c && !/[:/[\]]/.test(c))
    .slice(0, 2)
    .map((c) => `.${CSS.escape(c)}`)
    .join("");
  let seg = tag + classes;
  const parent = cur.parentElement;
  if (parent) {
    const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
    if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
  }
  return seg;
}

function selectorFor(el) {
  if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
  for (const a of ["data-testid", "data-test", "data-cy"]) {
    const v = el.getAttribute(a);
    if (v && unique(`[${a}="${CSS.escape(v)}"]`)) return `[${a}="${CSS.escape(v)}"]`;
  }
  const parts = [];
  for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
    if (cur !== el && cur.id && unique(`#${CSS.escape(cur.id)}`)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    parts.unshift(segment(cur));
    const sel = parts.join(" > ");
    if (unique(sel)) return sel;
  }
  return parts.join(" > ");
}

/** The selector an edit is reported under: anchored at the nearest ancestor with an id
 *  (`#plans > article.card:nth-of-type(2)`), so it stays right when the page has a second group
 *  that looks the same; without one near, the shortest path that matches exactly one element. */
function editSel(el) {
  const base = selectorFor(el);
  if (/^[#[]/.test(base)) return base; // its own id or test id, or already anchored at an id
  const parts = [];
  for (let cur = el, n = 0; cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && n < 8; cur = cur.parentElement, n++) {
    if (cur !== el && cur.id && unique(`#${CSS.escape(cur.id)}`)) {
      const sel = [`#${CSS.escape(cur.id)}`, ...parts].join(" > ");
      return sel.length <= 200 && unique(sel) ? sel : base;
    }
    parts.unshift(segment(cur));
  }
  return base;
}

function component(el) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  if (key) {
    const stack = [];
    let source;
    for (let f = el[key]; f && stack.length < 4; f = f.return) {
      if (!source && f._debugSource) source = f._debugSource;
      const t = f.type;
      if (!t || typeof t === "string") continue;
      const n =
        t.displayName ||
        t.name ||
        (t.render && (t.render.displayName || t.render.name)) ||
        (t.type && (t.type.displayName || t.type.name));
      if (n && /^[A-Z]/.test(n) && stack[stack.length - 1] !== n) stack.push(n);
    }
    if (stack.length) {
      const c = { framework: "react", name: stack[0], stack };
      if (source) c.source = `${source.fileName}:${source.lineNumber}`;
      return c;
    }
  }
  let v = el.__vueParentComponent;
  if (v) {
    const stack = [];
    let source;
    for (; v && stack.length < 4; v = v.parent) {
      const n = v.type && (v.type.name || v.type.__name);
      if (!source && v.type && v.type.__file) source = v.type.__file;
      if (n) stack.push(n);
    }
    if (stack.length) return { framework: "vue", name: stack[0], stack, ...(source ? { source } : {}) };
  }
  return null;
}

function describe(el) {
  const d = { selector: selectorFor(el), tag: el.tagName.toLowerCase() };
  if (el.id) d.id = el.id;
  const cls = typeof el.className === "string" ? el.className.trim() : el.getAttribute("class") || "";
  if (cls) d.classes = cls.slice(0, 200);
  const text = textOf(el);
  if (text) d.text = text;
  d.rect = round(rectOf(el));
  const attrs = {};
  for (const a of ["role", "aria-label", "data-testid", "href", "src", "alt", "type", "name", "placeholder", "title"]) {
    const v = el.getAttribute(a);
    if (v) attrs[a] = v.slice(0, 120);
  }
  if (Object.keys(attrs).length) d.attrs = attrs;
  const c = component(el);
  if (c) d.component = c;
  return d;
}

/** The words in an element, as one line. Text of separate children is joined by a space
 *  ("Pro For small teams"); a word split by inline markup (un<b>believ</b>able) is not. */
const INLINE = /^(A|ABBR|B|BDI|BDO|CITE|CODE|DFN|EM|I|KBD|MARK|Q|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|U|VAR|WBR)$/;
function textOf(el) {
  let text = "";
  if (!el.firstElementChild) text = el.textContent || "";
  else {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let prev = null;
    for (let n = walker.nextNode(); n && text.length < 240; n = walker.nextNode()) {
      const a = prev && prev.parentNode, b = n.parentNode;
      if (prev && a !== b && !((a.contains(b) && INLINE.test(b.tagName)) || (b.contains(a) && INLINE.test(a.tagName)))) text += " ";
      text += n.data;
      prev = n;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
const line = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Re-find a pin's element after the page changed. The agent's own edit is what changes the
 *  element, so the selector often points at the wrong node (or none). Order: selector whose
 *  text still matches → same tag (and component) with the same text → selector anyway. */
function findPin(p) {
  const bySel = q(p.selector);
  if (bySel && (!p.text || textOf(bySel) === p.text)) return bySel;
  if (p.text && document.body) {
    const pool = document.body.querySelectorAll(p.tag || "*");
    const hits = [];
    for (let i = 0; i < pool.length && i < 5000; i++) {
      const el = pool[i];
      if (textOf(el) !== p.text) continue;
      if (p.component && component(el)?.name !== p.component) continue;
      hits.push(el);
    }
    const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    if (deepest.length) return deepest[0];
  }
  return bySel;
}

const label = (el) => {
  const c = component(el);
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  else if (typeof el.className === "string" && el.className.trim()) s += `.${el.className.trim().split(/\s+/)[0]}`;
  return c ? `<${c.name}> ${s}` : s;
};

/** What a designer would call it: "Button · Start free trial". The selector stays in the tooltip. */
const KINDS = { a: "Link", button: "Button", img: "Image", svg: "Icon", input: "Field", textarea: "Field", select: "Menu", p: "Text",
  span: "Text", label: "Label", ul: "List", ol: "List", li: "List item", nav: "Navigation", header: "Header", footer: "Footer",
  section: "Section", article: "Card", form: "Form", table: "Table", video: "Video", h1: "Heading", h2: "Heading", h3: "Heading",
  h4: "Heading", h5: "Heading", h6: "Heading" };
const plainLabel = (el, max = 32) => {
  const tag = el.tagName.toLowerCase();
  const kind = component(el)?.name || KINDS[tag] || (el.getAttribute("role") ? el.getAttribute("role") : "Block");
  const words = (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || textOf(el)).trim();
  return words ? `${kind} · ${words.length > max ? `${words.slice(0, max - 1)}…` : words}` : kind;
};

// ── picking ─────────────────────────────────────────────────────────────────────────────────
function pick(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === hostEl || el === document.documentElement || el === document.body) return null;
  return el;
}

/** Elements fully inside a viewport rect, reduced to the outermost ones: the first 20 in
 *  document order. The tree is walked, and what is inside an element that is itself inside is
 *  not looked at. (Children can overflow a parent that lies outside, so those are all visited.) */
function elementsIn(r) {
  if (!document.body) return [];
  const out = [];
  const visit = (el) => {
    for (let k = el.firstElementChild; k && out.length < 20; k = k.nextElementSibling) {
      if (k === hostEl) continue;
      const b = k.getBoundingClientRect();
      if (b.width >= 2 && b.height >= 2 && b.left >= r.x - 1 && b.top >= r.y - 1 && b.right <= r.x + r.w + 1 && b.bottom <= r.y + r.h + 1) out.push(k);
      else visit(k);
    }
  };
  visit(document.body);
  return out;
}

/** Elements a stroke points at: a closed loop selects what it encloses, an open line what it crosses. */
function strokeTargets(pts) {
  const view = pts.map(toView);
  const box = bboxOf(view);
  const [sx, sy] = view[0];
  const [ex, ey] = view[view.length - 1];
  const closed = Math.hypot(ex - sx, ey - sy) < 0.35 * Math.max(box.w, box.h) && box.w > 16 && box.h > 16;
  if (closed) {
    const inside = elementsIn(box);
    if (inside.length) return inside;
  }
  const hits = [];
  let last = null;
  for (const [x, y] of view) {
    if (last && Math.hypot(x - last[0], y - last[1]) < 10) continue;
    last = [x, y];
    const el = pick(x, y);
    if (el && !hits.includes(el)) hits.push(el);
  }
  // keep the deepest elements: drop any hit that contains another hit
  return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o))).slice(0, 12);
}

function walk(dir) {
  const el = S.sel[0];
  if (!el) return;
  let next = null;
  if (dir === "up") {
    next = el.parentElement;
    if (next === document.body || next === document.documentElement) next = null;
  } else {
    const kids = [...el.children];
    next = kids.find((k) => {
      const r = k.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) || kids[0] || null;
  }
  if (!next) return;
  S.sel = [next];
  S.area = null;
  updateCardMeta();
  draftChanged();
  kick();
}

// ── rules the page adopts ───────────────────────────────────────────────────────────────────
// Typed declarations must win over the site's rules the way an inline style would, without
// "!important" in what the agent reads: three ids' worth of specificity that matches anything.
const BOOST = ":not(#b42-x#b42-x#b42-x)";
const adopt = (sheet, on) => {
  const list = document.adoptedStyleSheets;
  const has = list.includes(sheet);
  if (on && !has) document.adoptedStyleSheets = [...list, sheet];
  else if (!on && has) document.adoptedStyleSheets = list.filter((s) => s !== sheet);
};

