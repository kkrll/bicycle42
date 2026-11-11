// End-to-end tests for canvas mode (the inspector and the mouse gestures) on harness/canvas.html.
// Same set-up as overlay.test.mjs: a system Chromium, headless. Run: npm test
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
  const f = page.frames().find((fr) => fr.url().endsWith("/harness/canvas.html"));
  await f.waitForFunction(() => document.querySelector("b42-review") && document.documentElement.hasAttribute("data-b42-review"));
  return f;
}

/** Open the canvas test page; with `canvas`, switch to canvas mode with the bar's button. */
async function open({ delay = 150, canvas = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=${delay}&page=canvas`);
  const f = await pageFrame(page);
  if (canvas) await canvasOn(f);
  return { page, f, errors };
}
const canvasOn = async (f) => {
  await f.locator("b42-review .m-canvas").click();
  await f.waitForFunction(() => !document.querySelector("b42-review").shadowRoot.querySelector(".insp").hidden);
};

const box = async (f, sel) => {
  const b = await f.locator(sel).first().boundingBox();
  assert.ok(b, `no box for ${sel}`);
  return b;
};
const frames = (f, n = 2) => f.evaluate((k) => new Promise((done) => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : done());
  step();
}), n);
/** Click the page at a point of an element (default: its centre). */
const clickAt = async (page, f, sel, dx, dy) => {
  const b = await box(f, sel);
  await page.mouse.click(b.x + (dx ?? b.width / 2), b.y + (dy ?? b.height / 2));
  await frames(f);
};
/** Press at (x, y), move by steps to (x2, y2), release; frames pass in between, as with a hand. */
const drag = async (page, f, x, y, x2, y2, { hold } = {}) => {
  await page.mouse.move(x, y);
  await frames(f);
  await page.mouse.down();
  await page.mouse.move((x + x2) / 2, (y + y2) / 2, { steps: 4 });
  await frames(f);
  await page.mouse.move(x2, y2, { steps: 4 });
  await frames(f);
  if (hold) await hold();
  await page.mouse.up();
  await frames(f);
};
/** Typing is applied in the next frame, or after a short pause when the last apply was slow. */
const settle = async (f) => {
  await new Promise((r) => setTimeout(r, 160));
  await frames(f, 2);
};
const ui = (f, fn, arg) => f.evaluate(`(${fn})(document.querySelector("b42-review").shadowRoot, ${JSON.stringify(arg ?? null)})`);
/** One of the inspector's fields. The CSS side has two tabs (Element: classes and element styles;
 *  Global: the stylesheet), so filling or clicking a field first brings its tab to the front. */
const field = (f, cls) => {
  const loc = f.locator(`b42-review .${cls}`);
  const tab = cls === "free" ? "t-gl" : cls === "css" || cls === "cls" ? "t-el" : null;
  const front = () => (tab ? ui(f, (r, t) => { const b = r.querySelector(`.${t}`); if (!b.classList.contains("on") && !b.disabled) b.click(); }, tab) : null);
  return {
    fill: async (v) => (await front(), loc.fill(v)),
    click: async () => (await front(), loc.click()),
    inputValue: () => loc.inputValue(),
  };
};
const sentNotes = (page) => page.evaluate(() => window.__harness.notes.map(({ prompt, ...n }) => n));
const waitNotes = (page, count) => page.waitForFunction((c) => window.__harness.notes.length >= c, count);
const send = async (page, count = 1) => {
  await page.keyboard.press("Enter");
  await waitNotes(page, count);
  return (await sentNotes(page))[count - 1];
};
const style = (f, sel, prop) => f.evaluate(([s, p]) => getComputedStyle(document.querySelector(s)).getPropertyValue(p), [sel, prop]);
/** Everything a preview could leave behind: the DOM as text, and rules in adopted stylesheets. */
const pageState = (f) =>
  f.evaluate(() => ({
    html: document.documentElement.outerHTML,
    rules: document.adoptedStyleSheets.flatMap((s) => [...s.cssRules].map((r) => r.cssText)).filter((t) => !/cursor:|^html\[data-b42-review\] \{ padding-bottom/.test(t)),
  }));
const SECOND = "#plans article:nth-of-type(2)";

test("canvas is off by default: the bar shows only the switch, notes work as before", async () => {
  const { page, f } = await open({ canvas: false });
  const s = await ui(f, (r) => ({ bar: !r.querySelector(".bar").hidden, insp: r.querySelector(".insp").hidden, sheets: document.adoptedStyleSheets.length }));
  assert.deepEqual(s, { bar: true, insp: true, sheets: 0 });
  await clickAt(page, f, "#cta");
  await page.keyboard.type("bigger");
  const n = await send(page);
  assert.equal(n.text, "bigger");
  assert.equal(n.edits, undefined);
  assert.equal(n.css, undefined);
  await page.close();
});

test("mod+E switches modes; a note in progress hands over its element and its words", async () => {
  const { page, f } = await open({ canvas: false });
  await clickAt(page, f, "#cta");
  await page.keyboard.type("rounder");
  await page.keyboard.press(`${MOD}+KeyE`);
  await settle(f);
  const s = await ui(f, (r) => ({ card: !r.querySelector(".card").hidden, insp: !r.querySelector(".insp").hidden, path: r.querySelector(".ipath").textContent, note: r.querySelector(".cnote").value, cursor: getComputedStyle(document.body).cursor }));
  assert.deepEqual(s, { card: false, insp: true, path: "Button · Start free trial", note: "rounder", cursor: "default" });
  await page.keyboard.press(`${MOD}+KeyE`);
  await settle(f);
  assert.deepEqual(await ui(f, (r) => [r.querySelector(".insp").hidden, getComputedStyle(document.body).cursor, document.adoptedStyleSheets.length]), [true, "crosshair", 0]);
  await page.close();
});

test("tree: a click on the page selects its row; rows select, expand and outline; arrows walk", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, `${SECOND} h3`);
  let s = await ui(f, (r) => ({
    on: r.querySelector(".trow.on")?.textContent,
    rows: [...r.querySelectorAll(".trow")].map((x) => x.textContent),
    open: [...r.querySelectorAll(".trow")].filter((x) => x.querySelector(".tw.open")).map((x) => x.textContent),
    path: r.querySelector(".ipath").textContent,
  }));
  assert.equal(s.on, "h3Pro");
  assert.equal(s.path, "Heading · Pro");
  assert.ok(s.rows.includes("section#plans.row") && s.open.includes("section#plans.row"), `ancestors are open: ${s.rows} / ${s.open}`);
  assert.ok(!s.rows.some((x) => /^(script|style|head|b42-review)([#.\s]|$)/.test(x)), "no script, style or overlay rows");
  // with the keyboard on the page: ↑ is the parent, ↓ the first child
  await page.keyboard.press("ArrowUp");
  await frames(f);
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Card · Pro For small teams");
  await page.keyboard.press("ArrowDown");
  await frames(f);
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Heading · Pro");
  // click a row: the element is selected on the page
  await f.locator("b42-review .trow", { hasText: "section#grid" }).locator(".tt").click();
  await frames(f);
  s = await ui(f, (r) => ({ path: r.querySelector(".ipath").textContent, sel: r.querySelectorAll(".box.csel").length, focus: r.activeElement?.className }));
  assert.deepEqual(s, { path: "Section · 1 2 3 4 5 6", sel: 1, focus: "tree" });
  // arrows: right opens, down goes to the first child, left twice closes and goes up
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await frames(f);
  assert.equal(await ui(f, (r) => r.querySelector(".trow.on").textContent), "div.tile1");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await frames(f);
  assert.deepEqual(await ui(f, (r) => [r.querySelector(".trow.on").textContent, r.querySelector(".trow.on .tw").className]), ["section#grid.grid", "tw shut"]);
  // hovering a row outlines its element on the page
  const row = await f.locator("b42-review .trow", { hasText: "header" }).first().boundingBox();
  await page.mouse.move(row.x + 60, row.y + 10);
  await page.mouse.move(row.x + 62, row.y + 10);
  await settle(f);
  const hov = await ui(f, (r) => {
    const b = r.querySelector(".box.hover")?.getBoundingClientRect();
    const h = document.querySelector("header").getBoundingClientRect();
    return b && Math.abs(b.left - h.left) + Math.abs(b.top - h.top) + Math.abs(b.width - h.width);
  });
  assert.ok(hov !== undefined && hov < 2, `hover outline on <header>, off by ${hov}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("tree stays small on a large page and follows DOM changes", async () => {
  const { page, f } = await open();
  await f.evaluate(() => {
    const big = document.createElement("ul");
    big.id = "big";
    for (let i = 0; i < 5000; i++) big.appendChild(document.createElement("li")).textContent = `row ${i}`;
    document.body.appendChild(big);
  });
  await page.waitForTimeout(300);
  await f.locator("b42-review .trow", { hasText: "ul#big" }).locator(".tw").click();
  await page.waitForTimeout(300);
  const n = await ui(f, (r) => ({ rows: r.querySelectorAll(".trow").length, tall: r.querySelector(".tspace").offsetHeight }));
  assert.ok(n.rows < 40, `only a window of rows is in the DOM (${n.rows})`);
  assert.ok(n.tall > 5000 * 20, "the scroll height stands for all rows");
  await f.evaluate(() => document.getElementById("big").remove());
  await page.waitForTimeout(500);
  assert.ok((await ui(f, (r) => r.querySelector(".tspace").offsetHeight)) < 1000, "rows of removed elements are gone");
  await page.close();
});

test("element styles: typing applies live; Enter is a new line; mod+Enter sends one style edit", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await field(f, "css").click();
  await page.keyboard.type("padding: 20px 40px;");
  await page.keyboard.press("Enter");
  await page.keyboard.type("&:hover { opacity: 0.5; }");
  await settle(f);
  assert.equal(await style(f, "#cta", "padding-left"), "40px");
  assert.equal(await field(f, "css").inputValue(), "padding: 20px 40px;\n&:hover { opacity: 0.5; }");
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0, "Enter in the box does not send");
  assert.equal(await f.evaluate(() => window.pageKeys), 0, "the page saw no keys");
  await page.keyboard.press(`${MOD}+Enter`);
  await waitNotes(page, 1);
  const [n] = await sentNotes(page);
  assert.equal(n.text, "");
  assert.deepEqual(n.targets.map((t) => t.selector), ["#cta"]);
  assert.deepEqual(n.edits, [{
    kind: "style", selector: "#cta", tag: "button", label: "Button · Start free trial",
    css: "padding: 20px 40px;\n&:hover { opacity: 0.5; }",
    changes: [{ prop: "padding", from: "8px 14px", to: "20px 40px" }],
  }]);
  await page.close();
});

