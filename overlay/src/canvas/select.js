import { pick, rectOf } from "../page.js";
import { C, num } from "./state.js";
import { meta, stableSel } from "./stamps.js";
import { commit } from "./batch.js";
import { hush } from "./bar.js";
import { reveal, treeKids } from "./tree.js";
import { syncFields } from "./host.js";
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
  C.trail = C.deep = null; // (cvWalk and a mod+click say theirs again after this)
  if (el) reveal(el);
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
  // (in block flow, as they are seen: a reorder there is a shift, not a new order)
  if (fg) out.sort((a, b) => a.o - b.o || a.i - b.i);
  else out.sort((a, b) => a.r.y - b.r.y || a.i - b.i);
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
  if (g.resizable && el !== document.body && el !== document.documentElement) boxZones(g, el);
  return g;
}

export const SIDES = ["top", "right", "bottom", "left"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
/** A side with no padding or margin still has something to grab: a short bar in its middle,
 *  `off` px in from the border (padding: past the edge's own strip) or out from it (margin). */
const pillAt = (i, w, h, off) => {
  const L = 22, T = 6;
  if (i === 0) return { x: w / 2 - L / 2, y: off, w: L, h: T };
  if (i === 2) return { x: w / 2 - L / 2, y: h - off - T, w: L, h: T };
  if (i === 3) return { x: off, y: h / 2 - L / 2, w: T, h: L };
  return { x: w - off - T, y: h / 2 - L / 2, w: T, h: L };
};

/** The selection's own padding and margin, side by side, as bands to drag (relative to its
 *  corner, as the gaps are). A margin the browser works out (`auto`, which centres) is left
 *  alone: dragging it would write a number over the centring. So is a side where the parent's
 *  gap is: there the gap's band is what moves the neighbour. */
function boxZones(g, el) {
  const cs = getComputedStyle(el), w = g.r.w, h = g.r.h;
  const side = (k) => SIDES.map((s) => num(cs[k.replace("$", cap(s))]));
  const [bt, br, bb, bl] = side("border$Width"), pad = side("padding$"), mar = side("margin$");
  const [pt, pr, pb, pl] = pad;
  let map = null;
  try {
    map = el.computedStyleMap();
  } catch {}
  const gapAt = new Set();
  for (const z of g.zones) if (z.a === el) gapAt.add(z.axis === "x" ? 1 : 2);
  else if (z.b === el) gapAt.add(z.axis === "x" ? 3 : 0);
  const add = (box, i, value, rel, pill) =>
    g.zones.push({ t: "space", box, side: i, i: g.zones.length, el, axis: i % 2 ? "x" : "y", rel, pill, prop: `${box === "pad" ? "padding" : "margin"}-${SIDES[i]}`, value });
  // Padding, inside the border: top and bottom the full width, left and right what is between.
  const iw = Math.max(0, w - bl - br), ih = Math.max(0, h - bt - bb - pt - pb);
  const padRel = [{ x: bl, y: bt, w: iw, h: pt }, { x: w - br - pr, y: bt + pt, w: pr, h: ih }, { x: bl, y: h - bb - pb, w: iw, h: pb }, { x: bl, y: bt + pt, w: pl, h: ih }];
  const roomy = w >= 48 && h >= 32; // (on a small one the bars would cover what moves it)
  for (let i = 0; i < 4; i++)
    if (pad[i] > 0) padRel[i].w > 0 && padRel[i].h > 0 && add("pad", i, pad[i], padRel[i]);
    else if (roomy) add("pad", i, 0, pillAt(i, w, h, 5), true);
  const marRel = [{ x: 0, y: -mar[0], w, h: mar[0] }, { x: w, y: 0, w: mar[1], h }, { x: 0, y: h, w, h: mar[2] }, { x: -mar[3], y: 0, w: mar[3], h }];
  for (let i = 0; i < 4; i++) {
    let auto = false;
    try {
      auto = String(map && map.get(`margin-${SIDES[i]}`)) === "auto";
    } catch {}
    if (auto || gapAt.has(i) || mar[i] < 0) continue;
    if (mar[i] > 0) add("mar", i, mar[i], marRel[i]);
    else add("mar", i, 0, pillAt(i, w, h, -14), true);
  }
}

/** Where a padding or margin band is now (it moves as it is dragged), in the viewport. */
export function boxBand(z) {
  const r = rectOf(z.el), cs = getComputedStyle(z.el), s = cap(SIDES[z.side]);
  const v = num(cs[`${z.box === "pad" ? "padding" : "margin"}${s}`]);
  const b = SIDES.map((x) => num(cs[`border${cap(x)}Width`]));
  if (z.box === "mar")
    return [{ x: r.x, y: r.y - v, w: r.w, h: v }, { x: r.x + r.w, y: r.y, w: v, h: r.h }, { x: r.x, y: r.y + r.h, w: r.w, h: v }, { x: r.x - v, y: r.y, w: v, h: r.h }][z.side];
  // (left and right between the top and bottom ones, as boxZones has them)
  const pt = num(cs.paddingTop), pb = num(cs.paddingBottom);
  const iw = r.w - b[1] - b[3], ih = Math.max(0, r.h - b[0] - b[2] - pt - pb);
  return [{ x: r.x + b[3], y: r.y + b[0], w: iw, h: v }, { x: r.x + r.w - b[1] - v, y: r.y + b[0] + pt, w: v, h: ih },
    { x: r.x + b[3], y: r.y + r.h - b[2] - v, w: iw, h: v }, { x: r.x + b[3], y: r.y + b[0] + pt, w: v, h: ih }][z.side];
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
  handles.forEach((el, i) => (g.resizable ? at(el, (i % 2) * w - c / 2, /** @type {any} */ (i > 1) * h - c / 2, c, c) : gone(el)));
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
    const look = z.pill ? `gz pill ${z.box}` : "gz";
    if (zs[i].className !== look) zs[i].className = look;
    const cur = z.axis === "x" ? "col-resize" : "row-resize";
    if (zs[i]._c !== cur) zs[i].style.cursor = zs[i]._c = cur;
  });
}
const PAGE = { t: "page" };
/** What the pointer is on of the selection's: a handle, an edge, a band. A child laid over the
 *  padding (a badge in a corner) is the page's: { t: "page" }, a click there selects it. */
export const zoneOf = (e) => {
  const z = C.sel && e.composedPath()[0]._z;
  if (!z) return null;
  if (z.box === "pad") {
    const under = pick(e.clientX, e.clientY);
    if (under && under !== z.el && z.el.contains(under)) return PAGE;
  }
  return z;
};
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

/** Out to the parent, or in: to the child the way out came through, else to the first one there
 *  is to see (a line break is none). False when there is no further that way. */
export function cvWalk(up) {
  const from = C.sel, trail = C.trail;
  let next = from.parentElement;
  if (!up) {
    const inside = treeKids(from).filter((k) => !/^W?BR$/.test(k.tagName) && k.getClientRects().length);
    next = (trail && inside.find((k) => k.contains(trail))) || inside[0] || null;
  }
  if (!next || next === document.documentElement) return false;
  select(next);
  // The deepest element the way out started from: the way back in ends there.
  C.trail = up && !(trail && from.contains(trail)) ? from : trail;
  return true;
}

