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

const root = (f, fn, arg) => f.evaluate(`(${fn})(document.querySelector("b42-review").shadowRoot, ${JSON.stringify(arg ?? null)})`);
const frames = (f, n = 2) => f.evaluate((k) => new Promise((done) => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : done());
  step();
}), n);
const altDrag = async (page, x0, y0, x1, y1, steps = 30) => {
  await page.keyboard.down("Alt");
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps });
  await page.mouse.up();
  await page.keyboard.up("Alt");
};

test("a note the host refuses does not look sent: the card comes back with its words and says why", async () => {
  const { page, f } = await open();
  await page.evaluate(() => (window.__harness.refuse = "there is nothing in it the app can send"));
  await clickAt(page, f, "#cta");
  await page.keyboard.type("make it bigger");
  await page.keyboard.press("Enter");
  await f.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector(".hint.warn"));
  const s = await root(f, (r) => ({
    card: !r.querySelector(".card").hidden, text: r.querySelector("textarea").value, hint: r.querySelector(".hint").textContent,
    sent: !r.querySelector(".sent").hidden, sel: r.querySelectorAll(".box.sel").length, busy: window.__b42.busy(), typing: r.activeElement === r.querySelector("textarea"),
  }));
  assert.deepEqual(s, { card: true, text: "make it bigger", hint: "Not sent: there is nothing in it the app can send", sent: false, sel: 1, busy: true, typing: true });
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  await page.waitForFunction(() => window.__harness.draft?.text === "make it bigger");
  // The old two-second timer must not call it sent after all.
  await page.waitForTimeout(2200);
  assert.deepEqual(await root(f, (r) => [!r.querySelector(".card").hidden, r.querySelector("textarea").value, r.querySelector(".sent").hidden]), [true, "make it bigger", true]);
  // Typing takes the reason away; the same note goes once the host takes it.
  await page.evaluate(() => (window.__harness.refuse = ""));
  await page.keyboard.type("!");
  assert.equal(await root(f, (r) => r.querySelector(".hint").className), "hint");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  assert.equal((await notes(page))[0].text, "make it bigger!");
  await f.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector(".card").hidden);
  await page.close();
});

