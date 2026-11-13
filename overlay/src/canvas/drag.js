import { DRAG_PX, mod } from "../state.js";
import { BOOST, editSel, line, pick, plainLabel, readView, rectOf, VP } from "../page.js";
import * as Notes from "../notes/api.js";
import { C, kids, MAX_CSS, num, px } from "./state.js";
import { entry, meta, stableSel, stamp } from "./stamps.js";
import { setDecl } from "./css.js";
import { applyAll, ordered } from "./apply.js";
import { commit } from "./batch.js";
import { between, cursorOf, flow, select, zoneOf } from "./select.js";
import { endEdit, startEdit } from "./text.js";
import { liveEnd, liveSet, shield } from "./cursor.js";
import { flash, hush, setPop } from "./bar.js";
import { T } from "./tree.js";
import { syncFields } from "./inspector.js";
import { block, isOurs } from "../input.js";
import { kick } from "../render.js";
import { root } from "../mount.js";

// ── drags ───────────────────────────────────────────────────────────────────────────────────
// pointermove only records where the pointer is. The frame does the work: it measures once when
// the drag starts (sizes, siblings), then each frame computes one value and writes one rule.
export function cvDown(e, z) {
  hush();
  if (C.pop) setPop(C.pop);
  const f = root.activeElement;
  if (f && f !== Notes.textarea) f.blur(); // a click on the page ends typing in the bar or the inspector
  if (C.edit) endEdit(true);
  // The click is kept from the page, so it does not bring the keyboard here by itself: Delete,
  // Enter and the arrows must work after a click in a frame that did not have the focus.
  if (!document.hasFocus()) window.focus();
  const x = e.clientX, y = e.clientY, r = C.r;
  const body = !z && r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  C.drag = { x0: x, y0: y, x, y, zone: z || (body ? { t: "body" } : null), mode: null, free: mod(e), sx: window.scrollX, sy: window.scrollY };
}

export function cvMove(e) {
  const d = C.drag;
  if (!d) {
    const z = zoneOf(e);
    const ours = !z && isOurs(e);
    if (ours && !C.over && C.hover) {
      C.hover = null;
      T.need = true;
    }
    C.over = ours;
    C.px = e.clientX;
    C.py = e.clientY;
    C.moved = true;
    C.zone = z;
    return;
  }
  block(e);
  d.x = e.clientX;
  d.y = e.clientY;
  d.free = mod(e);
  const far = Math.hypot(d.x - d.x0, d.y - d.y0);
  if (!d.mode && far > (d.zone && d.zone.t !== "body" ? 2 : DRAG_PX)) d.mode = "start";
  kick();
}

export function cvUp(e) {
  const d = C.drag;
  if (!d) return;
  block(e);
  C.drag = null;
  if (d.mode === "start") {
    // Released before a frame came: do the frame's part now, so a quick flick still counts.
    readView();
    startDrag(d);
    if (d.mode !== "none") stepDrag(d);
  }
  if (d.mode) return endDrag(d, true);
  if (d.zone && d.zone.t !== "body") return; // a click on a handle or a gap changes nothing
  const el = pick(d.x0, d.y0);
  const now = performance.now();
  const twice = C.last && el && el === C.sel && now - C.last.t < 400 && Math.hypot(d.x0 - C.last.x, d.y0 - C.last.y) < 5;
  C.last = twice ? null : { t: now, x: d.x0, y: d.y0 };
  if (twice) startEdit(el);
  else if (el !== C.sel) select(el);
}

export function cancelDrag() {
  const d = C.drag;
  C.drag = null;
  if (d && d.mode && d.mode !== "start") endDrag(d, false);
}

export function startDrag(d) {
  beginDrag(d);
  if (d.mode !== "none") shield(d.mode === "move" ? "grabbing" : cursorOf(d.zone)); // the cursor for the whole drag
}

function beginDrag(d) {
  const z = d.zone;
  d.mode = "none";
  if (z && z.t === "resize") return startResize(d, z);
  if (z && z.t === "space") {
    const cs = getComputedStyle(z.el);
    Object.assign(d, { mode: "space", el: z.el, sel: stableSel(z.el) + BOOST, v0: z.value, val: z.value,
      near: [...new Set(["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"].map((k) => num(cs[k])).filter(Boolean))] });
    return;
  }
  // A drag that starts on the selection moves the selection. One that starts elsewhere moves
  // what is under the pointer, or rather the nearest thing around it that can be reordered:
  // grabbing a card by its heading moves the card.
  let el = z ? C.sel : pick(d.x0, d.y0);
  if (!el) return;
  if (!z) {
    for (let a = el; a && a.parentElement && a !== document.body; a = a.parentElement)
      if (/flex|grid/.test(getComputedStyle(a.parentElement).display)) {
        el = a;
        break;
      }
    if (el !== C.sel) select(el);
  }
  startMove(d, el);
}