test("a rejected declaration is marked and said, the rest still applies", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await field(f, "css").click();
  await page.keyboard.type("colr: red; width: banana; height: 60px; --mine: 1;");
  await settle(f);
  const s = await ui(f, (r) => ({
    marks: [...r.querySelectorAll(".css").values()].length && [...r.querySelector(".css").previousElementSibling.querySelectorAll("u")].map((u) => [u.textContent, u.title]),
    err: r.querySelector(".css").parentElement.nextElementSibling.textContent,
  }));
  assert.deepEqual(s.marks, [["colr: red", "unknown property “colr”"], ["width: banana", "invalid value for width"]]);
  assert.match(s.err, /^Not applied: unknown property “colr” · invalid value for width$/);
  assert.equal(await style(f, "#cta", "height"), "60px");
  // unbalanced braces are said; what was complete before stays applied (see the P5 test)
  await page.keyboard.type(" }");
  await settle(f);
  assert.match(await ui(f, (r) => r.querySelector(".css").parentElement.nextElementSibling.textContent), /unbalanced braces: the last complete version stays applied/);
  assert.equal(await style(f, "#cta", "height"), "60px");
  await page.close();
});

test("stylesheet + class line: the owner's example; sent as note.css and a class edit", async () => {
  const { page, f } = await open();
  const css = `.bg-stripes {
  --stripe-period: 6px;
  background-image: repeating-linear-gradient(135deg,
    var(--stripe-a, var(--bg-300)), var(--stripe-a, var(--bg-300)) calc(var(--stripe-period) / 3),
    var(--stripe-b, var(--bg-200)) calc(var(--stripe-period) / 3), var(--stripe-b, var(--bg-200)) var(--stripe-period));
}`;
  await clickAt(page, f, `${SECOND}`, 100, 80);
  await field(f, "free").fill(css);
  await field(f, "cls").click();
  assert.equal(await field(f, "cls").inputValue(), "card");
  await page.keyboard.press("End");
  await page.keyboard.type(" bg-stripes");
  await settle(f);
  assert.equal(await f.evaluate((s) => document.querySelector(s).className, SECOND), "card bg-stripes");
  assert.match(await style(f, SECOND, "background-image"), /repeating-linear-gradient/);
  assert.equal(await ui(f, (r) => r.querySelector(".free").parentElement.nextElementSibling.hidden), true, "nothing is marked in the example");
  await page.keyboard.press(`${MOD}+Enter`);
  await waitNotes(page, 1);
  const [n] = await sentNotes(page);
  assert.equal(n.css, css);
  assert.equal(n.edits.length, 1);
  assert.deepEqual({ ...n.edits[0], selector: "" }, { kind: "class", selector: "", tag: "article", label: "Card · Pro For small teams", repeated: 3, from: "card", to: "card bg-stripes" });
  await page.close();
});

test("a stylesheet alone is a note; an invalid selector in it is marked", async () => {
  const { page, f } = await open();
  await field(f, "free").click();
  await page.keyboard.type(".tile { border-radius: 20px; }\n..oops { color: red; }");
  await settle(f);
  assert.equal(await style(f, "#grid .tile", "border-radius"), "20px");
  assert.match(await ui(f, (r) => r.querySelector(".free").parentElement.nextElementSibling.textContent), /invalid selector “\.\.oops”/);
  await page.keyboard.press(`${MOD}+Enter`);
  await waitNotes(page, 1);
  const [n] = await sentNotes(page);
  assert.equal(n.edits, undefined);
  assert.equal(n.css, ".tile { border-radius: 20px; }\n..oops { color: red; }");
  assert.deepEqual(n.targets, []);
  const [t1, t6] = [await box(f, "#grid .tile:nth-child(1)"), await box(f, "#grid .tile:nth-child(6)")];
  assert.ok(n.bounds && Math.abs(n.bounds.w - (t6.x + t6.width - t1.x)) < 2 && Math.abs(n.bounds.h - (t6.y + t6.height - t1.y)) < 2, `bounds: the elements the new rules match, got ${JSON.stringify(n.bounds)}`);
  await page.close();
});

test("computed list shows current values; a click copies the line into element styles", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#plans", 2, 2);
  await page.waitForTimeout(250);
  const rows = await ui(f, (r) => [...r.querySelectorAll(".crow")].map((x) => `${x.firstChild.textContent}: ${x.lastChild.value}`));
  assert.ok(rows.includes("display: flex") && rows.includes("gap: 16px"), rows.join("; "));
  await f.locator("b42-review .crow .cp", { hasText: "gap" }).click();
  assert.equal(await field(f, "css").inputValue(), "gap: 16px;");
  await page.close();
});

test("resize: an edge drag writes width into element styles, snapped to 4px; mod turns snapping off", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  const label = { text: "" };
  await drag(page, f, b.x + b.width, b.y + 30, b.x + b.width + 57, b.y + 30, {
    hold: async () => (label.text = await ui(f, (r) => r.querySelector(".lab.live").textContent)),
  });
  assert.equal(label.text, "width 200 → 256", "the live label follows the drag");
  assert.equal(await field(f, "css").inputValue(), "width: 256px;");
  assert.equal((await box(f, SECOND)).width, 256);
  // without snapping, and replacing the declaration in place
  await page.keyboard.down(MOD);
  await drag(page, f, b.x + 256, b.y + 30, b.x + 256 + 13, b.y + 30);
  await page.keyboard.up(MOD);
  assert.equal(await field(f, "css").inputValue(), "width: 269px;");
  // a corner sets both; snapping to a sibling's size (the cards are 200 wide)
  const c = await box(f, SECOND);
  await drag(page, f, c.x + c.width + 2, c.y + c.height + 2, c.x + 201, c.y + c.height + 30);
  assert.match(await field(f, "css").inputValue(), /^width: 200px;\nheight: \d+px;$/);
  // typing more on the same element: still one style edit
  await field(f, "css").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\ncolor: red;");
  await page.keyboard.press(`${MOD}+Enter`);
  await waitNotes(page, 1);
  const [n] = await sentNotes(page);
  assert.equal(n.edits.length, 1);
  assert.equal(n.edits[0].kind, "style");
  assert.deepEqual(n.edits[0].changes.map((c2) => c2.prop), ["width", "height", "color"]);
  assert.deepEqual(n.edits[0].changes[2], { prop: "color", from: "rgb(28, 28, 30)", to: "rgb(255, 0, 0)" });
  await page.close();
});

test("gap: dragging the space between flex items writes gap on the parent", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  // hover: the band and its value
  await page.mouse.move(b.x + b.width + 8, b.y + 40);
  await page.mouse.move(b.x + b.width + 9, b.y + 40);
  await settle(f);
  const hover = await ui(f, (r) => ({ band: Math.round(r.querySelector(".band").getBoundingClientRect().width), label: r.querySelector(".lab.live").textContent }));
  assert.deepEqual(hover, { band: 16, label: "gap 16" });
  // the cursor belongs to the layer's own element over the gap; the page's cursor rule is never rewritten
  assert.equal(await ui(f, (r, [x, y]) => getComputedStyle(r.elementFromPoint(x, y)).cursor, [b.x + b.width + 9 - (await f.evaluate(() => frameElement.getBoundingClientRect().left)), b.y + 40 - (await f.evaluate(() => frameElement.getBoundingClientRect().top))]), "col-resize");
  assert.equal(await style(f, "body", "cursor"), "default");
  await drag(page, f, b.x + b.width + 9, b.y + 40, b.x + b.width + 9 + 17, b.y + 40);
  assert.equal(await style(f, "#plans", "column-gap"), "32px");
  const n = await send(page);
  assert.deepEqual(n.edits, [{ kind: "style", selector: "#plans", tag: "section", label: "Section · Free For trying it out Pro For …", css: "gap: 32px;",
    changes: [{ prop: "gap", from: "16px", to: "32px" }] }]);
  await page.close();
});

test("move: dragging a card reorders it in its flex row with an insertion line; the DOM order is untouched", async () => {
  const { page, f } = await open();
  const b3 = await box(f, "#plans article:nth-of-type(3)");
  const b1 = await box(f, "#plans article:nth-of-type(1)");
  let seen;
  await drag(page, f, b3.x + 100, b3.y + 40, b1.x + 10, b1.y + 40, {
    hold: async () => (seen = await ui(f, (r) => {
      const l = r.querySelector(".ins").getBoundingClientRect();
      return { line: !r.querySelector(".ins").hidden, x: Math.round(l.left + l.width / 2), tall: l.height > l.width, ghost: !r.querySelector(".ghost").hidden, label: r.querySelector(".lab.live").textContent };
    })),
  });
  const left = await f.evaluate(() => frameElement.getBoundingClientRect().left);
  assert.deepEqual({ ...seen, x: Math.abs(seen.x + left - (b1.x - 5)) < 3 }, { line: true, x: true, tall: true, ghost: true, label: "3 → 1" });
  const order = () => f.evaluate(() => [...document.querySelectorAll("#plans article")].sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x).map((a) => a.querySelector("h3").textContent));
  assert.deepEqual(await order(), ["Scale", "Free", "Pro"]);
  assert.deepEqual(await f.evaluate(() => [...document.querySelectorAll("#plans h3")].map((h) => h.textContent)), ["Free", "Pro", "Scale"]);
  const n = await send(page);
  assert.equal(n.edits.length, 1);
  const e = n.edits[0];
  assert.deepEqual([e.kind, e.fromIndex, e.toIndex, e.repeated, e.parent.selector, e.parent.layout, e.before.label], ["move", 2, 0, 3, "#plans", "flex-row", "Card · Free For trying it out"]);
  assert.match(e.selector, /article.*nth-of-type\(3\)/);
  await page.close();
});

