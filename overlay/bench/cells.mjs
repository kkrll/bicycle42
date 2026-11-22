// The cells of the benchmark (a state of the overlay on a page, then three seconds of it), the
// columns of the table, and the invariants: what must hold on any machine, from counts alone.
import { sleep } from "./rig.mjs";

export const WINDOW_MS = 3000;

// ── gestures ────────────────────────────────────────────────────────────────────────────────────
/** Call fn(i) n times, evenly over ms (paced from here, so the page gets no timer for it). */
async function paced(n, ms, fn) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    await fn(i);
    const wait = t0 + ((i + 1) * ms) / n - performance.now();
    if (wait > 0) await sleep(wait);
  }
}
const frames = (page, n = 2) => page.evaluate((k) => new Promise((done) => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : done());
  step();
}), n);
const centre = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const click = async (page, sel) => {
  await page.mouse.click(...(await centre(page, sel)));
  await frames(page);
};
/** A click on an element's padding, near its top-left corner: the element itself, not a child. */
const clickPad = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  await page.mouse.click(b.x + 5, b.y + 5);
  await frames(page);
};
/** Four strokes of 300 points, alt+drag. Each is drawn above the one before: the note card opens
 *  under everything drawn so far, and a press that lands on the card would not start a stroke.
 *  The press and the release are the mouse's. The moves between them are dispatched in the page:
 *  Chromium delivers one real move a frame (five seconds a stroke), and the overlay takes one
 *  point from each move whoever sent it. */
async function strokes({ page }) {
  await page.keyboard.down("Alt");
  for (let k = 0; k < 4; k++) {
    const y = 480 - k * 70;
    await page.mouse.move(120, y);
    await page.mouse.down();
    await page.evaluate((y0) => {
      for (let i = 1; i <= 300; i++) window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120 + i * 3.8, clientY: y0 + Math.sin(i / 9) * 14, altKey: true, buttons: 1 }));
    }, y);
    await page.mouse.up();
  }
  await page.keyboard.up("Alt");
}
const canvasOn = async (page) => {
  await page.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" })); // the switch is the host's
  await page.waitForFunction(() => window.__canvasViews > 0); // the host's inspector has its first view
};
/** Press on a card, move it 48 px and back, let go where it started: nothing is reordered, and
 *  the card is selected by the drag (from inside a frame), not by a click. */
async function canvasDrag({ page }) {
  await canvasOn(page);
  const [x, y] = await centre(page, "#c7");
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) (await page.mouse.move(x + i * 4, y), await frames(page, 1));
  await page.mouse.move(x, y);
  await frames(page);
  await page.mouse.up();
  await frames(page);
}
const wheel = ({ page }) => paced(90, WINDOW_MS, () => page.mouse.wheel(0, 40));
const sweep = ({ page }) => paced(180, WINDOW_MS, (i) => page.mouse.move(80 + ((i * 29) % 1240), 100 + ((i * 4) % 700)));
/** The page scrolled by its own script: no input event, only scroll events. */
const scrolls = ({ page }) => paced(90, WINDOW_MS, () => page.evaluate(() => window.scrollBy(0, 40)));
/** One stroke drawn live, 150 real moves over the window (alt+drag). Each window draws a new
 *  stroke above the one before, as strokes() does, so a press never lands on the card. */
async function drawLive(t) {
  const y = 700 - (t.reps = (t.reps || 0) + 1) * 120;
  const { page } = t;
  await page.keyboard.down("Alt");
  await page.mouse.move(120, y);
  await page.mouse.down();
  await paced(150, WINDOW_MS - 100, (i) => page.mouse.move(120 + i * 7, y + Math.sin(i / 9) * 14));
  await page.mouse.up();
  await page.keyboard.up("Alt");
}
/** Fifteen keys a second into the note card, a space now and then. */
const typing = ({ page }) => paced(45, WINDOW_MS, (i) => page.keyboard.press(i % 9 === 8 ? "Space" : "KeyA"));
/** Canvas mode's resize drag on the selected card's right edge, half a pixel a move: out 42 px
 *  and back, so every window starts from the same width. Each frame of it changes the preview. */
async function resizeDrag({ page }) {
  const b = await page.locator("#c7").boundingBox();
  const x = b.x + b.width, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await frames(page); // the handle under the pointer is the layer's, placed by a frame
  await page.mouse.down();
  await paced(170, WINDOW_MS - 150, (i) => page.mouse.move(x + 0.5 * (i < 85 ? i + 1 : 169 - i), y));
  await page.mouse.up();
}
/** Motion mode, its dock the host's (as the app's is: the overlay has none of its own), so the
 *  views the dock is sent are part of what is measured. */
