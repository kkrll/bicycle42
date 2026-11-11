// The timeline as bars: each stretch between two keyframes of a property is a bar, its keyframes
// are the grips at its ends. The keyframes are a band behind their lanes, headed by their name;
// when other elements play them too, the header says so and offers this element its own copy.
// The playhead is a flag with the time on it.
import { esc, icon, kindIcon, transport } from "./ui.js";

const MAJOR = [50, 100, 200, 250, 500, 1000, 2000, 5000];
const secs = (n) => `${+(n / 1000).toFixed(2)}s`;

/** One lane's bars and grips, in 0…1 of the keyframes. */
function laneBars(mo, p) {
  const fr = mo.frames().filter((f) => p in f.vals), key = mo.M.key, out = [];
  if (!fr.length) return "";
  const on = (f) => key && key.at === f.at && (key.prop === p || key.prop === null);
  if (fr.length === 1) out.push(`<i class="sb solo${on(fr[0]) ? " on" : ""}" style="--fa: ${fr[0].at / 100}; --fb: ${fr[0].at / 100}; --l: -10px; --r: 10px"></i>`);
  // The outer ends of a lane's bars reach past its first and last keyframes, so those grips sit
  // inside them; where two bars meet, a gap holds the grip they share.
  fr.forEach((f, i) => {
    const next = fr[i + 1];
    if (!next) return;
    const ease = mo.segEase(f.at, p).shown, flat = f.vals[p] === next.vals[p];
    out.push(`<i class="sb${on(f) ? " on" : ""}${flat ? " flat" : ""}" data-seg="${f.at}" data-prop="${esc(p)}" data-click title="${esc(ease)}"
      style="--fa: ${f.at / 100}; --fb: ${next.at / 100}; --l: ${i === 0 ? -10 : 3}px; --r: ${i === fr.length - 2 ? 10 : -3}px"></i>`);
  });
  for (const f of fr) out.push(`<i class="key grip${on(f) ? " on" : ""}" style="--at: ${f.at / 100}" data-at="${f.at}" data-prop="${esc(p)}" title="${esc(f.vals[p])}"></i>`);
  return out.join("");
}

export function drawBars(el, mo) {
  el.classList.add("bars");
  const o = mo.M.open;
  if (!o) {
    el.innerHTML = `<div class="empty">${mo.M.sel ? `<div>Nothing moves this</div><button class="btn" data-act="new">${icon("plus")}New animation</button>` : ""}</div>`;
    return;
  }
  const ro = mo.readOnly(), key = mo.M.key, fr = mo.frames(), T = Math.max(1, +mo.timing().duration || 0);
  el._T = T;
  const major = MAJOR.find((m) => T / m <= 7) || 5000, minor = major / 5;
  const ticks = [];
  for (let n = 0; n <= T + 0.5; n += minor) {
    const big = Math.round(n / minor) % 5 === 0;
    ticks.push(`<i class="tick${big ? " big" : ""}" style="--at: ${n / T}">${big ? `<b>${secs(n)}</b>` : ""}</i>`);
  }
  // the whole keyframes, under the ruler: one grabs every property at that moment
  const whole = fr.map((f) => `<i class="key wk${key && key.at === f.at && key.prop === null ? " on" : ""}" style="--at: ${f.at / 100}" data-at="${f.at}" data-prop=""></i>`).join("");
  const html = [`<div class="lrow ruler"><div class="lab">${transport(mo)}</div><div class="trk" data-ruler>${ticks.join("")}${whole}</div></div>`];

  // the band: the keyframes' name, and who else plays them
  const n = mo.sharedBy(), u = mo.openUse();
  const name = o.kind === "transition" ? "transition" : o.name;
  const note = n > 1 ? `<span class="shared" title="These keyframes are played by ${n} elements: a change to them changes all of them. Duration, delay and easing are this element's own.">${icon("link", 14)}${n} elements</span>
      <button class="btn own" data-act="detach" title="Copy the keyframes for this element only; the others keep them as they are">Only this one</button>`
    : u && u.from ? `<span class="shared">Own copy of <b>${esc(u.from)}</b></span>` : "";
  const lanes = mo.laneOrder();
  const rows = lanes.map((p) => `<div class="lrow lane${key && key.prop === p ? " kon" : ""}"><div class="lab"><span title="${esc(p)}">${esc(p)}</span>${ro ? "" : `<button class="btn ic x" data-act="rmlane" data-prop="${esc(p)}" title="Remove">${icon("x", 14)}</button>`}</div>
      <div class="trk"><div class="trk kspan" data-prop="${esc(p)}">${laneBars(mo, p)}</div></div></div>`);
  html.push(`<div class="lanes"><div class="bands"><i class="band"></i></div>
    <div class="lrow ghead"><div class="lab">${kindIcon(o.kind === "transition" ? "transition" : o.kind === "script" ? "script" : "css")}<b>${esc(name)}</b></div><div class="trk">${note}</div></div>
    ${rows.join("")}</div>`);
  if (!ro) html.push(`<div class="addp"><input class="fld" data-addp list="m-props" placeholder="+ Property" spellcheck="false" autocomplete="off"></div>`);
  html.push(`<div class="phl"><div class="flag" hidden><b></b></div></div>`);
  el.innerHTML = html.join("");
  el.classList.toggle("ro", ro);
}

/** Every frame: the flag, at the playhead, with its time. */
export function barsFrame(p, el) {
  const f = el.querySelector(".flag");
  if (!f || !el._T) return;
  f.hidden = p === null;
  if (p === null) return;
  f.style.setProperty("--x", p.toFixed(4));
  const text = secs(Math.round(p * el._T));
  if (f.firstChild.textContent !== text) f.firstChild.textContent = text;
}
