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
async function open(dpr = 1) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: dpr });
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
/** The pane's outlines on the page, in the window's layer and in the one that scrolls with the
 *  document: where each is and what it is. */
const LAYERS = ["b42-review", "b42-marks"];
const outlines = (f, sel = ".box.fx:not(.mk)") => f.evaluate(([s, layers]) => layers.flatMap((h) => [...(document.querySelector(h)?.shadowRoot.querySelectorAll(s) ?? [])]).map((b) => {
  const r = b.getBoundingClientRect();
  return { cls: b.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}), [sel, LAYERS]);
const marks = (f) => outlines(f, ".box.fx.mk");
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
  assert.deepEqual(v.small.items.map((i) => [i.label, i.detail]), [["Email", "14 px"]]);
  assert.equal(v.marks, false); // (off until the host asks)
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

/** Count what is read of the page from now on (the layer's reads and the test's own): how many
 *  times the document is walked (a walk starts at the body's box), boxes and styles read, and
 *  each element's text. `reads` gives the counts and starts them again. */
const counting = (f) => f.evaluate(() => {
  const c = (window.__reads = { scans: 0, rects: 0, styles: 0, text: new Map() });
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    c.rects++;
    if (this === document.body) c.scans++;
    return rect.call(this);
  };
  const style = window.getComputedStyle;
  window.getComputedStyle = function (...a) {
    c.styles++;
    return style.apply(this, a);
  };
  const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  Object.defineProperty(Node.prototype, "textContent", { ...text, get() {
    c.text.set(this, (c.text.get(this) || 0) + 1);
    return text.get.call(this);
  } });
});
const reads = (f) => f.evaluate(() => {
  const c = window.__reads;
  const out = { scans: c.scans, rects: c.rects, styles: c.styles };
  c.scans = c.rects = c.styles = 0;
  c.text.clear();
  return out;
});

test("what animates in is in the facts once it is there: the page is looked at again when an animation or a transition ends, a script's too, with no change to the page; one that never ends asks for nothing", async () => {
  const { page, f, errors } = await open();
  // Three small buttons that are not there yet (opacity 0, as an entry animation holds what it
  // has not brought in), each animation held at its start; and a spinner that turns for ever.
  await f.evaluate(() => {
    document.head.append(Object.assign(document.createElement("style"), { textContent: "@keyframes in { from { opacity: 0 } to { opacity: 1 } } @keyframes turn { to { rotate: 360deg } } .in { animation: in 200ms both } .tr { opacity: 0; transition: opacity 200ms 1200ms } .tr.on { opacity: 1 } .spin { display: inline-block; width: 12px; height: 12px; animation: turn 300ms linear infinite }" }));
    document.getElementById("more").insertAdjacentHTML("beforeend", `<button class="close in" id="by-css">Css</button><button class="close" id="by-script">Script</button><button class="close tr" id="by-transition">Transition</button><i class="spin"></i>`);
    document.getElementById("by-script").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "both" });
    for (const id of ["by-css", "by-script"]) for (const a of document.getElementById(id).getAnimations()) a.pause();
  });
  await act(page, { type: "view" });
  await until(page, "(v) => v.taps.total > 0");
  const labels = async () => (await view(page)).taps.items.map((i) => i.label);
  const first = await labels();
  for (const no of ["Css", "Script", "Transition"]) assert.ok(!first.includes(no), `${no} in ${first.join(", ")}`);
  // The spinner turns and nothing else happens: the page is not looked at again.
  await page.waitForTimeout(500); // (a look the first one's own sending may have asked for)
  await counting(f);
  await page.waitForTimeout(1200);
  assert.equal((await reads(f)).scans, 0);
  // The animations run to their ends. Nothing of the page's tree changes: only their ends say so.
  await f.evaluate(() => {
    for (const id of ["by-css", "by-script"]) for (const a of document.getElementById(id).getAnimations()) a.play();
  });
  await page.waitForFunction(() => { const v = window.__harness.view("facts"); return ["Css", "Script"].every((l) => v.taps.items.some((i) => i.label === l)); }, null, { timeout: 6000 });
  // A transition with a long wait before it: the class that starts it is a change, and the look
  // that follows finds the button still not there; the transition's end brings the next.
  await f.evaluate(() => document.getElementById("by-transition").classList.add("on"));
  await page.waitForFunction(() => window.__harness.view("facts").taps.items.some((i) => i.label === "Transition"), null, { timeout: 6000 });
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
  assert.deepEqual(await outlines(f), [{ cls: "box fx k-taps", ...tiny }]);
  await act(page, { type: "hover", id: null });
  await frames(f);
  assert.deepEqual(await outlines(f), []);

  // Preview: review off, and the outline is still drawn.
  await page.evaluate(() => document.getElementById("toggle").click());
  await page.waitForFunction(() => !window.__harness.enabled);
  await act(page, { type: "hover", id: idOf(v, "Email") });
  await frames(f);
  assert.deepEqual((await outlines(f)).map((o) => o.cls), ["box fx k-small"]);
  await act(page, { type: "hover", id: null });

  // Show: scrolled into view, flashed, then drawn no more.
  await f.evaluate(() => (document.getElementById("more").style.height = "2000px"));
  await f.evaluate(() => window.scrollTo(0, 2000));
  await act(page, { type: "show", id: idOf(v, "Email") });
  await f.waitForFunction(() => {
    const r = document.getElementById("small").getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
  await frames(f); // (scrolled by the act; the outlines are drawn in the frame after)
  assert.deepEqual((await outlines(f)).map((o) => o.cls), ["box fx flash k-small"]);
  await f.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".box.fx") && !document.querySelector("b42-marks")?.shadowRoot.querySelector(".box.fx"), null, { timeout: 3000 });
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

