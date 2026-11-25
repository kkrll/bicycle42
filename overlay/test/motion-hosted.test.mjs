// End-to-end tests for motion mode's dock when the host draws it (src/motion/host.js): the
// harness plays a host that draws the dock (__harness.hostDocks), reads the views the overlay
// sends (__harness.panel) and acts in the dock (__harness.act). The page is
// harness/motion-page.html, as in motion.test.mjs (which has what motion mode does on the page,
// driven the same way). Run: bun run test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { serve } from "../scripts/serve.mjs";
import { build } from "../scripts/build.mjs";

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

async function pageFrame(page) {
  await page.waitForFunction(() => document.getElementById("page").contentWindow?.__b42);
  const f = page.frames().find((fr) => fr.url().endsWith("/harness/motion-page.html"));
  await f.waitForFunction(() => document.querySelector("b42-review") && document.documentElement.hasAttribute("data-b42-review"));
  return f;
}
const frames = (f, n = 2) => f.evaluate((k) => new Promise((done) => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : done());
  step();
}), n);
/** Every rule the page has adopted from us (the unsent sheet and the sent ones), as text. */
const adopted = (f) => f.evaluate(() => document.adoptedStyleSheets.map((s) => [...s.cssRules].map((r) => r.cssText).join("\n")).join("\n"));
const views = (page) => page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).length);
/** The last view the overlay sent, once `fn` (its source, run on the view) holds for it. */
async function view(page, fn = "true", timeout = 3000) {
  await page.waitForFunction((src) => {
    const v = window.__harness.panel.filter((m) => m.panel === "motion" && m.view).at(-1)?.view;
    return !!v && new Function("v", `return (${src})`)(v);
  }, fn, { timeout });
  return page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).at(-1).view);
}
const act = (page, a) => page.evaluate((x) => window.__harness.act("motion", x), a);
const rowId = (v, text) => v.rows.find((r) => r.text === text && !r.sub)?.id;

/** The motion page in motion mode, its dock the host's. `before` (its source, run in the page)
 *  changes the page first, while it is still in notes mode. */
