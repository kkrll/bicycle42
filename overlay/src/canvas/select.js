import { rectOf } from "../page.js";
import { C, num } from "./state.js";
import { meta, stableSel } from "./stamps.js";
import { commit } from "./batch.js";
import { hush } from "./bar.js";
import { reveal, T, treeKids } from "./tree.js";
import { syncFields } from "./inspector.js";
import { gone } from "./frame.js";
import { edges, gzEl, handles } from "./mount.js";
import { kick, pool } from "../render.js";
import { hostEl } from "../mount.js";

// ── selection and its geometry ──────────────────────────────────────────────────────────────
export function select(el) {
  if (C.typeTimer) commit();
  hush();
  C.sel = el || null;
  C.selRs = el ? stableSel(el) : "";
  C.geo = null;
  C.geoKey = "";
  C.zone = null;
  if (el) reveal(el);
  T.need = true;
  syncFields(true);
  kick();
}

/** The children of P that take part in its layout, in the order they are laid out. */
export function flow(P) {
  const fg = /flex|grid/.test(getComputedStyle(P).display);
  const out = [];
  for (let i = 0; i < P.children.length && out.length < 200; i++) {
    const el = P.children[i];
    if (el === hostEl) continue;
    const r = rectOf(el);
    if (r.w <= 0 || r.h <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    out.push({ el, r, o: fg ? Number(cs.order) || 0 : 0, i });
  }
  if (fg) out.sort((a, b) => a.o - b.o || a.i - b.i);
  return out;
}

/** The empty band between two neighbours: side by side, or one under the other. */
export function between(a, b, pr) {
  const top = Math.max(a.y, b.y), bot = Math.min(a.y + a.h, b.y + b.h);
  if (b.x >= a.x + a.w - 0.5 && bot > top) return { axis: "x", rect: { x: a.x + a.w, y: top, w: Math.max(0, b.x - a.x - a.w), h: bot - top } };
  if (b.y < a.y + a.h - 0.5) return null;
  const wrap = b.x + b.w <= a.x + 0.5; // the next row of a wrapping row or a grid: the band spans the parent
  const x1 = wrap ? pr.x : Math.min(a.x, b.x), x2 = wrap ? pr.x + pr.w : Math.max(a.x + a.w, b.x + b.w);
  return { axis: "y", rect: { x: x1, y: a.y + a.h, w: x2 - x1, h: Math.max(0, b.y - a.y - a.h) } };
}

function gapZones(g, P, only) {
  const cs = getComputedStyle(P);
  if (!/flex|grid/.test(cs.display)) return;
  const items = flow(P);
  const cg = num(cs.columnGap), rg = num(cs.rowGap), pr = rectOf(P);
  for (let i = 1; i < items.length && g.zones.length < 120; i++) {
    const a = items[i - 1], b = items[i];
    if (only && a.el !== only && b.el !== only) continue;
    const bw = between(a.r, b.r, pr);
    if (!bw) continue;
    const q2 = bw.rect;
    // `rel` is the band relative to the selection's corner: scrolling moves both together.
    g.zones.push({ t: "space", i: g.zones.length, el: P, a: a.el, b: b.el, axis: bw.axis,
      rel: { x: q2.x - g.r.x, y: q2.y - g.r.y, w: q2.w, h: q2.h },
      prop: cg === rg ? "gap" : bw.axis === "x" ? "column-gap" : "row-gap", value: bw.axis === "x" ? cg : rg });
  }
}

export function buildGeo(el, r) {
  const d = getComputedStyle(el).display;
  const g = { el, r, resizable: d !== "inline" && d !== "contents" && r.w > 0 && r.h > 0, zones: [] };
  const P = el.parentElement;
  if (P && P !== document.documentElement) gapZones(g, P, el);
  if (el.childElementCount > 1) gapZones(g, el, null);
  return g;
}

/** Lay out what the pointer can grab around the selection: corners, edges, the gaps. They are
 *  the layer's own elements (so the cursor is theirs, and "what is under the pointer" is the
 *  event's target), placed relative to the selection's corner; the frame moves them as one. */
export function layoutHit(g, r) {
  const w = r.w, h = r.h;
  const at = (el, x, y, ww, hh) => {
    const k = `${x}|${y}|${ww}|${hh}`;
    if (el._k === k) return;
    el._k = k;
    el.hidden = false;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${ww}px`;
    el.style.height = `${hh}px`;
  };
  // Corners: 16px to hit (less on a small element), an 8px square to see. Edges: the strip
  // between the corners, 6px outside the border and 3px inside, so the body stays draggable.
  const c = Math.max(8, Math.min(16, w / 2, h / 2));
  handles.forEach((el, i) => (g.resizable ? at(el, (i % 2) * w - c / 2, (i > 1) * h - c / 2, c, c) : gone(el)));
  const ex = w - c, ey = h - c;
  [[c / 2, -6, ex, 9], [w - 3, c / 2, 9, ey], [c / 2, h - 3, ex, 9], [-6, c / 2, 9, ey]].forEach(([x, y, ww, hh], i) =>
    g.resizable && ww > 0 && hh > 0 ? at(edges[i], x, y, ww, hh) : gone(edges[i]));
  if (g.laid) return; // the gaps are laid out once per geometry; a resize drag only moves the handles
  g.laid = true;
  const zs = pool(gzEl, g.zones.length, () => {
    const el = document.createElement("div");
    el.className = "gz";
    return el;
  });
  g.zones.forEach((z, i) => {
    const q2 = z.rel;
    const px2 = z.axis === "x" ? Math.max(0, (8 - q2.w) / 2) : 0, py2 = z.axis === "y" ? Math.max(0, (8 - q2.h) / 2) : 0;
    zs[i]._k = "";
    at(zs[i], q2.x - px2, q2.y - py2, q2.w + 2 * px2, q2.h + 2 * py2);
    zs[i]._z = z;
    const cur = z.axis === "x" ? "col-resize" : "row-resize";
    if (zs[i]._c !== cur) zs[i].style.cursor = zs[i]._c = cur;
  });
}
export const zoneOf = (e) => (C.sel && e.composedPath()[0]._z) || null;
export const cursorOf = (z) =>
  !z || z.t === "body" ? "default"
  : z.t === "space" ? (z.axis === "x" ? "col-resize" : "row-resize")
  : z.hx && z.hy ? (z.hx === z.hy ? "nwse-resize" : "nesw-resize")
  : z.hx ? "ew-resize" : "ns-resize";

export function hideSel() {
  const el = C.sel;
  const m = meta(el);
  select(null);
  if (!C.draft.B.ops.some((o) => o.kind === "hide" && o.rs === m.rs)) C.draft.B.ops.push({ kind: "hide", ...m });
  commit();
}

export function cvWalk(up) {
  let next = up ? C.sel.parentElement : treeKids(C.sel).find((k) => k.getClientRects().length) || null;
  if (next === document.documentElement) next = null;
  if (next) select(next);
}

