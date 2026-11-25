// Motion mode, triggers: what switches a transition, as the reviewer names it. The page's rules
// say many of them (states.js); what a script does (a class it adds, an attribute it sets) may be
// on an element no rule was found for, or the reviewer knows better. A trigger is a class
// (`.open`), an attribute (`[data-state=open]`) or a state (`:hover`), on the element or on one of
// its parents.
//
// A class or an attribute is put on for real while its state is played: what the page's own rules
// make of it, on this element and on everything else, is what is seen. It is worn only while the
// state is on (apply() in model.js asks wear() each time), so whatever switches the state off takes
// it off. One the element has already is taken off instead: the state is then being without it.
// A state of the pointer or the keyboard can't be put on: its rules are found by writing the
// element where the state stands in their selectors, and their declarations are applied, as those
// of a state that was found are.
//
// Triggers are plain data, by the element's path (M.trig): undo and the draft keep them.

import { editSel } from "../page.js";
import { M, mq, name, pathOf, splitTop } from "./model.js";
import { STATE } from "./states.js";

/** How many one element may have. */
const MAX_TRIGGERS = 6;
/** Attributes that are not a state: what they say is run, loaded, or the layer's to leave alone. */
const NOT_A_STATE = /^(on.*|style|class|id|name|src|srcset|srcdoc|href|xlink:href|action|formaction|data|ping|content|http-equiv|data-b42.*)$/;
export const stateful = (attr) => /^[a-z_][\w:.-]{0,60}$/i.test(attr) && !NOT_A_STATE.test(attr.toLowerCase());

