// ── applying the batches ────────────────────────────────────────────────────────────────────
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

