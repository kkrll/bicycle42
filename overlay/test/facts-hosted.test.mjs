// End-to-end tests for the host's "This page on this phone" pane (src/facts/host.js): nothing is
// worked out until the pane asks, what the view says about a page shown 390 wide, and what the
// pane's acts do to the page. The harness plays the host (__harness.hostDocks, act, view);
// harness/facts.html is the page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { serve } from "../scripts/serve.mjs";

const CANDIDATES = [
  process.env.CHROMIUM,
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));

let server, browser, base;

before(async () => {
  assert.ok(executablePath, `no Chromium found; set CHROMIUM (tried ${CANDIDATES.join(", ")})`);
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** The facts page in a frame 390 wide, with the pane the host's: the overlay says it works nothing out yet. */
async function open() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=150&page=facts`);
  await page.waitForFunction(() => document.getElementById("page").contentWindow?.__b42);
  await page.evaluate(() => (document.getElementById("page").style.width = "390px"));
  const f = page.frames().find((fr) => fr.url().endsWith("/harness/facts.html"));
  await f.waitForFunction(() => document.querySelector("b42-review") && document.documentElement.clientWidth === 390);
  await page.evaluate(() => window.__harness.hostDocks(["facts"]));
  await page.waitForFunction(() => window.__harness.view("facts") === null);
  return { page, f, errors };
}

const frames = (f, n = 2) => f.evaluate((k) => new Promise((done) => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : done());
  step();
}), n);
const act = (page, a) => page.evaluate((x) => window.__harness.act("facts", x), a);
const view = (page) => page.evaluate(() => window.__harness.view("facts"));
/** Wait until the last view passes `fn` (a function of the view, as source). */
const until = (page, fn) => page.waitForFunction(`(() => { const v = window.__harness.view("facts"); return !!v && (${fn})(v); })()`);
const views = (page) => page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "facts" && "view" in m).length);
/** The pane's outlines on the page: where each is and what it is. */
const outlines = (f) => f.evaluate(() => [...document.querySelector("b42-review").shadowRoot.querySelectorAll(".box.fx")].map((b) => {
  const r = b.getBoundingClientRect();
  return { cls: b.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}));
const rect = (f, sel) => f.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);
const idOf = (v, label) => [...v.wide.items, ...v.taps.items, ...v.small.items].find((i) => i.label === label)?.id;

test("nothing is worked out before the pane asks; the view says what sticks out, what is too small to tap and what zooms", async () => {
  const { page, f, errors } = await open();
  // A change to the page while nobody asks: still nothing.
  await f.evaluate(() => document.getElementById("more").append(Object.assign(document.createElement("button"), { textContent: "Late" })));
  await page.waitForTimeout(600);
  assert.equal(await views(page), 1);
  assert.equal(await view(page), null);

  await act(page, { type: "view" });
  await until(page, "(v) => v.taps.total > 0");
  const v = await view(page);
  assert.deepEqual(v.viewport.w, 390);
  assert.equal(v.doc.w, 536); // 16 px of the body's padding, then 520
  assert.equal(v.meta, true);
  assert.equal(v.partial, false);
  // The banner sticks out, once: not its paragraph (its overflow is the banner's), not what a box
  // that fits clips.
  assert.deepEqual(v.wide.items.map((i) => [i.label, i.detail]), [["Spring sale banner", "+146 px"]]);
  assert.equal(v.wide.total, 1);
  const taps = v.taps.items.map((i) => i.label);
  assert.ok(taps.includes("Close"), taps.join(", "));
  assert.equal(v.taps.items.find((i) => i.label === "Close").detail, "24 × 24");
  assert.ok(taps.includes("Pricing") && taps.includes("Late"), taps.join(", "));
  // A link in a sentence, a 160 x 48 button and buttons that are not shown are not listed.
  for (const no of ["terms of service", "Sign up", "Hidden away", "Invisible"]) assert.ok(!taps.includes(no), `${no} in ${taps.join(", ")}`);
  assert.equal(v.taps.total, v.taps.items.length);
  assert.deepEqual(v.small.items.map((i) => [i.label, i.detail]), [["Email", "14px"]]);
  assert.equal(v.small.total, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the view follows the page: a change, a scroll; after stop nothing is worked out, and the pane's view is null", async () => {
  const { page, f, errors } = await open();
  await act(page, { type: "view" });
  await until(page, "(v) => v.taps.total > 0");
  const before = (await view(page)).taps.total;
  await f.evaluate(() => {
    const b = document.createElement("button");
    b.textContent = "Tiny";
    b.style.cssText = "width:20px;height:20px;padding:0";
    document.getElementById("more").append(b);
  });
  await until(page, `(v) => v.taps.total === ${before + 1}`);
  // Scrolling sends where the page is.
  await f.evaluate(() => (document.getElementById("more").style.height = "2000px"));
  await until(page, "(v) => v.doc.h > 2000");
  await f.evaluate(() => window.scrollTo(0, 120));
  await until(page, "(v) => v.scrollY > 0");

  await act(page, { type: "stop" });
  await page.waitForFunction(() => window.__harness.view("facts") === null);
  const n = await views(page);
  await f.evaluate(() => {
    document.getElementById("more").append(Object.assign(document.createElement("button"), { textContent: "After" }));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(700);
  assert.equal(await views(page), n);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hover outlines a row's element and takes it away, review off too; show brings it into view with a flash", async () => {
  const { page, f, errors } = await open();
  await act(page, { type: "view" });
  await until(page, "(v) => v.small.total > 0");
  const v = await view(page);
  await act(page, { type: "hover", id: idOf(v, "Close") });
  await frames(f);
  const tiny = await rect(f, "#tiny");
  assert.deepEqual(await outlines(f), [{ cls: "box fx", ...tiny }]);
  await act(page, { type: "hover", id: null });
  await frames(f);
  assert.deepEqual(await outlines(f), []);

  // Preview: review off, and the outline is still drawn.
  await page.evaluate(() => document.getElementById("toggle").click());
  await page.waitForFunction(() => !window.__harness.enabled);
  await act(page, { type: "hover", id: idOf(v, "Email") });
  await frames(f);
  assert.deepEqual((await outlines(f)).map((o) => o.cls), ["box fx"]);
  await act(page, { type: "hover", id: null });

  // Show: scrolled into view, flashed, then drawn no more.
  await f.evaluate(() => (document.getElementById("more").style.height = "2000px"));
  await f.evaluate(() => window.scrollTo(0, 2000));
  await act(page, { type: "show", id: idOf(v, "Email") });
  await f.waitForFunction(() => {
    const r = document.getElementById("small").getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
  assert.deepEqual((await outlines(f)).map((o) => o.cls), ["box fx flash"]);
  await f.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".box.fx"), null, { timeout: 3000 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("note makes a row's element the note's selection in notes mode, and does nothing with review off", async () => {
  const { page, f, errors } = await open();
  await act(page, { type: "view" });
  await until(page, "(v) => v.small.total > 0");
  const v = await view(page);
  const card = () => f.evaluate(() => !document.querySelector("b42-review").shadowRoot.querySelector(".card").hidden);
  assert.equal(await card(), false);
  await act(page, { type: "note", id: idOf(v, "Email") });
  await page.waitForFunction(() => window.__harness.draft?.targets?.length === 1);
  assert.match((await page.evaluate(() => window.__harness.draft.targets[0])), /small/);
  assert.equal(await card(), true);
  assert.deepEqual(errors, []);
  await page.close();

  // Review off: nothing.
  const two = await open();
  await act(two.page, { type: "view" });
  await until(two.page, "(v) => v.small.total > 0");
  const v2 = await view(two.page);
  await two.page.evaluate(() => document.getElementById("toggle").click());
  await two.page.waitForFunction(() => !window.__harness.enabled);
  await act(two.page, { type: "note", id: idOf(v2, "Email") });
  await two.page.waitForTimeout(400);
  assert.equal(await two.page.evaluate(() => window.__harness.draft?.targets?.length ?? 0), 0);
  await two.page.close();
});