function startResize(d, z) {
  const el = C.sel, cs = getComputedStyle(el), P = el.parentElement, r0 = C.r || C.geo.r;
  const pcs = P ? getComputedStyle(P) : null;
  const dir = pcs && pcs.display.includes("flex") ? (pcs.flexDirection.startsWith("column") ? "y" : "x") : "";
  Object.assign(d, { mode: "resize", el, sel: C.selRs + BOOST, r0, w0: num(cs.width) || r0.w, h0: num(cs.height) || r0.h, kx: 1, ky: 1,
    // In a flex parent the main size is flex's to decide: say so in the same edit, or the drag does nothing.
    unflex: (dir === "x" && z.hx) || (dir === "y" && z.hy) ? cs.flexGrow !== "0" || cs.flexBasis !== "auto" : false,
    // Sizes of the siblings, to snap to: "as wide as the one next to it".
    peers: P ? flow(P).filter((it) => it.el !== el).slice(0, 40).map((it) => it.r) : [] });
  d.w = d.w0;
  d.h = d.h0;
  if (d.unflex) liveSet(d.sel, "flex", "none");
  // How far does the dragged edge move per pixel of size? A centred element grows both ways (½).
  const probe = (prop, v0, far, near) => {
    liveSet(d.sel, prop, px(v0 + 16));
    const r = rectOf(el);
    liveSet(d.sel, prop, px(v0));
    const moved = far ? r[near] + r[far] - (r0[near] + r0[far]) : r0[near] - r[near];
    return moved > 5 && moved < 11 ? 0.5 : 1;
  };
  if (z.hx) d.kx = probe("width", d.w0, z.hx > 0 ? "w" : "", "x");
  if (z.hy) d.ky = probe("height", d.h0, z.hy > 0 ? "h" : "", "y");
}

function startMove(d, el) {
  const P = el.parentElement;
  const cs = P && getComputedStyle(P);
  const layout = !cs ? "block" : cs.display.includes("flex") ? (cs.flexDirection.startsWith("column") ? "flex-column" : "flex-row") : cs.display.includes("grid") ? "grid" : "block";
  if (layout === "block") return flash("Reordering works inside flex and grid containers for now");
  const items = flow(P);
  const self = items.findIndex((it) => it.el === el);
  if (self < 0) return flash("This element is out of the flow: it can't be reordered");
  if (items.length < 2) return flash("Nothing here to reorder it with");
  const others = items.filter((_, i) => i !== self);
  // Insertion lines, one per place it can go, measured once. Side by side: vertical lines, per
  // row; stacked: horizontal lines.
  const row = items.some((b, i) => i && between(items[i - 1].r, b.r, b.r)?.axis === "x");
  const lines = [];
  if (row) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const top = Math.min(...run.map(([it]) => it.r.y)), bot = Math.max(...run.map(([it]) => it.r.y + it.r.h));
      run.forEach(([it, k], j) => {
        const prev = j ? run[j - 1][0].r : null;
        lines.push({ k, x: prev ? (prev.x + prev.w + it.r.x) / 2 : it.r.x - 5, y: top, w: 0, h: bot - top });
      });
      const [end, k] = run[run.length - 1];
      lines.push({ k: k + 1, x: end.r.x + end.r.w + 5, y: top, w: 0, h: bot - top });
      run = [];
    };
    others.forEach((it, k) => {
      if (run.length && it.r.y >= Math.max(...run.map(([o]) => o.r.y + o.r.h)) - 1) flush();
      run.push([it, k]);
    });
    flush();
  } else {
    const x1 = Math.min(...others.map((it) => it.r.x)), x2 = Math.max(...others.map((it) => it.r.x + it.r.w));
    others.forEach((it, k) => {
      const prev = k ? others[k - 1].r : null;
      lines.push({ k, x: x1, y: prev ? (prev.y + prev.h + it.r.y) / 2 : it.r.y - 5, w: x2 - x1, h: 0 });
    });
    const end = others[others.length - 1].r;
    lines.push({ k: others.length, x: x1, y: end.y + end.h + 5, w: x2 - x1, h: 0 });
  }
  Object.assign(d, { mode: "move", el, P, pr: rectOf(P), layout, others, self, lines, r0: items[self].r, k: self, at: null });
  liveSet(C.selRs, "opacity", "0.35");
}