/** What was typed, as { kind, name, value?, alt? }, or why it is not a trigger. */
export function parseTrigger(text) {
  const t = String(text).trim();
  if (t.length > 120 || /[\u0000-\u001f\u007f]/.test(t)) return "Too long for a trigger";
  let m = /^\.((?:\\.|[^\s.\\[\]#>+~,:"'(){}])+)$/.exec(t);
  if (m) return { kind: "class", name: m[1].replace(/\\(.)/g, "$1") };
  m = /^\[\s*([^\s=\]"'~|^$*]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']*))\s*)?\]$/.exec(t);
  if (m) {
    if (!stateful(m[1])) return `${m[1]} is not a state: a class, a data- or an aria- attribute is`;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    return { kind: "attr", name: m[1], value, alt: OTHER[value] ?? null };
  }
  m = /^:([\w-]+)$/.exec(t);
  if (m && STATE.test(t)) return { kind: "state", name: m[1] };
  return m ? `:${m[1]} is not a state known here` : "A trigger is .class, [attribute=value] or :state";
}
/** What an attribute that has the value already is switched to: the word's opposite, where it has one. */
const OTHER = { true: "false", false: "true", open: "closed", closed: "open", on: "off", off: "on", active: "inactive", inactive: "active", checked: "unchecked", unchecked: "checked" };

/** The trigger in words, without where it is. */
const said = (t) => (t.kind === "class" ? `.${t.name}` : t.kind === "state" ? `:${t.name}` : t.kind === "style" ? "style" : t.value ? `[${t.name}=${t.value}]` : `[${t.name}]`);
const short = (s) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
/** An element as the code has it: "section.hero". */
const tagOf = (el) => {
  const c = (el.getAttribute("class") || "").trim().split(/\s+/)[0];
  return short(`${el.localName}${el.id ? `#${el.id}` : c ? `.${c}` : ""}`);
};
/** The elements a trigger may be on instead of the open one, nearest first: a few of its parents,
 *  then the body and the root (where a page often keeps what is open). */
export function above(el) {
  const out = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const top = p === document.body || p === document.documentElement;
    if (out.length < 5 || top) out.push({ path: pathOf(p), text: top ? p.localName : name(p, true), aside: tagOf(p) });
  }
  return out;
}
/** Where the trigger is, as the note says it: so that the agent finds the element. */
export const triggerWords = (t, off) => {
  const at = t.on ? mq(t.on) : null;
  return `${said(t)}${t.on ? ` on ${at ? editSel(at) : "a parent"}` : ""}${off ? " taken off" : ""}`;
};

// ── the states made of them ──────────────────────────────────────────────────────────────
/** The triggers named for the element at `rs`, as states beside those found: [{ label, css,
 *  props, trigger }]. A class or an attribute has no declarations of its own (it is put on), and
 *  its properties are read once it is (setState). */
export function namedStates(el, rs, moves, rules) {
  const out = [];
  for (const t of M.trig.get(rs) || []) {
    const st = { label: t.label, css: "", props: /** @type {string[]} */ ([]), trigger: t };
    if (t.kind === "state") {
      const at = t.on ? mq(t.on) : el;
      if (at) Object.assign(st, inState(el, at, t.name, moves, rules));
    }
    out.push(st);
  }
  return out;
}
/** What the page's rules say of `el` while `at` is in a state: each rule whose selector matches
 *  with `at` written where the state stands. (What is hovered, pressed or focused within is its
 *  parents too.) */
function inState(el, at, word, moves, rules) {
  const path = pathOf(at), is = /^(hover|active|focus-within)$/.test(word) ? `:is(${path}, :has(:is(${path})))` : `:is(${path})`;
  const has = new RegExp(`:${word}(?![\\w-])`, "g");
  let css = "";
  const props = [];
  for (const [sel, style] of rules) {
    let any = false;
    for (let i = 0; i < style.length && !any; i++) any = moves(style[i]);
    if (!any) continue;
    for (const one of splitTop(sel)) {
      const then = one.replace(has, is);
      try {
        if (then === one || el.matches(one) || !el.matches(then)) continue;
      } catch {
        continue;
      }
      css += `${style.cssText} `;
      for (let i = 0; i < style.length; i++) if (!props.includes(style[i])) props.push(style[i]);
      break;
    }
  }
  return { css: css.trim(), props };
}
/** It is put on the page, not applied as a rule. */
export const wears = (t) => !!t && (t.kind === "class" || t.kind === "attr");
/** Puts the trigger on `at` (or takes it off, when it is on already); gives back what undoes it. */
export function put(t, at) {
  if (t.kind === "class") {
    const was = at.getAttribute("class"), had = at.classList.contains(t.name);
    at.classList.toggle(t.name, !had);
    return () => {
      at.classList.toggle(t.name, had);
      if (was === null && !at.getAttribute("class")) at.removeAttribute("class");
    };
  }
  const was = at.getAttribute(t.name), next = was === t.value ? t.alt : t.value;
  const set = (v) => (v === null || v === undefined ? at.removeAttribute(t.name) : at.setAttribute(t.name, v));
  set(next);
  return () => {
    // (Not when the page has set it to something else meanwhile: that is the page's.)
    if (at.getAttribute(t.name) === (next ?? null)) set(was);
  };
}
/** It is on now, as the page has it: playing the state takes it off. */
export const isOn = (t, at) => (t.kind === "class" ? at.classList.contains(t.name) : t.kind === "attr" && at.getAttribute(t.name) === t.value);
/** The open state's trigger is on the page while the state is on, and only then (see apply). */
export function wear() {
  const st = M.on && M.open && M.open.kind === "transition" && M.ro && M.ro.on ? M.ro.state : null;
  const t = st && wears(st.trigger) ? st.trigger : null;
  if (M.worn && (M.worn.t !== t || !M.worn.at.isConnected)) {
    M.worn.undo();
    M.worn = null;
  }
  if (!t || M.worn) return;
  const at = mq(t.on || M.open.rs);
  if (at) M.worn = { t, at, undo: put(t, at) };
}

// ── naming one ───────────────────────────────────────────────────────────────────────────
/** A trigger put into the element's list: what it is called there. One that is there already is
 *  that one; "" when there are too many. */
export function keep(rs, t) {
  const list = M.trig.get(rs) || [];
  const same = list.find((x) => x.on === t.on && x.kind === t.kind && x.name === t.name && (x.value === t.value || (x.by === "recorded" && t.by === "recorded")));
  if (same) return same.label;
  if (list.length >= MAX_TRIGGERS) return "";
  const at = t.on ? mq(t.on) : null, base = `${short(said(t))}${t.on ? ` on ${at ? tagOf(at) : "a parent"}` : ""}`;
  let label = base;
  for (let n = 2; list.some((x) => x.label === label); n++) label = `${base} ${n}`;
  M.trig.set(rs, [...list, { ...t, label }]);
  return label;
}
export function drop(rs, label) {
  const list = M.trig.get(rs) || [], rest = list.filter((x) => x.label !== label);
  if (rest.length === list.length) return false;
  if (rest.length) M.trig.set(rs, rest);
  else M.trig.delete(rs);
  return true;
}
/** From the draft the host kept: one that can be used as it is. */
export const usable = (t) => !!t && typeof t === "object" && typeof t.label === "string" && typeof t.name === "string" && typeof t.on === "string"
  && (t.kind === "class" ? !!t.name && !/\s/.test(t.name) : t.kind === "attr" ? stateful(t.name) && typeof t.value === "string" : t.kind === "state" && STATE.test(`:${t.name}`));
