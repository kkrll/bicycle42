// End-to-end tests for motion mode on harness/motion-page.html: what it does on the page, driven
// as the app drives it. The dock is the host's (the overlay has none of its own): the harness
// plays a host that draws it (__harness.hostDocks), reads the views the overlay sends
// (__harness.panel) and acts in it (__harness.act); clicks and keys go to the page itself.
// motion-hosted.test.mjs has the dock's own acts one by one. Same set-up as overlay.test.mjs: a
// system Chromium, headless. Run: bun run test
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
/** What the layer's shadow root says, read in the page. */
const inLayer = (f, fn, arg) => f.evaluate(([src, a]) => new Function("r", "a", `return (${src})(r, a)`)(document.querySelector("b42-review").shadowRoot, a), [fn.toString(), arg]);
/** Every rule the page has adopted from us (the unsent sheet and the sent ones), as text. */
const adopted = (f) => f.evaluate(() => document.adoptedStyleSheets.map((s) => [...s.cssRules].map((r) => r.cssText).join("\n")).join("\n"));
const host = (page) => page.evaluate(() => ({ mode: window.__harness.mode, draft: window.__harness.draft, notes: window.__harness.notes }));
const views = (page) => page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).length);
/** The last view the overlay sent, once `fn` (its source, run on the view) holds for it. */
async function view(page, fn = "true", timeout = 3000) {
  await page.waitForFunction((src) => {
    const v = window.__harness.view("motion");
    return !!v && new Function("v", `return (${src})`)(v);
  }, fn, { timeout });
  return page.evaluate(() => window.__harness.view("motion"));
}
const act = (page, a) => page.evaluate((x) => window.__harness.act("motion", x), a);
/** The names of the list's animations (not the elements under them). */
const animNames = (v) => v.rows.filter((r) => !r.group && !r.sub).map((r) => r.text);
/** A click on the page, where the element is. */
const clickEl = async (page, f, sel) => {
  const b = await f.locator(sel).first().boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await frames(f);
};
/** The keyboard is the page's (as it is once the reviewer clicks into it): keys go to its window. */
const focusPage = (page) => page.evaluate(() => document.getElementById("page").contentWindow.focus());

/** The motion page in motion mode as the host's switch turns it on, its dock the host's (with
 *  `hosted` false, a host that draws no dock). */
