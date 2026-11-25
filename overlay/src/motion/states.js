// Motion mode, the states of an element: what the page's CSS says would change it. A transition
// has no keyframes, only the two looks it goes between, and the second is a rule that does not
// apply now: on hover, with a class a script adds (`.drawer.open`), with an attribute
// (`[data-state="open"]`), when a parent is hovered (`.group:hover .label`). Such a rule is found
// by taking one piece out of its selector: when what is left matches the element, that piece is
// the state. Nothing is switched on to find one, and what a script does without a rule (a style
// written by hand) is not found.

import { splitTop } from "./model.js";

const STATE = /:(hover|focus-visible|focus-within|focus|active|checked|disabled|target|open|popover-open)(?![\w-])/;
// A selector in pieces: a class, an id, an attribute, a pseudo (with what is in its brackets),
// what joins two elements, a tag.
const PIECE = /\.(?:\\.|[\w-])+|#(?:\\.|[\w-])+|\[[^\]]*\]|::?[\w-]+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?|\s*[>+~]\s*|\s+|(?:\\.|[\w-])+|\*|&/g;
const joins = (t) => /^\s*[>+~]?\s*$/.test(t);
const MAX_STATES = 8;

/** Every style rule of the page that applies in this window, as [selector, declarations]: a
 *  rule written inside another has its whole selector, one inside a media query that does not
 *  hold is left out. In the page's order, so a later one wins as it does on the page. */
export function styleRules() {
  const out = [];
  const nest = (sel, parent) => splitTop(sel).map((s) => (s.includes("&") ? s.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${s}`)).join(", ");
  const walk = (list, parent) => {
    for (const r of list) {
      if (r instanceof CSSKeyframesRule || /StartingStyle|FontFace|Page|Property/.test(r.constructor.name)) continue;
      if (typeof r.selectorText === "string" && r.style) {
        const sel = parent ? nest(r.selectorText, parent) : r.selectorText;
        out.push([sel, r.style]);
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, sel);
      } else if (r.style && parent && !r.cssRules) out.push([parent, r.style]); // declarations of the rule it is in, after a rule nested there
      else if (r.cssRules) {
        try {
          if (r.media && r.media.mediaText && !matchMedia(r.media.mediaText).matches) continue;
        } catch {}
        walk(r.cssRules, parent);
      }
    }
  };
  for (const s of document.styleSheets) {
    try {
      walk(s.cssRules, "");
    } catch {} // another origin's stylesheet
  }
  return out;
}

/** The states of `el` that change something `moves` says it animates: [{ label, css, props }],
 *  those of the pointer and the keyboard first, then attributes, then classes. `css` is the
 *  declarations of every rule of that state, `props` the properties they set. */
export function statesOf(el, moves, rules) {
  const found = new Map();
  for (const [sel, style] of rules) {
    let any = false;
    for (let i = 0; i < style.length && !any; i++) any = moves(style[i]);
    if (!any) continue;
    for (const one of splitTop(sel)) {
      let is;
      try {
        is = el.matches(one);
      } catch {
        continue; // (a pseudo-element's rule, or a selector this browser does not read)
      }
      if (is) continue; // it applies now: it is how the element looks, not a state it could be in
      const ps = one.match(PIECE) || [];
      for (let i = 0; i < ps.length; i++) {
        const t = ps[i], kind = t[0] === ":" && t[1] !== ":" && STATE.test(t) ? 0 : t[0] === "[" ? 1 : t[0] === "." ? 2 : -1;
        if (kind < 0) continue;
        // (What is left of its element must still name something: `.open` alone is no state of anything.)
        const before = i > 0 && !joins(ps[i - 1]), after = i < ps.length - 1 && !joins(ps[i + 1]) && !ps[i + 1].startsWith("::");
        if (!before && !after) continue;
        try {
          if (!el.matches(ps.slice(0, i).concat(ps.slice(i + 1)).join(""))) continue;
        } catch {
          continue;
        }
        const above = ps.slice(i + 1).some(joins) || (kind === 0 && /[\s>+~]/.test(t.replace(/^:[\w-]+\(|\)$/g, "").trim()));
        const word = kind === 0 ? STATE.exec(t)[1] : t.length > 32 ? `${t.slice(0, 31)}…` : t;
        const label = `${word}${above ? " on a parent" : ""}`;
        const st = found.get(label) || found.set(label, { label, kind, css: "", props: [] }).get(label);
        st.css += `${style.cssText} `;
        for (let j = 0; j < style.length; j++) if (!st.props.includes(style[j])) st.props.push(style[j]);
        break; // one piece taken out of a selector is enough to call it a state
      }
    }
  }
  return [...found.values()].sort((a, b) => a.kind - b.kind).slice(0, MAX_STATES).map(({ label, css, props }) => ({ label, css: css.trim(), props }));
}
