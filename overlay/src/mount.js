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

const STYLES = include("styles.css");

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