test("move: in a grid, to the end (before: null); in block flow it is refused and said", async () => {
  const { page, f } = await open();
  const t1 = await box(f, "#grid .tile:nth-child(1)");
  const t6 = await box(f, "#grid .tile:nth-child(6)");
  await drag(page, f, t1.x + 20, t1.y + 20, t6.x + t6.width + 20, t6.y + 30);
  const tiles = await f.evaluate(() => [...document.querySelectorAll("#grid .tile")].sort((a, b) => { const p = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return p.y - q.y || p.x - q.x; }).map((a) => a.textContent).join(""));
  assert.equal(tiles, "234561");
  const s1 = await box(f, "#stack p:nth-of-type(1)");
  await drag(page, f, s1.x + 30, s1.y + 15, s1.x + 30, s1.y + 120);
  assert.match(await ui(f, (r) => r.querySelector(".bmsg").textContent), /flex and grid/);
  const n = await send(page);
  assert.deepEqual([n.edits.length, n.edits[0].kind, n.edits[0].fromIndex, n.edits[0].toIndex, n.edits[0].before, n.edits[0].parent.layout], [1, "move", 0, 5, null, "grid"]);
  await page.close();
});

test("text: double-click edits in place; Enter keeps, Esc reverts; contenteditable never stays", async () => {
  const { page, f } = await open();
  const b = await box(f, "#title");
  const dbl = async () => {
    await page.mouse.click(b.x + 40, b.y + 20);
    await page.mouse.click(b.x + 40, b.y + 20);
    await frames(f);
  };
  await dbl();
  assert.equal(await f.evaluate(() => document.getElementById("title").getAttribute("contenteditable")), "plaintext-only");
  await page.keyboard.type("Fair pricing");
  await page.keyboard.press("Escape");
  assert.equal(await f.evaluate(() => document.getElementById("title").outerHTML), '<h1 id="title">Simple pricing</h1>');
  await dbl();
  await page.keyboard.type("Honest pricing");
  await page.keyboard.press("Enter");
  await frames(f);
  assert.equal(await f.evaluate(() => document.getElementById("title").outerHTML), '<h1 id="title">Honest pricing</h1>');
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0, "Enter while editing text does not send");
  assert.equal(await f.evaluate(() => window.pageKeys), 0);
  const n = await send(page);
  assert.deepEqual(n.edits, [{ kind: "text", selector: "#title", tag: "h1", label: "Heading · Simple pricing", from: "Simple pricing", to: "Honest pricing" }]);
  await page.close();
});

