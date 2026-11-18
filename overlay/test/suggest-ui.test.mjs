// The inspector's suggestions in a browser (src/canvas/suggest.js), on harness/canvas.html: the
// list, its keys, the live preview and what undo makes of it. Same set-up as canvas.test.mjs.
// (What is at the caret, matching and order are tested without a browser, in suggest.test.mjs.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { serve } from "../scripts/serve.mjs";
import { COLOURS } from "../src/canvas/suggest-model.js";

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

/** The canvas test page in canvas mode, with the flex row (#plans) selected. */
async function open() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=150&page=canvas`);
  await page.waitForFunction(() => document.getElementById("page").contentWindow?.__b42);
  const f = page.frames().find((fr) => fr.url().endsWith("/harness/canvas.html"));
  await f.waitForFunction(() => document.querySelector("b42-review") && document.documentElement.hasAttribute("data-b42-review"));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await f.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".insp").hidden);
  const b = await f.locator("#plans").boundingBox();
  await page.mouse.click(b.x + b.width - 5, b.y + 5); // the row itself, not a card
  await f.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelectorAll(".crow").length > 0);
  const ui = (fn, arg) => f.evaluate(`(${fn})(document.querySelector("b42-review").shadowRoot, ${JSON.stringify(arg ?? null)})`);
  /** A pause in the typing, and the frames in which the page and the list follow. */
  const settle = async (ms = 160) => {
    await new Promise((r) => setTimeout(r, ms));
    await f.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const press = async (...keys) => {
    for (const k of keys) await page.keyboard.press(k);
    await settle();
  };
  const type = async (text) => {
    await page.keyboard.type(text);
    await settle();
  };
  /** The list: null when closed, else its items, the highlighted one and where it is. */
  const list = () => ui((r) => {
    const l = r.querySelector(".sug");
    if (l.hidden || l.style.visibility === "hidden") return null;
    const b = l.getBoundingClientRect();
    // (an item's own text: a variable's value beside it is in its .tv)
    const own = (c) => (c ? [...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("") : undefined);
    return { items: [...l.children].map(own), on: own(l.querySelector(".sg.on")), vals: [...l.children].map((c) => c.querySelector(".tv")?.textContent ?? null),
      swatches: [...l.children].map((c) => c.querySelector("i")?.style.background || null), x: b.x, y: b.y, w: b.width, h: b.height, scrolls: l.scrollHeight > l.clientHeight };
  });
  const value = (cls) => ui((r, c) => r.querySelector(`.${c}`).value, cls);
  const focus = () => ui((r) => r.activeElement?.className ?? "");
  const style = (sel, prop) => f.evaluate(([s, p]) => getComputedStyle(document.querySelector(s)).getPropertyValue(p), [sel, prop]);
  const row = (prop) => f.locator("b42-review .crow", { has: f.locator(".cp", { hasText: new RegExp(`^${prop}$`) }) }).locator(".cval");
  /** What is selected in a text area, and where it starts. */
  const sel = (cls) => ui((r, c) => { const x = r.querySelector(`.${c}`); return { text: x.value.slice(x.selectionStart, x.selectionEnd), at: x.selectionStart }; }, cls);
  const pick = (cls, a, b = a) => ui((r, [c, i, j]) => r.querySelector(`.${c}`).setSelectionRange(i, j), [cls, a, b]);
  /** A real double click on the letter at `offset` of a text area (found in the layer under it that mirrors its text). */
  const dbl = async (cls, offset) => {
    const at = await ui((r, [c, o]) => {
      const walk = document.createTreeWalker(r.querySelector(`.${c}`).previousElementSibling, NodeFilter.SHOW_TEXT);
      for (let n, left = o; (n = walk.nextNode()); left -= n.nodeValue.length) {
        if (left >= n.nodeValue.length) continue;
        const g = document.createRange();
        g.setStart(n, left);
        g.setEnd(n, left + 1);
        const b = g.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      return null;
    }, [cls, offset]);
    const frame = await page.locator("#page").boundingBox();
    await page.mouse.dblclick(frame.x + at.x, frame.y + at.y);
    await settle();
  };
  return { page, f, errors, ui, settle, press, type, list, value, focus, style, row, sel, pick, dbl };
}

test("element styles: names as a name is typed, then the property's values; Tab and Enter accept", async () => {
  const { page, f, errors, ui, press, type, list, value, focus, style } = await open();
  await f.locator("b42-review .css").click();
  assert.equal(await list(), null);
  await type("al");
  let l = await list();
  assert.deepEqual(l.items.slice(0, 3), ["align-items", "align-content", "align-self"]);
  assert.equal(l.on, "align-items");
  assert.ok(l.items.includes("vertical-align") && l.items.indexOf("vertical-align") > l.items.indexOf("all"), "names that only contain the word come last");
  assert.ok(l.h <= 168 && l.scrolls, "eight rows show, the rest scrolls");
  // In the layer, over the inspector and not cut by it; the field says what it controls.
  const a = await ui((r) => {
    const l = r.querySelector(".sug"), b = l.getBoundingClientRect(), t = r.querySelector(".css");
    const top = r.elementFromPoint(b.x + 20, b.y + 10);
    return { parent: l.parentNode === r, top: !!top && l.contains(top), role: l.getAttribute("role"), opt: l.firstChild.getAttribute("role"), sel: l.firstChild.getAttribute("aria-selected"),
      auto: t.getAttribute("aria-autocomplete"), exp: t.getAttribute("aria-expanded"), pop: t.getAttribute("aria-haspopup"), tRole: t.getAttribute("role"), act: t.getAttribute("aria-activedescendant"), id: l.firstChild.id, owns: t.getAttribute("aria-controls") === l.id,
      inView: b.x >= 0 && b.y >= 0 && b.right <= innerWidth && b.bottom <= innerHeight };
  });
  // (A text area is no combobox and has no aria-expanded: it says a list pops up, which, and the item in it.)
  assert.deepEqual(a, { parent: true, top: true, role: "listbox", opt: "option", sel: "true", auto: "list", exp: null, pop: "listbox", tRole: null, act: a.id, id: "b42-sg-0", owns: true, inView: true });
  assert.equal(await ui((r) => r.querySelectorAll("#b42-sug").length + r.querySelectorAll("#b42-sg-0").length), 2, "the ids are the one shadow root's, once each");

  await press("Tab");
  assert.equal(await value("css"), "align-items: ", "Tab takes the name and adds the colon, not two spaces");
  assert.equal(await focus(), "css", "…and the focus stays");
  l = await list();
  assert.deepEqual(l.items.slice(0, 4), ["normal", "stretch", "baseline", "center"], "the values open at once, in Chrome's order");
  assert.deepEqual(l.items.slice(-4), ["inherit", "initial", "unset", "revert"]);
  assert.ok(!l.items.includes("auto") && !l.items.includes("none"), "align-items takes neither auto nor none");

  await type("c");
  l = await list();
  assert.deepEqual(l.items.slice(0, 2), ["center", "stretch"], "what starts with it, then what contains it");
  await press("Enter");
  assert.equal(await value("css"), "align-items: center", "Enter takes the value: no new line");
  assert.equal(await list(), null);
  assert.equal(await style("#plans", "align-items"), "center");
  assert.deepEqual(await ui((r) => [r.querySelector(".css").getAttribute("aria-activedescendant"), r.querySelector(".css").getAttribute("aria-expanded")]), [null, null]);

  // Typing on: the list follows, and closes when nothing matches.
  await type(";\nzz");
  assert.equal(await list(), null);
  await press("Backspace", "Backspace");
  await type("wid");
  assert.equal((await list()).on, "width");
  await type("q");
  assert.equal(await list(), null, "nothing matches: closed");
  await press("Backspace");
  assert.equal(await list(), null, "deleting does not open it");
  await page.keyboard.press("Control+Space");
  await press();
  assert.equal((await list()).on, "width", "ctrl+space does");
  await press("Enter");
  l = await list();
  assert.ok(l.items.includes("auto") && l.items.includes("fit-content") && !l.items.includes("none"), l.items.join());
  await type("12");
  assert.equal(await list(), null, "a number is not completed");
  assert.equal(await value("css"), "align-items: center;\nwidth: 12");
  assert.deepEqual(errors, []);
  await page.close();
});

test("the highlighted value shows on the page; Escape puts back what was typed; one undo step at most", async () => {
  const { page, f, errors, press, type, list, value, focus, style, settle } = await open();
  await f.locator("b42-review .css").click();
  await type("align-items: st");
  await settle(800); // the typing is a step of its own
  assert.deepEqual((await list()).items, ["stretch", "start", "self-start", "flex-start"]);
  assert.equal(await style("#plans", "align-items"), "normal");
  await press("ArrowDown");
  assert.equal((await list()).on, "start");
  assert.equal(await value("css"), "align-items: start");
  assert.equal(await style("#plans", "align-items"), "start");
  await settle(800); // looked at for longer than a typing pause: still no step
  await press("ArrowDown", "ArrowDown");
  assert.equal(await value("css"), "align-items: flex-start");
  await press("ArrowDown");
  assert.equal((await list()).on, "stretch", "around the end");
  await press("ArrowUp");
  assert.equal(await style("#plans", "align-items"), "flex-start");
  await press("Escape");
  assert.equal(await list(), null);
  assert.equal(await value("css"), "align-items: st", "what was typed is back");
  assert.equal(await style("#plans", "align-items"), "normal");
  assert.equal(await focus(), "css", "Escape closed the list, not the field");
  await settle(800);
  await press(`${MOD}+z`);
  assert.equal(await value("css"), "", "the look through the list left no step: undo takes the typing");
  await press(`${MOD}+Shift+z`);
  assert.equal(await value("css"), "align-items: st");

  // The same, ended with Enter: one step.
  await f.locator("b42-review .css").click();
  await press("End");
  await page.keyboard.press("Control+Space");
  await press("ArrowDown");
  await settle(800);
  await press("ArrowDown", "Enter");
  assert.equal(await value("css"), "align-items: self-start");
  assert.equal(await style("#plans", "align-items"), "self-start");
  await settle(800);
  await press(`${MOD}+z`);
  assert.equal(await value("css"), "align-items: st");
  assert.equal(await style("#plans", "align-items"), "normal");
  assert.deepEqual(errors, []);
  await page.close();
});

test("the style boxes: ↑/↓ are the caret's; they step or cycle only a number or a keyword that is selected", async () => {
  const { page, f, errors, press, type, list, value, style, settle, sel, pick, dbl } = await open();
  await f.locator("b42-review .css").click();
  const text = "display: flex;\ngap: 12px;\nalign-items: center;\nmargin: -4px auto";
  await type(text);
  await settle(800); // the typing is a step of its own
  assert.equal(await value("css"), text);

  // A caret alone, in a keyword: ↓ goes to the next line, and the next, and changes nothing.
  await pick("css", text.indexOf("flex") + 2);
  await press("ArrowDown");
  let at = (await sel("css")).at;
  assert.ok(at > text.indexOf("gap") && at <= text.indexOf("align-items") - 1, `the caret is in the second line (${at})`);
  await press("ArrowDown", "ArrowDown");
  assert.ok((await sel("css")).at > text.indexOf("margin"), "…then in the last");
  assert.equal(await value("css"), text, "nothing changed");
  assert.equal(await style("#plans", "display"), "flex");
  // …and in a number.
  await pick("css", text.indexOf("12px") + 1);
  await press("ArrowUp");
  assert.deepEqual([await value("css"), (await sel("css")).at < text.indexOf("gap")], [text, true]);
  // With shift the arrows select, as they do in any text box.
  await pick("css", text.indexOf("flex") + 2);
  await press("Shift+ArrowDown");
  assert.deepEqual([await value("css"), (await sel("css")).text.includes("\n")], [text, true]);

  // A double click on a number, then ↑ ↑: stepped twice, still selected, the page following; one undo step.
  await dbl("css", text.indexOf("12px") + 1);
  assert.equal((await sel("css")).text, "12px");
  await press("ArrowUp");
  assert.deepEqual([(await sel("css")).text, await style("#plans", "gap")], ["13px", "13px"]);
  await press("ArrowUp");
  assert.equal(await value("css"), text.replace("12px", "14px"));
  assert.deepEqual(await sel("css"), { text: "14px", at: text.indexOf("12px") });
  assert.equal(await style("#plans", "column-gap"), "14px");
  await settle(800);
  await press(`${MOD}+z`);
  assert.equal(await value("css"), text, "the two presses were one step");
  assert.equal(await style("#plans", "column-gap"), "12px");
  // A part of a number selected (a double click takes "4px" of "-4px") is the whole of it; the modifiers are DevTools'.
  await pick("css", text.indexOf("-4px") + 1, text.indexOf("-4px") + 4);
  await press("ArrowUp");
  assert.equal((await sel("css")).text, "-3px");
  await press("Shift+ArrowDown");
  assert.equal((await sel("css")).text, "-13px");
  assert.equal(await value("css"), text.replace("-4px", "-13px"));

  // A double click on a keyword, then ↓: the property's next keyword, selected in its turn.
  await dbl("css", text.indexOf("center") + 2);
  assert.equal((await sel("css")).text, "center");
  await press("ArrowDown");
  assert.deepEqual([(await sel("css")).text, await style("#plans", "align-items"), await list()], ["start", "start", null]);
  await press("ArrowDown");
  assert.equal((await sel("css")).text, "end");
  await press("ArrowUp", "ArrowUp", "ArrowUp");
  assert.equal((await sel("css")).text, "baseline");
  let now = text.replace("-4px", "-13px").replace("center", "baseline");
  assert.equal(await value("css"), now);
  // Beside another token a CSS-wide keyword is no value: `-13px auto` never becomes `-13px revert`.
  await pick("css", now.indexOf("auto"), now.indexOf("auto") + 4);
  await press("ArrowUp");
  assert.deepEqual([await value("css"), (await sel("css")).text], [now, "auto"]);
  await press("ArrowDown");
  assert.equal(await value("css"), now);
  // …alone it has them, around the end of the list.
  await pick("css", now.indexOf("baseline"), now.indexOf("baseline") + 8);
  await press("ArrowUp", "ArrowUp", "ArrowUp");
  assert.equal((await sel("css")).text, "revert");
  await press("ArrowDown", "ArrowDown", "ArrowDown");
  assert.deepEqual([await value("css"), (await sel("css")).text], [now, "baseline"]);
  // More than one token selected, or a name: the keys are the field's.
  await pick("css", now.indexOf("-13px"), now.length);
  await press("ArrowUp");
  assert.equal(await value("css"), now);
  await pick("css", now.indexOf("align"), now.indexOf("align") + 5);
  await press("ArrowDown");
  assert.equal(await value("css"), now);
  assert.equal(await list(), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Enter after a whole keyword is a new line, though longer keywords start with it; shift+↓ is not the list's", async () => {
  const { page, f, errors, ui, press, type, list, value, style } = await open();
  await f.locator("b42-review .css").click();
  await type("display: flex");
  assert.deepEqual([(await list()).on, (await list()).items.includes("inline-flex")], ["flex", true], "the list is open, on what is typed");
  await press("Enter");
  assert.equal(await list(), null);
  await type("gap: 4px");
  assert.equal(await value("css"), "display: flex\ngap: 4px", "two lines");
  // The highlight moved: Enter takes what it is on, as before.
  await type(";\ndisplay: flex");
  await press("ArrowDown", "Enter");
  assert.equal(await value("css"), "display: flex\ngap: 4px;\ndisplay: inline-flex");
  assert.equal(await style("#plans", "display"), "inline-flex");
  // A name is taken with its colon, whole or not.
  await type(";\ngap");
  assert.equal((await list()).on, "gap");
  await press("Enter");
  assert.equal(await value("css"), "display: flex\ngap: 4px;\ndisplay: inline-flex;\ngap: ");
  // shift+↓ selects: the list closes, its highlight goes nowhere and nothing is shown on the page.
  await type("0;\nalign-items: st");
  const before = await value("css");
  assert.equal((await list()).on, "stretch");
  await press("Shift+ArrowDown");
  assert.equal(await list(), null);
  assert.deepEqual([await value("css"), await style("#plans", "align-items")], [before, "normal"]);
  await page.keyboard.press("Control+Space");
  await press();
  assert.equal((await list()).on, "stretch");
  await press("Shift+ArrowUp");
  assert.equal(await list(), null);
  assert.equal(await value("css"), before);
  assert.ok((await ui((r) => r.querySelector(".css").selectionEnd - r.querySelector(".css").selectionStart)) > 0, "shift+↑ selected a line");
  assert.deepEqual(errors, []);
  await page.close();
});

test("names are properties this browser takes: no descriptors, nothing it would flag as unknown", async () => {
  const { page, f, errors, press, type, list } = await open();
  await f.locator("b42-review .css").click();
  await type("sr");
  assert.ok(!(await list())?.items.includes("src"), "src is @font-face's, not a property");
  await press("Backspace", "Backspace");
  await page.keyboard.press("Control+Space");
  await press();
  const all = (await list()).items;
  assert.ok(all.length > 450, `${all.length} names`);
  assert.deepEqual(await f.evaluate((names) => names.filter((n) => !CSS.supports(n, "initial")), all), [], "none of them would be flagged as unknown");
  for (const d of ["src", "syntax", "inherits", "unicode-range", "system", "pad", "range", "fallback", "font-display", "origin-trial-test-property"]) assert.ok(!all.includes(d), d);
  assert.ok(all.includes("scrollbar-color") && all.includes("align-items") && all.includes("font-family"));
  assert.deepEqual(errors, []);
  await page.close();
});

test("the named colours are offered wherever a colour goes, with their swatch", async () => {
  const { page, f, errors, ui, press, type, list, value, style } = await open();
  await f.locator("b42-review .css").click();
  await type("color: re");
  let l = await list();
  assert.deepEqual(l.items.slice(0, 3), ["rebeccapurple", "red", "revert"]);
  const swatch = () => ui((r) => Object.fromEntries([...r.querySelectorAll(".sug .sg")].slice(0, 3).map((g) => [g.textContent, g.firstElementChild ? g.firstElementChild.style.background : null])));
  assert.deepEqual(await swatch(), { rebeccapurple: "rebeccapurple", red: "red", revert: null });
  await press("ArrowDown");
  assert.equal(await style("#plans", "color"), "rgb(255, 0, 0)", "shown on the page");
  await press("Enter");
  assert.equal(await value("css"), "color: red");
  assert.deepEqual(await f.evaluate((cs) => cs.filter((c) => !CSS.supports("color", c)), COLOURS), [], "every colour of the list is one");
  // After a property's own keywords; and in a shorthand that takes a colour.
  await type(";\nbackground-color: ");
  l = await list();
  assert.ok(l.items.indexOf("currentcolor") < l.items.indexOf("aliceblue") && l.items.indexOf("yellowgreen") < l.items.indexOf("transparent") && l.items.indexOf("transparent") < l.items.indexOf("inherit"), l.items.slice(0, 6).join());
  await type("transparent;\nborder: 1px solid tom");
  assert.deepEqual((await list()).items, ["tomato"]);
  // Not where `red` would be a name (a font's): no colours there.
  await type("ato;\nfont-family: re");
  assert.ok(!(await list())?.items.includes("red"), JSON.stringify((await list())?.items.slice(0, 5)));
  assert.deepEqual(errors, []);
  await page.close();
});

test("a computed row: coming back to the row's own value in the list declares nothing, with Enter or with Escape", async () => {
  const { page, errors, ui, press, type, list, value, focus, style, row } = await open();
  const ai = row("align-items");
  await ai.click();
  assert.deepEqual(await ui((r) => [r.activeElement.getAttribute("role"), r.activeElement.getAttribute("aria-expanded"), r.activeElement.getAttribute("aria-controls"), r.activeElement.getAttribute("aria-haspopup")]), ["combobox", "false", "b42-sug", null]);
  await press(`${MOD}+a`);
  await type("n");
  assert.deepEqual((await list()).items.slice(0, 2), ["normal", "baseline"]);
  await press("ArrowDown");
  assert.deepEqual([await ai.inputValue(), await value("css"), await style("#plans", "align-items")], ["baseline", "align-items: baseline;", "baseline"]);
  await press("ArrowUp"); // back on "normal": what the row had
  assert.deepEqual([await ai.inputValue(), await value("css"), await style("#plans", "align-items")], ["normal", "", "normal"], "no `align-items: normal;` for a value it has anyway");
  await press("Enter");
  assert.deepEqual([await list(), await ai.inputValue(), await value("css"), await focus()], [null, "normal", "", "cval"]);
  assert.equal(await ui((r) => r.querySelector(".undo").disabled), true, "and no undo step");
  // The same way round, ended with Escape.
  await press(`${MOD}+a`);
  await type("n");
  await press("ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp");
  assert.deepEqual([(await list()).on, await value("css")], ["normal", ""]);
  await press("ArrowDown", "Escape");
  assert.deepEqual([await list(), await ai.inputValue(), await value("css"), await style("#plans", "align-items")], [null, "n", "", "normal"]);
  assert.equal(await ui((r) => r.querySelector(".undo").disabled), true);
  // A value that is another one is written, as before.
  await page.keyboard.press("Control+Space");
  await press("ArrowDown", "Enter");
  assert.deepEqual([await ai.inputValue(), await value("css")], ["baseline", "align-items: baseline;"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a computed row: values only, under the field; ↑/↓ cycles; Enter writes as the row does", async () => {
  const { page, errors, ui, press, type, list, value, focus, style, row, settle } = await open();
  const ai = row("align-items");
  await ai.click();
  assert.equal(await ai.inputValue(), "normal");
  await press("ArrowDown");
  assert.equal(await ai.inputValue(), "stretch");
  assert.equal(await style("#plans", "align-items"), "stretch");
  assert.equal(await value("css"), "align-items: stretch;");
  await press("ArrowDown", "ArrowDown");
  assert.equal(await ai.inputValue(), "center");
  await press("ArrowDown");
  assert.equal(await ai.inputValue(), "start");
  assert.equal(await style("#plans", "align-items"), "start");
  assert.equal(await focus(), "cval");
  await settle(800);
  await press(`${MOD}+z`);
  assert.equal(await value("css"), "", "a run of presses is one step");
  assert.equal(await style("#plans", "align-items"), "normal");

  await ai.click();
  await press(`${MOD}+a`);
  await type("e");
  let l = await list();
  assert.deepEqual(l.items.slice(0, 2), ["end", "stretch"]);
  const at = await ui((r) => {
    const b = r.activeElement.getBoundingClientRect(), s = r.querySelector(".sug").getBoundingClientRect();
    return { under: s.top >= b.bottom || s.bottom <= b.top, near: Math.abs(s.left - b.left) < 16, role: r.activeElement.getAttribute("role"), exp: r.activeElement.getAttribute("aria-expanded"), act: r.activeElement.getAttribute("aria-activedescendant") };
  });
  assert.deepEqual(at, { under: true, near: true, role: "combobox", exp: "true", act: "b42-sg-0" });
  await press("ArrowDown");
  assert.equal(await ai.inputValue(), "stretch");
  assert.equal(await style("#plans", "align-items"), "stretch", "the highlighted value shows on the page");
  await press("Escape");
  assert.equal(await list(), null);
  assert.equal(await ai.inputValue(), "e", "Escape: what was typed, and the field still has the focus");
  assert.equal(await focus(), "cval");
  assert.equal(await style("#plans", "align-items"), "normal");
  assert.equal(await value("css"), "");
  await page.keyboard.press("Control+Space");
  await press("ArrowDown", "ArrowUp", "Enter");
  assert.equal(await ai.inputValue(), "end");
  assert.equal(await value("css"), "align-items: end;");
  assert.equal(await style("#plans", "align-items"), "end");
  assert.equal(await focus(), "cval");
  await press(`${MOD}+z`);
  assert.equal(await value("css"), "", "one step");
  await press("Escape"); // the list is closed: Escape is the row's own again (the value as it was, the focus gone)
  assert.equal(await ai.inputValue(), "normal");
  assert.equal(await focus(), "");

  // A number is not the suggestions': the key goes on to the number stepping (keys.js), which writes it.
  const w = row("width");
  await w.click();
  const before = await w.inputValue();
  assert.ok(/px$/.test(before));
  await press("ArrowDown");
  assert.equal(await value("css"), `width: ${parseFloat(before) - 1}px;`);
  assert.equal(await list(), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the stylesheet: nothing in a selector; a click on an item takes it and keeps the focus", async () => {
  const { page, f, errors, type, press, list, value, focus, style } = await open();
  await f.locator("b42-review .t-gl").click();
  await f.locator("b42-review .free").click();
  await type(".card:ho");
  assert.equal(await list(), null);
  await type("ver { disp");
  assert.deepEqual((await list()).items, ["display"]); // (font-display is @font-face's: not offered)
  await f.locator("b42-review .sg").first().click();
  await press();
  assert.equal(await value("free"), ".card:hover { display: ");
  assert.equal(await focus(), "free");
  await f.locator("b42-review .sg", { hasText: /^grid$/ }).click();
  await press();
  assert.equal(await value("free"), ".card:hover { display: grid");
  assert.equal(await list(), null);
  await type("; }\n.card { color: bl");
  assert.deepEqual((await list()).items.slice(0, 3), ["black", "blanchedalmond", "blue"], "the property's own keyword first, then the named colours");
  await type("ac");
  assert.deepEqual((await list()).items, ["black"]);
  await press("ArrowDown"); // one item: it is shown
  await type(" }");
  assert.equal(await value("free"), ".card:hover { display: grid; }\n.card { color: black }");
  assert.equal(await style(".card", "color"), "rgb(0, 0, 0)");
  // Leaving the field closes the list.
  await type("\n.card { al");
  assert.ok(await list());
  await page.mouse.click(700, 150);
  await press();
  assert.equal(await list(), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the page's variables: offered where the property takes them, with their values; ↑ ↓ walk a selected one's scale", async () => {
  const { page, f, errors, press, type, list, value, style, sel, dbl, pick } = await open();
  await f.locator("b42-review .css").click();
  // after the property's own keywords, only those it takes (no colours for gap), each with its value
  await type("gap: ");
  let l = await list();
  const vars = l.items.filter((i) => i.startsWith("var("));
  assert.deepEqual(vars, ["var(--space-1)", "var(--space-2)", "var(--space-3)", "var(--space-4)", "var(--space-6)"]);
  // (gap has no keyword of its own in Chrome's list: the CSS-wide ones come after the variables)
  assert.deepEqual(l.items.slice(0, 6), [...vars, "inherit"]);
  assert.deepEqual(vars.map((v) => l.vals[l.items.indexOf(v)]), ["4px", ".5rem", "calc(4px * 3)", "16px", "24px"]);
  assert.equal(l.vals[l.items.indexOf("inherit")], null, "a keyword has no value beside it");
  // `--` lists the variables only; looking through them shows each on the page; Enter takes one
  await type("--sp");
  l = await list();
  assert.deepEqual(l.items, vars);
  await press("ArrowDown");
  assert.equal(await style("#plans", "column-gap"), "8px");
  await press("Enter");
  assert.equal(await value("css"), "gap: var(--space-2)");
  assert.equal(await list(), null);
  // ↑ on a selected one (a double click on its name): the next step up, by size, and still selected
  await dbl("css", 13);
  await press("ArrowUp");
  assert.deepEqual([await value("css"), await sel("css"), await style("#plans", "column-gap")], ["gap: var(--space-3)", { text: "var(--space-3)", at: 5 }, "12px"]);
  await press("ArrowUp", "ArrowUp");
  assert.equal(await value("css"), "gap: var(--space-6)");
  // the top of the scale: nothing, and the key is taken (the 6 in the name is no number)
  await press("ArrowUp");
  assert.deepEqual([await value("css"), (await sel("css")).text], ["gap: var(--space-6)", "var(--space-6)"]);
  await press("ArrowDown");
  assert.deepEqual([await value("css"), await style("#plans", "column-gap")], ["gap: var(--space-4)", "16px"]);
  // a caret alone in it: the arrows are the field's own
  await pick("css", 12);
  await press("ArrowDown");
  assert.equal(await value("css"), "gap: var(--space-4)");
  // in a var( typed by hand: the variables at once, the whole var(…) replaced
  await page.keyboard.press(`${MOD}+a`);
  await type("color: var(");
  l = await list();
  assert.deepEqual(l.items, ["var(--bg-200)", "var(--bg-300)", "var(--brand)"]);
  assert.deepEqual(l.swatches.map(Boolean), [true, true, true], "a colour has its swatch");
  await press("ArrowDown", "Enter");
  assert.equal(await value("css"), "color: var(--bg-300)");
  // the Global sheet: the page's own variables (its root's), whatever is selected
  await press("Escape");
  await f.locator("b42-review .t-gl").click();
  await f.locator("b42-review .free").click();
  await type(".x { margin: --sp");
  assert.deepEqual((await list()).items, ["var(--space-1)", "var(--space-2)", "var(--space-3)", "var(--space-4)", "var(--space-6)"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a computed row offers the variables too: the one taken goes into Element styles", async () => {
  const { page, f, errors, press, type, list, style, row } = await open();
  await row("gap").click();
  await press(`${process.platform === "darwin" ? "Meta" : "Control"}+a`);
  await type("--");
  let l = await list();
  assert.deepEqual(l.items, ["var(--space-1)", "var(--space-2)", "var(--space-3)", "var(--space-4)", "var(--space-6)"]);
  await press("ArrowDown", "ArrowDown", "Enter");
  assert.equal(await style("#plans", "column-gap"), "12px");
  assert.equal(await f.evaluate(() => document.querySelector("b42-review").shadowRoot.querySelector(".css").value), "gap: var(--space-3);");
  assert.deepEqual(errors, []);
  await page.close();
});