export function stepDrag(d) {
  const dx = d.x - d.x0 + VP.sx - d.sx, dy = d.y - d.y0 + VP.sy - d.sy;
  const key = `${dx}|${dy}|${d.free}`;
  if (key === d.key) return;
  d.key = key;
  d.snapped = false;
  // Whole pixels always; to a sibling's size or a spacing used nearby when within 3px, else to 4.
  const snap = (v, near) => {
    if (d.free) return Math.max(0, Math.round(v));
    for (const c of near)
      if (Math.abs(v - c) <= 3) {
        d.snapped = true;
        return Math.max(0, Math.round(c));
      }
    return Math.max(0, Math.round(v / 4) * 4);
  };
  const n = (v) => String(Math.round(v));
  if (d.mode === "resize") {
    const z = d.zone;
    if (z.hx) liveSet(d.sel, "width", px((d.w = snap(d.w0 + (z.hx * dx) / d.kx, d.peers.map((r) => d.w0 + r.w - d.r0.w)))));
    if (z.hy) liveSet(d.sel, "height", px((d.h = snap(d.h0 + (z.hy * dy) / d.ky, d.peers.map((r) => d.h0 + r.h - d.r0.h)))));
    d.label = z.hx && z.hy ? `${n(d.w0)} × ${n(d.h0)} → ${n(d.w)} × ${n(d.h)}` : z.hx ? `width ${n(d.w0)} → ${n(d.w)}` : `height ${n(d.h0)} → ${n(d.h)}`;
  } else if (d.mode === "space") {
    const z = d.zone;
    d.val = snap(d.v0 + (z.axis === "x" ? dx : dy), d.near);
    liveSet(d.sel, z.prop, px(d.val));
    d.label = `${z.prop} ${n(d.v0)} → ${n(d.val)}`;
  } else if (d.mode === "move") {
    // The nearest insertion line, in the coordinates the lines were measured in.
    const x = d.x + VP.sx - d.sx, y = d.y + VP.sy - d.sy;
    let best = null, bd = Infinity;
    for (const l of d.lines) {
      const cx = Math.min(Math.max(x, l.x), l.x + l.w), cy = Math.min(Math.max(y, l.y), l.y + l.h);
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < bd) {
        bd = dist;
        best = l;
      }
    }
    d.k = best.k;
    d.at = best.k === d.self ? null : best;
    d.label = d.at ? `${d.self + 1} → ${d.k + 1}` : "";
  }
}

function endDrag(d, keep) {
  liveEnd();
  shield(null);
  C.geoKey = "";
  if (!keep || d.mode === "none") return applyAll();
  if (d.mode === "move") {
    if (d.at) commitMove(d.el, d.P, d.others[d.k] ? d.others[d.k].el : null, d.layout);
    return;
  }
  const e = entry(d.el);
  let css = e.css;
  if (d.mode === "space") {
    if (d.val !== d.v0) css = setDecl(css, d.zone.prop, px(d.val));
  } else {
    const w = d.zone.hx && px(d.w) !== px(d.w0), h = d.zone.hy && px(d.h) !== px(d.h0);
    if ((w || h) && d.unflex) css = setDecl(css, "flex", "none");
    if (w) css = setDecl(css, "width", px(d.w));
    if (h) css = setDecl(css, "height", px(d.h));
  }
  const full = css.length > MAX_CSS;
  if (!full) e.css = css;
  commit();
  syncFields(true);
  if (full) flash("This element's styles are full: shorten them first");
}

function commitMove(el, P, beforeEl, layout) {
  const prs = stamp(P), B = C.draft.B;
  const prior = [...C.sent.filter((b) => !C.hide.has(b.id)), C.draft].flatMap((b) => b.B.ops.filter((o) => o.kind === "move" && o.parent.rs === prs));
  const from = ordered(kids(P), prior).indexOf(el);
  const side = (x) => ({ selector: editSel(x), rs: stamp(x), label: line(plainLabel(x)) });
  const op = { kind: "move", ...meta(el), parent: { ...side(P), layout }, before: beforeEl ? side(beforeEl) : null, fromIndex: from, toIndex: from };
  op.toIndex = ordered(kids(P), [...prior, op]).indexOf(el);
  const last = B.ops[B.ops.length - 1];
  if (last && last.kind === "move" && last.rs === op.rs) {
    // Dragged again: still one move, from where it first was.
    op.fromIndex = last.fromIndex;
    B.ops.pop();
  }
  if (op.toIndex !== op.fromIndex) B.ops.push(op);
  commit();
}