test("marks: on, every listed element has a quiet outline in its kind's tone; the hovered row's is the strong one; off and stop take them away", async () => {
  const { page, f, errors } = await open();
  await act(page, { type: "view", marks: true });
  await until(page, "(v) => v.small.total > 0 && v.marks");
  const v = await view(page);
  const kinds = [...v.wide.items.map(() => "k-wide"), ...v.taps.items.map(() => "k-taps"), ...v.small.items.map(() => "k-small")].sort();
  await frames(f);
  let m = await marks(f);
  assert.deepEqual(m.map((o) => o.cls.split(" ").at(-1)).sort(), kinds);
  assert.ok(m.every((o) => /^box fx mk k-/.test(o.cls)), JSON.stringify(m));
  assert.ok(m.some((o) => o.cls.endsWith("k-wide")) && m.some((o) => o.cls.endsWith("k-taps")) && m.some((o) => o.cls.endsWith("k-small")));
  // The banner's mark is where the banner is, and follows a scroll.
  const banner = await rect(f, "#wide");
  assert.ok(m.some((o) => o.cls.endsWith("k-wide") && o.x === banner.x && o.y === banner.y && o.w === banner.w), JSON.stringify(m));
  const marksDom = () => f.evaluate(() => getComputedStyle(document.querySelector("b42-marks").shadowRoot.querySelector(".box.fx.mk")).pointerEvents);
  assert.equal(await marksDom(), "none");
  await f.evaluate(() => (document.getElementById("more").style.height = "2000px"));
  await f.evaluate(() => window.scrollTo(0, 50));
  await frames(f, 3);
  const scrolled = (await marks(f)).find((o) => o.cls.endsWith("k-wide"));
  assert.equal(scrolled.y, (await rect(f, "#wide")).y);
  await f.evaluate(() => window.scrollTo(0, 0));

  // The row under the pointer: its element strong, not marked twice.
  await act(page, { type: "hover", id: idOf(v, "Close") });
  await frames(f);
  assert.deepEqual(await outlines(f), [{ cls: "box fx k-taps", ...(await rect(f, "#tiny")) }]);
  assert.equal((await marks(f)).length, kinds.length - 1);
  await act(page, { type: "hover", id: null });
  await frames(f);
  assert.equal((await marks(f)).length, kinds.length);

  // Off: none; the view says so.
  await act(page, { type: "marks", on: false });
  await until(page, "(v) => v.marks === false");
  await frames(f);
  assert.deepEqual(await marks(f), []);
  await act(page, { type: "marks", on: true });
  await until(page, "(v) => v.marks === true");
  await frames(f);
  assert.equal((await marks(f)).length, kinds.length);

  // Stop: none, and none again until the next view.
  await act(page, { type: "stop" });
  await page.waitForFunction(() => window.__harness.view("facts") === null);
  await frames(f);
  assert.deepEqual(await marks(f), []);
  assert.deepEqual(errors, []);
  await page.close();
});