test("hide: Delete on a selection; undo, redo and Reset; the page ends exactly as it began", async () => {
  const { page, f } = await open();
  const start = await pageState(f);
  // one of each kind of edit
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  await drag(page, f, b.x + b.width, b.y + 30, b.x + b.width + 40, b.y + 30); // resize
  await field(f, "cls").fill("card wide"); // class
  await field(f, "free").fill(".wide { outline: 2px solid red; }"); // stylesheet
  const b1 = await box(f, "#plans article:nth-of-type(1)");
  await drag(page, f, b1.x + 100, b1.y + 60, b1.x + 700, b1.y + 60); // move to the end
  const t = await box(f, "#title");
  await page.mouse.click(t.x + 40, t.y + 20);
  await page.mouse.click(t.x + 40, t.y + 20);
  await frames(f);
  await page.keyboard.type("Changed");
  await page.keyboard.press("Enter"); // text
  await clickAt(page, f, "#cta");
  await page.keyboard.press("Delete"); // hide
  await frames(f);
  assert.equal(await style(f, "#cta", "display"), "none");
  assert.equal(await ui(f, (r) => r.querySelector(".count").textContent), "6 edits");
  // undo the hide, redo it, undo again
  await page.keyboard.press(`${MOD}+z`);
  assert.notEqual(await style(f, "#cta", "display"), "none");
  await page.keyboard.press(`${MOD}+Shift+z`);
  assert.equal(await style(f, "#cta", "display"), "none");
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`); // the text
  assert.equal(await f.evaluate(() => document.getElementById("title").textContent), "Simple pricing");
  // Reset takes the rest away; nothing is left of any of it
  await f.locator("b42-review .reset").click();
  await frames(f);
  assert.deepEqual(await pageState(f), start);
  assert.equal(await ui(f, (r) => r.querySelector(".count").textContent), "No edits");
  // …and Reset is itself a step: undo brings the edits back, undoing them all clears the page again
  await page.keyboard.press(`${MOD}+z`);
  assert.equal(await f.evaluate((s) => document.querySelector(s).className, SECOND), "card wide");
  for (let i = 0; i < 8; i++) await page.keyboard.press(`${MOD}+z`);
  await frames(f);
  assert.deepEqual(await pageState(f), start);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  await page.close();
});

test("edits survive a re-render that replaces nodes and patches attributes and text", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 300px;");
  await field(f, "cls").fill("card roomy");
  const b1 = await box(f, "#plans article:nth-of-type(1)");
  await drag(page, f, b1.x + 100, b1.y + 60, b1.x + 700, b1.y + 60); // "Free" to the end
  await f.evaluate(() => window.scrollTo(0, 320)); // the stack sits under the inspector: scroll it out
  await settle(f);
  await clickAt(page, f, "#stack p:nth-of-type(2)");
  await field(f, "cls").fill("item picked");
  const t = await box(f, "#stack p:nth-of-type(3)");
  await page.mouse.click(t.x + 20, t.y + 15);
  await page.mouse.click(t.x + 20, t.y + 15);
  await frames(f);
  await page.keyboard.type("Deploy");
  await page.keyboard.press("Enter");
  await frames(f);
  const look = () => f.evaluate(() => ({
    width: document.querySelector("#plans article:nth-of-type(2)").getBoundingClientRect().width,
    cls: document.querySelector("#plans article:nth-of-type(2)").className,
    first: [...document.querySelectorAll("#plans article")].sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)[2].querySelector("h3").textContent,
    picked: document.querySelector("#stack p:nth-of-type(2)").className,
    text: document.querySelector("#stack p:nth-of-type(3)").textContent,
    rev: document.querySelector("#stack p").getAttribute("data-rev"),
    fresh: !document.querySelector("#plans article").hasAttribute("data-seen"),
  }));
  const was = await look();
  assert.deepEqual(was, { width: 300, cls: "card roomy", first: "Free", picked: "item picked", text: "Deploy", rev: "1", fresh: true });
  await f.evaluate(() => document.querySelectorAll("#plans article").forEach((a) => a.setAttribute("data-seen", "")));
  await page.click("#rerender");
  await settle(f);
  assert.deepEqual(await look(), { ...was, rev: "2" }, "the cards are new nodes, the stack was patched, and every edit is still there");
  await page.close();
});

test("the draft carries unsent edits across a reload", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await field(f, "free").fill(".tile { color: red; }");
  await clickAt(page, f, "#cta");
  await page.keyboard.press("Delete");
  await f.locator("b42-review .cnote").fill("tighten this up");
  await page.waitForFunction(() => window.__harness.draft?.note === "tighten this up" && window.__harness.draft.edits?.ops.length === 1);
  await page.click("#reload");
  await page.waitForTimeout(150);
  const f2 = await pageFrame(page);
  await f2.waitForFunction(() => getComputedStyle(document.querySelector("#cta")).display === "none");
  assert.equal((await box(f2, SECOND)).width, 320);
  assert.equal(await style(f2, "#grid .tile", "color"), "rgb(255, 0, 0)");
  // canvas mode itself is still on, the fields are filled, and the batch can be sent or undone
  const s = await ui(f2, (r) => ({ insp: !r.querySelector(".insp").hidden, count: r.querySelector(".count").textContent, note: r.querySelector(".cnote").value, free: r.querySelector(".free").value }));
  assert.deepEqual(s, { insp: true, count: "3 edits", note: "tighten this up", free: ".tile { color: red; }" });
  await clickAt(page, f2, "#title");
  const n = await send(page);
  assert.equal(n.text, "tighten this up");
  assert.deepEqual(n.edits.map((e) => e.kind), ["style", "hide"]);
  assert.equal(n.css, ".tile { color: red; }");
  await page.waitForFunction(() => window.__harness.draft === null);
  await page.close();
});

test("sent edits stay as a preview until the note's pin is done, then go", async () => {
  const { page, f } = await open({ delay: 700 });
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await field(f, "cls").fill("card done-soon");
  await clickAt(page, f, "#title");
  const n = await send(page);
  assert.equal(n.edits.length, 2);
  // sent: the bar is clean, the preview is still on the page
  await f.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector(".count").textContent === "No edits");
  assert.equal((await box(f, SECOND)).width, 320);
  assert.equal(await f.evaluate(() => window.__b42.busy()), false);
  await page.waitForFunction(() => window.__harness.notes[0].status === "done");
  await settle(f);
  assert.equal((await box(f, SECOND)).width, 200);
  assert.deepEqual((await pageState(f)).rules, []);
  await page.close();
});

test("a failed note's class and text previews are put back", async () => {
  const { page, f } = await open({ delay: 60000 });
  const start = await pageState(f);
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "cls").fill("card nope");
  const t = await box(f, "#title");
  await page.mouse.click(t.x + 40, t.y + 20);
  await page.mouse.click(t.x + 40, t.y + 20);
  await frames(f);
  await page.keyboard.type("Nope");
  await page.keyboard.press("Enter");
  await frames(f);
  const n = await send(page);
  await f.waitForFunction(() => !window.__b42.busy());
  assert.equal(await f.evaluate(() => document.getElementById("title").textContent), "Nope");
  await f.evaluate((id) => window.__b42.receive({ type: "pins", pins: [{ id, n: 1, status: "failed", selector: "#title" }] }), n.id);
  await settle(f);
  assert.deepEqual(await pageState(f), start);
  await page.close();
});

test("edits show/hide: everything of the batch goes and comes back; the reply echoes id and show", async () => {
  const { page, f } = await open({ delay: 60000 });
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await field(f, "cls").fill("card striped");
  await field(f, "free").fill(".striped { outline: 3px solid rgb(255, 0, 0); }");
  await clickAt(page, f, "#cta");
  await page.keyboard.press("Delete");
  const n = await send(page);
  await f.waitForFunction(() => !window.__b42.busy());
  // what the note says about where: both sides of the edit are inside the bounds
  const cta = await box(f, SECOND);
  assert.ok(n.bounds.x <= cta.x && n.bounds.x + n.bounds.w >= 1000, `bounds cover the hidden button too: ${JSON.stringify(n.bounds)}`);
  const state = () => f.evaluate(() => {
    const a = document.querySelector("#plans article:nth-of-type(2)");
    const r = document.querySelector("b42-review").shadowRoot;
    return { w: a.getBoundingClientRect().width, cls: a.className, outline: getComputedStyle(a).outlineStyle, cta: getComputedStyle(document.querySelector("#cta")).display !== "none",
      chrome: !r.querySelector(".bar").hidden || !r.querySelector(".insp").hidden || r.querySelectorAll(".pin").length > 0 };
  });
  const replies = () => page.evaluate(() => window.__seen);
  await page.evaluate(() => {
    const fw = document.getElementById("page").contentWindow;
    const real = fw.__review;
    window.__seen = [];
    fw.__review = (s) => {
      const m = JSON.parse(s);
      if (m.type === "edits-shown") window.__seen.push(m);
      real(s);
    };
  });
  assert.deepEqual(await state(), { w: 320, cls: "card striped", outline: "solid", cta: false, chrome: true });
  await f.evaluate((id) => window.__b42.receive({ type: "edits", id, show: false }), n.id);
  await page.waitForFunction(() => window.__seen.length === 1);
  assert.deepEqual(await state(), { w: 200, cls: "card", outline: "none", cta: true, chrome: false });
  await f.evaluate((id) => window.__b42.receive({ type: "edits", id, show: true }), n.id);
  await page.waitForFunction(() => window.__seen.length === 2);
  await frames(f, 2);
  assert.deepEqual(await state(), { w: 320, cls: "card striped", outline: "solid", cta: false, chrome: true });
  assert.deepEqual(await replies(), [{ type: "edits-shown", id: n.id, show: false }, { type: "edits-shown", id: n.id, show: true }]);
  // an id that is not a sent batch changes nothing, but is still answered
  await f.evaluate(() => window.__b42.receive({ type: "edits", id: "n_unknown", show: false }));
  await page.waitForFunction(() => window.__seen.length === 3);
  assert.equal((await state()).w, 320);
  await page.close();
});

test("Esc: leaves the field, deselects, leaves canvas mode (edits stay), then review mode", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").click();
  await page.keyboard.type("width: 300px;");
  const s = () => ui(f, (r) => ({ field: r.activeElement?.className ?? null, sel: r.querySelectorAll(".box.csel").length, insp: !r.querySelector(".insp").hidden, count: r.querySelector(".count").textContent }));
  await page.keyboard.press("Escape");
  await frames(f);
  assert.deepEqual(await s(), { field: null, sel: 1, insp: true, count: "1 edit" });
  await page.keyboard.press("Escape");
  await frames(f);
  assert.deepEqual(await s(), { field: null, sel: 0, insp: true, count: "1 edit" });
  await page.keyboard.press("Escape");
  await frames(f);
  assert.deepEqual(await s(), { field: null, sel: 0, insp: false, count: "1 unsent canvas edit" });
  assert.equal((await box(f, SECOND)).width, 300, "the edit is still applied, and still in the draft");
  await page.waitForFunction(() => window.__harness.draft?.edits && Object.keys(window.__harness.draft.edits.els).length === 1);
  assert.equal(await page.evaluate(() => window.__harness.enabled), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__harness.enabled === false);
  // a drag is cancelled by Esc without an edit
  await page.close();
});

test("Esc cancels a drag; nothing is ever sent without Enter", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  await page.mouse.move(b.x + b.width, b.y + 30);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + 30, { steps: 5 });
  await frames(f);
  assert.equal((await box(f, SECOND)).width, 260);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await frames(f);
  assert.equal((await box(f, SECOND)).width, 200);
  assert.equal(await field(f, "css").inputValue(), "");
  // every other way of making edits, and the bar's buttons: no note
  await drag(page, f, b.x + b.width, b.y + 30, b.x + b.width + 40, b.y + 30);
  await f.locator("b42-review .undo").click();
  await field(f, "css").fill("color: red;");
  await f.locator("b42-review .m-notes").click();
  await f.locator("b42-review .m-canvas").click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  assert.ok(!(await page.evaluate(() => window.__harness.log)).includes("note"));
  // Enter with nothing to send says so and sends nothing
  await f.locator("b42-review .reset").click();
  await clickAt(page, f, "#title");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  assert.match(await ui(f, (r) => r.querySelector(".bmsg").textContent), /Nothing to send/);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  assert.equal(await f.evaluate(() => window.pageClicks), 0, "the page saw no clicks");
  await page.close();
});

test("works inside an open modal dialog and on a scrolled page", async () => {
  const { page, f } = await open({ canvas: false });
  await f.evaluate(() => document.getElementById("dlg").showModal());
  await settle(f);
  await canvasOn(f);
  await clickAt(page, f, "#db");
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Button · Beta");
  const b = await box(f, "#db");
  await drag(page, f, b.x + b.width, b.y + 10, b.x + b.width + 32, b.y + 10);
  const w = (await box(f, "#db")).width;
  assert.equal(w % 4, 0);
  assert.equal(await field(f, "css").inputValue(), `width: ${w}px;`);
  await field(f, "css").click();
  await page.keyboard.type(" color: red;");
  await settle(f);
  assert.equal(await style(f, "#db", "color"), "rgb(255, 0, 0)", "typing reaches the box although the dialog makes the page inert");
  const a = await box(f, "#da");
  await drag(page, f, a.x + 10, a.y + 10, (await box(f, "#dc")).x + 200, a.y + 10);
  assert.deepEqual(await f.evaluate(() => [...document.querySelectorAll("#dlg-row button")].sort((x, y) => x.getBoundingClientRect().x - y.getBoundingClientRect().x).map((x) => x.id)), ["db", "dc", "da"]);
  await f.evaluate(() => document.getElementById("dlg").close());
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  // scrolled
  await f.evaluate(() => window.scrollTo(0, 1900));
  await settle(f);
  const s2 = await box(f, "#far span:nth-of-type(2)");
  await clickAt(page, f, "#far span:nth-of-type(2)");
  const out = await ui(f, (r) => { const o = r.querySelector(".box.csel").getBoundingClientRect(); return [Math.round(o.left), Math.round(o.top)]; });
  assert.deepEqual(out, [Math.round(s2.x - (await f.evaluate(() => frameElement.getBoundingClientRect().left))), Math.round(s2.y - (await f.evaluate(() => frameElement.getBoundingClientRect().top)))]);
  await drag(page, f, s2.x + s2.width, s2.y + 10, s2.x + s2.width + 30, s2.y + 10);
  assert.equal((await box(f, "#far span:nth-of-type(2)")).width, 120);
  const s1 = await box(f, "#far span:nth-of-type(1)");
  await drag(page, f, s1.x + 20, s1.y + 10, s1.x + 400, s1.y + 10);
  const n = await send(page);
  assert.deepEqual(n.edits.map((e) => e.kind), ["style", "move"]);
  assert.equal(n.viewport.scrollY, 1900);
  await page.close();
});

test("limits: over-long text is marked, not applied and not sent; more than 40 edits are refused", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await field(f, "css").fill(`color: red; /* ${"x".repeat(4000)} */`);
  await settle(f);
  assert.match(await ui(f, (r) => r.querySelector(".css").parentElement.nextElementSibling.textContent), /^Too long: 4018 \/ 4000/);
  assert.notEqual(await style(f, "#cta", "color"), "rgb(255, 0, 0)");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(200);
  assert.match(await ui(f, (r) => r.querySelector(".bmsg").textContent), /Too long to send/);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  await field(f, "css").fill("");
  // 41 elements
  await f.evaluate(() => {
    const d = document.createElement("div");
    d.id = "many";
    for (let i = 0; i < 41; i++) d.appendChild(document.createElement("i")).textContent = "x";
    document.body.prepend(d);
  });
  for (let i = 1; i <= 41; i++) {
    await f.locator("b42-review .tree").evaluate((t) => (t.scrollTop = 0));
    await clickAt(page, f, `#many i:nth-of-type(${i})`);
    await field(f, "css").fill("color: red;");
    await field(f, "cls").click(); // blur: the step closes
  }
  assert.equal(await ui(f, (r) => r.querySelector(".count").textContent), "40 edits");
  assert.match(await ui(f, (r) => r.querySelector(".bmsg").textContent), /40 edits is the limit/);
  assert.notEqual(await style(f, "#many i:nth-of-type(41)", "color"), "rgb(255, 0, 0)");
  await page.close();
});

