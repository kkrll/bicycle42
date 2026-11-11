/*
 * bicycle 42 overlay: the in-page review layer.
 *
 * One dependency-free script. A host (the Electron app, or the test harness) injects
 * it into the page under review. The overlay draws outlines, strokes, the note card and pins, and
 * reports notes to the host. It keeps NO durable state: drafts and pins live in the host, so a hot
 * reload of the page loses nothing (the host sends them back on "ready").
 *
 * ── Protocol ────────────────────────────────────────────────────────────────────────────────────
 * page → host   window.__review(JSON.stringify(msg))      (a CDP Runtime.addBinding, or a shim)
 *   { type: "ready", url, viewport }                      overlay mounted; host replies with "state"
 *   { type: "toggle", enabled? }                          mod+shift+M, or Esc with nothing selected
 *   { type: "draft", draft | null }                       current unsent note, debounced
 *   { type: "note", note }                                submitted; card is hidden, outlines and
 *                                                         strokes stay drawn until "captured".
 *                                                         note.lane is "bg" when sent with alt+Enter
 *                                                         (to the host's background session)
 *   { type: "pins-placement", unplaced: [id] }            pins whose element can't be found (shown
 *                                                         at their stored position, if any, dimmed)
 *   { type: "pin", id }                                   a pin was clicked
 *   { type: "edits-shown", id, show }                     reply to "edits", two frames after the page
 *                                                         changed; id and show are echoed as received
 *
 *   A note made in canvas mode carries, besides the usual fields:
 *     note.edits?: Edit[]   at most 40. Kinds sent: "style" { css, changes: [{prop, from, to}] } (typed
 *                           declarations and resize/gap drags, one per element), "class" { from, to },
 *                           "move" { parent, fromIndex, toIndex, before }, "text" { from, to }, "hide".
 *                           Each has selector, tag, label, component?, repeated?.
 *     note.css?: string     the batch stylesheet (new rules), verbatim
 *     note.targets          the edited elements; note.bounds their rects before and after, united
 *   The draft carries the unsent batch as draft.edits (opaque: { els, sheet, ops }) and draft.note.
 *
 * host → page   window.__b42.receive(msg)
 *   { type: "state", enabled, draft?, pins?, templates? } templates: [{ name, hint }], offered after "/"
 *   { type: "enabled", enabled }
 *   { type: "pins", pins: [Pin] }
 *       Pin = { id, n, status: queued|working|done|failed|paused|stopped, lane?: "bg", note?,
 *               selector?, tag?, text?, component?,      from the note's first target, for re-finding
 *               at?: [x, y] }                            document coords, the last-resort position
 *   { type: "captured", id }                              screenshot taken; clear the selection.
 *                                                         Clicks made before this are held, then applied
 *   { type: "captured", id, ok: false, why? }             the host did not take the note: nothing is
 *                                                         cleared, the card (or the canvas batch) comes
 *                                                         back and says why. A host answers every note
 *                                                         one way or the other; with no answer in 2 s
 *                                                         the note counts as taken (a slow screenshot)
 *   { type: "edits", id, show }                           hide (show: false) or show again everything
 *                                                         the sent canvas note `id` applied: styles,
 *                                                         classes, text, order, its stylesheet. While
 *                                                         any batch is hidden the layer's own chrome is
 *                                                         hidden too, as during a capture
 *
 * host → page, sync  window.__b42.busy()                true while the reviewer is mid-note (card
 *                                                         open, selection, drag, capture): a host
 *                                                         that reloads the page waits for false
 *
 * Gestures (review mode on): hover outlines · click selects · shift+click adds · drag selects an
 * area · alt+drag draws (a closed loop selects what it encloses) · ↑/↓ parent/child (when the note
 * is empty, or with alt) · Enter sends · alt+Enter sends to the background · Esc cancels, then exits · mod+Z undoes a stroke (empty note).
 * The bar's brush (next to Notes) makes a plain drag draw, as alt+drag does, until the note is sent or cancelled.
 *
 * Canvas mode (mod+E, or the bar's switch; review mode on): the page's real elements are edited and
 * the batch goes out as one note. An inspector docks at the bottom: DOM tree, class line, "Element
 * styles" (declarations for the selected element), "Stylesheet" (new rules), computed values.
 * click selects · drag reorders inside a flex or grid parent · drag an edge or corner resizes ·
 * drag the space between flex/grid items changes the gap (mod: no snapping) · double-click edits
 * text · Delete hides · mod+Z / mod+shift+Z undo, redo · Enter sends (mod+Enter from the
 * inspector's fields) · Esc: leave the field, deselect, then back to notes.
 * The bar's count opens the list of edits in the batch (a row selects its element, its × removes that
 * edit); "?" lists these keys. After sending, the bar says the preview stays until the note is done.
 * Previews never touch the page's inline styles: styles, order and hiding are rules in constructed
 * stylesheets; class and text edits write the DOM and are re-applied when a framework re-renders.
 * A sent batch stays applied until its pin is done, failed or stopped, or the page reloads.
 */
