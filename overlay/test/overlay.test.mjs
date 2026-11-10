// End-to-end tests for the overlay in the harness, using a system Chromium (no browser download).
// CHROMIUM=/path/to/chrome overrides the browser. Run: npm test
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
const MOD = process.platform === "darwin" ? "Meta" : "Control";

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

async function open(delay = 150) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${base}/?delay=${delay}`);
  const f = await pageFrame(page);
  return { page, f };
}

async function pageFrame(page) {
  await page.waitForFunction(() => document.getElementById("page").contentWindow?.__b42);
  const f = page.frames().find((fr) => fr.url().endsWith("/harness/page.html"));
  await f.waitForFunction(() => document.querySelector("b42-review"));
  // let the host's "state" reply land
  await f.waitForFunction(() => document.documentElement.hasAttribute("data-b42-review"));
  return f;
}

const center = (b) => [b.x + b.width / 2, b.y + b.height / 2];
const box = async (f, sel) => {
  const b = await f.locator(sel).first().boundingBox();
  assert.ok(b, `no box for ${sel}`);
  return b;
};
const clickAt = async (page, f, sel, opts = {}) => {
  const [x, y] = center(await box(f, sel));
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  if (opts.shift) await page.keyboard.up("Shift");
};
const notes = (page) =>
  page.evaluate(() =>
    window.__harness.notes.map((n) => ({
      text: n.text,
      targets: n.targets.map((t) => t.selector),
      strokes: n.strokes.length,
      area: !!n.area,
      status: n.status,
      prompt: n.prompt,
    })),
  );
const waitNotes = (page, count) => page.waitForFunction((c) => window.__harness.notes.length >= c, count);
const shadow = (f, fn) => f.evaluate(fn);
const cardOpen = (f) => shadow(f, () => !document.querySelector("b42-review").shadowRoot.querySelector(".card").hidden);

test("click, type, Enter sends one note; page never sees the click or keys", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  assert.equal(await cardOpen(f), true);
  await page.keyboard.type("make it bigger");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  const [n] = await notes(page);
  assert.equal(n.text, "make it bigger");
  assert.deepEqual(n.targets, ["#cta"]);
  assert.match(n.prompt, /"Start free trial"/);
  assert.equal(await f.evaluate(() => window.pageClicks), 0);
  assert.equal(await f.evaluate(() => window.pageKeys), 0);
  assert.equal(await cardOpen(f), false);
  await page.close();
});

test("pin follows the queue to done", async () => {
  const { page, f } = await open(100);
  await clickAt(page, f, "#cta");
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__harness.notes[0]?.status === "done");
  await f.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector(".pin.done")?.textContent === "1");
  await page.close();
});

test("alt+Enter sends to the background lane; busy() covers the whole note", async () => {
  const { page, f } = await open(100);
  const busy = () => f.evaluate(() => window.__b42.busy());
  assert.equal(await busy(), false);
  await clickAt(page, f, "#cta");
  assert.equal(await busy(), true);
  await page.keyboard.type("fix the copy");
  await page.keyboard.press("Alt+Enter");
  await waitNotes(page, 1);
  assert.equal(await page.evaluate(() => window.__harness.notes[0].lane), "bg");
  await f.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector(".pin.bg"));
  await f.waitForFunction(() => !window.__b42.busy());
  await clickAt(page, f, "#cta");
  await page.keyboard.type("plain");
  await page.keyboard.press("Enter");
  await waitNotes(page, 2);
  assert.equal(await page.evaluate(() => window.__harness.notes[1].lane), undefined);
  await page.close();
});

test("shift+click adds elements to one note", async () => {
  const { page, f } = await open();
  await clickAt(page, f, 'nav a[href="#features"]');
  await clickAt(page, f, 'nav a[href="#pricing"]', { shift: true });
  await clickAt(page, f, 'nav a[href="#docs"]', { shift: true });
  await page.keyboard.type("same style");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  const [n] = await notes(page);
  assert.equal(n.targets.length, 3);
  await page.close();
});

test("drag selects the elements inside an area", async () => {
  const { page, f } = await open();
  const bs = await Promise.all([1, 2, 3, 4, 5].map((i) => box(f, `.toolbar button:nth-child(${i})`)));
  const x0 = Math.min(...bs.map((b) => b.x)) - 4;
  const y0 = Math.min(...bs.map((b) => b.y)) - 4;
  const x1 = Math.max(...bs.map((b) => b.x + b.width)) + 4;
  const y1 = Math.max(...bs.map((b) => b.y + b.height)) + 4;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.type("all are expected to have the same style");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  const [n] = await notes(page);
  assert.equal(n.targets.length, 5);
  assert.equal(n.area, true);
  await page.close();
});

test("alt+drag line selects what it crosses; a closed loop selects what it encloses", async () => {
  const { page, f } = await open();
  // line across the three card headings
  const hs = await Promise.all([1, 2, 3].map((i) => box(f, `#cards article:nth-of-type(${i}) h3`)));
  const y = center(hs[0])[1];
  await page.keyboard.down("Alt");
  await page.mouse.move(hs[0].x + 2, y);
  await page.mouse.down();
  await page.mouse.move(hs[2].x + hs[2].width - 2, y, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.type("pl-8");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  let [n] = await notes(page);
  assert.equal(n.strokes, 1);
  assert.ok(n.targets.length >= 3, `expected ≥3 targets, got ${n.targets}`);

  // loop around the CTA
  const b = await box(f, "#cta");
  const [cx, cy] = center(b);
  const rx = b.width / 2 + 10;
  const ry = b.height / 2 + 10;
  await page.waitForTimeout(50);
  await page.keyboard.down("Alt");
  await page.mouse.move(cx + rx, cy);
  await page.mouse.down();
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 16) await page.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.type("hide this on mobile");
  await page.keyboard.press("Enter");
  await waitNotes(page, 2);
  n = (await notes(page))[1];
  assert.deepEqual(n.targets, ["#cta"]);
  await page.close();
});

