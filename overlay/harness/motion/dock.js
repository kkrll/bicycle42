// Motion mode's layout: the page above, the dock below. The dock has the list of what moves, and
// the open animation: one bar (Keyframes | CSS, how this element plays it, the tools), then its
// timeline (bars.js) or its text, then the selected keyframe.
import { mountPage, drawList, wireLanes, drawCss, timingFields, keyEditor, viewSwitch, extras, edits, wire, openPop, icon } from "./ui.js";
import { drawBars, barsFrame } from "./bars.js";

const CSS = `
  body { display: grid; grid-template-rows: minmax(0, 1fr) 340px; }
  #page { margin: 12px 12px 0; border-radius: 10px; overflow: hidden; }
  .dock { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 0; margin-top: 12px; background: var(--panel); border-top: 1px solid var(--line); }
  .dock > .list { border-right: 1px solid var(--line); }
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .hd { flex: none; display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 12px 0 16px; }
  .hd .timing { flex-wrap: nowrap; gap: 16px; min-width: 0; }
  .hd .sp { flex: 1; }
  .hd .grp { display: flex; align-items: center; gap: 2px; }
  .body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .tl { flex: 1; }
  .time { min-width: 40px; color: var(--muted); font: 12px var(--mono); font-variant-numeric: tabular-nums; line-height: 28px; }
  .cssv { flex: 1; padding-top: 0; }
  .kb { flex: none; display: flex; align-items: center; height: 52px; padding: 0 12px 0 16px; border-top: 1px solid var(--line); }
  .kb .keyed { flex: 1; }
`;

export function dock() {
  document.head.insertAdjacentHTML("beforeend", `<style>${CSS}</style>`);
  document.body.insertAdjacentHTML("afterbegin", `<div id="page"></div>
    <div class="dock"><div class="list" id="list"></div><div class="main"><div class="hd" id="hd"></div>
      <div class="body"><div class="tl" id="tl" tabindex="0"></div><div class="cssv" id="css" hidden></div></div><div class="kb" id="kb" hidden></div></div></div>`);
  const $ = (s) => document.querySelector(s);
  const { mo, ui } = mountPage($("#page"), redraw);

  function redraw(what) {
    drawList($("#list"), mo);
    if (what === "list") return;
    const o = mo.M.open, typing = ui.typingIn && ui.typingIn();
    // The list says what is open; the bar holds only what is done to it.
    if (!typing || !$("#hd").contains(typing))
      $("#hd").innerHTML = o ? `${viewSwitch(ui)}<div class="timing">${timingFields(mo, ["duration", "delay", "easing"])}</div>
        <button class="btn ic" data-act="more" title="More">${icon("more")}</button><span class="sp"></span>
        <div class="grp">${extras(mo)}</div><div class="grp">${edits(mo)}</div>` : "";
    $("#hd").hidden = !o;
    const css = ui.view === "css" && o;
    $("#tl").hidden = css;
    $("#css").hidden = !css;
    if (css) drawCss($("#css"), mo);
    else if (!typing || !$("#tl").contains(typing)) drawBars($("#tl"), mo);
    if (!typing || !$("#kb").contains(typing)) $("#kb").innerHTML = css ? "" : keyEditor(mo);
    $("#kb").hidden = !$("#kb").innerHTML.trim();
  }
  wireLanes($("#tl"), mo, redraw, { span: () => $("#tl .kspan[data-prop]") });
  wire(mo, ui, redraw, {
    act: (act, b) => {
      if (act !== "more") return false;
      openPop(b, timingFields(mo, ["count", "direction", "fill", "how"]), "below");
    },
    frame: (p) => barsFrame(p, $("#tl")),
  });
  redraw();
  window.__mo = mo;
  return { mo, ui, redraw };
}
