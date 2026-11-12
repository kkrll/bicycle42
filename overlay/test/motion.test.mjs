// End-to-end tests for motion mode (the dock, the timeline, sending one animation) on
// harness/motion-page.html. Same set-up as overlay.test.mjs: a system Chromium, headless. Run: bun run test
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

async function pageFrame(page) {
  await page.waitForFunction(() => document.getElementById("page").contentWindow?.__b42);
  const f = page.frames().find((fr) => fr.url().endsWith("/harness/motion-page.html"));
  await f.waitForFunction(() => document.querySelector("b42-review") && document.documentElement.hasAttribute("data-b42-review"));
  return f;
}

/** Open the motion test page; with `motion`, switch to motion mode as the host's switch does. */
async function open({ delay = 150, motion = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=${delay}&page=motion`);
  const f = await pageFrame(page);
  if (motion) await motionOn(f);
  return { page, f, errors };
}
const motionOn = async (f) => {
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "motion" }));
  await f.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".m-dock").hidden);
};
const frames = (f, n = 2) => f.evaluate((k) => new Promise((done) => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : done());
  step();
}), n);
/** Something in the layer's shadow root, as a locator. */
const ui = (f, sel) => f.locator(`b42-review >> css=${sel}`);
/** What the layer's shadow root says, read in the page. */
const inLayer = (f, fn, arg) => f.evaluate(([src, a]) => new Function("r", "a", `return (${src})(r, a)`)(document.querySelector("b42-review").shadowRoot, a), [fn.toString(), arg]);
/** Every rule the page has adopted from us (the unsent sheet and the sent ones), as text. */
const adopted = (f) => f.evaluate(() => document.adoptedStyleSheets.map((s) => [...s.cssRules].map((r) => r.cssText).join("\n")).join("\n"));
const clickEl = async (page, f, sel) => {
  const b = await f.locator(sel).first().boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await frames(f);
};
const host = (page) => page.evaluate(() => ({ mode: window.__harness.mode, draft: window.__harness.draft, notes: window.__harness.notes }));

test("motion mode: the host's switch opens the dock and the overlay says the mode back", async () => {
  const { page, f, errors } = await open();
  assert.equal((await host(page)).mode, "motion");
  const rows = await inLayer(f, (r) => [...r.querySelectorAll(".m-list .m-grp, .m-list .m-it")].map((e) => (e.classList.contains("m-grp") ? `#${e.textContent}` : e.querySelector(".m-nm").textContent)));
  for (const want of ["#Animations", "spin", "rise", "pulse", "card-in", "#Transitions", "#Scripts", "bob", "#Unused", "wiggle"]) assert.ok(rows.includes(want), `${want} in ${rows.join(" ")}`);
  // rise is played by two elements: they are listed under it
  assert.ok(rows.indexOf("Ship calmer interfaces") === rows.indexOf("rise") + 1, rows.join(" | "));
  // the frame-by-frame bar is found once it has moved for a while
  await f.waitForFunction(() => [...document.querySelector("b42-review").shadowRoot.querySelectorAll(".m-it.k-frames")].length > 0, null, { timeout: 3000 });
  // the canvas bar is not in the way
  assert.equal(await inLayer(f, (r) => r.querySelector(".bar").hidden), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a click on the page opens the first animation of what was clicked; its name is on a tag", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".hero h2");
  const s = await inLayer(f, (r) => ({ head: !r.querySelector(".m-hd").hidden, band: r.querySelector(".m-ghead b")?.textContent, lanes: [...r.querySelectorAll(".m-lane .m-lab span")].map((e) => e.textContent),
    shared: r.querySelector(".m-shared")?.textContent.trim(), tag: r.querySelector(".m-tag").textContent, on: r.querySelector(".m-it.on .m-nm")?.textContent }));
  assert.equal(s.head, true);
  assert.equal(s.band, "rise");
  assert.deepEqual(s.lanes, ["opacity", "transform"]);
  assert.equal(s.shared, "2 elements");
  assert.match(s.tag, /Heading · Ship calmer/);
  assert.equal(s.on, "Ship calmer interfaces");
  // a click on something that does not move says so, and offers a new animation
  await clickEl(page, f, ".card h3");
  assert.equal(await inLayer(f, (r) => !!r.querySelector(".m-empty [data-m=new]")), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("dragging a grip moves the keyframe, live and undoably; a value typed for it applies", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".hero h2");
  const g = await ui(f, '.m-kspan[data-prop="opacity"] .m-key[data-at="100"]').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 100, g.y + g.height / 2, { steps: 6 });
  await page.mouse.up();
  await frames(f);
  const css = await adopted(f);
  assert.match(css, /@keyframes rise \{[^]*?\d+% \{ opacity: 1; \}/, css);
  const at = await inLayer(f, (r) => r.querySelector('.m-kspan[data-prop="opacity"] .m-key.on')?.dataset.at);
  assert.ok(Number(at) < 100 && Number(at) > 50, `moved to ${at}`);
  // the selected keyframe's value
  await ui(f, ".m-kb [data-k=val]").fill("0.6");
  await ui(f, ".m-kb [data-k=val]").press("Enter");
  assert.match(await adopted(f), new RegExp(`${at}% \\{ opacity: 0\\.6; \\}`));
  // undo, twice: the page's own keyframes again
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await frames(f);
  assert.doesNotMatch(await adopted(f), /@keyframes rise/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("timing belongs to the element: a duration typed writes its animation, not the keyframes", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".hero p");
  await ui(f, "[data-t=duration]").fill("900");
  await ui(f, "[data-t=duration]").press("Enter");
  const css = await adopted(f);
  assert.match(css, /section\.hero|body > section/);
  // (the browser writes the shorthand back in its own order)
  assert.match(css, /animation: 900ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\) 120ms 1 normal both running rise;/, css);
  assert.doesNotMatch(css, /@keyframes/);
  // the more popover: chips set how it plays
  await ui(f, "[data-m=more]").click();
  await ui(f, '.m-pop [data-tkey=direction] [data-v=alternate]').click();
  assert.match(await adopted(f), /alternate/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Enter sends the open animation as one note; it stays applied until the note is done", async () => {
  const { page, f, errors } = await open({ delay: 700 });
  await clickEl(page, f, ".hero p");
  await ui(f, "[data-t=duration]").fill("900");
  await ui(f, "[data-t=duration]").press("Enter");
  await ui(f, ".m-note").fill("calmer");
  await ui(f, ".m-note").press("Enter");
  await page.waitForFunction(() => window.__harness.notes.length === 1);
  const note = (await host(page)).notes[0];
  assert.equal(note.text, "calmer");
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
  await frames(f, 4);
  assert.equal(await inLayer(f, (r) => r.querySelector(".m-msg").textContent), "Sent · preview stays until note 1 is done");
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
  await ui(f, "[data-t=duration]").fill("950");
  await ui(f, "[data-t=duration]").press("Enter");
  await ui(f, ".m-note").fill("slower");
  await ui(f, ".m-go").click();
  await frames(f, 6);
  const s = await inLayer(f, (r) => ({ msg: r.querySelector(".m-msg").textContent, note: r.querySelector(".m-note").value, dur: r.querySelector("[data-t=duration]")?.value }));
  assert.match(s.msg, /Not sent: the server is offline/);
  assert.equal(s.note, "slower");
  assert.equal(s.dur, "950");
  assert.match(await adopted(f), /950ms[^;]* rise;/);
  assert.equal((await host(page)).notes.length, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("unsent edits survive a reload: the host keeps them, the page comes back in motion mode", async () => {
  const { page, f: f1, errors } = await open();
  await clickEl(page, f1, ".hero h2");
  await ui(f1, "[data-t=duration]").fill("1200");
  await ui(f1, "[data-t=duration]").press("Enter");
  await page.waitForFunction(() => window.__harness.draft && window.__harness.draft.motion);
  await page.click("#reload");
  await page.waitForTimeout(300);
  const f = await pageFrame(page);
  await f.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".m-dock").hidden);
  assert.equal((await host(page)).mode, "motion");
  await f.waitForFunction(() => document.adoptedStyleSheets.some((s) => [...s.cssRules].some((r) => /1200ms[^;]* rise;/.test(r.cssText))));
  // the list marks what is changed and unsent
  assert.equal(await inLayer(f, (r) => !!r.querySelector(".m-it.sub .m-ed")), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Esc steps back: the keyframe, the animation, then notes mode; nothing is left stopped", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".sync .spinner");
  await ui(f, '.m-kspan .m-key').first().click();
  assert.equal(await f.evaluate(() => document.querySelector(".spinner").getAnimations()[0].playState), "paused");
  await page.keyboard.press("Escape");
  assert.equal(await inLayer(f, (r) => !!r.querySelector(".m-key.on")), false);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__harness.mode === "notes");
  await frames(f);
  assert.equal(await inLayer(f, (r) => r.querySelector(".m-dock").hidden), true);
  assert.equal(await f.evaluate(() => document.querySelector(".spinner").getAnimations()[0].playState), "running");
  assert.deepEqual(errors, []);
  await page.close();
});

test("shared keyframes: Only this one gives the element its own copy; the note says so", async () => {
  const { page, f, errors } = await open();
  await clickEl(page, f, ".hero p");
  await ui(f, '.m-kspan[data-prop="opacity"] .m-key[data-at="0"]').click();
  await ui(f, ".m-kb [data-k=val]").fill("0.3");
  await ui(f, ".m-kb [data-k=val]").press("Enter");
  await ui(f, "[data-m=detach]").click();
  await frames(f);
  const css = await adopted(f);
  assert.match(css, /@keyframes rise-2 \{[^]*?0% \{ opacity: 0\.3;/, css);
  assert.doesNotMatch(css, /@keyframes rise \{/); // the heading keeps the page's own
  assert.match(css, /animation: 700ms[^;]* rise-2;/);
  assert.equal(await inLayer(f, (r) => r.querySelector(".m-shared").textContent.trim()), "Own copy of rise");
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