test("U1 the batch can be read: the count opens a list; rows select, × removes one edit; the tree marks edited and hidden", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  await drag(page, f, b.x + b.width, b.y + 30, b.x + b.width + 60, b.y + 30);
  await field(f, "free").fill(".tile { color: red; }");
  await clickAt(page, f, "#cta");
  await page.keyboard.press("Delete");
  await settle(f);
  const rows = () => ui(f, (r) => (r.querySelector(".pop").hidden ? null : [...r.querySelectorAll(".erow")].map((x) => x.title)));
  assert.equal(await rows(), null);
  await f.locator("b42-review .count").click();
  assert.deepEqual(await rows(), ["Card · Pro For small teams — width 200 → 260", "Button · Start free trial — hidden", "Stylesheet — 1 rule"]);
  // a row selects its element, hidden or not
  await f.locator("b42-review .erow", { hasText: "hidden" }).locator(".el").click();
  await settle(f);
  const tree = await ui(f, (r) => ({
    path: r.querySelector(".ipath").textContent,
    hid: [...r.querySelectorAll(".trow.hid")].map((x) => x.textContent),
    ed: [...r.querySelectorAll(".trow.ed")].map((x) => x.textContent),
    struck: getComputedStyle(r.querySelector(".trow.hid .tt")).textDecorationLine,
  }));
  assert.deepEqual(tree, { path: "Button · Start free trial · hidden", hid: ["button#cta.primaryStart free trial"], ed: ["article.card"], struck: "line-through" });
  // × takes that one edit away, and that is a step like any other
  await f.locator("b42-review .erow", { hasText: "hidden" }).locator(".ex").click();
  await settle(f);
  assert.notEqual(await style(f, "#cta", "display"), "none");
  assert.deepEqual([await ui(f, (r) => r.querySelector(".count").textContent), (await rows()).length], ["2 edits", 2]);
  await page.keyboard.press(`${MOD}+z`);
  await settle(f);
  assert.equal(await style(f, "#cta", "display"), "none");
  assert.equal((await rows()).length, 3);
  // Esc closes the list before anything else
  await page.keyboard.press("Escape");
  assert.equal(await rows(), null);
  // the keys are one click away
  await f.locator("b42-review .help").click();
  assert.match(await ui(f, (r) => r.querySelector(".corner .pop").textContent), /double-click text.*Delete.*drag the space between items|drag the space between items.*double-click text.*Delete/s);
  await page.close();
});

test("U2 the bar says what sending did: preview stays until note N is done, then that it was removed; no chip over the page", async () => {
  const { page, f } = await open({ delay: 900 });
  const msg = () => ui(f, (r) => (r.querySelector(".bmsg").hidden ? "" : r.querySelector(".bmsg").textContent));
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await clickAt(page, f, "#title");
  await send(page);
  await f.waitForFunction(() => /^Sent · preview stays until note 1 is done$/.test(document.querySelector("b42-review").shadowRoot.querySelector(".bmsg").textContent));
  assert.equal(await ui(f, (r) => r.querySelector(".sent").hidden), true, "no detached Sent chip in canvas mode");
  assert.equal((await box(f, SECOND)).width, 320);
  await page.waitForFunction(() => window.__harness.notes[0].status === "done");
  await settle(f);
  assert.equal(await msg(), "Note 1 done · preview removed");
  assert.equal((await box(f, SECOND)).width, 200);
  await page.waitForTimeout(4300);
  assert.equal(await msg(), "", "idle again: controls only, no standing text");
  // a failed note says the edits were put back
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await clickAt(page, f, "#title");
  const n = await send(page, 2);
  await f.waitForFunction(() => !window.__b42.busy());
  await f.evaluate((id) => window.__b42.receive({ type: "pins", pins: [{ id, n: 2, status: "failed", selector: "#title" }] }), n.id);
  await settle(f);
  assert.equal(await msg(), "Note 2 failed · edits put back");
  await page.close();
});

test("U3 a refusal never outlives the next thing done; in notes mode unsent canvas edits are a button back", async () => {
  const { page, f } = await open();
  const msg = () => ui(f, (r) => [r.querySelector(".bmsg").textContent, r.querySelector(".bmsg").classList.contains("warn")]);
  await clickAt(page, f, "#title");
  await page.keyboard.press("Enter");
  await frames(f);
  assert.deepEqual(await msg(), ["Nothing to send yet: edit something first", true]);
  await clickAt(page, f, "#cta");
  assert.deepEqual(await ui(f, (r) => [r.querySelector(".bmsg").hidden, r.querySelector(".cnote").hidden]), [true, false], "idle: the note field, no message");
  // a refused reorder, then an edit: the refusal is gone at once
  const s1 = await box(f, "#stack p:nth-of-type(1)");
  await drag(page, f, s1.x + 30, s1.y + 15, s1.x + 30, s1.y + 40);
  assert.match((await msg())[0], /flex and grid/);
  await field(f, "css").fill("color: red;");
  await settle(f);
  assert.equal(await ui(f, (r) => r.querySelector(".bmsg").hidden), true);
  // back in notes mode the edit is not forgotten: a button says so and leads back
  await f.locator("b42-review .m-notes").click();
  const count = f.locator("b42-review .count");
  assert.equal(await count.textContent(), "1 unsent canvas edit");
  await count.click();
  await settle(f);
  assert.deepEqual(await ui(f, (r) => [r.querySelector(".insp").hidden, r.querySelector(".count").textContent]), [false, "1 edit"]);
  await page.close();
});

test("U6 the bar keeps its width and place through every state; U5 one send hint that names the right key", async () => {
  const { page, f } = await open({ delay: 60000 });
  const seen = [];
  const look = async (what) => seen.push([what, ...(await ui(f, (r) => {
    const b = r.querySelector(".bar").getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.width), r.querySelector(".undo").disabled, r.querySelector(".reset").disabled, r.querySelector(".bsend").textContent];
  }))]);
  await look("entered");
  await clickAt(page, f, SECOND, 100, 80);
  await look("selected");
  await page.keyboard.press("Enter");
  await frames(f);
  await look("refused");
  await field(f, "css").click();
  await page.keyboard.type("width: 300px;");
  await settle(f);
  await look("typing in the inspector");
  await clickAt(page, f, "#cta");
  await page.keyboard.press("Delete");
  await settle(f);
  await look("two edits");
  const t = await box(f, "#title");
  await page.mouse.click(t.x + 40, t.y + 20);
  await page.mouse.click(t.x + 40, t.y + 20);
  await settle(f);
  assert.equal(await ui(f, (r) => r.querySelector(".bmsg").textContent), "Editing text · ↵ keep · esc revert");
  await look("editing text");
  await page.keyboard.press("Escape");
  await send(page);
  await f.waitForFunction(() => !window.__b42.busy());
  await settle(f);
  await look("sent");
  const mod = MOD === "Meta" ? "⌘" : "ctrl+";
  assert.deepEqual(seen, [
    ["entered", 250, 580, true, true, "↵ send"],
    ["selected", 250, 580, true, true, "↵ send"],
    ["refused", 250, 580, true, true, "↵ send"],
    ["typing in the inspector", 250, 580, true, false, `${mod}↵ send`],
    ["two edits", 250, 580, false, false, "↵ send"],
    ["editing text", 250, 580, false, false, "↵ send"],
    ["sent", 250, 580, true, true, "↵ send"],
  ]);
  assert.equal(await ui(f, (r) => r.querySelector(".ihead").textContent.includes("send")), false, "no second send hint in the inspector's header");
  // a long refusal is cut with an ellipsis and kept whole in the title
  await page.keyboard.press("Enter");
  await frames(f);
  assert.deepEqual(await ui(f, (r) => { const m = r.querySelector(".bmsg"); return [m.title, m.scrollWidth >= m.clientWidth, Math.round(r.querySelector(".bar").getBoundingClientRect().width)]; }), ["Nothing to send yet: edit something first", true, 580]);
  await page.close();
});

test("U8 labels join the texts of children with a space, and leave a word split by inline markup whole", async () => {
  const { page, f } = await open();
  await f.evaluate(() => document.querySelector("header").insertAdjacentHTML("beforebegin", '<p id="w">un<b>believ</b>able <i>deal</i></p><div id="x"><div>Label</div><div>Value</div></div><nav id="nv"><a>Home</a><a>Docs</a></nav>'));
  await page.waitForTimeout(300);
  await clickAt(page, f, SECOND, 100, 80);
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Card · Pro For small teams");
  await f.locator("b42-review .trow", { hasText: "p#w" }).locator(".tt").click();
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Text · unbelievable deal");
  await f.locator("b42-review .trow", { hasText: "div#x" }).locator(".tt").click();
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Block · Label Value");
  await f.locator("b42-review .trow", { hasText: "nav#nv" }).locator(".tt").click();
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Navigation · Home Docs");
  await page.close();
});