const motionOn = async (page) => {
  await page.evaluate(() => {
    window.__b42.receive({ type: "docks", hosted: ["motion"] });
    window.__b42.receive({ type: "mode", mode: "motion" });
  });
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-b42-review"));
};
/** A card that bobs forever (the none+bob baseline is the page with it and no overlay). */
const bob = ({ page }) => page.addStyleTag({ content: "#c7 { animation: bob 1.2s ease-in-out infinite; } @keyframes bob { 50% { transform: translateY(-6px); } }" });
/** The bobbing card opened in motion mode. */
async function motionSelected(t) {
  const { page } = t;
  await bob(t);
  await motionOn(page);
  await clickPad(page, "#c7");
}

// ── cells ───────────────────────────────────────────────────────────────────────────────────────
const MISSING = Array.from({ length: 5 }, (_, i) => ({ id: `gone${i}`, n: i + 1, status: "queued", selector: `#gone${i}`, tag: "article", text: `No such words ${i}`, at: [100, 100 + i * 30] }));
// Twenty pins on cards down the page: several are in view wherever the wheel has got to.
const PLACED = Array.from({ length: 20 }, (_, i) => ({ id: `on${i}`, n: i + 1, status: i % 3 ? "done" : "queued", selector: `#c${i * 12 + 2} h3`, tag: "h3", at: [0, 0] }));
const WORKING = [{ id: "w1", n: 1, status: "working", selector: "#c7 h3", tag: "h3", at: [0, 0] }];
// Two hundred pins, one every fifth card: a review that has gone on for a while.
const MANY = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, n: i + 1, status: "done", selector: `#c${i * 5} h3`, tag: "h3", at: [0, 0] }));
const cardOpen = (r) => !r.querySelector(".card").hidden;
const fourStrokes = (r) => {
  const points = [...r.querySelectorAll(".strokes path")].map((p) => p.getAttribute("d").split("L").length);
  return points.length === 4 && points.every((n) => n > 290) && !r.querySelector(".card").hidden;
};
const inspecting = () => window.__canvasViews > 0 && window.__b42.busy();

// page and enabled and pins: what the page opens with. setup: gestures before the settling pause.
// ready: must be true in the overlay's shadow root before measuring (the setup did what it says).
// run: what happens during the window (default: nothing). after: must be true once it is over.
// overlay: false for a baseline, the page and the gesture with no overlay at all. base: the
// baseline a cell's own ms are taken from (default: the same page, still).
export const CELLS = [
  { id: "none", page: "heavy", overlay: false },
  { id: "none+churn", page: "churn", overlay: false },
  { id: "none-sweep", page: "heavy", overlay: false, run: sweep },
  { id: "none-wheel", page: "heavy", overlay: false, run: wheel },
  { id: "none+bob", page: "heavy", overlay: false, setup: bob },
  { id: "off", page: "heavy" },
  { id: "off-sweep", page: "heavy", run: sweep, base: "none-sweep" },
  { id: "off-wheel", page: "heavy", run: wheel, base: "none-wheel", after: () => window.scrollY > 3000 },
  { id: "off-scroll", page: "heavy", run: scrolls, after: () => window.scrollY > 3000 },
  { id: "off+churn", page: "churn" },
  { id: "off-pins", page: "heavy", pins: PLACED, run: wheel, base: "none-wheel", after: () => window.scrollY > 3000 },
  { id: "pins-missing", page: "churn", enabled: true, pins: MISSING, ready: (r) => r.querySelectorAll(".pin.approx").length === 5 },
  { id: "on-idle", page: "heavy", enabled: true },
  { id: "selected", page: "heavy", enabled: true, setup: ({ page }) => click(page, "#c7 h3"), ready: cardOpen },
  { id: "strokes", page: "heavy", enabled: true, setup: strokes, ready: fourStrokes },
  { id: "churn-selected", page: "churn", enabled: true, setup: ({ page }) => click(page, "#c7 h3"), ready: cardOpen },
  { id: "strokes-scroll", page: "heavy", enabled: true, setup: strokes, ready: fourStrokes, run: wheel, base: "none-wheel", after: () => window.scrollY > 3000 },
  { id: "drawing", page: "heavy", enabled: true, run: drawLive, after: (r) => r.querySelectorAll(".strokes path").length === 3 },
  { id: "typing", page: "heavy", enabled: true, setup: ({ page }) => click(page, "#c7 h3"), ready: cardOpen, run: typing, after: (r) => r.querySelector(".card textarea").value.length === 135 },
  { id: "hover", page: "heavy", enabled: true, run: sweep, base: "none-sweep", after: (r) => r.querySelectorAll(".box.hover").length === 1 },
  { id: "canvas-selected", page: "heavy", enabled: true, setup: async ({ page }) => (await canvasOn(page), await click(page, "#c7")), ready: inspecting },
  { id: "canvas-after-drag", page: "heavy", enabled: true, setup: canvasDrag, ready: inspecting },
  { id: "canvas-drag", page: "heavy", enabled: true, setup: async ({ page }) => (await canvasOn(page), await clickPad(page, "#c7")), ready: inspecting, run: resizeDrag },
  { id: "motion-selected", page: "heavy", enabled: true, setup: motionSelected, base: "none+bob", ready: (r) => !r.querySelector(".m-tag").hidden },
  { id: "pins-scroll", page: "heavy", enabled: true, pins: PLACED, ready: (r) => r.querySelectorAll(".pin:not(.approx)").length === 20, run: wheel, base: "none-wheel", after: () => window.scrollY > 3000 },
  { id: "pins200-scroll", page: "heavy", enabled: true, pins: MANY, ready: (r) => r.querySelectorAll(".pin:not(.approx)").length > 5, run: wheel, base: "none-wheel", after: () => window.scrollY > 3000 },
  { id: "pin-working", page: "heavy", enabled: true, pins: WORKING, ready: (r) => r.querySelectorAll(".pin.working:not(.approx)").length === 1 },
];
/** The baseline a cell's own milliseconds are measured against. */
export const baseOf = (cell) => cell.base || (cell.page === "churn" ? "none+churn" : "none");

