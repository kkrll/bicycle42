// The measuring rig of the benchmark: two pages made in memory, a host shim, counters that run
// inside the page, and one measured window (CDP metrics, the counters, Paint events of a trace).
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const CANDIDATES = [
  process.env.CHROMIUM,
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);
// Without these a headless page that looks hidden to Chromium gets its timers and frames slowed.
// BENCH_GPU=1 draws with the graphics card, as the app does (headless Chromium draws in software
// otherwise). The counts are the same either way; paint and raster milliseconds are not.
const GPU = process.env.BENCH_GPU ? ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=gl-egl", "--ozone-platform=headless"] : [];
const FLAGS = ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", ...GPU];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pages ───────────────────────────────────────────────────────────────────────────────────────
const WORDS = "calm review ship note pin draw queue agent design code page element margin colour layout frame render quiet fast slow".split(" ");
const words = (i, n) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(" ");
const cards = (n) => Array.from({ length: n }, (_, i) => `<article id="c${i}"><h3>${words(i, 2)} ${i}</h3><p>${words(i + 1, 8)}</p><span>${words(i + 2, 1)} ${i}</span><a href="#${i}">${words(i + 3, 2)}</a></article>`).join("");
const html = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>bench</title><style>
  body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #fafafa; }
  main { display: flex; flex-wrap: wrap; gap: 12px; padding: 16px 24px; }
  article { width: 210px; padding: 12px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
  h3, p { margin: 0 0 4px; } span { color: #777; margin-right: 8px; }
</style></head><body>${body}</body></html>`;
const PAGES = {
  "/blank": html(""),
  // 1,000 cards of five elements: 5,000 elements with text, about twenty screens tall.
  "/heavy": html(`<main>${cards(1000)}</main>`),
  // 400 cards (2,000 elements) under a counter that the page rewrites in every frame.
  "/churn": html(`<div id="clock">0</div><main>${cards(400)}</main><script>
    let i = 0;
    (function tick() { document.getElementById("clock").firstChild.data = String(++i); requestAnimationFrame(tick); })();
  </script>`),
};

// ── what runs in the page before the overlay ────────────────────────────────────────────────────
// The counters only count calls the page and the overlay make anyway: no frame, timer or observer
// of their own, so a page that does nothing still does nothing.
const PROBE = () => {
  const N = (window.__n = { frames: 0, timers: 0, writes: 0, searches: 0 });
  const raf = window.requestAnimationFrame.bind(window);
  // The overlay's frame callback is a function named "frame"; the pages' own loop is named "tick".
  window.requestAnimationFrame = (cb) => raf(cb && cb.name === "frame" ? (ts) => (N.frames++, cb(ts)) : cb);
  for (const name of ["setTimeout", "setInterval"]) {
    const orig = window[name].bind(window);
    window[name] = (cb, ...rest) => orig(typeof cb === "function" ? (...a) => (N.timers++, cb(...a)) : cb, ...rest);
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === "d") N.writes++;
    return setAttribute.call(this, name, value);
  };
  for (const proto of [Document.prototype, Element.prototype]) {
    const all = proto.querySelectorAll;
    proto.querySelectorAll = function (sel) {
      if (this === document || this === document.body) N.searches++;
      return all.call(this, sel);
    };
  }
};
// The host: answers "ready" with the state and takes every note, as harness/host.js does.
const SHIM = ({ enabled, pins }) => {
  window.__review = (json) => {
    const m = JSON.parse(json);
    if (m.type === "ready") window.__b42.receive({ type: "state", enabled, pins });
    if (m.type === "note") window.__b42.receive({ type: "captured", id: m.note.id });
  };
};

// ── browser ─────────────────────────────────────────────────────────────────────────────────────
export async function start() {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error(`no Chromium found; set CHROMIUM (tried ${CANDIDATES.join(", ")})`);
  const server = createServer((req, res) => {
    const body = PAGES[new URL(req.url, "http://x").pathname];
    if (!body) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath, headless: true, args: FLAGS });
  const close = async () => (await browser.close(), server.close());
  return { browser, base: `http://127.0.0.1:${server.address().port}`, close };
}

/** Frames a second this machine really shows: a loop that asks for every frame, on an empty page. */
export async function displayRate(rig) {
  const page = await rig.browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${rig.base}/blank`);
  const rate = await page.evaluate(() => new Promise((done) => {
    let n = 0, t0 = 0;
    const step = (ts) => {
      t0 ||= ts;
      if (ts - t0 >= 1000) return done((n * 1000) / (ts - t0));
      n++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  await page.close();
  return rate;
}

/** A fresh page with the counters, the host and the overlay file under test; review on or off. */
export async function open(rig, overlay, { page: name, enabled = false, pins = [] }) {
  const page = await rig.browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(PROBE);
  await page.addInitScript(SHIM, { enabled, pins });
  await page.addInitScript({ path: overlay });
  await page.goto(`${rig.base}/${name}`);
  await page.waitForFunction((on) => document.querySelector("b42-review") && document.documentElement.hasAttribute("data-b42-review") === on, enabled);
  const cdp = await page.context().newCDPSession(page);
  // timeTicks: the clock trace events use, so Paint events can be cut to the measured window.
  await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
  return { page, cdp, errors };
}

const metrics = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const counters = (page) => page.evaluate(() => ({ ...window.__n }));

/** Everything in METRICS (cells.mjs), per second, over the time `run` takes. */
export async function measure({ page, cdp }, run) {
  const events = [];
  const collect = (e) => events.push(...e.value.filter((ev) => ev.name === "Paint" || ev.name === "RasterTask" || ev.name === "GPUTask"));
  cdp.on("Tracing.dataCollected", collect);
  // (Raster tasks, the drawing of what was painted into tiles, are in the "cc" category.)
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "cc", "gpu", "disabled-by-default-devtools.timeline"] } });
  const n0 = await counters(page);
  const m0 = await metrics(cdp);
  await run();
  const m1 = await metrics(cdp);
  const n1 = await counters(page);
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", collect);
  const secs = m1.Timestamp - m0.Timestamp;
  const inWindow = (name) => events.filter((ev) => ev.name === name && ev.ph === "X" && ev.ts >= m0.Timestamp * 1e6 && ev.ts <= m1.Timestamp * 1e6);
  const paints = inWindow("Paint");
  const total = (list) => list.reduce((sum, ev) => sum + (ev.dur || 0), 0) / 1000 / secs;
  const ms = (k) => ((m1[k] - m0[k]) * 1000) / secs;
  return {
    busyMs: ms("TaskDuration"),
    scriptMs: ms("ScriptDuration"),
    layouts: (m1.LayoutCount - m0.LayoutCount) / secs,
    layoutMs: ms("LayoutDuration"),
    recalcs: (m1.RecalcStyleCount - m0.RecalcStyleCount) / secs,
    recalcMs: ms("RecalcStyleDuration"),
    frames: (n1.frames - n0.frames) / secs,
    timers: (n1.timers - n0.timers) / secs,
    writes: (n1.writes - n0.writes) / secs,
    searches: (n1.searches - n0.searches) / secs,
    paints: paints.length / secs,
    paintMs: total(paints),
    rasterMs: total(inWindow("RasterTask")),
    gpuMs: total(inWindow("GPUTask")),
  };
}