(() => {
  "use strict";
  if (window.__b42) return;

  const VERSION = "0.1.0";
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
  const DRAG_PX = 5;
  const CAPTURE_TIMEOUT_MS = 2000;

  // ── host bridge ─────────────────────────────────────────────────────────────────────────────
  const send = (msg) => {
    const fn = window.__review;
    if (typeof fn !== "function") return;
    try {
      fn(JSON.stringify(msg));
    } catch (err) {
      console.warn("[b42] send failed", err);
    }
  };

  // ── state (transient only) ──────────────────────────────────────────────────────────────────
  const S = {
    enabled: false,
    hover: null, // Element
    sel: [], // Element[]
    area: null, // {x,y,w,h} document coords
    strokes: [], // [[[x,y],…]] document coords
    drag: null, // {x0,y0,x,y,mode,pts,shift}
    card: false,
    brush: false, // the bar's brush is on: a plain drag draws
    pending: null, // note id awaiting "captured"
    quiet: null, // that id when it is a canvas note: the bar says "Sent", not a chip over the page
    buffered: null, // a click made while pending: {x,y,shift}
    pins: [], // [{id,n,status,selector?,at?,el?}]
    images: [], // [{name,uri}] pictures pasted into the note
    templates: [], // [{name,hint}] from the host; empty when the host has none
    template: null, // name of the template chosen for this note
    menu: null, // templates matching what is typed after "/", while that list is open
    menuAt: 0,
    undo: null, // a note dropped with Esc, restorable for a few seconds
    unplaced: "",
  };

  let corner, bar, insp, cv, cnote, treeEl, trows, tspace, clsEl, cssEl, freeEl, compEl, ipath, bandEl, ghostEl, insEl, labEl, dimEl, handles, edges, hitEl, gzEl, shieldEl;
  let hostEl, root, ink, strokesEl, pencil, boxes, pinsEl, card, what, refs, textarea, cursorStyle, tip, sentEl, chip, menuEl, variantsEl, variantStyle;
  const PLACEHOLDER = "Note…  ( / for templates, paste a picture to attach it )";
  const HINT = `↵ send · ${isMac ? "⌥↵" : "alt+↵"} in parallel · / templates · esc`;
  let cardAt = null; // where the note card last sat: the "Sent" chip appears there
  let sentTimer = 0;
  let raf = 0;
  let draftTimer = 0;
  let domVersion = 0; // bumped on every DOM mutation; pins re-search only when it changes

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
  const plainLabel = (el) => {
    const tag = el.tagName.toLowerCase();
    const kind = component(el)?.name || KINDS[tag] || (el.getAttribute("role") ? el.getAttribute("role") : "Block");
    const words = (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || textOf(el)).trim();
    return words ? `${kind} · ${words.length > 32 ? `${words.slice(0, 31)}…` : words}` : kind;
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

  // ── draft ───────────────────────────────────────────────────────────────────────────────────
  const hasDraft = () => S.sel.length > 0 || S.strokes.length > 0 || !!S.area;

  function serializeDraft() {
    const noteDraft = !S.pending && (hasDraft() || !!textarea.value);
    const edits = C.snap !== EMPTY ? C.draft.B : null;
    const words = cnote ? cnote.value : "";
    if (!noteDraft && !edits && !words) return null;
    // (Between a send and its "captured", S.sel holds the sent note's outlines: not a draft.)
    return {
      text: textarea.value, targets: (noteDraft ? S.sel : []).map(selectorFor), area: S.area, strokes: S.strokes, template: S.template,
      ...(edits ? { edits } : {}), ...(words ? { note: words } : {}),
    };
  }

  function draftChanged() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => send({ type: "draft", draft: serializeDraft() }), 120);
  }

  function restoreDraft(d) {
    if (!d) return;
    S.sel = (d.targets || []).map(q).filter(Boolean);
    S.area = d.area || null;
    S.strokes = d.strokes || [];
    textarea.value = d.text || "";
    setTemplate(S.templates.some((t) => t.name === d.template) ? d.template : null);
    if (hasDraft() || textarea.value) openCard();
    restoreEdits(d);
  }

  function clearDraft() {
    S.sel = [];
    S.area = null;
    S.strokes = [];
    textarea.value = "";
    setImages([]);
    setTemplate(null);
    closeCard();
    clearTimeout(draftTimer);
    send({ type: "draft", draft: serializeDraft() }); // null, unless canvas edits are waiting
    kick();
  }

  // ── note card ───────────────────────────────────────────────────────────────────────────────
  function updateCardMeta() {
    what.title = S.sel.length === 1 ? label(S.sel[0]) : "";
    if (S.sel.length === 1) what.textContent = plainLabel(S.sel[0]);
    else if (S.sel.length > 1) what.textContent = `${S.sel.length} elements`;
    else if (S.strokes.length) what.textContent = "drawing";
    else what.textContent = "area";
  }

  function openCard() {
    hideSent();
    S.undo = null;
    S.card = true;
    updateCardMeta();
    autosize();
    if (S.enabled) {
      card.hidden = false;
      textarea.focus({ preventScroll: true });
    }
    draftChanged();
    kick();
  }

  /** The line beside the card's title: the keys, or why the note did not go (until it is changed). */
  function setHint(why) {
    const hint = card.querySelector(".hint");
    const text = why || HINT;
    if (hint.textContent === text) return;
    hint.textContent = text;
    hint.title = why || "";
    hint.classList.toggle("warn", !!why);
  }

  function closeCard() {
    S.card = false;
    card.hidden = true;
    setHint("");
    if (root && root.activeElement === textarea) textarea.blur();
  }

  function autosize() {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }

  // ── templates ───────────────────────────────────────────────────────────────────────────────
  // "/" at the start of a note lists kinds of work (variants, accessible, grade, …). Picking one
  // puts a chip on the card; whatever is typed after it steers the template, and may be nothing.
  function setTemplate(name) {
    S.template = name || null;
    S.menu = null;
    if (!chip) return;
    chip.hidden = !S.template;
    chip.textContent = S.template ? `/${S.template}` : "";
    const t = S.templates.find((x) => x.name === S.template);
    textarea.placeholder = t ? `${t.hint}. Add a note, or just press ↵` : PLACEHOLDER;
    drawMenu();
  }

  function updateMenu() {
    const m = !S.template && S.templates.length ? /^\/([a-z-]*)$/.exec(textarea.value) : null;
    const found = m ? S.templates.filter((t) => t.name.startsWith(m[1])) : [];
    S.menu = found.length ? found : null;
    S.menuAt = Math.min(S.menuAt, Math.max(0, found.length - 1));
    drawMenu();
  }

  function drawMenu() {
    if (!menuEl) return;
    menuEl.hidden = !S.menu;
    menuEl.replaceChildren(
      ...(S.menu || []).map((t, i) => {
        const row = document.createElement("div");
        row.className = `opt${i === S.menuAt ? " on" : ""}`;
        const name = document.createElement("span");
        name.className = "opt-name";
        name.textContent = `/${t.name}`;
        const hint = document.createElement("span");
        hint.className = "opt-hint";
        hint.textContent = t.hint;
        row.append(name, hint);
        // mousedown, not click: the textarea must keep the caret.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pickTemplate(t);
        });
        return row;
      }),
    );
    kick();
  }

  function pickTemplate(t) {
    textarea.value = "";
    setTemplate(t.name);
    autosize();
    draftChanged();
    textarea.focus({ preventScroll: true });
  }

  // ── pasted pictures ─────────────────────────────────────────────────────────────────────────
  // A reference to go with the words ("like this"). They are scaled down here, so a full-screen
  // screenshot costs the agent no more than the note's own crops, and they are not part of the
  // saved draft: a page reload drops them.
  const MAX_IMAGES = 4;
  const IMAGE_SIDE = 1600;

  function setImages(list) {
    S.images = list;
    if (!refs) return;
    refs.replaceChildren(
      ...list.map((im, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ref";
        b.title = "Remove this picture";
        const img = document.createElement("img");
        img.src = im.uri;
        img.alt = `Picture ${i + 1}`;
        b.append(img);
        b.addEventListener("click", () => {
          setImages(S.images.filter((x) => x !== im));
          textarea.focus({ preventScroll: true });
        });
        return b;
      }),
    );
    refs.hidden = !list.length;
    kick();
  }

  async function addImage(file) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, IMAGE_SIDE / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; // JPEG has no transparency
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const uri = c.toDataURL("image/jpeg", 0.85);
      if (S.card && S.images.length < MAX_IMAGES) setImages([...S.images, { name: "reference.jpg", uri }]);
    } catch {
      // Not a picture the browser can read: nothing is added.
    }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return; // plain text pastes as usual
    e.preventDefault();
    for (const f of files.slice(0, MAX_IMAGES)) void addImage(f);
  }

  // A stroke's box in document coordinates, worked out once: a stroke is never changed after it
  // is drawn (undo drops it whole, a restored draft brings new arrays).
  const strokeBox = new WeakMap();
  function anchorRect() {
    const rects = S.sel.map(rectOf);
    if (S.area) rects.push(docToViewRect(S.area));
    for (const s of S.strokes) {
      let b = strokeBox.get(s);
      if (!b) strokeBox.set(s, (b = bboxOf(s)));
      rects.push(docToViewRect(b));
    }
    return union(rects);
  }

  function placeCard() {
    const a = anchorRect();
    if (!a) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = Math.min(380, W - 16);
    const h = card.offsetHeight || 104;
    card.style.width = `${w}px`;
    let top = a.y + a.h + 8;
    if (top + h > H - 8) top = a.y - h - 8;
    if (top < 8) top = Math.min(Math.max(8, a.y + 8), H - h - 8);
    const left = Math.min(Math.max(8, a.x), W - w - 8);
    cardAt = [Math.round(left), Math.round(top)];
    card.style.transform = `translate(${cardAt[0]}px, ${cardAt[1]}px)`;
  }

  // ── submit ──────────────────────────────────────────────────────────────────────────────────
  function submit(background) {
    const text = textarea.value.trim();
    if (!text && !S.template) return;
    if (!hasDraft()) return;
    const targets = S.sel.filter((el) => el.isConnected).map(describe);
    const area = S.area ? round(docToViewRect(S.area)) : null;
    const strokes = S.strokes.map((s) => s.map(toView).map(([x, y]) => [Math.round(x), Math.round(y)]));
    const bounds = union([...targets.map((t) => t.rect), area, ...strokes.map(bboxOf)]);
    const note = {
      id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text,
      url: location.href,
      title: document.title,
      viewport: vp(),
      targets,
      area,
      strokes,
      bounds: bounds && round(bounds),
      time: Date.now(),
      ...(background ? { lane: "bg" } : {}),
      ...(S.images.length ? { images: S.images } : {}),
      ...(S.template ? { template: S.template } : {}),
    };
    setBrush(false);
    dispatch(note);
  }

  function dispatch(note) {
    // Hide the card (and, via S.pending, hover and pins) before the host takes its screenshot.
    closeCard();
    hideSent();
    hideTip();
    S.pending = note.id;
    clearTimeout(draftTimer);
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => send({ type: "note", note })));
    setTimeout(() => finishCapture(note.id), CAPTURE_TIMEOUT_MS);
  }

  // ── variants ────────────────────────────────────────────────────────────────────────────────
  // The /variants template asks the agent to render every option as siblings in one wrapper:
  //   <div data-b42-variants="hero-cta">
  //     <a data-b42-variant="0" data-b42-label="current">…</a>
  //     <a data-b42-variant="1" data-b42-label="softer">…</a> …
  // The page has no switching code. This layer hides all but the chosen one with a style rule
  // (no attribute is written, so a framework re-render can't undo it), draws a small switcher
  // over each group, and "Keep" starts a /keep note that tells the agent to delete the rest.
  const V = { groups: [], choice: {}, version: -1, css: "" };
  try {
    V.choice = JSON.parse(sessionStorage.getItem("b42-variants") || "{}") || {};
  } catch {}

  // The accent drawn on the page (selection outlines) has to show on the page's own background:
  // olive on a light page, pale yellow on a dark one. The card and its chips are always dark.
  function pageAccent() {
    for (const el of [document.body, document.documentElement]) {
      const m = el && /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(el).backgroundColor);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5))
        return 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3] < 110 ? "#fffaa0" : "#526737";
    }
    return "#526737";
  }

  function scanVariants() {
    if (V.version === domVersion) return;
    V.version = domVersion;
    const accent = pageAccent();
    if (accent !== V.accent) hostEl.style.setProperty("--pa", (V.accent = accent));
    V.groups = [...document.querySelectorAll("[data-b42-variants]")].slice(0, 12).map((el) => {
      const id = el.getAttribute("data-b42-variants") || "";
      const options = [...el.children]
        .filter((c) => c.hasAttribute("data-b42-variant"))
        .map((c) => ({ k: c.getAttribute("data-b42-variant"), label: c.getAttribute("data-b42-label") || "", el: c }));
      return { id, el, options };
    }).filter((g) => g.id && g.options.length > 1);
    let css = "";
    for (const g of V.groups) {
      if (!g.options.some((o) => o.k === V.choice[g.id])) V.choice[g.id] = g.options[0].k;
      css += `[data-b42-variants="${CSS.escape(g.id)}"] > [data-b42-variant]:not([data-b42-variant="${CSS.escape(V.choice[g.id])}"]) { display: none !important; }\n`;
    }
    if (css !== V.css) {
      V.css = css;
      variantStyle.textContent = css;
    }
  }

  function chooseVariant(g, step) {
    const i = g.options.findIndex((o) => o.k === V.choice[g.id]);
    V.choice[g.id] = g.options[(i + step + g.options.length) % g.options.length].k;
    try {
      sessionStorage.setItem("b42-variants", JSON.stringify(V.choice));
    } catch {}
    V.version = -1; // rebuild the style rule
    active();
  }

  function keepVariant(g) {
    const o = g.options.find((x) => x.k === V.choice[g.id]);
    if (!o || S.pending) return;
    S.sel = [g.el];
    S.area = null;
    S.strokes = [];
    setTemplate(S.templates.some((t) => t.name === "keep") ? "keep" : null);
    textarea.value = `${S.template ? "" : "Keep "}variant ${o.k}${o.label ? ` (${o.label})` : ""} of ${g.id}${S.template ? "" : ", delete the others"}`;
    openCard();
  }

  function makeVariantBar() {
    const bar = document.createElement("div");
    bar.className = "vbar";
    const button = (text, title, run) => {
      const b = document.createElement("button");
      b.type = "button";
      if (ICONS[text]) {
        b.innerHTML = icon(text);
        b.setAttribute("aria-label", title);
      } else b.textContent = text;
      b.title = title;
      b.addEventListener("click", () => bar._group && run(bar._group));
      return b;
    };
    const name = document.createElement("span");
    name.className = "vname";
    const keep = button("Keep", "Keep this variant and delete the others", keepVariant);
    keep.className = "vkeep";
    bar.append(button("chevron-left", "Previous variant", (g) => chooseVariant(g, -1)), name, button("chevron-right", "Next variant", (g) => chooseVariant(g, 1)), keep);
    return bar;
  }

  function drawVariants(capturing) {
    scanVariants();
    const shown = S.enabled && !capturing ? V.groups.filter((g) => g.el.isConnected) : [];
    const bars = pool(variantsEl, shown.length, makeVariantBar);
    shown.forEach((g, i) => {
      const bar = bars[i];
      bar._group = g;
      const at = g.options.findIndex((o) => o.k === V.choice[g.id]);
      const o = g.options[at];
      const r = rectOf(o && o.el.isConnected ? o.el : g.el);
      const x = Math.round(Math.min(Math.max(8, r.x), window.innerWidth - 220));
      const y = Math.round(r.y - 34 < 8 ? r.y + r.h + 6 : r.y - 34);
      const drawn = `${g.id}|${at}|${g.options.length}|${o?.label}|${x}|${y}`;
      if (bar._drawn === drawn) return;
      bar._drawn = drawn;
      bar.querySelector(".vname").textContent = `${at + 1} of ${g.options.length}${o?.label ? ` · ${o.label}` : ""}`;
      bar.style.transform = `translate(${x}px, ${y}px)`;
    });
  }

  // ── "Sent" ──────────────────────────────────────────────────────────────────────────────────
  // The card vanishes on Enter. For a moment a chip says the note went, and which number it got,
  // where the card was; it never blocks the next click and is gone before the next screenshot.
  function showSent(id) {
    if (!cardAt || !S.enabled) return;
    const n = S.pins.find((p) => p.id === id)?.n;
    sentEl.textContent = n ? `Sent · ${n}` : "Sent";
    sentEl.style.transform = `translate(${cardAt[0]}px, ${cardAt[1]}px)`;
    sentEl.hidden = false;
    // Restart the fade when notes come quickly one after another.
    sentEl.style.animation = "none";
    void sentEl.offsetWidth;
    sentEl.style.animation = "";
    clearTimeout(sentTimer);
    S.undo = null;
    sentTimer = setTimeout(hideSent, 1800);
  }

  function hideSent() {
    clearTimeout(sentTimer);
    S.undo = null;
    if (sentEl) sentEl.hidden = true;
  }

  function offerUndo(draft) {
    if (!cardAt) return;
    sentEl.textContent = `Note dropped · ${isMac ? "⌘" : "ctrl+"}Z brings it back`;
    sentEl.style.transform = `translate(${cardAt[0]}px, ${cardAt[1]}px)`;
    sentEl.hidden = false;
    sentEl.style.animation = "none";
    clearTimeout(sentTimer);
    S.undo = draft;
    sentTimer = setTimeout(hideSent, 5000);
  }

  // ── pin tooltip ─────────────────────────────────────────────────────────────────────────────
  const STATUS_WORDS = { queued: "Waiting", working: "Working", done: "Done", failed: "Failed", paused: "Paused (offline)", stopped: "Stopped" };

  function showTip(el) {
    const p = el._pin;
    if (!p || !S.enabled || S.drag) return;
    const r = el.getBoundingClientRect();
    tip.replaceChildren();
    const state = document.createElement("div");
    state.className = `tip-state ${p.status || "queued"}`;
    state.textContent = `${p.n} · ${STATUS_WORDS[p.status] || "Waiting"}${p.lane === "bg" ? " · in parallel" : ""}`;
    tip.append(state);
    if (p.note) {
      const words = document.createElement("div");
      words.textContent = p.note;
      tip.append(words);
    }
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(8, top))}px)`;
  }

  function hideTip() {
    if (tip && !tip.hidden) tip.hidden = true; // (writing `hidden` again restyles, even unchanged)
  }

  function makePin() {
    const el = document.createElement("div");
    el.addEventListener("mouseenter", () => showTip(el));
    el.addEventListener("mouseleave", hideTip);
    // Clicking a pin shows its note in the app's panel; it never starts a selection.
    el.addEventListener("click", () => el._pin && S.enabled && send({ type: "pin", id: el._pin.id }));
    return el;
  }

  /** The host did not take the note ("captured" with ok: false): it must not look sent. Nothing
   *  of a plain note was cleared yet (finishCapture does that), so its card opens again with
   *  the words in it; a canvas batch goes back to being the unsent one. */
  function refuseCapture(id, why) {
    if (!S.pending || S.pending !== id) return;
    S.pending = null;
    S.buffered = null;
    const say = `Not sent: ${typeof why === "string" && why.trim() ? line(why).slice(0, 80) : "the app did not take the note"}`;
    if (S.quiet === id) {
      S.quiet = null;
      unsendCanvas(id, say);
    } else {
      openCard();
      setHint(say);
    }
    kick();
  }

  function finishCapture(id) {
    if (!S.pending || S.pending !== id) return;
    S.pending = null;
    C.unsent = null;
    if (S.quiet === id) S.quiet = null;
    else showSent(id);
    S.sel = [];
    S.area = null;
    S.strokes = [];
    textarea.value = "";
    setImages([]);
    setTemplate(null);
    send({ type: "draft", draft: serializeDraft() });
    const b = S.buffered;
    S.buffered = null;
    const el = b && pick(b.x, b.y);
    if (el && C.on) select(el);
    else if (el) {
      S.sel = [el];
      openCard();
    }
    kick();
  }

  // ── canvas mode ─────────────────────────────────────────────────────────────────────────────
  // The reviewer edits the page's real elements and sends the batch as one note. Three rules:
  //  - one source of truth per element: its "Element styles" text. Typing writes it, and so do the
  //    resize and gap drags (a drag makes `width: 400px;` appear there);
  //  - previews never write the page's inline styles. Styles, order and hiding are rules in
  //    constructed stylesheets (adopted by the document, so they leave no node behind and survive
  //    a framework re-render); class and text edits have to write the DOM, so they are recorded
  //    with their original value, re-applied when the page re-renders, and put back exactly;
  //  - the batch is plain data ({ els, sheet, ops }), so undo is a stack of snapshots, the draft is
  //    the batch itself, and a sent batch is the same object with a note id.
  const MAX_EDITS = 40;
  const MAX_CSS = 4000;
  const MAX_SHEET = 8000;
  const MAX_CLASS = 1000;
  const MAX_TEXT = 2000;
  // Typed declarations must win over the site's rules the way an inline style would, without
  // "!important" in what the agent reads: three ids' worth of specificity that matches anything.
  const BOOST = ":not(#b42-x#b42-x#b42-x)";
  const SKIP = /^(SCRIPT|STYLE|HEAD|LINK|META|TITLE|NOSCRIPT|TEMPLATE|B42-REVIEW)$/;
  const COMPUTED = ["display", "flex-direction", "align-items", "justify-content", "gap", "width", "height", "padding", "margin",
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "border-radius"];
  // Every icon of the layer: inline SVG on a 16px grid, stroked in the text colour. No glyphs.
  const ICONS = {
    "chevron-down": '<path d="m4 6 4 4 4-4"/>',
    "chevron-up": '<path d="m4 10 4-4 4 4"/>',
    "chevron-right": '<path d="m6 4 4 4-4 4"/>',
    "chevron-left": '<path d="m10 4-4 4 4 4"/>',
    x: '<path d="m4 4 8 8M12 4l-8 8"/>',
    help: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.9 1.9 0 0 1 3.7.6c0 1.2-1.8 1.5-1.8 2.7"/><path d="M8.1 11.7v.1"/>',
    brush: '<path d="M8 9.3 13.6 3.3a1 1 0 0 0-1.5-1.4L6.6 8.2"/><path d="M6.2 8.2c1.4 0 2.6 1.1 2.6 2.5 0 1.8-1.7 3-3.6 3-1.4 0-2.6-.5-3.2-1.2 1-.3 1.5-1 1.6-2 .2-1.3 1.2-2.3 2.6-2.3z"/>',
  };
  const icon = (name, size = 16) =>
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const newBatch = () => ({ els: {}, sheet: "", ops: [] });
  const EMPTY = JSON.stringify(newBatch());
  const C = {
    on: false,
    sel: null, // the selected element
    selRs: "", // its stable selector, to find it again after a re-render
    hover: null,
    draft: { id: "draft", B: newBatch() }, // the unsent batch (+ its two stylesheets, made on demand)
    sent: [], // batches already sent, still applied as previews: [{ id, B, seen }]
    hide: new Set(), // ids of sent batches switched off for a "before" picture
    unsent: null, // what the batch being sent was, until the host takes it: { id, snap, past, future, note, sel }
    snap: EMPTY, // the draft batch as last committed; past and future are the undo stacks
    past: [],
    future: [],
    applied: new Map(), // Element → { cls?: original class attribute, text?: original text } written by us
    found: new Map(), // stable selector → Element
    moves: {}, // the stylesheet of `order` rules, shared by all batches
    orders: new Map(), // parent selector → the `order` rules last worked out for it
    marks: new Map(), // Element → "ed" | "hid" | "ed hid": what the tree marks
    pop: "", // the list open above the bar: "list" (the batch), "help" (the keys) or none
    done: "", // what happened to the last sent batch, shown for a few seconds
    r: null, // the selection's rect in the last frame
    drag: null,
    zone: null,
    geo: null,
    geoKey: "",
    edit: null, // text being edited in place
    rev: 0,
    px: 0, py: 0, moved: false, over: false, last: null,
    drawn: false, msg: "", msgTimer: 0, typeTimer: 0, typeRaf: 0, hideTimer: 0,
    ph: 300, collapsed: false, compKey: "", compAt: 0,
  };
  try {
    const p = JSON.parse(sessionStorage.getItem("b42-inspector") || "{}");
    if (p.h > 0) C.ph = p.h;
    C.collapsed = !!p.c;
  } catch {}

  // The window's scroll and size, read once at the top of each frame (before anything is written).
  const VP = { sx: 0, sy: 0, w: 0, h: 0 };
  const readView = () => {
    VP.sx = window.scrollX;
    VP.sy = window.scrollY;
    VP.w = window.innerWidth;
    VP.h = window.innerHeight;
  };
  const num = (s) => parseFloat(s) || 0;
  const px = (n) => `${Math.round(n * 100) / 100}px`;
  const line = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""); // tabs and line breaks stay
  const kids = (P) => [...P.children].filter((c) => c !== hostEl);

  /** A selector for our own rules and for finding the element again. Unlike selectorFor it uses no
   *  class names, so it still matches after the reviewer edits the class list. */
  function stableSel(el) {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur === document.body || cur === document.documentElement) {
        parts.unshift(cur.localName);
        break;
      }
      if (cur.id && unique(`#${CSS.escape(cur.id)}`)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      let seg = CSS.escape(cur.localName);
      const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      parts.unshift(seg);
    }
    return parts.join(" > ");
  }

  function elOf(rs) {
    let el = C.found.get(rs);
    if (!el || !el.isConnected) {
      el = q(rs);
      if (el) C.found.set(rs, el);
      else C.found.delete(rs);
    }
    return el;
  }

  /** What every edit says about its element (the wire names), plus `rs` for our own use. */
  function meta(el) {
    const m = { selector: editSel(el), rs: stableSel(el), tag: el.tagName.toLowerCase(), label: line(plainLabel(el)) };
    const c = component(el);
    if (c) m.component = line(c.name);
    const cls = el.getAttribute("class");
    const n = el.parentElement ? kids(el.parentElement).filter((k) => k.tagName === el.tagName && k.getAttribute("class") === cls).length : 1;
    if (n > 1) m.repeated = n;
    C.found.set(m.rs, el);
    return m;
  }

  function entry(el) {
    const rs = el === C.sel ? C.selRs : stableSel(el);
    const els = C.draft.B.els;
    return els[rs] || (els[rs] = { ...meta(el), rs, css: "" });
  }

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
  const supports = (prop, value) => {
    try {
      return CSS.supports(prop, value.replace(/!\s*important\s*$/i, "").trim());
    } catch {
      return false;
    }
  };
  const short = (s) => (s.length > 28 ? `${s.slice(0, 27)}…` : s);

  /** What the browser will not take, as ranges of the text with a reason each. */
  function problems(text, sheet) {
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
  const usable = (css, max) => {
    if (!css.trim() || css.length > max) return false;
    let ok = balance.get(css);
    if (ok === undefined) {
      if (balance.size > 200) balance.clear();
      balance.set(css, (ok = scanCss(css).balanced));
    }
    return ok;
  };

  /** The top-level properties a declaration text sets, for the note's before → after list. */
  function topProps(css) {
    const out = [];
    for (const g of scanCss(css).segs) {
      if (g.depth || g.head) continue;
      const d = declOf(g.text);
      if (d && d.value && d.prop.length <= 100 && (d.prop.startsWith("--") || supports(d.prop, d.value)) && !out.includes(d.prop)) out.push(d.prop);
    }
    return out.slice(0, 40);
  }

  /** `css` with `prop: value` set: replaced where it is declared at the top level, else added. */
  function setDecl(css, prop, value) {
    let hit = null;
    for (const g of scanCss(css).segs) if (!g.depth && !g.head && declOf(g.text)?.prop === prop) hit = g;
    if (hit) return `${css.slice(0, hit.s)}${prop}: ${value}${css.slice(hit.e)}`;
    const t = css.replace(/\s+$/, "");
    return `${t ? `${/[;}]$/.test(t) ? t : `${t};`}\n` : ""}${prop}: ${value};`;
  }

  // ── applying the batches ────────────────────────────────────────────────────────────────────
  const adopt = (sheet, on) => {
    const list = document.adoptedStyleSheets;
    const has = list.includes(sheet);
    if (on && !has) document.adoptedStyleSheets = [...list, sheet];
    else if (!on && has) document.adoptedStyleSheets = list.filter((s) => s !== sheet);
  };

  /** A top-level cut of stylesheet text: one string per rule, so a change re-inserts one rule. */
  function splitRules(text) {
    const out = [];
    let depth = 0, start = 0;
    const cut = (end) => {
      const t = text.slice(start, end);
      if (t.replace(/\/\*[\s\S]*?(\*\/|$)/g, "").trim()) out.push(t.trim());
      start = end;
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "/" && text[i + 1] === "*") {
        const j = text.indexOf("*/", i + 2);
        i = j < 0 ? text.length : j + 1;
      } else if (ch === '"' || ch === "'") {
        for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      } else if (ch === "{") depth++;
      else if (ch === "}") {
        if (--depth <= 0) {
          depth = 0;
          cut(i + 1);
        }
      } else if (ch === ";" && !depth) cut(i + 1);
    }
    cut(text.length);
    return out;
  }

  /** Keep one of a batch's stylesheets in step with its rules. Only the rules whose text changed
   *  are replaced (the browser then restyles for that rule, not for the sheet); a rule the browser
   *  cannot parse keeps its place as an empty one. Adopted only while it has rules. */
  function setRules(b, k, rules) {
    if (!b[k]) {
      if (!rules.length) return false;
      b[k] = new CSSStyleSheet();
      b[`${k}Rules`] = [];
    }
    const sheet = b[k], old = b[`${k}Rules`];
    const put = (text, i) => {
      try {
        sheet.insertRule(text, i);
      } catch {
        sheet.insertRule("b42-none {}", i);
      }
    };
    let changed = false;
    if (old.length !== rules.length) {
      while (sheet.cssRules.length) sheet.deleteRule(sheet.cssRules.length - 1);
      rules.forEach(put);
      changed = true;
    } else
      for (let i = 0; i < rules.length; i++)
        if (old[i] !== rules[i]) {
          sheet.deleteRule(i);
          put(rules[i], i);
          changed = true;
        }
    b[`${k}Rules`] = rules;
    adopt(sheet, rules.length > 0);
    return changed;
  }

  /** The children of P in the order the move ops ask for. */
  function ordered(base, ops) {
    const L = base.slice();
    for (const op of ops) {
      const el = elOf(op.rs);
      const i = L.indexOf(el);
      if (i < 0) continue;
      L.splice(i, 1);
      const b = op.before && elOf(op.before.rs);
      let j = b ? L.indexOf(b) : -1;
      if (j < 0) j = op.before ? Math.min(op.toIndex, L.length) : L.length;
      L.splice(j, 0, el);
    }
    return L;
  }

  const setText = (el, s) => {
    const t = el.firstChild;
    if (el.childNodes.length === 1 && t.nodeType === 3) t.data = s; // the same text node: a framework keeps its reference
    else el.textContent = s;
  };
  const setClass = (el, v) => (v === null ? el.removeAttribute("class") : el.setAttribute("class", v));

  /** Make the page show every batch that is not hidden. Idempotent: it writes only what differs,
   *  so it is also what runs after the page re-renders. */
  function applyAll() {
    if (C.edit) return;
    clearTimeout(C.slowTimer);
    C.slowTimer = 0;
    const want = new Map();
    const need = (el) => want.get(el) || want.set(el, {}).get(el);
    const groups = new Map();
    const marks = new Map(); // Element → "ed" | "hid" | "ed hid", for the tree
    const note = (rs, m) => {
      const el = elOf(rs);
      if (el) marks.set(el, marks.has(el) && marks.get(el) !== m ? "ed hid" : m);
      return el;
    };
    let watchClass = false, watchDom = false, dirty = false;
    for (const b of [...C.sent, C.draft]) {
      const off = C.hide.has(b.id);
      const ok = b.ok || (b.ok = {}); // per element (and "" for the stylesheet): the last complete text
      for (const k in ok) if (k && !(k in b.B.els)) delete ok[k];
      const rules = [];
      for (const rs in b.B.els) {
        const e = b.B.els[rs];
        // While a brace is still open the last complete text stays applied, so a rule being typed
        // does not switch the rest of the box off and on.
        if (usable(e.css, MAX_CSS)) ok[rs] = e.css;
        else if (!e.css.trim() || e.css.length > MAX_CSS) delete ok[rs];
        if (ok[rs]) rules.push(`${rs}${BOOST} {\n${ok[rs]}\n}`);
        if (e.css.trim() || e.cls) note(rs, "ed");
        if (!e.cls || off || e.cls.to.length > MAX_CLASS) continue;
        watchClass = true;
        const el = elOf(rs);
        if (!el) continue;
        const w = need(el);
        w.cls = { from: w.cls ? w.cls.from : e.cls.from, to: e.cls.to };
      }
      for (const op of b.B.ops) {
        note(op.rs, op.kind === "hide" ? "hid" : "ed");
        if (op.kind === "hide") rules.push(`${op.rs} { display: none !important; }`);
        if (off || op.kind === "hide") continue;
        watchDom = true;
        if (op.kind === "move") (groups.get(op.parent.rs) || groups.set(op.parent.rs, []).get(op.parent.rs)).push(op);
        else {
          const el = elOf(op.rs);
          if (!el) continue;
          const w = need(el);
          w.text = { from: w.text ? w.text.from : op.from, to: op.to };
        }
      }
      const sheet = b.B.sheet;
      if (usable(sheet, MAX_SHEET)) ok[""] = sheet;
      else if (!sheet.trim() || sheet.length > MAX_SHEET) delete ok[""];
      if (b.freeText !== ok[""]) b.split = (b.freeText = ok[""]) ? splitRules(ok[""]) : [];
      if (setRules(b, "gen", off ? [] : rules)) dirty = true;
      if (setRules(b, "free", off ? [] : b.split || [])) dirty = true;
    }
    // Reorder: `order` on the children from the first one that moves; worked out again only when
    // the parent's children or its moves changed (this runs on every re-render of the page).
    const order = [];
    for (const [prs, ops] of groups) {
      const P = elOf(prs);
      if (!P) continue;
      const all = P.children;
      const sig = ops.map((o) => `${o.rs}>${o.before ? o.before.rs : ""}`).join("|");
      let c = C.orders.get(prs);
      let same = !!c && c.P === P && c.sig === sig && c.kids.length === all.length;
      for (let i = 0; same && i < all.length; i++) same = c.kids[i] === all[i];
      if (!same) {
        const kidsNow = [...all];
        const base = kidsNow.filter((x) => x !== hostEl);
        const L = ordered(base, ops);
        const rules = [];
        let first = 0, last = L.length - 1;
        while (first <= last && L[first] === base[first]) first++;
        while (last > first && L[last] === base[last]) last--;
        if (first <= last) {
          const at = new Map(kidsNow.map((el, i) => [el, i + 1]));
          // Those before the first change keep their order (0); the changed run is numbered; the
          // rest follow under one rule.
          for (let i = first; i <= last; i++) rules.push(`${prs} > :nth-child(${at.get(L[i])}) { order: ${i - first + 1} !important; }`);
          if (base[last + 1]) rules.push(`${prs} > :nth-child(n + ${at.get(base[last + 1])}) { order: ${last - first + 2} !important; }`);
        }
        C.orders.set(prs, (c = { P, sig, kids: kidsNow, rules }));
      }
      order.push(...c.rules);
    }
    for (const k of C.orders.keys()) if (!groups.has(k)) C.orders.delete(k);
    if (setRules(C.moves, "gen", order)) dirty = true;
    // What has to be written into the DOM: first put back what is no longer wanted, then write.
    for (const [el, st] of C.applied) {
      const w = want.get(el);
      if (el.isConnected) {
        if ("cls" in st && !(w && w.cls)) {
          if (el.getAttribute("class") !== st.cls) setClass(el, st.cls);
          delete st.cls;
          dirty = true;
        }
        if ("text" in st && !(w && w.text)) {
          if (el.textContent !== st.text) setText(el, st.text);
          delete st.text;
          dirty = true;
        }
      }
      if (!el.isConnected || !("cls" in st || "text" in st)) C.applied.delete(el);
    }
    for (const [el, w] of want) {
      const st = C.applied.get(el) || {};
      if (w.cls) {
        const to = w.cls.to === "" && w.cls.from === null ? null : w.cls.to;
        if (el.getAttribute("class") !== to) {
          setClass(el, to);
          dirty = true;
        }
        st.cls = w.cls.from;
      }
      if (w.text) {
        if (el.textContent !== w.text.to) {
          setText(el, w.text.to);
          dirty = true;
        }
        st.text = w.text.from;
      }
      C.applied.set(el, st);
    }
    C.marks = marks;
    watch(watchClass ? 2 : watchDom ? 1 : 0);
    if (dirty) {
      C.rev++; // the selection's geometry, the computed list and the tree's marks are read again
      T.need = true;
    }
    drawBar();
    kick();
  }

  /** Re-apply after the page changes under us. Only observed while a batch needs it: class and
   *  text edits (the DOM was written) and reorders (the rules go by child position). */
  function watch(mode) {
    if (mode !== C.obsMode) {
      C.obsMode = mode;
      if (C.obs) C.obs.disconnect();
      if (mode) {
        C.obs = C.obs || new MutationObserver(() => applyAll());
        C.obs.observe(document.documentElement, {
          childList: true, subtree: true, characterData: true, ...(mode === 2 ? { attributes: true, attributeFilter: ["class"] } : {}),
        });
      }
    }
    if (C.obs && mode) C.obs.takeRecords(); // our own writes are not news
  }

  // ── the batch: commit, undo, reset, draft ───────────────────────────────────────────────────
  const countEdits = (B) =>
    Object.values(B.els).reduce((n, e) => n + (e.css.trim() ? 1 : 0) + (e.cls ? 1 : 0), 0) + B.ops.length;

  function prune(B) {
    for (const rs in B.els) {
      const e = B.els[rs];
      if (e.cls && e.cls.to === (e.cls.from ?? "")) delete e.cls;
      if (!e.css.trim() && !e.cls) delete B.els[rs];
    }
  }

  /** Close an undo step: the batch as it stands becomes the new committed state. */
  function commit() {
    clearTimeout(C.typeTimer);
    C.typeTimer = 0;
    hush();
    const B = C.draft.B;
    prune(B);
    const now = JSON.stringify(B);
    if (now !== C.snap) {
      if (countEdits(B) > MAX_EDITS) {
        C.draft.B = JSON.parse(C.snap);
        flash(`${MAX_EDITS} edits is the limit: send these first`);
        syncFields(true);
      } else {
        C.past.push(C.snap);
        if (C.past.length > 200) C.past.shift();
        C.snap = now;
        C.future = [];
      }
    }
    applyAll();
    syncFields();
    draftChanged();
  }

  function travel(from, to) {
    if (C.typeTimer) commit();
    hush();
    if (!from.length) return;
    to.push(C.snap);
    C.snap = from.pop();
    C.draft.B = JSON.parse(C.snap);
    applyAll();
    syncFields(true);
    draftChanged();
  }
  const undo = () => travel(C.past, C.future);
  const redo = () => travel(C.future, C.past);

  function reset() {
    if (C.typeTimer) commit();
    if (C.snap === EMPTY) return;
    C.draft.B = newBatch();
    commit(); // a step like any other: mod+Z brings the edits back
    syncFields(true);
  }

  function restoreEdits(d) {
    if (!d || C.snap !== EMPTY) return;
    // The words typed for the batch are a draft on their own: they come back with or without edits.
    if (cnote && typeof d.note === "string" && !cnote.value) cnote.value = d.note;
    const B = d.edits;
    if (B && typeof B === "object" && B.els && typeof B.els === "object" && Array.isArray(B.ops)) {
      C.draft.B = { els: B.els, sheet: typeof B.sheet === "string" ? B.sheet : "", ops: B.ops };
      C.snap = JSON.stringify(C.draft.B);
      applyAll();
    }
    syncFields(true);
  }

  // ── sending ─────────────────────────────────────────────────────────────────────────────────
  const tidy = (e) => {
    const out = { selector: e.selector, tag: e.tag, label: e.label };
    if (e.component) out.component = e.component;
    if (e.repeated) out.repeated = e.repeated;
    return out;
  };
  const value = (s) => line(s).slice(0, 400);

  function submitCanvas(background) {
    if (C.typeTimer) commit();
    if (S.pending) return;
    const B = C.draft.B;
    const entries = Object.values(B.els);
    const css = B.sheet.trim() ? B.sheet : "";
    if (!countEdits(B) && !css) return flash("Nothing to send yet: edit something first");
    if (css.length > MAX_SHEET || entries.some((e) => e.css.length > MAX_CSS || (e.cls && e.cls.to.length > MAX_CLASS)))
      return flash("Too long to send: shorten the text marked in the inspector");
    // (The host takes no longer text: sent as it is, the edit would be dropped there without a word.)
    if (B.ops.some((o) => o.kind === "text" && line(o.to).length > MAX_TEXT))
      return flash(`Too long to send: a text edit holds ${MAX_TEXT} characters at most. Double-click the text to shorten it`);
    const rss = [...new Set([...entries.map((e) => e.rs), ...B.ops.map((o) => o.rs)])];
    const els = rss.map(elOf).filter(Boolean);
    const props = new Map(entries.map((e) => [e.rs, topProps(e.css)]));
    // Elements the new rules match: only where nothing else says where the note is about.
    const matched = [];
    if (!els.length && C.draft.free)
      for (const r of [...C.draft.free.cssRules].slice(0, 20)) {
        const found = r.selectorText ? document.querySelectorAll(r.selectorText) : [];
        for (let i = 0; i < found.length && matched.length < 20; i++) if (found[i] !== hostEl) matched.push(found[i]);
      }
    // Measure with the batch switched off, then on: the note carries both sides.
    const measure = () => {
      const vals = new Map();
      for (const [rs, list] of props) {
        const el = elOf(rs);
        const cs = el && getComputedStyle(el);
        vals.set(rs, list.map((p) => (cs ? value(cs.getPropertyValue(p)) : "")));
      }
      return { vals, rects: [...els, ...matched].map(rectOf) };
    };
    C.draft.id = "measuring";
    C.hide.add("measuring");
    applyAll();
    const before = measure();
    C.hide.delete("measuring");
    applyAll();
    const after = measure();

    const edits = [];
    for (const e of entries) {
      if (e.css.trim())
        edits.push({ kind: "style", ...tidy(e), css: e.css,
          changes: props.get(e.rs).map((prop, i) => ({ prop, from: before.vals.get(e.rs)[i], to: after.vals.get(e.rs)[i] })) });
      if (e.cls) edits.push({ kind: "class", ...tidy(e), from: line(e.cls.from), to: line(e.cls.to) });
    }
    for (const op of B.ops) {
      const out = { kind: op.kind, ...tidy(op) };
      if (op.kind === "text") Object.assign(out, { from: line(op.from), to: line(op.to) });
      if (op.kind === "move")
        Object.assign(out, {
          parent: { selector: op.parent.selector, label: op.parent.label, layout: op.parent.layout },
          fromIndex: op.fromIndex, toIndex: op.toIndex,
          before: op.before ? { selector: op.before.selector, label: op.before.label } : null,
        });
      edits.push(out);
    }
    const seen = [...before.rects, ...after.rects].filter((r) => r.w > 0 && r.h > 0);
    const bounds = union(seen);
    const note = {
      id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: cnote.value.trim(),
      url: location.href,
      title: document.title,
      viewport: vp(),
      // Described as they are now, but under the selector they had before this batch's class edits.
      targets: els.map((el) => {
        const rs = stableSel(el);
        const known = B.els[rs] || B.ops.find((o) => o.rs === rs);
        return { ...describe(el), ...(known ? { selector: known.selector } : {}) };
      }),
      area: null,
      strokes: [],
      bounds: bounds && round(bounds),
      time: Date.now(),
      ...(background ? { lane: "bg" } : {}),
      ...(edits.length ? { edits } : {}),
      ...(css ? { css } : {}),
    };
    // The batch stays applied under the note's id; a new empty draft takes its place.
    C.unsent = { id: note.id, snap: C.snap, past: C.past, future: C.future, note: cnote.value, sel: C.sel };
    C.draft.id = note.id;
    C.sent.push(C.draft);
    C.draft = { id: "draft", B: newBatch() };
    C.snap = EMPTY;
    C.past = [];
    C.future = [];
    cnote.value = "";
    S.quiet = note.id; // no "Sent" chip over the page: the bar says it
    if (C.pop) setPop(C.pop);
    select(null);
    // Outlines for the screenshot: the edited elements, wherever they are in each picture.
    S.sel = els.filter((el, i) => after.rects[i].w > 0 || before.rects[i].w > 0);
    syncFields(true);
    drawBar();
    dispatch(note);
  }

  /** The host refused the note: its batch is the unsent one again, with its undo steps and its
   *  words, and the bar says why. Anything typed since (the Global box and the note field stay
   *  usable while the answer is awaited) is added to it, not lost. */
  function unsendCanvas(id, say) {
    const u = C.unsent;
    C.unsent = null;
    const i = C.sent.findIndex((b) => b.id === id);
    if (i < 0 || !u || u.id !== id) return flash(say);
    if (C.typeTimer) commit();
    const b = C.sent.splice(i, 1)[0];
    const later = C.draft;
    C.hide.delete(id);
    for (const k of ["gen", "free"]) if (later[k]) adopt(later[k], false);
    b.id = "draft";
    b.seen = b.n = undefined;
    for (const rs in later.B.els) {
      const e = later.B.els[rs], old = b.B.els[rs];
      if (!old) b.B.els[rs] = e;
      else {
        if (e.css.trim()) old.css = old.css.trim() ? `${old.css}\n${e.css}` : e.css;
        if (e.cls) old.cls = { from: old.cls ? old.cls.from : e.cls.from, to: e.cls.to };
      }
    }
    b.B.ops.push(...later.B.ops);
    if (later.B.sheet.trim()) b.B.sheet = b.B.sheet.trim() ? `${b.B.sheet}\n${later.B.sheet}` : later.B.sheet;
    C.draft = b;
    C.snap = u.snap;
    C.past = u.past;
    C.future = u.future;
    cnote.value = [u.note, cnote.value].filter((w) => w.trim()).join(" ");
    S.sel = []; // the outlines that were for the screenshot
    commit(); // what was added since, if anything, is one more undo step
    select(u.sel && u.sel.isConnected ? u.sel : null);
    syncFields(true);
    flash(say);
  }

  /** A sent batch is a preview until the agent is finished with its note. */
  function dropFinished() {
    let changed = false;
    C.sent = C.sent.filter((b) => {
      const p = S.pins.find((x) => x.id === b.id);
      if (p) b.seen = b.n = p.n || true;
      const over = p ? p.status === "done" || p.status === "failed" || p.status === "stopped" : b.seen;
      if (!over) return true;
      changed = true;
      C.hide.delete(b.id);
      for (const k of ["gen", "free"]) if (b[k]) adopt(b[k], false);
      // Done: the agent's own change is (or is about to be) in the page, so the class and text we
      // wrote are left for it to replace. Failed or stopped: they are put back (by applyAll).
      if (p && p.status === "done") {
        for (const rs in b.B.els) if (b.B.els[rs].cls) forget(rs, "cls");
        for (const op of b.B.ops) if (op.kind === "text") forget(op.rs, "text");
      }
      // Say what just happened to the preview, for a few seconds, where the reviewer is looking.
      const name = typeof b.n === "number" ? `Note ${b.n}` : "Note";
      C.done = !p ? `${name} removed · preview removed` : p.status === "done" ? `${name} done · preview removed` : `${name} ${p.status} · edits put back`;
      clearTimeout(C.doneTimer);
      C.doneTimer = setTimeout(() => {
        C.done = "";
        drawBar();
      }, 4000);
      return false;
    });
    if (changed) applyAll();
    drawBar();
  }

  function forget(rs, k) {
    const el = elOf(rs);
    const st = el && C.applied.get(el);
    if (st) delete st[k];
  }

  function showEdits(msg) {
    const b = C.sent.find((x) => x.id === msg.id);
    if (b) {
      if (msg.show === false) C.hide.add(b.id);
      else C.hide.delete(b.id);
      applyAll();
      // A host that never asks for them back must not leave the page without its chrome.
      clearTimeout(C.hideTimer);
      if (C.hide.size)
        C.hideTimer = setTimeout(() => {
          C.hide.clear();
          applyAll();
        }, 5000);
    }
    let told = false;
    const tell = () => {
      if (told) return;
      told = true;
      send({ type: "edits-shown", id: msg.id, show: msg.show });
    };
    requestAnimationFrame(() => requestAnimationFrame(tell));
    setTimeout(tell, 400); // frames may not come (a hidden window): the host waits a second at most
  }

  // ── mode ────────────────────────────────────────────────────────────────────────────────────
  /** The brush belongs to notes mode: while it is on, a plain drag draws (what alt+drag always does). */
  function setBrush(on) {
    if (S.brush === on) return;
    S.brush = on;
    drawBar();
  }

  function setCanvas(on) {
    if (on === C.on || !bar) return;
    if (on) setBrush(false);
    hush();
    if (C.pop) setPop(C.pop);
    if (on) {
      // A note in progress becomes the start of the canvas session: its element is selected and
      // its words move to the bar's note field. (A drawing or an area has no place here.)
      const el = S.sel.length === 1 ? S.sel[0] : null;
      const words = textarea.value.trim();
      if (S.card || hasDraft()) clearDraft();
      hideSent();
      if (words && !cnote.value) cnote.value = words;
      C.on = true;
      select(el && el.isConnected ? el : null);
    } else {
      endEdit(true);
      cancelDrag();
      if (C.typeTimer) commit();
      select(null);
      C.on = false;
      C.hover = null;
    }
    S.hover = null;
    try {
      sessionStorage.setItem("b42-canvas", on ? "1" : "");
    } catch {}
    syncUi();
    syncFields(true);
    drawBar();
    draftChanged();
    kick();
  }

  /** After a reload (the agent's own edits cause many) the reviewer is still in canvas mode. */
  function resumeCanvas() {
    let was = false;
    try {
      was = sessionStorage.getItem("b42-canvas") === "1";
    } catch {}
    if (was && !C.on && !S.card && !hasDraft()) setCanvas(true);
  }

  function flash(text) {
    C.msg = text;
    drawBar();
    clearTimeout(C.msgTimer);
    C.msgTimer = setTimeout(() => {
      C.msg = "";
      drawBar();
    }, 2600);
  }

  /** Any change of state takes a refusal off the bar: it must never describe something older. */
  function hush() {
    if (!C.msg) return;
    C.msg = "";
    clearTimeout(C.msgTimer);
    drawBar();
  }

  /** What the bar says about the batch sent last, while the agent has it. */
  function sentStatus() {
    const b = C.sent[C.sent.length - 1];
    return b ? `Sent · preview stays until ${typeof b.n === "number" ? `note ${b.n}` : "the note"} is done` : "";
  }

  function drawBar() {
    if (!bar) return;
    const B = C.draft.B;
    const n = countEdits(B) + (B.sheet.trim() ? 1 : 0);
    const f = root.activeElement;
    const inField = f === clsEl || f === cssEl || f === freeEl;
    const busyNote = f === cnote || !!cnote.value; // words being typed are not covered by a status line
    const msg = !C.on ? ""
      : C.msg || (C.edit ? "Editing text · ↵ keep · esc revert"
      : busyNote && n ? ""
      : C.done || (n ? "" : sentStatus())); // state only: the bar carries no standing instructions (the "?" has the keys)
    const key = [C.on, n, msg, C.past.length, dock(), inField, C.pop, S.brush].join("|");
    if (key === bar._key) return;
    bar._key = key;
    const $ = (s) => bar.querySelector(s);
    const s = n === 1 ? "" : "s";
    bar.classList.toggle("canvas", C.on);
    bar.style.bottom = `${C.on ? dock() + 10 : 14}px`;
    $(".m-notes").classList.toggle("on", !C.on);
    $(".m-brush").classList.toggle("on", !!S.brush);
    $(".m-brush").setAttribute("aria-pressed", String(!!S.brush));
    $(".m-canvas").classList.toggle("on", C.on);
    const count = $(".count");
    count.hidden = !C.on && !n;
    count.disabled = C.on && !n;
    count.firstChild.textContent = C.on ? (n ? `${n} edit${s}` : "No edits") : `${n} unsent canvas edit${s}`;
    count.title = C.on ? (n ? "Show what is in this batch" : "Nothing edited yet") : "Back to canvas mode, where these edits can be sent";
    count.classList.toggle("open", C.pop === "list");
    for (const b of [$(".undo"), $(".reset"), $(".bsend")]) b.hidden = !C.on;
    corner.style.bottom = bar.style.bottom; // the "?" keeps to the bar's row, in the corner
    corner.querySelector(".help").classList.toggle("on", C.pop === "help");
    $(".undo").disabled = !C.past.length;
    $(".reset").disabled = !n;
    cnote.hidden = !C.on || !!msg;
    const m = $(".bmsg");
    m.hidden = !C.on || !msg;
    m.textContent = m.title = msg;
    m.classList.toggle("warn", !!C.msg);
    $(".bsend").textContent = `${inField ? (isMac ? "⌘" : "ctrl+") : ""}↵ send`;
    $(".bsend").classList.toggle("off", !n);
  }

  // ── the bar's lists: what is in the batch, and the keys ─────────────────────────────────────
  const HELP = () => {
    const m = isMac ? "⌘" : "ctrl+", alt = isMac ? "⌥" : "alt";
    if (!C.on)
      return [
        ["click", "select · shift+click adds"],
        ["drag", "select everything in an area"],
        [`${alt}+drag, or the brush`, "draw · a closed loop selects what it encloses"],
        ["↑ ↓", "parent, child (with the note empty)"],
        ["↵", `send · ${alt}+↵ sends in parallel`],
        ["/", "templates"],
        [`${m}Z`, "undo a stroke, or bring back a dropped note"],
        ["esc", "cancel the note, then leave review mode"],
        [`${m}E`, "notes ⇄ canvas"],
      ];
    return [
      ["click", "select · ↑ ↓ parent, child"],
      ["drag", "reorder inside a flex or grid parent"],
      ["drag an edge or corner", `resize · hold ${isMac ? "⌘" : "ctrl"} for no snapping`],
      ["drag the space between items", "change the gap"],
      ["double-click text", "edit it · ↵ keep, esc revert"],
      ["Delete", "hide the selection"],
      [`${m}Z · ${m}shift+Z`, "undo · redo"],
      ["↵", `send · ${m}↵ from the inspector's fields`],
      ["esc", "leave the field, deselect, back to notes"],
      [`${m}E`, "notes ⇄ canvas"],
    ];
  };

  /** Computed values of every property an element's styles set, with the draft off and on. */
  function changesFor(entries) {
    const props = new Map(entries.map((e) => [e.rs, topProps(e.css)]));
    const read = () => {
      const vals = new Map();
      for (const [rs, list] of props) {
        const el = elOf(rs);
        const cs = el && getComputedStyle(el);
        vals.set(rs, list.map((p) => (cs ? value(cs.getPropertyValue(p)) : "")));
      }
      return vals;
    };
    C.draft.id = "measuring";
    C.hide.add("measuring");
    applyAll();
    const before = read();
    C.hide.delete("measuring");
    C.draft.id = "draft";
    applyAll();
    const after = read();
    return new Map(entries.map((e) => [e.rs, props.get(e.rs).map((prop, i) => ({ prop, from: before.get(e.rs)[i], to: after.get(e.rs)[i] }))]));
  }

  /** The unsent batch in plain words, one row per edit. */
  function editRows() {
    const B = C.draft.B, entries = Object.values(B.els), rows = [];
    const changes = changesFor(entries.filter((e) => e.css.trim()));
    const bare = (v) => v.replace(/(\d)px\b/g, "$1");
    for (const e of entries) {
      if (e.css.trim()) {
        const list = changes.get(e.rs) || [];
        const text = list.length
          ? list.slice(0, 3).map((c) => `${c.prop} ${bare(c.from)} → ${bare(c.to)}`).join(", ") + (list.length > 3 ? `, and ${list.length - 3} more` : "")
          : line(e.css).slice(0, 60);
        rows.push({ kind: "style", rs: e.rs, label: e.label, text });
      }
      if (e.cls) rows.push({ kind: "class", rs: e.rs, label: e.label, text: `class “${line(e.cls.from)}” → “${line(e.cls.to)}”` });
    }
    for (const op of B.ops)
      rows.push({ kind: op.kind, rs: op.rs, label: op.label, op,
        text: op.kind === "hide" ? "hidden" : op.kind === "move" ? `moved from place ${op.fromIndex + 1} to ${op.toIndex + 1}` : `text “${line(op.from)}” → “${line(op.to)}”` });
    if (B.sheet.trim()) {
      const k = splitRules(B.sheet).length;
      rows.push({ kind: "sheet", label: "Stylesheet", text: `${k} rule${k === 1 ? "" : "s"}` });
    }
    return rows;
  }

  function removeEdit(row) {
    const B = C.draft.B;
    if (row.kind === "style") B.els[row.rs].css = "";
    else if (row.kind === "class") delete B.els[row.rs].cls;
    else if (row.kind === "sheet") B.sheet = "";
    else B.ops.splice(B.ops.indexOf(row.op), 1);
    commit(); // a step like any other: mod+Z brings it back
    syncFields(true);
  }

  function setPop(which) {
    C.pop = which === C.pop ? "" : which;
    drawPop();
    drawBar();
  }

  function drawPop() {
    // Two lists, one open at a time: the batch above the bar, the keys above the "?" in the corner.
    const rows = C.pop === "list" ? editRows() : [];
    if (C.pop === "list" && !rows.length) C.pop = "";
    const list = bar.querySelector(".pop"), keys = corner.querySelector(".pop");
    list.hidden = C.pop !== "list";
    keys.hidden = C.pop !== "help";
    if (!C.pop) return;
    const pop = C.pop === "help" ? keys : list;
    const el = (tag, cls, text) => {
      const x = document.createElement(tag);
      x.className = cls;
      if (text !== undefined) x.textContent = text;
      return x;
    };
    if (C.pop === "help")
      pop.replaceChildren(...HELP().map(([k, v]) => {
        const row = el("div", "hrow");
        row.append(el("span", "hk", k), el("span", "hv", v));
        return row;
      }));
    else
      pop.replaceChildren(...rows.map((r) => {
        const row = el("div", "erow");
        const x = el("button", "ex");
        x.type = "button";
        x.innerHTML = icon("x", 12);
        x.title = "Remove this edit";
        x.setAttribute("aria-label", "Remove this edit");
        row.append(el("span", "el", r.label), el("span", "et", `— ${r.text}`), x);
        row.title = `${r.label} — ${r.text}`;
        row.addEventListener("click", (e) => {
          if (x.contains(e.target)) return removeEdit(r);
          if (r.kind === "sheet") {
            // The stylesheet is the batch's, not an element's: it lives under "Global".
            C.pin = true;
            syncFields();
            return freeEl.focus();
          }
          const target = elOf(r.rs);
          if (!target) return;
          select(target);
          target.scrollIntoView({ block: "center", inline: "nearest" });
        });
        return row;
      }));
  }

  // In canvas mode the page's cursor is the plain arrow, by one rule that never changes (changing a
  // rule that matches every element restyles the whole document). The arrows over a handle or a
  // gap come from the layer's own elements; during a drag a shield over the viewport carries the
  // cursor. The second rule gives the page room to scroll its last part out from under the dock.
  const dock = () => (C.collapsed ? 30 : C.ph);
  function syncUi() {
    if (!(C.on && S.enabled)) {
      if (C.ui) adopt(C.ui, false);
      return;
    }
    if (!C.ui) {
      C.ui = new CSSStyleSheet();
      C.ui.replaceSync("html[data-b42-review], html[data-b42-review] * { cursor: default !important; } html[data-b42-review] { padding-bottom: 0px !important; }");
    }
    adopt(C.ui, true);
    const room = `${dock()}px`;
    if (room !== C.room) C.ui.cssRules[1].style.setProperty("padding-bottom", (C.room = room), "important");
  }

  /** The caret cursor over text being edited in place: a rule for that element only. */
  function editCursor(rs) {
    if (!C.caret) C.caret = new CSSStyleSheet();
    if (rs)
      try {
        C.caret.replaceSync(`${rs}${BOOST}, ${rs}${BOOST} * { cursor: text !important; }`);
      } catch {}
    adopt(C.caret, !!rs);
  }

  function shield(cursor) {
    shieldEl.hidden = !cursor;
    if (cursor) shieldEl.style.cursor = cursor;
  }

  // A drag previews through one rule of its own, changed in place each frame; on release the
  // value is written into the element's styles and the rule goes.
  function liveSet(sel, prop, val) {
    if (!C.live) {
      C.live = new CSSStyleSheet();
      C.live.replaceSync("b42-none {}");
    }
    const rule = C.live.cssRules[0];
    if (rule.selectorText !== sel) rule.selectorText = sel;
    adopt(C.live, true);
    if (val == null) rule.style.removeProperty(prop);
    else rule.style.setProperty(prop, val, "important");
  }
  function liveEnd() {
    if (!C.live) return;
    adopt(C.live, false);
    C.live.cssRules[0].style.cssText = "";
  }

  // ── selection and its geometry ──────────────────────────────────────────────────────────────
  function select(el) {
    if (C.typeTimer) commit();
    hush();
    C.sel = el || null;
    C.selRs = el ? stableSel(el) : "";
    C.geo = null;
    C.geoKey = "";
    C.zone = null;
    if (el) reveal(el);
    T.need = true;
    syncFields(true);
    kick();
  }

  /** The children of P that take part in its layout, in the order they are laid out. */
  function flow(P) {
    const fg = /flex|grid/.test(getComputedStyle(P).display);
    const out = [];
    for (let i = 0; i < P.children.length && out.length < 200; i++) {
      const el = P.children[i];
      if (el === hostEl) continue;
      const r = rectOf(el);
      if (r.w <= 0 || r.h <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "absolute" || cs.position === "fixed") continue;
      out.push({ el, r, o: fg ? Number(cs.order) || 0 : 0, i });
    }
    if (fg) out.sort((a, b) => a.o - b.o || a.i - b.i);
    return out;
  }

  /** The empty band between two neighbours: side by side, or one under the other. */
  function between(a, b, pr) {
    const top = Math.max(a.y, b.y), bot = Math.min(a.y + a.h, b.y + b.h);
    if (b.x >= a.x + a.w - 0.5 && bot > top) return { axis: "x", rect: { x: a.x + a.w, y: top, w: Math.max(0, b.x - a.x - a.w), h: bot - top } };
    if (b.y < a.y + a.h - 0.5) return null;
    const wrap = b.x + b.w <= a.x + 0.5; // the next row of a wrapping row or a grid: the band spans the parent
    const x1 = wrap ? pr.x : Math.min(a.x, b.x), x2 = wrap ? pr.x + pr.w : Math.max(a.x + a.w, b.x + b.w);
    return { axis: "y", rect: { x: x1, y: a.y + a.h, w: x2 - x1, h: Math.max(0, b.y - a.y - a.h) } };
  }

  function gapZones(g, P, only) {
    const cs = getComputedStyle(P);
    if (!/flex|grid/.test(cs.display)) return;
    const items = flow(P);
    const cg = num(cs.columnGap), rg = num(cs.rowGap), pr = rectOf(P);
    for (let i = 1; i < items.length && g.zones.length < 120; i++) {
      const a = items[i - 1], b = items[i];
      if (only && a.el !== only && b.el !== only) continue;
      const bw = between(a.r, b.r, pr);
      if (!bw) continue;
      const q2 = bw.rect;
      // `rel` is the band relative to the selection's corner: scrolling moves both together.
      g.zones.push({ t: "space", i: g.zones.length, el: P, a: a.el, b: b.el, axis: bw.axis,
        rel: { x: q2.x - g.r.x, y: q2.y - g.r.y, w: q2.w, h: q2.h },
        prop: cg === rg ? "gap" : bw.axis === "x" ? "column-gap" : "row-gap", value: bw.axis === "x" ? cg : rg });
    }
  }

  function buildGeo(el, r) {
    const d = getComputedStyle(el).display;
    const g = { el, r, resizable: d !== "inline" && d !== "contents" && r.w > 0 && r.h > 0, zones: [] };
    const P = el.parentElement;
    if (P && P !== document.documentElement) gapZones(g, P, el);
    if (el.childElementCount > 1) gapZones(g, el, null);
    return g;
  }

  /** Lay out what the pointer can grab around the selection: corners, edges, the gaps. They are
   *  the layer's own elements (so the cursor is theirs, and "what is under the pointer" is the
   *  event's target), placed relative to the selection's corner; the frame moves them as one. */
  function layoutHit(g, r) {
    const w = r.w, h = r.h;
    const at = (el, x, y, ww, hh) => {
      const k = `${x}|${y}|${ww}|${hh}`;
      if (el._k === k) return;
      el._k = k;
      el.hidden = false;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${ww}px`;
      el.style.height = `${hh}px`;
    };
    // Corners: 16px to hit (less on a small element), an 8px square to see. Edges: the strip
    // between the corners, 6px outside the border and 3px inside, so the body stays draggable.
    const c = Math.max(8, Math.min(16, w / 2, h / 2));
    handles.forEach((el, i) => (g.resizable ? at(el, (i % 2) * w - c / 2, (i > 1) * h - c / 2, c, c) : gone(el)));
    const ex = w - c, ey = h - c;
    [[c / 2, -6, ex, 9], [w - 3, c / 2, 9, ey], [c / 2, h - 3, ex, 9], [-6, c / 2, 9, ey]].forEach(([x, y, ww, hh], i) =>
      g.resizable && ww > 0 && hh > 0 ? at(edges[i], x, y, ww, hh) : gone(edges[i]));
    if (g.laid) return; // the gaps are laid out once per geometry; a resize drag only moves the handles
    g.laid = true;
    const zs = pool(gzEl, g.zones.length, () => {
      const el = document.createElement("div");
      el.className = "gz";
      return el;
    });
    g.zones.forEach((z, i) => {
      const q2 = z.rel;
      const px2 = z.axis === "x" ? Math.max(0, (8 - q2.w) / 2) : 0, py2 = z.axis === "y" ? Math.max(0, (8 - q2.h) / 2) : 0;
      zs[i]._k = "";
      at(zs[i], q2.x - px2, q2.y - py2, q2.w + 2 * px2, q2.h + 2 * py2);
      zs[i]._z = z;
      const cur = z.axis === "x" ? "col-resize" : "row-resize";
      if (zs[i]._c !== cur) zs[i].style.cursor = zs[i]._c = cur;
    });
  }
  const zoneOf = (e) => (C.sel && e.composedPath()[0]._z) || null;
  const cursorOf = (z) =>
    !z || z.t === "body" ? "default"
    : z.t === "space" ? (z.axis === "x" ? "col-resize" : "row-resize")
    : z.hx && z.hy ? (z.hx === z.hy ? "nwse-resize" : "nesw-resize")
    : z.hx ? "ew-resize" : "ns-resize";

  // ── drags ───────────────────────────────────────────────────────────────────────────────────
  // pointermove only records where the pointer is. The frame does the work: it measures once when
  // the drag starts (sizes, siblings), then each frame computes one value and writes one rule.
  function cvDown(e, z) {
    hush();
    if (C.pop) setPop(C.pop);
    const f = root.activeElement;
    if (f && f !== textarea) f.blur(); // a click on the page ends typing in the bar or the inspector
    if (C.edit) endEdit(true);
    // The click is kept from the page, so it does not bring the keyboard here by itself: Delete,
    // Enter and the arrows must work after a click in a frame that did not have the focus.
    if (!document.hasFocus()) window.focus();
    const x = e.clientX, y = e.clientY, r = C.r;
    const body = !z && r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    C.drag = { x0: x, y0: y, x, y, zone: z || (body ? { t: "body" } : null), mode: null, free: mod(e), sx: window.scrollX, sy: window.scrollY };
  }

  function cvMove(e) {
    const d = C.drag;
    if (!d) {
      const z = zoneOf(e);
      const ours = !z && isOurs(e);
      if (ours && !C.over && C.hover) {
        C.hover = null;
        T.need = true;
      }
      C.over = ours;
      C.px = e.clientX;
      C.py = e.clientY;
      C.moved = true;
      C.zone = z;
      return;
    }
    block(e);
    d.x = e.clientX;
    d.y = e.clientY;
    d.free = mod(e);
    const far = Math.hypot(d.x - d.x0, d.y - d.y0);
    if (!d.mode && far > (d.zone && d.zone.t !== "body" ? 2 : DRAG_PX)) d.mode = "start";
    kick();
  }

  function cvUp(e) {
    const d = C.drag;
    if (!d) return;
    block(e);
    C.drag = null;
    if (d.mode === "start") {
      // Released before a frame came: do the frame's part now, so a quick flick still counts.
      readView();
      startDrag(d);
      if (d.mode !== "none") stepDrag(d);
    }
    if (d.mode) return endDrag(d, true);
    if (d.zone && d.zone.t !== "body") return; // a click on a handle or a gap changes nothing
    const el = pick(d.x0, d.y0);
    const now = performance.now();
    const twice = C.last && el && el === C.sel && now - C.last.t < 400 && Math.hypot(d.x0 - C.last.x, d.y0 - C.last.y) < 5;
    C.last = twice ? null : { t: now, x: d.x0, y: d.y0 };
    if (twice) startEdit(el);
    else if (el !== C.sel) select(el);
  }

  function cancelDrag() {
    const d = C.drag;
    C.drag = null;
    if (d && d.mode && d.mode !== "start") endDrag(d, false);
  }

  function startDrag(d) {
    beginDrag(d);
    if (d.mode !== "none") shield(d.mode === "move" ? "grabbing" : cursorOf(d.zone)); // the cursor for the whole drag
  }

  function beginDrag(d) {
    const z = d.zone;
    d.mode = "none";
    if (z && z.t === "resize") return startResize(d, z);
    if (z && z.t === "space") {
      const cs = getComputedStyle(z.el);
      Object.assign(d, { mode: "space", el: z.el, sel: stableSel(z.el) + BOOST, v0: z.value, val: z.value,
        near: [...new Set(["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"].map((k) => num(cs[k])).filter(Boolean))] });
      return;
    }
    // A drag that starts on the selection moves the selection. One that starts elsewhere moves
    // what is under the pointer, or rather the nearest thing around it that can be reordered:
    // grabbing a card by its heading moves the card.
    let el = z ? C.sel : pick(d.x0, d.y0);
    if (!el) return;
    if (!z) {
      for (let a = el; a && a.parentElement && a !== document.body; a = a.parentElement)
        if (/flex|grid/.test(getComputedStyle(a.parentElement).display)) {
          el = a;
          break;
        }
      if (el !== C.sel) select(el);
    }
    startMove(d, el);
  }

  function startResize(d, z) {
    const el = C.sel, cs = getComputedStyle(el), P = el.parentElement, r0 = C.r || C.geo.r;
    const pcs = P ? getComputedStyle(P) : null;
    const dir = pcs && pcs.display.includes("flex") ? (pcs.flexDirection.startsWith("column") ? "y" : "x") : "";
    Object.assign(d, { mode: "resize", el, sel: C.selRs + BOOST, r0, w0: num(cs.width) || r0.w, h0: num(cs.height) || r0.h, kx: 1, ky: 1,
      // In a flex parent the main size is flex's to decide: say so in the same edit, or the drag does nothing.
      unflex: (dir === "x" && z.hx) || (dir === "y" && z.hy) ? cs.flexGrow !== "0" || cs.flexBasis !== "auto" : false,
      // Sizes of the siblings, to snap to: "as wide as the one next to it".
      peers: P ? flow(P).filter((it) => it.el !== el).slice(0, 40).map((it) => it.r) : [] });
    d.w = d.w0;
    d.h = d.h0;
    if (d.unflex) liveSet(d.sel, "flex", "none");
    // How far does the dragged edge move per pixel of size? A centred element grows both ways (½).
    const probe = (prop, v0, far, near) => {
      liveSet(d.sel, prop, px(v0 + 16));
      const r = rectOf(el);
      liveSet(d.sel, prop, px(v0));
      const moved = far ? r[near] + r[far] - (r0[near] + r0[far]) : r0[near] - r[near];
      return moved > 5 && moved < 11 ? 0.5 : 1;
    };
    if (z.hx) d.kx = probe("width", d.w0, z.hx > 0 ? "w" : "", "x");
    if (z.hy) d.ky = probe("height", d.h0, z.hy > 0 ? "h" : "", "y");
  }

  function startMove(d, el) {
    const P = el.parentElement;
    const cs = P && getComputedStyle(P);
    const layout = !cs ? "block" : cs.display.includes("flex") ? (cs.flexDirection.startsWith("column") ? "flex-column" : "flex-row") : cs.display.includes("grid") ? "grid" : "block";
    if (layout === "block") return flash("Reordering works inside flex and grid containers for now");
    const items = flow(P);
    const self = items.findIndex((it) => it.el === el);
    if (self < 0) return flash("This element is out of the flow: it can't be reordered");
    if (items.length < 2) return flash("Nothing here to reorder it with");
    const others = items.filter((_, i) => i !== self);
    // Insertion lines, one per place it can go, measured once. Side by side: vertical lines, per
    // row; stacked: horizontal lines.
    const row = items.some((b, i) => i && between(items[i - 1].r, b.r, b.r)?.axis === "x");
    const lines = [];
    if (row) {
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const top = Math.min(...run.map(([it]) => it.r.y)), bot = Math.max(...run.map(([it]) => it.r.y + it.r.h));
        run.forEach(([it, k], j) => {
          const prev = j ? run[j - 1][0].r : null;
          lines.push({ k, x: prev ? (prev.x + prev.w + it.r.x) / 2 : it.r.x - 5, y: top, w: 0, h: bot - top });
        });
        const [end, k] = run[run.length - 1];
        lines.push({ k: k + 1, x: end.r.x + end.r.w + 5, y: top, w: 0, h: bot - top });
        run = [];
      };
      others.forEach((it, k) => {
        if (run.length && it.r.y >= Math.max(...run.map(([o]) => o.r.y + o.r.h)) - 1) flush();
        run.push([it, k]);
      });
      flush();
    } else {
      const x1 = Math.min(...others.map((it) => it.r.x)), x2 = Math.max(...others.map((it) => it.r.x + it.r.w));
      others.forEach((it, k) => {
        const prev = k ? others[k - 1].r : null;
        lines.push({ k, x: x1, y: prev ? (prev.y + prev.h + it.r.y) / 2 : it.r.y - 5, w: x2 - x1, h: 0 });
      });
      const end = others[others.length - 1].r;
      lines.push({ k: others.length, x: x1, y: end.y + end.h + 5, w: x2 - x1, h: 0 });
    }
    Object.assign(d, { mode: "move", el, P, pr: rectOf(P), layout, others, self, lines, r0: items[self].r, k: self, at: null });
    liveSet(C.selRs, "opacity", "0.35");
  }

  function stepDrag(d) {
    const dx = d.x - d.x0 + VP.sx - d.sx, dy = d.y - d.y0 + VP.sy - d.sy;
    const key = `${dx}|${dy}|${d.free}`;
    if (key === d.key) return;
    d.key = key;
    d.snapped = false;
    // Whole pixels always; to a sibling's size or a spacing used nearby when within 3px, else to 4.
    const snap = (v, near) => {
      if (d.free) return Math.max(0, Math.round(v));
      for (const c of near)
        if (Math.abs(v - c) <= 3) {
          d.snapped = true;
          return Math.max(0, Math.round(c));
        }
      return Math.max(0, Math.round(v / 4) * 4);
    };
    const n = (v) => String(Math.round(v));
    if (d.mode === "resize") {
      const z = d.zone;
      if (z.hx) liveSet(d.sel, "width", px((d.w = snap(d.w0 + (z.hx * dx) / d.kx, d.peers.map((r) => d.w0 + r.w - d.r0.w)))));
      if (z.hy) liveSet(d.sel, "height", px((d.h = snap(d.h0 + (z.hy * dy) / d.ky, d.peers.map((r) => d.h0 + r.h - d.r0.h)))));
      d.label = z.hx && z.hy ? `${n(d.w0)} × ${n(d.h0)} → ${n(d.w)} × ${n(d.h)}` : z.hx ? `width ${n(d.w0)} → ${n(d.w)}` : `height ${n(d.h0)} → ${n(d.h)}`;
    } else if (d.mode === "space") {
      const z = d.zone;
      d.val = snap(d.v0 + (z.axis === "x" ? dx : dy), d.near);
      liveSet(d.sel, z.prop, px(d.val));
      d.label = `${z.prop} ${n(d.v0)} → ${n(d.val)}`;
    } else if (d.mode === "move") {
      // The nearest insertion line, in the coordinates the lines were measured in.
      const x = d.x + VP.sx - d.sx, y = d.y + VP.sy - d.sy;
      let best = null, bd = Infinity;
      for (const l of d.lines) {
        const cx = Math.min(Math.max(x, l.x), l.x + l.w), cy = Math.min(Math.max(y, l.y), l.y + l.h);
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < bd) {
          bd = dist;
          best = l;
        }
      }
      d.k = best.k;
      d.at = best.k === d.self ? null : best;
      d.label = d.at ? `${d.self + 1} → ${d.k + 1}` : "";
    }
  }

  function endDrag(d, keep) {
    liveEnd();
    shield(null);
    C.geoKey = "";
    if (!keep || d.mode === "none") return applyAll();
    if (d.mode === "move") {
      if (d.at) commitMove(d.el, d.P, d.others[d.k] ? d.others[d.k].el : null, d.layout);
      return;
    }
    const e = entry(d.el);
    let css = e.css;
    if (d.mode === "space") {
      if (d.val !== d.v0) css = setDecl(css, d.zone.prop, px(d.val));
    } else {
      const w = d.zone.hx && px(d.w) !== px(d.w0), h = d.zone.hy && px(d.h) !== px(d.h0);
      if ((w || h) && d.unflex) css = setDecl(css, "flex", "none");
      if (w) css = setDecl(css, "width", px(d.w));
      if (h) css = setDecl(css, "height", px(d.h));
    }
    const full = css.length > MAX_CSS;
    if (!full) e.css = css;
    commit();
    syncFields(true);
    if (full) flash("This element's styles are full: shorten them first");
  }

  function commitMove(el, P, beforeEl, layout) {
    const prs = stableSel(P), B = C.draft.B;
    const prior = [...C.sent.filter((b) => !C.hide.has(b.id)), C.draft].flatMap((b) => b.B.ops.filter((o) => o.kind === "move" && o.parent.rs === prs));
    const from = ordered(kids(P), prior).indexOf(el);
    const side = (x) => ({ selector: editSel(x), rs: stableSel(x), label: line(plainLabel(x)) });
    const op = { kind: "move", ...meta(el), parent: { ...side(P), layout }, before: beforeEl ? side(beforeEl) : null, fromIndex: from, toIndex: from };
    op.toIndex = ordered(kids(P), [...prior, op]).indexOf(el);
    const last = B.ops[B.ops.length - 1];
    if (last && last.kind === "move" && last.rs === op.rs) {
      // Dragged again: still one move, from where it first was.
      op.fromIndex = last.fromIndex;
      B.ops.pop();
    }
    if (op.toIndex !== op.fromIndex) B.ops.push(op);
    commit();
  }

  function hideSel() {
    const el = C.sel;
    const m = meta(el);
    select(null);
    if (!C.draft.B.ops.some((o) => o.kind === "hide" && o.rs === m.rs)) C.draft.B.ops.push({ kind: "hide", ...m });
    commit();
  }

  function cvWalk(up) {
    let next = up ? C.sel.parentElement : treeKids(C.sel).find((k) => k.getClientRects().length) || null;
    if (next === document.documentElement) next = null;
    if (next) select(next);
  }

  // ── text, edited in place ───────────────────────────────────────────────────────────────────
  // The element itself becomes editable for the moment (plain text only), so the words wrap and
  // look exactly as they will. The attribute goes the moment editing ends, whichever way it ends.
  const inEdit = (e) => e.composedPath().includes(C.edit.el);

  function startEdit(el) {
    if (![...el.childNodes].every((n) => n.nodeType === 3) || !el.textContent.trim())
      return flash(el.childElementCount ? "Double-click the words themselves: this has elements inside" : "No text here to edit");
    if (C.typeTimer) commit();
    const ed = { el, from: el.textContent, had: el.getAttribute("contenteditable"), meta: meta(el), onBlur: () => endEdit(true) };
    C.edit = ed;
    el.setAttribute("contenteditable", "plaintext-only");
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    el.addEventListener("blur", ed.onBlur);
    editCursor(ed.meta.rs);
    drawBar();
    kick();
  }

  function endEdit(keep) {
    const ed = C.edit;
    if (!ed) return;
    C.edit = null;
    const el = ed.el;
    el.removeEventListener("blur", ed.onBlur);
    const typed = line(el.textContent);
    if (ed.had === null) el.removeAttribute("contenteditable");
    else el.setAttribute("contenteditable", ed.had);
    if (el.isConnected) {
      // Back to exactly what it was; if the edit is kept, applyAll writes the new words (and
      // remembers the old ones) like any other edit.
      setText(el, ed.from);
      if (document.activeElement === el) el.blur();
      getSelection()?.removeAllRanges();
    }
    if (keep && el.isConnected && typed && typed !== line(ed.from)) {
      const pad = /^(\s*)[\s\S]*?(\s*)$/.exec(ed.from);
      const ops = C.draft.B.ops;
      const old = ops.find((o) => o.kind === "text" && o.rs === ed.meta.rs);
      const op = { kind: "text", ...ed.meta, from: old ? old.from : ed.from, to: pad[1] + typed + pad[2] };
      if (old) ops.splice(ops.indexOf(old), 1);
      if (op.to !== op.from) ops.push(op);
    }
    editCursor(null);
    C.geoKey = "";
    commit();
    drawBar();
  }

  // ── keys ────────────────────────────────────────────────────────────────────────────────────
  function cvKey(e) {
    const f = root.activeElement;
    const area = f && f.tagName === "TEXTAREA" && f !== textarea ? f : null; // an inspector text area
    const field = area || (f && f.tagName === "INPUT" ? f : null);
    if (C.edit) {
      if (e.key === "Enter" && !e.isComposing) {
        block(e);
        endEdit(true);
      } else if (e.key === "Escape") {
        block(e);
        endEdit(false);
      } else e.stopImmediatePropagation(); // typing: the page's handlers never see it
      return;
    }
    const val = f && f.classList.contains("cval") ? f : null; // a computed value being edited
    const tab = f && f.classList.contains("tab") ? f : null;
    if (e.key === "Escape") {
      block(e);
      if (C.drag) cancelDrag();
      else if (C.pop) setPop(C.pop);
      else if (val) {
        val.value = val.parentElement._v; // back to what it was
        unmarkValue(val.parentElement);
        val.blur();
      } else if (field || f === treeEl || tab) f.blur();
      else if (C.sel) select(null);
      else setCanvas(false);
      return;
    }
    if (e.key === "Enter" && !e.isComposing) {
      // In the inspector Enter is a new line (or, in the class line, "done"); mod+Enter sends.
      if (tab && !mod(e)) return void e.stopImmediatePropagation(); // the switch works as a button does
      if (area || f === clsEl || val ? mod(e) : !e.shiftKey) {
        block(e);
        if (val) setValue(val);
        submitCanvas(e.altKey);
      } else if (f === clsEl) {
        block(e);
        commit();
      } else if (val) {
        block(e);
        setValue(val);
      } else e.stopImmediatePropagation();
      return;
    }
    if (tab && (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (e.key === " ") return void e.stopImmediatePropagation();
      block(e);
      const other = insp.querySelector(e.key === "ArrowLeft" ? ".t-el" : ".t-gl");
      if (!other.disabled) {
        other.focus();
        other.click();
      }
      return;
    }
    if (val && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      block(e);
      const up = e.key === "ArrowUp";
      if (e.altKey) {
        // alt+↑/↓ nudges the first number of the value by 1 (with shift: 10) and writes it.
        val.value = val.value.replace(/-?\d*\.?\d+/, (m) => String(Math.round((Number(m) + (up ? 1 : -1) * (e.shiftKey ? 10 : 1)) * 100) / 100));
        setValue(val);
      } else {
        const row = up ? val.parentElement.previousElementSibling : val.parentElement.nextElementSibling;
        if (row) {
          row.lastChild.focus();
          row.lastChild.select();
        }
      }
      return;
    }
    if (mod(e) && !e.altKey && e.key.toLowerCase() === "z") {
      block(e);
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (area && e.key === "Tab" && !e.shiftKey && !mod(e)) {
      block(e);
      area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
      area.dispatchEvent(new Event("input"));
      return;
    }
    if (field) return void e.stopImmediatePropagation();
    if (f === treeEl && /^Arrow/.test(e.key)) {
      block(e);
      treeKey(e.key);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && C.sel) {
      block(e);
      hideSel();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && C.sel) {
      block(e);
      cvWalk(e.key === "ArrowUp");
      return;
    }
    e.stopImmediatePropagation();
  }

  // ── inspector: the tree ─────────────────────────────────────────────────────────────────────
  // A flat list of the rows that are open, built by walking only the expanded elements, and drawn
  // through a window: however large the page, the tree holds a screenful of row elements.
  const ROW = 20;
  const T = { open: new WeakSet(), rows: [], ver: -1, at: 0, need: true, scroll: 0, first: -1 };
  const treeKids = (el) => [...el.children].filter((c) => !SKIP.test(c.tagName));
  const hasKids = (el) => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!SKIP.test(c.tagName)) return true;
    return false;
  };

  function buildRows() {
    const rows = [];
    const walk = (el, depth) => {
      if (rows.length >= 20000) return;
      rows.push({ el, depth });
      if (T.open.has(el)) for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!SKIP.test(c.tagName)) walk(c, depth + 1);
    };
    if (document.body) {
      if (!T.init) T.open.add((T.init = document.body));
      walk(document.body, 0);
    }
    T.rows = rows;
    T.ver = domVersion;
    T.at = performance.now();
  }

  /** Open the way down to an element and bring its row into view. */
  function reveal(el) {
    for (let a = el.parentElement; a; a = a.parentElement) T.open.add(a);
    buildRows();
    const i = T.rows.findIndex((r) => r.el === el);
    const h = treeHeight();
    // Where to scroll is only noted here. drawTree scrolls, after it has made the pane tall enough
    // for the rows just opened: scrolling first is cut short at the old height by the browser, and
    // the rows were then drawn for a place the pane never reached (a blank pane until touched).
    if (i >= 0 && (i * ROW < T.scroll || (i + 1) * ROW > T.scroll + h)) T.want = Math.max(0, i * ROW - Math.floor(h / 2 / ROW) * ROW);
    T.need = true;
  }
  const treeHeight = () => Math.max(ROW, C.ph - 31);

  function toggleRow(el, open) {
    if (open ?? !T.open.has(el)) T.open.add(el);
    else T.open.delete(el);
    buildRows();
    T.need = true;
    kick();
  }

  function makeRow() {
    const row = document.createElement("div");
    row.className = "trow";
    row.innerHTML = `<span class="tw none">${icon("chevron-right", 12)}</span><span class="tt"></span><span class="ti"></span><span class="tc"></span><span class="tx"></span>`;
    return row;
  }

  function drawTree() {
    // After DOM changes the list is walked again, but not more often than a few times a second.
    if (T.ver !== domVersion && (T.ver < 0 || performance.now() - T.at > 200)) buildRows();
    else if (!T.need) return;
    T.need = false;
    // The pane's height first, then the scroll, then the window of rows: in that order the
    // window is always the one the pane shows.
    const total = `${T.rows.length * ROW}px`;
    if (tspace.style.height !== total) tspace.style.height = total;
    if (T.want != null) {
      treeEl.scrollTop = T.want;
      T.scroll = treeEl.scrollTop; // what the browser made of it
      T.want = null;
    }
    T.scroll = Math.min(T.scroll, Math.max(0, T.rows.length * ROW - ROW)); // the list got shorter under us
    const first = Math.max(0, Math.floor(T.scroll / ROW) - 2);
    const n = Math.max(0, Math.min(T.rows.length - first, Math.ceil(treeHeight() / ROW) + 4));
    if (T.first !== first) trows.style.transform = `translateY(${(T.first = first) * ROW}px)`;
    const els = pool(trows, n, makeRow);
    for (let i = 0; i < n; i++) {
      const { el, depth } = T.rows[first + i];
      const row = els[i];
      row._el = el;
      // Each part of the row is compared with what it shows and written only when it differs:
      // on a page that changes all the time, a redraw of unchanged rows writes nothing.
      const mark = C.marks.get(el);
      const cls = `trow${el === C.sel ? " on" : ""}${el === C.hover ? " hov" : ""}${mark ? ` ${mark}` : ""}`;
      if (row._cls !== cls) row.className = row._cls = cls;
      if (row._depth !== depth) row.style.paddingLeft = `${4 + (row._depth = depth) * 12}px`;
      const names = (el.getAttribute("class") || "").trim();
      // A short preview of the element's own words (not its children's).
      let words = "";
      for (let c = el.firstChild, k = 0; c && k < 12 && words.length < 40; c = c.nextSibling, k++) if (c.nodeType === 3) words += c.data;
      words = line(words);
      const parts = [
        hasKids(el) ? (T.open.has(el) ? "open" : "shut") : "none",
        el.localName,
        el.id ? `#${el.id}` : "",
        names ? `.${names.split(/\s+/).slice(0, 4).join(".")}`.slice(0, 60) : "",
        words.length > 40 ? `${words.slice(0, 39)}…` : words,
      ];
      const shown = row._parts || (row._parts = []);
      if (shown[0] !== parts[0]) row.firstChild.className = `tw ${(shown[0] = parts[0])}`; // the twisty is an icon, turned by its class
      for (let k = 1; k < 5; k++) if (shown[k] !== parts[k]) row.children[k].textContent = shown[k] = parts[k];
    }
  }

  function treeKey(key) {
    const i = T.rows.findIndex((r) => r.el === C.sel);
    const el = C.sel;
    if (i < 0) return void (T.rows[0] && select(T.rows[0].el));
    if (key === "ArrowDown" && T.rows[i + 1]) select(T.rows[i + 1].el);
    else if (key === "ArrowUp" && T.rows[i - 1]) select(T.rows[i - 1].el);
    else if (key === "ArrowRight") {
      if (!T.open.has(el) && hasKids(el)) toggleRow(el, true);
      else if (T.open.has(el) && T.rows[i + 1] && T.rows[i + 1].depth > T.rows[i].depth) select(T.rows[i + 1].el);
    } else if (key === "ArrowLeft") {
      if (T.open.has(el) && hasKids(el)) toggleRow(el, false);
      else if (el !== document.body && el.parentElement) select(el.parentElement);
    }
  }

  // ── inspector: classes, element styles, stylesheet, computed ────────────────────────────────
  /** Put the batch's text into the fields (never into the one being typed in, unless forced). */
  function syncFields(force) {
    if (!insp) return;
    const el = C.sel && C.sel.isConnected ? C.sel : null;
    const e = el && C.draft.B.els[C.selRs];
    const f = root.activeElement;
    const put = (field, v) => {
      if ((force || f !== field) && field.value !== v) field.value = v;
    };
    put(clsEl, el ? el.getAttribute("class") ?? "" : "");
    put(cssEl, e ? e.css : "");
    put(freeEl, C.draft.B.sheet);
    clsEl.disabled = cssEl.disabled = !el;
    const hint = el ? "No classes · type to add" : "Select an element to edit its classes";
    if (clsEl.placeholder !== hint) clsEl.placeholder = hint;
    const name = el ? `${line(plainLabel(el))}${C.marks.get(el)?.includes("hid") ? " · hidden" : ""}` : "Nothing selected";
    if (ipath.textContent !== name) ipath.textContent = name;
    if (force) for (const row of compEl.children) unmarkValue(row);
    drawTabs();
    markAll();
    C.compKey = "";
    if (C.pop === "list" && !C.inPop) {
      C.inPop = true; // (the list measures by switching the draft off and on, which comes back here)
      drawPop();
      C.inPop = false;
    }
    drawBar();
  }

  function markAll() {
    mark(cssEl, false);
    mark(freeEl, true);
    const long = clsEl.value.length > MAX_CLASS;
    if (clsEl._long !== long) {
      clsEl._long = long;
      clsEl.classList.toggle("bad", long);
      clsEl.title = long ? `Too long: more than ${MAX_CLASS} characters. Not applied` : "";
    }
  }

  /** Underline what the browser rejects (in a layer under the text) and say why below the box. */
  function mark(area, sheet) {
    const text = area.value;
    if (area._marked === text) return;
    area._marked = text;
    const max = sheet ? MAX_SHEET : MAX_CSS;
    const bad = text.length > max ? [] : problems(text, sheet);
    const nodes = [];
    let at = 0;
    for (const b of bad) {
      if (b.s < at) continue;
      nodes.push(text.slice(at, b.s));
      const u = document.createElement("u");
      u.textContent = text.slice(b.s, b.e);
      u.title = b.why;
      nodes.push(u);
      at = b.e;
    }
    nodes.push(`${text.slice(at)}\n`);
    area.previousElementSibling.replaceChildren(...nodes);
    const err = area.parentElement.nextElementSibling;
    const msg = text.length > max ? `Too long: ${text.length} / ${max} characters. Not applied; shorten it before sending`
      : bad.length ? `Not applied: ${bad.slice(0, 3).map((b) => b.why).join(" · ")}${bad.length > 3 ? ` · and ${bad.length - 3} more` : ""}` : "";
    if (err.textContent !== msg) err.textContent = msg;
    err.hidden = !msg;
  }

  /** Typing: the page follows within a frame; the undo step closes when the typing pauses. */
  function typed(field) {
    const v = clean(field.value);
    if (v !== field.value) {
      const at = field.selectionStart - (field.value.length - v.length);
      field.value = v;
      field.setSelectionRange(at, at);
    }
    const B = C.draft.B;
    if (field === freeEl) {
      B.sheet = v;
      drawTabs();
    }
    else if (!C.sel) return;
    else if (field === cssEl) entry(C.sel).css = v;
    else {
      const e = entry(C.sel);
      // "From" is the attribute as this batch found it (the page's own, or what an earlier batch left).
      e.cls = { from: e.cls ? e.cls.from : C.sel.getAttribute("class"), to: v.replace(/\s+/g, " ") };
    }
    hush();
    clearTimeout(C.typeTimer);
    C.typeTimer = setTimeout(commit, 700);
    // The key press itself only stores the text. Marking and applying happen in the next frame;
    // on a page where applying is slow (measured: the restyle it causes is forced and timed), it
    // waits for a short pause in the typing instead of running on every frame.
    if (!C.typeRaf)
      C.typeRaf = requestAnimationFrame(() => {
        C.typeRaf = 0;
        markAll();
        clearTimeout(C.slowTimer);
        if (C.slow) C.slowTimer = setTimeout(applyTimed, 100);
        else applyTimed();
      });
  }

  function applyTimed() {
    const t0 = performance.now();
    applyAll();
    void getComputedStyle(document.documentElement).opacity; // the restyle happens now, not later, so it can be timed
    C.slow = performance.now() - t0 > 8;
  }

  /** Computed values as a designer reads them: colours as hex, lengths to a tenth of a pixel. */
  const pretty = (v) =>
    v.replace(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/g, (_, r, g, b, a) =>
      `#${[r, g, b].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}${a === undefined ? "" : Math.round(Number(a) * 255).toString(16).padStart(2, "0")}`)
      .replace(/(-?\d+\.\d\d+)px/g, (_, x) => `${Math.round(Number(x) * 10) / 10}px`);

  function drawComputed() {
    const el = C.sel;
    const now = performance.now();
    // The page changes an element's look without changing the tree: a class or an inline style
    // set by its script (the agent's edit, hot-reloaded, is often just that). domVersion does not
    // count those, so the selection's own two attributes are part of the key; and once a second
    // the values are read again whatever happened (a stylesheet swapped, a class on a parent).
    const attrs = el && el.isConnected ? `${el.getAttribute("class")}|${el.getAttribute("style")}` : "";
    const key = `${C.selRs}|${C.rev}|${domVersion}|${C.collapsed}|${attrs}`;
    if ((key === C.compKey && now - C.compAt < 1000) || now - C.compAt < 150) return;
    C.compKey = key;
    C.compAt = now;
    const live = el && el.isConnected && !C.collapsed;
    // The class line shows the attribute as it is now, unless it is being typed in: typing on
    // top of an old list would record the page's newer classes as removed.
    if (live && root.activeElement !== clsEl) {
      const cls = el.getAttribute("class") ?? "";
      if (clsEl.value !== cls) {
        clsEl.value = cls;
        markAll();
      }
    }
    const cs = live ? getComputedStyle(el) : null;
    const flex = live && cs.display.includes("flex"), grid = live && cs.display.includes("grid");
    // Only what can apply: the flex and grid properties show when the element is one.
    const list = !live ? [] : COMPUTED.filter((p) => (p === "flex-direction" ? flex : p === "align-items" || p === "justify-content" || p === "gap" ? flex || grid : true));
    const e = live && C.draft.B.els[C.selRs];
    const mine = e ? topProps(e.css) : [];
    const rows = pool(compEl, list.length, () => {
      const row = document.createElement("div");
      row.className = "crow";
      // The name copies the line into Element styles; the value is a field that writes it there.
      // (Tab goes from value to value: the names are out of the tab order.)
      row.innerHTML = '<button type="button" class="cp" tabindex="-1" title="Copy into Element styles"></button><input class="cval" type="text" spellcheck="false" autocomplete="off">';
      return row;
    });
    const focused = root.activeElement;
    list.forEach((p, i) => {
      const row = rows[i], field = row.lastChild;
      const v = pretty(cs.getPropertyValue(p));
      // In the accent colour: what this batch has changed on this element.
      const changed = mine.some((m) => m === p || m.startsWith(`${p}-`) || p.startsWith(`${m}-`));
      if (row._p !== p) {
        row.firstChild.textContent = row._p = p;
        field.setAttribute("aria-label", p);
      }
      row._v = v;
      // A value being typed, or one marked as rejected, is the reviewer's: it is left alone.
      if (field !== focused && !row._bad && field.value !== v) field.value = field.title = v;
      if (row._m !== changed) row.classList.toggle("mine", (row._m = changed));
    });
  }

  const unmarkValue = (row) => {
    if (!row._bad) return;
    row._bad = false;
    row.lastChild.classList.remove("bad");
    row.lastChild.title = row._v || "";
  };

  /** A computed value was edited: write `prop: value;` into Element styles (the way a drag does),
   *  unless the browser would not take it; then it is marked, like rejected CSS, and not written. */
  function setValue(field) {
    const row = field.parentElement, p = row._p, v = line(clean(field.value));
    if (!C.sel || !p) return;
    if (!v || v === row._v) {
      field.value = row._v;
      return unmarkValue(row);
    }
    if (!supports(p, v)) {
      row._bad = true;
      field.classList.add("bad");
      field.title = `invalid value for ${p}: not written`;
      return;
    }
    unmarkValue(row);
    const en = entry(C.sel);
    const css = setDecl(en.css, p, v);
    const full = css.length > MAX_CSS;
    if (!full) en.css = css;
    commit();
    syncFields(true);
    if (full) flash("This element's styles are full: shorten them first");
  }

  /** Element | Global: the selection's own styles, or the batch's stylesheet. Without a selection
   *  there is only Global; with one it is Element, unless the reviewer chose Global themselves. */
  function drawTabs() {
    const el = C.sel && C.sel.isConnected ? C.sel : null;
    const global = !el || C.pin;
    const tEl = insp.querySelector(".t-el"), tGl = insp.querySelector(".t-gl");
    const key = `${!!el}|${global}|${!!C.draft.B.sheet.trim()}`;
    if (key === tEl._key) return;
    tEl._key = key;
    tEl.disabled = !el;
    tEl.title = el ? "Classes, styles and computed values of the selection" : "Select an element";
    tEl.classList.toggle("on", !global);
    tGl.classList.toggle("on", global);
    tEl.setAttribute("aria-selected", String(!global));
    tGl.setAttribute("aria-selected", String(global));
    insp.querySelector(".p-el").hidden = global;
    insp.querySelector(".p-gl").hidden = !global;
    tGl.querySelector(".dot").hidden = !C.draft.B.sheet.trim(); // rules are waiting in there
  }

  function setPanel(h, collapsed, settled = true) {
    const opened = C.collapsed && !collapsed;
    C.ph = Math.round(Math.min(Math.max(h, 140), Math.max(140, window.innerHeight * 0.7)));
    C.collapsed = collapsed;
    insp.style.height = `${dock()}px`;
    insp.classList.toggle("shut", collapsed);
    const fold = insp.querySelector(".ifold");
    if (fold._shut !== collapsed) {
      fold._shut = collapsed;
      fold.innerHTML = icon(collapsed ? "chevron-up" : "chevron-down");
      fold.title = collapsed ? "Open the inspector" : "Collapse the inspector";
      fold.setAttribute("aria-label", fold.title);
    }
    // Folded, the tree is not displayed and loses its scroll: opened again, the selection is
    // brought back into view (or the old place, with nothing selected).
    if (opened) {
      T.want = T.scroll;
      if (C.sel) {
        T.scroll = -1e9;
        reveal(C.sel);
      }
    }
    T.need = true;
    if (settled) syncUi(); // the page's scroll room follows when the drag is over, not during it
    drawBar();
    kick();
  }

  function mountCanvas() {
    bar = root.querySelector(".bar");
    corner = root.querySelector(".corner");
    cnote = bar.querySelector(".cnote");
    cv = root.querySelector(".cv");
    [bandEl, ghostEl, insEl, labEl, dimEl] = [".band", ".ghost", ".ins", ".lab.live", ".lab.dim"].map((s) => cv.querySelector(s));
    hitEl = cv.querySelector(".hit");
    gzEl = cv.querySelector(".gzs");
    shieldEl = cv.querySelector(".shield");
    handles = [...cv.querySelectorAll(".hd")];
    edges = [...cv.querySelectorAll(".eg")];
    // What each grab element means, and its cursor: corners (top-left, top-right, bottom-left,
    // bottom-right), then edges (top, right, bottom, left).
    handles.forEach((el, i) => (el._z = { t: "resize", hx: i % 2 ? 1 : -1, hy: i > 1 ? 1 : -1 }));
    edges.forEach((el, i) => (el._z = { t: "resize", hx: i === 1 ? 1 : i === 3 ? -1 : 0, hy: i === 0 ? -1 : i === 2 ? 1 : 0 }));
    for (const el of [...handles, ...edges]) el.style.cursor = cursorOf(el._z);
    insp = root.querySelector(".insp");
    treeEl = insp.querySelector(".tree");
    tspace = insp.querySelector(".tspace");
    trows = insp.querySelector(".trows");
    clsEl = insp.querySelector(".cls");
    cssEl = insp.querySelector(".css");
    freeEl = insp.querySelector(".free");
    compEl = insp.querySelector(".comp");
    ipath = insp.querySelector(".ipath");

    // Keys and typing in the bar and the inspector must not reach the page's own shortcuts.
    // (The same for the mouse on them, and on the grab elements around the selection.)
    for (const box of [bar, corner, insp, cv])
      for (const t of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut", "click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel"])
        box.addEventListener(t, (e) => e.stopPropagation());
    bar.querySelector(".count").addEventListener("click", () => (C.on ? setPop("list") : setCanvas(true)));
    corner.querySelector(".help").addEventListener("click", () => setPop("help"));
    cnote.addEventListener("focus", drawBar);
    cnote.addEventListener("blur", drawBar);
    bar.querySelector(".m-notes").addEventListener("click", () => setCanvas(false));
    bar.querySelector(".m-canvas").addEventListener("click", () => setCanvas(true));
    bar.querySelector(".m-brush").addEventListener("click", () => {
      const on = C.on || !S.brush; // from canvas mode: to notes, with the brush on
      setCanvas(false);
      setBrush(on);
    });
    bar.querySelector(".undo").addEventListener("click", undo);
    bar.querySelector(".reset").addEventListener("click", reset);
    cnote.addEventListener("input", draftChanged);

    for (const f of [clsEl, cssEl, freeEl]) {
      f.addEventListener("input", () => typed(f));
      f.addEventListener("blur", () => (C.typeTimer ? commit() : drawBar()));
      f.addEventListener("focus", drawBar); // the send hint names the key that sends from here
    }
    for (const a of [cssEl, freeEl]) a.addEventListener("scroll", () => (a.previousElementSibling.scrollTop = a.scrollTop), { passive: true });
    for (const [cls, pin] of [[".t-el", false], [".t-gl", true]])
      insp.querySelector(cls).addEventListener("click", (e) => {
        C.pin = pin;
        drawTabs();
        if (e.detail) e.currentTarget.blur(); // by mouse: the keyboard stays with the page (Enter sends)
      });
    compEl.addEventListener("input", (e) => unmarkValue(e.target.parentElement));
    // (blur does not bubble; it is caught on the way down)
    compEl.addEventListener("blur", (e) => e.target.classList && e.target.classList.contains("cval") && setValue(e.target), true);
    compEl.addEventListener("click", (e) => {
      const row = e.target.closest(".crow");
      if (!row || !C.sel || !e.target.classList.contains("cp")) return;
      const en = entry(C.sel);
      const css = setDecl(en.css, row._p, row._v);
      if (css.length <= MAX_CSS) en.css = css;
      commit();
      syncFields(true);
      cssEl.focus({ preventScroll: true });
    });

    treeEl.addEventListener("scroll", () => {
      T.scroll = treeEl.scrollTop;
      T.need = true;
      kick();
    }, { passive: true });
    trows.addEventListener("click", (e) => {
      const row = e.target.closest(".trow");
      if (!row || !row._el) return;
      if (e.target.closest(".tw")) toggleRow(row._el);
      else if (row._el !== C.sel) select(row._el);
    });
    trows.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".trow");
      if (row && row._el && !e.target.closest(".tw")) toggleRow(row._el);
    });
    // mousemove, not mouseover: it comes after the pointermove that says "the pointer left the page".
    trows.addEventListener("mousemove", (e) => {
      const row = e.target.closest(".trow");
      const el = row ? row._el : null;
      if (el === C.hover) return;
      C.hover = el;
      T.need = true;
      kick();
    });
    trows.addEventListener("mouseleave", () => {
      C.hover = null;
      T.need = true;
      kick();
    });

    // The top edge resizes the panel; the button folds it down to its title.
    const grip = insp.querySelector(".grip");
    grip.addEventListener("pointerdown", (e) => {
      grip.setPointerCapture(e.pointerId);
      grip._on = true;
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => grip._on && setPanel(window.innerHeight - e.clientY, false, false));
    const done = () => {
      if (!grip._on) return;
      grip._on = false;
      syncUi();
      try {
        sessionStorage.setItem("b42-inspector", JSON.stringify({ h: C.ph, c: C.collapsed }));
      } catch {}
    };
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
    insp.querySelector(".ifold").addEventListener("click", () => {
      setPanel(C.ph, !C.collapsed);
      try {
        sessionStorage.setItem("b42-inspector", JSON.stringify({ h: C.ph, c: C.collapsed }));
      } catch {}
    });
    setPanel(C.ph, C.collapsed);

    // While text is edited in place, or the pointer works the canvas, the page's own handlers
    // must not see the typing. (keydown has its own path, above.)
    for (const t of ["keyup", "keypress", "beforeinput", "input", "paste", "cut", "copy", "compositionstart", "compositionupdate", "compositionend"])
      window.addEventListener(t, (e) => S.enabled && C.on && !isOurs(e) && e.stopImmediatePropagation(), true);
    drawBar();
  }

  // ── canvas: one frame ───────────────────────────────────────────────────────────────────────
  const place = (el, x, y, w, h, cls) => {
    const k = `${x}|${y}|${w}|${h}|${cls}`;
    if (el._k === k) return;
    el._k = k;
    el.hidden = false;
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (w !== undefined) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    if (cls !== undefined) el.className = cls;
  };
  const gone = (el) => {
    if (el._k === "") return;
    el._k = "";
    el.hidden = true;
  };
  const say = (el, text, x, y, cls) => {
    if (el._t !== text) el.textContent = el._t = text;
    place(el, Math.round(x), Math.round(y), undefined, undefined, cls);
  };

  /** Everything canvas mode does in a frame: the drag's one write, then the reads and the drawing.
   *  Returns the outlines to draw with the others, or null when canvas mode shows nothing. */
  function cvFrame(capturing) {
    if (!bar) return null;
    const show = S.enabled && !capturing;
    if (bar._shown !== show) bar.hidden = corner.hidden = !(bar._shown = show);
    const on = C.on && show;
    if (insp._shown !== on) insp.hidden = !(insp._shown = on);
    if (!on) {
      if (C.drawn) {
        cv.hidden = true;
        C.drawn = false;
      }
      return null;
    }
    if (!C.drawn) {
      cv.hidden = false;
      C.drawn = T.need = true;
      T.want = T.scroll; // a pane that was not displayed has lost its scroll: put it back
    }
    const d = C.drag, now = performance.now();
    if (d && d.mode === "start") startDrag(d);
    const live = !!d && !!d.mode && d.mode !== "none";
    if (live) stepDrag(d);

    // The selection: found again if the page re-rendered it. Its geometry (the siblings, the gaps)
    // is kept relative to its own corner, so scrolling costs nothing; it is measured again when
    // an edit, its size or the window changed, and a few times a second while the DOM changes.
    let r = null;
    if (C.sel && !C.sel.isConnected) {
      if (C.edit) endEdit(false);
      const again = q(C.selRs);
      if (again) {
        C.sel = again;
        reveal(again);
        syncFields();
      } else select(null);
    }
    if (C.sel) {
      r = rectOf(C.sel);
      const key = `${C.rev}|${r.w}|${r.h}|${VP.w}`;
      if (!d && !C.edit && (key !== C.geoKey || (C.geoDom !== domVersion && now - C.geoAt > 200) || now - C.geoAt > 1000)) {
        C.geoKey = key;
        C.geoDom = domVersion;
        C.geoAt = now;
        C.geo = buildGeo(C.sel, r);
        layoutHit(C.geo, r);
        if (C.zone && C.zone.t === "space") C.zone = C.geo.zones[C.zone.i] || null;
      } else if (live && d.mode === "resize" && C.geo) layoutHit(C.geo, r);
    }
    C.r = r;
    if (C.moved && !d) {
      C.moved = false;
      if (!C.over) {
        const h = C.zone ? null : pick(C.px, C.py);
        if (h !== C.hover) {
          C.hover = h;
          T.need = true;
        }
      }
    }

    const z = live ? d.zone : d ? null : C.zone;
    const boxes = [];
    if (C.hover && C.hover.isConnected && C.hover !== C.sel && !d && !C.edit && !z) boxes.push([rectOf(C.hover), "hover"]);
    const seen = !!r && (r.w > 0 || r.h > 0);
    if (seen) boxes.push([r, "csel"]);
    if (seen && C.geo && !C.edit && !(live && d.mode === "move")) place(hitEl, r.x, r.y);
    else gone(hitEl);

    // The gap under the pointer (or being dragged): a tinted band, its value above it.
    let band = null;
    if (z && z.t === "space") {
      band = live ? between(rectOf(z.a), rectOf(z.b), rectOf(z.el))?.rect : r && { x: r.x + z.rel.x, y: r.y + z.rel.y, w: z.rel.w, h: z.rel.h };
      if (band) {
        const bw = Math.max(band.w, 2), bh = Math.max(band.h, 2);
        place(bandEl, Math.round(band.x - (bw - band.w) / 2), Math.round(band.y - (bh - band.h) / 2), Math.round(bw), Math.round(bh));
      }
    }
    if (!band) gone(bandEl);

    const floor = VP.h - dock();
    if (live && d.mode === "move") {
      const ox = VP.sx - d.sx, oy = VP.sy - d.sy;
      // The ghost follows the pointer but stays inside its parent (and the window).
      const gx = Math.min(Math.max(d.r0.x + d.x - d.x0, Math.max(0, d.pr.x - ox)), Math.max(Math.max(0, d.pr.x - ox), Math.min(VP.w, d.pr.x - ox + d.pr.w) - d.r0.w));
      const gy = Math.min(Math.max(d.r0.y + d.y - d.y0, Math.max(0, d.pr.y - oy)), Math.max(Math.max(0, d.pr.y - oy), Math.min(floor, d.pr.y - oy + d.pr.h) - d.r0.h));
      place(ghostEl, Math.round(gx), Math.round(gy), Math.round(d.r0.w), Math.round(d.r0.h));
      if (d.at) place(insEl, Math.round(d.at.x - ox) - (d.at.w ? 0 : 1.5), Math.round(d.at.y - oy) - (d.at.h ? 0 : 1.5), Math.max(3, d.at.w), Math.max(3, d.at.h), `ins ${d.at.w ? "h" : "v"}`);
      else gone(insEl);
    } else {
      gone(ghostEl);
      gone(insEl);
    }

    // Labels: the live one sits 12px off the pointer; a gap's value sits above its band; the
    // selection's size sits under it, unless the dock covers that spot.
    if (live && d.label) say(labEl, d.label, Math.min(d.x + 12, VP.w - 180), Math.min(d.y + 12, floor - 24), `lab live${d.snapped ? " snap" : ""}`);
    else if (band && !d) say(labEl, `${z.prop} ${Math.round(z.value)}`, band.x + band.w / 2, Math.max(10, band.y - 12), "lab live mid");
    else gone(labEl);
    if (seen && !d && !C.edit && r.y + r.h + 26 <= floor && r.y + r.h + 14 > 0) say(dimEl, `${Math.round(r.w)} × ${Math.round(r.h)}`, r.x + r.w / 2, r.y + r.h + 14, "lab dim mid");
    else gone(dimEl);

    if (!C.collapsed) {
      drawTree();
      drawComputed();
    }
    return boxes;
  }

  // ── input ───────────────────────────────────────────────────────────────────────────────────
  const isOurs = (e) => !!hostEl && e.composedPath().includes(hostEl);
  const block = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  function onPointerDown(e) {
    if (!S.enabled) return;
    const zone = C.on ? zoneOf(e) : null; // a handle, an edge or a gap of the canvas selection: ours, but a page gesture
    if (isOurs(e) && !zone) return;
    if (C.pop) setPop(C.pop); // a click on the page closes whichever list is open
    if (C.edit && inEdit(e)) return void e.stopImmediatePropagation(); // the caret goes where it is clicked
    block(e);
    if (e.button !== 0) return;
    if (S.pending) {
      // The host is still taking the previous note's screenshot: hold this click until it's done,
      // so the new outline can't land in that screenshot. (A drag started now is dropped.)
      S.buffered = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
      return;
    }
    if (C.on) return cvDown(e, zone);
    S.drag = {
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      mode: null,
      alt: e.altKey || S.brush, // the bar's brush: a plain drag draws, as alt+drag does
      shift: e.shiftKey,
      pts: [[e.clientX + window.scrollX, e.clientY + window.scrollY]],
    };
  }

  function onPointerMove(e) {
    if (!S.enabled) return;
    if (C.on) return cvMove(e);
    const d = S.drag;
    if (!d) {
      const next = isOurs(e) ? null : pick(e.clientX, e.clientY);
      if (next !== S.hover) {
        S.hover = next;
        kick();
      }
      return;
    }
    block(e);
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.mode && Math.hypot(d.x - d.x0, d.y - d.y0) > DRAG_PX) d.mode = d.alt ? "draw" : "area";
    if (d.mode === "draw") {
      const [lx, ly] = toView(d.pts[d.pts.length - 1]);
      if (Math.hypot(d.x - lx, d.y - ly) > 2) d.pts.push([d.x + window.scrollX, d.y + window.scrollY]);
    }
    kick();
  }

  function onPointerUp(e) {
    if (C.on) return void (S.enabled && cvUp(e));
    const d = S.drag;
    if (!S.enabled || !d) return;
    block(e);
    S.drag = null;
    if (d.mode === "draw" && d.pts.length >= 2) {
      S.strokes.push(d.pts);
      if (!S.sel.length) S.sel = strokeTargets(d.pts);
      openCard();
      return;
    }
    if (d.mode === "area") {
      const r = { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
      if (r.w >= 6 && r.h >= 6) {
        const inside = elementsIn(r);
        S.sel = d.shift ? [...new Set([...S.sel, ...inside])] : inside;
        S.area = { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.w, h: r.h };
        openCard();
        return;
      }
    }
    const el = pick(d.x0, d.y0);
    if (!el) return;
    if (d.shift) {
      const i = S.sel.indexOf(el);
      if (i >= 0) S.sel.splice(i, 1);
      else S.sel.push(el);
    } else {
      S.sel = [el];
      S.area = null;
    }
    if (hasDraft()) openCard();
    else clearDraft();
  }

  function blockIfActive(e) {
    if (!S.enabled || isOurs(e)) return;
    // While text is edited in place, the mouse works inside it (caret, selection); the page's own
    // handlers still see nothing, and a click still does nothing (no link is followed).
    if (C.edit && inEdit(e) && /^(mousedown|mouseup|selectstart|dblclick)$/.test(e.type)) e.stopImmediatePropagation();
    else block(e);
  }

  function onKeyDown(e) {
    if (mod(e) && e.shiftKey && e.code === "KeyM") {
      block(e);
      send({ type: "toggle" });
      return;
    }
    if (!S.enabled) return;
    if (mod(e) && !e.shiftKey && !e.altKey && e.code === "KeyE") {
      block(e);
      setCanvas(!C.on);
      return;
    }
    if (C.on) return cvKey(e);
    if (e.key === "Escape" && C.pop) {
      block(e);
      setPop(C.pop);
      return;
    }
    if (e.key === "Escape") {
      block(e);
      if (S.menu) {
        // First Esc closes the template list and keeps the selection.
        textarea.value = "";
        updateMenu();
        autosize();
      } else if (S.card || hasDraft()) {
        // Typed words are not thrown away on a slip: for a few seconds mod+Z brings the note back.
        const kept = textarea.value.trim() ? { ...serializeDraft(), images: S.images } : null;
        clearDraft();
        setBrush(false);
        if (kept) offerUndo(kept);
      }
      else send({ type: "toggle", enabled: false });
      return;
    }
    if (S.undo && mod(e) && !e.shiftKey && e.key.toLowerCase() === "z") {
      block(e);
      const d = S.undo;
      hideSent();
      restoreDraft(d);
      setImages(d.images || []);
      return;
    }
    if (!S.card) return;
    if (S.menu) {
      // The template list is open: arrows move in it, Enter or Tab picks, Esc (above) cancels.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        block(e);
        S.menuAt = (S.menuAt + (e.key === "ArrowDown" ? 1 : S.menu.length - 1)) % S.menu.length;
        drawMenu();
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
        block(e);
        pickTemplate(S.menu[S.menuAt]);
        return;
      }
    }
    if (e.key === "Backspace" && S.template && !textarea.value) {
      block(e);
      setTemplate(null);
      draftChanged();
      return;
    }
    const empty = !textarea.value;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && S.sel.length === 1 && (empty || e.altKey)) {
      block(e);
      walk(e.key === "ArrowUp" ? "up" : "down");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      block(e);
      submit(e.altKey);
      return;
    }
    if (mod(e) && !e.shiftKey && e.key.toLowerCase() === "z" && S.strokes.length && empty) {
      block(e);
      S.strokes.pop();
      if (!hasDraft()) clearDraft();
      else {
        updateCardMeta();
        draftChanged();
      }
      kick();
    }
  }

  function setEnabled(on) {
    S.enabled = on;
    document.documentElement.toggleAttribute("data-b42-review", on);
    pinsEl.classList.toggle("live", on);
    if (!on) {
      S.hover = null;
      S.drag = null;
      card.hidden = true;
      hideTip();
      hideSent();
      endEdit(true);
      cancelDrag();
      setBrush(false);
    } else if (S.card) {
      card.hidden = false;
      textarea.focus({ preventScroll: true });
    }
    syncUi();
    kick();
  }

  function setPins(pins) {
    const old = new Map(S.pins.map((p) => [p.id, p]));
    S.pins = (pins || []).map((p) => ({ ...p, el: old.get(p.id)?.el }));
    if (C.sent.length) dropFinished();
    kick();
  }

  // ── render ──────────────────────────────────────────────────────────────────────────────────
  const SVG = "http://www.w3.org/2000/svg";

  function pool(container, n, make) {
    while (container.children.length < n) container.appendChild(make());
    while (container.children.length > n) container.lastChild.remove();
    return [...container.children];
  }

  function placeBox(div, r, cls) {
    // Most frames an outline has not moved: nothing is written then (no restyle for an idle selection).
    const k = `${cls}|${r.x}|${r.y}|${r.w}|${r.h}`;
    if (div._k === k) return;
    div._k = k;
    div.className = `box ${cls}`;
    div.style.transform = `translate(${r.x}px, ${r.y}px)`;
    div.style.width = `${r.w}px`;
    div.style.height = `${r.h}px`;
  }

  /** Where a pin sits: the top-left of the element, or of its text when it holds only text
   *  (a full-width heading would otherwise put the pin at the page edge, far from the words). */
  let pinRange = null;
  function pinPoint(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    if (el.childElementCount === 0 && el.textContent.trim()) {
      // One Range for all pins and frames: every live Range has to be kept up to date by the
      // browser on each DOM change, so a new one per pin per frame makes the page's own writes slow.
      const range = pinRange || (pinRange = document.createRange());
      range.selectNodeContents(el);
      const t = range.getBoundingClientRect();
      range.setStart(document, 0);
      range.collapse(true);
      if (t.width > 0) return [t.left - 12, t.top - 6];
    }
    // Just outside the top-left corner, so the pin marks the element without covering it.
    return [r.left - 8, r.top - 8];
  }

  function render() {
    if (!root) return;
    readView();
    // A batch hidden for the host's "before" picture counts as a capture: no chrome in that picture.
    const capturing = !!S.pending || C.hide.size > 0;
    const d = S.drag;
    drawVariants(capturing);
    const canvasBoxes = cvFrame(capturing);

    // boxes: hover + selection
    const items = [];
    if (S.enabled && !capturing && !d && !C.on && S.hover && S.hover.isConnected && !S.sel.includes(S.hover))
      items.push([rectOf(S.hover), "hover"]);
    if (S.enabled || capturing) for (const el of S.sel) if (el.isConnected) items.push([rectOf(el), "sel"]);
    if (canvasBoxes) items.push(...canvasBoxes);
    const divs = pool(boxes, items.length, () => document.createElement("div"));
    items.forEach(([r, cls], i) => placeBox(divs[i], r, cls));

    // ink: committed strokes, area, and the live drag
    // Strokes are drawn in document coordinates inside a group shifted by the scroll, so the
    // pencil grain (noise in the group's own coordinates) stays put on the page as it scrolls.
    // The filter only works out the visible part of the page.
    const show = S.enabled || capturing;
    const paths = show ? S.strokes.slice() : [];
    if (d && d.mode === "draw") paths.push(d.pts);
    const sx = VP.sx, sy = VP.sy;
    const inkKey = `${sx}|${sy}|${VP.w}|${VP.h}`;
    // Only strokes need the ink moved with the scroll: with none drawn, scrolling writes nothing here.
    if (paths.length && ink._key !== inkKey) {
      ink._key = inkKey;
      strokesEl.setAttribute("transform", `translate(${-sx} ${-sy})`);
      pencil.setAttribute("x", sx - 50);
      pencil.setAttribute("y", sy - 50);
      pencil.setAttribute("width", VP.w + 100);
      pencil.setAttribute("height", VP.h + 100);
    }
    const areas = [];
    if (show && S.area) areas.push(docToViewRect(S.area));
    if (d && d.mode === "area") areas.push({ x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) });
    const pathEls = pool(strokesEl, paths.length, () => document.createElementNS(SVG, "path"));
    paths.forEach((pts, i) => {
      // A drawn stroke stays as it is, and the one being drawn only grows: the same points and
      // the same count mean the same path. Writing it again would repaint the ink every frame.
      const el = pathEls[i];
      if (el._pts === pts && el._n === pts.length) return;
      el._pts = pts;
      el._n = pts.length;
      el.setAttribute("d", `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}`);
    });
    const rectEls = pool(ink.querySelector(".areas"), areas.length, () => document.createElementNS(SVG, "rect"));
    areas.forEach((r, i) => {
      rectEls[i].setAttribute("x", r.x);
      rectEls[i].setAttribute("y", r.y);
      rectEls[i].setAttribute("width", r.w);
      rectEls[i].setAttribute("height", r.h);
    });

    // card
    if (S.card && S.enabled && !capturing) placeCard();

    // pins
    const visible = [];
    const unplaced = [];
    const now = performance.now();
    for (const p of S.pins) {
      let at = null;
      let approx = false;
      if (p.selector || p.text) {
        // Search again only after the DOM changed (a text search is too heavy for every frame).
        // The first search after an element goes is immediate, and so is the next (a re-render
        // often removes and adds in two steps); a pin that stays missing on a page that keeps
        // changing is then looked for less and less often, down to once a second.
        if ((!p.el || !p.el.isConnected) && p.searched !== domVersion && now >= (p.retryAt || 0)) {
          p.searched = domVersion;
          p.el = findPin(p);
          p.misses = p.el ? 0 : (p.misses || 0) + 1;
          p.retryAt = p.misses > 1 ? now + Math.min(1000, 16 * 2 ** (p.misses - 1)) : 0;
        }
        if (p.el && p.el.isConnected) at = pinPoint(p.el);
      }
      if (!at && p.at) {
        at = toView(p.at);
        approx = !!(p.selector || p.text);
      }
      if (!at || approx) unplaced.push(p.id);
      if (at && !capturing) visible.push([p, at, approx]);
    }
    const pinEls = pool(pinsEl, visible.length, makePin);
    if (!visible.length) hideTip();
    visible.forEach(([p, [x, y], approx], i) => {
      const el = pinEls[i];
      el._pin = p;
      const cx = Math.min(Math.max(10, x), VP.w - 10);
      const cy = Math.min(Math.max(10, y), VP.h - 10);
      // Most frames nothing moved: don't touch the DOM for a pin that looks the same.
      const drawn = `${p.n}|${p.status}|${p.lane}|${approx}|${cx}|${cy}`;
      if (el._drawn === drawn) return;
      el._drawn = drawn;
      // While the page scrolls only the place changes: the class and the number are left alone.
      const cls = `pin ${p.status || "queued"}${p.lane === "bg" ? " bg" : ""}${approx ? " approx" : ""}`;
      const num = String(p.n ?? "");
      if (el._cls !== cls) el.className = el._cls = cls;
      if (el._num !== num) el.textContent = el._num = num;
      el.style.transform = `translate(${cx}px, ${cy}px)`;
    });
    const key = unplaced.join(",");
    if (key !== S.unplaced) {
      S.unplaced = key;
      send({ type: "pins-placement", unplaced });
    }
  }

  // Draw every frame only while a note is being made or the reviewer is doing something (outlines
  // must follow the layout as it moves). Otherwise the layer redraws when something says it may
  // have moved: DOM changes, scroll, resize. A slow tick covers what none of those report (CSS
  // animations, late-loading images), so idle pins cost a few redraws a second, not sixty.
  const IDLE_TICK_MS = 250;
  const ACTIVE_MS = 500;
  let idleTimer = 0;
  let lastInput = 0;
  function active() {
    lastInput = performance.now();
    kick();
  }
  function frame() {
    raf = 0;
    render();
    // Through kick(): something in render() may have asked for the next frame already, and a
    // second request here would start a second chain (two renders a frame until the selection goes).
    if (S.card || S.sel.length || S.drag || S.pending || (C.on && (C.sel || C.drag || C.edit)) || performance.now() - lastInput < ACTIVE_MS)
      kick();
    else if ((S.enabled || S.pins.length) && !idleTimer)
      idleTimer = setTimeout(() => {
        idleTimer = 0;
        kick();
      }, IDLE_TICK_MS);
  }

  function kick() {
    if (!raf && root) raf = requestAnimationFrame(frame);
  }

  // ── mount ───────────────────────────────────────────────────────────────────────────────────
  // Pencil strokes: noise nudges the edge, and a fine paper grain cuts small breaks into the line
  // (alpha = 4.4·grain − 1.3), like graphite on paper. Picked in harness/strokes.html.
  const PENCIL = `<filter id="b42-pencil" filterUnits="userSpaceOnUse">
    <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="11" result="edge"/>
    <feDisplacementMap in="SourceGraphic" in2="edge" scale="2" xChannelSelector="R" yChannelSelector="G" result="line"/>
    <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="2" result="grain"/>
    <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4.4 0 0 0 -1.3" result="tooth"/>
    <feComposite in="line" in2="tooth" operator="in"/>
  </filter>`;

  const STYLES = `
    :host { all: initial; }
    .ink { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
    .ink path { fill: none; stroke: #ef4444; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .ink rect { fill: color-mix(in srgb, var(--pa) 10%, transparent); stroke: var(--pa); stroke-width: 1.5; stroke-dasharray: 5 4; }
    .box { position: fixed; left: 0; top: 0; box-sizing: border-box; border-radius: 3px; pointer-events: none; }
    .box.hover { border: 1.5px dashed #3b82f6; background: rgba(59, 130, 246, 0.06); }
    .box.sel { border: 2px solid var(--pa); background: color-mix(in srgb, var(--pa) 10%, transparent); }
    /* The same badge as in the app's notes list: 20 px, the same rounded-square corners, bold mono
       digits, dark ink on amber and green, no ring. */
    .pin { position: fixed; left: -10px; top: -10px; box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 5px;
      border-radius: 10px; corner-shape: superellipse(1.333); font: 700 12px/20px ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; text-align: center;
      font-variant-numeric: tabular-nums; color: #fff; background: #6b7280;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); pointer-events: none; }
    .pins.live .pin { pointer-events: auto; cursor: pointer; }
    .pins.live .pin:hover { box-shadow: 0 0 0 2px var(--pa); }
    .vbar { position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 3px; box-sizing: border-box;
      pointer-events: auto; background: #1a1a1b; color: #ededed; border-radius: 8px; white-space: nowrap;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.12); font: 13px/1 system-ui, -apple-system, sans-serif; }
    .vbar button { all: unset; box-sizing: border-box; min-width: 26px; height: 22px; padding: 0 6px; border-radius: 5px; text-align: center;
      cursor: pointer; font: inherit; line-height: 22px; }
    .vbar button:hover { background: rgba(255, 255, 255, 0.1); }
    .vbar button:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .vname { padding: 0 6px; font-variant-numeric: tabular-nums; }
    .vkeep { margin-left: 4px; padding: 0 10px !important; background: #fffaa0; color: #171717; font-weight: 600 !important; }
    .vbar .vkeep:hover { background: #fffcc4; }
    .pin.paused { background: #fff; color: #171717; box-shadow: inset 0 0 0 1.5px #f59e0b, 0 1px 3px rgba(0, 0, 0, 0.3); }
    .tip, .sent { position: fixed; left: 0; top: 0; box-sizing: border-box; pointer-events: none; background: #1a1a1b; color: #ededed;
      border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12);
      font: 13px/1.4 system-ui, -apple-system, sans-serif; }
    .tip { max-width: 280px; padding: 8px 10px; overflow-wrap: anywhere; }
    .tip[hidden], .sent[hidden] { display: none; }
    .tip-state { margin-bottom: 2px; color: #9ca3af; font-size: 12px; font-variant-numeric: tabular-nums; }
    .tip-state.working { color: #fbbf24; }
    .tip-state.done { color: #4ade80; }
    .tip-state.failed { color: #f87171; }
    .sent { padding: 6px 10px; color: #fffaa0; font-weight: 600; font-variant-numeric: tabular-nums;
      animation: sent 1.8s ease-out both; }
    @keyframes sent { 0% { opacity: 0; } 8% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .sent { animation: none; } .pin.working { animation: none; } }
    .pin.working { background: #f59e0b; color: #10100e; animation: pulse 1s ease-in-out infinite; }
    .pin.done { background: #16a34a; color: #10100e; }
    .pin.failed { background: #dc2626; }
    .pin.stopped { background: #fff; color: #171717; box-shadow: inset 0 0 0 1.5px #6b7280, 0 1px 3px rgba(0, 0, 0, 0.3); }
    .pin.bg { border-radius: 4px; }
    .pin.approx { box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.35); opacity: 0.75; }
    @keyframes pulse { 50% { opacity: 0.55; } }
    .card { position: fixed; left: 0; top: 0; box-sizing: border-box; padding: 10px; background: #1a1a1b; color: #ededed;
      border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12);
      font: 14px/1.45 system-ui, -apple-system, sans-serif; pointer-events: auto; }
    .card[hidden] { display: none; }
    .meta { display: flex; justify-content: space-between; gap: 12px; margin: 0 2px 8px; color: #d4d4d4; font-size: 12px; }
    .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fffaa0; font-weight: 500; }
    .hint { flex: none; }
    .hint.warn { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fbbf24; }
    textarea { all: unset; display: block; width: 100%; box-sizing: border-box; min-height: 44px; max-height: 240px;
      overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 4px 2px; color: #ededed; font: inherit;
      cursor: text; }
    textarea::placeholder { color: #9ca3af; }
    .chip { all: unset; display: inline-block; margin: 0 2px 4px; padding: 1px 8px; border-radius: 6px; cursor: pointer;
      background: rgba(255, 250, 160, 0.16); color: #fffaa0; font: 500 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .chip[hidden], .menu[hidden] { display: none; }
    .chip:hover::after { content: ""; display: inline-block; width: 9px; height: 9px; margin-left: 6px; background: currentColor;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m3 3 10 10M13 3 3 13'/%3E%3C/svg%3E") center / contain no-repeat; }
    .chip:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .menu { margin: 6px -4px -2px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.1); max-height: 216px; overflow: auto; }
    .opt { display: flex; align-items: baseline; gap: 10px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
    .opt.on, .opt:hover { background: rgba(255, 255, 255, 0.08); }
    .opt-name { flex: none; color: #fffaa0; font: 500 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .opt-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9ca3af; font-size: 13px; }
    .refs { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 2px 2px; }
    .refs[hidden] { display: none; }
    .ref { all: unset; position: relative; width: 56px; height: 56px; border-radius: 6px; overflow: hidden; cursor: pointer;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.16); }
    .ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ref:hover::after, .ref:focus-visible::after { content: ""; position: absolute; inset: 0;
      background: rgba(17, 24, 39, 0.7) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23f9fafb' stroke-width='1.4' stroke-linecap='round'%3E%3Cpath d='m4 4 8 8M12 4l-8 8'/%3E%3C/svg%3E") center / 20px no-repeat; }
    .ref:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    /* canvas mode: on-page marks */
    [hidden] { display: none !important; }
    .box.csel { border: 1.5px solid var(--pa); }
    .cv > * { position: fixed; left: 0; top: 0; box-sizing: border-box; pointer-events: none; }
    /* What the pointer grabs around the selection: the layer's own elements, so the cursor is theirs. */
    .hit > *, .gzs > * { position: absolute; left: 0; top: 0; box-sizing: border-box; pointer-events: auto; touch-action: none; }
    .hit > .gzs { pointer-events: none; }
    .hd::after { content: ""; position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; box-sizing: border-box;
      background: #fff; border: 1.5px solid var(--pa); border-radius: 2px; }
    .cv > .shield { inset: 0; pointer-events: auto; }
    .band { background: color-mix(in srgb, var(--pa) 22%, transparent) repeating-linear-gradient(135deg, color-mix(in srgb, var(--pa) 60%, transparent) 0 1px, transparent 1px 5px); }
    .ghost { border: 1.5px dashed var(--pa); border-radius: 3px; background: color-mix(in srgb, var(--pa) 12%, transparent); }
    .ins { background: var(--pa); border-radius: 2px; }
    .ins::before, .ins::after { content: ""; position: absolute; width: 9px; height: 9px; border-radius: 50%; background: var(--pa); }
    .ins.v::before { left: -3px; top: -5px; } .ins.v::after { left: -3px; bottom: -5px; }
    .ins.h::before { top: -3px; left: -5px; } .ins.h::after { top: -3px; right: -5px; }
    .lab { padding: 2px 6px; border-radius: 5px; background: #1a1a1b; color: #ededed; white-space: nowrap;
      font: 500 11px/16px ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.12); }
    .lab.live { color: #fffaa0; }
    .lab.snap { background: #fffaa0; color: #171717; }
    .lab.mid { translate: -50% -50%; }
    /* canvas mode: the bar. In canvas mode its width is fixed, so nothing in it moves as the state changes. */
    .bar { position: fixed; left: 100px; right: 56px; bottom: 14px; width: max-content; margin: 0 auto; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 5px;
      box-sizing: border-box; max-width: calc(100vw - 156px); pointer-events: auto; background: #1a1a1b; color: #ededed; border-radius: 8px; white-space: nowrap;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12); font: 13px/1 system-ui, -apple-system, sans-serif; }
    .bar.canvas { width: 580px; }
    .seg { display: flex; flex: none; padding: 2px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); }
    .seg button, .act, .ifold, .count { all: unset; box-sizing: border-box; height: 24px; padding: 0 10px; border-radius: 5px; cursor: pointer; font: inherit; line-height: 24px; color: #b4b4b4; }
    .seg button:hover, .act:hover, .ifold:hover { color: #fff; }
    .seg button.on { background: rgba(255, 255, 255, 0.14); color: #fff; }
    /* The brush: a bubble of its own to the left of the bar, same surface and height. The bar is
       shifted by half of it (and the gap), so the pair is centred together. */
    .m-brush { all: unset; position: absolute; right: calc(100% + 8px); top: 0; width: 36px; height: 36px; box-sizing: border-box; display: grid; place-items: center;
      border-radius: 8px; background: #1a1a1b; color: #b4b4b4; cursor: pointer;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12); }
    .m-brush:hover { color: #fff; }
    .m-brush.on { background: #fffaa0; color: #171717; }
    .m-brush:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .bar.canvas .m-canvas.on { background: #fffaa0; color: #171717; font-weight: 600; }
    .act { flex: none; padding: 0 8px; color: #ededed; }
    .act:hover, .count:hover, .count.open { background: rgba(255, 255, 255, 0.1); }
    .act:disabled, .count:disabled { color: #6b6b6b; background: none; cursor: default; }
    .seg button:focus-visible, .act:focus-visible, .ifold:focus-visible, .count:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .count { flex: none; padding: 0 8px; color: #fffaa0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .bar.canvas .count { min-width: 66px; text-align: center; }
    .count .ic { display: none; margin-left: 3px; vertical-align: -1px; }
    .bar.canvas .count:not(:disabled) .ic { display: inline-block; }
    /* The bar sits between the brush (left) and the "?" (corner): 44px more room on its left makes
       the brush and the bar centre as a pair. Where that does not fit, the bar gives way, not the "?". */
    @media (max-width: 740px) { .bar { left: 52px; max-width: calc(100vw - 108px); } }
    .corner { position: fixed; right: 12px; bottom: 14px; width: 36px; height: 36px; pointer-events: auto; font: 13px/1 system-ui, -apple-system, sans-serif; }
    .help { all: unset; display: grid; place-items: center; width: 36px; height: 36px; box-sizing: border-box; border-radius: 8px; background: #1a1a1b; color: #b4b4b4;
      cursor: pointer; font: 600 14px/1 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12); }
    .help:hover, .help.on { color: #fff; }
    .help:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .corner .pop { left: auto; right: 0; width: min(400px, calc(100vw - 24px)); color: #ededed; }
    .cnote { all: unset; box-sizing: border-box; flex: 1 1 0; min-width: 0; height: 24px; padding: 0 8px; border-radius: 5px;
      background: rgba(255, 255, 255, 0.08); color: #ededed; font: inherit; cursor: text; }
    .cnote::placeholder, .cls::placeholder, .ed textarea::placeholder { color: #8b8b8b; font: italic 12px/18px system-ui, -apple-system, sans-serif; }
    .cnote:focus, .cls:focus, .ed textarea:focus { box-shadow: 0 0 0 1.5px rgba(255, 250, 160, 0.7); }
    .bmsg { flex: 1 1 0; min-width: 0; padding: 0 4px; color: #9ca3af; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
    .bmsg.warn { color: #fbbf24; }
    .bsend { flex: none; min-width: 74px; text-align: right; color: #d4d4d4; font-size: 12px; }
    .bsend.off { color: #6b6b6b; }
    .pop { position: absolute; left: 0; right: 0; bottom: 42px; max-height: min(50vh, 320px); overflow: auto; padding: 4px; box-sizing: border-box; white-space: normal;
      background: #1a1a1b; border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12); font-size: 12px; line-height: 1.4; }
    .erow, .hrow { display: flex; align-items: baseline; gap: 6px; padding: 4px 4px 4px 8px; border-radius: 5px; }
    .erow { cursor: pointer; }
    .erow:hover { background: rgba(255, 255, 255, 0.08); }
    .erow .el { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fffaa0; font-weight: 500; }
    .erow .et { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d4d4d4; }
    .ex { all: unset; flex: none; display: grid; place-items: center; width: 24px; height: 24px; margin: -2px 0; align-self: center; border-radius: 4px; color: #9ca3af; cursor: pointer; }
    .ex:hover { background: rgba(248, 113, 113, 0.2); color: #f87171; }
    .ex:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .hk { flex: 0 0 190px; color: #ededed; }
    .hv { flex: 1; color: #9ca3af; }
    /* canvas mode: the inspector */
    .insp { position: fixed; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; box-sizing: border-box; pointer-events: auto;
      background: #1a1a1b; color: #ededed; border-radius: 8px 8px 0 0; font: 13px/1.4 system-ui, -apple-system, sans-serif;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.12); }
    .grip { position: absolute; left: 0; right: 0; top: -4px; height: 9px; cursor: ns-resize; touch-action: none; }
    .grip::after { content: ""; position: absolute; left: 50%; top: 6px; width: 36px; height: 3px; margin-left: -18px; border-radius: 2px; background: rgba(255, 255, 255, 0.22); }
    .grip:hover::after { background: #fffaa0; }
    .insp.shut .grip { display: none; }
    .ihead { flex: none; display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 6px 0 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
    .insp.shut .ihead { border-bottom: 0; }
    .ititle { font-weight: 600; }
    .ipath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fffaa0; }
    .ifold { flex: none; display: grid; place-items: center; width: 28px; height: 24px; padding: 0; }
    .ibody { flex: 1; min-height: 0; display: flex; }
    .insp.shut .ibody { display: none; }
    .tree { flex: 0 0 44%; min-width: 0; overflow: auto; outline: none; border-right: 1px solid rgba(255, 255, 255, 0.1);
      font: 12px/20px ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; }
    .tree:focus-visible { box-shadow: inset 0 0 0 1.5px rgba(255, 250, 160, 0.5); }
    .tspace { position: relative; min-width: max-content; }
    .trow { height: 20px; padding-right: 12px; white-space: nowrap; cursor: default; }
    .trow.hov { background: rgba(255, 255, 255, 0.06); }
    .trow.on { background: rgba(255, 250, 160, 0.2); box-shadow: inset 2px 0 0 #fffaa0; }
    /* Edited in a batch: a small dot. Hidden by one: struck through and dimmed, still selectable. */
    .trow.ed::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 8px; border-radius: 50%; background: #fffaa0; vertical-align: 1px; }
    .trow.hid .tt, .trow.hid .ti, .trow.hid .tc { text-decoration: line-through; opacity: 0.5; }
    .trow.hid .tx { opacity: 0.5; }
    .tw { display: inline-grid; place-items: center; width: 16px; height: 20px; vertical-align: top; color: #9ca3af; cursor: pointer; }
    .tw.open .ic { rotate: 90deg; }
    .tw.none { visibility: hidden; }
    .tt { color: #ededed; } .ti { color: #fffaa0; } .tc { color: #9ca3af; }
    .tx { margin-left: 8px; color: #6f7684; font-style: italic; }
    .side { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    /* Element: the selection's classes, styles and computed values. Global: the batch's stylesheet. */
    .tabs { flex: none; display: flex; gap: 2px; width: max-content; margin: 8px 12px 0; padding: 2px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); }
    .tab { all: unset; box-sizing: border-box; height: 22px; padding: 0 10px; border-radius: 5px; color: #b4b4b4; font-size: 12px; line-height: 22px; cursor: pointer; }
    .tab:hover { color: #fff; }
    .tab.on { background: rgba(255, 255, 255, 0.14); color: #fff; }
    .tab:disabled { color: #6b6b6b; cursor: default; }
    .tab:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .dot { display: inline-block; width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: #fffaa0; vertical-align: 1px; }
    .pane { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 14px; }
    .p-gl { display: flex; flex-direction: column; }
    .p-gl .sec { flex: none; }
    .p-gl .ed { flex: 1; min-height: 60px; }
    .p-gl .ed textarea { height: 100%; max-height: none; field-sizing: fixed; }
    .p-gl .err { flex: none; }
    .sec { display: block; margin: 10px 0 4px; color: #d4d4d4; font-size: 12px; font-weight: 600; }
    .sec i { margin-left: 6px; color: #8b8b8b; font-style: normal; font-weight: 400; }
    .cls, .ed textarea, .hl { box-sizing: border-box; width: 100%; margin: 0; padding: 5px 8px; border: 0; border-radius: 6px;
      font: 12px/18px ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; tab-size: 2; }
    .cls { all: unset; display: block; box-sizing: border-box; width: 100%; padding: 5px 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.07); color: #ededed;
      font: 12px/18px ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; cursor: text; }
    .cls:disabled, .ed textarea:disabled { opacity: 0.5; cursor: default; }
    .cls.bad { box-shadow: 0 0 0 1.5px #f87171; }
    .ed { position: relative; border-radius: 6px; background: rgba(255, 255, 255, 0.07); }
    /* The box grows with its text by itself (field-sizing), so typing never has to measure it. */
    .ed textarea { position: relative; display: block; min-height: 40px; max-height: 220px; height: auto; field-sizing: content; overflow: auto; resize: none; background: none; color: #ededed;
      white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
    @supports not (field-sizing: content) { .ed textarea { height: 76px; } }
    .hl { position: absolute; inset: 0; overflow: hidden; color: transparent; white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: none; }
    .hl u { text-decoration: underline wavy #f87171; text-decoration-skip-ink: none; }
    .err { margin: 4px 2px 0; color: #f87171; font-size: 12px; overflow-wrap: anywhere; }
    .crow { display: flex; gap: 10px; align-items: center; height: 20px; padding: 0 8px; border-radius: 4px; font: 12px/18px ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; }
    .crow:hover { background: rgba(255, 255, 255, 0.06); }
    .cp { all: unset; flex: 0 0 116px; color: #9ca3af; font: inherit; cursor: pointer; }
    .cp:hover { color: #fff; }
    /* A value reads as text until it is pointed at or focused: then it is a field. */
    .cval { all: unset; flex: 1; min-width: 0; height: 18px; box-sizing: border-box; padding: 0 4px; margin-left: -4px; border-radius: 4px; color: #ededed; font: inherit;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text; }
    .cval:hover { background: rgba(255, 255, 255, 0.08); }
    .cval:focus { background: rgba(255, 255, 255, 0.1); box-shadow: 0 0 0 1.5px rgba(255, 250, 160, 0.7); text-overflow: clip; }
    .cval.bad { text-decoration: underline wavy #f87171; text-decoration-skip-ink: none; box-shadow: 0 0 0 1.5px #f87171; }
    .crow.mine .cp, .crow.mine .cval { color: #fffaa0; }
  `;

  // The layer has to be the topmost thing on the page and has to take typing, whatever the page
  // shows. Two browser rules decide where it sits:
  //  - the top layer (modal dialogs, popovers) paints over every z-index, so the layer is a
  //    popover itself, and the popover shown last is on top;
  //  - a modal dialog makes everything outside it inert (no focus, no typing), so while one is
  //    open the layer lives inside it.
  function seat() {
    const modals = document.querySelectorAll("dialog:modal");
    const home = modals.length ? modals[modals.length - 1] : document.documentElement;
    const typing = root.activeElement === textarea;
    if (hostEl.parentNode !== home) home.appendChild(hostEl); // moving it also takes it out of the top layer
    try {
      if (hostEl.showPopover && !hostEl.matches(":popover-open")) hostEl.showPopover();
    } catch {
      // Not connected yet, or no popover support: it stays a fixed layer with the top z-index.
    }
    if ((typing || (S.card && S.enabled)) && root.activeElement !== textarea) textarea.focus({ preventScroll: true });
  }

  function raise() {
    if (!hostEl.isConnected || !hostEl.showPopover) return;
    const typing = root.activeElement === textarea;
    try {
      if (hostEl.matches(":popover-open")) hostEl.hidePopover();
      hostEl.showPopover();
    } catch {}
    if (typing) textarea.focus({ preventScroll: true });
  }

  function mount() {
    if (hostEl && hostEl.isConnected) return;
    hostEl = document.createElement("b42-review");
    hostEl.setAttribute("popover", "manual");
    hostEl.setAttribute("style", "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block");
    root = hostEl.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>
      <svg class="ink" xmlns="${SVG}"><defs>${PENCIL}</defs><g class="areas"></g><g class="strokes" filter="url(#b42-pencil)"></g></svg>
      <div class="boxes"></div><div class="pins"></div>
      <div class="card" hidden><div class="meta"><span class="what"></span><span class="hint">${HINT}</span></div>
      <button type="button" class="chip" title="Remove the template" hidden></button>
      <textarea rows="2" placeholder="${PLACEHOLDER}" spellcheck="false"></textarea><div class="menu" hidden></div><div class="refs" hidden></div></div>
      <div class="variants"></div><div class="tip" hidden></div><div class="sent" hidden></div>
      <div class="cv" hidden><div class="band" hidden></div>
        <div class="hit" hidden><div class="gzs"></div><div class="eg" hidden></div><div class="eg" hidden></div><div class="eg" hidden></div><div class="eg" hidden></div>
          <div class="hd" hidden></div><div class="hd" hidden></div><div class="hd" hidden></div><div class="hd" hidden></div></div>
        <div class="ghost" hidden></div><div class="ins" hidden></div><div class="lab dim" hidden></div><div class="lab live" hidden></div>
        <div class="shield" hidden></div></div>
      <div class="insp" hidden><div class="grip" title="Drag to resize"></div>
        <div class="ihead"><span class="ititle">Inspector</span><span class="ipath"></span><button type="button" class="ifold"></button></div>
        <div class="ibody"><div class="tree" tabindex="0" role="tree" aria-label="Page elements"><div class="tspace"><div class="trows"></div></div></div>
          <div class="side">
            <div class="tabs" role="tablist" aria-label="What the styles are for"><button type="button" role="tab" class="tab t-el">Element</button><button type="button" role="tab" class="tab t-gl" title="New rules for the page, sent with this batch">Global<i class="dot" hidden></i></button></div>
            <div class="pane p-el" role="tabpanel" hidden>
              <label class="sec" for="b42-cls">Classes</label>
              <input id="b42-cls" class="cls" type="text" spellcheck="false" autocomplete="off" placeholder="Select an element to edit its classes">
              <label class="sec" for="b42-css">Element styles <i>only this element · & nests</i></label>
              <div class="ed"><pre class="hl" aria-hidden="true"></pre><textarea id="b42-css" class="css" spellcheck="false" placeholder="Type CSS for this element, e.g. padding: 20px"></textarea></div><div class="err" hidden></div>
              <div class="sec">Computed <i>edit a value to add it to Element styles</i></div>
              <div class="comp"></div>
            </div>
            <div class="pane p-gl" role="tabpanel">
              <label class="sec" for="b42-free">Stylesheet <i>new rules, sent with this batch</i></label>
              <div class="ed"><pre class="hl" aria-hidden="true"></pre><textarea id="b42-free" class="free" spellcheck="false" placeholder="New rules, e.g. .name { … }"></textarea></div><div class="err" hidden></div>
            </div>
          </div></div></div>
      <div class="bar" hidden><button type="button" class="m-brush" aria-label="Draw on the page" aria-pressed="false" title="Draw on the page · or hold ${isMac ? "⌥" : "alt"} and drag">${icon("brush")}</button><div class="pop" hidden></div>
        <div class="seg"><button type="button" class="m-notes on" title="Notes: point at something and say what to change">Notes</button><button type="button" class="m-canvas" title="Canvas: edit the page itself (${isMac ? "⌘" : "ctrl+"}E)">Canvas</button></div>
        <button type="button" class="count" hidden><span class="cn"></span>${icon("chevron-up", 12)}</button>
        <button type="button" class="act undo" title="Undo (${isMac ? "⌘" : "ctrl+"}Z)" hidden>Undo</button><button type="button" class="act reset" title="Remove every unsent edit (undoable)" hidden>Reset</button>
        <input class="cnote" type="text" spellcheck="false" autocomplete="off" placeholder="Add a note (optional)" hidden><span class="bmsg" hidden></span>
        <span class="bsend" hidden></span></div>
      <div class="corner" hidden><div class="pop" hidden></div><button type="button" class="help" title="Keys and gestures" aria-label="Keys and gestures">${icon("help")}</button></div>`;
    ink = root.querySelector(".ink");
    strokesEl = ink.querySelector(".strokes");
    pencil = ink.querySelector("#b42-pencil");
    boxes = root.querySelector(".boxes");
    pinsEl = root.querySelector(".pins");
    card = root.querySelector(".card");
    what = root.querySelector(".what");
    textarea = root.querySelector(".card textarea");
    refs = root.querySelector(".refs");
    variantsEl = root.querySelector(".variants");
    variantStyle = document.createElement("style");
    (document.head || document.documentElement).appendChild(variantStyle);
    chip = root.querySelector(".chip");
    menuEl = root.querySelector(".menu");
    tip = root.querySelector(".tip");
    sentEl = root.querySelector(".sent");
    mountCanvas();
    seat();

    // A change to the page may have removed the layer, closed it (an element taken out of the
    // document leaves the top layer) or opened or closed a modal dialog: seat it again then.
    // Any other change leaves it where it is, and the document is not searched for dialogs.
    new MutationObserver((records) => {
      if (!hostEl.isConnected || (hostEl.showPopover && !hostEl.matches(":popover-open")) || records.some((r) => r.type === "attributes")) seat();
      domVersion++;
      kick();
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributeFilter: ["open"] });
    // Something of the page's entered the top layer after us: go back on top of it.
    window.addEventListener(
      "toggle",
      (e) => {
        if (e.target !== hostEl && e.newState === "open" && e.target.matches?.("[popover], dialog")) raise();
      },
      true,
    );
    // A focus trap (the page's modal pulling focus back into itself) must not see focus enter the
    // note card, or it takes the caret away.
    for (const t of ["focusin", "focusout"])
      window.addEventListener(t, (e) => isOurs(e) && e.stopImmediatePropagation(), true);

    cursorStyle = document.createElement("style");
    cursorStyle.textContent = "html[data-b42-review], html[data-b42-review] * { cursor: crosshair !important; }";
    (document.head || document.documentElement).appendChild(cursorStyle);

    // Keys typed into the card must not reach the page's own shortcuts.
    for (const t of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut"]) card.addEventListener(t, (e) => e.stopPropagation());
    textarea.addEventListener("paste", onPaste);
    chip.addEventListener("click", () => {
      setTemplate(null);
      draftChanged();
      textarea.focus({ preventScroll: true });
    });
    textarea.addEventListener("input", () => {
      setHint("");
      updateMenu();
      autosize();
      draftChanged();
    });

    const opts = { capture: true, passive: false };
    window.addEventListener("pointerdown", onPointerDown, opts);
    window.addEventListener("pointermove", onPointerMove, opts);
    window.addEventListener("pointerup", onPointerUp, opts);
    for (const t of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "dragstart", "selectstart", "touchstart"])
      window.addEventListener(t, blockIfActive, opts);
    window.addEventListener("keydown", onKeyDown, opts);
    window.addEventListener("scroll", kick, { capture: true, passive: true });
    window.addEventListener("resize", kick, { passive: true });
    for (const type of ["pointerdown", "pointermove", "pointerup", "keydown", "keyup", "wheel"])
      window.addEventListener(type, active, { capture: true, passive: true });

    send({ type: "ready", url: location.href, viewport: vp() });
  }

  window.__b42 = {
    version: VERSION,
    // (C.typeTimer: CSS or classes typed but not yet an undo step. Until that pause ends the batch
    // still looks empty and the host has no draft of it: a reload then would lose what was typed.)
    busy: () => !!(S.card || S.pending || S.drag || hasDraft() || C.drag || C.edit || C.typeTimer || C.snap !== EMPTY || (C.on && C.sel)),
    receive(msg) {
      if (typeof msg === "string") msg = JSON.parse(msg);
      if (!root) return;
      switch (msg.type) {
        case "state":
          if (Array.isArray(msg.templates)) S.templates = msg.templates.filter((t) => t && typeof t.name === "string");
          setEnabled(!!msg.enabled);
          if (msg.pins) setPins(msg.pins);
          if (msg.draft && !hasDraft() && C.snap === EMPTY) restoreDraft(msg.draft);
          resumeCanvas();
          break;
        case "enabled":
          setEnabled(!!msg.enabled);
          break;
        case "pins":
          setPins(msg.pins);
          break;
        case "captured":
          if (msg.ok === false) refuseCapture(msg.id, msg.why);
          else finishCapture(msg.id);
          break;
        case "edits":
          showEdits(msg);
          break;
      }
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