// ── columns: [key in what measure() returns, heading]. All are per second of the window. ────────
export const METRICS = [
  ["busyMs", "busy ms"], ["scriptMs", "script ms"], ["layouts", "layouts"], ["layoutMs", "layout ms"], ["recalcs", "recalcs"], ["recalcMs", "recalc ms"],
  ["frames", "frames"], ["timers", "timers"], ["writes", "writes"], ["searches", "searches"], ["paints", "paints"], ["paintMs", "paint ms"], ["rasterMs", "raster ms"], ["gpuMs", "gpu ms"],
];

// ── invariants: [cell, metric, at most, over?]. Counts only: milliseconds depend on the machine. ─
// `fps` is the display's frame rate: one chain of overlay frames draws once a display frame.
// `over` names a cell to subtract first: the same page without what this cell adds.
export const invariants = (fps) => [
  // Review off and no pins: nothing to draw, whatever the page or the reviewer does.
  ["off", "frames", 0],
  ["off", "timers", 0],
  ["off-sweep", "frames", 0],
  ["off-sweep", "searches", 0],
  ["off-wheel", "frames", 0],
  ["off-wheel", "searches", 0],
  ["off-scroll", "frames", 0],
  ["off-scroll", "searches", 0],
  ["off+churn", "frames", 0],
  ["off+churn", "searches", 0],
  // Review off with pins: Preview draws none, so the same nothing while the page scrolls.
  ["off-pins", "frames", 0],
  ["off-pins", "searches", 0],
  // Still: the idle tick (250 ms), whether something is selected or drawn or not.
  ["on-idle", "frames", 6],
  ["selected", "frames", 6],
  ["strokes", "frames", 6],
  ["canvas-selected", "frames", 6],
  ["canvas-after-drag", "frames", 6],
  ["selected", "recalcs", 0],
  ["selected", "layouts", 0],
  ["strokes", "writes", 0],
  ["strokes", "layouts", 0],
  ["strokes", "recalcs", 0],
  // A page that changes keeps the frames coming, one chain of them (two would be twice the
  // display rate); a text that changes is no reason to search the document for variant groups.
  ["churn-selected", "frames", fps + 5],
  ["churn-selected", "searches", 0],
  // The ink and the pins are layers that move with the scroll: no stroke is written, nothing is
  // laid out and next to nothing is painted (without their layer, every frame is painted).
  ["strokes-scroll", "writes", 0],
  ["strokes-scroll", "layouts", 0],
  ["strokes-scroll", "paints", 5],
  ["pins-scroll", "paints", 5],
  ["pins200-scroll", "paints", 5],
  // Typing: fifteen keys a second, each laid out once (the card grows with its text by CSS).
  ["typing", "layouts", 16],
  // Missing pins on a page that changes: what looking for them adds, at most.
  ["pins-missing", "searches", 10, "off+churn"],
  // (hover has none: it is judged by its raster ms. Its counts, a frame a move and the layouts
  // and paints of an outline that moves, stay the same however the outline is drawn.)
];
