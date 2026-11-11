// Motion mode, the mode and what is drawn: switched on and off, the dock drawn from the data,
// and every frame the playhead, the time and the outlines on the page.

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
