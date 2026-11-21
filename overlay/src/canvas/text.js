import { line } from "../page.js";
import { C } from "./state.js";
import { meta } from "./stamps.js";
import { runsOf, runText } from "./apply.js";
import { commit } from "./batch.js";
import { editCursor } from "./cursor.js";
import { drawBar, flash } from "./bar.js";
import { kick } from "../render.js";

// ── text, edited in place ───────────────────────────────────────────────────────────────────
// The element itself becomes editable for the moment (plain text only), so the words wrap and
// look exactly as they will. What is inside it (an image, a link, a line break) is not editable
// and stays where it is: the words around it are what is typed, each run of them an edit of its
// own (apply.js, runsOf). The attributes go the moment editing ends, whichever way it ends.
export const inEdit = (e) => e.composedPath().includes(C.edit.el);
const words = (run) => !!runText(run).trim();
/** The element has words of its own (not only its children's). */
export const hasWords = (el) => runsOf(el).some(words);

/** What is in an element now, to put back exactly: its nodes, and the words of the text ones. */
const snap = (el) => {
  const nodes = [...el.childNodes];
  return { nodes, data: nodes.map((n) => (n.nodeType === 3 ? n.data : null)) };
};
/** …and back, node for node: a node the browser's editing threw away is put back, what it made
 *  (text, the line break of an emptied line) is taken out; those that stayed are not touched, so
 *  nothing inside loads again. `by`: what the editing made and threw away since the snapshot
 *  (checkEdit keeps count); without it nothing but the editing was at the element since (one
 *  step back). What the page itself did meanwhile is the page's: a node it took out is not put
 *  back (to a framework it would be one nobody ever removes), one it added stays. */
function putBack(el, was, by) {
  const own = new Set(was.nodes);
  for (const n of [...el.childNodes]) if (by ? by.made.has(n) : !own.has(n)) n.remove();
  let ref = el.firstChild;
  for (const n of was.nodes) {
    while (ref && !own.has(ref)) ref = ref.nextSibling;
    if (n === ref) ref = ref.nextSibling;
    else if (n.parentNode === el) ref = n.nextSibling; // (moved by the page: its place is the page's)
    else if (!by || by.gone.has(n)) el.insertBefore(n, ref);
  }
  was.nodes.forEach((n, i) => was.data[i] !== null && n.parentNode === el && n.data !== was.data[i] && (n.data = was.data[i]));
}

/** `at`: where it was double-clicked, { x, y }: the words there are the ones selected. */
export function startEdit(el, at) {
  const runs = runsOf(el);
  if (!runs.some(words)) return void flash(el.childElementCount ? "Double-click the words themselves: this has no words of its own" : "No text here to edit");
  if (C.typeTimer) commit();
  const ed = {
    el, meta: meta(el), had: el.getAttribute("contenteditable"), onBlur: () => endEdit(true),
    was: snap(el), // (and `step`: the same before the last thing typed, see guardEdit)
    made: new Set(), gone: new Set(), // the nodes the typing made and threw away since (checkEdit)
    from: runs.map(runText),
    els: runs.slice(0, -1).map((r) => r.end), // the elements between the runs
    kids: [...el.children],
  };
  ed.locks = ed.kids.map((c) => c.getAttribute("contenteditable"));
  C.edit = ed;
  for (const c of ed.kids) c.setAttribute("contenteditable", "false");
  el.setAttribute("contenteditable", "plaintext-only");
  el.focus({ preventScroll: true });
  // All of it is selected, to type over. With elements inside, one run of words: the one that was
  // double-clicked, else the first (typing over all of it would take the elements with it).
  const range = document.createRange();
  range.selectNodeContents(el);
  if (ed.els.length) {
    const span = (r) => {
      range.setStart(r.nodes[0], 0);
      range.setEnd(r.nodes[r.nodes.length - 1], r.nodes[r.nodes.length - 1].length);
      return range;
    };
    const full = runs.filter(words);
    const hit = at && full.find((r) => [...span(r).getClientRects()].some((q) => at.x >= q.left && at.x <= q.right && at.y >= q.top && at.y <= q.bottom));
    span(hit || full[0]);
  }
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
  el.addEventListener("blur", ed.onBlur);
  editCursor(ed.meta.rs);
  drawBar();
  kick();
}