async function open({ delay = 150, hosted = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=${delay}&page=motion`);
  const f = await pageFrame(page);
  if (hosted) await page.evaluate(() => window.__harness.hostDocks(["motion"]));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  const v = hosted ? await view(page, "v.on && v.rows.length > 0") : null;
  return { page, f, errors, v };
}

test("motion mode: the host's switch turns it on, the overlay says the mode back, and the dock lists what moves", async () => {
  const { page, f, errors, v } = await open();
  assert.equal((await host(page)).mode, "motion");
  const rows = v.rows.map((r) => (r.group ? `#${r.group}` : r.text));
  for (const want of ["#Animations", "spin", "rise", "pulse", "card-in", "#Transitions", "#Scripts", "bob", "#Unused", "wiggle"]) assert.ok(rows.includes(want), `${want} in ${rows.join(" ")}`);
  // rise is played by two elements: they are listed under it
  assert.ok(rows.indexOf("Ship calmer interfaces") === rows.indexOf("rise") + 1, rows.join(" | "));
  // the frame-by-frame bar is found once it has moved for a while
  await view(page, "v.rows.some((r) => r.kind === 'frames')");
  // the canvas bar is not in the way
  assert.equal(await inLayer(f, (r) => r.querySelector(".bar").hidden), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a click on the page opens the first animation of what was clicked; its name is on a tag", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".hero h2");
  const w = await view(page, "v.open && v.open.name === 'rise'");
  assert.deepEqual(w.open.lanes.map((l) => l.prop), ["opacity", "transform"]);
  assert.equal(w.open.shared, 2);
  assert.equal(w.rows.find((r) => r.on)?.text, "Ship calmer interfaces");
  await frames(f, 2);
  assert.match(await inLayer(f, (r) => r.querySelector(".m-tag").textContent), /Heading · Ship calmer/);
  assert.equal(await inLayer(f, (r) => r.querySelector(".m-tag").hidden), false);
  // a click on something that does not move says so, and offers a new animation
  await clickEl(page, f, ".card h3");
  const n = await view(page, "v.sel && !v.open");
  assert.match(n.sel, /Review/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("dragging a grip moves the keyframe, live and undoably; a value typed for it applies; mod+Z on the page undoes", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".hero h2");
  await view(page, "v.open && v.open.name === 'rise'");
  await act(page, { type: "select", key: { at: 100, prop: "opacity" }, grab: true });
  for (const to of [96, 90, 82, 75]) await act(page, { type: "drag", to });
  await act(page, { type: "drop" });
  const at = (await view(page, "v.open.key && v.open.key.at < 100")).open.key.at;
  assert.ok(at < 100 && at > 50, `moved to ${at}`);
  const css = await adopted(f);
  assert.match(css, /@keyframes rise \{[^]*?\d+% \{ opacity: 1; \}/, css);
  // the selected keyframe's value
  await act(page, { type: "key", what: "val", value: "0.6", done: true });
  await view(page, "v.open.key && v.open.key.value === '0.6'");
  assert.match(await adopted(f), new RegExp(`${at}% \\{ opacity: 0\\.6; \\}`));
  // undo, twice, with the page's keyboard: the page's own keyframes again
  await focusPage(page);
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await view(page, "!v.undo");
  assert.doesNotMatch(await adopted(f), /@keyframes rise/);
  // and mod+shift+Z does it again
  await page.keyboard.press(`${MOD}+Shift+z`);
  await view(page, "v.undo && v.redo");
  assert.match(await adopted(f), /@keyframes rise/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Enter on the page sends the open animation as one note; it stays applied until the note is done", async () => {
  const { page, f, errors } = await open({ delay: 700 });
  await clickEl(page, f, ".hero p");
  await view(page, "v.open && v.open.name === 'rise'");
  await act(page, { type: "timing", what: "duration", value: "900", done: true });
  await act(page, { type: "note", text: "calmer" });
  await view(page, "v.note === 'calmer'");
  await focusPage(page);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const note = (await host(page)).notes[0];
  assert.equal(note.text, "calmer");
  assert.equal(note.lane, undefined);
  assert.equal(note.motion.kind, "keyframes");
  assert.equal(note.motion.name, "rise");
  assert.equal(note.motion.shared, 2);
  assert.deepEqual(note.motion.changes, [{ prop: "duration", from: "700ms", to: "900ms" }]);
  assert.match(note.motion.animation.to, /^rise 900ms/);
  assert.match(note.motion.animation.from, /^rise 700ms/);
  assert.equal(note.motion.keyframes, undefined);
  assert.match(note.targets[0].selector, /p/);
  assert.match(note.prompt, /Motion edit, made on the live page/);
  assert.match(note.prompt, /animation: rise 900ms/);
  // sent: the edits are no longer unsent, but the page still plays them
  const w = await view(page, "v.note === '' && v.status !== ''");
  assert.equal(w.status, "Sent · preview stays until note 1 is done");
  assert.match(await adopted(f), /900ms[^;]* rise;/);
  const d = (await host(page)).draft;
  assert.ok(!d || !d.motion, JSON.stringify(d));
  // done: the preview goes (the agent's own change is what plays now)
  await page.waitForFunction(() => window.__harness.notes[0].status === "done", null, { timeout: 5000 });
  await frames(f, 4);
  assert.doesNotMatch(await adopted(f), /900ms[^;]* rise;/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a refused note comes back unsent, with its edits and its words", async () => {
  const { page, f, errors } = await open();
  await page.evaluate(() => (window.__harness.refuse = "the server is offline"));
  await clickEl(page, f, ".hero p");
  await view(page, "v.open && v.open.name === 'rise'");
  await act(page, { type: "timing", what: "duration", value: "950", done: true });
  await act(page, { type: "note", text: "slower" });
  await act(page, { type: "send", background: false });
  const w = await view(page, "/Not sent/.test(v.msg)");
  assert.match(w.msg, /Not sent: the server is offline/);
  assert.equal(w.note, "slower");
  assert.equal(w.open.timing.duration, 950);
  assert.match(await adopted(f), /950ms[^;]* rise;/);
  assert.equal((await host(page)).notes.length, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a refusal of another note leaves the one being sent alone: refused itself, it still comes back", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // No host message reaches Motion.refuse with an id that is not the pending one (refuseCapture
  // checks first), so the module is put on the page for this test: the overlay is built with
  // two lines more, which run after its own.
  const withMotion = build('import * as Motion from "./motion/api.js";\nwindow.__motion = Motion;');
  await page.route("**/overlay.js", (route) => route.fulfill({ contentType: "text/javascript", body: withMotion }));
  await page.goto(`${base}/?delay=150&page=motion`);
  const f = await pageFrame(page);
  await page.evaluate(() => window.__harness.hostDocks(["motion"]));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  await view(page, "v.on && v.rows.length > 0");
  // The host holds the note: it is sent, and neither taken nor refused yet.
  await f.evaluate(() => {
    const real = window.__review;
    window.__review = (s) => (JSON.parse(s).type === "note" ? void (window.__held = JSON.parse(s).note) : real(s));
  });
  await clickEl(page, f, ".hero p");
  await view(page, "v.open && v.open.name === 'rise'");
  await act(page, { type: "timing", what: "duration", value: "950", done: true });
  await act(page, { type: "note", text: "slower" });
  await act(page, { type: "send", background: false });
  // All in one go: the overlay gives up waiting for the host after two seconds.
  const stale = await f.evaluate(async () => {
    while (!window.__held) await new Promise(requestAnimationFrame);
    const Mo = window.__motion;
    // another animation, edited meanwhile
    Mo.debug.select(document.querySelector(".hero h2"));
    Mo.debug.setTiming("duration", "1300", true);
    // an older note refused: it is not this one, so nothing changes
    const out = Mo.refuse("n_older", "Not sent: an older note");
    window.__b42.receive({ type: "captured", id: window.__held.id, ok: false, why: "the server is offline" });
    return out;
  });
  assert.equal(stale, false);
  // the note that was pending is refused now: it comes back unsent, with its edits and words
  const w = await view(page, "/Not sent/.test(v.msg)");
  assert.match(w.msg, /Not sent: the server is offline/);
  assert.equal(w.note, "slower");
  assert.equal(w.open.timing.duration, 950);
  assert.match(await adopted(f), /950ms[^;]* rise;/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Esc on the page steps back: the keyframe, the animation, then notes mode; nothing is left stopped", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".sync .spinner");
  const o = (await view(page, "v.open && v.open.lanes.length > 0")).open;
  await act(page, { type: "select", key: { at: o.lanes[0].keys[0].at, prop: o.lanes[0].prop } });
  await view(page, "v.open.key");
  assert.equal(await f.evaluate(() => document.querySelector(".spinner").getAnimations()[0].playState), "paused");
  await focusPage(page);
  await page.keyboard.press("Escape");
  await view(page, "v.open && !v.open.key");
  await page.keyboard.press("Escape");
  await view(page, "!v.open && !v.sel");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__harness.mode === "notes");
  assert.equal((await view(page, "!v.on")).rows.length, 0);
  await frames(f);
  assert.equal(await f.evaluate(() => document.querySelector(".spinner").getAnimations()[0].playState), "running");
  assert.deepEqual(errors, []);
  await page.close();
});

test("shared keyframes: Duplicate gives the element its own copy; the note says so", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".hero p");
  await view(page, "v.open && v.open.name === 'rise' && v.open.shared === 2");
  await act(page, { type: "select", key: { at: 0, prop: "opacity" } });
  await act(page, { type: "key", what: "val", value: "0.3", done: true });
  await act(page, { type: "detach" });
  const w = await view(page, "v.open.name === 'rise-2'");
  const css = await adopted(f);
  assert.match(css, /@keyframes rise-2 \{[^]*?0% \{ opacity: 0\.3;/, css);
  assert.doesNotMatch(css, /@keyframes rise \{/); // the heading keeps the page's own
  assert.match(css, /animation: 700ms[^;]* rise-2;/);
  assert.equal(w.open.from, "rise");
  assert.equal(w.open.shared, 1);
  await focusPage(page);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const m = (await host(page)).notes[0].motion;
  assert.equal(m.name, "rise-2");
  assert.equal(m.from, "rise");
  assert.match(m.keyframes.to, /@keyframes rise-2/);
  assert.equal(m.keyframes.from, undefined);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a new animation is named in its band; renamed in the CSS text, the list follows at once and no row is left under the old name", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".card h3");
  await view(page, "v.sel && !v.open");
  await act(page, { type: "new" });
  // it says it is new (not a copy of anything), and can be renamed and removed
  let w = await view(page, "v.open && v.open.renamable");
  assert.equal(w.open.name, "new-animation");
  assert.equal(w.open.from, null);
  assert.equal(w.open.removable, true);
  await act(page, { type: "name", value: "slide-in", done: true });
  assert.ok(animNames(await view(page, "v.open.name === 'slide-in'")).includes("slide-in"));
  // a name that is taken is refused, and the one it has stays
  await act(page, { type: "name", value: "rise", done: true });
  await frames(f, 3);
  assert.equal((await view(page)).open.name, "slide-in");
  // renamed in the text, then back to the keyframes: one animation, under the new name
  await act(page, { type: "view", view: "css" });
  w = await view(page, "v.view === 'css'");
  await act(page, { type: "css", text: w.open.css.replace("slide-in", "test-one"), done: false });
  w = await view(page, "v.rows.some((r) => !r.sub && r.text === 'test-one')");
  assert.ok(animNames(w).includes("test-one"), "the list follows while typing");
  await act(page, { type: "view", view: "keys" });
  await clickEl(page, f, ".hero h2");
  await view(page, "v.open && v.open.name === 'rise'");
  await clickEl(page, f, ".card h3");
  w = await view(page, "v.open && v.open.name === 'test-one'");
  const list = animNames(w);
  assert.ok(list.includes("test-one") && !list.includes("slide-in"), list.join(" "));
  assert.match(await adopted(f), /animation: [^;]*test-one;/);
  assert.doesNotMatch(await adopted(f), /slide-in/);
  // Remove takes it off the element
  await act(page, { type: "discard" });
  w = await view(page, "v.sel && !v.open");
  assert.ok(!animNames(w).includes("test-one"));
  assert.doesNotMatch(await adopted(f), /test-one/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("something that does not move can play keyframes the page has, timed as the page times them", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".card h3");
  const names = (await view(page, "v.sel && !v.open && v.names.length > 0")).names;
  assert.ok(["rise", "spin", "wiggle"].every((n) => names.includes(n)), names.join(" "));
  await act(page, { type: "use", name: "spin" });
  const o = (await view(page, "v.open && v.open.name === 'spin'")).open;
  assert.deepEqual({ name: o.name, shared: o.shared, duration: o.timing.duration }, { name: "spin", shared: 2, duration: 900 });
  assert.match(await adopted(f), /animation: [^;]*spin;/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a host that does not say it draws motion's dock has none: nothing over the page, no room, no views; said, the views come and a ping is answered; given back, they stop", async () => {
  const { page, f, errors } = await open({ hosted: false });
  await page.waitForFunction(() => window.__harness.mode === "motion");
  await clickEl(page, f, ".hero h2");
  await frames(f, 3);
  // Motion mode itself is on, on the page: the open element is tagged.
  assert.equal(await inLayer(f, (r) => r.querySelector(".m-tag").hidden), false);
  // Nothing of the layer's at the bottom of the window, and the page is given no room for a dock.
  const bottom = await f.evaluate(() => ({ at: document.elementFromPoint(innerWidth / 2, innerHeight - 4)?.localName, room: getComputedStyle(document.documentElement).paddingBottom }));
  assert.notEqual(bottom.at, "b42-review");
  assert.equal(bottom.room, "0px");
  assert.equal(await views(page), 0);
  // Said: the host's dock is told what it shows, and a ping is answered.
  await page.evaluate(() => window.__harness.hostDocks(["motion"]));
  await view(page, "v.on && v.open && v.open.name === 'rise'");
  await page.evaluate(() => window.__harness.act("motion", { type: "ping", id: 7 }));
  await page.waitForFunction(() => window.__harness.panel.some((m) => m.panel === "motion" && m.pong === 7));
  // A dock that is not hosted is not answered.
  await page.evaluate(() => window.__harness.act("canvas", { type: "ping", id: 8 }));
  await frames(f, 3);
  assert.equal(await page.evaluate(() => window.__harness.panel.some((m) => m.pong === 8)), false);
  // A reload: the host says it again after "state", and the new document sends views too.
  const before = await views(page);
  await page.evaluate(() => {
    const w = document.getElementById("page").contentWindow;
    w.__old = true; // (until the new document is there, the frame is still the old one's)
    w.location.reload();
  });
  await page.waitForFunction(() => !document.getElementById("page").contentWindow.__old);
  const f2 = await pageFrame(page);
  await f2.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  await page.waitForFunction((k) => window.__harness.panel.filter((m) => m.panel === "motion" && m.view).length > k, before);
  await view(page, "v.on");
  // Given back: no views any more, and motion mode still works on the page.
  await page.evaluate(() => window.__harness.hostDocks([]));
  await frames(f2, 3);
  const after = await views(page);
  await clickEl(page, f2, ".hero p");
  await frames(f2, 3);
  assert.equal(await views(page), after);
  assert.equal(await inLayer(f2, (r) => r.querySelector(".m-tag").hidden), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test("nothing of the page is kept that is gone from it: an element a script moved, once it is removed; the elements the list was made from, once the mode is left", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=150&page=motion`);
  const f = await pageFrame(page);
  const cdp = await page.context().newCDPSession(page);
  /** How many of the elements `window[name]` has weak references to are still alive. */
  const alive = async (name) => {
    for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
    return f.evaluate((n) => window[n].filter((r) => r.deref()).length, name);
  };
  const perFrame = (v) => v.rows.filter((r) => r.kind === "frames").length;
  await page.evaluate(() => window.__harness.hostDocks(["motion"]));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  // (The page's own bar, moved by a script frame by frame, is listed once it has been seen to move.)
  await view(page, "v.on && v.rows.some((r) => r.kind === 'frames')");
  // Twelve toasts, each moved by a script (its inline style written many times): listed.
  await f.evaluate(() => {
    window.__toasts = [];
    window.__gone = [];
    for (let n = 0; n < 12; n++) {
      const d = document.createElement("div");
      d.className = "toast";
      d.innerHTML = "<b>Saved</b> <span>just now</span>";
      document.body.append(d);
      window.__toasts.push(d);
      window.__gone.push(new WeakRef(d));
      for (let i = 0; i < 25; i++) d.style.transform = `translateY(${i}px)`;
    }
  });
  assert.equal(perFrame(await view(page, "v.rows.filter((r) => r.kind === 'frames').length > 1")), 13);
  // Removed, as a toast is: their rows go, and nothing holds them.
  await f.evaluate(() => {
    for (const d of window.__toasts) d.remove();
    delete window.__toasts;
  });
  assert.equal(perFrame(await view(page, "v.rows.filter((r) => r.kind === 'frames').length < 13")), 1);
  assert.equal(await alive("__gone"), 0, "removed toasts kept while motion mode is on");
  // The mode left, and then the page takes out what the list was made from (the hero: its
  // heading and paragraph play rise, its buttons pulse and have transitions; the spinner in the
  // bar): none of it is kept. (Not the cards: the page's own script holds on to its meter.)
  await f.evaluate(() => {
    window.__listed = [...document.querySelectorAll("nav, nav *, .hero, .hero *")].map((el) => new WeakRef(el));
  });
  assert.equal(await f.evaluate(() => window.__listed.length), 12);
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "notes" }));
  await view(page, "!v.on");
  await f.evaluate(() => {
    document.querySelector("nav").remove();
    document.querySelector(".hero").remove();
  });
  await frames(f, 3);
  assert.equal(await alive("__listed"), 0, "elements of the list kept after motion mode was left");
  // Back in the mode, the list is of the page as it is now.
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  const again = await view(page, "v.on && v.rows.length > 0");
  assert.deepEqual(again.rows.filter((r) => r.kind === "css" && !r.sub).map((r) => r.text), ["card-in"]);
  assert.deepEqual(again.rows.filter((r) => r.kind === "unused").map((r) => r.text).sort(), ["pulse", "rise", "spin", "wiggle"]);
  assert.deepEqual(errors, []);
  await page.close();
});
