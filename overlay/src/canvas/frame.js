// ── canvas: one frame ───────────────────────────────────────────────────────────────────────
const place = (el, x, y, w, h, cls) => {
  const k = `${x}|${y}|${w}|${h}|${cls}`;
  if (el._k === k) return;
  el._k = k;
  el.hidden = false;
  el.style.transform = `translate(${x}px, ${y}px)`;
  if (w !== undefined) {
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }
  if (cls !== undefined) el.className = cls;
};
const gone = (el) => {
  if (el._k === "") return;
  el._k = "";
  el.hidden = true;
};
const say = (el, text, x, y, cls) => {
  if (el._t !== text) el.textContent = el._t = text;
  place(el, Math.round(x), Math.round(y), undefined, undefined, cls);
};

/** Everything canvas mode does in a frame: the drag's one write, then the reads and the drawing.
 *  Returns the outlines to draw with the others, or null when canvas mode shows nothing. */
function cvFrame(capturing) {
  if (!bar) return null;
  const show = S.enabled && !capturing && !MO.on; // motion mode has its own dock
  if (bar._shown !== show) bar.hidden = corner.hidden = !(bar._shown = show);
  const on = C.on && show;
  if (insp._shown !== on) insp.hidden = !(insp._shown = on);
  if (!on) {
    if (C.drawn) {
      cv.hidden = true;
      C.drawn = false;
    }
    return null;
  }
  if (!C.drawn) {
    cv.hidden = false;
    C.drawn = T.need = true;
    T.want = T.scroll; // a pane that was not displayed has lost its scroll: put it back
  }
  const d = C.drag, now = performance.now();
  if (d && d.mode === "start") startDrag(d);
  const live = !!d && !!d.mode && d.mode !== "none";
  if (live) stepDrag(d);

  // The selection: found again if the page re-rendered it. Its geometry (the siblings, the gaps)
  // is kept relative to its own corner, so scrolling costs nothing; it is measured again when
  // an edit, its size or the window changed, and a few times a second while the DOM changes.
  let r = null;
  if (C.sel && !C.sel.isConnected) {
    if (C.edit) endEdit(false);
    const again = stampOf(C.selRs) ? elOf(C.selRs) : q(C.selRs);
    if (again) {
      C.sel = again;
      reveal(again);
      syncFields();
    } else select(null);
  }
  if (C.sel) {
    r = rectOf(C.sel);
    const key = `${C.rev}|${r.w}|${r.h}|${VP.w}`;
    if (!d && !C.edit && (key !== C.geoKey || (C.geoDom !== domVersion && now - C.geoAt > 200) || now - C.geoAt > 1000)) {
      C.geoKey = key;
      C.geoDom = domVersion;
      C.geoAt = now;
      C.geo = buildGeo(C.sel, r);
      layoutHit(C.geo, r);
      if (C.zone && C.zone.t === "space") C.zone = C.geo.zones[C.zone.i] || null;
    } else if (live && d.mode === "resize" && C.geo) layoutHit(C.geo, r);
  }
  C.r = r;
  if (C.moved && !d) {
    C.moved = false;
    if (!C.over) {
      const h = C.zone ? null : pick(C.px, C.py);
      if (h !== C.hover) {
        C.hover = h;
        T.need = true;
      }
    }
  }

  const z = live ? d.zone : d ? null : C.zone;
  const boxes = [];
  if (C.hover && C.hover.isConnected && C.hover !== C.sel && !d && !C.edit && !z) boxes.push([rectOf(C.hover), "hover"]);
  const seen = !!r && (r.w > 0 || r.h > 0);
  if (seen) boxes.push([r, "csel"]);
  if (seen && C.geo && !C.edit && !(live && d.mode === "move")) place(hitEl, r.x, r.y);
  else gone(hitEl);

  // The gap under the pointer (or being dragged): a tinted band, its value above it.
  let band = null;
  if (z && z.t === "space") {
    band = live ? between(rectOf(z.a), rectOf(z.b), rectOf(z.el))?.rect : r && { x: r.x + z.rel.x, y: r.y + z.rel.y, w: z.rel.w, h: z.rel.h };
    if (band) {
      const bw = Math.max(band.w, 2), bh = Math.max(band.h, 2);
      place(bandEl, Math.round(band.x - (bw - band.w) / 2), Math.round(band.y - (bh - band.h) / 2), Math.round(bw), Math.round(bh));
    }
  }
  if (!band) gone(bandEl);

  const floor = VP.h - dock();
  if (live && d.mode === "move") {
    const ox = VP.sx - d.sx, oy = VP.sy - d.sy;
    // The ghost follows the pointer but stays inside its parent (and the window).
    const gx = Math.min(Math.max(d.r0.x + d.x - d.x0, Math.max(0, d.pr.x - ox)), Math.max(Math.max(0, d.pr.x - ox), Math.min(VP.w, d.pr.x - ox + d.pr.w) - d.r0.w));
    const gy = Math.min(Math.max(d.r0.y + d.y - d.y0, Math.max(0, d.pr.y - oy)), Math.max(Math.max(0, d.pr.y - oy), Math.min(floor, d.pr.y - oy + d.pr.h) - d.r0.h));
    place(ghostEl, Math.round(gx), Math.round(gy), Math.round(d.r0.w), Math.round(d.r0.h));
    if (d.at) place(insEl, Math.round(d.at.x - ox) - (d.at.w ? 0 : 1.5), Math.round(d.at.y - oy) - (d.at.h ? 0 : 1.5), Math.max(3, d.at.w), Math.max(3, d.at.h), `ins ${d.at.w ? "h" : "v"}`);
    else gone(insEl);
  } else {
    gone(ghostEl);
    gone(insEl);
  }

  // Labels: the live one sits 12px off the pointer; a gap's value sits above its band; the
  // selection's size sits under it, unless the dock covers that spot.
  if (live && d.label) say(labEl, d.label, Math.min(d.x + 12, VP.w - 180), Math.min(d.y + 12, floor - 24), `lab live${d.snapped ? " snap" : ""}`);
  else if (band && !d) say(labEl, `${z.prop} ${Math.round(z.value)}`, band.x + band.w / 2, Math.max(10, band.y - 12), "lab live mid");
  else gone(labEl);
  if (seen && !d && !C.edit && r.y + r.h + 26 <= floor && r.y + r.h + 14 > 0) say(dimEl, `${Math.round(r.w)} × ${Math.round(r.h)}`, r.x + r.w / 2, r.y + r.h + 14, "lab dim mid");
  else gone(dimEl);

  if (!C.collapsed) {
    drawTree();
    drawComputed();
  }
  return boxes;
}

