// ── the bar ─────────────────────────────────────────────────────────────────────────────────
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