test("U9 an edit's selector is anchored at the nearest id, or is the shortest that matches one element", async () => {
  const { page, f } = await open();
  // two groups that look the same, no ids anywhere near
  await f.evaluate(() => document.querySelector("header").insertAdjacentHTML("afterend", '<div class="twins"><ul class="list"><li>A</li><li>B</li></ul><ul class="list"><li>A</li><li>B</li></ul></div>'));
  await page.waitForTimeout(300);
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 300px;");
  await f.locator("b42-review .trow", { hasText: "div.twins" }).locator(".tw").click();
  await f.locator("b42-review .trow", { hasText: "ul.list" }).nth(1).locator(".tw").click();
  await f.locator("b42-review .trow", { hasText: "liB" }).nth(0).locator(".tt").click();
  await field(f, "css").fill("color: red;");
  await clickAt(page, f, "#grid .tile:nth-child(3)");
  await field(f, "cls").fill("tile hot");
  await clickAt(page, f, "#title");
  const n = await send(page);
  const sels = n.edits.map((e) => e.selector);
  assert.deepEqual(sels, ["#plans > article.card:nth-of-type(2)", "ul.list:nth-of-type(2) > li:nth-of-type(2)", "#grid > div.tile:nth-of-type(3)"]);
  const hits = await f.evaluate((list) => list.map((s) => { const all = document.querySelectorAll(s); return [all.length, all[0]?.textContent.trim().slice(0, 3)]; }), sels);
  assert.deepEqual(hits, [[1, "Pro"], [1, "B"], [1, "3"]]);
  assert.deepEqual(n.targets.map((t) => t.selector), sels, "targets go by the same selectors");
  assert.ok(sels.every((s) => !/\n/.test(s) && s.length < 120));
  await page.close();
});

test("P5 while a brace is open, what was complete stays applied; the open rule is marked, not the box switched off", async () => {
  const { page, f } = await open();
  await field(f, "free").click();
  await page.keyboard.type(".tile { border-radius: 20px; }");
  await settle(f);
  const state = () => f.evaluate(() => {
    const r = document.querySelector("b42-review").shadowRoot;
    return [getComputedStyle(document.querySelector("#grid .tile")).borderRadius, getComputedStyle(document.querySelector("#cta")).letterSpacing, r.querySelector(".free").parentElement.nextElementSibling.textContent];
  });
  assert.deepEqual(await state(), ["20px", "normal", ""]);
  await page.keyboard.type("\n#cta {");
  await settle(f);
  assert.deepEqual(await state(), ["20px", "normal", "Not applied: unbalanced braces: the last complete version stays applied"]);
  await page.keyboard.type(" letter-spacing: 2px;");
  await settle(f);
  assert.equal((await state())[0], "20px");
  await page.keyboard.type(" }");
  await settle(f);
  assert.deepEqual(await state(), ["20px", "2px", ""]);
  // the same in Element styles
  await clickAt(page, f, "#cta");
  await field(f, "css").click();
  await page.keyboard.type("height: 60px; &:hover {");
  await settle(f);
  assert.equal(await style(f, "#cta", "height"), "60px");
  await page.close();
});

test("brush: on, a plain drag draws a stroke; off, it selects an area; alt+drag draws either way", async () => {
  const { page, f } = await open({ canvas: false });
  const brush = f.locator("b42-review .m-brush");
  const pressed = () => brush.getAttribute("aria-pressed");
  const line = async (alt) => {
    const hs = [await box(f, "#plans article:nth-of-type(1) h3"), await box(f, "#plans article:nth-of-type(3) h3")];
    const y = hs[0].y + hs[0].height / 2;
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(hs[0].x + 2, y);
    await page.mouse.down();
    await page.mouse.move(hs[1].x + hs[1].width - 2, y, { steps: 20 });
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
  };
  assert.deepEqual([await pressed(), await brush.getAttribute("aria-label"), await brush.getAttribute("title")], ["false", "Draw on the page", `Draw on the page · or hold ${MOD === "Meta" ? "⌥" : "alt"} and drag`]);
  // its own bubble, left of the bar: square, the bar's height, 8px away, and the pair centred together
  const geo = await ui(f, (r) => {
    const a = r.querySelector(".m-brush").getBoundingClientRect(), b = r.querySelector(".bar").getBoundingClientRect();
    return { square: [a.width, a.height], gap: Math.round(b.left - a.right), top: a.top === b.top, tall: a.height === b.height,
      centred: Math.abs((a.left + b.right) / 2 - innerWidth / 2) < 1, inSeg: !!r.querySelector(".seg .m-brush") };
  });
  assert.deepEqual(geo, { square: [36, 36], gap: 8, top: true, tall: true, centred: true, inSeg: false });
  // off: a plain drag is an area, as it always was
  const b = await box(f, "#grid");
  await page.mouse.move(b.x - 4, b.y - 4);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + 80, { steps: 4 });
  await page.mouse.move(b.x + 400, b.y + 140, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.type("area");
  let n = await send(page, 1);
  assert.deepEqual([n.strokes.length, !!n.area], [0, true]);
  // on: the same plain drag is a stroke; sending turns the brush off
  await f.waitForFunction(() => !window.__b42.busy());
  await brush.click();
  assert.equal(await pressed(), "true");
  await line(false);
  await page.keyboard.type("drawn");
  n = await send(page, 2);
  assert.deepEqual([n.strokes.length, n.area, n.targets.length >= 3], [1, null, true]);
  await f.waitForFunction(() => !window.__b42.busy());
  assert.equal(await pressed(), "false");
  // off again: alt+drag still draws
  await line(true);
  await page.keyboard.type("alt");
  n = await send(page, 3);
  assert.equal(n.strokes.length, 1);
  await f.waitForFunction(() => !window.__b42.busy());
  // a click still selects with the brush on; Esc on the note turns it off; mod+Z undoes a stroke
  await brush.click();
  await clickAt(page, f, "#cta");
  assert.equal(await ui(f, (r) => r.querySelector(".what").textContent), "Button · Start free trial");
  await line(false);
  await page.keyboard.press(`${MOD}+z`);
  await frames(f, 2);
  assert.equal(await ui(f, (r) => r.querySelectorAll(".strokes path").length), 0);
  await page.keyboard.press("Escape");
  assert.equal(await pressed(), "false");
  // from canvas mode the brush leads to notes mode with the brush on; canvas mode turns it off
  await f.locator("b42-review .m-canvas").click();
  await brush.click();
  assert.deepEqual([await pressed(), await ui(f, (r) => r.querySelector(".insp").hidden)], ["true", true]);
  await f.locator("b42-review .m-canvas").click();
  assert.equal(await pressed(), "false");
  await page.close();
});

test("the “?” is a bubble of its own in the corner: on the bar's row, its key list above it and inside the window; the bar gives way", async () => {
  const { page, f } = await open({ canvas: false });
  const geo = () => ui(f, (r) => {
    const q = r.querySelector(".help").getBoundingClientRect(), b = r.querySelector(".bar").getBoundingClientRect(), br = r.querySelector(".m-brush").getBoundingClientRect();
    const p = r.querySelector(".corner .pop"), pr = p.getBoundingClientRect();
    return { right: Math.round(innerWidth - q.right), size: [q.width, q.height], row: q.top === b.top && q.top === br.top, clear: q.left - b.right >= 8, inBar: !!r.querySelector(".bar .help"),
      pop: p.hidden ? null : { above: pr.bottom <= q.top, rightAligned: Math.round(pr.right) === Math.round(q.right), inside: pr.left >= 0 && pr.top >= 0 }, shown: !r.querySelector(".corner").hidden };
  });
  // notes mode: there too, with the keys of notes mode
  assert.deepEqual(await geo(), { right: 12, size: [36, 36], row: true, clear: true, inBar: false, pop: null, shown: true });
  await f.locator("b42-review .help").click();
  assert.deepEqual((await geo()).pop, { above: true, rightAligned: true, inside: true });
  assert.match(await ui(f, (r) => r.querySelector(".corner .pop").textContent), /the brush.*templates/s);
  await page.keyboard.press("Escape");
  assert.equal((await geo()).pop, null);
  assert.equal(await page.evaluate(() => window.__harness.enabled), true, "Esc closed the list, not review mode");
  // canvas mode: it rides above the dock, and follows it when it folds
  await canvasOn(f);
  assert.deepEqual(await geo(), { right: 12, size: [36, 36], row: true, clear: true, inBar: false, pop: null, shown: true });
  const above = () => ui(f, (r) => Math.round(r.querySelector(".insp").getBoundingClientRect().top - r.querySelector(".help").getBoundingClientRect().bottom));
  assert.equal(await above(), 10);
  await f.locator("b42-review .ifold").click();
  assert.equal(await above(), 10);
  await f.locator("b42-review .ifold").click();
  await f.locator("b42-review .help").click();
  assert.match(await ui(f, (r) => r.querySelector(".corner .pop").textContent), /double-click text.*Delete/s);
  await clickAt(page, f, "#title");
  assert.equal((await geo()).pop, null, "a click on the page closes it");
  // a narrow window: nothing overlaps, the bar is the one that shrinks
  await page.evaluate(() => { const fr = document.getElementById("page"); fr.style.width = "600px"; fr.style.flex = "none"; });
  await clickAt(page, f, "#plans article:nth-of-type(2)", 60, 60);
  await field(f, "css").fill("width: 180px;");
  await settle(f);
  const narrow = await ui(f, (r) => {
    const q = r.querySelector(".help").getBoundingClientRect(), b = r.querySelector(".bar").getBoundingClientRect(), br = r.querySelector(".m-brush").getBoundingClientRect();
    return { vw: innerWidth, brushIn: br.left >= 0, gap: q.left - b.right >= 8, right: Math.round(innerWidth - q.right), note: r.querySelector(".cnote").getBoundingClientRect().width > 20 };
  });
  assert.deepEqual(narrow, { vw: 600, brushIn: true, gap: true, right: 12, note: true });
  // hidden with the bar during a capture
  await page.evaluate(() => { const fw = document.getElementById("page").contentWindow; const real = fw.__b42.receive; fw.__b42.receive = (m) => (m.type === "captured" ? 0 : real(m)); });
  await clickAt(page, f, "#title");
  await page.keyboard.press("Enter");
  await waitNotes(page, 1);
  assert.equal(await ui(f, (r) => r.querySelector(".corner").hidden && r.querySelector(".bar").hidden), true);
  await page.close();
});

