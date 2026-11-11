// ── mount ───────────────────────────────────────────────────────────────────────────────────
// Its part of the layer: the grab elements around the selection, the inspector, the bar and
// the "?" in the corner. mount.js puts it in its place among the rest; mountCanvas finds them.
const HTML = `<div class="cv" hidden><div class="band" hidden></div>
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
    <div class="corner" hidden><div class="pop" hidden></div><button type="button" class="help" title="Keys and gestures" aria-label="Keys and gestures">${icon("help")}</button></div>`;

let corner, bar, insp, cv, cnote, treeEl, trows, tspace, clsEl, cssEl, freeEl, compEl, ipath, bandEl, ghostEl, insEl, labEl, dimEl, handles, edges, hitEl, gzEl, shieldEl;

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
  bar.querySelector(".count").addEventListener("click", () => (C.on ? setPop("list") : setMode("canvas")));
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

