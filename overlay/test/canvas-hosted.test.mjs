// End-to-end tests for canvas mode's inspector when the host draws it (src/canvas/host.js): the
// view the overlay sends, and what the host's acts do to the page. The harness plays the host
// (__harness.hostDocks, __harness.act, __harness.panel). Same set-up as canvas.test.mjs.
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
  const f = page.frames().find((fr) => fr.url().endsWith("/harness/canvas.html"));
  await f.waitForFunction(() => document.querySelector("b42-review") && document.documentElement.hasAttribute("data-b42-review"));
  return f;
}

/** The canvas test page in canvas mode, with the inspector the host's: it says so first. */
async function open() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=150&page=canvas`);
  const f = await pageFrame(page);
  await page.evaluate(() => window.__harness.hostDocks(["canvas"]));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await page.waitForFunction(() => window.__harness.panel.some((m) => m.panel === "canvas" && m.view));
  return { page, f, errors };
}

const frames = (f, n = 2) => f.evaluate((k) => new Promise((done) => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : done());
  step();
}), n);
const clickAt = async (page, f, sel, dx, dy) => {
  const b = await f.locator(sel).first().boundingBox();
  await page.mouse.click(b.x + (dx ?? b.width / 2), b.y + (dy ?? b.height / 2));
  await frames(f);
};
/** The view the overlay sent last. */
const view = (page) => page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "canvas" && m.view).at(-1).view);
/** Wait until the last view passes `fn` (a function of the view, as source). */
const until = (page, fn) => page.waitForFunction(`(() => { const v = window.__harness.panel.filter((m) => m.panel === "canvas" && m.view).at(-1)?.view; return !!v && (${fn})(v); })()`);
const act = (page, a) => page.evaluate((x) => window.__harness.act("canvas", x), a);
const style = (f, sel, prop) => f.evaluate(([s, p]) => getComputedStyle(document.querySelector(s)).getPropertyValue(p), [sel, prop]);
/** The layer's bar and the "?" in its corner: shown or not. */
const barShown = (f) => f.evaluate(() => {
  const r = document.querySelector("b42-review").shadowRoot;
  return { bar: !r.querySelector(".bar").hidden, corner: !r.querySelector(".corner").hidden };
});
const SECOND = "#plans article:nth-of-type(2)";

test("hosted: the layer shows no inspector and makes no room; the view names the selection, its rows, values and variables", async () => {
  const { page, f, errors } = await open();
  const s = await f.evaluate(() => ({
    insp: !!document.querySelector("b42-review").shadowRoot.querySelector(".insp, .sug, textarea:not(.card textarea)"),
    bar: document.querySelector("b42-review").shadowRoot.querySelector(".bar").checkVisibility(),
    room: getComputedStyle(document.documentElement).paddingBottom,
  }));
  assert.deepEqual(s, { insp: false, bar: false, room: "0px" }); // (the bar is the host's footer)
  let v = await view(page);
  assert.equal(v.sel, null);
  assert.equal(v.global, true, "nothing selected: the stylesheet");
  assert.equal(v.tree.rows[0].tag, "body");
  assert.equal(v.tree.rows[0].kids, "open");

  await clickAt(page, f, SECOND, 100, 80);
  v = await until(page, "(v) => v.sel && v.computed.length").then(() => view(page));
  // What it is, not what it says: no words of the page in the header.
  assert.equal(v.sel.label, await f.evaluate((s) => { const e = document.querySelector(s); return `${e.localName}${e.id ? `#${e.id}` : ""}.${e.getAttribute("class").trim().split(/\s+/).slice(0, 4).join(".")}`; }, SECOND));
  assert.equal(v.sel.tag, v.sel.label);
  assert.doesNotMatch(v.sel.label, /Pro|small teams/);
  assert.equal(v.global, false);
  assert.equal(v.classes.text, await f.evaluate((s) => document.querySelector(s).getAttribute("class") ?? "", SECOND));
  // its row is among those sent, opened down to it, and named as the selection
  const row = v.tree.rows[v.tree.sel - v.tree.first];
  assert.ok(row, `row ${v.tree.sel} in ${v.tree.first}…${v.tree.first + v.tree.rows.length}`);
  assert.equal(row.id, v.sel.id);
  assert.equal(row.tag, "article");
  assert.equal(v.computed.find((c) => c.prop === "padding").value, "16px");
  assert.ok(v.tokens.length > 0 && v.tokens.every((t) => t.name.startsWith("--")), "the page's variables, for the suggestions");
  // only what the host shows, not the whole document
  assert.ok(v.tree.rows.length <= 90, `${v.tree.rows.length} rows`);
  const weight = await page.evaluate(() => JSON.stringify(window.__harness.panel.filter((m) => m.view).at(-1)).length);
  assert.ok(weight < 40000, `a view weighs ${weight} bytes`);
  // a ping is answered at once
  await act(page, { type: "ping", id: 3 });
  await page.waitForFunction(() => window.__harness.panel.some((m) => m.pong === 3));
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted tree: a row opens and closes, is selected, outlined from the host; arrows walk", async () => {
  const { page, f, errors } = await open();
  let v = await view(page);
  const plans = v.tree.rows.find((r) => r.idName === "#plans") ?? null;
  const main = plans ?? v.tree.rows.find((r) => r.kids === "shut");
  assert.ok(main, "a shut row under body");
  await act(page, { type: "open", id: main.id });
  v = await until(page, `(v) => v.tree.rows.find((r) => r.id === ${main.id})?.kids === "open"`).then(() => view(page));
  const child = v.tree.rows[v.tree.rows.findIndex((r) => r.id === main.id) + 1];
  assert.equal(child.depth, main.depth + 1);
  await act(page, { type: "select", id: child.id });
  v = await until(page, `(v) => v.sel?.id === ${child.id}`).then(() => view(page));
  assert.equal(v.tree.rows[v.tree.sel - v.tree.first].id, child.id);
  // the pointer on a row outlines its element on the page
  await act(page, { type: "hover", id: main.id });
  await until(page, `(v) => v.tree.hover === ${main.id}`);
  assert.equal(await f.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".box.hover").length > 0), true);
  await act(page, { type: "hover", id: 0 });
  // ↓ the next row, ← back out to the parent, ← again closes it
  await act(page, { type: "walk", key: "ArrowDown" });
  v = await until(page, `(v) => v.sel && v.sel.id !== ${child.id}`).then(() => view(page));
  await act(page, { type: "walk", key: "ArrowLeft" });
  await until(page, `(v) => v.sel?.id === ${main.id}`);
  await act(page, { type: "walk", key: "ArrowLeft" });
  await until(page, `(v) => v.tree.rows.find((r) => r.id === ${main.id})?.kids === "shut"`);
  // Esc: the selection goes; once more, canvas mode goes
  await act(page, { type: "escape" });
  await until(page, "(v) => v.sel === null");
  await act(page, { type: "escape" });
  await page.waitForFunction(() => window.__harness.mode === "notes");
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted fields: classes and Element styles are typed in the host; the view marks what is not applied", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const v = await until(page, "(v) => v.sel").then(() => view(page));
  const id = v.sel.id;
  await act(page, { type: "text", field: "classes", id, text: `${v.classes.text} tile` });
  await f.waitForFunction((s) => document.querySelector(s).classList.contains("tile"), SECOND);
  await until(page, `(v) => v.classes.text.endsWith(" tile")`);

  await act(page, { type: "text", field: "css", id, text: "padding: 32px;\ncolor: nope;" });
  const bad = await until(page, `(v) => v.css.text.startsWith("padding: 32px") && v.css.marks.length && v.computed.find((c) => c.prop === "padding")?.mine`).then(() => view(page));
  assert.deepEqual(bad.css.marks.map((m) => [m.s, m.e, m.why]), [[15, 26, "invalid value for color"]]);
  assert.equal(bad.css.error, "Not applied: invalid value for color");
  await f.waitForFunction((s) => getComputedStyle(document.querySelector(s)).paddingTop === "32px", SECOND);
  assert.equal(bad.computed.find((c) => c.prop === "padding")?.mine, true);

  await act(page, { type: "text", field: "css", id, text: "padding: 32px;\ncolor: red;" });
  const good = await until(page, `(v) => v.css.text.endsWith("red;") && !v.css.marks.length`).then(() => view(page));
  assert.equal(good.css.error, "");
  await f.waitForFunction((s) => getComputedStyle(document.querySelector(s)).color === "rgb(255, 0, 0)", SECOND);
  // typing for a selection that has gone does nothing
  await act(page, { type: "text", field: "css", id: id + 999, text: "padding: 1px;" });
  await frames(f, 3);
  assert.equal(await style(f, SECOND, "padding-top"), "32px");
  // the stylesheet: Global
  await act(page, { type: "global", on: true });
  await until(page, "(v) => v.global");
  await act(page, { type: "text", field: "sheet", text: ".tile { outline: 2px solid red; }\nnope {" });
  const sheet = await until(page, `(v) => v.sheet.text.startsWith(".tile") && v.sheet.marks.length`).then(() => view(page));
  assert.match(sheet.sheet.error, /unbalanced braces/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted fields: the same text in the two boxes is judged as each box's own: a declaration is fine in Element styles and outside a rule in the stylesheet", async () => {
  const TEXT = "color: red;";
  // The stylesheet first, then Element styles; and the other way round.
  for (const order of [["sheet", "css"], ["css", "sheet"]]) {
    const { page, f, errors } = await open();
    await clickAt(page, f, SECOND, 100, 80);
    const { sel: { id } } = await until(page, "(v) => v.sel").then(() => view(page));
    for (const field of order) {
      await act(page, { type: "text", field, text: TEXT, ...(field === "css" ? { id } : {}) });
      await until(page, `(v) => v.${field}.text === ${JSON.stringify(TEXT)}`); // (the first is judged before the second is typed)
    }
    const v = await view(page);
    assert.deepEqual({ error: v.css.error, marks: v.css.marks }, { error: "", marks: [] }, `Element styles, typed ${order.join(" then ")}`);
    assert.match(v.sheet.error, /^Not applied: .*outside a rule/, `the stylesheet, typed ${order.join(" then ")}`);
    assert.equal(v.sheet.marks.length, 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("hosted values: a computed value set is one undo step; a scrub is live and one step; Esc during it puts it back; undo and redo", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const { sel: { id } } = await until(page, "(v) => v.sel").then(() => view(page));
  await act(page, { type: "value", id, prop: "padding", value: "24px" });
  await f.waitForFunction((s) => getComputedStyle(document.querySelector(s)).paddingTop === "24px", SECOND);
  await until(page, `(v) => v.css.text === "padding: 24px;"`);
  await until(page, "(v) => v.batch.undo && v.batch.edits === 1"); // an undo step at once
  // a value the browser does not take is not written
  await act(page, { type: "value", id, prop: "padding", value: "lots" });
  await frames(f, 3);
  assert.equal((await view(page)).css.text, "padding: 24px;");

  // a scrub: many live values, held, then one commit
  await act(page, { type: "commit" });
  for (const w of [210, 220, 230, 240]) {
    await act(page, { type: "value", id, prop: "width", value: `${w}px`, live: true, hold: true });
    await f.waitForFunction(([s, x]) => Math.round(document.querySelector(s).getBoundingClientRect().width) === x, [SECOND, w]);
  }
  await page.waitForTimeout(800); // a pause does not end the step
  await act(page, { type: "commit" });
  await until(page, `(v) => v.css.text === "padding: 24px;\\nwidth: 240px;"`);
  await act(page, { type: "undo" });
  await until(page, `(v) => v.css.text === "padding: 24px;"`);
  assert.equal(await style(f, SECOND, "width") !== "240px", true);
  await act(page, { type: "redo" });
  await until(page, `(v) => v.css.text === "padding: 24px;\\nwidth: 240px;"`);
  // Esc during a scrub: back to the step before it
  const force = (await view(page)).force;
  await act(page, { type: "value", id, prop: "width", value: "300px", live: true, hold: true });
  await until(page, `(v) => v.css.text.endsWith("width: 300px;")`);
  await act(page, { type: "revert" });
  const back = await until(page, `(v) => v.css.text === "padding: 24px;\\nwidth: 240px;"`).then(() => view(page));
  assert.ok(back.force > force, "the fields take the view's text");
  assert.equal(Math.round(await f.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, SECOND)), 240);
  // the token button's write, and the name's copy, are values too; mod+Enter sends from the host
  await act(page, { type: "send" });
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const note = await page.evaluate(() => window.__harness.notes[0]);
  assert.deepEqual(note.edits.map((e) => e.kind), ["style"]);
  assert.equal(note.edits[0].css, "padding: 24px;\nwidth: 240px;");
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted: the bar is the inspector's footer: none on the page; the view says what it would, its acts are its controls", async () => {
  const { page, f, errors } = await open();
  await frames(f);
  assert.deepEqual(await barShown(f), { bar: false, corner: false });
  let v = await view(page);
  assert.deepEqual(v.batch, { edits: 0, undo: false, redo: false, note: "", msg: "", status: "" });
  // Send with nothing edited: refused, for a moment.
  await act(page, { type: "send" });
  await until(page, `(v) => v.batch.msg.startsWith("Nothing to send yet")`);
  await until(page, `(v) => v.batch.msg === ""`); // (it goes by itself)

  // An edit and the note's words: counted, kept as the layer's own field's (the draft has them).
  await clickAt(page, f, SECOND, 100, 80);
  const { sel: { id } } = await until(page, "(v) => v.sel").then(() => view(page));
  await act(page, { type: "value", id, prop: "padding", value: "24px" });
  await act(page, { type: "note", text: "roomier\nplease" });
  v = await until(page, `(v) => v.batch.edits === 1 && v.batch.note === "roomier please"`).then(() => view(page));
  assert.equal(v.batch.undo, true);
  await page.waitForFunction(() => window.__harness.draft?.note === "roomier please");
  // Reset: no edits, one step; undo brings them back.
  await act(page, { type: "reset" });
  await until(page, "(v) => v.batch.edits === 0 && v.batch.undo && !v.css.text");
  assert.notEqual(await style(f, SECOND, "padding-top"), "24px");
  await act(page, { type: "undo" });
  await until(page, "(v) => v.batch.edits === 1 && v.batch.redo");
  assert.equal(await style(f, SECOND, "padding-top"), "24px");

  // Send: a note with the words, the batch empty again, and the line says it was sent.
  await act(page, { type: "send" });
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const note = await page.evaluate(() => window.__harness.notes[0]);
  assert.equal(note.text, "roomier please");
  assert.deepEqual(note.edits.map((e) => e.kind), ["style"]);
  v = await until(page, "(v) => v.batch.edits === 0 && v.batch.note === '' && v.batch.status.startsWith('Sent')").then(() => view(page));
  assert.equal(v.batch.undo, false);
  // Back in notes mode with no unsent edits: no bar; nothing of the layer's bar came back in canvas mode.
  await frames(f);
  assert.deepEqual(await barShown(f), { bar: false, corner: false });
  assert.deepEqual(errors, []);
  await page.close();
});

test("not hosted: no inspector and no bar, on the page or in views; canvas mode still edits the page", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${base}/?delay=150&page=canvas`);
  const f = await pageFrame(page);
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await frames(f, 3);
  assert.deepEqual(await barShown(f), { bar: false, corner: false });
  // the drags work the page without one, and Enter sends
  await clickAt(page, f, SECOND, 100, 80);
  const b = await f.locator(SECOND).boundingBox();
  await page.mouse.move(b.x + b.width, b.y + 30);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + 30, { steps: 8 });
  await frames(f);
  await page.mouse.up();
  await frames(f);
  assert.equal(Math.round((await f.locator(SECOND).boundingBox()).width), 260);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__harness.panel.filter((m) => m.panel === "canvas").length), 0, "no view was sent");
  assert.equal(await f.evaluate(() => getComputedStyle(document.documentElement).paddingBottom), "0px", "and no room made");
  // hosted while it is up: the views start; given back: they stop, and nothing comes on the page
  await page.evaluate(() => window.__harness.hostDocks(["canvas"]));
  await page.waitForFunction(() => window.__harness.panel.some((m) => m.panel === "canvas" && m.view));
  await page.evaluate(() => window.__harness.hostDocks([]));
  await frames(f, 3);
  const n = await page.evaluate(() => window.__harness.panel.length);
  await clickAt(page, f, "#title");
  await frames(f, 3);
  assert.equal(await page.evaluate(() => window.__harness.panel.length), n);
  assert.deepEqual(await barShown(f), { bar: false, corner: false });
  await page.close();
});