test("↑ moves the selection to the parent", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cards article:nth-of-type(2) h3");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("more padding");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  const [n] = await notes(page);
  assert.match(n.targets[0], /article/);
  assert.doesNotMatch(n.targets[0], /h3/);
  await page.close();
});

test("Esc cancels, then exits review mode; clicks reach the page again", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await page.keyboard.press("Escape");
  assert.equal(await cardOpen(f), false);
  await page.waitForFunction(() => window.__harness.draft === null);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__harness.enabled === false);
  await clickAt(page, f, "#menu");
  assert.equal(await f.evaluate(() => window.pageClicks), 1);
  await page.close();
});

test("mod+shift+M inside the page toggles review mode", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta"); // focus lands in the card
  await page.keyboard.press(`${MOD}+Shift+KeyM`);
  await page.waitForFunction(() => window.__harness.enabled === false);
  await page.close();
});

test("a draft survives a page reload", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await page.keyboard.type("draft text");
  await page.waitForFunction(() => window.__harness.draft?.text === "draft text");
  await page.click("#reload");
  await page.waitForTimeout(100);
  const f2 = await pageFrame(page);
  await f2.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector("textarea").value === "draft text");
  assert.equal(await cardOpen(f2), true);
  await f2.locator("b42-review .card textarea").click();
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  const [n] = await notes(page);
  assert.deepEqual(n.targets, ["#cta"]);
  assert.equal(n.text, "draft text");
  await page.close();
});

test("pins re-attach after a re-render and after a reload", async () => {
  const { page, f } = await open(50);
  await clickAt(page, f, "#cards article:nth-of-type(3) h3");
  await page.keyboard.type("copy v1 -> copy v2");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__harness.notes[0]?.status === "done");
  const pinCount = (fr) => fr.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".pin").length);
  await page.click("#rerender");
  await page.waitForTimeout(100);
  assert.equal(await pinCount(f), 1);
  assert.deepEqual(await page.evaluate(() => window.__harness.unplaced), []);
  await page.click("#reload");
  await page.waitForTimeout(100);
  const f2 = await pageFrame(page);
  await f2.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".pin.done").length === 1);
  await page.close();
});

