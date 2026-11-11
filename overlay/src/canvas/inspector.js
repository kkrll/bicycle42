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

