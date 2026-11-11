// Harness host: plays the part the Electron app plays for real.
// It owns all durable state (mode, draft, notes, pins), injects the overlay into the page,
// and fakes the agent queue: one note at a time, queued → working → done.
import { notePrompt } from "../prompt.js";

const $ = (id) => document.getElementById(id);
const frame = $("page");
const isMac = /Mac/.test(navigator.platform);

const H = {
  enabled: true,
  mode: "notes", // what the overlay last said: "notes" | "canvas" | "motion"
  brush: false,
  draft: null,
  notes: [],
  unplaced: [],
  delay: Number(new URLSearchParams(location.search).get("delay") ?? 1500),
  refuse: "", // set by a test: the next notes are refused with this reason
  selected: null,
  log: [],
};
window.__harness = H; // for tests

const pins = () =>
  H.notes.map((n) => {
    const t = n.targets[0];
    return { id: n.id, n: n.n, status: n.status, ...(n.lane === "bg" ? { lane: "bg" } : {}), selector: t?.selector, tag: t?.tag, text: t?.text, component: t?.component?.name, at: n.at };
  });

function toPage(msg) {
  frame.contentWindow?.__b42?.receive(msg);
}

function onMessage(msg) {
  H.log.push(msg.type);
  switch (msg.type) {
    case "ready":
      toPage({ type: "state", enabled: H.enabled, draft: H.draft, pins: pins() });
      break;
    case "toggle":
      setEnabled(msg.enabled ?? !H.enabled);
      break;
    case "mode":
      H.mode = msg.mode;
      H.brush = msg.brush;
      break;
    case "draft":
      H.draft = msg.draft;
      break;
    case "note": {
      const note = msg.note;
      if (H.refuse) {
        toPage({ type: "captured", id: note.id, ok: false, why: H.refuse });
        break;
      }
      const n = H.notes.length + 1;
      const at = note.bounds ? [note.bounds.x + note.viewport.scrollX, note.bounds.y + note.viewport.scrollY] : undefined;
      H.notes.push({ ...note, n, at, status: "queued", prompt: notePrompt(note, n, { images: 2 }) });
      H.draft = null;
      // A real host takes the screenshot here, then confirms.
      toPage({ type: "captured", id: note.id });
      toPage({ type: "pins", pins: pins() });
      H.selected = n;
      pump();
      break;
    }
    case "pins-placement":
      H.unplaced = msg.unplaced;
      break;
  }
  render();
}

// Fake agent queue: one note at a time.
let busy = false;
function pump() {
  if (busy) return;
  const next = H.notes.find((n) => n.status === "queued");
  if (!next) return;
  busy = true;
  next.status = "working";
  toPage({ type: "pins", pins: pins() });
  render();
  setTimeout(() => {
    next.status = "done";
    busy = false;
    toPage({ type: "pins", pins: pins() });
    render();
    pump();
  }, H.delay);
}

function setEnabled(on) {
  H.enabled = on;
  toPage({ type: "enabled", enabled: on });
  render();
}

function inject() {
  const w = frame.contentWindow;
  w.__review = (s) => onMessage(JSON.parse(s));
  const s = w.document.createElement("script");
  s.src = new URL("../overlay.js", import.meta.url).href;
  w.document.documentElement.appendChild(s);
}

function render() {
  $("mode").textContent = H.enabled ? "Review on" : "Review off";
  $("mode").classList.toggle("on", H.enabled);
  $("brush").classList.toggle("on", H.enabled && H.brush);
  $("m-notes").classList.toggle("on", H.enabled && H.mode === "notes");
  $("m-edit").classList.toggle("on", H.enabled && H.mode === "canvas");
  $("m-motion").classList.toggle("on", H.enabled && H.mode === "motion");
  const c = { queued: 0, working: 0, done: 0 };
  for (const n of H.notes) c[n.status]++;
  $("counts").innerHTML = H.notes.length
    ? `${c.queued} queued · ${c.working} working · ${c.done} done` +
      (H.unplaced.length ? ` · <span class="unplaced">${H.unplaced.length} unplaced</span>` : "")
    : "No notes yet";
  $("notes").innerHTML = H.notes
    .map((n) => {
      const tg = n.targets.length ? n.targets.map((t) => t.selector).join(", ") : n.strokes.length ? "drawing" : "area";
      return `<li data-n="${n.n}" class="${n.n === H.selected ? "active" : ""}"><div class="row"><span class="n">${n.n}</span>
        <span>${escapeHtml(n.text)}</span><span class="st ${n.status}">${n.status}</span></div><div class="tg">${escapeHtml(tg)}</div></li>`;
    })
    .join("");
  const sel = H.notes.find((n) => n.n === H.selected);
  $("prompt").textContent = sel ? sel.prompt : "Select a note to see the prompt the agent would get.";
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

$("notes").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  H.selected = Number(li.dataset.n);
  render();
});
$("toggle").addEventListener("click", () => setEnabled(!H.enabled));
// The host has the mode switch and the brush; the overlay answers with the mode it is in.
$("brush").addEventListener("click", () => toPage({ type: "mode", brush: !H.brush }));
$("m-notes").addEventListener("click", () => toPage({ type: "mode", mode: "notes" }));
$("m-edit").addEventListener("click", () => toPage({ type: "mode", mode: "canvas" }));
$("m-motion").addEventListener("click", () => toPage({ type: "mode", mode: "motion" }));
$("reload").addEventListener("click", () => frame.contentWindow.location.reload());
$("rerender").addEventListener("click", () => frame.contentWindow.rerender?.());
$("width").addEventListener("change", (e) => {
  frame.style.width = e.target.value ? `${e.target.value}px` : "100%";
  frame.style.flex = "none";
});
window.addEventListener("keydown", (e) => {
  if ((isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === "KeyM") {
    e.preventDefault();
    setEnabled(!H.enabled);
  }
});

frame.addEventListener("load", inject);
// ?page=canvas loads the canvas-mode test page instead of the default one; ?page=motion, the one
// with animations, transitions and scripted motion.
const PAGES = { canvas: "./canvas.html", motion: "./motion-page.html" };
const PAGE = PAGES[new URLSearchParams(location.search).get("page")] || "./page.html";
frame.src = new URL(PAGE, import.meta.url).href;
render();