// Make the harness hold back "captured" so a test can look at the capture moment.
const holdCapture = (page) =>
  page.evaluate(() => {
    const fw = document.getElementById("page").contentWindow;
    const real = fw.__b42.receive;
    window.__release = () => real(window.__held);
    fw.__b42.receive = (m) => (m.type === "captured" ? (window.__held = m) : real(m));
  });
const capState = (f) =>
  f.evaluate(() => {
    const r = document.querySelector("b42-review").shadowRoot;
    return { card: !r.querySelector(".card").hidden, sel: r.querySelectorAll(".box.sel").length, what: r.querySelector(".what").textContent };
  });

test("a click during the capture is held until the screenshot is taken", async () => {
  const { page, f } = await open(5000);
  await holdCapture(page);
  await clickAt(page, f, "#cta");
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  await clickAt(page, f, "#menu"); // fast next click, before "captured"
  let s = await capState(f);
  assert.deepEqual([s.card, s.sel], [false, 1]); // still the first note's outline only
  await page.evaluate(() => window.__release());
  await f.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".card").hidden);
  s = await capState(f);
  assert.deepEqual([s.card, s.sel, s.what], [true, 1, "Button · Menu"]);
  await page.close();
});

test("pins re-find their element by text when the selector now points elsewhere", async () => {
  const { page, f } = await open(50);
  await clickAt(page, f, "#cards article:nth-of-type(3) h3"); // "Review"
  await page.keyboard.type("copy");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__harness.notes[0]?.status === "done");
  // Reorder the cards, as an agent edit might: nth-of-type(3) is now "Annotate".
  await f.evaluate(() => {
    const c = document.getElementById("cards");
    c.replaceChildren(...[...c.children].reverse().map((n) => n.cloneNode(true)));
  });
  await page.waitForTimeout(150);
  const pin = await f.evaluate(() => {
    const p = document.querySelector("b42-review").shadowRoot.querySelector(".pin").getBoundingClientRect();
    const h = [...document.querySelectorAll("#cards h3")].find((x) => x.textContent === "Review").getBoundingClientRect();
    // The pin's centre sits just outside the heading's top-left corner (see pinPoint).
    return { dx: Math.abs(p.left + p.width / 2 - h.left), dy: Math.abs(p.top + p.height / 2 - h.top) };
  });
  assert.ok(pin.dx < 16 && pin.dy < 16, `pin is ${pin.dx},${pin.dy} px from the "Review" heading`);
  // Remove that card entirely (selector and text both miss now): the pin stays at its old spot,
  // dimmed, and is reported unplaced. (If only the text changed, the selector still wins: that's
  // what a "copy v1 -> v2" note does to its own element.)
  await f.evaluate(() => [...document.querySelectorAll("#cards h3")].find((x) => x.textContent === "Review").closest("article").remove());
  await page.waitForFunction(() => window.__harness.unplaced.length === 1);
  assert.equal(await f.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".pin.approx").length), 1);
  await page.close();
});

test("screenshot moment: card and pins hidden, outline kept", async () => {
  const { page, f } = await open(5000);
  await clickAt(page, f, "#cta");
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  // Second note: freeze the host's "captured" reply to inspect the capture state.
  await page.evaluate(() => {
    const fw = document.getElementById("page").contentWindow;
    const real = fw.__b42.receive;
    fw.__b42.receive = (m) => (m.type === "captured" ? (window.__held = m) : real(m));
  });
  await clickAt(page, f, "#menu");
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await waitNotes(page, 2);
  const state = await f.evaluate(() => {
    const r = document.querySelector("b42-review").shadowRoot;
    return { card: !r.querySelector(".card").hidden, pins: r.querySelectorAll(".pin").length, sel: r.querySelectorAll(".box.sel").length };
  });
  assert.deepEqual(state, { card: false, pins: 0, sel: 1 });
  await page.close();
});
