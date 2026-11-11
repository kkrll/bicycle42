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
 *   { type: "mode", mode: "notes"|"canvas"|"motion", brush }  the mode or the brush changed (also sent
 *                                                         after every "state"). The host has the
 *                                                         switch for both; the layer has none
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
 *   The draft carries the unsent batch as draft.edits (opaque: { els, sheet, ops }), draft.paths
 *   (where its elements were, to find them after a reload) and draft.note.
 *
 *   A note made in motion mode is about one animation, and carries:
 *     note.motion           { kind: "keyframes"|"transition"|"script", name, selector, label,
 *                             shared?, isNew?, from?, animation?: { to, from? }, keyframes?: { to, from? },
 *                             changes?: [{ prop, from, to }], starts?, current? } (see `Motion` in
 *                             app/src/main/review.ts). Its words may be empty when it changes something.
 *   The draft carries the unsent motion edits as draft.motion (opaque: { kf, use, note? }).
 *
 * host → page   window.__b42.receive(msg)
 *   { type: "state", enabled, draft?, pins?, templates? } templates: [{ name, hint }], offered after "/"
 *   { type: "enabled", enabled }
 *   { type: "mode", mode?: "notes"|"canvas"|"motion", brush? }  the host's switch. brush: true goes to notes
 *                                                         mode first: the brush belongs to it
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
 * The host's brush makes a plain drag draw, as alt+drag does, until the note is sent or cancelled.
 *
 * Canvas mode ("Edit" to the reviewer; mod+E, or the host's switch; review mode on): the page's real elements are edited and
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
 * An edited element without an id of its own carries a `data-b42e` attribute while a batch names
 * it: the edit's rules select by it, so the edit stays on its element when the page moves it.
 * A sent batch stays applied until its pin is done, failed or stopped, or the page reloads.
 *
 * Motion mode (the host's switch; review mode on): what moves on the page, listed in a dock at the
 * bottom (CSS animations, transitions, the Web Animations API, frame-by-frame scripts), and one
 * animation open in a timeline: a lane per property, a bar between two keyframes, a grip on each.
 * click an element or a row · drag a grip in time · press twice on a lane to add a keyframe ·
 * space plays · ←/→ steps · Delete removes the keyframe · mod+Z / mod+shift+Z undo, redo · Enter
 * sends the open animation as one note (with the words typed for it) · Esc: deselect, then back to
 * notes. Keyframes belong to their name and to every element that plays them; duration, delay,
 * easing and the rest belong to the element. Previews are rules in a constructed stylesheet, as in
 * canvas mode; a sent animation stays applied until its pin is done, failed or stopped.
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
    brush: false, // the host's brush is on: a plain drag draws
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
  const PLACEHOLDER = "Note…"; // what else the card does (/, a pasted picture) is behind its "?"
  // The card's keys: behind its "?", shown while the pointer (or focus) is on it. The card itself
  // carries no instructions, only what is being noted and the ↵ that sends it.
  const CARD_KEYS = [
    ["↵", "send"],
    [isMac ? "⌥↵" : "alt+↵", "send, to work in parallel"],
    ["/", "templates"],
    [isMac ? "⌘V" : "ctrl+V", "attach a copied picture"],
    ["↑ ↓", "parent, child (note empty)"],
    [isMac ? "⌘Z" : "ctrl+Z", "undo a stroke"],
    ["esc", "cancel the note"],
  ];
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

  // ── draft ───────────────────────────────────────────────────────────────────────────────────
  const hasDraft = () => S.sel.length > 0 || S.strokes.length > 0 || !!S.area;

  /** Where the stamped elements of a batch last were: after a reload their stamps are gone. */
  function pathsOf(B) {
    const out = {};
    const add = (x) => {
      const p = x && stampOf(x.rs) && C.paths.get(x.rs);
      if (p) out[x.rs] = [p.path, p.tag];
    };
    for (const rs in B.els) add(B.els[rs]);
    for (const op of B.ops) {
      add(op);
      add(op.parent);
      add(op.before);
    }
    return out;
  }

  function serializeDraft() {
    const noteDraft = !S.pending && (hasDraft() || !!textarea.value);
    const edits = C.snap !== EMPTY ? C.draft.B : null;
    const words = cnote ? cnote.value : "";
    const motion = MO.draft();
    if (!noteDraft && !edits && !words && !motion) return null;
    // (Between a send and its "captured", S.sel holds the sent note's outlines: not a draft.)
    return {
      text: textarea.value, targets: (noteDraft ? S.sel : []).map(selectorFor), area: S.area, strokes: S.strokes, template: S.template,
      ...(edits ? { edits, paths: pathsOf(edits) } : {}), ...(words ? { note: words } : {}), ...(motion ? { motion } : {}),
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
    MO.restore(d.motion);
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

  /** Beside the card's title: why the note did not go, until it is changed. Nothing otherwise. */
  function setHint(why) {
    const hint = card.querySelector(".hint");
    const text = why || "";
    if (hint.textContent === text) return;
    hint.textContent = hint.title = text;
    hint.hidden = !why;
    hint.classList.toggle("warn", !!why);
  }

  /** The ↵ in the card's corner: lit when Enter would send. */
  function drawCardSend() {
    if (!card) return;
    const can = !!(textarea.value.trim() || S.template);
    const b = card.querySelector(".csend");
    if (b.disabled === !can) return;
    b.disabled = !can;
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
    textarea.placeholder = t ? `${t.hint}. A note is optional` : PLACEHOLDER;
    drawCardSend();
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
    // The keys open toward the room: down from a card in the top half, up from one in the bottom.
    const low = top > H / 2;
    if (card._low !== low) card.classList.toggle("low", (card._low = low));
    drawCardSend();
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
  // a dark olive on a light page, pale yellow on a dark one. The card and its chips are always dark.
  function pageAccent() {
    for (const el of [document.body, document.documentElement]) {
      const m = el && /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(el).backgroundColor);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5))
        return 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3] < 110 ? "#fffaa0" : "#3b4d22";
    }
    return "#3b4d22";
  }

  function scanVariants() {
    if (V.version === domVersion) return;
    V.version = domVersion;
    const accent = pageAccent();
    if (accent !== V.accent) {
      hostEl.style.setProperty("--pa", (V.accent = accent));
      hostEl.style.setProperty("--pat", accent === "#fffaa0" ? "#171717" : "#ffffff"); // words on the accent
    }
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
    // Both arrows lead, so they stay put while the label's width changes from variant to variant.
    bar.append(button("chevron-left", "Previous variant", (g) => chooseVariant(g, -1)), button("chevron-right", "Next variant", (g) => chooseVariant(g, 1)), name, keep);
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
    sentEl.replaceChildren(keyNodes(`Note dropped · ${isMac ? "⌘" : "ctrl+"}Z brings it back`));
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
      if (!MO.refuse(id, say)) unsendCanvas(id, say);
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
    MO.finish(id);
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
  //    the one other write is the stamp that says which element an edit is on (see stamp());
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
    undo: '<path d="M6 3.5 3 6.5l3 3"/><path d="M3 6.5h6.25a3.25 3.25 0 0 1 0 6.5H7"/>',
    redo: '<path d="m10 3.5 3 3-3 3"/><path d="M13 6.5H6.75a3.25 3.25 0 0 0 0 6.5H9"/>',
    help: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.9 1.9 0 0 1 3.7.6c0 1.2-1.8 1.5-1.8 2.7"/><path d="M8.1 11.7v.1"/>',
    // The Mac's key symbols, drawn: the page's fonts may not have them, and fallbacks draw specks.
    "⌘": '<path d="M6 6V4a2 2 0 1 0-2 2h8a2 2 0 1 0-2-2v8a2 2 0 1 0 2-2H4a2 2 0 1 0 2 2z"/>',
    "⇧": '<path d="M8 2.7 13.3 8h-3v5.3H5.7V8H2.7z"/>',
    "⌥": '<path d="M2 3.3h3.7l4.6 9.4H14M9.7 3.3H14"/>',
    "↵": '<path d="M13.3 3.3v4a2.7 2.7 0 0 1-2.7 2.7H2.7M5.7 7l-3 3 3 3"/>',
  };
  const icon = (name, size = 16) =>
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const KEY_NAMES = { "⌘": "command", "⇧": "shift", "⌥": "option", "↵": "return" };
  /** Words with key symbols in them ("↵ send", "⌘Z"), as nodes: the symbols drawn at the size of
   *  the letters, the rest as text (never markup, so any words are safe here). */
  function keyNodes(text) {
    const out = document.createDocumentFragment();
    for (const part of String(text).split(/([⌘⇧⌥↵])/)) {
      if (!part) continue;
      if (!KEY_NAMES[part]) {
        out.append(part);
        continue;
      }
      const t = document.createElement("template");
      t.innerHTML = icon(part, 12);
      const svg = t.content.firstChild;
      svg.classList.add("kg");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", KEY_NAMES[part]);
      svg.removeAttribute("aria-hidden");
      out.append(svg);
    }
    return out;
  }
  const newBatch = () => ({ els: {}, sheet: "", ops: [] });
  const EMPTY = JSON.stringify(newBatch());
  const C = {
    on: false,
    sel: null, // the selected element
    selRs: "", // its stable selector: its key in the batch, and how it is found again after a re-render
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
    paths: new Map(), // an element's stamp (as a selector) → { path, tag }: where it last was
    pathsDirty: false, pathsAt: 0,
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

  /** Where an element is: a path of tags and places from the nearest id. Unlike selectorFor it
   *  uses no class names, so it still matches after the reviewer edits the class list. It says
   *  where, not which: when the page adds a sibling before the element, its path is another one. */
  function pathSel(el) {
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

  // An element with an edit is stamped (an attribute: like the class and text edits a write to
  // the DOM, taken off again when no batch names it), and the edit's rules and its key in the
  // batch are that stamp. So an edit stays on its element when the page adds, removes or reorders
  // the ones around it. The stamp is lost when the page builds the element anew (or reloads):
  // then the element is the one where the old one last was, as before. An element with an id of
  // its own needs no stamp.
  const STAMP = "data-b42e";
  const stampSel = (id) => `[${STAMP}="${id}"]`;
  const stampOf = (rs) => /^\[data-b42e="([a-z0-9]+)"\]$/.exec(rs)?.[1];
  const stampBase = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`; // (a restored draft has stamps of an earlier load)
  let stampN = 0;

  /** The selector that says which element this is: its stamp if it has one, else its path. */
  const stableSel = (el) => (el.hasAttribute(STAMP) ? stampSel(el.getAttribute(STAMP)) : pathSel(el));

  /** The same for an element that is being edited: it gets its stamp now. */
  function stamp(el) {
    const path = pathSel(el);
    if (!el.hasAttribute(STAMP)) {
      if (el === document.body || el === document.documentElement || (el.id && path === `#${CSS.escape(el.id)}`)) return path;
      el.setAttribute(STAMP, `${stampBase}${(++stampN).toString(36)}`);
    }
    const rs = stampSel(el.getAttribute(STAMP));
    C.paths.set(rs, { path, tag: el.localName });
    C.found.set(rs, el);
    if (el === C.sel) C.selRs = rs;
    return rs;
  }

  function elOf(rs) {
    let el = C.found.get(rs);
    const id = stampOf(rs);
    if (el && el.isConnected) {
      // (Taken off when nothing named it any more; an undo, or a refused note, names it again.)
      if (id && el.getAttribute(STAMP) !== id) el.setAttribute(STAMP, id);
      return el;
    }
    el = q(rs);
    if (!el && id) {
      const p = C.paths.get(rs);
      const at = p && q(p.path);
      if (at && at !== hostEl && at.localName === p.tag && !at.hasAttribute(STAMP)) {
        at.setAttribute(STAMP, id);
        el = at;
      }
    }
    if (el) C.found.set(rs, el);
    else C.found.delete(rs);
    return el;
  }

  /** Where each stamped element is now, for the day the page builds it anew. Read after the page
   *  changed its tree, while the element is still there: one that just went keeps its last place. */
  function readPaths() {
    C.pathsDirty = false;
    C.pathsAt = performance.now();
    let changed = false;
    for (const [rs, el] of C.found) {
      if (!stampOf(rs) || !el.isConnected) continue;
      const path = pathSel(el), p = C.paths.get(rs);
      if (p && p.path === path) continue;
      C.paths.set(rs, { path, tag: el.localName });
      changed = true;
    }
    if (C.sel && C.sel.isConnected) C.selRs = stableSel(C.sel);
    if (changed && C.snap !== EMPTY) draftChanged(); // the draft carries the paths (see serializeDraft)
  }

  /** What every edit says about its element (the wire names), plus `rs` for our own use. */
  function meta(el) {
    const m = { selector: editSel(el), rs: stamp(el), tag: el.tagName.toLowerCase(), label: line(plainLabel(el)) };
    const c = component(el);
    if (c) m.component = line(c.name);
    const cls = el.getAttribute("class");
    const n = el.parentElement ? kids(el.parentElement).filter((k) => k.tagName === el.tagName && k.getAttribute("class") === cls).length : 1;
    if (n > 1) m.repeated = n;
    C.found.set(m.rs, el);
    return m;
  }

  function entry(el) {
    const els = C.draft.B.els;
    return (el.hasAttribute(STAMP) && els[stampSel(el.getAttribute(STAMP))]) || els[stamp(el)] || (els[stamp(el)] = { ...meta(el), css: "" });
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
    const named = new Set();
    for (const b of [...C.sent, C.draft]) {
      const off = C.hide.has(b.id);
      const ok = b.ok || (b.ok = {}); // per element (and "" for the stylesheet): the last complete text
      for (const k in ok) if (k && !(k in b.B.els)) delete ok[k];
      const rules = [];
      for (const rs in b.B.els) {
        const e = b.B.els[rs];
        named.add(rs);
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
        named.add(op.rs);
        if (op.parent) named.add(op.parent.rs);
        if (op.before) named.add(op.before.rs);
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
    // A stamp no batch names any more comes off its element (an undo puts it back, see elOf).
    for (const [rs, el] of C.found) {
      if (named.has(rs)) continue;
      if (stampOf(rs) && el.getAttribute(STAMP) === stampOf(rs)) {
        el.removeAttribute(STAMP);
        if (el === C.sel) C.selRs = stableSel(el);
      }
      if (!el.isConnected) C.found.delete(rs);
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
      const paths = d.paths && typeof d.paths === "object" ? d.paths : {};
      for (const rs in paths) {
        const v = paths[rs];
        if (stampOf(rs) && !C.paths.has(rs) && Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") C.paths.set(rs, { path: v[0], tag: v[1] });
      }
      C.draft.B = { els: B.els, sheet: typeof B.sheet === "string" ? B.sheet : "", ops: B.ops };
      C.snap = JSON.stringify(C.draft.B);
      applyAll();
    }
    syncFields(true);
  }

  // ── sending ─────────────────────────────────────────────────────────────────────────────────
  const tidy = (e, selector = e.selector) => {
    const out = { selector, tag: e.tag, label: e.label };
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
    // Each element is reported under the selector it has now, read while the batch is off: the
    // page may have moved it since the edit was made, and its classes are the page's own here.
    const where = new Map();
    const locate = (x) => {
      const el = x && !where.has(x.rs) && elOf(x.rs);
      if (el) where.set(x.rs, editSel(el));
    };
    for (const e of entries) locate(e);
    for (const op of B.ops) {
      locate(op);
      locate(op.parent);
      locate(op.before);
    }
    const sel = (x) => where.get(x.rs) || x.selector;
    C.hide.delete("measuring");
    applyAll();
    const after = measure();

    const edits = [];
    for (const e of entries) {
      if (e.css.trim())
        edits.push({ kind: "style", ...tidy(e, sel(e)), css: e.css,
          changes: props.get(e.rs).map((prop, i) => ({ prop, from: before.vals.get(e.rs)[i], to: after.vals.get(e.rs)[i] })) });
      if (e.cls) edits.push({ kind: "class", ...tidy(e, sel(e)), from: line(e.cls.from), to: line(e.cls.to) });
    }
    for (const op of B.ops) {
      const out = { kind: op.kind, ...tidy(op, sel(op)) };
      if (op.kind === "text") Object.assign(out, { from: line(op.from), to: line(op.to) });
      if (op.kind === "move")
        Object.assign(out, {
          parent: { selector: sel(op.parent), label: op.parent.label, layout: op.parent.layout },
          fromIndex: op.fromIndex, toIndex: op.toIndex,
          before: op.before ? { selector: sel(op.before), label: op.before.label } : null,
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
        return { ...describe(el), ...(known ? { selector: sel(known) } : {}) };
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
    if (on) MO.setOn(false);
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
      : C.msg || (C.edit ? "Editing text"
      : busyNote && n ? ""
      : C.done || (n ? "" : sentStatus())); // state only: the bar carries no standing instructions (the "?" has the keys)
    tellMode();
    const key = [C.on, n, msg, C.past.length, C.future.length, dock(), inField, C.pop].join("|");
    if (key === bar._key) return;
    bar._key = key;
    const $ = (s) => bar.querySelector(s);
    const s = n === 1 ? "" : "s";
    bar.classList.toggle("canvas", C.on);
    // In notes mode the bar has one thing to say, and only sometimes: edits were left unsent.
    bar.classList.toggle("idle", !C.on && !n);
    bar.style.bottom = `${C.on ? dock() + 10 : 14}px`;
    const count = $(".count");
    count.hidden = !C.on && !n;
    count.disabled = C.on && !n;
    count.firstChild.textContent = C.on ? (n ? `${n} edit${s}` : "No edits") : `${n} unsent edit${s}`;
    count.title = C.on ? (n ? "Show what is in this batch" : "Nothing edited yet") : "Back to edit mode, where these edits can be sent";
    count.classList.toggle("open", C.pop === "list");
    for (const b of [$(".undo"), $(".redo"), $(".reset"), $(".bsend")]) b.hidden = !C.on;
    corner.style.bottom = bar.style.bottom; // the "?" keeps to the bar's row, in the corner
    corner.querySelector(".help").classList.toggle("on", C.pop === "help");
    $(".undo").disabled = !C.past.length;
    $(".redo").disabled = !C.future.length;
    $(".reset").disabled = !n;
    cnote.hidden = !C.on || !!msg;
    const m = $(".bmsg");
    m.hidden = !C.on || !msg;
    m.replaceChildren(keyNodes(msg));
    m.title = msg;
    m.classList.toggle("warn", !!C.msg);
    // The button says which key does the same from where the keyboard is now.
    $(".bsend").title = n ? `Send ${n === 1 ? "this edit" : `these ${n} edits`} as one note (${inField ? (isMac ? "⌘" : "ctrl+") : ""}↵)` : "Nothing to send yet";
    $(".bsend").disabled = !n;
  }

  /** The host has the mode switch and the brush: it is told whenever either changes here (a key,
   *  Esc, a note sent, a reload that comes back in edit mode). */
  function tellMode() {
    const mode = C.on ? "canvas" : MO.on ? "motion" : "notes", key = `${mode}|${S.brush}`;
    if (C.told === undefined || key === C.told) return; // nothing before the host's first "state"
    C.told = key;
    send({ type: "mode", mode, brush: !!S.brush });
  }

  /** From the host's switch. The brush belongs to notes mode: switching it on leaves edit mode. */
  function hostMode(msg) {
    if (msg.brush === true) {
      setCanvas(false);
      MO.setOn(false);
      return setBrush(true);
    }
    if (msg.mode === "motion") MO.setOn(true);
    else if (msg.mode === "canvas" || msg.mode === "notes") {
      MO.setOn(false);
      setCanvas(msg.mode === "canvas");
    }
    drawBar(); // says the mode, whichever it is now
    if (msg.brush === false) setBrush(false);
  }

  // ── the bar's lists: what is in the batch, and the keys ─────────────────────────────────────
  const HELP = () => {
    // A Mac writes a chord without "+" (⌘⇧Z), everyone else with it (ctrl+shift+Z).
    const m = isMac ? "⌘" : "ctrl+", sh = isMac ? "⇧" : "shift+", alt = isMac ? "⌥" : "alt+";
    if (!C.on)
      return [
        ["click", `select · ${isMac ? "⇧ click" : "shift+click"} adds`],
        ["drag", "select everything in an area"],
        [`${isMac ? "⌥ drag" : "alt+drag"}, or the pencil`, "draw · a closed loop selects what it encloses"],
        ["↑ ↓", "parent, child (with the note empty)"],
        ["↵", `send · ${alt}↵ sends in parallel`],
        ["/", "templates"],
        [`${m}Z`, "undo a stroke, or bring back a dropped note"],
        ["esc", "cancel the note, then leave review mode"],
        [`${m}E`, "annotate ⇄ edit"],
      ];
    return [
      ["click", "select · ↑ ↓ parent, child"],
      ["drag", "reorder inside a flex or grid parent"],
      ["drag an edge or corner", `resize · hold ${isMac ? "⌘" : "ctrl"} for no snapping`],
      ["drag the space between items", "change the gap"],
      ["double-click text", "edit it · ↵ keep, esc revert"],
      ["Delete", "hide the selection"],
      [`${m}Z · ${m}${sh}Z`, "undo · redo"],
      ["↵", `send · ${m}↵ from the inspector's fields`],
      ["esc", "leave the field, deselect, back to annotate"],
      [`${m}E`, "annotate ⇄ edit"],
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
        const hk = el("span", "hk"), hv = el("span", "hv");
        hk.append(keyNodes(k));
        hv.append(keyNodes(v));
        row.append(hk, hv);
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
    const prs = stamp(P), B = C.draft.B;
    const prior = [...C.sent.filter((b) => !C.hide.has(b.id)), C.draft].flatMap((b) => b.B.ops.filter((o) => o.kind === "move" && o.parent.rs === prs));
    const from = ordered(kids(P), prior).indexOf(el);
    const side = (x) => ({ selector: editSel(x), rs: stamp(x), label: line(plainLabel(x)) });
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
    // The header has the room: the words are cut where it ends, not at a note's length.
    const name = el ? `${line(plainLabel(el, 80))}${C.marks.get(el)?.includes("hid") ? " · hidden" : ""}` : "Nothing selected";
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
    bar.querySelector(".bsend").addEventListener("click", () => submitCanvas(false));
    bar.querySelector(".undo").addEventListener("click", undo);
    bar.querySelector(".redo").addEventListener("click", redo);
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
    const show = S.enabled && !capturing && !MO.on; // motion mode has its own dock
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
      const again = stampOf(C.selRs) ? elOf(C.selRs) : q(C.selRs);
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

  // ── motion mode ─────────────────────────────────────────────────────────────────────────────
  // The reviewer looks at what moves on the page and changes it: an animation's keyframes, and
  // how one element plays them (duration, delay, easing, repeats, what starts it). One animation
  // is one note. As in canvas mode, previews are rules in a constructed stylesheet the page
  // adopts, never inline styles; playback is the browser's own (the Web Animations API pauses and
  // seeks the page's animations), so what is seen is what ships. Three rules:
  //  - keyframes belong to their name and to every element that plays them; how they are played
  //    belongs to each element. So two maps (`kf` by name, `use` by element and name), both plain
  //    data: undo is a stack of their JSON, and so is the draft the host keeps;
  //  - a sent animation's rules move to a stylesheet of their own, which stays applied until its
  //    pin is done, failed or stopped (or the page reloads), as a sent canvas batch does;
  //  - the dock is drawn from that data; nothing in it is state of its own but what is open.
  // Everything here is in one closure: its names stay out of the canvas code's way.
  const MO = (() => {
    const EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier(0.2, 0.8, 0.2, 1)", "cubic-bezier(0.34, 1.56, 0.64, 1)", "steps(4, end)"];
    const PROPS = ["opacity", "transform", "translate", "scale", "rotate", "background-color", "color", "box-shadow", "filter", "clip-path", "width", "height", "border-radius", "letter-spacing"];
    // What starts it: the agent wires this up in code; here it plays when Play is pressed.
    const HOW = { asnow: "As now", load: "On load", view: "In view", hover: "On hover", click: "On click", appear: "On appear", scroll: "On scroll" };
    // The choices for how it plays, as [label, what it means]; the key is the CSS value.
    const COUNT = { 1: ["Once"], 2: ["2×"], 3: ["3×"], infinite: ["Forever"] };
    const DIRECTION = { normal: ["Forward"], reverse: ["Backward", "From the last keyframe to the first"], alternate: ["Alternate", "Forward, then backward, and so on"],
      "alternate-reverse": ["Alt. reverse", "Backward, then forward, and so on"] };
    const FILL = { none: ["None", "Before it starts and after it ends, the element looks as it does without it"], forwards: ["Hold end", "After it ends, it stays on the last keyframe"],
      backwards: ["Hold start", "During the delay, it waits on the first keyframe"], both: ["Hold both", "Waits on the first keyframe, stays on the last"] };
    const RATES = [1, 0.5, 0.25, 0.1];
    const RATE_TEXT = { 1: "1×", 0.5: "½×", 0.25: "¼×", 0.1: "⅒×" };
    const MAJOR = [50, 100, 200, 250, 500, 1000, 2000, 5000];
    const DOCK_H = 360;
    const MAX_KF = 4000; // the keyframes' text, as the host takes it
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
    const r1 = (n) => Math.round(n * 10) / 10;
    const ms = (n) => `${Math.round(n)}ms`;
    const secs = (n) => `${+(n / 1000).toFixed(2)}s`;
    const MI = {
      play: '<path d="M5 3.2v9.6L12.5 8z" fill="currentColor" stroke="none"/>',
      pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
      loop: '<path d="M3 7.5V7a3 3 0 0 1 3-3h7"/><path d="m11 2 2 2-2 2"/><path d="M13 8.5V9a3 3 0 0 1-3 3H3"/><path d="m5 14-2-2 2-2"/>',
      iso: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5"/>',
      reset: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/>',
      plus: '<path d="M8 3v10M3 8h10"/>',
      more: '<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>',
      trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/>',
      link: '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5"/><path d="M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5"/>',
    };
    const mi = (name, size = 16) => (ICONS[name] ? icon(name, size)
      : `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MI[name]}</svg>`);
    // What kind of motion a row is (24 grid, drawn at 16): a keyframe animation is a ball leaving
    // echoes; a transition goes from one state to another; a script's ball is in braces; frame by
    // frame is three discrete steps; keyframes nothing plays are the ball as an outline.
    const K = "currentColor";
    const TRAIL = `<rect x="6" y="9" width="12" height="1" rx="0.5" fill="${K}"/><rect x="3.5" y="11.5" width="12" height="1" rx="0.5" fill="${K}"/><rect x="6" y="14" width="12" height="1" rx="0.5" fill="${K}"/>
      <path d="M10 17.3A6.2 6.2 0 0 1 7.12 18C3.74 18 1 15.31 1 12s2.74-6 6.12-6c1.04 0 2.02.25 2.88.7" stroke="${K}"/>
      <path d="M15 17.3c-.86.45-1.84.7-2.88.7-1.81 0-3.44-.77-4.56-2M15 6.7A6.2 6.2 0 0 0 12.13 6c-1.81 0-3.44.77-4.56 2" stroke="${K}"/>`;
    const KIND = {
      css: `${TRAIL}<circle cx="18" cy="12" r="5.5" fill="${K}" stroke="${K}"/>`,
      unused: `${TRAIL}<circle cx="18" cy="12" r="5.5" fill="#161617" stroke="${K}"/>`,
      transition: `<circle cx="7.5" cy="12" r="5.5" stroke="${K}"/><circle cx="16.5" cy="12" r="5.5" fill="${K}" stroke="${K}"/>`,
      script: `<path d="M6 5.5c-1.7 0-2.5.8-2.5 2.5v1.5c0 1.3-.7 2.5-2 2.5 1.3 0 2 1.2 2 2.5V16c0 1.7.8 2.5 2.5 2.5M18 5.5c1.7 0 2.5.8 2.5 2.5v1.5c0 1.3.7 2.5 2 2.5-1.3 0-2 1.2-2 2.5V16c0 1.7-.8 2.5-2.5 2.5" stroke="${K}" stroke-linecap="round"/><circle cx="12" cy="12" r="4" fill="${K}"/>`,
      frames: `<circle cx="4.5" cy="12" r="3" stroke="${K}"/><circle cx="12" cy="12" r="3" stroke="${K}"/><circle cx="19.5" cy="12" r="3" fill="${K}" stroke="${K}"/>`,
    };
    const KIND_TITLE = { css: "Keyframes", unused: "Keyframes nothing plays", transition: "Transition", script: "Script (animate())", frames: "Moved by a script, frame by frame" };
    const kindIcon = (kind) => `<svg class="m-kind" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">${KIND[kind] || KIND.css}</svg>`;

    const M = {
      on: false,
      sel: null, selRs: "", hover: null,
      kf: new Map(), // name → { name, frames: [{ at, ease, vals: { prop: value } }], orig, isNew }
      use: new Map(), // "selector|name" → { rs, name, timing, orig, plays: { how, words }, base, index, isNew, from? }
      open: null, // what is open: { kind: "css" | "script" | "transition", rs, name }
      ro: null, // for the two kinds that are only read: { frames, timing?, laneEase?, state?, total?, on?, items? }
      key: null, // the selected keyframe: { at, prop } (prop null: the whole keyframe)
      lanes: [], // the properties, in the order their lanes were first drawn
      isolate: false, rate: 1, loop: false, loopAt: 0, pos: 0,
      past: [], future: [], snap: "",
      held: null, // the page's Animation object for what is open
      scan: { anims: [], unused: [], transitions: [], scripts: [], rules: new Map() },
      suspects: new Set(), // elements whose inline style changes many times a second
      sheet: null, // the unsent edits, as rules
      sent: [], // [{ id, sheet, seen, n, undo: [{ rs, index, entry }] }]: applied until the pin is done
      unsent: null, // what the animation being sent was, until the host takes it
      view: "keys", // the timeline, or the keyframes as text
      rowEls: null, // the elements of the list row under the pointer
      drag: null, last: null, findUntil: 0, obs: null, ui: null,
      msg: "", msgTimer: 0, done: "", doneTimer: 0,
    };
    let dock, listEl, hdEl, tlEl, cssEl, kbEl, ftEl, noteEl, msgEl, popEl, tagEl, popAnchor = null;

    // ── elements of the page ─────────────────────────────────────────────────────────────────
    const mq = (rs) => {
      try {
        return rs ? document.querySelector(rs) : null;
      } catch {
        return null;
      }
    };
    /** A path from the body: no class names, so it also names the elements our own rules are for. */
    function pathOf(el) {
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
    /** "Heading · Ship calmer…", or with short only the words (the kind when there are none). */
    const name = (el, short = false) => {
      if (!el) return "(gone)";
      const s = plainLabel(el, 28);
      const i = s.indexOf(" · ");
      if (i > 0) return short ? s.slice(i + 3) : s;
      // No words: its first class says more than "Block" does.
      const cls = (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\s+/)[0];
      return cls ? (short ? `.${cls}` : `${s} · .${cls}`) : s;
    };
    const splitTop = (s, sep = ",") => {
      const out = [];
      let depth = 0, start = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") depth--;
        else if (s[i] === sep && !depth) {
          out.push(s.slice(start, i).trim());
          start = i + 1;
        }
      }
      out.push(s.slice(start).trim());
      return out.filter(Boolean);
    };

    // ── keyframes as text ────────────────────────────────────────────────────────────────────
    // Not a CSS parser: it finds the keyframe blocks and cuts their declarations, and the browser
    // says whether a value is one. Shorthands stay as they were typed.
    function parseKf(text) {
      const t = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
      const m = /@keyframes\s+([^\s{]+)\s*\{/.exec(t);
      if (!m) return { error: "No @keyframes rule" };
      const at = new Map();
      let i = m.index + m[0].length, closed = false;
      while (i < t.length) {
        const open = t.indexOf("{", i), close = t.indexOf("}", i);
        if (close >= 0 && (open < 0 || close < open)) {
          closed = true;
          break;
        }
        if (open < 0) break;
        const end = t.indexOf("}", open);
        if (end < 0) return { error: "A brace is open" };
        const offsets = t.slice(i, open).split(",").map((s) => s.trim()).map((s) => (s === "from" ? 0 : s === "to" ? 100 : /^\d*\.?\d+%$/.test(s) ? parseFloat(s) : NaN));
        if (!offsets.length || offsets.some((o) => !(o >= 0 && o <= 100))) return { error: `“${t.slice(i, open).trim().slice(0, 24)}” is not a keyframe` };
        for (const o of offsets) {
          const f = at.get(o) || at.set(o, { at: o, ease: "", vals: {} }).get(o);
          for (const d of splitTop(t.slice(open + 1, end), ";")) {
            const c = d.indexOf(":");
            if (c < 1) return { error: `“${d.slice(0, 24)}” is not a declaration` };
            const prop = d.slice(0, c).trim().toLowerCase(), value = d.slice(c + 1).trim();
            if (prop === "animation-timing-function") f.ease = value;
            else if (value) f.vals[prop] = value;
          }
        }
        i = end + 1;
      }
      if (!closed) return { error: "A brace is open" };
      return { name: m[1], frames: [...at.values()].sort((a, b) => a.at - b.at) };
    }
    function serialize(nm, frames) {
      const body = frames.map((f) => {
        const d = Object.entries(f.vals).map(([p, v]) => `${p}: ${v};`);
        if (f.ease) d.push(`animation-timing-function: ${f.ease};`);
        return `  ${r1(f.at)}% { ${d.join(" ")} }`;
      });
      return `@keyframes ${nm} {\n${body.join("\n")}\n}`;
    }
    /** Keyframes as the Web Animations API gives them (a script's, or a stylesheet we may not read). */
    function fromApi(list) {
      const kebab = (s) => (s === "cssFloat" ? "float" : s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      return list.map((k) => {
        const vals = {};
        for (const p in k) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) vals[kebab(p)] = String(k[p]);
        return { at: r1(k.computedOffset * 100), ease: k.easing && k.easing !== "linear" ? k.easing : "", vals };
      });
    }
    function entryCss(e) {
      const out = [e.name, ms(e.duration)];
      if (e.easing !== "ease") out.push(e.easing);
      if (e.delay) out.push(ms(e.delay));
      if (String(e.count) !== "1") out.push(e.count);
      if (e.direction !== "normal") out.push(e.direction);
      if (e.fill !== "none") out.push(e.fill);
      return out.join(" ");
    }
    /** The easing as an SVG polyline's points in a w×h box, sampled from the browser, so steps()
     *  and linear() draw as they are. */
    function curvePoints(easing, w, h, pad) {
      try {
        const fx = new KeyframeEffect(null, null, { duration: 100, easing, fill: "both" });
        const a = new Animation(fx, document.timeline);
        a.pause();
        const pts = [];
        for (let i = 0; i <= 30; i++) {
          a.currentTime = (i / 30) * 99.999;
          pts.push(`${(pad + (i / 30) * (w - 2 * pad)).toFixed(1)},${(h - pad - (fx.getComputedTiming().progress || 0) * (h - 2 * pad)).toFixed(1)}`);
        }
        a.cancel();
        return pts.join(" ");
      } catch {
        return "";
      }
    }
    const curve = (easing) => `<svg class="m-cv" viewBox="0 0 28 28" aria-hidden="true"><polyline points="${curvePoints(easing, 28, 28, 6)}" fill="none" stroke="#fffaa0" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

    // ── how an element plays its animations ──────────────────────────────────────────────────
    function readList(el) {
      const cs = getComputedStyle(el);
      const names = splitTop(cs.animationName);
      if (names.length === 1 && names[0] === "none") return [];
      const col = (p) => splitTop(cs.getPropertyValue(p));
      const dur = col("animation-duration"), del = col("animation-delay"), ease = col("animation-timing-function"), n = col("animation-iteration-count"),
        dir = col("animation-direction"), fill = col("animation-fill-mode");
      const at = (list, i) => list[i % list.length];
      return names.map((nm, i) => ({ name: nm, duration: Math.round(parseFloat(at(dur, i)) * 1000) || 0, delay: Math.round(parseFloat(at(del, i)) * 1000) || 0,
        easing: at(ease, i), count: at(n, i), direction: at(dir, i), fill: at(fill, i) }));
    }
    const kfDirty = (k) => !!k && (k.isNew || serialize(k.name, k.frames) !== k.orig);
    const useDirty = (u) => !!u && (u.isNew || !!u.from || JSON.stringify(u.timing) !== JSON.stringify(u.orig));
    const playsDirty = (u) => !!u && (u.plays.how !== "asnow" || !!u.plays.words.trim());
    const openKf = () => (M.open && M.open.kind === "css" ? M.kf.get(M.open.name) : null);
    const openUse = () => (M.open && M.open.kind === "css" ? M.use.get(`${M.open.rs}|${M.open.name}`) : null);
    const frames = () => (openKf() ? openKf().frames : M.ro ? M.ro.frames : []);
    const readOnly = () => !!M.open && M.open.kind !== "css";
    /** Anything unsent: an edit, or how it starts. */
    const anyDirty = () => [...M.kf.values()].some(kfDirty) || [...M.use.values()].some((u) => useDirty(u) || playsDirty(u));
    /** The open animation has something to send. */
    const openDirty = () => {
      const u = openUse();
      return !!u && (useDirty(u) || playsDirty(u) || kfDirty(openKf()));
    };

    // ── applying ─────────────────────────────────────────────────────────────────────────────
    // Everything changed and not sent, as one stylesheet text. A `@keyframes` of the same name in an
    // adopted sheet wins over the page's own, and the animation that is running (or paused at a
    // frame) takes the new keyframes without starting over: that is what makes editing live.
    function rulesText() {
      const out = [];
      for (const k of M.kf.values()) if (kfDirty(k)) out.push(serialize(k.name, k.frames));
      const by = new Map();
      for (const u of M.use.values()) if (useDirty(u)) (by.get(u.rs) || by.set(u.rs, []).get(u.rs)).push(u);
      for (const [rs, list] of by) {
        // The whole list is written, with only these animations' entries replaced: the element's
        // other animations keep playing.
        const entries = list[0].base.map((e) => ({ ...e }));
        for (const u of list) entries[u.index] = { name: u.name, ...u.timing };
        out.push(`${rs}${BOOST} { animation: ${entries.filter(Boolean).map(entryCss).join(", ")}; }`);
      }
      if (M.on && M.ro && M.ro.on && M.ro.state) out.push(`${M.open.rs}${BOOST} { ${M.ro.state.css} }`);
      if (M.on && M.isolate && M.selRs) out.push(`body *:not(${M.selRs}, ${M.selRs} *) { visibility: hidden !important; }`, `${M.selRs} { visibility: visible !important; }`);
      return out.join("\n");
    }
    function apply() {
      const text = rulesText();
      if (!M.sheet) {
        if (!text) return;
        M.sheet = new CSSStyleSheet();
      }
      // The unsent edits come after every sent one: they are newer.
      adopt(M.sheet, false);
      adopt(M.sheet, !!text);
      if (text === M.sheet._text) return;
      M.sheet._text = text;
      try {
        M.sheet.replaceSync(text);
      } catch {}
    }

    // ── what moves on this page ──────────────────────────────────────────────────────────────
    function scan() {
      const rules = new Map(); // name → the @keyframes rule that wins (the last one)
      const walk = (list) => {
        for (const r of list) {
          if (r instanceof CSSKeyframesRule) rules.set(r.name, r);
          else if (r.cssRules) walk(r.cssRules);
        }
      };
      for (const s of document.styleSheets) {
        try {
          walk(s.cssRules);
        } catch {} // another origin's stylesheet: its animations are still read, through the API
      }
      for (const b of M.sent) walk(b.sheet.cssRules); // what was sent is what the page plays now
      const anims = new Map(), transitions = [];
      const all = document.body ? document.body.getElementsByTagName("*") : [];
      for (let i = 0; i < all.length && i < 4000; i++) {
        const el = all[i];
        if (el === hostEl || SKIP.test(el.tagName)) continue;
        const cs = getComputedStyle(el);
        if (cs.animationName !== "none") for (const nm of splitTop(cs.animationName)) (anims.get(nm) || anims.set(nm, []).get(nm)).push(el);
        if (cs.transitionProperty !== "none" && splitTop(cs.transitionDuration).some((d) => parseFloat(d) > 0)) transitions.push(el);
      }
      const live = document.getAnimations();
      const running = new Set(live.filter((a) => a.playState === "running" && a.animationName).map((a) => a.animationName));
      M.scan = {
        rules,
        anims: [...anims].map(([nm, els]) => ({ name: nm, els, running: running.has(nm) })),
        unused: [...rules.keys()].filter((n) => !anims.has(n)),
        transitions,
        scripts: live.filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.effect && a.effect.target && a.effect.target.getRootNode() !== root),
      };
    }

    // ── opening one ──────────────────────────────────────────────────────────────────────────
    function baseFor(rs, el) {
      for (const u of M.use.values()) if (u.rs === rs) return u.base;
      return readList(el);
    }
    function show(open) {
      // What was stopped at a frame to be looked at goes on from there: nothing stays frozen behind.
      const was = M.open && M.open.kind !== "transition" ? animOf() : null;
      if (was && was.playState === "paused" && !(open && M.open.kind === open.kind && M.open.rs === open.rs && M.open.name === open.name)) {
        was.playbackRate = 1;
        was.play();
      }
      if (M.ro && M.ro.on) M.ro.on = false;
      M.open = open;
      M.key = null;
      M.lanes = [];
      M.held = null;
      M.loopAt = 0;
      if (!open || open.kind === "css") M.ro = null;
      M.snap = snapshot();
      apply();
      draw();
    }
    function openCss(el, nm) {
      const rs = pathOf(el);
      setSel(el);
      if (!M.kf.has(nm)) {
        const rule = M.scan.rules.get(nm);
        const live = el.getAnimations().find((a) => a.animationName === nm);
        const fr = rule ? parseKf(rule.cssText).frames || [] : live ? fromApi(live.effect.getKeyframes()) : [];
        M.kf.set(nm, { name: nm, frames: fr, orig: serialize(nm, fr), isNew: false });
      }
      const k = `${rs}|${nm}`;
      if (!M.use.has(k)) {
        const base = baseFor(rs, el), index = base.findIndex((e) => e.name === nm);
        if (index < 0) return attach(el, nm);
        const { name: _, ...timing } = base[index];
        M.use.set(k, { rs, name: nm, timing, orig: { ...timing }, plays: { how: "asnow", words: "" }, base, index, isNew: false });
      }
      show({ kind: "css", rs, name: nm });
    }
    /** Keyframes the element does not play yet: a new animation, or ones the page declares and nothing plays. */
    function attach(el, nm, timing = { duration: 400, delay: 0, easing: "ease-out", count: "1", direction: "normal", fill: "both" }) {
      const rs = pathOf(el), base = baseFor(rs, el);
      const index = base.length + [...M.use.values()].filter((u) => u.rs === rs && u.isNew).length;
      M.use.set(`${rs}|${nm}`, { rs, name: nm, timing, orig: null, plays: { how: "load", words: "" }, base, index, isNew: true });
      setSel(el);
      show({ kind: "css", rs, name: nm });
      commit();
      seek(0);
      play();
    }
    function newAnimation() {
      if (!M.sel) return;
      let nm = "fade-up";
      for (let i = 2; M.kf.has(nm) || M.scan.rules.has(nm); i++) nm = `fade-up-${i}`;
      M.kf.set(nm, { name: nm, isNew: true, orig: "", frames: [{ at: 0, ease: "", vals: { opacity: "0", translate: "0 12px" } }, { at: 100, ease: "", vals: { opacity: "1", translate: "0 0" } }] });
      attach(M.sel, nm);
    }
    function tryUnused(nm) {
      if (!M.sel) return;
      if (!M.kf.has(nm)) {
        const fr = parseKf(M.scan.rules.get(nm).cssText).frames || [];
        M.kf.set(nm, { name: nm, frames: fr, orig: serialize(nm, fr), isNew: false });
      }
      attach(M.sel, nm, { duration: 600, delay: 0, easing: "ease-in-out", count: "1", direction: "normal", fill: "none" });
    }
    function openScript(a) {
      const el = a.effect.target, t = a.effect.getTiming();
      setSel(el);
      M.ro = { frames: fromApi(a.effect.getKeyframes()), timing: { duration: +t.duration || 0, delay: t.delay, easing: t.easing, count: t.iterations === Infinity ? "infinite" : String(t.iterations), direction: t.direction, fill: t.fill === "auto" ? "none" : t.fill } };
      show({ kind: "script", rs: pathOf(el), name: a.id || "animate()" });
      M.held = a;
    }
    /** A transition has no keyframes: two values per property and the state that switches them,
     *  found in the page's own rules (`.primary:hover`). Playing it applies that rule. */
    function openTransition(el) {
      const rs = pathOf(el), cs = getComputedStyle(el);
      setSel(el);
      const col = (p) => splitTop(cs.getPropertyValue(p));
      const props = col("transition-property"), dur = col("transition-duration"), del = col("transition-delay"), ease = col("transition-timing-function");
      const at = (list, i) => list[i % list.length];
      let state = null;
      const walk = (list) => {
        for (const r of list) {
          if (r.cssRules && r.cssRules.length && !r.selectorText) walk(r.cssRules);
          if (!r.selectorText) continue;
          for (const s of splitTop(r.selectorText)) {
            const m = /:(hover|focus-visible|focus-within|focus|active)\b/.exec(s);
            if (!m) continue;
            try {
              if (el.matches(s.replace(m[0], ""))) state = { pseudo: m[0], css: r.style.cssText, props: [...r.style] };
            } catch {}
          }
        }
      };
      for (const s of document.styleSheets) {
        try {
          walk(s.cssRules);
        } catch {}
      }
      let items = props.map((p, i) => ({ prop: p, duration: parseFloat(at(dur, i)) * 1000, delay: parseFloat(at(del, i)) * 1000, easing: at(ease, i) })).filter((x) => x.duration > 0);
      if (state) items = items.flatMap((x) => (x.prop === "all" ? state.props.map((p) => ({ ...x, prop: p })) : [x]));
      const total = Math.max(1, ...items.map((x) => x.delay + x.duration));
      // Both ends of each property: read now, and with the state's declarations applied at once.
      const read = () => Object.fromEntries(items.map((x) => [x.prop, getComputedStyle(el).getPropertyValue(x.prop)]));
      const from = read();
      let to = from;
      if (state) {
        const probe = new CSSStyleSheet();
        try {
          probe.replaceSync(`${rs}${BOOST}${BOOST} { ${state.css}; transition: none !important; }`);
          adopt(probe, true);
          to = read();
        } catch {}
        adopt(probe, false);
        getComputedStyle(el).opacity; // settled before the transition is allowed again
      }
      const fr = new Map(), laneEase = {};
      const put = (o, p, v) => ((fr.get(o) || fr.set(o, { at: o, ease: "", vals: {} }).get(o)).vals[p] = v);
      for (const x of items) {
        put(r1((x.delay / total) * 100), x.prop, from[x.prop]);
        put(r1(((x.delay + x.duration) / total) * 100), x.prop, to[x.prop]);
        laneEase[x.prop] = x.easing;
      }
      M.ro = { frames: [...fr.values()].sort((a, b) => a.at - b.at), laneEase, state, total, on: false, items };
      show({ kind: "transition", rs, name: "transition" });
    }
    function setSel(el) {
      M.sel = el;
      M.selRs = el ? pathOf(el) : "";
    }
    /** A click on the page: the element, and with it the first thing that moves it. */
    function selectEl(el) {
      if (!el) {
        setSel(null);
        return show(null);
      }
      const names = readList(el);
      const script = M.scan.scripts.find((a) => a.effect.target === el);
      if (names.length) openCss(el, names[0].name);
      else if (script) openScript(script);
      else if (M.scan.transitions.includes(el)) openTransition(el);
      else {
        setSel(el);
        show(null);
      }
    }
    /** Bring the element into view, and send a ring out from it: the way to find something small
     *  (a 12px spinner) after choosing it in the list. */
    function reveal(el) {
      if (!el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight - DOCK_H || r.right < 0 || r.left > window.innerWidth) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      M.findUntil = performance.now() + 1400;
      kick();
    }

    // ── playing ──────────────────────────────────────────────────────────────────────────────
    /** The page's own Animation object for what is open. One that ended without holding its last
     *  frame is no longer listed by the element, but the object still plays: it is kept. */
    function animOf() {
      const o = M.open, el = o && mq(o.rs);
      if (!el || o.kind === "transition") return null;
      if (o.kind === "script") return M.held;
      const a = el.getAnimations().find((x) => x.animationName === o.name);
      if (a) return (M.held = a);
      return M.held && M.held.effect && M.held.effect.target === el ? M.held : null;
    }
    /** Nothing to hold on to (it ended before it was opened): its animations start again, by
     *  switching them off and on in one go. */
    function revive() {
      const o = M.open, el = o && mq(o.rs);
      if (!el || o.kind !== "css") return null;
      const off = new CSSStyleSheet();
      try {
        off.replaceSync(`${o.rs}${BOOST}${BOOST} { animation: none !important; }`);
        adopt(off, true);
        getComputedStyle(el).animationName;
      } catch {}
      adopt(off, false);
      getComputedStyle(el).animationName;
      return animOf();
    }
    const backward = (t) => t.direction === "reverse" || t.direction === "alternate-reverse";
    function play() {
      if (M.open && M.open.kind === "transition") return flip();
      const a = animOf() || revive();
      if (!a) return;
      a.playbackRate = M.rate;
      if (a.playState === "finished") a.currentTime = 0;
      a.play();
      kick();
    }
    function pause() {
      const a = animOf();
      if (a) a.pause();
    }
    const running = () => {
      if (!M.open || M.open.kind === "transition") return false;
      const a = animOf();
      return !!a && a.playState === "running";
    };
    const toggle = () => (M.open && M.open.kind === "transition" ? flip() : running() ? pause() : play());
    /** Show the frame at `p` (0…1 along the keyframes) and stay there. */
    function seek(p) {
      const a = animOf() || revive();
      M.pos = p = clamp(p, 0, 1);
      if (!a) return;
      const t = a.effect.getComputedTiming(), dur = +t.duration || 0;
      a.pause();
      // Just short of the end: at the end itself an animation that does not hold its last frame shows nothing.
      a.currentTime = t.delay + Math.min(backward(t) ? 1 - p : p, 0.99999) * dur;
      kick();
    }
    /** A transition: switch its state on or off, and the page runs it. */
    function flip() {
      if (!M.ro || !M.ro.state) return;
      M.ro.on = !M.ro.on;
      apply();
      const el = mq(M.open.rs);
      if (!el) return;
      getComputedStyle(el).opacity;
      for (const a of el.getAnimations()) if (a instanceof CSSTransition) a.playbackRate = M.rate;
      kick();
    }
    function position() {
      const o = M.open, el = o && mq(o.rs);
      if (!el) return null;
      if (o.kind === "transition") {
        const ts = el.getAnimations().filter((a) => a instanceof CSSTransition);
        if (!ts.length) return M.ro.on ? 1 : 0;
        const t = Math.max(...ts.map((a) => a.currentTime || 0)) / M.ro.total;
        return clamp(M.ro.on ? t : 1 - t, 0, 1);
      }
      const a = animOf();
      if (!a) return null;
      const p = a.effect.getComputedTiming().progress;
      return p === null ? null : p;
    }
    /** What was paused to be looked at plays again, and nothing is switched on for it: leaving
     *  motion mode leaves the page moving as it does (with the unsent edits). */
    function letGo() {
      const a = M.open && M.open.kind !== "transition" ? animOf() : null;
      if (a && a.playState === "paused") {
        a.playbackRate = 1;
        a.play();
      }
      if (M.ro && M.ro.on) M.ro.on = false;
    }

    // ── undo ─────────────────────────────────────────────────────────────────────────────────
    const snapshot = () => JSON.stringify({ kf: [...M.kf], use: [...M.use], open: M.open && M.open.kind === "css" ? M.open : null });
    function commit() {
      const now = snapshot();
      if (now !== M.snap) {
        M.past.push(M.snap);
        if (M.past.length > 200) M.past.shift();
        M.snap = now;
        M.future = [];
      }
      apply();
      scan();
      draw();
      draftChanged();
    }
    function travel(from, to) {
      if (!from.length) return;
      to.push(M.snap);
      M.snap = from.pop();
      const s = JSON.parse(M.snap);
      M.kf = new Map(s.kf);
      M.use = new Map(s.use);
      const keep = M.open && M.open.kind !== "css" ? M.open : s.open;
      M.open = keep && (keep.kind !== "css" || M.use.has(`${keep.rs}|${keep.name}`)) ? keep : null;
      M.key = null;
      apply();
      scan();
      draw();
      draftChanged();
    }
    /** The open animation as the page has it (or as it was last sent): its edits go. */
    function discard() {
      let u = openUse(), k = openKf();
      if (!u) return;
      if (u.from) {
        // its own keyframes go; it plays the shared ones again
        M.kf.delete(k.name);
        M.use.delete(`${u.rs}|${u.name}`);
        u.name = M.open.name = u.from;
        delete u.from;
        M.use.set(`${u.rs}|${u.name}`, u);
        M.held = null;
        k = openKf();
      }
      if (u.isNew) M.use.delete(`${u.rs}|${u.name}`);
      else {
        u.timing = { ...u.orig };
        u.plays = { how: "asnow", words: "" };
      }
      if (k && k.isNew) M.kf.delete(k.name);
      else if (k) k.frames = parseKf(k.orig).frames;
      if (u.isNew) M.open = null;
      M.key = null;
      commit();
    }

    // ── shared keyframes ─────────────────────────────────────────────────────────────────────
    /** How many elements play the open keyframes. A change to them changes every one. */
    function sharedBy() {
      const k = openKf();
      const a = k && M.scan.anims.find((x) => x.name === k.name);
      return a ? a.els.length : 1;
    }
    /** The open element gets keyframes of its own: a copy, under a new name, with the changes made
     *  so far; the shared ones go back to what the page has, for the other elements. */
    function detach() {
      const u = openUse(), k = openKf();
      if (!u || !k || sharedBy() < 2) return;
      let nm = `${k.name}-2`;
      for (let i = 3; M.kf.has(nm) || M.scan.rules.has(nm); i++) nm = `${k.name}-${i}`;
      M.kf.set(nm, { name: nm, frames: JSON.parse(JSON.stringify(k.frames)), orig: "", isNew: true });
      if (!k.isNew) k.frames = parseKf(k.orig).frames;
      M.use.delete(`${u.rs}|${u.name}`);
      u.from = u.name;
      u.name = nm;
      M.use.set(`${u.rs}|${nm}`, u);
      M.open.name = nm;
      M.held = null;
      const p = M.pos;
      commit();
      seek(p);
    }

    // ── editing keyframes ────────────────────────────────────────────────────────────────────
    function moveKey(prop, from, to) {
      const k = openKf();
      if (!k) return false;
      const F = k.frames, a = F.find((f) => f.at === from);
      let b = F.find((f) => f.at === to);
      if (!a || from === to) return false;
      if (prop === null) {
        if (b) return false;
        a.at = to;
      } else {
        if (b && prop in b.vals) return false;
        if (!b) F.push((b = { at: to, ease: "", vals: {} }));
        b.vals[prop] = a.vals[prop];
        delete a.vals[prop];
        if (!Object.keys(a.vals).length) {
          if (a.ease && !b.ease) b.ease = a.ease;
          F.splice(F.indexOf(a), 1);
        }
      }
      F.sort((x, y) => x.at - y.at);
      return true;
    }
    /** A new keyframe where a lane was pressed twice. It takes the value the animation has at that
     *  moment, so adding one changes nothing until it is edited; a transform comes back from the
     *  browser as a matrix, which nobody wants to edit, so there the keyframe before is copied. */
    function addKey(prop, at) {
      const k = openKf(), el = mq(M.open && M.open.rs);
      if (!k || !el) return;
      let f = k.frames.find((x) => x.at === at);
      const props = prop === null ? laneOrder() : [prop];
      seek(at / 100);
      const cs = getComputedStyle(el);
      for (const p of props) {
        if (f && p in f.vals) continue;
        let v = cs.getPropertyValue(p).replace(/-?\d*\.\d{4,}/g, (n) => String(Math.round(n * 1000) / 1000));
        if (/^matrix/.test(v) || !v) {
          const before = k.frames.filter((x) => x.at <= at && p in x.vals).pop() || k.frames.find((x) => p in x.vals);
          v = before ? before.vals[p] : v || "initial";
        }
        if (!f) k.frames.push((f = { at, ease: "", vals: {} }));
        f.vals[p] = v;
      }
      k.frames.sort((x, y) => x.at - y.at);
      M.key = { at, prop };
      commit();
    }
    function removeKey() {
      const k = openKf(), key = M.key;
      if (!k || !key) return;
      const f = k.frames.find((x) => x.at === key.at);
      if (!f) return;
      if (key.prop === null) k.frames.splice(k.frames.indexOf(f), 1);
      else {
        delete f.vals[key.prop];
        if (!Object.keys(f.vals).length) k.frames.splice(k.frames.indexOf(f), 1);
      }
      M.key = null;
      commit();
    }
    function addLane(prop) {
      const k = openKf(), el = mq(M.open && M.open.rs);
      prop = prop.trim().toLowerCase();
      if (!k || !el || !prop || !CSS.supports(prop, "initial") || laneOrder().includes(prop)) return false;
      const now = getComputedStyle(el).getPropertyValue(prop) || "initial";
      const v = /^matrix/.test(now) ? "none" : now;
      for (const at of [0, 100]) {
        let f = k.frames.find((x) => x.at === at);
        if (!f) k.frames.push((f = { at, ease: "", vals: {} }));
        f.vals[prop] = v;
      }
      k.frames.sort((x, y) => x.at - y.at);
      M.key = { at: 100, prop };
      commit();
      seek(1);
      return true;
    }
    function removeLane(prop) {
      const k = openKf();
      if (!k) return;
      for (const f of k.frames) delete f.vals[prop];
      k.frames = k.frames.filter((f) => Object.keys(f.vals).length);
      M.key = null;
      commit();
    }
    /** The lanes keep their place while keyframes are dragged past each other. */
    function laneOrder() {
      const have = new Set(frames().flatMap((f) => Object.keys(f.vals)));
      M.lanes = M.lanes.filter((p) => have.has(p));
      for (const p of have) if (!M.lanes.includes(p)) M.lanes.push(p);
      return M.lanes;
    }
    function keyInfo() {
      const key = M.key, o = M.open;
      if (!key || !o) return null;
      const f = frames().find((x) => x.at === key.at);
      if (!f) return null;
      const ro = o.kind !== "css";
      const t = timing();
      const ease = (M.ro && M.ro.laneEase && key.prop ? M.ro.laneEase[key.prop] : f.ease) || "";
      return { f, at: f.at, prop: key.prop, value: key.prop ? f.vals[key.prop] : null, ease, dflt: t ? t.easing : "", last: f.at >= 100 || o.kind === "transition", ro };
    }
    /** One field of the selected keyframe: "val", "ease" or "at". False when the browser says no. */
    function setKey(what, v, done) {
      const k = openKf(), key = M.key;
      if (!k || !key) return false;
      const fr = k.frames.find((x) => x.at === key.at);
      if (!fr) return false;
      v = String(v).trim();
      let ok = true;
      if (what === "val") {
        ok = v !== "" && v.length <= 400 && CSS.supports(key.prop, v);
        if (ok) fr.vals[key.prop] = v;
      } else if (what === "ease") {
        ok = v === "" || CSS.supports("animation-timing-function", v);
        if (ok) fr.ease = v;
      } else if (what === "at") {
        const to = r1(Number(v));
        ok = v !== "" && to >= 0 && to <= 100;
        if (ok && done && moveKey(key.prop, key.at, to)) key.at = to;
      }
      if (!ok) return false;
      apply();
      if (done) {
        commit();
        seek(M.key ? M.key.at / 100 : M.pos);
      }
      return true;
    }
    function segEase(at, prop) {
      const f = frames().find((x) => x.at === at);
      const own = M.ro && M.ro.laneEase ? M.ro.laneEase[prop] : f ? f.ease : "";
      const t = timing();
      return own || (t ? t.easing : "");
    }

    // ── timing ───────────────────────────────────────────────────────────────────────────────
    function timing() {
      const o = M.open;
      if (!o) return null;
      if (o.kind === "css") return openUse().timing;
      if (o.kind === "script") return M.ro.timing;
      return { duration: M.ro.total, delay: 0, easing: M.ro.items.length ? M.ro.items[0].easing : "ease", count: "1", direction: "normal", fill: "none" };
    }
    /** One field of the timing, or of what starts it ("how"). False when the value is not one. */
    function setTiming(key, v, done) {
      const u = openUse();
      if (!u) return false;
      if (key === "how") {
        if (!HOW[v]) return false;
        u.plays.how = v;
      } else {
        let val = String(v).trim(), ok = true;
        if (key === "duration" || key === "delay") {
          ok = val !== "" && Number.isFinite(Number(val)) && Math.abs(Number(val)) <= 600000 && (key === "delay" || Number(val) >= 0);
          val = Number(val);
        } else if (key === "easing") ok = CSS.supports("animation-timing-function", val);
        else if (key === "count") ok = val === "infinite" || (Number(val) >= 0 && Number.isFinite(Number(val)));
        else if (key === "direction") ok = !!DIRECTION[val];
        else if (key === "fill") ok = !!FILL[val];
        else ok = false;
        if (!ok) return false;
        const paused = (animOf() || {}).playState === "paused";
        u.timing[key] = val;
        apply();
        if (paused) seek(M.pos);
      }
      if (done) commit();
      return true;
    }

    // ── the text ─────────────────────────────────────────────────────────────────────────────
    function cssText() {
      const k = openKf();
      if (k) return serialize(k.name, k.frames);
      if (M.ro && M.open.kind === "script") return serialize(M.open.name, M.ro.frames);
      if (M.ro && M.open.kind === "transition") return `${editSel(M.sel)} {\n  transition: ${M.ro.items.map((x) => `${x.prop} ${ms(x.duration)} ${x.easing}`).join(",\n    ")};\n}`;
      return "";
    }
    function setCss(text) {
      const k = openKf();
      if (!k) return "";
      if (text.length > MAX_KF) return `Too long: ${MAX_KF} characters at most`;
      const p = parseKf(text);
      let why = p.error;
      if (!why && p.name !== k.name && !k.isNew) why = `The name stays “${k.name}”`;
      if (!why) {
        const bad = p.frames.flatMap((f) => Object.entries(f.vals).filter(([pr, v]) => !pr.startsWith("--") && !CSS.supports(pr, v)).map(([pr]) => pr));
        if (bad.length) why = `Not a value for ${bad[0]}`;
      }
      if (why) return why;
      if (p.name !== k.name && k.isNew) rename(k, p.name);
      k.frames = p.frames;
      if (M.key && !k.frames.some((f) => f.at === M.key.at && (M.key.prop === null || M.key.prop in f.vals))) M.key = null;
      apply();
      return "";
    }
    function rename(k, nm) {
      if (!/^-?[a-zA-Z_][\w-]{0,60}$/.test(nm) || M.kf.has(nm) || M.scan.rules.has(nm)) return;
      M.kf.delete(k.name);
      for (const [key, u] of [...M.use])
        if (u.name === k.name) {
          M.use.delete(key);
          u.name = nm;
          M.use.set(`${u.rs}|${nm}`, u);
        }
      if (M.open.name === k.name) M.open.name = nm;
      k.name = nm;
      M.kf.set(nm, k);
      M.held = null;
    }

    // ── the list ─────────────────────────────────────────────────────────────────────────────
    function rows() {
      const S2 = M.scan, o = M.open, out = [];
      const timingOf = (el, nm) => {
        const u = M.use.get(`${pathOf(el)}|${nm}`);
        return u ? u.timing : readList(el).find((x) => x.name === nm) || null;
      };
      const dirtyUse = (el, nm) => {
        const u = M.use.get(`${pathOf(el)}|${nm}`);
        return useDirty(u) || playsDirty(u);
      };
      if (S2.anims.length) out.push({ group: "Animations" });
      for (const a of S2.anims) {
        const k = M.kf.get(a.name), one = a.els.length === 1, mine = o && o.kind === "css" && o.name === a.name;
        const t = one ? timingOf(a.els[0], a.name) : null;
        out.push({ kind: "css", els: a.els, name: a.name, label: one ? name(a.els[0], true) : `${a.els.length} elements`, running: a.running,
          dirty: kfDirty(k) || (one && dirtyUse(a.els[0], a.name)), on: mine && one, duration: t ? t.duration : null, open: () => openCss(a.els[0], a.name) });
        if (!one)
          a.els.forEach((el, j) => {
            const t2 = timingOf(el, a.name);
            out.push({ kind: "css", els: [el], sub: true, last: j === a.els.length - 1, name: a.name, label: name(el, true), dirty: dirtyUse(el, a.name),
              on: mine && o.rs === pathOf(el), duration: t2 ? t2.duration : null, open: () => openCss(el, a.name) });
          });
      }
      if (S2.transitions.length) out.push({ group: "Transitions" });
      for (const el of S2.transitions) {
        const cs = getComputedStyle(el);
        out.push({ kind: "transition", els: [el], name: name(el, true), label: cs.transitionProperty, on: o && o.kind === "transition" && o.rs === pathOf(el),
          duration: Math.max(...splitTop(cs.transitionDuration).map((d) => parseFloat(d) * 1000)), open: () => openTransition(el) });
      }
      if (S2.scripts.length || M.suspects.size) out.push({ group: "Scripts" });
      for (const a of S2.scripts)
        out.push({ kind: "script", els: [a.effect.target], name: a.id || "animate()", label: name(a.effect.target, true), running: a.playState === "running",
          on: o && o.kind === "script" && M.held === a, duration: +a.effect.getTiming().duration || 0, open: () => openScript(a) });
      for (const el of M.suspects)
        if (el.isConnected) out.push({ kind: "frames", els: [el], name: name(el, true), label: "per frame", running: true, off: true, duration: null, open: () => {} });
      if (S2.unused.length) out.push({ group: "Unused" });
      for (const n of S2.unused) out.push({ kind: "unused", els: [], name: n, label: "", off: !M.sel, duration: null, open: () => tryUnused(n) });
      return out;
    }

    // ── sending ──────────────────────────────────────────────────────────────────────────────
    /** The open animation, as the note says it (see `Motion` in app/src/main/review.ts). */
    function payload() {
      const o = M.open, el = mq(o.rs);
      const who = { selector: editSel(el), label: plainLabel(el) };
      if (o.kind !== "css") {
        const t = timing();
        const current = o.kind === "transition"
          ? `transition: ${M.ro.items.map((x) => `${x.prop} ${ms(x.duration)} ${x.easing}${x.delay ? ` ${ms(x.delay)}` : ""}`).join(", ")}${M.ro.state ? ` (on ${M.ro.state.pseudo})` : ""}`
          : `animate(): ${ms(t.duration)} ${t.easing}${t.delay ? ` ${ms(t.delay)}` : ""}${t.count !== "1" ? `, ${t.count === "infinite" ? "forever" : `${t.count} times`}` : ""}${t.direction !== "normal" ? `, ${t.direction}` : ""}`;
        return { kind: o.kind, name: o.kind === "transition" ? "transition" : o.name.slice(0, 64), ...who, current: current.slice(0, 400) };
      }
      const u = openUse(), k = openKf();
      const out = { kind: "keyframes", name: k.name, ...who, shared: sharedBy() };
      if (u.isNew) out.isNew = true;
      if (u.from) out.from = u.from;
      if (useDirty(u)) out.animation = { to: entryCss({ name: u.name, ...u.timing }), ...(u.isNew ? {} : { from: entryCss({ name: u.from || u.name, ...u.orig }) }) };
      if (kfDirty(k)) out.keyframes = { to: serialize(k.name, k.frames), ...(k.isNew ? {} : { from: k.orig }) };
      if (!u.isNew)
        out.changes = ["duration", "delay", "easing", "count", "direction", "fill"].filter((p) => String(u.timing[p]) !== String(u.orig[p]))
          .map((p) => ({ prop: p, from: p === "duration" || p === "delay" ? ms(u.orig[p]) : String(u.orig[p]), to: p === "duration" || p === "delay" ? ms(u.timing[p]) : String(u.timing[p]) }));
      if (u.plays.how !== "asnow") out.starts = u.plays.how;
      return out;
    }
    function submit(background) {
      if (S.pending) return;
      const o = M.open, el = o && mq(o.rs), words = noteEl.value.trim();
      if (!o || !el) return flash("Open an animation first: click something that moves, or a row of the list");
      if (!openDirty() && !words) return flash("Nothing to send yet: change it, or say what it should do");
      const k = openKf();
      if (k && serialize(k.name, k.frames).length > MAX_KF) return flash("Too long to send: the keyframes are over 4000 characters");
      letGo(); // the screenshot shows the element as it plays, not stopped at a frame
      const motion = payload();
      const target = describe(el);
      const note = {
        id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text: words,
        url: location.href,
        title: document.title,
        viewport: vp(),
        targets: [target],
        area: null,
        strokes: [],
        bounds: target.rect,
        time: Date.now(),
        ...(background ? { lane: "bg" } : {}),
        motion,
      };
      // What it was, until the host takes it; then its rules move to a sheet of their own, and it
      // is no longer unsent.
      M.unsent = { id: note.id, snap: M.snap, past: M.past, future: M.future, words: noteEl.value, open: o, sel: M.sel };
      if (o.kind === "css") moveToSent(note.id);
      noteEl.value = "";
      noteEl.blur(); // the line under the timeline says it was sent
      S.quiet = note.id; // no "Sent" chip over the page: the dock's line says it
      S.sel = [el]; // its outline, in the screenshot
      draw();
      dispatch(note);
    }
    /** The open animation's rules go into a sheet of their own, under the note's id; the draft
     *  keeps everything else. */
    function moveToSent(id) {
      const u = openUse(), k = openKf();
      const out = [];
      if (kfDirty(k)) out.push(serialize(k.name, k.frames));
      const entry = { name: u.name, ...u.timing };
      const undo = [];
      if (useDirty(u)) {
        const entries = u.base.map((e) => ({ ...e }));
        entries[u.index] = entry;
        out.push(`${u.rs}${BOOST} { animation: ${entries.filter(Boolean).map(entryCss).join(", ")}; }`);
        // The element's other unsent animations are written over this one's entry: they must
        // write it as sent, and put it back if the note comes to nothing.
        for (const x of M.use.values())
          if (x !== u && x.rs === u.rs) {
            undo.push({ x, index: u.index, entry: x.base[u.index] });
            x.base = x.base.slice();
            x.base[u.index] = entry;
          }
      }
      const sheet = new CSSStyleSheet();
      try {
        sheet.replaceSync(out.join("\n"));
      } catch {}
      adopt(sheet, true);
      M.sent.push({ id, sheet, seen: false, undo });
      M.use.delete(`${u.rs}|${u.name}`);
      if (![...M.use.values()].some((x) => x.name === k.name)) M.kf.delete(k.name);
      M.past = [];
      M.future = [];
      M.held = null;
      apply(); // after the sent sheet: the unsent edits stay on top
      scan();
      // Open again, as the page plays it now.
      const el = mq(u.rs);
      M.snap = snapshot();
      if (el && readList(el).some((e) => e.name === u.name)) openCss(el, u.name);
      else show(null);
      draftChanged();
    }
    /** The host did not take the note: the animation is unsent again, with its undo steps and words. */
    function refuse(id, say) {
      const u = M.unsent;
      M.unsent = null;
      if (!u || u.id !== id) return false;
      const i = M.sent.findIndex((b) => b.id === id);
      if (i >= 0) dropSent(M.sent.splice(i, 1)[0]);
      const s = JSON.parse(u.snap);
      M.kf = new Map(s.kf);
      M.use = new Map(s.use);
      M.snap = u.snap;
      M.past = u.past;
      M.future = u.future;
      noteEl.value = [u.words, noteEl.value].filter((w) => w.trim()).join(" ");
      S.sel = [];
      apply();
      scan();
      M.open = u.open;
      M.held = null;
      setSel(u.sel && u.sel.isConnected ? u.sel : mq(u.open.rs));
      draw();
      draftChanged();
      flash(say);
      return true;
    }
    function dropSent(b) {
      adopt(b.sheet, false);
      for (const { x, index, entry } of b.undo) if (x.base[index] && x.base[index].name === (b.undo[0] && x.base[index].name)) x.base[index] = entry;
    }
    function finish(id) {
      if (M.unsent && M.unsent.id === id) M.unsent = null;
      if (S.quiet === id) S.sel = [];
    }
    /** A sent animation is a preview until the agent is finished with its note. */
    function dropFinished() {
      let changed = false;
      M.sent = M.sent.filter((b) => {
        const p = S.pins.find((x) => x.id === b.id);
        if (p) b.seen = b.n = p.n || true;
        const over = p ? p.status === "done" || p.status === "failed" || p.status === "stopped" : b.seen;
        if (!over) return true;
        changed = true;
        dropSent(b);
        const nm = typeof b.n === "number" ? `Note ${b.n}` : "Note";
        M.done = !p ? `${nm} removed · preview removed` : p.status === "done" ? `${nm} done · preview removed` : `${nm} ${p.status} · preview removed`;
        clearTimeout(M.doneTimer);
        M.doneTimer = setTimeout(() => {
          M.done = "";
          drawFoot();
        }, 4000);
        return false;
      });
      drawFoot(); // a note's number is known now: the line says it
      if (!changed) return;
      apply();
      scan();
      if (M.on) {
        // what is open is read again, as the page plays it now
        const o = M.open, el = o && mq(o.rs);
        if (o && o.kind === "css" && el && !M.use.has(`${o.rs}|${o.name}`) && readList(el).some((e) => e.name === o.name)) {
          M.kf.delete(o.name);
          openCss(el, o.name);
        } else draw();
      }
    }

    // ── the draft the host keeps ─────────────────────────────────────────────────────────────
    /** What is unsent, for the host to keep across a reload: the edited keyframes and uses only. */
    function draft() {
      const kf = [...M.kf].filter(([, k]) => kfDirty(k));
      const use = [...M.use].filter(([, u]) => useDirty(u) || playsDirty(u));
      const words = noteEl ? noteEl.value : "";
      if (!kf.length && !use.length && !words) return null;
      return { kf, use, ...(words ? { note: words } : {}) };
    }
    function restore(d) {
      if (!d || typeof d !== "object" || anyDirty()) return;
      try {
        const kf = (Array.isArray(d.kf) ? d.kf : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && Array.isArray(e[1].frames));
        const use = (Array.isArray(d.use) ? d.use : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[1] && e[1].timing && Array.isArray(e[1].base));
        M.kf = new Map(kf);
        M.use = new Map(use);
        if (noteEl && typeof d.note === "string" && !noteEl.value) noteEl.value = d.note;
        M.snap = snapshot();
        apply();
      } catch {
        M.kf = new Map();
        M.use = new Map();
      }
    }

    // ── mode ─────────────────────────────────────────────────────────────────────────────────
    function setOn(on) {
      if (on === M.on || !dock) return;
      closePop();
      if (on) {
        if (C.on) setCanvas(false);
        setBrush(false);
        M.on = true;
        // A note in progress becomes the start: its element is looked at.
        const el = S.sel.length === 1 ? S.sel[0] : null;
        if (S.card || hasDraft()) clearDraft();
        hideSent();
        S.hover = null;
        watchSuspects(true);
        scan();
        M.snap = snapshot();
        if (el && el.isConnected) selectEl(el);
        else if (M.open && !mq(M.open.rs)) show(null);
        else draw();
      } else {
        letGo();
        M.isolate = false;
        M.drag = null;
        M.hover = null;
        M.rowEls = null;
        watchSuspects(false);
        M.on = false;
        apply();
      }
      try {
        sessionStorage.setItem("b42-motion", on ? "1" : "");
      } catch {}
      syncUi();
      drawBar(); // the host hears the mode
      kick();
    }
    /** After a reload (the agent's own edits cause many) the reviewer is still in motion mode. */
    function resume() {
      let was = false;
      try {
        was = sessionStorage.getItem("b42-motion") === "1";
      } catch {}
      if (was && !M.on && !C.on && !S.card && !hasDraft()) setOn(true);
    }
    /** Room for the dock: the page can scroll its last part out from under it. */
    function syncUi() {
      if (!(M.on && S.enabled)) {
        if (M.ui) adopt(M.ui, false);
        return;
      }
      if (!M.ui) {
        M.ui = new CSSStyleSheet();
        M.ui.replaceSync(`html[data-b42-review] { padding-bottom: ${DOCK_H}px !important; }`);
      }
      adopt(M.ui, true);
    }
    /** What no stylesheet and no animation object accounts for: an inline style rewritten many
     *  times a second. It cannot be edited here, but the list can say it is there. */
    function watchSuspects(on) {
      if (M.obs) M.obs.disconnect();
      M.obs = null;
      if (!on || !document.body) return;
      const seen = new Map();
      M.obs = new MutationObserver((list) => {
        const now = performance.now();
        for (const m of list) {
          const c = seen.get(m.target) || seen.set(m.target, { n: 0, t: now }).get(m.target);
          if (now - c.t > 1000) (c.n = 0), (c.t = now);
          if (++c.n === 20 && !M.suspects.has(m.target)) {
            M.suspects.add(m.target);
            drawList();
          }
        }
      });
      M.obs.observe(document.body, { attributes: true, attributeFilter: ["style"], subtree: true });
    }
    function flash(text) {
      M.msg = text;
      drawFoot();
      clearTimeout(M.msgTimer);
      M.msgTimer = setTimeout(() => {
        M.msg = "";
        drawFoot();
      }, 2600);
    }

    // ── drawing ──────────────────────────────────────────────────────────────────────────────
    const typingIn = (el) => {
      const a = root.activeElement;
      return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && el.contains(a);
    };
    function draw() {
      if (!dock || !M.on) return;
      drawList();
      drawHead();
      const css = M.view === "css" && !!M.open;
      tlEl.hidden = css;
      cssEl.hidden = !css;
      if (css) drawCss();
      else if (!typingIn(tlEl)) drawLanes();
      if (!typingIn(kbEl)) kbEl.innerHTML = css ? "" : keyEditor();
      kbEl.hidden = !kbEl.innerHTML.trim();
      drawFoot();
      kick();
    }
    function drawList() {
      if (!dock || !M.on) return;
      const list = rows();
      listEl._rows = list;
      listEl.innerHTML = list.map((r, i) => r.group ? `<div class="m-grp">${esc(r.group)}</div>`
        : `<div class="m-it k-${r.kind}${r.on ? " on" : ""}${r.sub ? " sub" : ""}${r.last ? " last" : ""}${r.off ? " off" : ""}${r.running ? " run" : ""}" data-row="${i}"
          title="${r.sub ? "" : `${KIND_TITLE[r.kind]}${r.running ? ", playing" : ""}`}">${r.sub ? "" : kindIcon(r.kind)}<span class="m-nm">${esc(r.sub ? r.label : r.name)}</span>
          <span class="m-ex">${r.sub ? "" : esc(r.label)}</span>${r.dirty ? '<i class="m-ed"></i>' : ""}
          ${r.duration !== null && r.duration !== undefined ? `<span class="m-du">${Math.round(r.duration)}</span>` : ""}</div>`).join("") ||
        `<div class="m-none">Nothing moves on this page</div>`;
    }
    function timingFields() {
      const t = timing(), ro = readOnly() ? "disabled" : "";
      return `<label class="m-tf"><span>Duration</span><input class="m-fld num" data-t="duration" value="${Math.round(t.duration)}" inputmode="numeric" ${ro}><span class="m-unit">ms</span></label>
        <label class="m-tf"><span>Delay</span><input class="m-fld num" data-t="delay" value="${Math.round(t.delay)}" inputmode="numeric" ${ro}><span class="m-unit">ms</span></label>
        <label class="m-tf"><span>Easing</span><input class="m-fld ease" data-t="easing" list="b42-m-easings" value="${esc(t.easing)}" spellcheck="false" ${ro}>${curve(t.easing)}</label>`;
    }
    function drawHead() {
      if (typingIn(hdEl)) return;
      const o = M.open;
      hdEl.hidden = !o;
      if (!o) return void (hdEl.innerHTML = "");
      const b = (v, t) => `<button type="button" data-m="view" data-v="${v}" class="${M.view === v ? "on" : ""}">${t}</button>`;
      hdEl.innerHTML = `<div class="m-seg" role="tablist">${b("keys", "Keyframes")}${b("css", "CSS")}</div><div class="m-timing">${timingFields()}</div>
        <button type="button" class="m-btn ic" data-m="more" title="More">${mi("more")}</button><span class="m-sp"></span>
        <div class="m-tools"><button type="button" class="m-btn" data-m="rate" title="Speed while looking">${RATE_TEXT[M.rate]}</button>
          <button type="button" class="m-btn ic${M.loop ? " on" : ""}" data-m="loop" title="Repeat while looking">${mi("loop")}</button>
          <button type="button" class="m-btn ic${M.isolate ? " on" : ""}" data-m="iso" ${M.sel ? "" : "disabled"} title="Show only this element">${mi("iso")}</button></div>
        <div class="m-tools"><button type="button" class="m-btn ic" data-m="undo" ${M.past.length ? "" : "disabled"} title="Undo (${isMac ? "⌘" : "ctrl+"}Z)">${mi("undo")}</button>
          <button type="button" class="m-btn ic" data-m="discard" ${openDirty() ? "" : "disabled"} title="Put back as the page has it">${mi("reset")}</button></div>`;
    }
    function laneBars(p) {
      const fr = frames().filter((f) => p in f.vals), key = M.key, out = [];
      if (!fr.length) return "";
      const on = (f) => key && key.at === f.at && (key.prop === p || key.prop === null);
      if (fr.length === 1) out.push(`<i class="m-sb solo${on(fr[0]) ? " on" : ""}" style="--fa: ${fr[0].at / 100}; --fb: ${fr[0].at / 100}; --l: -10px; --r: 10px"></i>`);
      // The outer ends of a lane's bars reach past its first and last keyframes, so those grips sit
      // inside them; where two bars meet, a gap holds the grip they share.
      fr.forEach((f, i) => {
        const next = fr[i + 1];
        if (!next) return;
        const ease = segEase(f.at, p), flat = f.vals[p] === next.vals[p];
        out.push(`<i class="m-sb${on(f) ? " on" : ""}${flat ? " flat" : ""}" data-seg="${f.at}" data-prop="${esc(p)}" title="${esc(ease)}"
          style="--fa: ${f.at / 100}; --fb: ${next.at / 100}; --l: ${i === 0 ? -10 : 3}px; --r: ${i === fr.length - 2 ? 10 : -3}px"></i>`);
      });
      for (const f of fr) out.push(`<i class="m-key m-gr${on(f) ? " on" : ""}" style="--at: ${f.at / 100}" data-at="${f.at}" data-prop="${esc(p)}" title="${esc(f.vals[p])}"></i>`);
      return out.join("");
    }
    function drawLanes() {
      const o = M.open;
      tlEl.classList.toggle("ro", readOnly());
      if (!o) {
        tlEl.innerHTML = `<div class="m-empty">${M.sel ? `<div>Nothing moves this</div><button type="button" class="m-btn m-new" data-m="new">${mi("plus")}New animation</button>` : "<div>Click something on the page, or a row of the list</div>"}</div>`;
        return;
      }
      const ro = readOnly(), key = M.key, fr = frames(), T = Math.max(1, +timing().duration || 0);
      M.T = T;
      const major = MAJOR.find((m) => T / m <= 7) || 5000, minor = major / 5;
      const ticks = [];
      for (let n = 0; n <= T + 0.5; n += minor) {
        const big = Math.round(n / minor) % 5 === 0;
        ticks.push(`<i class="m-tick${big ? " big" : ""}" style="--at: ${n / T}">${big ? `<b>${secs(n)}</b>` : ""}</i>`);
      }
      // the whole keyframes, under the ruler: one grabs every property at that moment
      const whole = fr.map((f) => `<i class="m-key wk${key && key.at === f.at && key.prop === null ? " on" : ""}" style="--at: ${f.at / 100}" data-at="${f.at}" data-prop=""></i>`).join("");
      const tr = o.kind === "transition";
      const html = [`<div class="m-lrow m-ruler"><div class="m-lab"><button type="button" class="m-btn ic play" data-m="play" title="${tr ? "Switch the state" : "Play (space)"}">${mi(running() ? "pause" : "play")}</button><span class="m-time"></span></div>
        <div class="m-trk" data-ruler>${ticks.join("")}${whole}</div></div>`];
      // the band: the keyframes' name, and who else plays them
      const n = sharedBy(), u = openUse(), nm = tr ? "transition" : o.name;
      const note = n > 1 ? `<span class="m-shared" title="These keyframes are played by ${n} elements: a change to them changes all of them. Duration, delay and easing are this element's own.">${mi("link", 14)}${n} elements</span>
          <button type="button" class="m-btn m-own" data-m="detach" title="Copy the keyframes for this element only; the others keep them as they are">Only this one</button>`
        : u && u.from ? `<span class="m-shared">Own copy of <b>${esc(u.from)}</b></span>` : "";
      const lanes = laneOrder();
      const rowsHtml = lanes.map((p) => `<div class="m-lrow m-lane${key && key.prop === p ? " kon" : ""}"><div class="m-lab"><span title="${esc(p)}">${esc(p)}</span>${ro ? "" : `<button type="button" class="m-btn ic m-x" data-m="rmlane" data-prop="${esc(p)}" title="Remove">${icon("x", 14)}</button>`}</div>
          <div class="m-trk"><div class="m-trk m-kspan" data-prop="${esc(p)}">${laneBars(p)}</div></div></div>`);
      html.push(`<div class="m-lanes"><div class="m-bands"><i class="m-band"></i></div>
        <div class="m-lrow m-ghead"><div class="m-lab">${kindIcon(tr ? "transition" : o.kind === "script" ? "script" : "css")}<b>${esc(nm)}</b></div><div class="m-trk">${note}</div></div>
        ${rowsHtml.join("")}</div>`);
      if (!ro) html.push(`<div class="m-addp"><input class="m-fld" data-addp list="b42-m-props" placeholder="+ Property" spellcheck="false" autocomplete="off"></div>`);
      html.push(`<div class="m-phl"><div class="m-flag" hidden><b></b></div></div>`);
      tlEl.innerHTML = html.join("");
      tlEl._play = null;
    }
    function keyEditor() {
      const k = keyInfo();
      if (!k) return "";
      const ro = k.ro ? "disabled" : "";
      return `<div class="m-keyed"><input class="m-fld num" data-k="at" value="${r1(k.at)}" ${ro}><span class="m-unit">%</span>
        ${k.prop === null ? `<span class="m-p">${Object.keys(k.f.vals).length} properties</span><span class="m-sp"></span>`
          : `<span class="m-p">${esc(k.prop)}</span><input class="m-fld val" data-k="val" value="${esc(k.value)}" spellcheck="false" autocomplete="off" ${ro}>`}
        ${k.last ? "" : `<input class="m-fld ease" data-k="ease" list="b42-m-easings" value="${esc(k.ease)}" placeholder="${esc(k.dflt)}" spellcheck="false" ${ro}><button type="button" class="m-btn ic m-cvb" data-m="kease" ${ro} title="Easing">${curve(k.ease || k.dflt)}</button>`}
        ${ro ? "" : `<button type="button" class="m-btn ic" data-m="rmkey" title="Delete (⌫)">${mi("trash")}</button>`}</div>`;
    }
    function drawCss() {
      const area = cssEl.querySelector("textarea");
      if (area && root.activeElement === area) return;
      cssEl.innerHTML = `<textarea data-css spellcheck="false" autocomplete="off" ${openKf() ? "" : "readonly"}>${esc(cssText())}</textarea><div class="m-err" hidden></div>`;
    }
    /** The note that goes with the open animation, and Send; or what the line has to say. */
    function sentStatus() {
      const b = M.sent[M.sent.length - 1];
      return b ? `Sent · preview stays until ${typeof b.n === "number" ? `note ${b.n}` : "the note"} is done` : "";
    }
    function drawFoot() {
      if (!ftEl) return;
      const o = M.open, can = !!o && (openDirty() || !!noteEl.value.trim());
      const busy = root.activeElement === noteEl || !!noteEl.value;
      const msg = M.msg || (busy ? "" : M.done || (o && openDirty() ? "" : sentStatus()));
      noteEl.hidden = !!msg;
      noteEl.placeholder = o ? (o.kind === "css" ? "Note… (optional)" : "Say what it should do…") : "Note…";
      msgEl.hidden = !msg;
      msgEl.textContent = msg;
      msgEl.classList.toggle("warn", !!M.msg);
      const go = ftEl.querySelector(".m-go");
      go.disabled = !can;
      go.title = can ? "Send this animation to the agent (↵)" : o ? "Change it, or say what it should do, first" : "Open an animation first";
    }

    // ── one frame ────────────────────────────────────────────────────────────────────────────
    /** Every frame: the playhead, the time, the play button, the outlines on the page. */
    function frame(capturing) {
      if (!dock) return null;
      const on = M.on && S.enabled && !capturing;
      if (dock._shown !== on) {
        dock.hidden = !(dock._shown = on);
        if (!on) closePop();
      }
      // (Nothing is written that is already so: an idle layer changes nothing, frame after frame.)
      const hide = (el, h) => el.hidden !== h && (el.hidden = h);
      if (!on) {
        hide(tagEl, true);
        return null;
      }
      // repeat, while Loop is on
      const a = M.open && M.open.kind !== "transition" ? animOf() : null;
      if (a && M.loop && a.playState === "finished") {
        const now = performance.now();
        if (!M.loopAt) M.loopAt = now + 400;
        else if (now > M.loopAt) {
          M.loopAt = 0;
          a.currentTime = 0;
          a.play();
        }
      }
      const run = running(), p = position();
      const flag = tlEl.querySelector(".m-flag");
      if (flag && M.T) {
        hide(flag, p === null);
        if (p !== null) {
          flag.style.setProperty("--x", p.toFixed(4));
          const text = secs(Math.round(p * M.T));
          if (flag.firstChild.textContent !== text) flag.firstChild.textContent = text;
        }
      }
      const time = tlEl.querySelector(".m-time");
      if (time) {
        const text = p === null ? "" : String(Math.round(p * M.T));
        if (time.textContent !== text) time.textContent = text;
      }
      const state = `${run}|${M.ro && M.ro.on}`;
      const pb = tlEl.querySelector(".play");
      if (pb && pb._s !== state) {
        pb._s = state;
        pb.innerHTML = mi(run ? "pause" : "play");
        pb.classList.toggle("on", !!(M.ro && M.ro.on));
      }
      // outlines: the element under the pointer, the list row's elements, the open one
      const out = [];
      if (M.hover && M.hover !== M.sel && M.hover.isConnected) out.push([rectOf(M.hover), "hover"]);
      for (const el of M.rowEls || []) if (el !== M.sel && el.isConnected) out.push([rectOf(el), "mrow"]);
      const sel = M.sel;
      if (sel && sel.isConnected) {
        const r = rectOf(sel);
        // While it plays, only its corners: the motion is not covered.
        out.push([{ x: Math.round(r.x - 3), y: Math.round(r.y - 3), w: Math.round(r.w + 6), h: Math.round(r.h + 6) }, `${run ? "mcorn" : "csel"}${performance.now() < M.findUntil ? " mfind" : ""}`]);
        const text = name(sel);
        if (tagEl._t !== text) tagEl.textContent = tagEl._t = text;
        hide(tagEl, false);
        const y = r.y - 3 - 20 >= 0 ? r.y - 3 - 20 : r.y + r.h + 5;
        const at = `${Math.max(0, Math.round(r.x - 3))}|${Math.round(y)}`;
        if (tagEl._at !== at) {
          tagEl._at = at;
          tagEl.style.transform = `translate(${Math.max(0, Math.round(r.x - 3))}px, ${Math.round(y)}px)`;
        }
      } else hide(tagEl, true);
      return out;
    }
    /** More frames are needed: something plays, is dragged, or a ring is going out. */
    const busyFrames = () => M.on && S.enabled && (running() || !!M.drag || performance.now() < M.findUntil || !!(M.ro && M.ro.on));

    // ── the page's pointer ───────────────────────────────────────────────────────────────────
    function pointerDown(e) {
      if (popEl && !popEl.hidden) closePop();
      block(e);
      if (e.button !== 0) return;
      const el = pick(e.clientX, e.clientY);
      if (root.activeElement && root.activeElement.blur) root.activeElement.blur();
      selectEl(el);
    }
    function pointerMove(e) {
      if (isOurs(e)) {
        if (M.hover) {
          M.hover = null;
          kick();
        }
        return;
      }
      const next = pick(e.clientX, e.clientY);
      if (next !== M.hover) {
        M.hover = next;
        kick();
      }
    }

    // ── the timeline's pointer ───────────────────────────────────────────────────────────────
    // Click a keyframe (the page shows that frame), drag it, press twice on a lane to add one,
    // drag the ruler or an empty lane to scrub.
    const spanOf = () => tlEl.querySelector(".m-kspan[data-prop]") || tlEl.querySelector("[data-ruler]");
    function atOf(e, free, span) {
      const r = span.getBoundingClientRect(), pad = span.classList.contains("m-kspan") ? 0 : 16;
      const at = clamp(((e.clientX - r.left - pad) / (r.width - 2 * pad)) * 100, 0, 100);
      return free ? r1(at) : Math.round(at / 5) * 5;
    }
    function tlDown(e) {
      if (e.button || !M.open || e.target.closest("input, button, textarea")) return;
      const key = e.target.closest(".m-key"), seg = e.target.closest("[data-seg]"), trk = e.target.closest(".m-kspan[data-prop], [data-ruler]");
      const now = performance.now(), l = M.last;
      const twice = !!l && now - l.t < 350 && Math.abs(e.clientX - l.x) < 5 && Math.abs(e.clientY - l.y) < 5;
      M.last = twice ? null : { t: now, x: e.clientX, y: e.clientY };
      const span = spanOf();
      if (!span) return;
      if (twice && !key && trk && trk.dataset.prop !== undefined && openKf()) {
        e.preventDefault();
        addKey(trk.dataset.prop || null, atOf(e, mod(e), span));
        return focusLater("[data-k=val]");
      }
      if (key || seg) {
        const at = Number(key ? key.dataset.at : seg.dataset.seg), prop = (key || seg).dataset.prop || null;
        M.key = { at, prop };
        M.drag = key && !readOnly() ? { type: "key", at, prop, moved: false } : null;
        seek(at / 100);
        draw();
      } else if (trk) {
        M.drag = { type: "scrub" };
        seek(atOf(e, true, span) / 100);
        if (M.key) {
          M.key = null; // a press beside the keyframes lets go of the selected one
          draw();
        }
      } else return;
      if (M.drag) tlEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      tlEl.focus({ preventScroll: true });
    }
    function tlMove(e) {
      const d = M.drag;
      if (!d) return;
      const span = spanOf();
      if (!span) return;
      if (d.type === "scrub") return seek(atOf(e, true, span) / 100);
      const to = atOf(e, mod(e), span);
      if (to === d.at || !moveKey(d.prop, d.at, to)) return;
      d.at = to;
      M.key = { at: to, prop: d.prop };
      d.moved = true;
      apply();
      seek(to / 100);
      drawLanes();
      if (!typingIn(kbEl)) kbEl.innerHTML = keyEditor();
    }
    function tlUp() {
      const d = M.drag;
      M.drag = null;
      if (d && d.moved) commit();
    }
    const focusLater = (sel) =>
      setTimeout(() => {
        const f = dock.querySelector(sel);
        if (f && !f.disabled) f.select ? f.select() : f.focus();
      }, 0);

    // ── a small sheet over the dock ──────────────────────────────────────────────────────────
    function openPop(anchor, html) {
      popEl.innerHTML = html;
      popEl.hidden = false;
      popAnchor = anchor;
      const r = anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
      popEl.style.left = `${clamp(r.right - w, 8, innerWidth - w - 8)}px`;
      popEl.style.top = `${clamp(r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8, 8, innerHeight - h - 8)}px`;
    }
    function closePop() {
      if (popEl) popEl.hidden = true;
      popAnchor = null;
    }
    function morePop(b) {
      const t = timing(), u = openUse(), ro = readOnly() ? "disabled" : "";
      const count = { ...COUNT, ...(COUNT[t.count] ? {} : { [t.count]: [`${t.count}×`] }) };
      const how = u ? Object.fromEntries(Object.entries(HOW).filter(([k]) => !(u.isNew && k === "asnow")).map(([k, v]) => [k, [v]])) : {};
      const chips = (key, lab, map, cur) => `<div class="m-tchips"><span>${lab}</span><div class="m-chips" data-tkey="${key}">${Object.entries(map).map(([v, [text, what]]) =>
        `<button type="button" class="m-chip${String(cur) === v ? " on" : ""}" data-m="tset" data-v="${esc(v)}" ${ro} title="${esc(what ? `${what} (${v})` : v)}">${esc(text)}</button>`).join("")}</div></div>`;
      openPop(b, chips("count", "Repeat", count, t.count) + chips("direction", "Direction", DIRECTION, t.direction) + chips("fill", "Fill", FILL, t.fill) +
        (u ? chips("how", "Starts", how, u.plays.how) : ""));
    }
    function easePop(b) {
      const k = keyInfo();
      if (!k) return;
      const cur = k.ease || k.dflt;
      openPop(b, `<div class="m-ez">${[...new Set([cur, ...EASINGS])].map((e) => `<button type="button" data-m="ez" data-v="${esc(e)}" class="${e === cur ? "on" : ""}">${curve(e)}${esc(e)}</button>`).join("")}</div>`);
    }

    // ── clicks, fields and keys ──────────────────────────────────────────────────────────────
    function onClick(e) {
      const row = e.target.closest("[data-row]");
      if (row) {
        const r = listEl._rows[row.dataset.row];
        if (r && !r.off) {
          r.open();
          reveal(M.sel);
        }
        return;
      }
      const b = e.target.closest("[data-m]");
      if (!b || b.disabled) return;
      const act = b.dataset.m;
      if (act === "play") toggle();
      else if (act === "rate") {
        M.rate = RATES[(RATES.indexOf(M.rate) + 1) % RATES.length];
        const a = animOf();
        if (a) a.playbackRate = M.rate;
      } else if (act === "loop") (M.loop = !M.loop), (M.loopAt = 0);
      else if (act === "iso") {
        M.isolate = !M.isolate;
        apply();
      } else if (act === "undo") return travel(M.past, M.future);
      else if (act === "discard") return discard();
      else if (act === "new") return newAnimation();
      else if (act === "rmkey") return removeKey();
      else if (act === "rmlane") return removeLane(b.dataset.prop);
      else if (act === "detach") return detach();
      else if (act === "view") M.view = b.dataset.v;
      else if (act === "more") return popAnchor === b ? closePop() : morePop(b);
      else if (act === "kease") return popAnchor === b ? closePop() : easePop(b);
      else if (act === "ez") {
        setKey("ease", b.dataset.v, true);
        return closePop();
      } else if (act === "tset") {
        // a chip: set, and marked in its row here (the popover is not drawn again)
        const row2 = b.closest("[data-tkey]");
        setTiming(row2.dataset.tkey, b.dataset.v, true);
        for (const c of row2.children) c.classList.toggle("on", c === b);
        return;
      } else if (act === "send") return submit(e.altKey);
      draw();
    }
    function onField(e, done) {
      const f = e.target;
      if (f === noteEl) return drawFoot();
      if (f.dataset.css !== undefined) {
        const why = setCss(f.value), err = f.parentElement.querySelector(".m-err");
        if (err) (err.hidden = !why), (err.textContent = why);
        if (!why) drawFoot();
        return;
      }
      if (f.dataset.t !== undefined) {
        const ok = setTiming(f.dataset.t, f.value, done);
        f.classList.toggle("bad", !ok);
        if (ok && !done) drawLanes();
      } else if (f.dataset.k !== undefined) {
        const ok = setKey(f.dataset.k, f.value, done);
        f.classList.toggle("bad", !ok);
        if (ok && !done) drawLanes();
      } else if (f.dataset.addp !== undefined && done && f.value.trim()) {
        if (!addLane(f.value)) f.classList.add("bad");
        else focusLater("[data-k=val]");
      }
    }
    /** Keys while motion mode is on. Typing in the dock's fields never reaches the page. */
    function key(e) {
      const f = root.activeElement;
      const field = f && /^(INPUT|TEXTAREA)$/.test(f.tagName) && (dock.contains(f) || popEl.contains(f)) ? f : null;
      if (field) {
        if (e.key === "Enter" && !e.isComposing && (field.tagName === "INPUT" || mod(e))) {
          block(e);
          if (field === noteEl || mod(e)) return submit(e.altKey);
          field.blur(); // its change event makes the undo step
          return;
        }
        if (e.key === "Escape") {
          block(e);
          field.blur();
          // Esc in a keyframe's field is done with that keyframe too.
          if (field.dataset.k !== undefined) {
            M.key = null;
            draw();
          }
          return;
        }
        e.stopImmediatePropagation(); // typing: the page's handlers never see it
        return;
      }
      if (mod(e) && e.key.toLowerCase() === "z") {
        block(e);
        return e.shiftKey ? travel(M.future, M.past) : travel(M.past, M.future);
      }
      if (mod(e) || e.altKey && e.key !== "Enter") return;
      if (e.key === " ") {
        block(e);
        toggle();
        return draw();
      }
      if (e.key === "Enter" && !e.isComposing) {
        block(e);
        return submit(e.altKey);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && M.key && openKf()) {
        block(e);
        return removeKey();
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (!M.open) return;
        block(e);
        return seek((position() ?? M.pos) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01));
      }
      if (e.key === "Escape") {
        block(e);
        if (popEl && !popEl.hidden) closePop();
        else if (M.key) {
          M.key = null;
          draw();
        } else if (M.open || M.sel) selectEl(null);
        else setOn(false);
      }
    }

    // ── mount ────────────────────────────────────────────────────────────────────────────────
    function mount() {
      dock = root.querySelector(".m-dock");
      listEl = dock.querySelector(".m-list");
      hdEl = dock.querySelector(".m-hd");
      tlEl = dock.querySelector(".m-tl");
      cssEl = dock.querySelector(".m-css");
      kbEl = dock.querySelector(".m-kb");
      ftEl = dock.querySelector(".m-ft");
      noteEl = dock.querySelector(".m-note");
      msgEl = dock.querySelector(".m-msg");
      popEl = root.querySelector(".m-pop");
      tagEl = root.querySelector(".m-tag");
      root.querySelector(".m-lists").innerHTML = `<datalist id="b42-m-easings">${EASINGS.map((x) => `<option value="${x}">`).join("")}</datalist><datalist id="b42-m-props">${PROPS.map((x) => `<option value="${x}">`).join("")}</datalist>`;
      for (const el of [dock, popEl]) {
        el.addEventListener("click", onClick);
        el.addEventListener("input", (e) => onField(e, false));
        el.addEventListener("change", (e) => onField(e, true));
        // Keys typed into the dock must not reach the page's own shortcuts.
        for (const t of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut"]) el.addEventListener(t, (e) => e.stopPropagation());
      }
      dock.addEventListener("focusout", (e) => {
        if (e.target.dataset && e.target.dataset.css !== undefined) commit();
        if (e.target === noteEl) {
          drawFoot();
          draftChanged();
        }
      });
      noteEl.addEventListener("focus", drawFoot);
      // A button keeps the caret where it was (the note, a value being typed).
      dock.addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
      listEl.addEventListener("pointerover", (e) => {
        const row = e.target.closest("[data-row]");
        const r = row && listEl._rows[row.dataset.row];
        M.rowEls = r && r.els && r.els.length ? r.els : null;
        kick();
      });
      listEl.addEventListener("pointerleave", () => {
        M.rowEls = null;
        kick();
      });
      tlEl.addEventListener("pointerdown", tlDown);
      tlEl.addEventListener("pointermove", tlMove);
      tlEl.addEventListener("pointerup", tlUp);
      tlEl.addEventListener("pointercancel", tlUp);
    }

    return {
      get on() {
        return M.on;
      },
      mount, setOn, resume, syncUi, letGo, frame, busyFrames, key, pointerDown, pointerMove, submit, refuse, finish, dropFinished, draft, restore,
      hasSent: () => M.sent.length > 0,
      busy: () => !!M.drag,
      /** For tests: the engine's state and a few actions. */
      debug: { M, seek, play, pause, position, select: selectEl, openCss, setTiming, setKey, rows },
    };
  })();

  // ── input ───────────────────────────────────────────────────────────────────────────────────
  const isOurs = (e) => !!hostEl && e.composedPath().includes(hostEl);
  const block = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  function onPointerDown(e) {
    if (!S.enabled) return;
    if (MO.on) {
      if (isOurs(e)) return;
      if (S.pending) return block(e); // the screenshot is being taken: nothing new until it is
      return MO.pointerDown(e);
    }
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
      alt: e.altKey || S.brush, // the host's brush: a plain drag draws, as alt+drag does
      shift: e.shiftKey,
      pts: [[e.clientX + window.scrollX, e.clientY + window.scrollY]],
    };
  }

  function onPointerMove(e) {
    if (!S.enabled) return;
    if (C.on) return cvMove(e);
    if (MO.on) return MO.pointerMove(e);
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
    if (MO.on) return void (S.enabled && !isOurs(e) && block(e));
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
    if (MO.on) return MO.key(e);
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
      MO.letGo(); // the page is used as it is: nothing stays stopped at a frame
    } else if (S.card) {
      card.hidden = false;
      textarea.focus({ preventScroll: true });
    }
    syncUi();
    MO.syncUi();
    kick();
  }

  function setPins(pins) {
    const old = new Map(S.pins.map((p) => [p.id, p]));
    S.pins = (pins || []).map((p) => ({ ...p, el: old.get(p.id)?.el }));
    if (C.sent.length) dropFinished();
    if (MO.hasSent()) MO.dropFinished();
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
    const motionBoxes = MO.frame(capturing);

    // boxes: hover + selection
    const items = [];
    if (S.enabled && !capturing && !d && !C.on && !MO.on && S.hover && S.hover.isConnected && !S.sel.includes(S.hover))
      items.push([rectOf(S.hover), "hover"]);
    if (S.enabled || capturing) for (const el of S.sel) if (el.isConnected) items.push([rectOf(el), "sel"]);
    if (canvasBoxes) items.push(...canvasBoxes);
    if (motionBoxes) items.push(...motionBoxes);
    const divs = pool(boxes, items.length, () => document.createElement("div"));
    items.forEach(([r, cls], i) => placeBox(divs[i], r, cls));

    // ink: committed strokes, area, and the live drag
    // All of it is drawn in document coordinates, and the whole picture is moved against the
    // scroll by a CSS transform on a compositor layer of its own. So scrolling paints nothing:
    // the layer is drawn once and then only moved, and the pencil grain (noise in the picture's
    // own coordinates) stays put on the page.
    const show = S.enabled || capturing;
    const paths = show ? S.strokes.slice() : [];
    if (d && d.mode === "draw") paths.push(d.pts);
    const sx = VP.sx, sy = VP.sy;
    const areas = [];
    if (show && S.area) areas.push(S.area);
    if (d && d.mode === "area") areas.push({ x: Math.min(d.x0, d.x) + sx, y: Math.min(d.y0, d.y) + sy, w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) });
    const drawn = paths.length + areas.length > 0;
    if (ink._on !== drawn) ink.classList.toggle("on", (ink._on = drawn)); // a layer only while there is ink
    // With nothing drawn, scrolling writes nothing here.
    const inkAt = `${sx}|${sy}`;
    if (drawn && ink._at !== inkAt) {
      ink._at = inkAt;
      ink.style.transform = `translate(${-sx}px, ${-sy}px)`;
    }
    const pathEls = pool(strokesEl, paths.length, () => document.createElementNS(SVG, "path"));
    let redrawn = pathEls.length !== strokesEl._n;
    strokesEl._n = pathEls.length;
    paths.forEach((pts, i) => {
      // A drawn stroke stays as it is, and the one being drawn only grows: the same points and
      // the same count mean the same path. Writing it again would repaint the ink every frame.
      const el = pathEls[i];
      if (el._pts === pts && el._n === pts.length) return;
      el._pts = pts;
      el._n = pts.length;
      el.setAttribute("d", `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}`);
      redrawn = true;
    });
    // The pencil filter is worked out for the strokes' own box, wherever the page is scrolled to
    // (the line is nudged by 2px at most; the margin is for its width and round ends).
    if (redrawn && paths.length) {
      const b = union(paths.map((pts) => (pts === (d && d.pts) ? bboxOf(pts) : strokeBox.get(pts) || strokeBox.set(pts, bboxOf(pts)).get(pts))));
      const key = `${Math.floor(b.x) - 12}|${Math.floor(b.y) - 12}|${Math.ceil(b.w) + 24}|${Math.ceil(b.h) + 24}`;
      if (pencil._key !== key) {
        pencil._key = key;
        const [x, y, w, h] = key.split("|");
        pencil.setAttribute("x", x);
        pencil.setAttribute("y", y);
        pencil.setAttribute("width", w);
        pencil.setAttribute("height", h);
      }
    }
    const rectEls = pool(ink.querySelector(".areas"), areas.length, () => document.createElementNS(SVG, "rect"));
    areas.forEach((r, i) => {
      const el = rectEls[i], key = `${r.x}|${r.y}|${r.w}|${r.h}`;
      if (el._k === key) return; // (an area that stays is not written again either)
      el._k = key;
      el.setAttribute("x", r.x);
      el.setAttribute("y", r.y);
      el.setAttribute("width", r.w);
      el.setAttribute("height", r.h);
    });

    // card
    if (S.card && S.enabled && !capturing) placeCard();

    // pins
    const visible = [];
    const unplaced = [];
    const now = performance.now();
    if (C.pathsDirty && now - C.pathsAt > 50) readPaths();
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
    const dpr = window.devicePixelRatio || 1;
    if (!visible.length) hideTip();
    visible.forEach(([p, [x, y], approx], i) => {
      const el = pinEls[i];
      el._pin = p;
      // On whole device pixels: a pin is a layer, drawn once and then moved, and a layer moved by
      // part of a pixel is shown blurred.
      const cx = Math.round(Math.min(Math.max(10, x), VP.w - 10) * dpr) / dpr;
      const cy = Math.round(Math.min(Math.max(10, y), VP.h - 10) * dpr) / dpr;
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
    if (S.card || S.sel.length || S.drag || S.pending || (C.on && (C.sel || C.drag || C.edit)) || MO.busyFrames() || performance.now() - lastInput < ACTIVE_MS)
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
    .ink.on { will-change: transform; }
    .ink path { fill: none; stroke: #ef4444; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .ink rect { fill: color-mix(in srgb, var(--pa) 10%, transparent); stroke: var(--pa); stroke-width: 1.5; stroke-dasharray: 5 4; }
    .box { position: fixed; left: 0; top: 0; box-sizing: border-box; border-radius: 3px; pointer-events: none; }
    .box.hover { border: 1.5px dashed #3b82f6; background: rgba(59, 130, 246, 0.06); }
    .box.sel { border: 2px solid var(--pa); background: color-mix(in srgb, var(--pa) 10%, transparent); }
    /* A selection's outline and the pins are compositor layers of their own: they keep their size
       and only move, with the scroll, so the page under them (which may be large) is not painted
       again. Not the hover outline: it changes size with every element, and a layer that is
       resized is drawn anew each time (measured: no gain in software, a third more GPU time). */
    .box.sel, .box.csel { will-change: transform; }
    /* The same badge as in the app's notes list: 20 px, the same rounded-square corners, bold mono
       digits, dark ink on amber and green, no ring. */
    .pin { position: fixed; left: -10px; top: -10px; box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 5px;
      border-radius: 10px; corner-shape: superellipse(1.333); font: 700 12px/20px ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; text-align: center;
      font-variant-numeric: tabular-nums; color: #fff; background: #6b7280;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); pointer-events: none; will-change: transform; }
    .pins.live .pin { pointer-events: auto; cursor: pointer; }
    .pins.live .pin:hover { box-shadow: 0 0 0 2px var(--pa); }
    .vbar { position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 3px; box-sizing: border-box;
      pointer-events: auto; background: #1a1a1b; color: #ededed; border-radius: 8px; white-space: nowrap;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.12); font: 13px/1 system-ui, -apple-system, sans-serif; }
    .vbar button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
      min-width: 26px; height: 22px; padding: 0 6px; border-radius: 5px; cursor: pointer; font: inherit; }
    .vbar button .ic { display: block; flex: none; }
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
    @media (prefers-reduced-motion: reduce) { .sent { animation: none; } }
    /* The pulse of a working pin goes in four steps each way, not sixty frames a second: a pin can
       pulse for minutes with review off, and every frame of it is a frame the whole window is
       drawn again (measured: 107 ms of CPU a second smooth, 38 in steps, 12 to 27 with none). */
    .pin.working { background: #f59e0b; color: #10100e; animation: pulse 1s steps(4, jump-none) infinite; }
    @media (prefers-reduced-motion: reduce) { .pin.working { animation: none; } }
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
    .meta { display: flex; align-items: center; gap: 12px; height: 20px; margin: 0 0 6px 2px; color: #d4d4d4; font-size: 12px; }
    .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fffaa0; font-weight: 500; }
    .hint.warn { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fbbf24; }
    /* The card's keys: a "?" whose list shows while the pointer or the focus is on it. */
    .khelp { position: relative; flex: none; display: flex; }
    .kq { all: unset; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 5px; color: #8b8b8b; cursor: help; }
    .kq:hover, .kq:focus-visible { color: #ededed; background: rgba(255, 255, 255, 0.08); }
    .kq:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .kpop { position: absolute; right: -4px; top: calc(100% + 6px); z-index: 1; display: none; width: max-content; padding: 6px 4px; box-sizing: border-box;
      background: #1a1a1b; border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12);
      font-size: 12px; line-height: 1.4; pointer-events: none; }
    .card.low .kpop { top: auto; bottom: calc(100% + 6px); }
    .khelp:hover .kpop, .kq:focus-visible + .kpop { display: block; }
    .krow { display: flex; align-items: center; gap: 12px; padding: 3px 8px; }
    .kk { flex: none; display: inline-flex; align-items: center; gap: 1px; min-width: 40px; color: #ededed; }
    .kv { color: #9ca3af; white-space: nowrap; }
    .kg { flex: none; display: inline-block; vertical-align: -1px; }
    /* The note and, in its corner, the ↵ that sends it: lit once there is something to send. */
    .cbody { display: flex; align-items: flex-end; gap: 6px; }
    .cbody textarea { flex: 1; min-width: 0; }
    textarea { all: unset; display: block; width: 100%; box-sizing: border-box; min-height: 44px; max-height: 240px;
      overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 4px 2px; color: #ededed; font: inherit;
      cursor: text; }
    .csend { all: unset; flex: none; display: grid; place-items: center; width: 28px; height: 28px; margin: 0 -4px -4px 0; border-radius: 6px;
      color: #ededed; cursor: pointer; }
    .csend:hover { background: rgba(255, 255, 255, 0.1); }
    .csend:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .csend:disabled { color: #5c5c5c; background: none; cursor: default; }
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
    /* The bar, in edit mode: a small card above the inspector. What is in the batch, undo, reset
       and Send on its first row; the note that goes with the edits (or what the bar has to say)
       on its second. Its width is fixed, so nothing in it moves as the state changes. In notes
       mode it is one button, and only when edits were left unsent. The mode switch and the brush
       are the host's. */
    .bar { position: fixed; left: 56px; right: 56px; bottom: 14px; width: max-content; margin: 0 auto; display: flex; flex-direction: column; gap: 4px; padding: 4px;
      box-sizing: border-box; max-width: calc(100vw - 112px); pointer-events: auto; background: #1a1a1b; color: #ededed; border-radius: 10px; white-space: nowrap;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12); font: 13px/1 system-ui, -apple-system, sans-serif; }
    .bar.canvas { width: 340px; }
    .bar.idle { display: none; }
    .brow { display: flex; align-items: center; gap: 2px; height: 28px; }
    .bgap { flex: 1; }
    .act, .ifold, .count { all: unset; box-sizing: border-box; height: 24px; padding: 0 10px; border-radius: 5px; cursor: pointer; font: inherit; line-height: 24px; color: #b4b4b4; }
    .act:hover, .ifold:hover { color: #fff; }
    .act { flex: none; padding: 0 8px; color: #ededed; }
    .act.ib { display: grid; place-items: center; width: 28px; padding: 0; }
    .act:hover, .count:hover, .count.open { background: rgba(255, 255, 255, 0.1); }
    .act:disabled, .count:disabled { color: #6b6b6b; background: none; cursor: default; }
    .act:focus-visible, .ifold:focus-visible, .count:focus-visible, .bsend:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .count { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; color: #fffaa0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .count .ic { display: none; order: -1; }
    .bar.canvas .count:not(:disabled) .ic { display: block; }
    .corner { position: fixed; right: 12px; bottom: 14px; width: 36px; height: 36px; pointer-events: auto; font: 13px/1 system-ui, -apple-system, sans-serif; }
    .help { all: unset; display: grid; place-items: center; width: 36px; height: 36px; box-sizing: border-box; border-radius: 8px; background: #1a1a1b; color: #b4b4b4;
      cursor: pointer; font: 600 14px/1 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12); }
    .help:hover, .help.on { color: #fff; }
    .help:focus-visible { box-shadow: 0 0 0 2px #fffaa0; }
    .corner .pop { left: auto; right: 0; width: min(400px, calc(100vw - 24px)); color: #ededed; }
    .cnote { all: unset; box-sizing: border-box; flex: none; width: 100%; height: 30px; padding: 0 8px; border-radius: 6px;
      background: rgba(255, 255, 255, 0.07); color: #ededed; font: inherit; cursor: text; }
    .cnote::placeholder { color: #8b8b8b; }
    .cls::placeholder, .ed textarea::placeholder { color: #8b8b8b; font: italic 12px/18px system-ui, -apple-system, sans-serif; }
    .cnote:focus, .cls:focus, .ed textarea:focus { box-shadow: 0 0 0 1.5px rgba(255, 250, 160, 0.7); }
    .bmsg { flex: none; box-sizing: border-box; width: 100%; height: 30px; padding: 0 8px; color: #9ca3af; font-size: 12px; line-height: 30px; overflow: hidden; text-overflow: ellipsis; }
    .bmsg.warn { color: #fbbf24; }
    .bsend { all: unset; flex: none; box-sizing: border-box; height: 28px; margin-left: 4px; padding: 0 16px; border-radius: 6px; background: #fffaa0; color: #171717;
      font: inherit; font-weight: 600; line-height: 28px; cursor: pointer; }
    .bsend:hover { background: #fffcc4; }
    .bsend:disabled { background: rgba(255, 255, 255, 0.08); color: #6b6b6b; cursor: default; }
    .bar .pop { bottom: calc(100% + 6px); }
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
    .ibody { flex: 1; min-height: 0; display: flex; container-type: inline-size; }
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
    /* Element: the selection's classes, styles and computed values. Global: the batch's stylesheet.
       The switch is in the inspector's header, so the columns start at the top of the body. */
    .tabs { flex: none; display: flex; gap: 2px; padding: 2px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); }
    .insp.shut .tabs { display: none; }
    .tab { all: unset; box-sizing: border-box; height: 20px; padding: 0 10px; border-radius: 4px; color: #b4b4b4; font-size: 12px; line-height: 20px; cursor: pointer; }
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
    /* With room for it, the inspector is three equal columns: the tree, what the selection
       computes to, and what is typed for it. Each scrolls by itself, so the fields stay in view
       down the list, and the styles box takes the height that is left, as the stylesheet's does.
       (Tab still goes to the fields first: they come first in the markup.) */
    @container (min-width: 900px) {
      .tree { box-sizing: border-box; flex-basis: 33.333%; }
      .p-el { display: flex; padding: 0; overflow: hidden; }
      .p-el .col { box-sizing: border-box; min-width: 0; overflow: auto; padding: 0 12px 14px; }
      .p-el .c-comp { order: -1; flex: 0 0 50%; border-right: 1px solid rgba(255, 255, 255, 0.1); }
      .p-el .c-in { flex: 1; display: flex; flex-direction: column; }
      .p-el .c-in > * { flex: none; }
      .p-el .c-in .ed { flex: 1; min-height: 60px; }
      .p-el .c-in .ed textarea { height: 100%; max-height: none; field-sizing: fixed; }
    }
    /* motion mode: on the page, the open element (the accent), its corners while it plays, the
       elements of the list row under the pointer, a ring that goes out to find a small one */
    .box.mcorn { --c: var(--pa); background: linear-gradient(var(--c), var(--c)) 0 0 / 10px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 0 0 / 1.5px 10px no-repeat,
      linear-gradient(var(--c), var(--c)) 100% 0 / 10px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 100% 0 / 1.5px 10px no-repeat,
      linear-gradient(var(--c), var(--c)) 0 100% / 10px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 0 100% / 1.5px 10px no-repeat,
      linear-gradient(var(--c), var(--c)) 100% 100% / 10px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 100% 100% / 1.5px 10px no-repeat; will-change: transform; }
    .box.mrow { border: 1.5px solid color-mix(in srgb, var(--pa) 55%, transparent); background: color-mix(in srgb, var(--pa) 8%, transparent); }
    .box.mfind { animation: mfind 700ms cubic-bezier(0.2, 0.8, 0.2, 1) 2; }
    @keyframes mfind { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pa) 55%, transparent); } to { box-shadow: 0 0 0 22px transparent; } }
    @media (prefers-reduced-motion: reduce) { .box.mfind { animation: none; } }
    .m-tag { position: fixed; left: 0; top: 0; padding: 0 6px; border-radius: 4px; background: var(--pa); color: var(--pat, #fff); pointer-events: none;
      font: 500 11px/18px system-ui, -apple-system, sans-serif; white-space: nowrap; }
    /* motion mode: the dock. The list of what moves; the open animation: what is done to it, its
       timeline (a band of lanes, a bar between two keyframes, a grip on each), the selected
       keyframe, and the note with Send. */
    .m-dock, .m-pop { --mt: #ededed; --mm: #a1a1a6; --md: #6b6b70; --ml: rgba(255, 255, 255, 0.07); --mf: rgba(255, 255, 255, 0.06); --mh: rgba(255, 255, 255, 0.1);
      --ma: #fffaa0; --mas: rgba(255, 250, 160, 0.14); --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; }
    .m-dock { position: fixed; left: 0; right: 0; bottom: 0; height: 360px; display: grid; grid-template-columns: 248px minmax(0, 1fr); box-sizing: border-box;
      pointer-events: auto; background: #1a1a1b; color: var(--mt); border-radius: 10px 10px 0 0; font: 12px/1.5 system-ui, -apple-system, sans-serif;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.12); }
    .m-dock *, .m-pop * { box-sizing: border-box; }
    .m-btn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; min-width: 28px; padding: 0 8px;
      border-radius: 6px; color: var(--mm); cursor: pointer; white-space: nowrap; font: inherit; }
    .m-btn:hover { background: var(--mh); color: var(--mt); }
    .m-btn.on { color: var(--ma); }
    .m-btn:disabled { color: var(--md); background: none; cursor: default; opacity: 0.6; }
    .m-btn.ic { padding: 0; width: 28px; }
    .m-btn .ic { display: block; flex: none; }
    .m-btn:focus-visible, .m-fld:focus-visible, .m-chip:focus-visible, .m-go:focus-visible, .m-seg button:focus-visible { box-shadow: 0 0 0 1.5px rgba(255, 250, 160, 0.6); outline: none; }
    .m-fld { all: unset; box-sizing: border-box; height: 28px; min-width: 0; padding: 0 8px; border-radius: 6px; background: var(--mf); color: var(--mt); font: 12px/28px var(--mono); cursor: text; }
    .m-fld:hover { background: var(--mh); }
    .m-fld.num { width: 64px; text-align: right; }
    .m-fld.ease { field-sizing: content; min-width: 96px; max-width: 280px; }
    .m-fld.bad { box-shadow: 0 0 0 1.5px #f87171; }
    .m-fld:disabled { color: var(--mm); background: transparent; cursor: default; }
    .m-unit { color: var(--md); font: 12px var(--mono); margin-left: -2px; }
    .m-cv { flex: none; display: block; width: 28px; height: 28px; border-radius: 6px; background: var(--mf); }
    .m-sp { flex: 1; }
    .m-kind { flex: none; display: block; color: var(--md); }
    /* the list */
    .m-list { min-height: 0; overflow: auto; padding: 8px 0 16px; border-right: 1px solid var(--ml); }
    .m-grp { margin: 20px 16px 6px; color: var(--md); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
    .m-grp:first-child { margin-top: 8px; }
    .m-none { margin: 16px; color: var(--md); }
    .m-it { position: relative; display: flex; align-items: center; gap: 10px; height: 32px; margin: 0 8px; padding: 0 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
    .m-it:hover { background: var(--mf); }
    .m-it.on { background: var(--mas); }
    .m-it.on .m-nm { color: var(--ma); }
    .m-it.run .m-kind { color: var(--mm); }
    .m-it:hover .m-kind { color: var(--mt); }
    .m-it.on .m-kind { color: var(--ma); }
    .m-it.off { cursor: default; opacity: 0.5; }
    .m-it.off:hover { background: none; }
    /* an element of an animation: under it, with a line back to its icon */
    .m-it.sub { padding-left: 34px; }
    .m-it.sub::before { content: ""; position: absolute; left: 15.5px; top: 0; bottom: 0; width: 1px; background: rgba(255, 255, 255, 0.1); }
    .m-it:not(.sub) + .m-it.sub::before { top: -8px; }
    .m-it.sub.last::before { bottom: 50%; }
    .m-it.sub::after { content: ""; position: absolute; left: 15.5px; top: 50%; width: 8px; height: 1px; background: rgba(255, 255, 255, 0.1); }
    .m-nm { flex: none; max-width: 70%; overflow: hidden; text-overflow: ellipsis; font: 12px var(--mono); color: var(--mt); }
    .m-it.sub .m-nm, .m-it.k-transition .m-nm, .m-it.k-frames .m-nm { font-family: system-ui, -apple-system, sans-serif; }
    .m-ex { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--md); }
    .m-du { flex: none; color: var(--md); font: 12px var(--mono); font-variant-numeric: tabular-nums; }
    .m-ed { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--ma); }
    /* the open animation */
    .m-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .m-hd { flex: none; display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 12px 0 16px; }
    .m-tools { flex: none; display: flex; align-items: center; gap: 2px; }
    .m-hd > .m-tools + .m-tools { margin-left: -8px; }
    .m-seg { flex: none; display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px; background: var(--mf); }
    .m-seg button { all: unset; height: 24px; padding: 0 10px; border-radius: 6px; color: var(--mm); cursor: pointer; font: inherit; line-height: 24px; }
    .m-seg button:hover { color: var(--mt); }
    .m-seg button.on { background: var(--mh); color: var(--mt); }
    .m-timing { flex: 0 1 auto; display: flex; align-items: center; gap: 16px; min-width: 0; overflow: hidden; }
    /* A narrow dock (a phone-width window): the fields keep their values and lose their names. */
    .m-main { container-type: inline-size; }
    @container (max-width: 900px) { .m-tf > span:first-child, .m-timing .m-cv { display: none; } .m-hd { gap: 10px; } }
    .m-tf { display: inline-flex; align-items: center; gap: 8px; color: var(--md); white-space: nowrap; }
    .m-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .m-css { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 0 16px 12px; }
    .m-css textarea { all: unset; flex: 1; min-height: 0; box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 8px; background: var(--mf); color: var(--mt);
      font: 12px/20px var(--mono); tab-size: 2; white-space: pre; overflow: auto; cursor: text; }
    .m-css textarea:focus { box-shadow: 0 0 0 1.5px rgba(255, 250, 160, 0.5); }
    .m-err { margin-top: 8px; color: #f87171; }
    .m-kb { flex: none; display: flex; align-items: center; height: 52px; padding: 0 12px 0 16px; border-top: 1px solid var(--ml); }
    .m-keyed { flex: 1; display: flex; align-items: center; gap: 8px; color: var(--md); white-space: nowrap; }
    .m-p { color: var(--mt); font: 12px var(--mono); }
    .m-keyed .m-fld.val { flex: 1; min-width: 80px; }
    .m-cvb { width: 28px; height: 28px; }
    .m-ft { flex: none; display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 12px 0 16px; border-top: 1px solid var(--ml); }
    .m-note { all: unset; flex: 1; min-width: 0; box-sizing: border-box; height: 32px; padding: 0 10px; border-radius: 6px; background: var(--mf); color: var(--mt); font: inherit; cursor: text; }
    .m-note::placeholder { color: #8b8b8b; }
    .m-note:focus { box-shadow: 0 0 0 1.5px rgba(255, 250, 160, 0.6); }
    .m-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mm); }
    .m-msg.warn { color: #fbbf24; }
    .m-go { all: unset; flex: none; box-sizing: border-box; height: 32px; padding: 0 18px; border-radius: 6px; background: var(--ma); color: #171717; font: 600 12px/32px system-ui, -apple-system, sans-serif; cursor: pointer; }
    .m-go:hover { background: #fffcc4; }
    .m-go:disabled { background: var(--mf); color: var(--md); cursor: default; }
    /* the timeline: rows of a label and a track */
    .m-tl { --pad: 16px; --lab: 156px; position: relative; flex: 1; min-height: 0; overflow: auto; outline: none; touch-action: none; user-select: none; }
    .m-lrow { display: flex; height: 32px; }
    .m-lab { flex: 0 0 var(--lab); display: flex; align-items: center; gap: 4px; padding: 0 6px 0 16px; overflow: hidden; white-space: nowrap; color: var(--mm); }
    .m-lab > span { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .m-lab .m-x { visibility: hidden; }
    .m-lrow:hover .m-lab .m-x { visibility: visible; }
    .m-trk { position: relative; flex: 1; min-width: 0; cursor: pointer; }
    .m-empty { display: grid; place-items: center; align-content: center; gap: 12px; height: 100%; min-height: 120px; padding: 24px; color: var(--md); text-align: center; }
    .m-new { background: var(--mf); color: var(--mt); }
    .m-addp { display: flex; align-items: center; padding: 8px 16px 16px; }
    .m-addp .m-fld { width: 140px; }
    /* the ruler: seconds on top, ticks, the whole keyframes along the bottom */
    .m-ruler { position: sticky; top: 0; z-index: 3; height: 56px; background: #1a1a1b; }
    .m-ruler .m-lab { align-items: flex-start; gap: 2px; padding: 8px 6px 0 8px; }
    .m-ruler .m-trk { cursor: ew-resize; }
    .m-time { min-width: 40px; color: var(--mm); font: 12px/28px var(--mono); font-variant-numeric: tabular-nums; }
    .m-btn.play { color: var(--mt); }
    .m-tick { position: absolute; top: 22px; left: calc(var(--pad) + (100% - 2 * var(--pad)) * var(--at)); width: 1px; height: 4px; background: rgba(255, 255, 255, 0.16); }
    .m-tick.big { height: 8px; top: 18px; background: rgba(255, 255, 255, 0.3); }
    .m-tick b { position: absolute; top: -15px; left: 0; translate: -50% 0; color: var(--md); font: 400 10px/12px var(--mono); white-space: nowrap; }
    .m-tick:first-child b { translate: -2px 0; }
    .m-tick:last-child b { translate: calc(2px - 100%) 0; }
    .m-key { position: absolute; left: calc(var(--pad) + (100% - 2 * var(--pad)) * var(--at)); cursor: grab; z-index: 2; }
    .m-key::after { content: ""; position: absolute; }
    .m-key.wk { top: 44px; width: 16px; height: 16px; margin: -8px 0 0 -8px; }
    .m-key.wk::after { left: 4.5px; top: 4.5px; width: 7px; height: 7px; border-radius: 1.5px; rotate: 45deg; background: var(--md); }
    .m-key.wk:hover::after { background: var(--mt); }
    .m-key.wk.on::after { background: var(--ma); box-shadow: 0 0 0 3px rgba(255, 250, 160, 0.2); }
    /* the band: the keyframes, behind their lanes, headed by their name and who else plays them */
    .m-lanes { position: relative; padding-bottom: 4px; }
    .m-bands { position: absolute; inset: 0 0 0 var(--lab); pointer-events: none; }
    .m-band { position: absolute; inset: 0; border-radius: 12px; background: rgba(255, 255, 255, 0.025); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.045); }
    .m-ghead { height: 36px; }
    .m-ghead .m-lab { gap: 8px; }
    .m-ghead .m-lab b { font: 500 12px var(--mono); color: var(--mt); overflow: hidden; text-overflow: ellipsis; }
    .m-ghead .m-trk { display: flex; align-items: center; gap: 8px; padding: 0 12px; cursor: default; }
    .m-shared { display: inline-flex; align-items: center; gap: 6px; color: var(--mm); white-space: nowrap; cursor: help; }
    .m-shared b { font: 500 12px var(--mono); color: var(--mt); }
    .m-own { height: 24px; background: var(--mf); color: var(--mt); }
    .m-lane { height: 40px; }
    .m-lane .m-lab { padding-left: 40px; }
    .m-lane.kon .m-lab { color: var(--mt); }
    /* the keyframes' span, 0…100% of the lane (the ruler's inset is outside it) */
    .m-kspan { --pad: 0px; position: absolute; top: 0; bottom: 0; left: 16px; right: 16px; cursor: pointer; }
    /* a bar: one stretch between two keyframes. Its outer ends reach past the lane's first and
       last keyframes, so those grips sit inside it; where two meet, a gap holds the shared grip. */
    .m-sb { position: absolute; top: 8px; bottom: 8px; left: calc(100% * var(--fa) + var(--l)); width: calc(100% * (var(--fb) - var(--fa)) - var(--l) + var(--r));
      border-radius: 7px; background: rgba(255, 255, 255, 0.09); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07); cursor: pointer; }
    .m-sb:hover { background: rgba(255, 255, 255, 0.13); }
    .m-sb.flat { background: rgba(255, 255, 255, 0.04); }
    .m-sb.on { background: rgba(255, 250, 160, 0.14); box-shadow: inset 0 0 0 1px rgba(255, 250, 160, 0.45); }
    .m-key.m-gr { top: 50%; width: 14px; height: 24px; margin: -12px 0 0 -7px; }
    .m-key.m-gr::after { left: 6px; top: 6px; width: 2px; height: 12px; border-radius: 1px; background: rgba(255, 255, 255, 0.5); }
    .m-key.m-gr:hover::after { background: #fff; }
    .m-key.m-gr.on::after { background: var(--ma); }
    .m-tl.ro .m-key { cursor: pointer; }
    /* the playhead: a flag on the ruler, the time above it, a line down the lanes */
    .m-phl { position: absolute; top: 0; bottom: 0; left: var(--lab); right: 0; pointer-events: none; z-index: 4; }
    .m-flag { position: absolute; top: 0; bottom: 0; left: calc(var(--pad) + (100% - 2 * var(--pad)) * var(--x, 0)); width: 1px; }
    .m-flag::after { content: ""; position: absolute; top: 30px; bottom: 0; left: 0; width: 1px; background: var(--ma); opacity: 0.8; }
    .m-flag::before { content: ""; position: absolute; top: 18px; left: -5.5px; width: 12px; height: 13px; background: var(--ma); clip-path: polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%); border-radius: 2px; }
    .m-flag b { position: absolute; top: 1px; left: 0; translate: -50% 0; padding: 0 5px; border-radius: 4px; background: var(--ma); color: #161617; font: 600 10px/15px var(--mono); white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* a small sheet over the dock: how it plays (chips), the easings (curves) */
    .m-pop { position: fixed; z-index: 1; min-width: 220px; padding: 14px 16px 16px; border-radius: 10px; pointer-events: auto; background: #232325; color: var(--mt);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08); font: 12px/1.5 system-ui, -apple-system, sans-serif; }
    .m-tchips { display: flex; flex-direction: column; gap: 6px; }
    .m-tchips + .m-tchips { margin-top: 14px; }
    .m-tchips > span { color: var(--md); }
    .m-chips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 320px; }
    .m-chip { all: unset; height: 26px; padding: 0 10px; border-radius: 6px; background: var(--mf); color: var(--mm); cursor: pointer; white-space: nowrap; line-height: 26px; }
    .m-chip:hover { background: var(--mh); color: var(--mt); }
    .m-chip.on { background: var(--mas); color: var(--ma); box-shadow: inset 0 0 0 1px rgba(255, 250, 160, 0.35); }
    .m-chip:disabled { cursor: default; opacity: 0.5; }
    .m-ez { display: flex; flex-direction: column; gap: 2px; margin: -8px; }
    .m-ez button { all: unset; display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px; border-radius: 8px; color: var(--mm); cursor: pointer; font: 12px var(--mono); white-space: nowrap; }
    .m-ez button:hover { background: var(--mf); color: var(--mt); }
    .m-ez button.on { background: var(--mh); color: var(--mt); }
    .m-ez .m-cv { width: 22px; height: 22px; background: none; }
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
      <div class="card" hidden><div class="meta"><span class="what"></span><span class="hint" hidden></span>
        <span class="khelp"><button type="button" class="kq" aria-label="Keys" aria-describedby="b42-ckeys">${icon("help", 14)}</button><div class="kpop" id="b42-ckeys" role="tooltip"></div></span></div>
      <button type="button" class="chip" title="Remove the template" hidden></button>
      <div class="cbody"><textarea rows="2" placeholder="${PLACEHOLDER}" spellcheck="false"></textarea>
        <button type="button" class="csend" aria-label="Send" title="Send (↵) · ${isMac ? "⌥" : "alt+"}click to work in parallel" disabled>${icon("↵")}</button></div>
      <div class="menu" hidden></div><div class="refs" hidden></div></div>
      <div class="variants"></div><div class="tip" hidden></div><div class="sent" hidden></div>
      <div class="cv" hidden><div class="band" hidden></div>
        <div class="hit" hidden><div class="gzs"></div><div class="eg" hidden></div><div class="eg" hidden></div><div class="eg" hidden></div><div class="eg" hidden></div>
          <div class="hd" hidden></div><div class="hd" hidden></div><div class="hd" hidden></div><div class="hd" hidden></div></div>
        <div class="ghost" hidden></div><div class="ins" hidden></div><div class="lab dim" hidden></div><div class="lab live" hidden></div>
        <div class="shield" hidden></div></div>
      <div class="insp" hidden><div class="grip" title="Drag to resize"></div>
        <div class="ihead"><span class="ititle">Inspector</span><span class="ipath"></span>
          <div class="tabs" role="tablist" aria-label="What the styles are for"><button type="button" role="tab" class="tab t-el">Element</button><button type="button" role="tab" class="tab t-gl" title="New rules for the page, sent with this batch">Global<i class="dot" hidden></i></button></div>
          <button type="button" class="ifold"></button></div>
        <div class="ibody"><div class="tree" tabindex="0" role="tree" aria-label="Page elements"><div class="tspace"><div class="trows"></div></div></div>
          <div class="side">
            <div class="pane p-el" role="tabpanel" hidden>
              <div class="col c-in">
                <label class="sec" for="b42-cls">Classes</label>
                <input id="b42-cls" class="cls" type="text" spellcheck="false" autocomplete="off" placeholder="Select an element to edit its classes">
                <label class="sec" for="b42-css">Element styles <i>only this element · & nests</i></label>
                <div class="ed"><pre class="hl" aria-hidden="true"></pre><textarea id="b42-css" class="css" spellcheck="false" placeholder="Type CSS for this element, e.g. padding: 20px"></textarea></div><div class="err" hidden></div>
              </div>
              <div class="col c-comp">
                <div class="sec">Computed <i>edit a value to add it to Element styles</i></div>
                <div class="comp"></div>
              </div>
            </div>
            <div class="pane p-gl" role="tabpanel">
              <label class="sec" for="b42-free">Stylesheet <i>new rules, sent with this batch</i></label>
              <div class="ed"><pre class="hl" aria-hidden="true"></pre><textarea id="b42-free" class="free" spellcheck="false" placeholder="New rules, e.g. .name { … }"></textarea></div><div class="err" hidden></div>
            </div>
          </div></div></div>
      <div class="bar" hidden><div class="pop" hidden></div>
        <div class="brow"><button type="button" class="count" hidden><span class="cn"></span>${icon("chevron-up", 12)}</button><span class="bgap"></span>
          <button type="button" class="act ib undo" aria-label="Undo" title="Undo (${isMac ? "⌘" : "ctrl+"}Z)" hidden>${icon("undo")}</button><button type="button" class="act ib redo" aria-label="Redo" title="Redo (${isMac ? "⌘⇧" : "ctrl+shift+"}Z)" hidden>${icon("redo")}</button><button type="button" class="act reset" title="Remove every unsent edit (undoable)" hidden>Reset</button>
          <button type="button" class="bsend" hidden>Send</button></div>
        <input class="cnote" type="text" spellcheck="false" autocomplete="off" placeholder="Add a note…" hidden><span class="bmsg" hidden></span></div>
      <div class="corner" hidden><div class="pop" hidden></div><button type="button" class="help" title="Keys and gestures" aria-label="Keys and gestures">${icon("help")}</button></div>
      <div class="m-tag" hidden></div>
      <div class="m-dock" hidden><div class="m-list" role="list" aria-label="What moves on the page"></div>
        <div class="m-main"><div class="m-hd" hidden></div><div class="m-body"><div class="m-tl" tabindex="0"></div><div class="m-css" hidden></div></div>
          <div class="m-kb" hidden></div>
          <div class="m-ft"><input class="m-note" type="text" spellcheck="false" autocomplete="off" placeholder="Note…"><span class="m-msg" hidden></span>
            <button type="button" class="m-go" data-m="send" disabled>Send</button></div></div></div>
      <div class="m-pop" hidden></div><div class="m-lists"></div>`;
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
    MO.mount();
    seat();

    // A change to the page may have removed the layer, closed it (an element taken out of the
    // document leaves the top layer) or opened or closed a modal dialog: seat it again then.
    // Any other change leaves it where it is, and the document is not searched for dialogs.
    new MutationObserver((records) => {
      if (!hostEl.isConnected || (hostEl.showPopover && !hostEl.matches(":popover-open")) || records.some((r) => r.type === "attributes")) seat();
      // (Before any batch is applied again: this observer was made first, so it is told first.)
      if ((C.found.size || C.sel) && records.some((r) => r.type === "childList")) {
        if (performance.now() - C.pathsAt > 50) readPaths();
        else C.pathsDirty = true;
      }
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
    card.querySelector(".kpop").replaceChildren(...CARD_KEYS.map(([k, v]) => {
      const row = document.createElement("div");
      row.className = "krow";
      const kk = document.createElement("span");
      kk.className = "kk";
      kk.append(keyNodes(k));
      const kv = document.createElement("span");
      kv.className = "kv";
      kv.textContent = v;
      row.append(kk, kv);
      return row;
    }));
    // Neither button takes the caret from the note: the words stay where they were being typed.
    for (const b of card.querySelectorAll(".kq, .csend")) b.addEventListener("mousedown", (e) => e.preventDefault());
    // ↵ as a button: the same as the key. The host admits a note after a real click as after Enter.
    card.querySelector(".csend").addEventListener("click", (e) => {
      submit(e.altKey);
      if (S.card) textarea.focus({ preventScroll: true });
    });
    chip.addEventListener("click", () => {
      setTemplate(null);
      draftChanged();
      textarea.focus({ preventScroll: true });
    });
    textarea.addEventListener("input", () => {
      setHint("");
      drawCardSend();
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
    busy: () => !!(S.card || S.pending || S.drag || hasDraft() || C.drag || C.edit || C.typeTimer || C.snap !== EMPTY || (C.on && C.sel) || MO.busy()),
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
          MO.resume();
          C.told = ""; // a new page, or a host that asks again: it hears the mode whatever it was
          tellMode();
          break;
        case "mode":
          hostMode(msg);
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