test("hosted, after a reload: the host is told again, the view comes back with the batch", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const { sel: { id } } = await until(page, "(v) => v.sel").then(() => view(page));
  await act(page, { type: "text", field: "css", id, text: "padding: 40px;" });
  await act(page, { type: "commit" });
  await page.waitForFunction(() => window.__harness.draft?.edits);
  const before = await page.evaluate(() => window.__harness.panel.length);
  await page.click("#reload");
  await page.waitForTimeout(150);
  const f2 = await pageFrame(page);
  await f2.waitForFunction((s) => getComputedStyle(document.querySelector(s)).paddingTop === "40px", SECOND);
  // canvas mode is still on, and a fresh view says what the reloaded page has
  await page.waitForFunction((n) => window.__harness.panel.slice(n).some((m) => m.panel === "canvas" && m.view), before);
  assert.equal(await f2.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelector(".bar").checkVisibility()), false);
  await clickAt(page, f2, SECOND, 10, 10); // (in its padding: the card grew by it)
  const v = await until(page, `(v) => v.sel && v.css.text === "padding: 40px;"`).then(() => view(page));
  assert.equal(v.tree.rows[v.tree.sel - v.tree.first]?.ed, true, "its row has the edited dot");
  // a host that starts again asks for the whole view: it is sent even though nothing changed
  const n = await page.evaluate(() => window.__harness.panel.length);
  await act(page, { type: "tree", first: 0, count: 20 });
  await page.waitForFunction((k) => window.__harness.panel.slice(k).some((m) => m.view), n);
  assert.deepEqual(errors, []);
  await page.close();
});

