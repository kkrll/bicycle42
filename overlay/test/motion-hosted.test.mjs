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

/** The motion page in motion mode, its dock the host's. */
async function open({ delay = 150 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=${delay}&page=motion`);
  const f = await pageFrame(page);
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
  assert.deepEqual(w.open.lanes.find((l) => l.prop === "opacity").keys.map((k) => k.at), [0, 60]);
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