async function open({ delay = 150, before = "" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=${delay}&page=motion`);
  const f = await pageFrame(page);
  if (before) await f.evaluate(before);
  await page.evaluate(() => window.__harness.hostDocks(["motion"]));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  const v = await view(page, "v.on && v.rows.length > 0");
  return { page, f, errors, v };
}

test("hosted: the view lists what moves, and opening a row says everything the dock shows of it", async () => {
  const { page, f, errors, v } = await open();
  const names = v.rows.map((r) => r.group ? `#${r.group}` : r.text);
  for (const want of ["#Animations", "spin", "rise", "pulse", "card-in", "#Transitions", "#Scripts", "bob", "#Unused", "wiggle"]) assert.ok(names.includes(want), `${want} in ${names.join(" ")}`);
  // rise is played by two elements: they are listed under it, with ids of their own
  const rise = v.rows.findIndex((r) => r.text === "rise");
  assert.equal(v.rows[rise + 1].sub, true);
  assert.notEqual(v.rows[rise + 1].id, v.rows[rise + 2].id);
  assert.equal(v.open, null);
  // (the whole page was looked at: keyframes nothing plays are unused)
  assert.equal(v.partial, false);
  // the pointer over a row outlines its elements on the page
  await act(page, { type: "hover", id: rowId(v, "rise") });
  await frames(f, 3);
  assert.equal(await f.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".box.mrow").length), 2);
  await act(page, { type: "hover", id: null });
  // open the heading's rise: its timing, its lanes, its keyframes as text
  await act(page, { type: "row", id: v.rows[rise + 1].id });
  const o = (await view(page, "v.open && v.open.name === 'rise'")).open;
  assert.equal(o.kind, "css");
  assert.equal(o.readOnly, false);
  assert.equal(o.shared, 2);
  assert.deepEqual(o.timing, { duration: 700, delay: 0, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", count: "1", direction: "normal", fill: "both" });
  assert.deepEqual(o.lanes.map((l) => l.prop).sort(), ["opacity", "transform"]);
  assert.deepEqual(o.lanes.find((l) => l.prop === "opacity").keys, [{ at: 0, value: "0" }, { at: 100, value: "1" }]);
  assert.deepEqual(o.frames, [0, 100]);
  assert.match(o.css, /^@keyframes rise \{/);
  assert.equal(o.dirty, false);
  const after = await view(page);
  assert.match(after.sel, /Ship calmer interfaces/);
  assert.ok(after.rows.find((r) => r.id === v.rows[rise + 1].id).on);
  assert.ok(after.choices.easings.length > 3 && after.choices.props.includes("opacity") === false);
  // the page still shows its outline and the name tag
  await frames(f, 3);
  assert.equal(await f.evaluate(() => !document.querySelector("b42-review").shadowRoot.querySelector(".m-tag").hidden), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a page too large to look at whole says so, lists what plays past where the look stopped, and calls no keyframes unused", async () => {
  // 4,100 elements ahead of everything that moves, and keyframes an element at the end played
  // once and is done with (nothing holds its last frame: the page no longer lists it as playing).
  const { page, errors, v } = await open({ before: `(async () => {
    const st = document.createElement("style");
    st.textContent = "@keyframes blink { to { opacity: 0.5; } } .once { animation: blink 30ms; }";
    document.head.append(st);
    const box = document.createElement("div");
    box.hidden = true;
    box.innerHTML = "<i></i>".repeat(4100);
    document.body.prepend(box);
    const once = document.createElement("p");
    once.className = "once";
    once.textContent = "Played once";
    document.body.append(once);
    await Promise.all(once.getAnimations().map((a) => a.finished));
  })()` });
  assert.equal(v.partial, true);
  const under = (group) => {
    const i = v.rows.findIndex((r) => r.group === group);
    const n = v.rows.slice(i + 1).findIndex((r) => r.group);
    return i < 0 ? [] : v.rows.slice(i + 1, n < 0 ? undefined : i + 1 + n).filter((r) => !r.sub).map((r) => r.text);
  };
  // What plays now is listed with its element, wherever in the page it is.
  for (const nm of ["spin", "pulse", "rise", "card-in"]) assert.ok(under("Animations").includes(nm), `${nm} in ${under("Animations")}`);
  assert.equal(v.rows.find((r) => r.text === "spin").running, true);
  // What was not seen to play may play further down: it is not called unused.
  assert.equal(v.rows.some((r) => r.group === "Unused"), false, "nothing is called unused");
  assert.deepEqual(under("Not seen playing").sort(), ["blink", "wiggle"]);
  // A row past where the look stopped opens as any other.
  await act(page, { type: "row", id: rowId(v, "spin") });
  const o = (await view(page, "v.open && v.open.name === 'spin'")).open;
  assert.equal(o.timing.duration, 900);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: each act changes the page and the next view; undo takes it back", async () => {
  const { page, f, errors, v } = await open();
  await act(page, { type: "row", id: v.rows[v.rows.findIndex((r) => r.text === "rise") + 2].id }); // the paragraph's rise
  await view(page, "v.open && v.open.name === 'rise'");
  // a duration typed: shown at once, one undo step when done
  await act(page, { type: "timing", what: "duration", value: "9", done: false });
  await act(page, { type: "timing", what: "duration", value: "900", done: false });
  await act(page, { type: "timing", what: "duration", value: "900", done: true });
  let w = await view(page, "v.open.timing.duration === 900 && v.undo");
  // (timing belongs to the element: its animation is written, not the keyframes)
  const css = await adopted(f);
  assert.match(css, /animation: 900ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\) 120ms 1 normal both running rise;/);
  assert.match(css, /section\.hero|body > section/);
  assert.doesNotMatch(css, /@keyframes/);
  assert.equal(w.open.dirty, true);
  // a choice of the "more" sheet
  await act(page, { type: "timing", what: "direction", value: "alternate", done: true });
  await view(page, "v.open.timing.direction === 'alternate'");
  assert.match(await adopted(f), /alternate/);
  // a keyframe grabbed, dragged and let go: one undo step
  await act(page, { type: "select", key: { at: 100, prop: "opacity" }, grab: true });
  for (const to of [95, 85, 75, 60]) await act(page, { type: "drag", to });
  await act(page, { type: "drop" });
  w = await view(page, "v.open.key && v.open.key.at === 60");
  assert.deepEqual(w.open.lanes.find((l) => l.prop === "opacity").keys.filter((k) => !k.implied).map((k) => k.at), [0, 60]);
  assert.match(await adopted(f), /@keyframes rise \{[^]*?60% \{ opacity: 1; \}/);
  // its value
  await act(page, { type: "key", what: "val", value: "0.6", done: true });
  await view(page, "v.open.key && v.open.key.value === '0.6'");
  assert.match(await adopted(f), /60% \{ opacity: 0\.6; \}/);
  // a lane added, a keyframe added where it was pressed twice
  await act(page, { type: "addLane", prop: "scale" });
  w = await view(page, "v.open.lanes.some((l) => l.prop === 'scale')");
  assert.equal(w.choices.props.includes("scale"), false);
  await act(page, { type: "addKey", prop: "scale", at: 50 });
  await view(page, "v.open.lanes.find((l) => l.prop === 'scale').keys.length === 3");
  await act(page, { type: "removeKey" });
  await view(page, "v.open.lanes.find((l) => l.prop === 'scale').keys.length === 2");
  // something that is not a property: the line says so
  await act(page, { type: "addLane", prop: "nonsense" });
  assert.match((await view(page, "v.msg !== ''")).msg, /nonsense is not a property/);
  // the keyframes as text: what is not keyframes is said, and dropped once the field is left
  await act(page, { type: "view", view: "css" });
  await view(page, "v.view === 'css'");
  await act(page, { type: "css", text: "@keyframes rise { from { opacity: 0 } to { opacity: banana } }", done: false });
  assert.match((await view(page, "v.open.cssError !== ''")).open.cssError, /Not a value for opacity/);
  await act(page, { type: "css", text: "@keyframes rise { from { opacity: 0.2 } to { opacity: 1 } }", done: true });
  w = await view(page, "v.open.cssError === '' && /20%|0\\.2/.test(v.open.css)");
  assert.deepEqual(w.open.lanes.map((l) => l.prop), ["opacity"]);
  // speed, loop, show only this one
  await act(page, { type: "rate", rate: 0.25 });
  await act(page, { type: "loop", on: true });
  await act(page, { type: "isolate", on: true });
  w = await view(page, "v.rate === 0.25 && v.loop && v.isolate");
  assert.match(await adopted(f), /visibility: hidden !important/);
  await act(page, { type: "isolate", on: false });
  // undo all the way: the page's own animation again; redo once
  for (let i = 0; i < 12; i++) await act(page, { type: "undo" });
  w = await view(page, "!v.undo && v.redo");
  assert.equal(w.open.timing.duration, 700);
  assert.doesNotMatch(await adopted(f), /rise/);
  await act(page, { type: "redo" });
  assert.equal((await view(page, "v.open.timing.duration === 900")).open.dirty, true);
  // put back as the page has it
  await act(page, { type: "discard" });
  assert.equal((await view(page, "v.open.timing.duration === 700")).open.dirty, false);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: play moves the playhead in the views; seek and step stop it at a frame", async () => {
  const { page, f, errors, v } = await open();
  await act(page, { type: "row", id: rowId(v, "card-in") });
  await view(page, "v.open && v.open.name === 'card-in'");
  await act(page, { type: "seek", p: 0.5 });
  assert.equal((await view(page, "v.clock.pos !== null && Math.abs(v.clock.pos - 0.5) < 0.01")).clock.playing, false);
  await act(page, { type: "step", by: 0.1 });
  await view(page, "Math.abs(v.clock.pos - 0.6) < 0.01");
  // A quarter of the speed: what is left of card-in (200ms) plays for 800ms, so a loaded machine
  // still draws several frames of it.
  await act(page, { type: "rate", rate: 0.25 });
  await view(page, "v.rate === 0.25");
  const n = await views(page);
  await act(page, { type: "play" });
  // (Any view since: the last one may already say it ended, on a machine that polls slowly.)
  await page.waitForFunction((k) => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).slice(k).some((m) => m.view.clock.playing), n);
  const end = await view(page, "!v.clock.playing && v.clock.pos > 0.99", 4000);
  // one view a frame at most, each with the playhead where the page had it
  const sent = await views(page);
  assert.ok(sent - n > 3, `${sent - n} views while it played`);
  // Nothing new to say about the playhead: nothing is sent for it. (The list may still have
  // something new: the page's frame-by-frame bar is listed once it has been seen to move for a
  // while, which on a loaded machine can be now. Such a view says it, and the same clock.)
  await frames(f, 6);
  const after = await page.evaluate((k) => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).slice(k).map((m) => m.view), sent - 1);
  for (let i = 1; i < after.length; i++) {
    const { clock: _, ...before } = after[i - 1], { clock, ...now } = after[i];
    assert.deepEqual(clock, end.clock, "the playhead stays where it ended");
    assert.notDeepEqual(now, before, `view ${i} after the end says nothing new`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a frame that only moved the playhead sends the clock and nothing else; a host that asks gets the whole view again", async () => {
  const { page, f, errors, v } = await open();
  await act(page, { type: "row", id: rowId(v, "card-in") });
  await view(page, "v.open && v.open.name === 'card-in'");
  await act(page, { type: "rate", rate: 0.25 });
  await view(page, "v.rate === 0.25");
  await act(page, { type: "seek", p: 0 });
  await view(page, "v.clock.pos !== null && v.clock.pos < 0.01");
  const raw = () => page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).map((m) => ({ part: m.part ? Object.keys(m.part) : null, pos: m.view.clock.pos, bytes: JSON.stringify(m.part ?? m.view).length })));
  const n = (await raw()).length;
  await act(page, { type: "play" });
  await view(page, "!v.clock.playing && v.clock.pos > 0.99", 4000);
  const played = (await raw()).slice(n);
  // (The list may have something new once, as in the test above: every other message is the clock's.)
  const clocks = played.filter((m) => m.part && m.part.join() === "clock");
  assert.ok(clocks.length > 3 && clocks.length >= played.length - 2, `${clocks.length} of ${played.length} messages were the clock alone: ${JSON.stringify(played.map((m) => m.part))}`);
  assert.ok(clocks.every((m) => m.bytes < 100), `a clock is small: ${clocks.map((m) => m.bytes)}`);
  // The view the host has put together from them is the one the overlay has.
  const whole = await view(page);
  // A host that lost its view asks: the whole one comes, the same.
  const before = (await raw()).length;
  await act(page, { type: "whole" });
  await page.waitForFunction((k) => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).length > k, before);
  const again = await page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).at(-1));
  assert.equal(again.part, undefined, "the whole view, not a part of it");
  assert.deepEqual(again.view, whole);
  // And a host that has none (as one that just started) asks by itself on the first part.
  await page.evaluate(() => (window.__harness.panel.length = 0));
  await act(page, { type: "seek", p: 0.3 });
  const got = await view(page, "Math.abs(v.clock.pos - 0.3) < 0.01");
  assert.deepEqual({ ...got, clock: null }, { ...whole, clock: null });
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a keystroke in the note and a step of a keyframe's drag send only what they changed, and read nothing of the page for the list", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The module is put on the page (two lines more, which run after the overlay's own), so that
  // the list motion mode keeps can be seen to be the one it kept.
  const withMotion = build('import * as Motion from "./motion/api.js";\nwindow.__motion = Motion;');
  await page.route("**/overlay.js", (route) => route.fulfill({ contentType: "text/javascript", body: withMotion }));
  await page.goto(`${base}/?delay=150&page=motion`);
  const f = await pageFrame(page);
  await page.evaluate(() => window.__harness.hostDocks(["motion"]));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  // (The page's bar that a script moves is listed once it has been seen to move: wait for it, so
  // that the list has nothing new to say while the messages are counted.)
  const v = await view(page, "v.on && v.rows.some((r) => r.kind === 'frames')", 5000);
  await act(page, { type: "row", id: v.rows[v.rows.findIndex((r) => r.text === "rise") + 2].id }); // the paragraph's rise
  await view(page, "v.open && v.open.name === 'rise'");
  // (An edit first: the row has its dot already, so the drag below changes nothing in the list.)
  await act(page, { type: "timing", what: "duration", value: "900", done: true });
  const before = await view(page, "v.open.timing.duration === 900 && v.undo && v.rows.some((r) => r.sub && r.dirty)");
  // (And the playhead stopped: a playing one is a clock in every frame, counted in the test above.)
  await act(page, { type: "seek", p: 0.5 });
  await view(page, "!v.clock.playing && v.clock.pos !== null && Math.abs(v.clock.pos - 0.5) < 0.01");
  await frames(f, 3);
  /** Each message since the `n`th: the fields it carried (null: a whole view) and its size. */
  const since = (n) => page.evaluate((k) => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).slice(k).map((m) => ({ part: m.part ? Object.keys(m.part).sort().join() : null, bytes: JSON.stringify(m.part ?? m.view).length })), n);
  // What the list costs to make is read from the page: a computed style for a row's timing, a
  // look at the siblings for its path. Both are counted here, and the list itself is watched.
  await f.evaluate(() => {
    const real = window.getComputedStyle;
    window.getComputedStyle = function (...a) {
      window.__styles++;
      return real.apply(this, a);
    };
    const kids = Object.getOwnPropertyDescriptor(Element.prototype, "children");
    // (Of the page's elements: the layer counts its own boxes in its shadow root when it draws.)
    Object.defineProperty(Element.prototype, "children", { ...kids, get() {
      if (this.getRootNode() === document) window.__siblings++;
      return kids.get.call(this);
    } });
    window.__styles = window.__siblings = 0;
    window.__list = window.__motion.debug.M.list;
  });
  const read = () => f.evaluate(() => {
    const out = { styles: window.__styles, siblings: window.__siblings, listKept: !!window.__list && window.__motion.debug.M.list === window.__list };
    window.__styles = window.__siblings = 0;
    return out;
  });
  // The note, a key at a time: each view is the note's words and nothing else.
  let n = await views(page);
  for (const text of ["s", "sl", "slo", "slow", "slowe", "slower"]) {
    await act(page, { type: "note", text });
    await view(page, `v.note === ${JSON.stringify(text)}`);
  }
  await frames(f, 2);
  const typed = await since(n), typing = await read();
  assert.deepEqual(typed.map((m) => m.part), Array(6).fill("note"), `six keystrokes sent ${JSON.stringify(typed)}`);
  assert.ok(typed.every((m) => m.bytes < 40), `a keystroke is small: ${typed.map((m) => m.bytes)}`);
  assert.deepEqual(typing, { styles: 0, siblings: 0, listKept: true }, "typing the note reads nothing of the page, and the list is the one kept");
  // A keyframe grabbed and dragged: each step is what is open (its lanes, its text) and the
  // playhead, never the list, the choices or anything else.
  await act(page, { type: "select", key: { at: 100, prop: "opacity" }, grab: true });
  await view(page, "v.open.key && v.open.key.at === 100");
  await frames(f, 2);
  await read();
  n = await views(page);
  for (const to of [95, 85, 75, 60]) {
    await act(page, { type: "drag", to });
    await view(page, `v.open.key && v.open.key.at === ${to}`);
  }
  await frames(f, 2);
  const dragged = await since(n), dragging = await read();
  assert.equal(dragged.length, 4);
  // (The first step makes the keyframes unsent: the dot on the animation's own row, and so the
  // list, once. The list is still the one read from the page before: see the reads below.)
  assert.ok(dragged.every((m, i) => m.part === "open" || m.part === "clock,open" || (i === 0 && m.part === "clock,open,rows")), `four steps sent ${JSON.stringify(dragged)}`);
  assert.deepEqual(dragging, { styles: 0, siblings: 0, listKept: true }, "a step of the drag reads nothing of the page for the list, and the list is the one kept");
  // Let go, the page is looked at again (one undo step: commit), and the list is made again. A
  // list that says what it said is not sent again; one that says something new is (the dot of
  // the keyframes now unsent, an animation that has stopped playing since the last look).
  const held = (await view(page)).rows;
  n = await views(page);
  await act(page, { type: "drop" });
  await f.waitForFunction(() => window.__motion.debug.M.list !== window.__list);
  await frames(f, 3);
  const dropped = await since(n), now = (await view(page)).rows;
  assert.ok(dropped.every((m) => m.part !== null), `letting go sent ${JSON.stringify(dropped)}`);
  if (dropped.some((m) => m.part.split(",").includes("rows"))) assert.notDeepEqual(now, held, "a list sent again says something new");
  else assert.deepEqual(now, held);
  const plain = (rows) => rows.map(({ dirty: _, running: __, ...r }) => r);
  assert.deepEqual(plain(now), plain(before.rows));
  // And what says the same in every view went once: after the first view the choices came again
  // only for the animation opened (the properties it does not set yet are what they offer).
  const all = await since(0);
  assert.equal(all.filter((m) => m.part === null).length, 1, "one whole view");
  assert.ok(all.filter((m) => m.part && m.part.split(",").includes("choices")).length <= 1, `the choices went ${JSON.stringify(all.map((m) => m.part))}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: while it plays, the open element is not searched for in the page: it is the selection", async () => {
  const { page, f, errors, v } = await open();
  await act(page, { type: "row", id: rowId(v, "card-in") });
  await view(page, "v.open && v.open.name === 'card-in'");
  await act(page, { type: "rate", rate: 0.25 });
  await view(page, "v.rate === 0.25");
  await act(page, { type: "seek", p: 0 });
  await view(page, "v.clock.pos !== null && v.clock.pos < 0.01");
  await f.evaluate(() => {
    const real = Document.prototype.querySelector;
    window.__finds = 0;
    Document.prototype.querySelector = function (...a) {
      window.__finds++;
      return real.apply(this, a);
    };
    window.__frames = 0;
    const tick = () => (window.__frames++, requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  const n = await views(page);
  await act(page, { type: "play" });
  await view(page, "!v.clock.playing && v.clock.pos > 0.99", 4000);
  const { finds, count } = await f.evaluate(() => ({ finds: window.__finds, count: window.__frames }));
  assert.ok((await views(page)) - n > 3 && count > 3, `${count} frames`);
  assert.ok(finds <= 4, `${finds} searches of the page in ${count} frames`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a row says the reviewer's edits of its element after the page put another element before it", async () => {
  const { page, f, errors, v } = await open();
  // The page changes after the list was read: the spinner is no longer its parent's first <i>,
  // so the path its edits are kept under is another than the one the list was read with.
  await f.evaluate(() => document.querySelector(".sync").prepend(document.createElement("i")));
  await frames(f, 3);
  await act(page, { type: "row", id: rowId(v, "spin") });
  await view(page, "v.open && v.open.name === 'spin'");
  await act(page, { type: "timing", what: "duration", value: "2000", done: false });
  const now = await view(page, "v.open.timing.duration === 2000");
  const row = now.rows.find((r) => r.text === "spin" && !r.sub);
  assert.deepEqual({ on: row.on, dirty: row.dirty, duration: row.duration }, { on: true, dirty: true, duration: 2000 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a new animation, named in the dock; Esc steps back to notes mode", async () => {
  const { page, f, errors } = await open();
  const b = await f.locator(".card h3").first().boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  let w = await view(page, "v.sel && !v.open");
  assert.match(w.sel, /Review/);
  assert.ok(w.names.includes("wiggle"));
  await act(page, { type: "new" });
  w = await view(page, "v.open && v.open.renamable");
  assert.equal(w.open.removable, true);
  await act(page, { type: "name", value: "nudge", done: true });
  await view(page, "v.open.name === 'nudge'");
  assert.match(await adopted(f), /@keyframes nudge/);
  await act(page, { type: "select", key: { at: 0, prop: null } });
  await view(page, "v.open.key && v.open.key.prop === null");
  await act(page, { type: "escape" });
  await view(page, "v.open && !v.open.key");
  await act(page, { type: "escape" });
  await view(page, "!v.open && !v.sel");
  await act(page, { type: "escape" });
  await page.waitForFunction(() => window.__harness.mode === "notes");
  assert.equal((await view(page, "!v.on")).rows.length, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: the note's words and Send make one note; the note field is the overlay's", async () => {
  const { page, f, errors, v } = await open({ delay: 700 });
  await act(page, { type: "row", id: v.rows[v.rows.findIndex((r) => r.text === "rise") + 2].id });
  await view(page, "v.open && v.open.name === 'rise'");
  await act(page, { type: "timing", what: "duration", value: "900", done: true });
  await act(page, { type: "note", text: "calm" });
  await act(page, { type: "note", text: "calmer" });
  assert.equal((await view(page, "v.note === 'calmer'")).note, "calmer");
  // the words are in the draft the host keeps
  await page.waitForFunction(() => window.__harness.draft?.motion?.note === "calmer");
  await act(page, { type: "send", background: true });
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const note = await page.evaluate(() => window.__harness.notes[0]);
  assert.equal(note.text, "calmer");
  assert.equal(note.lane, "bg");
  assert.equal(note.motion.name, "rise");
  assert.deepEqual(note.motion.changes, [{ prop: "duration", from: "700ms", to: "900ms" }]);
  const w = await view(page, "v.note === '' && /^Sent/.test(v.status)");
  assert.equal(w.status, "Sent · preview stays until note 1 is done");
  // nothing more to send: the line says why, and no second note goes
  await act(page, { type: "send", background: false });
  assert.match((await view(page, "v.msg !== ''")).msg, /Nothing to send yet/);
  await frames(f, 4);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: after a reload the view comes again, with the unsent edits and words; resend asks for it", async () => {
  const { page, errors, v } = await open();
  await act(page, { type: "row", id: v.rows[v.rows.findIndex((r) => r.text === "rise") + 2].id });
  await view(page, "v.open && v.open.name === 'rise'");
  await act(page, { type: "timing", what: "duration", value: "1200", done: true });
  await act(page, { type: "note", text: "slower" });
  await page.waitForFunction(() => window.__harness.draft?.motion?.note === "slower");
  await page.evaluate(() => (window.__harness.panel.length = 0));
  await page.evaluate(() => document.getElementById("page").contentWindow.location.reload());
  const f2 = await pageFrame(page);
  // motion mode comes back by itself; its dock is still the host's, and says what is unsent
  const w = await view(page, "v.on && v.note === 'slower' && v.rows.some((r) => r.sub && r.dirty)", 5000);
  assert.ok(w.rows.length > 0);
  assert.equal(await page.evaluate(() => window.__harness.mode), "motion");
  await f2.waitForFunction(() => document.adoptedStyleSheets.some((s) => [...s.cssRules].some((r) => /1200ms[^;]* rise;/.test(r.cssText))));
  // a host that lost its view asks for it again
  const n = await views(page);
  await act(page, { type: "resend" });
  await page.waitForFunction((k) => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).length > k, n);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: Only this puts the element alone in the middle, a small one enlarged; go steps through what moves", async () => {
  const { page, f, errors, v } = await open();
  const box = () => f.evaluate(() => {
    const r = document.querySelector(".spinner").getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, s: new DOMMatrix(getComputedStyle(document.body).transform).a, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, y: scrollY };
  });
  await act(page, { type: "row", id: rowId(v, "spin") });
  await view(page, "v.open && v.open.name === 'spin'");
  const was = await box();
  await act(page, { type: "isolate", on: true });
  await view(page, "v.isolate");
  // the 12px spinner: four times as large, in the middle of the view
  let b = await box();
  assert.ok(Math.abs(b.cx - b.vw / 2) <= 2 && Math.abs(b.cy - b.vh / 2) <= 2, JSON.stringify(b));
  assert.equal(b.s, 4);
  assert.match(await adopted(f), /visibility: hidden !important/);
  // it still plays, and the outline is where it is drawn
  assert.equal((await view(page)).clock.playing, true);
  // the next thing that moves is put there in its place; the one before brings the spinner back
  await act(page, { type: "go", by: 1 });
  const next = await view(page, "v.open && v.open.name !== 'spin'");
  assert.ok(next.rows.some((r) => r.on && r.sub), "the next stop is one element of rise, not the row of its name");
  const mid = await f.evaluate(() => {
    const el = [...document.querySelectorAll(".hero h2, .hero p")].find((x) => getComputedStyle(x).visibility === "visible"), r = el.getBoundingClientRect();
    return { dx: r.left + r.width / 2 - document.documentElement.clientWidth / 2, dy: r.top + r.height / 2 - document.documentElement.clientHeight / 2, spinner: getComputedStyle(document.querySelector(".spinner")).visibility };
  });
  // (rise moves it up 18px: the middle is the middle of the whole motion)
  assert.ok(Math.abs(mid.dx) <= 2 && Math.abs(mid.dy) <= 12, JSON.stringify(mid));
  assert.equal(mid.spinner, "hidden");
  await act(page, { type: "go", by: -1 });
  await view(page, "v.open && v.open.name === 'spin'");
  b = await box();
  assert.ok(Math.abs(b.cx - b.vw / 2) <= 2 && Math.abs(b.cy - b.vh / 2) <= 2, JSON.stringify(b));
  // round at the ends: the one before the first is the last, and it is not keyframes nothing plays
  await act(page, { type: "go", by: -1 });
  const last = await view(page, "v.open && v.open.name !== 'spin'");
  assert.notEqual(last.open.name, "wiggle");
  // off: the page as it was, where it was
  await act(page, { type: "isolate", on: false });
  await view(page, "!v.isolate");
  assert.doesNotMatch(await adopted(f), /transform|overflow|visibility/);
  await act(page, { type: "row", id: rowId(v, "spin") });
  await view(page, "v.open && v.open.name === 'spin'");
  b = await box();
  assert.deepEqual([Math.round(b.cx), Math.round(b.cy), b.s, b.y], [Math.round(was.cx), Math.round(was.cy), 1, was.y]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: Only this shows an element the page has faded out with its parent, and says so; off, it is faded again", async () => {
  const { page, f, errors, v } = await open({ before: `document.querySelector(".sync").style.opacity = "0"` });
  const sync = () => f.evaluate(() => getComputedStyle(document.querySelector(".sync")).opacity);
  await act(page, { type: "row", id: rowId(v, "spin") });
  await view(page, "v.open && v.open.name === 'spin'");
  await act(page, { type: "isolate", on: true });
  assert.match((await view(page, "v.isolate && v.msg !== ''")).msg, /hidden \(a parent at opacity 0\): shown here/);
  assert.equal(await sync(), "1");
  // the view resized: staged again, and what was shown stays shown (read again it is not faded: our doing)
  await page.setViewportSize({ width: 1300, height: 900 });
  await frames(f, 4);
  assert.equal(await sync(), "1");
  assert.equal(await f.evaluate(() => new DOMMatrix(getComputedStyle(document.body).transform).a), 4);
  await act(page, { type: "isolate", on: false });
  await view(page, "!v.isolate");
  assert.equal(await sync(), "0");
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: on the stage the backdrop is the page's until a light or dark one is chosen, and the list's rows outline nothing", async () => {
  const { page, f, errors, v } = await open();
  const bg = () => f.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const own = await bg();
  await act(page, { type: "row", id: rowId(v, "spin") });
  await act(page, { type: "isolate", on: true });
  assert.equal((await view(page, "v.isolate")).backdrop, "light");
  await act(page, { type: "backdrop", value: "dark" });
  await view(page, "v.backdrop === 'dark'");
  assert.equal(await bg(), "rgb(20, 20, 20)");
  // the pointer over another row: its elements are hidden, and are not outlined
  await act(page, { type: "hover", id: rowId(v, "rise") });
  await frames(f, 3);
  assert.equal(await f.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".box.mrow").length), 0);
  await act(page, { type: "backdrop", value: "light" });
  await view(page, "v.backdrop === 'light'");
  assert.equal(await bg(), "rgb(250, 250, 250)");
  // off: the page's own again, and the next time it is the page's until chosen
  await act(page, { type: "isolate", on: false });
  await view(page, "!v.isolate");
  assert.equal(await bg(), own);
  await frames(f, 3);
  assert.equal(await f.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".box.mrow").length), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: where the keyframes do not say how a property starts, its lane has the element's own value as an implied key", async () => {
  const { page, errors, v } = await open();
  await act(page, { type: "row", id: rowId(v, "spin") });
  const o = (await view(page, "v.open && v.open.name === 'spin'")).open;
  // @keyframes spin { to { rotate: 360deg } }
  assert.deepEqual(o.lanes.map((l) => [l.prop, l.keys.map((k) => [k.at, !!k.implied])]), [["rotate", [[0, true], [100, false]]]]);
  assert.match(o.lanes[0].keys[0].value, /none|0deg/);
  assert.equal(o.lanes[0].eases.length, 1);
  assert.deepEqual(o.frames, [100]);
  assert.doesNotMatch(o.css, /\s0%/);
  // a keyframe added there is one of the keyframes: no longer implied
  await act(page, { type: "addKey", prop: "rotate", at: 0 });
  const w = (await view(page, "v.open.frames.length === 2")).open;
  assert.deepEqual(w.lanes[0].keys.map((k) => [k.at, !!k.implied]), [[0, false], [100, false]]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: keyframes a rule plays in a state are not unused; a scroll-driven animation is sought without an error; a transition nothing explains says so", async () => {
  const { page, f, errors, v } = await open({ before: `
    const s = document.createElement("style");
    s.textContent = ":root { --shake: wiggle 1s infinite; } .cards:hover .card h3 { animation: var(--shake); } @keyframes grow { from { scale: 0.5 } to { scale: 1 } } .ghost { animation: grow linear both; animation-timeline: view(); } nav { transition: opacity 300ms; }";
    document.head.appendChild(s);
    document.querySelector(".ghost").classList.add("ghost");
  ` });
  const names = v.rows.map((r) => (r.group ? `#${r.group}` : `${r.text}|${r.aside}`));
  assert.ok(names.includes("#Not playing now") && names.includes("wiggle|.cards:hover .card h3"), names.join(" "));
  assert.ok(!names.includes("#Unused"), names.join(" "));
  await act(page, { type: "row", id: rowId(v, "grow") });
  await view(page, "v.open && v.open.name === 'grow'");
  await act(page, { type: "seek", p: 0.5 });
  await frames(f, 3);
  assert.ok(Math.abs(await f.evaluate(() => +getComputedStyle(document.querySelector(".ghost")).scale) - 0.75) < 0.02);
  // the nav's opacity transition: no rule of the page says what changes it
  await act(page, { type: "row", id: v.rows.find((r) => r.kind === "transition" && r.aside === "opacity").id });
  await view(page, "v.open && v.open.kind === 'transition'");
  await act(page, { type: "play" });
  assert.match((await view(page, "v.msg !== ''")).msg, /Nothing in the page’s CSS says what changes this/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: elements that change the same way are one row of the list, named by the rule that says so, with the elements under it", async () => {
  const { page, errors, v } = await open({ before: `
    const s = document.createElement("style");
    s.textContent = ".card h3, .card p { transition: color 200ms linear; } .card:hover h3 { color: red; }";
    document.head.appendChild(s);
  ` });
  const i = v.rows.findIndex((r) => r.text === ".card h3, .card p");
  assert.ok(i > 0, v.rows.map((r) => r.group || r.text).join(" | "));
  assert.equal(v.rows[i].aside, "6 elements · color");
  assert.equal(v.rows[i].duration, 200);
  assert.deepEqual(v.rows.slice(i + 1, i + 7).map((r) => [r.kind, r.sub]), Array(6).fill(["transition", true]));
  assert.equal(v.rows[i + 6].last, true);
  // the row of the rule opens its first element; the row of that element is the one that is on
  await act(page, { type: "row", id: v.rows[i].id });
  const w = await view(page, "v.open && v.open.kind === 'transition'");
  assert.deepEqual(w.rows.filter((r) => r.on).map((r) => r.id), [v.rows[i + 1].id]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a transition's states are found in the page's rules (a class a script adds, hover, a rule inside another), and its timing is changed, sent and undone", async () => {
  const { page, f, errors, v } = await open({ before: `
    const s = document.createElement("style");
    s.textContent = ".hero { transition: opacity 300ms ease 50ms, translate 300ms ease 50ms; } .hero.away { opacity: 0.2; translate: 0 40px; }"
      + " .cta { transition: scale 200ms linear; &:hover { @media (min-width: 1px) { scale: 1.1; } } &:active { scale: 0.9; } }";
    document.head.appendChild(s);
  ` });
  // a class the page's script would add: both ends are read, though nothing switches it here
  await act(page, { type: "row", id: v.rows.find((r) => r.kind === "transition" && r.aside === "opacity, translate").id });
  let o = (await view(page, "v.open && v.open.kind === 'transition'")).open;
  assert.deepEqual(o.states, [".away"]);
  assert.equal(o.state, ".away");
  assert.equal(o.readOnly, true);
  assert.equal(o.timed, true);
  assert.deepEqual(o.timing, { duration: 300, delay: 50, easing: "ease", count: "1", direction: "normal", fill: "none" });
  assert.equal(o.T, 350);
  const op = o.lanes.find((l) => l.prop === "opacity");
  assert.deepEqual(op.keys.map((k) => k.value), ["1", "0.2"]);
  // Play switches the state on: the page goes there
  await act(page, { type: "play" });
  await f.waitForFunction(() => +getComputedStyle(document.querySelector(".hero")).opacity < 0.25);
  await act(page, { type: "play" });
  // slower, for every property: the page's rule is written over, the row says it is changed, undo takes it back
  await act(page, { type: "timing", what: "duration", value: "900", done: true });
  let w = await view(page, "v.open.timing.duration === 900 && v.open.dirty");
  assert.equal(w.open.T, 950);
  assert.equal(w.undo, true);
  assert.match(await adopted(f), /transition: opacity 900ms( ease)? 50ms, translate 900ms( ease)? 50ms/);
  assert.match(w.open.css, /opacity 900ms ease 50ms/);
  await act(page, { type: "undo" });
  w = await view(page, "v.open.timing.duration === 300 && !v.open.dirty");
  assert.doesNotMatch(await adopted(f), /transition:/);
  await act(page, { type: "redo" });
  await view(page, "v.open.timing.duration === 900");
  // sent: the note says what it was, what it is, and what switches it; the rule stays as a preview
  await act(page, { type: "send", background: false });
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const note = await page.evaluate(() => window.__harness.notes[0]);
  assert.equal(note.motion.kind, "transition");
  assert.match(note.prompt, /Transition edit on .*Make it real in the code[\s\S]*transition: opacity 900ms ease 50ms, translate 900ms ease 50ms;[\s\S]*It was: transition: opacity 300ms/);
  assert.equal(note.motion.current, "transition: opacity 300ms ease 50ms, translate 300ms ease 50ms");
  assert.equal(note.motion.next, "transition: opacity 900ms ease 50ms, translate 900ms ease 50ms");
  assert.match(note.motion.state, /^\.away: opacity 1 → 0\.2; translate /);
  w = await view(page, "v.open && !v.open.dirty && v.open.timing.duration === 900");
  assert.match(await adopted(f), /transition: opacity 900ms/);
  // hover and active, each in a rule written inside the element's own: two states, hover first
  await act(page, { type: "row", id: v.rows.find((r) => r.kind === "transition" && r.aside === "scale").id });
  o = (await view(page, "v.open && v.open.states.length === 2")).open;
  assert.deepEqual(o.states, ["hover", "active"]);
  assert.deepEqual(o.lanes.find((l) => l.prop === "scale").keys.map((k) => k.value), ["none", "1.1"]);
  await act(page, { type: "state", value: "active" });
  o = (await view(page, "v.open.state === 'active'")).open;
  assert.deepEqual(o.lanes.find((l) => l.prop === "scale").keys.map((k) => k.value), ["none", "0.9"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: what moves beside the open animation is its score, each with its delay; together starts them all again; a script's animation is written out as its call", async () => {
  const { page, f, errors, v } = await open();
  // the three cards come in one after another: 300, 390 and 480ms late
  const cards = v.rows.findIndex((r) => r.text === "card-in");
  await act(page, { type: "row", id: v.rows[cards + 2].id });
  let o = (await view(page, "v.open && v.open.name === 'card-in'")).open;
  assert.deepEqual(o.score.map((s) => [s.name, s.delay, s.duration, s.on]), [["card-in", 300, 500, false], ["card-in", 390, 500, true], ["card-in", 480, 500, false]]);
  assert.deepEqual(o.score.map((s) => s.id), v.rows.slice(cards + 1, cards + 4).map((r) => r.id));
  // its delay changed here is its bar's
  await act(page, { type: "timing", what: "delay", value: "900", done: true });
  o = (await view(page, "v.open.timing.delay === 900")).open;
  assert.deepEqual(o.score.map((s) => s.delay), [300, 900, 480]);
  // together: all three run again from the start
  await frames(f, 2);
  await act(page, { type: "together" });
  await f.waitForFunction(() => [...document.querySelectorAll(".card")].every((c) => c.getAnimations().some((a) => a.animationName === "card-in" && a.playState === "running" && a.currentTime < 400)));
  // the spinner moves alone in its parent
  await act(page, { type: "row", id: rowId(v, "spin") });
  assert.deepEqual((await view(page, "v.open && v.open.name === 'spin'")).open.score, []);
  // a script's animation, as code
  await act(page, { type: "row", id: rowId(v, "bob") });
  o = (await view(page, "v.open && v.open.kind === 'script'")).open;
  assert.match(o.css, /element\.animate\(\[\n  \{ offset: 0, translate: "0px" \},\n  \{ offset: 1, translate: "0px -3px" \}\n\], \{ duration: 800, easing: "ease-in-out", iterations: Infinity, direction: "alternate" \}\)$/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a script's animation is slowed in the animation itself, undone, put back when left unsent, and sent with what it was and is", async () => {
  const { page, f, errors, v } = await open();
  const dur = () => f.evaluate(() => document.querySelector(".badge").getAnimations().find((a) => a.id === "bob").effect.getTiming().duration);
  await act(page, { type: "row", id: rowId(v, "bob") });
  let o = (await view(page, "v.open && v.open.kind === 'script'")).open;
  assert.equal(o.timed, true);
  assert.equal(o.readOnly, true);
  await act(page, { type: "timing", what: "duration", value: "1600", done: true });
  let w = await view(page, "v.open.timing.duration === 1600 && v.open.dirty && v.undo");
  assert.equal(await dur(), 1600);
  assert.match(w.open.css, /duration: 1600/);
  await act(page, { type: "undo" });
  await view(page, "v.open.timing.duration === 800 && !v.open.dirty");
  assert.equal(await dur(), 800);
  // changed and left for something else: the page's script's again
  await act(page, { type: "timing", what: "duration", value: "1600", done: true });
  await view(page, "v.open.timing.duration === 1600");
  await act(page, { type: "row", id: rowId(v, "spin") });
  await view(page, "v.open && v.open.name === 'spin'");
  assert.equal(await dur(), 800);
  // changed and sent
  await act(page, { type: "row", id: rowId(v, "bob") });
  await view(page, "v.open && v.open.kind === 'script'");
  await act(page, { type: "timing", what: "duration", value: "1200", done: true });
  await view(page, "v.open.dirty");
  await act(page, { type: "send", background: false });
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const note = await page.evaluate(() => window.__harness.notes[0]);
  assert.equal(note.motion.current, "animate(): 800ms ease-in-out, forever, alternate");
  assert.equal(note.motion.next, "animate(): 1200ms ease-in-out, forever, alternate");
  assert.match(note.prompt, /Edit of the script's animation .*find the script that makes it/s);
  assert.equal((await view(page, "v.open && !v.open.dirty")).open.timing.duration, 1200);
  assert.equal(await dur(), 1200);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a delay dragged is a delay typed: every step on the page, one undo step; a transition's properties keep how much later they are; paused in its wait, the clock says where", async () => {
  const { page, f, errors, v } = await open({ before: `
    const s = document.createElement("style");
    s.textContent = ".hero { transition: opacity 300ms ease 50ms, translate 400ms ease 120ms; } .hero.away { opacity: 0.2; translate: 0 40px; }";
    document.head.appendChild(s);
  ` });
  const delay = (sel) => f.evaluate((x) => getComputedStyle(document.querySelector(x)).animationDelay, sel);
  // the paragraph's rise, 120ms late
  await act(page, { type: "row", id: v.rows[v.rows.findIndex((r) => r.text === "rise") + 2].id });
  const o = (await view(page, "v.open && v.open.name === 'rise'")).open;
  assert.equal(o.timing.delay, 120);
  assert.equal(o.T, 700);
  for (const value of ["200", "310", "400"]) {
    await act(page, { type: "timing", what: "delay", value, done: false });
    await view(page, `v.open.timing.delay === ${value}`);
    assert.equal(await delay(".hero p"), `${+value / 1000}s`);
  }
  await act(page, { type: "timing", what: "delay", value: "400", done: true });
  let w = await view(page, "v.undo && v.open.dirty");
  assert.equal(w.open.T, 700, "the timeline is the duration's; the delay comes before it");
  await act(page, { type: "undo" });
  w = await view(page, "v.open.timing.delay === 120 && !v.open.dirty");
  assert.equal(w.undo, false, "the whole drag is one step");
  assert.equal(await delay(".hero p"), "0.12s");
  // paused while it waits: the playhead has a place, in the wait
  await act(page, { type: "timing", what: "delay", value: "2000", done: true });
  await view(page, "v.open.timing.delay === 2000");
  await f.evaluate(() => {
    const a = document.querySelector(".hero p").getAnimations()[0];
    a.currentTime = 500;
    a.pause();
  });
  w = await view(page, "v.clock.wait !== null && !v.clock.playing");
  assert.ok(Math.abs(w.clock.wait - 0.25) < 0.01, String(w.clock.wait));
  await act(page, { type: "discard" });
  // a transition: its delay is the earliest property's, and the others stay as much later
  await act(page, { type: "row", id: v.rows.find((r) => r.kind === "transition" && r.aside === "opacity, translate").id });
  w = await view(page, "v.open && v.open.kind === 'transition'");
  assert.deepEqual([w.open.timing.delay, w.open.T], [50, 520]);
  await act(page, { type: "timing", what: "delay", value: "100", done: false });
  await act(page, { type: "timing", what: "delay", value: "200", done: true });
  w = await view(page, "v.open.timing.delay === 200");
  assert.equal(w.open.T, 670);
  assert.match(await adopted(f), /transition: opacity 300ms( ease)? 200ms, translate 400ms( ease)? 270ms/);
  await act(page, { type: "discard" });
  await view(page, "v.open.timing.delay === 50 && !v.open.dirty");
  // a script's
  await act(page, { type: "row", id: rowId(v, "bob") });
  await view(page, "v.open && v.open.kind === 'script'");
  await act(page, { type: "timing", what: "delay", value: "150", done: true });
  await view(page, "v.open.timing.delay === 150 && v.open.dirty");
  assert.equal(await f.evaluate(() => document.querySelector(".badge").getAnimations().find((a) => a.id === "bob").effect.getTiming().delay), 150);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: a bar of the score dragged is that element's delay, though another is open: its row is unsent, one undo step, and opened it is sent as changed", async () => {
  const { page, f, errors, v } = await open();
  const delays = () => f.evaluate(() => [...document.querySelectorAll(".card")].map((c) => getComputedStyle(c).animationDelay).join());
  const cards = v.rows.findIndex((r) => r.text === "card-in");
  const third = v.rows[cards + 3].id;
  await act(page, { type: "row", id: v.rows[cards + 2].id });
  await view(page, "v.open && v.open.name === 'card-in' && v.open.score.length === 3");
  await act(page, { type: "stagger", id: third, value: 550, done: false });
  await view(page, "v.open.score[2].delay === 550");
  await act(page, { type: "stagger", id: third, value: 700, done: false });
  await act(page, { type: "stagger", id: third, value: 700, done: true });
  let w = await view(page, "v.open.score[2].delay === 700 && v.undo");
  assert.equal(await delays(), "0.3s,0.39s,0.7s");
  assert.equal(w.open.dirty, false, "what is open is as it was");
  assert.deepEqual(w.rows.filter((r) => r.dirty).map((r) => r.id), [third]);
  // the open one's own bar is its Delay
  await act(page, { type: "stagger", id: v.rows[cards + 2].id, value: 500, done: true });
  w = await view(page, "v.open.timing.delay === 500 && v.open.dirty");
  await act(page, { type: "undo" });
  await view(page, "v.open.timing.delay === 390 && v.open.score[2].delay === 700");
  await act(page, { type: "undo" });
  w = await view(page, "v.open.score[2].delay === 480");
  assert.equal(w.undo, false);
  assert.equal(await delays(), "0.3s,0.39s,0.48s");
  // what is not one of them changes nothing
  await act(page, { type: "stagger", id: rowId(v, "spin"), value: 999, done: true });
  await act(page, { type: "redo" });
  await view(page, "v.open.score[2].delay === 700");
  // opened, it is sent with what it was and is
  await act(page, { type: "row", id: third });
  await view(page, "v.open.timing.delay === 700 && v.open.dirty");
  await act(page, { type: "send", background: false });
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  assert.deepEqual((await page.evaluate(() => window.__harness.notes[0])).motion.changes, [{ prop: "delay", from: "480ms", to: "700ms" }]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: the list starts with what is in view, the rest after it as elsewhere; scrolled, it is put in order once the scroll is over, and not on the stage", async () => {
  const { page, f, errors, v } = await open({ before: `
    document.querySelector(".cards").style.marginTop = "3000px";
    document.querySelector("nav").after(Object.assign(document.createElement("p"), { className: "far", textContent: "Far", style: "animation: rise 700ms both; position: absolute; top: 1500px" }));
  ` });
  const said = (w) => w.rows.map((r) => (r.group ? `#${r.group}` : r.sub ? `>${r.text}` : r.text));
  const kinds = (w, from, to) => said(w).slice(said(w).indexOf(from) + 1, to ? said(w).indexOf(to) : undefined);
  // what moves in the view, of every kind; a "rise" far down (the first of the page's) stays with its name, after the two in view
  assert.equal(said(v)[0], "#In view", said(v).join(" "));
  assert.deepEqual(kinds(v, "#In view", "#Animations elsewhere"), ["spin", "rise", ">Ship calmer interfaces", ">Acme helps small teams revi…", ">Far", "pulse", "Start free trial", "Book a demo"]);
  assert.deepEqual(v.rows.filter((r) => r.sub).map((r) => r.last).slice(0, 3), [false, false, true]);
  assert.deepEqual(kinds(v, "#Animations elsewhere", "#Scripts elsewhere").filter((x) => x[0] !== ">"), ["card-in"]);
  assert.ok(!said(v).some((x) => /Transitions/.test(x)), said(v).join(" "));
  assert.deepEqual(kinds(v, "#Unused"), ["wiggle"]);
  const ids = v.rows.map((r) => r.id).filter(Boolean).sort();
  // scrolled to the cards: the list is in order once the scroll is over, not while it goes on
  let n = await views(page);
  await f.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      scrollTo(0, 260 * (i + 1));
      await new Promise((r) => setTimeout(r, 30));
    }
    scrollTo(0, 1e6);
  });
  const during = await page.evaluate((k) => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).slice(k).filter((m) => !m.part || m.part.rows).map((m) => m.view.rows.map((r) => r.group || r.text)), n);
  let w = await view(page, "v.rows[1].text !== 'spin'");
  assert.ok(during.every((r) => r[1] === "spin"), JSON.stringify(during));
  assert.deepEqual(kinds(w, "#In view", "#Animations elsewhere").filter((x) => x[0] !== ">").slice(0, 2), ["card-in", "bob"], said(w).join(" "));
  assert.ok(kinds(w, "#Animations elsewhere").includes("spin"), said(w).join(" "));
  assert.deepEqual(w.rows.map((r) => r.id).filter(Boolean).filter((x) => !/^frames/.test(x)).sort(), ids.filter((x) => !/^frames/.test(x)), "the same rows, with the same ids");
  // a row opened brings the page to it: that scroll is the list's own, and it stays as it is
  await act(page, { type: "row", id: rowId(w, "spin") });
  await view(page, "v.open && v.open.name === 'spin'");
  await f.waitForFunction(() => scrollY < 50);
  await page.waitForTimeout(500);
  w = await view(page);
  assert.equal(said(w)[1], "card-in", said(w).join(" "));
  // an edit (the page looked at again) keeps it too; what is open closed, it is put in order
  await act(page, { type: "timing", what: "duration", value: "800", done: true });
  w = await view(page, "v.open.timing.duration === 800 && v.undo");
  assert.equal(said(w)[1], "card-in");
  // on the stage nothing is put in order, wherever the page is
  await act(page, { type: "isolate", on: true });
  await view(page, "v.isolate");
  await f.evaluate(() => scrollTo(0, 1500));
  await page.waitForTimeout(400);
  assert.equal(said(await view(page))[1], "card-in");
  await f.evaluate(() => scrollTo(0, 0));
  await act(page, { type: "isolate", on: false });
  w = await view(page, "!v.isolate && v.rows[1].text === 'spin'");
  // all of it in view (or none): one list, under its own groups
  await act(page, { type: "back" });
  await f.evaluate(() => {
    document.querySelector(".cards").style.marginTop = "";
    document.querySelector(".far").remove();
    dispatchEvent(new Event("resize"));
  });
  w = await view(page, "v.rows[0].group === 'Animations'");
  assert.ok(said(w).includes("#Transitions") && !said(w).some((x) => /elsewhere/.test(x)), said(w).join(" "));
  assert.deepEqual(errors, []);
  await page.close();
});