test("marks never trail a scroll: those that scroll with the document are in its layer, there in the same frame; one in a scroller of its own follows it", async () => {
  const { page, f, errors } = await open();
  await f.evaluate(() => {
    document.getElementById("more").style.height = "2000px";
    // A tap target in a box that scrolls on its own, and one in a fixed bar.
    document.getElementById("more").insertAdjacentHTML("beforebegin", `<div id="scroller" style="height:60px;overflow:auto"><div style="height:200px;padding-top:80px"><button id="inner" style="width:24px;height:24px">i</button></div></div><div style="position:fixed;bottom:0;left:0"><button id="pinned" style="width:24px;height:24px">p</button></div>`);
  });
  await act(page, { type: "view", marks: true });
  await until(page, "(v) => v.taps.items.length >= 4");
  await frames(f);
  const layers = await f.evaluate(() => Object.fromEntries(["b42-review", "b42-marks"].map((h) => [h, document.querySelector(h)?.shadowRoot.querySelectorAll(".box.fx.mk").length ?? 0])));
  const v = await view(page);
  const all = v.wide.items.length + v.taps.items.length + v.small.items.length;
  assert.equal(layers["b42-review"], 2, JSON.stringify(layers)); // the scroller's and the fixed bar's
  assert.equal(layers["b42-marks"], all - 2, JSON.stringify(layers));
  // Scrolled, and read in the same task: no frame has been drawn since, and the marks are there.
  const at = await f.evaluate(() => {
    const out = [];
    for (const y of [137, 400, 0]) {
      window.scrollTo(0, y);
      const el = document.getElementById("wide").getBoundingClientRect();
      const m = [...document.querySelector("b42-marks").shadowRoot.querySelectorAll(".box.fx.mk.k-wide")].map((b) => b.getBoundingClientRect())
        .find((r) => Math.abs(r.width - el.width) < 1);
      out.push([Math.round(el.x), Math.round(el.y), m && Math.round(m.x), m && Math.round(m.y)]);
    }
    return out;
  });
  for (const [x, y, mx, my] of at) assert.deepEqual([mx, my], [x, y], JSON.stringify(at));
  // The scroller's: placed in the window, where its button is a frame after the scroller scrolls.
  await f.evaluate(() => (document.getElementById("scroller").scrollTop = 50));
  await frames(f, 3);
  const inner = await rect(f, "#inner");
  assert.ok((await marks(f)).some((o) => o.x === inner.x && o.y === inner.y && o.w === inner.w), JSON.stringify(await marks(f)));
  // Off: the document's layer is empty (and stays: a row pointed at is no change to the page's
  // tree); the pane's stop takes it out.
  await act(page, { type: "marks", on: false });
  await until(page, "(v) => v.marks === false");
  await frames(f);
  assert.equal(await f.evaluate(() => document.querySelector("b42-marks")?.shadowRoot.querySelector(".boxes").childElementCount), 0);
  await act(page, { type: "stop" });
  await page.waitForFunction(() => window.__harness.view("facts") === null);
  assert.equal(await f.evaluate(() => !!document.querySelector("b42-marks")), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the layer adds nothing to the page's scrollable size: a mark in the document's layer never reaches past its element, at any pixel ratio", async () => {
  for (const dpr of [1, 1.5, 2]) {
    const { page, f, errors } = await open(dpr);
    // A page taller than its frame whose last thing is a small button: its right edge is the
    // banner's, its bottom edge the button's, each a part of a pixel in.
    await f.evaluate(() => {
      document.body.style.paddingBottom = "0";
      document.getElementById("more").style.height = "1200px";
      document.body.insertAdjacentHTML("beforeend", `<button id="last" class="close" style="display:block;margin:0"></button>`);
    });
    await act(page, { type: "view", marks: true });
    for (const part of [0, 0.25, 0.375, 0.4375, 0.75]) {
      await f.evaluate((p) => {
        document.getElementById("wide").style.width = `${520 + p}px`;
        document.getElementById("last").style.height = `${24 + p}px`;
      }, part);
      await act(page, { type: "refresh" });
      // (Parts of a pixel that a layout keeps exactly: sixty-fourths.)
      await f.waitForFunction((w) => document.getElementById("wide").getBoundingClientRect().width === w && [...(document.querySelector("b42-marks")?.shadowRoot.querySelectorAll(".box.fx.mk.k-wide") ?? [])].some((b) => Math.abs(b.getBoundingClientRect().width - w) < 1), 520 + part);
      await frames(f);
      const size = await f.evaluate(() => {
        const de = document.documentElement, layers = [document.querySelector("b42-marks"), document.querySelector("b42-review")];
        const marks = layers[0].shadowRoot.querySelectorAll(".box.fx.mk").length;
        const withThem = [de.scrollWidth, de.scrollHeight];
        for (const l of layers) l.style.display = "none";
        const without = [de.scrollWidth, de.scrollHeight];
        for (const l of layers) l.style.display = "block";
        return { marks, withThem, without };
      });
      assert.ok(size.marks >= 3, JSON.stringify(size));
      assert.deepEqual(size.withThem, size.without, `at ${dpr}x, ${part} of a pixel in`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("marks are not in a note's screenshot", async () => {
  const { page, f, errors } = await open();
  await act(page, { type: "view", marks: true });
  await until(page, "(v) => v.small.total > 0");
  await frames(f);
  const n = (await marks(f)).length;
  assert.ok(n > 0);
  // Hold the host's "captured" so the capture moment can be looked at.
  await page.evaluate(() => {
    const fw = document.getElementById("page").contentWindow;
    const real = fw.__b42.receive;
    window.__release = () => real(window.__held);
    fw.__b42.receive = (m) => (m.type === "captured" ? (window.__held = m) : real(m));
  });
  const b = await f.locator("#big").boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // (a frame's box is the page's)
  await page.keyboard.type("bigger");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  await frames(f);
  assert.deepEqual(await marks(f), []);
  await page.evaluate(() => window.__release());
  await f.waitForFunction((k) => document.querySelector("b42-marks")?.shadowRoot.querySelectorAll(".box.fx.mk").length === k, n);
  assert.deepEqual(errors, []);
  await page.close();
});

test("an edit made in canvas mode's inspector to a page element counts: the tap target it fixes leaves the list", async () => {
  const { page, f, errors } = await open();
  await page.evaluate(() => window.__harness.hostDocks(["facts", "canvas"]));
  await act(page, { type: "view" });
  await until(page, "(v) => v.taps.items.some((i) => i.label === 'Close')");
  const before = (await view(page)).taps.total;
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await page.waitForFunction(() => window.__harness.panel.some((m) => m.panel === "canvas" && m.view));
  // Select the close button, as a click on it does, then type its new size into the inspector.
  const b = await f.locator("#tiny").boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // (a frame's box is the page's)
  const id = await (await page.waitForFunction(() => window.__harness.panel.filter((m) => m.panel === "canvas" && m.view).at(-1)?.view?.sel?.id)).jsonValue();
  await page.evaluate((x) => window.__harness.act("canvas", { type: "text", field: "css", id: x, text: "width: 48px;\nheight: 48px;" }), id);
  await f.waitForFunction(() => document.getElementById("tiny").getBoundingClientRect().width === 48);
  // (No DOM change of the page's: the edit is an adopted rule.)
  await until(page, `(v) => v.taps.total === ${before - 1} && !v.taps.items.some((i) => i.label === 'Close')`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("kind: the pointer on a count marks that kind's elements only, and only while it is there, marks off", async () => {
  const { page, f, errors } = await open();
  await act(page, { type: "view" });
  await until(page, "(v) => v.small.total > 0");
  const v = await view(page);
  await frames(f);
  assert.deepEqual(await marks(f), []);
  await act(page, { type: "kind", kind: "taps" });
  await frames(f);
  let m = await marks(f);
  assert.equal(m.length, v.taps.items.length);
  assert.ok(m.every((o) => o.cls === "box fx mk lit k-taps"), JSON.stringify(m));
  await act(page, { type: "kind", kind: null });
  await frames(f);
  assert.deepEqual(await marks(f), []);

  // Marks on: every kind stays marked; the one under the pointer is the stronger.
  await act(page, { type: "marks", on: true });
  await act(page, { type: "kind", kind: "small" });
  await frames(f);
  m = await marks(f);
  assert.equal(m.length, v.wide.items.length + v.taps.items.length + v.small.items.length);
  assert.deepEqual(m.filter((o) => o.cls.includes(" lit ")).map((o) => o.cls), ["box fx mk lit k-small"]);
  await act(page, { type: "kind", kind: null });
  await act(page, { type: "marks", on: false });
  assert.deepEqual(errors, []);
  await page.close();
});

test("show, one listed element after another (the line's click): each scrolled into view and flashed; in canvas mode the selection stays", async () => {
  const { page, f, errors } = await open();
  await page.evaluate(() => window.__harness.hostDocks(["facts", "canvas"]));
  await act(page, { type: "view" });
  await until(page, "(v) => v.taps.items.some((i) => i.label === 'Close')");
  const v = await view(page);
  await f.evaluate(() => (document.getElementById("more").style.height = "2000px"));
  const inView = (id) => f.evaluate((x) => {
    const r = document.getElementById(x).getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }, id);
  for (const it of v.taps.items) {
    await f.evaluate(() => window.scrollTo(0, 2000));
    await act(page, { type: "show", id: it.id });
    // (The act reaches the page by message, later: the scroll it makes is the sign it was done.
    // The flash of the one before may still be on: it is not that sign.)
    await f.waitForFunction(() => scrollY < 2000);
    await frames(f);
    assert.deepEqual((await outlines(f)).map((o) => o.cls), ["box fx flash k-taps"]);
  }
  assert.ok(await inView("tiny")); // the last one, Close
  // In canvas mode a show brings the element into view and selects nothing.
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await page.waitForFunction(() => window.__harness.panel.some((m) => m.panel === "canvas" && m.view));
  await f.evaluate(() => window.scrollTo(0, 2000));
  await act(page, { type: "show", id: idOf(v, "Close") });
  await f.waitForFunction(() => scrollY < 2000);
  await frames(f, 3);
  assert.equal(await page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "canvas" && m.view).at(-1).view.sel), null);
  assert.ok(await inView("tiny"));
  assert.deepEqual(errors, []);
  await page.close();
});