test("hosted edits list: opened from the footer, the view lists the unsent edits in words; a row selects, its × removes that one edit as an undo step", async () => {
  const { page, f, errors } = await open();
  const drag = async (x, y, x2, y2) => {
    await page.mouse.move(x, y);
    await frames(f);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 });
    await frames(f);
    await page.mouse.up();
    await frames(f);
  };
  await clickAt(page, f, SECOND, 100, 80);
  const b = await f.locator(SECOND).boundingBox();
  await drag(b.x + b.width, b.y + 30, b.x + b.width + 60, b.y + 30);
  await act(page, { type: "global", on: true });
  await act(page, { type: "text", field: "sheet", text: ".tile { color: red; }" });
  await act(page, { type: "commit" });
  await clickAt(page, f, "#cta");
  await page.keyboard.press("Delete");
  await until(page, "(v) => v.batch.edits === 3");
  assert.equal((await view(page)).batch.list, undefined, "shut: no list in the view");
  // open: each edit, as the bar worded it
  await act(page, { type: "edits", open: true });
  let v = await until(page, "(v) => v.batch.list").then(() => view(page));
  assert.deepEqual(v.batch.list.map((r) => `${r.label} — ${r.text}`), ["Card · Pro For small teams — width 200 → 260", "Button · Start free trial — hidden", "Stylesheet — 1 rule"]);
  assert.equal(v.batch.list[2].id, undefined, "the stylesheet is no element's");
  // a row selects its element, hidden or not, and brings it into view
  const hid = v.batch.list[1];
  await act(page, { type: "select", id: hid.id, show: true });
  v = await until(page, `(v) => v.sel?.id === ${hid.id}`).then(() => view(page));
  assert.equal(v.sel.hidden, true);
  assert.deepEqual(v.tree.rows.filter((r) => r.hid).map((r) => r.tag + r.idName), ["button#cta"]);
  assert.deepEqual(v.tree.rows.filter((r) => r.ed).map((r) => r.tag + r.cls), ["article.card"]);
  // × takes that one edit away, and that is a step like any other
  await act(page, { type: "unedit", key: hid.key });
  v = await until(page, "(v) => v.batch.edits === 2 && v.batch.list?.length === 2").then(() => view(page));
  assert.notEqual(await style(f, "#cta", "display"), "none");
  await act(page, { type: "undo" });
  await until(page, "(v) => v.batch.list?.length === 3");
  assert.equal(await style(f, "#cta", "display"), "none");
  // the stylesheet's row is removed by its key too
  await act(page, { type: "unedit", key: "sheet" });
  await until(page, "(v) => v.batch.edits === 2 && !v.sheet.text");
  assert.notEqual(await style(f, "#grid .tile", "color"), "rgb(255, 0, 0)");
  // a key the batch no longer has does nothing
  await act(page, { type: "unedit", key: "sheet" });
  await frames(f, 3);
  assert.equal((await view(page)).batch.edits, 2);
  // Esc closes the list before anything else; a press on the page closes it too
  await act(page, { type: "escape" });
  v = await until(page, "(v) => !v.batch.list").then(() => view(page));
  assert.ok(v.sel, "the selection stayed");
  await act(page, { type: "edits", open: true });
  await until(page, "(v) => v.batch.list");
  await clickAt(page, f, "#title");
  await until(page, "(v) => !v.batch.list");
  // and it shuts by itself once the last edit is gone (and stays shut when asked with none)
  await act(page, { type: "edits", open: true });
  await until(page, "(v) => v.batch.list");
  await act(page, { type: "reset" });
  await until(page, "(v) => v.batch.edits === 0 && !v.batch.list");
  await act(page, { type: "edits", open: true });
  await frames(f, 3);
  assert.equal((await view(page)).batch.list, undefined);
  assert.deepEqual(errors, []);
  await page.close();
});