// What the tree pane shows: every row slot between its top and bottom edge must hold a rendered,
// non-empty row (no blank stretch), and the selected row must be among them.
const treeFill = (f) =>
  ui(f, (r) => {
    const pane = r.querySelector(".tree").getBoundingClientRect();
    const rows = [...r.querySelectorAll(".trow")].map((x) => ({ t: x.getBoundingClientRect().top, text: x.textContent, on: x.classList.contains("on") }));
    const total = parseInt(r.querySelector(".tspace").style.height) / 20;
    let blank = 0;
    for (let y = pane.top + 10; y < pane.bottom - 10; y += 20) if (!rows.some((x) => x.text && y >= x.t && y < x.t + 20)) blank++;
    const sel = rows.find((x) => x.on);
    return { blank, total, selVisible: !!sel && sel.t >= pane.top && sel.t + 20 <= pane.bottom + 1, scrollTop: r.querySelector(".tree").scrollTop };
  });

test("tree: after a far-down element is selected from the page, the pane is full of rows without any scroll", async () => {
  const { page, f } = await open();
  // a long subtree, its last element deep and far down the tree
  await f.evaluate(() => {
    const d = document.createElement("div");
    d.id = "deep";
    d.style.cssText = "font-size:0;line-height:0";
    for (let i = 0; i < 600; i++) d.appendChild(document.createElement("i")).textContent = "x";
    let at = d;
    for (let i = 0; i < 6; i++) at = at.appendChild(document.createElement("div"));
    const p = at.appendChild(document.createElement("p"));
    p.id = "far-down";
    p.textContent = "target";
    p.style.cssText = "font-size:14px;line-height:20px;margin:0";
    document.body.prepend(d);
  });
  await page.waitForTimeout(350);
  await clickAt(page, f, "#far-down");
  await frames(f, 3);
  let s = await treeFill(f);
  assert.ok(s.total > 600, `the tree is long (${s.total} rows)`);
  assert.deepEqual([s.blank, s.selVisible], [0, true], `selected from the page: ${JSON.stringify(s)}`);
  assert.ok(s.scrollTop > 600 * 20 - 400, "the pane really scrolled down to it");
  // a node above the viewport collapses and expands: still full
  await page.keyboard.press("ArrowUp");
  await frames(f, 3);
  await f.locator("b42-review .tree").focus();
  for (const k of ["ArrowLeft", "ArrowRight", "ArrowDown"]) {
    await page.keyboard.press(k);
    await frames(f, 3);
    s = await treeFill(f);
    assert.deepEqual([s.blank, s.selVisible], [0, true], `after ${k}: ${JSON.stringify(s)}`);
  }
  await clickAt(page, f, "#far-down");
  // the dock resized, folded and opened again: still full, the selection still in view
  const grip = await f.locator("b42-review .grip").boundingBox();
  await page.mouse.move(grip.x + 300, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x + 300, grip.y - 120, { steps: 5 });
  await page.mouse.up();
  await frames(f, 3);
  s = await treeFill(f);
  assert.deepEqual([s.blank, s.selVisible], [0, true], `after resizing the dock: ${JSON.stringify(s)}`);
  await f.locator("b42-review .ifold").click();
  await frames(f, 3);
  await f.locator("b42-review .ifold").click();
  await frames(f, 3);
  s = await treeFill(f);
  assert.deepEqual([s.blank, s.selVisible], [0, true], `after folding and opening the dock: ${JSON.stringify(s)}`);
  // leaving canvas mode and coming back
  await f.locator("b42-review .m-notes").click();
  await f.locator("b42-review .m-canvas").click();
  await clickAt(page, f, "#far-down");
  await frames(f, 3);
  s = await treeFill(f);
  assert.deepEqual([s.blank, s.selVisible], [0, true], `after leaving and re-entering canvas mode: ${JSON.stringify(s)}`);
  // the DOM changes while scrolled: rows above go away, the pane stays full
  await f.evaluate(() => { for (let i = 0; i < 300; i++) document.querySelector("#deep i").remove(); });
  await page.waitForTimeout(400);
  s = await treeFill(f);
  assert.equal(s.blank, 0, `after a DOM change while scrolled: ${JSON.stringify(s)}`);
  await page.close();
});

test("computed values are fields: a typed value goes into element styles; invalid is marked, Esc reverts, arrows move", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  await page.waitForTimeout(250);
  const val = (prop) => f.locator("b42-review .crow", { has: f.locator(".cp", { hasText: new RegExp(`^${prop}$`) }) }).locator(".cval");
  const row = (prop) => ui(f, (r, p) => {
    const x = [...r.querySelectorAll(".crow")].find((c) => c.firstChild.textContent === p);
    return { value: x.lastChild.value, bad: x.lastChild.classList.contains("bad"), title: x.lastChild.title, mine: x.classList.contains("mine"), focus: r.activeElement === x.lastChild };
  }, prop);
  assert.match(await ui(f, (r) => r.querySelector(".p-el div.sec").textContent), /^Computed edit a value to add it to Element styles$/);
  assert.deepEqual(await row("width"), { value: "200px", bad: false, title: "200px", mine: false, focus: false });
  // Enter writes it
  await val("width").fill("260px");
  await page.keyboard.press("Enter");
  await settle(f);
  assert.equal(await field(f, "css").inputValue(), "width: 260px;");
  assert.equal((await box(f, SECOND)).width, 260);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0, "Enter in a value does not send");
  // …blur too, replacing the declaration that is there
  await val("width").fill("300px");
  await page.keyboard.press("Tab");
  await settle(f);
  assert.equal(await field(f, "css").inputValue(), "width: 300px;");
  assert.equal((await row("height")).focus, true, "Tab goes to the next value");
  await page.waitForTimeout(200);
  assert.deepEqual([(await row("width")).value, (await row("width")).mine], ["300px", true]);
  // a value the browser rejects is marked and not written; Esc puts the old one back
  await val("width").fill("banana");
  await page.keyboard.press("Enter");
  assert.deepEqual(await row("width"), { value: "banana", bad: true, title: "invalid value for width: not written", mine: true, focus: true });
  assert.equal(await field(f, "css").inputValue(), "width: 300px;");
  await page.keyboard.press("Escape");
  assert.deepEqual(await row("width"), { value: "300px", bad: false, title: "300px", mine: true, focus: false });
  // ↓ ↑ move between the rows; alt+↑ nudges a number (shift: by 10)
  await val("width").click();
  await page.keyboard.press("ArrowDown");
  assert.equal((await row("height")).focus, true);
  await page.keyboard.press("ArrowUp");
  assert.equal((await row("width")).focus, true);
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await settle(f);
  assert.equal(await field(f, "css").inputValue(), "width: 311px;");
  // a second property is appended; the name still copies the line as it is
  await val("border-radius").fill("20px");
  await page.keyboard.press("Enter");
  await f.locator("b42-review .crow .cp", { hasText: /^display$/ }).click();
  await settle(f);
  assert.equal(await field(f, "css").inputValue(), "width: 311px;\nborder-radius: 20px;\ndisplay: block;");
  assert.equal(await f.evaluate(() => window.pageKeys), 0, "the page saw none of the typing");
  // a long value is cut with an ellipsis, whole in its title
  const ff = await ui(f, (r) => { const x = [...r.querySelectorAll(".crow")].find((c) => c.firstChild.textContent === "font-family").lastChild; return [x.title === x.value, getComputedStyle(x).textOverflow, x.getBoundingClientRect().right <= r.querySelector(".side").getBoundingClientRect().right]; });
  assert.deepEqual(ff, [true, "ellipsis", true]);
  // still one style edit for the element
  await clickAt(page, f, "#title");
  const n = await send(page);
  assert.deepEqual([n.edits.length, n.edits[0].kind, n.edits[0].changes.map((c) => c.prop)], [1, "style", ["width", "border-radius", "display"]]);
  await page.close();
});

test("Element | Global: the stylesheet has its own tab; nothing selected shows it; a chosen Global stays; a dot says it has rules", async () => {
  const { page, f } = await open();
  const tabs = () => ui(f, (r) => ({
    on: r.querySelector(".tab.on").textContent, elOff: r.querySelector(".t-el").disabled, elTitle: r.querySelector(".t-el").title,
    shown: [...r.querySelectorAll(".pane")].filter((p) => !p.hidden).map((p) => [...p.querySelectorAll(".sec")].map((x) => x.firstChild.textContent.trim()).join(",")).join("|"),
    dot: !r.querySelector(".t-gl .dot").hidden,
  }));
  assert.deepEqual(await tabs(), { on: "Global", elOff: true, elTitle: "Select an element", shown: "Stylesheet", dot: false });
  // the stylesheet box fills the pane
  const fill = await ui(f, (r) => { const a = r.querySelector(".free").getBoundingClientRect(), p = r.querySelector(".p-gl").getBoundingClientRect(); return p.bottom - a.bottom < 24 && a.height > 150; });
  assert.equal(fill, true);
  // selecting an element shows Element
  await clickAt(page, f, SECOND, 100, 80);
  assert.deepEqual(await tabs(), { on: "Element", elOff: false, elTitle: "Classes, styles and computed values of the selection", shown: "Classes,Element styles,Computed", dot: false });
  // Global, chosen by hand, stays through the next selection; rules in it show as a dot
  await f.locator("b42-review .t-gl").click();
  await f.locator("b42-review .free").fill(".tile { color: red; }");
  await clickAt(page, f, "#title");
  assert.deepEqual(await tabs(), { on: "Global", elOff: false, elTitle: "Classes, styles and computed values of the selection", shown: "Stylesheet", dot: true });
  await f.locator("b42-review .t-el").click();
  assert.deepEqual([(await tabs()).on, (await tabs()).dot], ["Element", true]);
  // by keyboard: the switch takes focus, arrows and Enter work it, and Enter there does not send
  await f.locator("b42-review .t-el").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal((await tabs()).on, "Global");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await tabs()).on, "Element");
  await f.locator("b42-review .t-gl").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  assert.deepEqual([(await tabs()).on, await page.evaluate(() => window.__harness.notes.length)], ["Global", 0]);
  // the edits list's "Stylesheet" row opens Global and puts the caret in the box
  await f.locator("b42-review .t-el").click();
  await f.locator("b42-review .count").click();
  await f.locator("b42-review .erow", { hasText: "Stylesheet" }).locator(".el").click();
  assert.deepEqual([(await tabs()).on, await ui(f, (r) => r.activeElement?.className)], ["Global", "free"]);
  // with the selection gone, Global again
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  assert.deepEqual([(await tabs()).on, (await tabs()).elOff], ["Global", true]);
  await page.close();
});

