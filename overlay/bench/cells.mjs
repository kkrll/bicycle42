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
  await page.locator("b42-review .m-canvas").click();
  await page.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".insp").hidden);
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

// ── cells ───────────────────────────────────────────────────────────────────────────────────────
const MISSING = Array.from({ length: 5 }, (_, i) => ({ id: `gone${i}`, n: i + 1, status: "queued", selector: `#gone${i}`, tag: "article", text: `No such words ${i}`, at: [100, 100 + i * 30] }));
// Twenty pins on cards down the page: several are in view wherever the wheel has got to.
const PLACED = Array.from({ length: 20 }, (_, i) => ({ id: `on${i}`, n: i + 1, status: i % 3 ? "done" : "queued", selector: `#c${i * 12 + 2} h3`, tag: "h3", at: [0, 0] }));
const WORKING = [{ id: "w1", n: 1, status: "working", selector: "#c7 h3", tag: "h3", at: [0, 0] }];
const cardOpen = (r) => !r.querySelector(".card").hidden;
const fourStrokes = (r) => {
  const points = [...r.querySelectorAll(".strokes path")].map((p) => p.getAttribute("d").split("L").length);
  return points.length === 4 && points.every((n) => n > 290) && !r.querySelector(".card").hidden;
};
const inspecting = (r) => !r.querySelector(".insp").hidden && window.__b42.busy();

// page and enabled and pins: what the page opens with. setup: gestures before the settling pause.
// ready: must be true in the overlay's shadow root before measuring (the setup did what it says).
// run: what happens during the window (default: nothing). after: must be true once it is over.
export const CELLS = [
  { id: "off", page: "heavy" },
  { id: "off+churn", page: "churn" },
  { id: "pins-missing", page: "churn", pins: MISSING, ready: (r) => r.querySelectorAll(".pin.approx").length === 5 },
  { id: "on-idle", page: "heavy", enabled: true },
  { id: "selected", page: "heavy", enabled: true, setup: ({ page }) => click(page, "#c7 h3"), ready: cardOpen },
  { id: "strokes", page: "heavy", enabled: true, setup: strokes, ready: fourStrokes },
  { id: "strokes-scroll", page: "heavy", enabled: true, setup: strokes, ready: fourStrokes, run: wheel, after: () => window.scrollY > 3000 },
  { id: "hover", page: "heavy", enabled: true, run: sweep, after: (r) => r.querySelectorAll(".box.hover").length === 1 },
  { id: "canvas-selected", page: "heavy", enabled: true, setup: async ({ page }) => (await canvasOn(page), await click(page, "#c7")), ready: inspecting },
  { id: "canvas-after-drag", page: "heavy", enabled: true, setup: canvasDrag, ready: inspecting },
  { id: "pins-scroll", page: "heavy", pins: PLACED, ready: (r) => r.querySelectorAll(".pin:not(.approx)").length === 20, run: wheel, after: () => window.scrollY > 3000 },
  { id: "pin-working", page: "heavy", pins: WORKING, ready: (r) => r.querySelectorAll(".pin.working:not(.approx)").length === 1 },
];

// ── columns: [key in what measure() returns, heading]. All are per second of the window. ────────
export const METRICS = [
  ["busyMs", "busy ms"], ["scriptMs", "script ms"], ["layouts", "layouts"], ["layoutMs", "layout ms"], ["recalcs", "recalcs"], ["recalcMs", "recalc ms"],
  ["frames", "frames"], ["timers", "timers"], ["writes", "writes"], ["searches", "searches"], ["paints", "paints"], ["paintMs", "paint ms"], ["rasterMs", "raster ms"], ["gpuMs", "gpu ms"],
];

// ── invariants: [cell, metric, at most, over?]. Counts only: milliseconds depend on the machine. ─
// `fps` is the display's frame rate: one chain of overlay frames draws once a display frame.
// `over` names a cell to subtract first: the same page without what this cell adds.
export const invariants = (fps) => [
  ["off", "frames", 0],
  ["off", "timers", 0],
  ["on-idle", "frames", 6], // the idle tick is 250 ms
  ["selected", "recalcs", 0],
  ["selected", "layouts", 0],
  ["selected", "frames", fps + 5],
  ["strokes", "writes", 0],
  ["strokes", "layouts", 0],
  ["strokes", "recalcs", 0],
  ["canvas-after-drag", "frames", fps + 5], // two chains would be twice the display rate
  ["strokes-scroll", "writes", 0], // the ink is a layer that moves with the scroll: no stroke is written,
  ["strokes-scroll", "layouts", 0], // and nothing is laid out
  // On a page that changes, each overlay frame searches the document once for variant groups,
  // pins or no pins (that is off+churn). What is limited here is what looking for the pins adds.
  ["pins-missing", "searches", 10, "off+churn"],
];