test("a note being made costs nothing while nothing moves: no stroke is written again, nothing in the layer changes", async () => {
  const { page, f } = await open();
  const count = async (n) => {
    await f.evaluate(() => {
      const w = (window.__w = { d: 0, records: 0, obs: null });
      const real = (window.__realSet ||= Element.prototype.setAttribute);
      Element.prototype.setAttribute = function (k, v) {
        if (k === "d") w.d++;
        return real.call(this, k, v);
      };
      w.obs = new MutationObserver((list) => (w.records += list.length));
      w.obs.observe(document.querySelector("b42-review").shadowRoot, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await frames(f, n);
    return f.evaluate(() => {
      const w = window.__w;
      w.records += w.obs.takeRecords().length;
      w.obs.disconnect();
      Element.prototype.setAttribute = window.__realSet;
      return { d: w.d, records: w.records };
    });
  };
  const ds = () => root(f, (r) => [...r.querySelectorAll(".strokes path")].map((p) => p.getAttribute("d").length));
  // A selection with its card open, and no pins.
  await clickAt(page, f, "#cta");
  await frames(f, 40); // past the half second in which the pointer still counts as moving
  assert.deepEqual(await count(20), { d: 0, records: 0 });
  // Three strokes, each above the last (the card opens under them): drawn once each.
  await page.keyboard.press("Escape");
  for (let i = 0; i < 3; i++) await altDrag(page, 300 + i * 20, 420 - i * 40, 700, 440 - i * 40);
  await frames(f, 40);
  const three = await ds();
  assert.equal(three.length, 3);
  assert.deepEqual(await count(20), { d: 0, records: 0 });
  // The stroke being drawn grows on screen as it is drawn.
  await page.keyboard.down("Alt");
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(400, 290, { steps: 10 });
  await frames(f, 2);
  const short = (await ds())[3];
  await page.mouse.move(700, 280, { steps: 20 });
  await frames(f, 2);
  const long = (await ds())[3];
  await page.mouse.up();
  await page.keyboard.up("Alt");
  assert.ok(short > 0 && long > short, `the fourth path grew: ${short} → ${long}`);
  // Undo drops the last one; a new one drawn into its path element is that new one.
  await page.keyboard.press(`${MOD}+z`);
  await frames(f, 2);
  assert.deepEqual(await ds(), three);
  await altDrag(page, 320, 260, 420, 250, 8);
  await frames(f, 2);
  const four = await ds();
  assert.deepEqual(four.slice(0, 3), three);
  assert.ok(four[3] > 0 && four[3] < long, "the redrawn fourth stroke is the short new one, not the undone one");
  // The card still sits under the strokes after a scroll (their boxes are kept in page coordinates).
  const before = await root(f, (r) => r.querySelector(".card").getBoundingClientRect().top);
  await f.evaluate(() => { document.body.style.minHeight = "3000px"; window.scrollTo(0, 120); });
  await frames(f, 3);
  assert.equal(Math.round(before - (await root(f, (r) => r.querySelector(".card").getBoundingClientRect().top))), 120);
  // Scrolling moves the ink as one layer: nothing inside it is written, and it stays on the page.
  const inkAt = () => root(f, (r) => r.querySelector(".strokes path").getBoundingClientRect().top);
  const top = await inkAt();
  await f.evaluate(() => {
    const svg = document.querySelector("b42-review").shadowRoot.querySelector(".ink");
    window.__ink = 0;
    // What is written inside the picture; its own transform is the one thing that may change.
    window.__inkObs = new MutationObserver((list) => (window.__ink += list.filter((m) => m.target !== svg).length));
    window.__inkObs.observe(svg, { subtree: true, childList: true, attributes: true });
  });
  for (let y = 140; y <= 300; y += 40) {
    await f.evaluate((to) => window.scrollTo(0, to), y);
    await frames(f, 2);
  }
  const ink = await f.evaluate(() => {
    const svg = document.querySelector("b42-review").shadowRoot.querySelector(".ink");
    window.__inkObs.disconnect();
    return { inside: window.__ink, layer: getComputedStyle(svg).willChange, at: svg.style.transform };
  });
  assert.deepEqual(ink, { inside: 0, layer: "transform", at: "translate(0px, -300px)" });
  assert.equal(Math.round(top - (await inkAt())), 180);
  await page.close();
});

test("a pin whose element is gone is looked for less and less often on a page that keeps changing", async () => {
  const { page, f } = await open();
  await f.evaluate(() => {
    window.__searches = 0;
    const real = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (s) {
      if (this === document.body) window.__searches++;
      return real.call(this, s);
    };
    // A page that never rests: one text node changes every frame.
    const t = document.querySelector(".hero p").firstChild;
    let i = 0;
    (function tick() {
      t.data = `Acme helps small teams review UI changes before they land. ${++i}`;
      requestAnimationFrame(tick);
    })();
    window.__b42.receive({ type: "pins", pins: [{ id: "gone", n: 1, status: "queued", selector: "#no-such-element", tag: "p", text: "No such words anywhere", at: [100, 100] }] });
  });
  await page.waitForFunction(() => window.__harness.unplaced.length === 1);
  await page.waitForTimeout(1000);
  const first = await f.evaluate(() => window.__searches);
  assert.ok(first >= 2 && first <= 12, `${first} searches in the first second (without the back-off: one per redraw, about 30)`);
  await page.waitForTimeout(2000);
  const later = (await f.evaluate(() => window.__searches)) - first;
  assert.ok(later >= 1 && later <= 4, `${later} searches in the next two seconds`);
  // It is still found the moment it appears.
  await f.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "No such words anywhere";
    document.querySelector(".hero").append(p);
  });
  await page.waitForFunction(() => window.__harness.unplaced.length === 0, null, { timeout: 1500 });
  await page.close();
});

test("an area selects what is inside it on a page of more than 10,000 elements", async () => {
  const { page, f } = await open();
  await f.evaluate(() => {
    const d = document.createElement("div");
    d.hidden = true;
    d.innerHTML = "<i></i>".repeat(10500);
    document.body.prepend(d);
  });
  const bs = await Promise.all([1, 2, 3, 4, 5].map((i) => box(f, `.toolbar button:nth-child(${i})`)));
  const x0 = Math.min(...bs.map((b) => b.x)) - 4, y0 = Math.min(...bs.map((b) => b.y)) - 4;
  const x1 = Math.max(...bs.map((b) => b.x + b.width)) + 4, y1 = Math.max(...bs.map((b) => b.y + b.height)) + 4;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.type("same style");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  assert.equal((await notes(page))[0].targets.length, 5);
  await page.close();
});
