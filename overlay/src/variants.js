import { S } from "./state.js";
import { icon, ICONS } from "./ui.js";
import { rectOf } from "./page.js";
import * as Notes from "./notes/api.js";
import { active, pool } from "./render.js";
import { domVersion, hostEl, variantsEl, variantStyle } from "./mount.js";

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
    const m = el && /** @type {any} */ (/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(el).backgroundColor));
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
  Notes.setTemplate(S.templates.some((t) => t.name === "keep") ? "keep" : null);
  Notes.textarea.value = `${S.template ? "" : "Keep "}variant ${o.k}${o.label ? ` (${o.label})` : ""} of ${g.id}${S.template ? "" : ", delete the others"}`;
  Notes.openCard();
}

function makeVariantBar() {
  const bar = /** @type {any} */ (document.createElement("div")); // (it carries its group, as _group)
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

export function drawVariants(capturing) {
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