test("icons are SVG: no glyph stands in for one, and what is clicked is at least 24px", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  await drag(page, f, b.x + b.width, b.y + 30, b.x + b.width + 40, b.y + 30);
  await f.locator("b42-review .count").click();
  const seen = await ui(f, (r) => {
    const size = (s) => { const q = r.querySelector(s).getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; };
    const svg = (s) => !!r.querySelector(`${s} svg`) && getComputedStyle(r.querySelector(`${s} svg`)).stroke !== "none" && r.querySelector(`${s} svg`).getAttribute("viewBox") === "0 0 16 16";
    const text = [".bar", ".insp", ".corner"].map((s) => r.querySelector(s).textContent).join(" ");
    return {
      svg: [".ifold", ".help", ".m-brush", ".trow .tw", ".ex", ".count"].filter((s) => !svg(s)),
      glyphs: (text.match(/[▾▸▴▲▼◂✕✖×●•‹›❮❯?]/g) || []).join(""),
      fold: size(".ifold"), ex: size(".ex"), help: size(".help"), twisty: size(".trow .tw"),
      foldTitle: r.querySelector(".ifold").title,
    };
  });
  assert.deepEqual(seen, { svg: [], glyphs: "", fold: [28, 24], ex: [24, 24], help: [36, 36], twisty: [16, 20], foldTitle: "Collapse the inspector" });
  await f.locator("b42-review .ifold").click();
  assert.deepEqual(await ui(f, (r) => [r.querySelector(".ifold").title, r.querySelector(".ifold svg path").getAttribute("d")]), ["Open the inspector", "m4 10 4-4 4 4"]);
  await page.close();
});

test("a canvas note the host refuses is the unsent batch again: its edits, its words and its undo steps, and the bar says why", async () => {
  const { page, f } = await open();
  await page.evaluate(() => (window.__harness.refuse = "the app could not read the note"));
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await field(f, "free").fill(".tile { color: red; }");
  await f.locator("b42-review .cnote").fill("wider, and red tiles");
  await clickAt(page, f, "#title");
  await page.keyboard.press("Enter");
  await f.waitForFunction(() => /^Not sent/.test(document.querySelector("b42-review").shadowRoot.querySelector(".bmsg").textContent));
  await frames(f);
  let s = await ui(f, (r) => ({ msg: r.querySelector(".bmsg").textContent, count: r.querySelector(".count").textContent, free: r.querySelector(".free").value, sel: r.querySelectorAll(".box.sel").length, undo: r.querySelector(".undo").disabled, busy: window.__b42.busy() }));
  assert.deepEqual(s, { msg: "Not sent: the app could not read the note", count: "2 edits", free: ".tile { color: red; }", sel: 0, undo: false, busy: true });
  assert.equal((await box(f, SECOND)).width, 320);
  assert.equal(await style(f, "#grid .tile", "color"), "rgb(255, 0, 0)");
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  await page.waitForFunction(() => window.__harness.draft?.note === "wider, and red tiles" && !!window.__harness.draft.edits?.sheet);
  // Not sent after all by the two-second timer, no pin-less preview left behind, and the reason goes.
  await page.waitForTimeout(2800);
  s = await ui(f, (r) => ({ count: r.querySelector(".count").textContent, note: r.querySelector(".cnote").value, msg: r.querySelector(".bmsg").textContent }));
  assert.deepEqual(s, { count: "2 edits", note: "wider, and red tiles", msg: "" });
  // Its undo steps are its own again.
  await page.keyboard.press(`${MOD}+z`);
  await settle(f);
  assert.equal(await style(f, "#grid .tile", "color"), "rgb(28, 28, 30)");
  await page.keyboard.press(`${MOD}+Shift+z`);
  await settle(f);
  assert.equal(await style(f, "#grid .tile", "color"), "rgb(255, 0, 0)");
  // And it goes once the host takes it.
  await page.evaluate(() => (window.__harness.refuse = ""));
  const n = await send(page);
  assert.equal(n.text, "wider, and red tiles");
  assert.deepEqual(n.edits.map((e) => e.kind), ["style"]);
  assert.equal(n.css, ".tile { color: red; }");
  await page.close();
});

test("a text edit too long for the host is said before sending, and stays to be shortened", async () => {
  const { page, f } = await open();
  const b = await box(f, "#title");
  await page.mouse.click(b.x + 40, b.y + 20);
  await page.mouse.click(b.x + 40, b.y + 20);
  await frames(f);
  await page.keyboard.insertText("x".repeat(2001));
  await page.keyboard.press("Enter");
  await frames(f);
  assert.equal(await ui(f, (r) => r.querySelector(".count").textContent), "1 edit");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  assert.match(await ui(f, (r) => r.querySelector(".bmsg").textContent), /^Too long to send: a text edit holds 2000 characters at most/);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  assert.equal(await f.evaluate(() => document.getElementById("title").textContent.length), 2001);
  assert.equal(await ui(f, (r) => r.querySelector(".count").textContent), "1 edit");
  await page.close();
});

test("busy() is true from the first key typed into a field, and a note's words alone survive a reload", async () => {
  const { page, f } = await open();
  assert.equal(await f.evaluate(() => window.__b42.busy()), false);
  // The rule is not an undo step yet (that takes a pause in the typing), and the host has no draft of it.
  await field(f, "free").fill(".tile { color: red; }");
  assert.deepEqual(await f.evaluate(() => [window.__b42.busy(), window.parent.__harness.draft]), [true, null]);
  await page.waitForFunction(() => window.__harness.draft?.edits?.sheet === ".tile { color: red; }");
  await field(f, "free").fill("");
  await page.waitForFunction(() => window.__harness.draft === null);
  // Words for the batch, and no edits.
  await f.locator("b42-review .cnote").fill("tighten this up");
  await page.waitForFunction(() => window.__harness.draft?.note === "tighten this up" && !window.__harness.draft.edits);
  await page.click("#reload");
  await page.waitForTimeout(150);
  const f2 = await pageFrame(page);
  await f2.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector(".cnote").value === "tighten this up");
  assert.equal(await ui(f2, (r) => !r.querySelector(".insp").hidden), true);
  await page.close();
});

test("the inspector follows a class the page itself changes: the class line and the computed values, and a class typed after it keeps the page's", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await settle(f);
  const read = () => ui(f, (r) => ({ cls: r.querySelector(".cls").value, size: [...r.querySelectorAll(".crow")].find((x) => x.firstChild.textContent === "font-size").lastChild.value }));
  assert.deepEqual(await read(), { cls: "primary", size: "15px" });
  // What an agent's edit, hot-reloaded, looks like from here: an attribute changes, no node does.
  await f.evaluate(() => {
    document.head.appendChild(document.createElement("style")).textContent = ".big { font-size: 30px; }";
    document.getElementById("cta").className = "primary big";
  });
  await f.waitForFunction(() => document.querySelector("b42-review").shadowRoot.querySelector(".cls").value === "primary big", null, { timeout: 1500 });
  assert.deepEqual(await read(), { cls: "primary big", size: "30px" });
  // An inline style set by the page shows too.
  await f.evaluate(() => (document.getElementById("cta").style.fontSize = "12px"));
  await f.waitForFunction(() => [...document.querySelector("b42-review").shadowRoot.querySelectorAll(".crow")].find((x) => x.firstChild.textContent === "font-size").lastChild.value === "12px", null, { timeout: 1500 });
  await f.evaluate(() => (document.getElementById("cta").style.fontSize = ""));
  // A class added now is added to what the page has.
  await field(f, "cls").fill("primary big wide");
  await settle(f);
  await page.keyboard.press(`${MOD}+Enter`);
  await waitNotes(page, 1);
  const n = (await sentNotes(page))[0];
  assert.deepEqual(n.edits.map((e) => [e.kind, e.from, e.to]), [["class", "primary big", "primary big wide"]]);
  await page.close();
});

test("one chain of frames: a drag that selects its element does not leave the layer drawing twice a frame", async () => {
  const { page, f } = await open();
  const b = await box(f, SECOND);
  // Not selected yet: the drag selects it, from inside a frame.
  await drag(page, f, b.x + 100, b.y + 80, b.x - 150, b.y + 80);
  assert.equal(await ui(f, (r) => r.querySelector(".ipath").textContent), "Card · Pro For small teams");
  await frames(f, 40); // past the half second in which the pointer still counts as moving
  const per = await f.evaluate(() => new Promise((done) => {
    const real = window.requestAnimationFrame;
    let asked = 0, left = 30;
    window.requestAnimationFrame = (cb) => {
      if (cb.name === "frame") asked++;
      return real.call(window, cb);
    };
    const step = () => {
      if (left-- > 0) return void real.call(window, step);
      window.requestAnimationFrame = real;
      done(asked / 30);
    };
    real.call(window, step);
  }));
  assert.ok(per > 0.8 && per < 1.2, `${per.toFixed(2)} frames asked for per frame (two chains: 2)`);
  await page.close();
});