// The browser deletes an element inside as it does a letter (Backspace after an image), or with
// the words selected around it. Here only words are edited, so that is not done: refused before
// it happens where the browser says what it is about to change, and where it does not (Chrome
// names no range when it is an element it deletes) taken back the moment after. mount.js tells
// both: it sees the events first.
const STAYS = "Only the words are edited here: what is inside stays. Select it and press Delete to hide it";
export function guardEdit(e) {
  const ed = C.edit;
  if (!ed) return;
  ed.step = null;
  const r = document.createRange();
  for (const t of e.cancelable && ed.kids.length ? e.getTargetRanges() : []) {
    r.setStart(t.startContainer, t.startOffset);
    r.setEnd(t.endContainer, t.endOffset);
    if (!ed.kids.some((c) => r.intersectsNode(c))) continue;
    e.preventDefault();
    return void flash(STAYS);
  }
  // As it is before this step (between here and the "input" only the browser is at it): what
  // the step may not take, and what it made and threw away is read against this.
  const s = getSelection();
  ed.step = { ...snap(ed.el), kids: ed.kids.filter((c) => c.parentNode === ed.el), node: s.focusNode, at: s.focusOffset };
}
export function checkEdit() {
  const ed = C.edit, step = ed && ed.step;
  if (!step) return;
  ed.step = null;
  const el = ed.el;
  // (Only an element this step took: one the page itself removed meanwhile is none of ours.)
  if (step.kids.some((c) => c.parentNode !== el)) {
    putBack(el, step);
    if (step.node && step.node.isConnected) getSelection().collapse(step.node, step.at);
    return void flash(STAYS);
  }
  const before = new Set(step.nodes);
  for (let n = el.firstChild; n; n = n.nextSibling) if (!before.has(n)) ed.made.add(n);
  for (const n of step.nodes) if (n.parentNode !== el) ed.gone.add(n);
}

/** The words of each run as they are now, by the elements that were there when the edit began
 *  (what the browser put in since, a line break in an emptied line, parts nothing). Null when
 *  one of them is gone or out of its place: the page built what is inside anew meanwhile (the
 *  typing cannot take one: checkEdit), and which words are which run is not known any more. */
function typedRuns(ed) {
  const out = [""];
  let k = 0;
  for (let n = ed.el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) out[k] += n.data;
    else if (n === ed.els[k]) out[++k] = "";
    else if (ed.els.includes(n)) return null;
  }
  return k === ed.els.length ? out : null;
}

export function endEdit(keep) {
  const ed = C.edit;
  if (!ed) return;
  C.edit = null;
  const el = ed.el;
  el.removeEventListener("blur", ed.onBlur);
  const typed = keep && el.isConnected ? typedRuns(ed) : null;
  if (ed.had === null) el.removeAttribute("contenteditable");
  else el.setAttribute("contenteditable", ed.had);
  ed.kids.forEach((c, i) => (ed.locks[i] === null ? c.removeAttribute("contenteditable") : c.setAttribute("contenteditable", ed.locks[i])));
  if (el.isConnected) {
    // Back to exactly what it was; if the edit is kept, applyAll writes the new words (and
    // remembers the old ones) like any other edit.
    putBack(el, ed.was, ed);
    if (document.activeElement === el) el.blur();
    getSelection()?.removeAllRanges();
  }
  const ops = C.draft.B.ops;
  (typed || []).forEach((raw, i) => {
    const from = ed.from[i], now = line(raw);
    // (A plain element is not emptied here: it is hidden with Delete. Words beside elements may go.)
    if (now === line(from) || (!now && !ed.els.length)) return;
    // The white space around the words stays as the page has it; in a run that had no words,
    // as it was typed.
    const pad = /^(\s*)[\s\S]*?(\s*)$/.exec(from);
    const to = line(from) ? pad[1] + now + pad[2] : raw.replace(/\s+/g, " ");
    const old = ops.find((o) => o.kind === "text" && o.rs === ed.meta.rs && (o.run || 0) === i);
    const op = { kind: "text", ...ed.meta, from: old ? old.from : from, to, ...(i ? { run: i } : {}) };
    if (old) ops.splice(ops.indexOf(old), 1);
    if (op.to !== op.from) ops.push(op);
  });
  editCursor(null);
  C.geoKey = "";
  commit();
  drawBar();
  if (keep && el.isConnected && !typed) flash("The page changed what is inside it while it was edited: the words were not kept");
}
