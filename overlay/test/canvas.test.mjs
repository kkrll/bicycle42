// End-to-end tests for canvas mode (edit mode: the mouse gestures on the page, and what the
// inspector's acts do to it) on harness/canvas.html. The inspector is the host's (the app's
// window draws it): the harness says so, as the app does, and plays it with acts, reading what
// the overlay sends back as the view (src/canvas/host.js; canvas-hosted.test.mjs has the view's
// own tests). Same set-up as overlay.test.mjs: a system Chromium, headless. Run: bun run test
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

/** Open the canvas test page, its inspector the host's; with `canvas`, in canvas mode. */
async function open({ delay = 150, canvas = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?delay=${delay}&page=canvas`);
  const f = await pageFrame(page);
  await page.evaluate(() => window.__harness.hostDocks(["canvas"]));
  if (canvas) await canvasOn(f);
  return { page, f, errors };
}
const canvasOn = async (f) => {
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await f.page().waitForFunction(() => window.__harness.mode === "canvas" && !!window.__harness.view("canvas"));
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

// ── the host's inspector ────────────────────────────────────────────────────────────────────
/** What the host's inspector shows: the view the overlay sent last. */
const view = (f) => f.page().evaluate(() => window.__harness.view("canvas"));
/** …after the page's next frames, in which the view follows what was done. */
const shown = async (f) => {
  await frames(f);
  return view(f);
};
/** Something done in the host's inspector. */
const act = (f, a) => f.page().evaluate((x) => window.__harness.act("canvas", x), a);
/** One of the inspector's fields, as the host's has them: typing sends the field's whole text
 *  (for the selection the view names); what it holds is the view's text. The stylesheet is under
 *  Global, the class line and Element styles under Element: filling one shows its side first. */
const FIELDS = { css: "css", cls: "classes", free: "sheet" };
const field = (f, cls) => {
  const k = FIELDS[cls];
  return {
    fill: async (text) => {
      const v = await shown(f);
      if (k === "sheet" ? !v.global : v.global && v.sel) await act(f, { type: "global", on: k === "sheet" });
      await act(f, { type: "text", field: k, text, ...(k === "sheet" ? {} : { id: v.sel?.id ?? 0 }) });
    },
    /** What the field shows now: the batch's text (the class attribute, for the class line). */
    inputValue: async () => {
      const v = await shown(f);
      return k === "classes" ? v.classes.text : v[k].text;
    },
    /** The field left: the typing's undo step closes. */
    leave: () => act(f, { type: "commit" }),
  };
};
/** What the footer's count says. */
const count = async (f) => {
  const n = (await shown(f)).batch.edits;
  return n ? `${n} edit${n === 1 ? "" : "s"}` : "No edits";
};
/** What the footer says in place of the note: a refusal, else the state. */
const said = async (f) => {
  const b = (await shown(f)).batch;
  return b.msg || b.status;
};
/** The selection as the tree names it ("article.card"), or null. */
const selTag = async (f) => (await shown(f)).sel?.tag ?? null;
/** The id the view gives the row of the element with this id or tree name. */
const rowId = async (f, name) => {
  const r = (await shown(f)).tree.rows.find((x) => x.idName === name || `${x.tag}${x.idName}${x.cls}` === name);
  assert.ok(r, `no row for ${name}`);
  return r.id;
};
const sendNow = (f, bg) => act(f, { type: "send", ...(bg ? { bg: true } : {}) });
const sentNotes = (page) => page.evaluate(() => window.__harness.notes.map(({ prompt, ...n }) => n));
const waitNotes = (page, count) => page.waitForFunction((c) => window.__harness.notes.length >= c, count);
const send = async (page, count = 1) => {
  await page.keyboard.press(`${MOD}+Enter`);
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

test("canvas is off by default: no inspector view, nothing adopted, notes work as before", async () => {
  const { page, f } = await open({ canvas: false });
  await frames(f, 3);
  assert.deepEqual([await view(f), await f.evaluate(() => document.adoptedStyleSheets.length)], [undefined, 0], "the host is told nothing of an inspector, and the page has no rule of edit mode's");
  await clickAt(page, f, "#cta");
  await page.keyboard.type("bigger");
  const n = await send(page);
  assert.equal(n.text, "bigger");
  assert.equal(n.edits, undefined);
  assert.equal(n.css, undefined);
  await page.close();
});

test("mod+O / mod+P switch modes; a note in progress hands over its element and its words", async () => {
  const { page, f } = await open({ canvas: false });
  await clickAt(page, f, "#cta");
  await page.keyboard.type("rounder");
  await page.keyboard.press(`${MOD}+KeyO`);
  await settle(f);
  const v = await shown(f);
  const s = await ui(f, (r) => ({ card: !r.querySelector(".card").hidden, cursor: getComputedStyle(document.body).cursor }));
  assert.deepEqual({ ...s, mode: await page.evaluate(() => window.__harness.mode), sel: v.sel?.tag, note: v.batch.note }, { card: false, cursor: "default", mode: "canvas", sel: "button#cta.primary", note: "rounder" });
  await page.keyboard.press(`${MOD}+KeyP`);
  await settle(f);
  assert.deepEqual([await page.evaluate(() => window.__harness.mode), await ui(f, () => getComputedStyle(document.body).cursor), await f.evaluate(() => document.adoptedStyleSheets.length)], ["notes", "crosshair", 0]);
  await page.close();
});

test("tree: a click on the page selects its row, its ancestors open; page arrows walk; rows select, expand and outline", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, `${SECOND} h3`);
  let v = await shown(f);
  const name = (r) => `${r.tag}${r.idName}${r.cls}${r.text}`;
  const on = (x) => x.tree.rows[x.tree.sel - x.tree.first];
  assert.equal(name(on(v)), "h3Pro");
  assert.equal(v.sel.tag, "h3");
  const plans = v.tree.rows.find((r) => name(r) === "section#plans.row");
  assert.ok(plans && plans.kids === "open", "ancestors are open");
  assert.ok(!v.tree.rows.some((r) => /^(script|style|head|b42-review)$/.test(r.tag)), "no script, style or overlay rows");
  // with the keyboard on the page: ↑ is the parent, ↓ the first child
  await page.keyboard.press("ArrowUp");
  assert.equal(await selTag(f), "article.card");
  await page.keyboard.press("ArrowDown");
  assert.equal(await selTag(f), "h3");
  // a row selected: the element is selected on the page
  await act(f, { type: "select", id: await rowId(f, "#grid") });
  v = await shown(f);
  assert.deepEqual([v.sel.tag, await ui(f, (r) => r.querySelectorAll(".box.csel").length)], ["section#grid.grid", 1]);
  // the tree's arrows: right opens, down goes to the first child, left twice closes and goes up
  await act(f, { type: "walk", key: "ArrowRight" });
  await act(f, { type: "walk", key: "ArrowDown" });
  v = await shown(f);
  assert.equal(name(on(v)), "div.tile1");
  await act(f, { type: "walk", key: "ArrowLeft" });
  await act(f, { type: "walk", key: "ArrowLeft" });
  v = await shown(f);
  assert.deepEqual([name(on(v)), on(v).kids], ["section#grid.grid", "shut"]);
  // a row under the pointer outlines its element on the page
  await act(f, { type: "hover", id: await rowId(f, "header") });
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
  await act(f, { type: "open", id: await rowId(f, "#big") });
  await page.waitForTimeout(300);
  const v = await shown(f);
  assert.ok(v.tree.rows.length < 100, `only the rows the host shows, and a screenful around them, are sent (${v.tree.rows.length})`);
  assert.ok(v.tree.total > 5000, "the tree's length stands for all rows");
  await f.evaluate(() => document.getElementById("big").remove());
  await page.waitForTimeout(500);
  assert.ok((await shown(f)).tree.total < 50, "rows of removed elements are gone");
  await page.close();
});

test("element styles: typing applies live; mod+Enter sends one style edit", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await field(f, "css").fill("padding: 20px 40px;\n&:hover { opacity: 0.5; }");
  await settle(f);
  assert.equal(await style(f, "#cta", "padding-left"), "40px");
  assert.equal(await field(f, "css").inputValue(), "padding: 20px 40px;\n&:hover { opacity: 0.5; }");
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0, "typing does not send");
  assert.equal(await f.evaluate(() => window.pageKeys), 0, "the page saw no keys");
  await sendNow(f);
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
  const text = "colr: red; width: banana; height: 60px; --mine: 1;";
  await field(f, "css").fill(text);
  await settle(f);
  let v = await shown(f);
  assert.deepEqual(v.css.marks.map((m) => [text.slice(m.s, m.e), m.why]), [["colr: red", "unknown property “colr”"], ["width: banana", "invalid value for width"]]);
  assert.match(v.css.error, /^Not applied: unknown property “colr” · invalid value for width$/);
  assert.equal(await style(f, "#cta", "height"), "60px");
  // unbalanced braces are said; what was complete before stays applied (see the P5 test)
  await field(f, "css").fill(`${text} }`);
  await settle(f);
  v = await shown(f);
  assert.match(v.css.error, /unbalanced braces: the last complete version stays applied/);
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
  assert.equal(await field(f, "cls").inputValue(), "card");
  await field(f, "cls").fill("card bg-stripes");
  await settle(f);
  assert.equal(await f.evaluate((s) => document.querySelector(s).className, SECOND), "card bg-stripes");
  assert.match(await style(f, SECOND, "background-image"), /repeating-linear-gradient/);
  assert.equal((await shown(f)).sheet.error, "", "nothing is marked in the example");
  await sendNow(f);
  await waitNotes(page, 1);
  const [n] = await sentNotes(page);
  assert.equal(n.css, css);
  assert.equal(n.edits.length, 1);
  assert.deepEqual({ ...n.edits[0], selector: "" }, { kind: "class", selector: "", tag: "article", label: "Card · Pro For small teams", repeated: 3, from: "card", to: "card bg-stripes" });
  await page.close();
});

test("a stylesheet alone is a note; an invalid selector in it is marked", async () => {
  const { page, f } = await open();
  await field(f, "free").fill(".tile { border-radius: 20px; }\n..oops { color: red; }");
  await settle(f);
  assert.equal(await style(f, "#grid .tile", "border-radius"), "20px");
  assert.match((await shown(f)).sheet.error, /invalid selector “\.\.oops”/);
  await sendNow(f);
  await waitNotes(page, 1);
  const [n] = await sentNotes(page);
  assert.equal(n.edits, undefined);
  assert.equal(n.css, ".tile { border-radius: 20px; }\n..oops { color: red; }");
  assert.deepEqual(n.targets, []);
  const [t1, t6] = [await box(f, "#grid .tile:nth-child(1)"), await box(f, "#grid .tile:nth-child(6)")];
  assert.ok(n.bounds && Math.abs(n.bounds.w - (t6.x + t6.width - t1.x)) < 2 && Math.abs(n.bounds.h - (t6.y + t6.height - t1.y)) < 2, `bounds: the elements the new rules match, got ${JSON.stringify(n.bounds)}`);
  await page.close();
});

test("computed list shows current values; one copied is written into element styles", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#plans", 2, 2);
  await page.waitForTimeout(250);
  const v = await shown(f);
  const rows = v.computed.map((c) => `${c.prop}: ${c.value}`);
  assert.ok(rows.includes("display: flex") && rows.includes("gap: 16px"), rows.join("; "));
  // (a click on a row's name copies its value: the host's "value" act with what the row shows)
  await act(f, { type: "value", id: v.sel.id, prop: "gap", value: v.computed.find((c) => c.prop === "gap").value });
  assert.equal(await field(f, "css").inputValue(), "gap: 16px;");
  await page.close();
});

test("resize: an edge drag writes width into element styles, snapped to 4px; mod turns snapping off", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  const label = { text: "" };
  const inline = () => f.evaluate((s) => document.querySelector(s).getAttribute("style"), SECOND);
  const before = await inline();
  await drag(page, f, b.x + b.width, b.y + 30, b.x + b.width + 57, b.y + 30, {
    hold: async () => (label.text = await ui(f, (r) => r.querySelector(".lab.live").textContent)),
  });
  assert.equal(label.text, "width 200 → 256", "the live label follows the drag");
  assert.equal(await field(f, "css").inputValue(), "width: 256px;");
  assert.equal((await box(f, SECOND)).width, 256);
  assert.equal(await inline(), before, "the drag's preview leaves the element's own style attribute as it was");
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
  await field(f, "css").fill(`${await field(f, "css").inputValue()}\ncolor: red;`);
  await sendNow(f);
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

test("a style edit set with the page's variables says which: the note's change names them", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  await page.waitForTimeout(250);
  await field(f, "css").fill("padding: var(--space-2) var(--space-4);\ncolor: var(--brand);\nmargin: 0;\nborder-color: var(--nope, red);");
  await sendNow(f);
  await waitNotes(page, 1);
  const [n] = await sentNotes(page);
  assert.deepEqual(n.edits[0].changes, [
    { prop: "padding", from: "16px", to: "8px 16px", tokens: ["--space-2", "--space-4"] },
    { prop: "color", from: "rgb(28, 28, 30)", to: "rgb(42, 109, 244)", tokens: ["--brand"] },
    { prop: "margin", from: "0px", to: "0px" },
    // (one the page does not have is still what was typed: the agent sees it, with its fallback, in the CSS)
    { prop: "border-color", from: "rgb(216, 216, 210)", to: "rgb(255, 0, 0)", tokens: ["--nope"] },
  ]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a computed value the page has a variable for names it; a click writes it as var(); a length only under a name of its kind", async () => {
  const { page, f, errors } = await open();
  const hints = async () => Object.fromEntries((await shown(f)).computed.map((c) => [c.prop, (c.tokens ?? []).join(" ")]));
  await clickAt(page, f, SECOND, 100, 80);
  await page.waitForTimeout(250);
  let h = await hints();
  // padding 16px is --space-4; width 200px and font-size 15px are no variable's; 16px is not a font size's
  assert.deepEqual([h.padding, h.width, h["font-size"], h.color, h["border-radius"]], ["--space-4", "", "", "", ""]);
  await field(f, "css").fill("color: var(--brand);\npadding: 8px 16px;");
  await settle(f);
  await page.waitForTimeout(1100);
  h = await hints();
  assert.deepEqual([h.color, h.padding], ["--brand", "--space-2 --space-4"]);
  // a click on it writes the value as those variables (the host's "value" act with them)
  const v = await shown(f);
  await act(f, { type: "value", id: v.sel.id, prop: "padding", value: v.computed.find((c) => c.prop === "padding").tokens.map((n) => `var(${n})`).join(" ") });
  await settle(f);
  assert.equal(await field(f, "css").inputValue(), "color: var(--brand);\npadding: var(--space-2) var(--space-4);");
  assert.equal(await style(f, SECOND, "padding"), "8px 16px");
  // the flex row's gap
  await clickAt(page, f, "#plans", 2, 2);
  await page.waitForTimeout(250);
  assert.equal((await hints()).gap, "--space-4");
  assert.deepEqual(errors, []);
  await page.close();
});

test("padding and margin: their bands are dragged like a gap, written into element styles; shift drags both sides; a side without any has a bar to grab", async () => {
  const { page, f, errors } = await open();
  const hover = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.move(x + 1, y);
    await settle(f);
    return ui(f, (r) => ({ label: r.querySelector(".lab.live").hidden ? "" : r.querySelector(".lab.live").textContent, band: r.querySelector(".band").hidden ? "" : r.querySelector(".band").className }));
  };
  await clickAt(page, f, SECOND, 100, 80);
  const b = await box(f, SECOND);
  // the top padding (a 1px border, then 16px), and its drag: 8px down is 8px more
  assert.deepEqual(await hover(b.x + 100, b.y + 9), { label: "padding-top 16", band: "band pad" });
  await drag(page, f, b.x + 101, b.y + 9, b.x + 101, b.y + 17);
  assert.equal(await style(f, SECOND, "padding-top"), "24px");
  // shift: the left one and the right one together
  await page.keyboard.down("Shift");
  await drag(page, f, b.x + 9, b.y + 60, b.x + 17, b.y + 60);
  await page.keyboard.up("Shift");
  assert.deepEqual([await style(f, SECOND, "padding-left"), await style(f, SECOND, "padding-right")], ["24px", "24px"]);
  // its sides in the row are the gap's; above it, no margin: a bar to grab, 14px out
  assert.deepEqual(await hover(b.x + b.width / 2, b.y - 11), { label: "margin-top 0", band: "band mar" });
  assert.equal(await field(f, "css").inputValue(), "padding-top: 24px;\npadding-left: 24px;\npadding-right: 24px;");
  // a block's margin below it, dragged down (scrolled up first)
  await f.evaluate(() => document.querySelector("#stack").scrollIntoView({ block: "start" }));
  await frames(f);
  await clickAt(page, f, "#stack p:nth-of-type(1)");
  const s1 = await box(f, "#stack p:nth-of-type(1)");
  // (from 6px out: nearer the border, the edge is the resize handle)
  assert.deepEqual(await hover(s1.x + 100, s1.y + s1.height + 9), { label: "margin-bottom 12", band: "band mar" });
  await drag(page, f, s1.x + 101, s1.y + s1.height + 9, s1.x + 101, s1.y + s1.height + 17);
  assert.equal(await style(f, "#stack p:nth-of-type(1)", "margin-bottom"), "20px");
  const n = await send(page);
  assert.deepEqual(n.edits.map((e) => [e.kind, e.css]), [["style", "padding-top: 24px;\npadding-left: 24px;\npadding-right: 24px;"], ["style", "margin-bottom: 20px;"]]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("padding: a child laid over the selection's padding (a badge in its corner) is the page's to click, not the band's", async () => {
  const { page, f, errors } = await open();
  await f.evaluate((s) => {
    const a = document.querySelector(s);
    a.style.position = "relative";
    a.insertAdjacentHTML("beforeend", '<span id="badge" style="position:absolute;top:3px;right:3px;width:40px;height:10px;background:gold"></span>');
  }, SECOND);
  await clickAt(page, f, SECOND, 100, 80);
  const g = await box(f, "#badge");
  await page.mouse.move(g.x + 20, g.y + 5);
  await page.mouse.move(g.x + 21, g.y + 5);
  await settle(f);
  assert.equal(await ui(f, (r) => r.querySelector(".band").hidden), true);
  await page.mouse.click(g.x + 20, g.y + 5);
  await settle(f);
  assert.equal(await selTag(f), "span#badge");
  assert.equal(await f.evaluate(() => document.querySelector("#badge").hasAttribute("data-b42e")), false);
  // beside it, the padding is still the band's
  const b = await box(f, SECOND);
  await clickAt(page, f, SECOND, 100, 80);
  await page.mouse.move(b.x + 60, b.y + 9);
  await page.mouse.move(b.x + 61, b.y + 9);
  await settle(f);
  assert.equal(await ui(f, (r) => r.querySelector(".band").className), "band pad");
  assert.deepEqual(errors, []);
  await page.close();
});

test("duplicate: mod+D puts a copy right after the selection and selects it; edits in it say so; undo, a re-render and Delete; Reset leaves the page as it began", async () => {
  const { page, f, errors } = await open();
  const start = await pageState(f);
  const names = () => f.evaluate(() => [...document.querySelectorAll("#plans h3")].map((h) => h.textContent).join(" "));
  await clickAt(page, f, SECOND, 100, 80);
  await page.keyboard.press(`${MOD}+KeyD`);
  await settle(f);
  assert.equal(await names(), "Free Pro Pro Scale");
  const third = "#plans article:nth-of-type(3)";
  assert.equal(await f.evaluate((s) => document.querySelector(s).hasAttribute("data-b42e") && document.querySelector(s).getAttribute("data-b42e") !== document.querySelector("#plans article:nth-of-type(2)").getAttribute("data-b42e"), third), true);
  assert.equal(await count(f), "1 edit");
  // the copy is the selection: styles typed now are its own, and it shows its source's too
  await field(f, "css").fill("border-color: rgb(255, 0, 0);");
  await settle(f);
  assert.equal(await style(f, third, "border-color"), "rgb(255, 0, 0)");
  assert.equal(await style(f, SECOND, "border-color"), "rgb(216, 216, 210)");
  // its heading reworded in place
  const h = await box(f, `${third} h3`);
  await page.mouse.click(h.x + 10, h.y + h.height / 2);
  await page.mouse.click(h.x + 10, h.y + h.height / 2);
  await frames(f);
  await page.keyboard.type("Team");
  await page.keyboard.press("Enter");
  await settle(f);
  assert.equal(await names(), "Free Pro Team Scale");
  // undo takes the copy out with its edits, redo brings them back
  for (let i = 0; i < 3; i++) await page.keyboard.press(`${MOD}+KeyZ`);
  await settle(f);
  assert.equal(await names(), "Free Pro Scale");
  for (let i = 0; i < 3; i++) await page.keyboard.press(`${MOD}+Shift+KeyZ`);
  await settle(f);
  assert.equal(await names(), "Free Pro Team Scale");
  // the page builds the row anew: the copy is put back after its source
  await f.evaluate(() => window.rerender());
  await settle(f);
  assert.equal(await names(), "Free Pro Team Scale");
  assert.equal(await style(f, third, "border-color"), "rgb(255, 0, 0)");
  const n = await send(page);
  assert.deepEqual(n.edits.map((e) => [e.kind, e.label, e.copyOf]), [["style", "Card · Pro For small teams", 1], ["duplicate", "Card · Pro For small teams", undefined], ["text", "Heading · Pro", 1]]);
  assert.equal(n.edits[2].to, "Team");
  // a copy in the next batch, taken out by Delete with what was edited in it
  await clickAt(page, f, "#plans article:nth-of-type(1)", 100, 80);
  await page.keyboard.press(`${MOD}+KeyD`);
  await settle(f);
  await field(f, "css").fill("opacity: 0.5;");
  await settle(f);
  await page.keyboard.press("Delete");
  await settle(f);
  assert.equal(await count(f), "No edits");
  assert.deepEqual(errors, []);
  await page.close();
  // Reset: nothing of it stays in the page
  const p2 = await open();
  await clickAt(p2.page, p2.f, SECOND, 100, 80);
  await p2.page.keyboard.press(`${MOD}+KeyD`);
  await settle(p2.f);
  await field(p2.f, "css").fill("color: red;");
  await settle(p2.f);
  await act(p2.f, { type: "reset" });
  await settle(p2.f);
  assert.deepEqual(await pageState(p2.f), start);
  await p2.page.close();
});

test("duplicate, a chain: a copy of a copy shows the source's edits, its descendants' too; deleting the first copy takes the second with what was edited in it, and no other card changes", async () => {
  const { page, f, errors } = await open();
  const names = () => f.evaluate(() => [...document.querySelectorAll("#plans h3")].map((h) => h.textContent).join(" "));
  await clickAt(page, f, `${SECOND} h3`);
  await field(f, "css").fill("color: rgb(0, 0, 255);");
  await settle(f);
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("border-top-color: rgb(0, 128, 0);");
  await settle(f);
  await page.keyboard.press(`${MOD}+KeyD`);
  await settle(f);
  await page.keyboard.press(`${MOD}+KeyD`);
  await settle(f);
  assert.equal(await names(), "Free Pro Pro Pro Scale");
  for (const i of [2, 3, 4]) {
    assert.equal(await style(f, `#plans article:nth-of-type(${i})`, "border-top-color"), "rgb(0, 128, 0)", `card ${i}`);
    assert.equal(await style(f, `#plans article:nth-of-type(${i}) h3`, "color"), "rgb(0, 0, 255)", `heading ${i}`);
  }
  // the second copy (selected) gets an outline; then the first copy goes
  await field(f, "css").fill("outline: 3px solid rgb(255, 0, 0);");
  await settle(f);
  await clickAt(page, f, "#plans article:nth-of-type(3)", 100, 80);
  await page.keyboard.press("Delete");
  await settle(f);
  assert.equal(await names(), "Free Pro Scale");
  assert.deepEqual(await f.evaluate(() => [...document.querySelectorAll("#plans article")].map((a) => getComputedStyle(a).outlineStyle + (a.hasAttribute("data-b42e") ? "*" : ""))), ["none", "none*", "none"]);
  assert.equal(await count(f), "2 edits");
  const n = await send(page);
  assert.deepEqual(n.edits.map((e) => [e.kind, e.tag]), [["style", "h3"], ["style", "article"]]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("duplicate: a copy has no id (the source's edits and its own stay apart); an edit in a copy an earlier note asked for says so, and goes with the copy when that note is done", async () => {
  const { page, f, errors } = await open({ delay: 60000 });
  await clickAt(page, f, "#cta");
  await field(f, "css").fill("background-color: rgb(255, 0, 0);");
  await settle(f);
  await page.keyboard.press(`${MOD}+KeyD`);
  await settle(f);
  const copy = "header button:nth-of-type(2)";
  assert.equal(await f.evaluate((s) => document.querySelector(s).id, copy), "");
  await field(f, "css").fill("background-color: rgb(0, 0, 255);");
  await settle(f);
  assert.equal(await style(f, "#cta", "background-color"), "rgb(255, 0, 0)");
  assert.equal(await style(f, copy, "background-color"), "rgb(0, 0, 255)");
  const n1 = await send(page);
  assert.deepEqual(n1.edits.map((e) => [e.kind, e.copyOf]), [["style", undefined], ["style", 2], ["duplicate", undefined]]);
  assert.deepEqual(n1.targets.map((t) => t.selector), ["#cta"]);
  // the next batch: an edit in that copy
  await clickAt(page, f, copy);
  await field(f, "css").fill("color: rgb(0, 255, 0);");
  await settle(f);
  await clickAt(page, f, "#title");
  await field(f, "css").fill("letter-spacing: 2px;");
  await settle(f);
  const n2 = await send(page, 2);
  assert.match(n2.edits[0].inCopy, /Start free trial/);
  assert.equal(n2.edits[1].inCopy, undefined);
  // a third batch edits the copy, then the first note is done: that edit goes with the copy
  await clickAt(page, f, copy);
  await field(f, "css").fill("opacity: 0.5;");
  await settle(f);
  await f.evaluate((id) => window.__b42.receive({ type: "pins", pins: [{ id, n: 1, status: "done", selector: "#cta" }] }), n1.id);
  await settle(f);
  assert.equal(await f.evaluate(() => document.querySelectorAll("header button").length), 1);
  assert.equal(await count(f), "No edits");
  assert.equal(await style(f, "#cta", "opacity"), "1");
  assert.deepEqual(errors, []);
  await page.close();
});

test("duplicate: two in one draft come back in their places after a reload", async () => {
  const { page, f } = await open();
  const names = (fr) => fr.evaluate(() => [...document.querySelectorAll("#plans h3")].map((h) => h.textContent).join(" "));
  await clickAt(page, f, SECOND, 100, 80);
  await page.keyboard.press(`${MOD}+KeyD`);
  await settle(f);
  await clickAt(page, f, "#plans article:nth-of-type(1)", 100, 80);
  await page.keyboard.press(`${MOD}+KeyD`);
  await settle(f);
  assert.equal(await names(f), "Free Free Pro Pro Scale");
  await page.waitForFunction(() => window.__harness.draft?.edits?.ops.length === 2);
  await page.click("#reload");
  await page.waitForTimeout(150);
  const f2 = await pageFrame(page);
  await f2.waitForFunction(() => document.querySelectorAll("#plans article").length === 5);
  assert.equal(await names(f2), "Free Free Pro Pro Scale");
  await page.close();
});

test("move in block flow: the shifts follow a box that grows; a stack with a graphic in it is refused", async () => {
  const { page, f, errors } = await open();
  const s1 = await box(f, "#stack p:nth-of-type(1)"), s3 = await box(f, "#stack p:nth-of-type(3)");
  await drag(page, f, s1.x + 30, s1.y + 15, s3.x + 30, s3.y + s3.height + 4);
  const rows = () => f.evaluate(() => [...document.querySelectorAll("#stack p")].map((p) => { const r = p.getBoundingClientRect(); return [p.textContent, Math.round(r.top), Math.round(r.bottom)]; }).sort((a, b) => a[1] - b[1]));
  const apart = (rs) => rs.every((r, i) => i === 0 || r[1] >= rs[i - 1][2] - 1);
  assert.ok(apart(await rows()));
  await f.evaluate(() => (document.querySelector("#stack p:nth-of-type(2)").style.height = "140px"));
  await frames(f, 4);
  const now = await rows();
  assert.deepEqual(now.map((r) => r[0]).join(" "), "Review Ship Annotate Repeat");
  assert.ok(apart(now), JSON.stringify(now));
  await page.keyboard.press(`${MOD}+KeyZ`);
  await settle(f);
  await f.evaluate(() => document.querySelector("#stack").insertAdjacentHTML("afterbegin", '<svg style="display:block" width="20" height="20"></svg>'));
  await frames(f);
  const p1 = await box(f, "#stack p:nth-of-type(1)"), p3 = await box(f, "#stack p:nth-of-type(3)");
  await drag(page, f, p1.x + 30, p1.y + 15, p3.x + 30, p3.y + p3.height + 4);
  assert.match(await said(f), /graphics/);
  assert.equal(await count(f), "No edits");
  assert.deepEqual(errors, []);
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

test("move: in a grid, to the end (before: null)", async () => {
  const { page, f } = await open();
  const t1 = await box(f, "#grid .tile:nth-child(1)");
  const t6 = await box(f, "#grid .tile:nth-child(6)");
  await drag(page, f, t1.x + 20, t1.y + 20, t6.x + t6.width + 20, t6.y + 30);
  const tiles = await f.evaluate(() => [...document.querySelectorAll("#grid .tile")].sort((a, b) => { const p = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return p.y - q.y || p.x - q.x; }).map((a) => a.textContent).join(""));
  assert.equal(tiles, "234561");
  const n = await send(page);
  assert.deepEqual([n.edits.length, n.edits[0].kind, n.edits[0].fromIndex, n.edits[0].toIndex, n.edits[0].before, n.edits[0].parent.layout], [1, "move", 0, 5, null, "grid"]);
  await page.close();
});

test("move: in block flow the stack is shown in its new order (shifted, the DOM untouched); what follows does not move; in running text it is refused", async () => {
  const { page, f, errors } = await open();
  const seen = () => f.evaluate(() => [...document.querySelectorAll("#stack p")].sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y).map((p) => p.textContent).join(" "));
  const tops = () => f.evaluate(() => [...document.querySelectorAll("#stack p")].map((p) => Math.round(p.getBoundingClientRect().y)));
  const top0 = await tops();
  const after0 = await f.evaluate(() => Math.round(document.querySelector("#open-dialog").getBoundingClientRect().y));
  const s1 = await box(f, "#stack p:nth-of-type(1)"), s3 = await box(f, "#stack p:nth-of-type(3)");
  let mid;
  await drag(page, f, s1.x + 30, s1.y + 15, s3.x + 30, s3.y + s3.height + 4, {
    hold: async () => (mid = await ui(f, (r) => ({ line: !r.querySelector(".ins").hidden, wide: r.querySelector(".ins").getBoundingClientRect().width > 100, label: r.querySelector(".lab.live").textContent }))),
  });
  assert.deepEqual(mid, { line: true, wide: true, label: "1 → 3" });
  assert.equal(await seen(), "Review Ship Annotate Repeat");
  assert.deepEqual(await f.evaluate(() => [...document.querySelectorAll("#stack p")].map((p) => p.textContent).join(" ")), "Annotate Review Ship Repeat");
  // the places are the old ones: the first box starts where the first did, the last one and what follows stay
  const top1 = await tops();
  assert.deepEqual([top1[1], top1[2], top1[0], top1[3]], top0);
  assert.equal(await f.evaluate(() => Math.round(document.querySelector("#open-dialog").getBoundingClientRect().y)), after0);
  // the page patches the stack: the order stays
  await f.evaluate(() => window.rerender());
  await frames(f, 3);
  assert.equal(await seen(), "Review Ship Annotate Repeat");
  // a button in a paragraph sits in a line: dragging it is refused and said
  await f.evaluate(() => document.querySelector("#stack").scrollIntoView({ block: "start" }));
  await frames(f);
  await clickAt(page, f, "#open-dialog");
  const b = await box(f, "#open-dialog");
  await drag(page, f, b.x + b.width / 2, b.y + b.height / 2, b.x + b.width / 2, b.y + 80);
  assert.match(await said(f), /among text, side-by-side/);
  const n = await send(page);
  const e = n.edits[0];
  assert.deepEqual([n.edits.length, e.kind, e.fromIndex, e.toIndex, e.parent.selector, e.parent.layout, e.before.label], [1, "move", 0, 2, "#stack", "block", "Text · Repeat"]);
  assert.deepEqual(errors, []);
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
  assert.equal(await count(f), "6 edits");
  // undo the hide, redo it, undo again
  await page.keyboard.press(`${MOD}+z`);
  assert.notEqual(await style(f, "#cta", "display"), "none");
  await page.keyboard.press(`${MOD}+Shift+z`);
  assert.equal(await style(f, "#cta", "display"), "none");
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`); // the text
  assert.equal(await f.evaluate(() => document.getElementById("title").textContent), "Simple pricing");
  // Reset takes the rest away; nothing is left of any of it
  await act(f, { type: "reset" });
  await frames(f);
  assert.deepEqual(await pageState(f), start);
  assert.equal(await count(f), "No edits");
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
  await f.evaluate(() => window.scrollTo(0, 320)); // (the stack nearer the middle)
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
  await act(f, { type: "note", text: "tighten this up" });
  await page.waitForFunction(() => window.__harness.draft?.note === "tighten this up" && window.__harness.draft.edits?.ops.length === 1);
  await page.click("#reload");
  await page.waitForTimeout(150);
  const f2 = await pageFrame(page);
  await f2.waitForFunction(() => getComputedStyle(document.querySelector("#cta")).display === "none");
  assert.equal((await box(f2, SECOND)).width, 320);
  assert.equal(await style(f2, "#grid .tile", "color"), "rgb(255, 0, 0)");
  // canvas mode itself is still on, the host's fields are filled again, and the batch can be sent or undone
  await page.waitForFunction(() => window.__harness.mode === "canvas");
  await f2.page().waitForFunction(() => window.__harness.view("canvas")?.batch.edits === 3);
  const v = await shown(f2);
  assert.deepEqual({ count: await count(f2), note: v.batch.note, free: v.sheet.text }, { count: "3 edits", note: "tighten this up", free: ".tile { color: red; }" });
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
  await page.waitForFunction(() => window.__harness.view("canvas").batch.edits === 0);
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
      chrome: r.querySelectorAll(".pin").length > 0 };
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

test("Esc: deselects, leaves canvas mode (edits stay, said in notes mode), then review mode", async () => {
  const { page, f } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 300px;");
  // (Esc in one of the host's fields leaves the field: the window's, app.e2e.ts.)
  const s = () => ui(f, (r) => ({ sel: r.querySelectorAll(".box.csel").length, chip: r.querySelector(".bar").checkVisibility() ? r.querySelector(".bar .count").textContent : "" }));
  await page.keyboard.press("Escape");
  await frames(f);
  assert.deepEqual({ ...(await s()), mode: await page.evaluate(() => window.__harness.mode), count: await count(f) }, { sel: 0, chip: "", mode: "canvas", count: "1 edit" });
  await page.keyboard.press("Escape");
  await frames(f);
  assert.deepEqual({ ...(await s()), mode: await page.evaluate(() => window.__harness.mode) }, { sel: 0, chip: "1 unsent edit", mode: "notes" });
  assert.equal((await box(f, SECOND)).width, 300, "the edit is still applied, and still in the draft");
  await page.waitForFunction(() => window.__harness.draft?.edits && Object.keys(window.__harness.draft.edits.els).length === 1);
  assert.equal(await page.evaluate(() => window.__harness.enabled), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__harness.enabled === false);
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
  assert.equal(await f.evaluate((s) => document.querySelector(s).getAttribute("style"), SECOND), null, "no style attribute is left behind");
  // The browser taking the pointer away (a system gesture) undoes it the same way.
  await page.mouse.move(b.x + b.width, b.y + 30);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + 30, { steps: 5 });
  await frames(f);
  assert.equal((await box(f, SECOND)).width, 260);
  await f.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));
  await page.mouse.up();
  await frames(f);
  assert.equal((await box(f, SECOND)).width, 200, "pointercancel puts the width back");
  assert.equal(await field(f, "css").inputValue(), "");
  assert.equal(await f.evaluate((s) => document.querySelector(s).getAttribute("style"), SECOND), null, "no style attribute or live property is left behind");
  // every other way of making edits, and the footer's buttons: no note
  await drag(page, f, b.x + b.width, b.y + 30, b.x + b.width + 40, b.y + 30);
  await act(f, { type: "undo" });
  await field(f, "css").fill("color: red;");
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "notes" }));
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  assert.ok(!(await page.evaluate(() => window.__harness.log)).includes("note"));
  // Enter with nothing to send says so and sends nothing
  await act(f, { type: "reset" });
  await clickAt(page, f, "#title");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(200);
  assert.match(await said(f), /Nothing to send/);
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
  assert.equal(await selTag(f), "button#db");
  const b = await box(f, "#db");
  await drag(page, f, b.x + b.width, b.y + 10, b.x + b.width + 32, b.y + 10);
  const w = (await box(f, "#db")).width;
  assert.equal(w % 4, 0);
  assert.equal(await field(f, "css").inputValue(), `width: ${w}px;`);
  await field(f, "css").fill(`width: ${w}px; color: red;`);
  await settle(f);
  assert.equal(await style(f, "#db", "color"), "rgb(255, 0, 0)", "what is typed reaches the element in the dialog");
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
  assert.match((await shown(f)).css.error, /^Too long: 4018 \/ 4000/);
  assert.notEqual(await style(f, "#cta", "color"), "rgb(255, 0, 0)");
  await sendNow(f);
  await page.waitForTimeout(200);
  assert.match(await said(f), /Too long to send/);
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
    await clickAt(page, f, `#many i:nth-of-type(${i})`);
    await field(f, "css").fill("color: red;");
    await field(f, "css").leave(); // the step closes
  }
  assert.equal(await count(f), "40 edits");
  assert.match(await said(f), /40 edits is the limit/);
  assert.notEqual(await style(f, "#many i:nth-of-type(41)", "color"), "rgb(255, 0, 0)");
  await page.close();
});


test("U2 the footer says what sending did: preview stays until note N is done, then that it was removed; no chip over the page", async () => {
  const { page, f } = await open({ delay: 900 });
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await clickAt(page, f, "#title");
  await send(page);
  await page.waitForFunction(() => /^Sent · preview stays until note 1 is done$/.test(window.__harness.view("canvas").batch.status));
  assert.equal(await ui(f, (r) => r.querySelector(".sent").hidden), true, "no detached Sent chip in canvas mode");
  assert.equal((await box(f, SECOND)).width, 320);
  await page.waitForFunction(() => window.__harness.notes[0].status === "done");
  await settle(f);
  assert.equal(await said(f), "Note 1 done · preview removed");
  assert.equal((await box(f, SECOND)).width, 200);
  await page.waitForTimeout(4300);
  assert.equal(await said(f), "", "idle again: controls only, no standing text");
  // a failed note says the edits were put back
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await clickAt(page, f, "#title");
  const n = await send(page, 2);
  await f.waitForFunction(() => !window.__b42.busy());
  await f.evaluate((id) => window.__b42.receive({ type: "pins", pins: [{ id, n: 2, status: "failed", selector: "#title" }] }), n.id);
  await settle(f);
  assert.equal(await said(f), "Note 2 failed · edits put back");
  await page.close();
});

test("U3 a refusal never outlives the next thing done; in notes mode unsent canvas edits are a button back", async () => {
  const { page, f } = await open();
  const msg = async () => (await shown(f)).batch.msg;
  await clickAt(page, f, "#title");
  await page.keyboard.press(`${MOD}+Enter`);
  await frames(f);
  assert.equal(await msg(), "Nothing to send yet: edit something first");
  await clickAt(page, f, "#cta");
  assert.equal(await msg(), "", "gone with the next click");
  // a refused reorder (a button in a line of a paragraph), then an edit: the refusal is gone at once
  await f.evaluate(() => document.querySelector("#stack").scrollIntoView({ block: "start" }));
  await frames(f);
  await clickAt(page, f, "#open-dialog");
  const s1 = await box(f, "#open-dialog");
  await drag(page, f, s1.x + s1.width / 2, s1.y + s1.height / 2, s1.x + s1.width / 2, s1.y + 60);
  assert.match(await msg(), /among text, side-by-side/);
  await field(f, "css").fill("color: red;");
  await settle(f);
  assert.equal(await msg(), "");
  // back in notes mode the edit is not forgotten: a button on the page says so and leads back
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "notes" }));
  const chip = f.locator("b42-review .bar .count");
  assert.equal(await chip.textContent(), "1 unsent edit");
  await chip.click();
  await settle(f);
  assert.deepEqual([await page.evaluate(() => window.__harness.mode), await count(f), await ui(f, (r) => r.querySelector(".bar .count").checkVisibility())], ["canvas", "1 edit", false]);
  await page.close();
});


test("U8 labels join the texts of children with a space, and leave a word split by inline markup whole", async () => {
  const { page, f } = await open();
  await f.evaluate(() => document.querySelector("header").insertAdjacentHTML("beforebegin", '<p id="w">un<b>believ</b>able <i>deal</i></p><div id="x"><div>Label</div><div>Value</div></div><nav id="nv"><a>Home</a><a>Docs</a></nav>'));
  await page.waitForTimeout(300);
  // (the label is what an edit is named by: in the edits list, and in the note)
  await clickAt(page, f, SECOND, 100, 80);
  await page.keyboard.press(`${MOD}+KeyD`);
  for (const id of ["#w", "#x", "#nv"]) {
    await act(f, { type: "select", id: await rowId(f, id) });
    await act(f, { type: "hide" });
  }
  await act(f, { type: "edits", open: true });
  await settle(f);
  assert.deepEqual((await shown(f)).batch.list.map((r) => r.label), ["Card · Pro For small teams", "Text · unbelievable deal", "Block · Label Value", "Navigation · Home Docs"]);
  await page.close();
});

test("U9 an edit's selector is anchored at the nearest id, or is the shortest that matches one element", async () => {
  const { page, f } = await open();
  // two groups that look the same, no ids anywhere near
  await f.evaluate(() => document.querySelector("header").insertAdjacentHTML("afterend", '<div class="twins"><ul class="list"><li>A</li><li>B</li></ul><ul class="list"><li>A</li><li>B</li></ul></div>'));
  await page.waitForTimeout(300);
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 300px;");
  await act(f, { type: "open", id: await rowId(f, "div.twins") });
  const lists = (await shown(f)).tree.rows.filter((r) => r.tag === "ul");
  await act(f, { type: "open", id: lists[1].id });
  const rows = (await shown(f)).tree.rows, at = rows.findIndex((r) => r.id === lists[1].id);
  await act(f, { type: "select", id: rows.slice(at + 1).find((r) => r.tag === "li" && r.text === "B").id });
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
  let text = ".tile { border-radius: 20px; }";
  await field(f, "free").fill(text);
  await settle(f);
  const state = async () => [await style(f, "#grid .tile", "border-radius"), await style(f, "#cta", "letter-spacing"), (await shown(f)).sheet.error];
  assert.deepEqual(await state(), ["20px", "normal", ""]);
  for (const more of ["\n#cta {", " letter-spacing: 2px;"]) {
    await field(f, "free").fill((text += more));
    await settle(f);
    assert.deepEqual(await state(), ["20px", "normal", "Not applied: unbalanced braces: the last complete version stays applied"]);
  }
  await field(f, "free").fill((text += " }"));
  await settle(f);
  assert.deepEqual(await state(), ["20px", "2px", ""]);
  // the same in Element styles
  await clickAt(page, f, "#cta");
  // What stays applied is the last complete text a frame saw, so the declaration has to reach
  // the page before the brace opens, as it does at a person's speed.
  await field(f, "css").fill("height: 60px;");
  await f.waitForFunction(() => getComputedStyle(document.querySelector("#cta")).height === "60px");
  await field(f, "css").fill("height: 60px; &:hover {");
  await page.waitForFunction(() => window.__harness.view("canvas").css.error.includes("unbalanced braces"));
  await settle(f);
  assert.equal(await style(f, "#cta", "height"), "60px");
  await page.close();
});


test("brush: on, a plain drag draws a stroke; off, it selects an area; alt+drag draws either way", async () => {
  const { page, f } = await open({ canvas: false });
  // the brush is the host's button: the layer is told, and says back what it is
  const brush = page.locator("#brush");
  const pressed = () => page.evaluate(() => String(window.__harness.brush));
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
  assert.deepEqual([await pressed(), await ui(f, (r) => r.querySelector(".m-brush, .seg"))], ["false", null], "the layer has no brush or mode switch of its own");
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
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  await brush.click();
  await frames(f);
  assert.deepEqual([await pressed(), await page.evaluate(() => window.__harness.mode)], ["true", "notes"]);
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "canvas" }));
  assert.deepEqual([await pressed(), await page.evaluate(() => window.__harness.mode)], ["false", "canvas"]);
  // the layer's own key changes the mode too, and the host hears it
  await clickAt(page, f, "#title"); // the keyboard is with the page again
  await page.keyboard.press(`${MOD}+KeyP`);
  assert.equal(await page.evaluate(() => window.__harness.mode), "notes");
  await page.close();
});

test("notes mode's “?” is a bubble of its own in the corner: its keys above it and inside the window; none in canvas mode or during a capture", async () => {
  const { page, f } = await open({ canvas: false });
  const geo = () => ui(f, (r) => {
    const q = r.querySelector(".help").getBoundingClientRect();
    const p = r.querySelector(".corner .pop"), pr = p.getBoundingClientRect();
    return { right: Math.round(innerWidth - q.right), size: [q.width, q.height], pop: p.hidden ? null : { above: pr.bottom <= q.top, rightAligned: Math.round(pr.right) === Math.round(q.right), inside: pr.left >= 0 && pr.top >= 0 }, shown: !r.querySelector(".corner").hidden };
  });
  assert.deepEqual(await geo(), { right: 12, size: [36, 36], pop: null, shown: true });
  await f.locator("b42-review .help").click();
  assert.deepEqual((await geo()).pop, { above: true, rightAligned: true, inside: true });
  assert.match(await ui(f, (r) => r.querySelector(".corner .pop").textContent), /the pencil.*templates/s);
  await page.keyboard.press("Escape");
  assert.equal((await geo()).pop, null);
  assert.equal(await page.evaluate(() => window.__harness.enabled), true, "Esc closed the list, not review mode");
  await f.locator("b42-review .help").click();
  await clickAt(page, f, "#title");
  assert.equal((await geo()).pop, null, "a click on the page closes it");
  await page.keyboard.press("Escape");
  // canvas mode: the host's inspector has its own (app.e2e.ts)
  await canvasOn(f);
  await frames(f);
  assert.equal((await geo()).shown, false);
  await f.evaluate(() => window.__b42.receive({ type: "mode", mode: "notes" }));
  await frames(f);
  assert.equal((await geo()).shown, true);
  // hidden during a capture
  await page.evaluate(() => { const fw = document.getElementById("page").contentWindow; const real = fw.__b42.receive; fw.__b42.receive = (m) => (m.type === "captured" ? 0 : real(m)); });
  await clickAt(page, f, "#title");
  await page.keyboard.type("hello");
  await page.keyboard.press(`${MOD}+Enter`);
  await waitNotes(page, 1);
  assert.equal(await ui(f, (r) => r.querySelector(".corner").hidden), true);
  await page.close();
});

test("undo and redo of an element's first style edit: Element styles shows the edit again, and typing goes on in it", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, SECOND, 100, 80);
  await page.waitForTimeout(250);
  const css = () => field(f, "css").inputValue();
  const colour = () => f.evaluate((s) => getComputedStyle(document.querySelector(s)).color, SECOND);
  const before = await colour();
  await field(f, "css").fill("color: rgb(255, 0, 0);");
  await page.waitForTimeout(800); // the pause that makes it an undo step
  await settle(f);
  assert.equal(await colour(), "rgb(255, 0, 0)");
  const force = (await shown(f)).force;
  await page.keyboard.press(`${MOD}+z`);
  await settle(f);
  assert.deepEqual([await css(), await colour()], ["", before], "undo takes it off");
  await page.keyboard.press(`${MOD}+Shift+z`);
  await settle(f);
  assert.deepEqual([await css(), await colour()], ["color: rgb(255, 0, 0);", "rgb(255, 0, 0)"], "redo shows it in Element styles again");
  assert.ok((await shown(f)).force > force, "and the host's field takes it, typed in or not");
  // and what is typed now is the same edit, not a second one for the same element
  await field(f, "css").fill("color: rgb(0, 0, 255);");
  await page.waitForTimeout(800);
  await settle(f);
  assert.equal(await colour(), "rgb(0, 0, 255)");
  assert.equal(await count(f), "1 edit");
  await page.keyboard.press(`${MOD}+z`);
  await settle(f);
  assert.deepEqual([await css(), await colour()], ["color: rgb(255, 0, 0);", "rgb(255, 0, 0)"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a canvas note the host refuses is the unsent batch again: its edits, its words and its undo steps, and the footer says why", async () => {
  const { page, f } = await open();
  await page.evaluate(() => (window.__harness.refuse = "the app could not read the note"));
  await clickAt(page, f, SECOND, 100, 80);
  await field(f, "css").fill("width: 320px;");
  await field(f, "free").fill(".tile { color: red; }");
  await act(f, { type: "note", text: "wider, and red tiles" });
  await clickAt(page, f, "#title");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForFunction(() => /^Not sent/.test(window.__harness.view("canvas").batch.msg));
  await frames(f);
  let v = await shown(f);
  const s = { msg: v.batch.msg, count: await count(f), free: v.sheet.text, sel: await ui(f, (r) => r.querySelectorAll(".box.sel").length), undo: v.batch.undo, busy: await f.evaluate(() => window.__b42.busy()) };
  assert.deepEqual(s, { msg: "Not sent: the app could not read the note", count: "2 edits", free: ".tile { color: red; }", sel: 0, undo: true, busy: true });
  assert.equal((await box(f, SECOND)).width, 320);
  assert.equal(await style(f, "#grid .tile", "color"), "rgb(255, 0, 0)");
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  await page.waitForFunction(() => window.__harness.draft?.note === "wider, and red tiles" && !!window.__harness.draft.edits?.sheet);
  // Not sent after all by the two-second timer, no pin-less preview left behind, and the reason goes.
  await page.waitForTimeout(2800);
  v = await shown(f);
  assert.deepEqual({ count: await count(f), note: v.batch.note, msg: v.batch.msg }, { count: "2 edits", note: "wider, and red tiles", msg: "" });
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
  assert.equal(await count(f), "1 edit");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(200);
  assert.match(await said(f), /^Too long to send: a text edit holds 2000 characters at most/);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  assert.equal(await f.evaluate(() => document.getElementById("title").textContent.length), 2001);
  assert.equal(await count(f), "1 edit");
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
  await act(f, { type: "note", text: "tighten this up" });
  await page.waitForFunction(() => window.__harness.draft?.note === "tighten this up" && !window.__harness.draft.edits);
  await page.click("#reload");
  await page.waitForTimeout(150);
  await pageFrame(page);
  await page.waitForFunction(() => window.__harness.mode === "canvas" && window.__harness.view("canvas")?.batch.note === "tighten this up");
  await page.close();
});

test("the inspector follows a class the page itself changes: the class line and the computed values, and a class typed after it keeps the page's", async () => {
  const { page, f } = await open();
  await clickAt(page, f, "#cta");
  await settle(f);
  const read = async () => { const v = await shown(f); return { cls: v.classes.text, size: v.computed.find((c) => c.prop === "font-size").value }; };
  assert.deepEqual(await read(), { cls: "primary", size: "15px" });
  // What an agent's edit, hot-reloaded, looks like from here: an attribute changes, no node does.
  await f.evaluate(() => {
    document.head.appendChild(document.createElement("style")).textContent = ".big { font-size: 30px; }";
    document.getElementById("cta").className = "primary big";
  });
  await page.waitForFunction(() => window.__harness.view("canvas").classes.text === "primary big", null, { timeout: 1500 });
  assert.deepEqual(await read(), { cls: "primary big", size: "30px" });
  // An inline style set by the page shows too.
  await f.evaluate(() => (document.getElementById("cta").style.fontSize = "12px"));
  await page.waitForFunction(() => window.__harness.view("canvas").computed.find((c) => c.prop === "font-size").value === "12px", null, { timeout: 1500 });
  await f.evaluate(() => (document.getElementById("cta").style.fontSize = ""));
  // A class added now is added to what the page has.
  await field(f, "cls").fill("primary big wide");
  await settle(f);
  await sendNow(f);
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
  assert.equal(await selTag(f), "article.card");
  await frames(f, 40); // past the half second in which the pointer still counts as moving
  const perFrame = () => f.evaluate(() => new Promise((done) => {
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
  // A selection that sits still is drawn on the slow tick only.
  const still = await perFrame();
  assert.ok(still < 0.3, `${still.toFixed(2)} frames asked for per frame while nothing moves`);
  // Animated, it is drawn every frame: once a frame, not twice.
  await f.evaluate((sel) => document.querySelector(sel).animate([{ translate: "0 0" }, { translate: "0 4px" }], { duration: 800, iterations: Infinity }), SECOND);
  await frames(f, 30); // the slow tick sees it within 250 ms, and the frames start then
  const per = await perFrame();
  assert.ok(per > 0.8 && per < 1.2, `${per.toFixed(2)} frames asked for per frame (two chains: 2)`);
  // An animation inside the selection (a panel opening in it) moves its outline too: every frame.
  await f.evaluate((sel) => document.querySelector(sel).getAnimations().forEach((a) => a.cancel()), SECOND);
  await frames(f, 40);
  assert.ok((await perFrame()) < 0.3, "still again once the animation is gone");
  await f.evaluate((sel) => document.querySelector(sel).firstElementChild.animate([{ paddingTop: "0px" }, { paddingTop: "12px" }], { duration: 800, iterations: Infinity }), SECOND);
  await frames(f, 30);
  const inner = await perFrame();
  assert.ok(inner > 0.8 && inner < 1.2, `${inner.toFixed(2)} frames asked for per frame with an animation inside the selection`);
  await page.close();
});

test("an edit stays on its element when the page adds or removes the ones around it, and is sent under the selector it has then", async () => {
  const { page, f } = await open();
  const red = () => f.evaluate(() => [...document.querySelectorAll("#grid .tile")].filter((t) => getComputedStyle(t).backgroundColor === "rgb(255, 0, 0)").map((t) => t.textContent));
  const stamps = () => f.evaluate(() => document.querySelectorAll("[data-b42e]").length);
  const start = await pageState(f);
  // Selected first, then the page puts a tile in front of it, then the edit is typed.
  await clickAt(page, f, "#grid .tile:nth-of-type(2)");
  await f.evaluate(() => document.getElementById("grid").insertAdjacentHTML("afterbegin", '<div class="tile">0</div>'));
  await settle(f);
  await field(f, "css").fill("background: red;");
  await settle(f);
  assert.deepEqual(await red(), ["2"]);
  assert.equal(await selTag(f), "div.tile");
  // Typed, and then the page changes around it: one more in front, then the first two gone.
  await f.evaluate(() => document.getElementById("grid").insertAdjacentHTML("afterbegin", '<div class="tile">-1</div>'));
  await settle(f);
  assert.deepEqual(await red(), ["2"]);
  await f.evaluate(() => { const g = document.getElementById("grid"); g.firstElementChild.remove(); g.firstElementChild.remove(); });
  await settle(f);
  assert.deepEqual(await red(), ["2"]);
  // The page builds the grid anew, with one tile more in front: the edit is on the one in the old one's last place.
  await f.evaluate(() => { document.getElementById("grid").innerHTML = ["a", "b", "c", "d"].map((t) => `<div class="tile">${t}</div>`).join(""); });
  await settle(f);
  assert.deepEqual(await red(), ["b"]);
  // Sent under the selector the element has now.
  await f.evaluate(() => document.getElementById("grid").insertAdjacentHTML("afterbegin", '<div class="tile">z</div>'));
  await settle(f);
  assert.deepEqual(await red(), ["b"]);
  await clickAt(page, f, "#title");
  const n = await send(page);
  assert.deepEqual(n.edits.map((e) => [e.kind, e.selector]), [["style", "#grid > div.tile:nth-of-type(3)"]]);
  assert.equal(n.targets[0].selector, "#grid > div.tile:nth-of-type(3)");
  // The stamp is the only thing written to the page for a style edit, and it goes with the edit.
  assert.equal(await stamps(), 1);
  await page.waitForFunction(() => window.__harness.notes[0]?.status === "done");
  await f.waitForFunction(() => document.querySelectorAll("[data-b42e]").length === 0);
  await f.evaluate(() => { document.getElementById("grid").innerHTML = [1, 2, 3, 4, 5, 6].map((t) => `<div class="tile">${t}</div>`).join("\n    "); });
  // An unsent edit taken back with undo leaves nothing either, and redo finds its element again.
  await clickAt(page, f, "#grid .tile:nth-of-type(5)");
  await field(f, "css").fill("background: red;");
  await clickAt(page, f, "#title");
  assert.equal(await stamps(), 1);
  await page.keyboard.press(`${MOD}+z`);
  await settle(f);
  assert.deepEqual([await red(), await stamps()], [[], 0]);
  await f.evaluate(() => document.getElementById("grid").insertAdjacentHTML("afterbegin", '<div class="tile">0</div>'));
  await page.keyboard.press(`${MOD}+Shift+z`);
  await settle(f);
  assert.deepEqual(await red(), ["5"]);
  await page.keyboard.press(`${MOD}+z`);
  await settle(f);
  await f.evaluate(() => document.getElementById("grid").firstElementChild.remove());
  assert.deepEqual((await pageState(f)).rules, start.rules);
  assert.equal(await stamps(), 0);
  await page.close();
});

test("a move and a hide follow their elements too: the page adds a card in front, the order and the hidden one stay right", async () => {
  const { page, f } = await open();
  const b = await box(f, "#plans article:nth-of-type(1)");
  const c = await box(f, "#plans article:nth-of-type(3)");
  // "Free" goes to the end of its row; "Pro" is hidden.
  await drag(page, f, b.x + 100, b.y + 80, c.x + c.width + 30, c.y + 80);
  await clickAt(page, f, "#plans article:nth-of-type(2)", 100, 80);
  await page.keyboard.press("Delete");
  await settle(f);
  const seen = () => f.evaluate(() => [...document.querySelectorAll("#plans article")]
    .filter((a) => getComputedStyle(a).display !== "none")
    .sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left)
    .map((a) => a.querySelector("h3").textContent));
  assert.deepEqual(await seen(), ["Scale", "Free"]);
  // The page adds a card in front (the same nodes stay).
  await f.evaluate(() => {
    const a = document.querySelector("#plans article").cloneNode(true);
    a.removeAttribute("data-b42e");
    a.querySelector("h3").textContent = "Trial";
    document.getElementById("plans").prepend(a);
  });
  await settle(f);
  assert.deepEqual(await seen(), ["Trial", "Scale", "Free"]);
  await page.close();
});

// ── the layers, walked as in Figma ──────────────────────────────────────────────────────────
/** Where the selection's outline is, to tell one card from another. */
const selBox = (f) => ui(f, (r) => {
  const b = r.querySelector(".box.csel")?.getBoundingClientRect();
  return b ? { x: Math.round(b.x), y: Math.round(b.y) } : null;
});
const near = (f, sel) => f.evaluate((s) => {
  const b = document.querySelector(s).getBoundingClientRect();
  return { x: Math.round(b.x), y: Math.round(b.y) };
}, sel);

test("Enter goes into the selection and shift+Enter out of it, back in by the way out; on words it edits them; alone it never sends", async () => {
  const { page, f, errors } = await open();
  await clickAt(page, f, `${SECOND} h3`);
  await page.keyboard.press("Shift+Enter");
  assert.equal(await selTag(f), "article.card");
  await page.keyboard.press("Shift+Enter");
  assert.equal(await selTag(f), "section#plans.row");
  // in again: not to the first card but to the one the way out came through, and on to the heading
  await page.keyboard.press("Enter");
  assert.equal(await selTag(f), "article.card");
  assert.deepEqual(await selBox(f), await near(f, SECOND));
  await page.keyboard.press("Enter");
  assert.equal(await selTag(f), "h3");
  // the arrows are the same walk
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  assert.equal(await selTag(f), "h3");
  // no further in: the heading's words are edited, and Enter keeps them
  await page.keyboard.press("Enter");
  assert.equal(await f.evaluate((s) => document.querySelector(s).getAttribute("contenteditable"), `${SECOND} h3`), "plaintext-only");
  await page.keyboard.type("Team");
  await page.keyboard.press("Enter");
  await frames(f);
  assert.equal(await f.evaluate((s) => document.querySelector(s).outerHTML.replace(/ data-b42e="[a-z0-9]+"/, ""), `${SECOND} h3`), "<h3>Team</h3>");
  assert.equal(await count(f), "1 edit");
  // a selection made any other way forgets the way: in is the first child
  await act(f, { type: "select", id: await rowId(f, "#plans") });
  await frames(f);
  await page.keyboard.press("Enter");
  assert.deepEqual(await selBox(f), await near(f, "#plans article:nth-of-type(1)"));
  // the host's Enter outside a field is the same step
  await act(f, { type: "select", id: await rowId(f, "#grid") });
  await act(f, { type: "step" });
  assert.equal(await selTag(f), "div.tile");
  await act(f, { type: "step", out: true });
  assert.equal(await selTag(f), "section#grid.grid");
  // Enter alone sends nothing, with a selection or without: without, it says what does
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  assert.match(await said(f), /Enter goes into the selection: .*Enter sends/);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__harness.notes.length), 0);
  assert.equal(await f.evaluate(() => window.pageKeys), 0, "the page saw no keys");
  const n = await send(page);
  assert.deepEqual(n.edits.map((e) => [e.kind, e.from, e.to]), [["text", "Pro", "Team"]]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("text beside elements: the words around an image, a link or a line break are edited, each run its own edit; what is inside stays the same nodes", async () => {
  const { page, f, errors } = await open();
  const HTML = 'Hello world <img id="pic" alt="Logo" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="> and <a id="lnk" href="#x">docs</a>';
  await f.evaluate((html) => {
    const p = document.createElement("p");
    p.id = "mix";
    p.innerHTML = html;
    const q = document.createElement("p");
    q.id = "two";
    q.innerHTML = "line one<br>line two";
    document.querySelector("header").after(p, q);
    window.kept = [...p.childNodes, ...q.childNodes];
    window.same = () => [...p.childNodes, ...q.childNodes].every((n, i) => n === window.kept[i]) && p.childNodes.length + q.childNodes.length === window.kept.length;
  }, HTML);
  await frames(f);
  /** Double-click the words of one text node of an element. */
  const dblWords = async (sel, i) => {
    const r = await f.evaluate(([s, k]) => {
      const t = [...document.querySelector(s).childNodes].filter((n) => n.nodeType === 3)[k];
      const range = document.createRange();
      range.selectNodeContents(t);
      const b = [...range.getClientRects()].find((q) => q.width > 4);
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, [sel, i]);
    const fb = await (await f.frameElement()).boundingBox();
    await page.mouse.click(fb.x + r.x, fb.y + r.y);
    await page.mouse.click(fb.x + r.x, fb.y + r.y);
    await frames(f);
  };
  const html = (sel) => f.evaluate((s) => document.querySelector(s).innerHTML, sel);
  // the first run: what is inside is kept out of the typing while it goes on
  await dblWords("#mix", 0);
  assert.deepEqual(await f.evaluate(() => [document.getElementById("mix").getAttribute("contenteditable"), document.getElementById("pic").getAttribute("contenteditable"), getSelection().toString()]),
    ["plaintext-only", "false", "Hello world "]);
  await page.keyboard.type("Hi there");
  await page.keyboard.press("Enter");
  await frames(f);
  assert.equal(await html("#mix"), HTML.replace("Hello world", "Hi there"));
  assert.ok(await f.evaluate(() => window.same()), "the same nodes");
  // the run after the image; Backspace at its start would take the image: it stays, and it is said
  await dblWords("#mix", 1);
  assert.equal(await f.evaluate(() => getSelection().toString()), " and ");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  assert.ok(await f.evaluate(() => !!document.getElementById("pic")?.isConnected));
  assert.match(await said(f), /Only the words are edited here/);
  await page.keyboard.press("Escape");
  await frames(f);
  assert.equal(await html("#mix"), HTML.replace("Hello world", "Hi there"));
  await dblWords("#mix", 1);
  await page.keyboard.type("or the");
  await page.keyboard.press("Enter");
  await frames(f);
  assert.equal(await html("#mix"), HTML.replace("Hello world", "Hi there").replace(" and ", " or the "));
  // a line break is an element inside too
  await dblWords("#two", 1);
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await frames(f);
  assert.equal(await html("#two"), "line one<br>second");
  assert.ok(await f.evaluate(() => window.same() && !document.querySelector("[contenteditable]")), "the same nodes, and nothing left editable");
  assert.equal(await count(f), "3 edits");
  // undo, all the way: as it began
  for (let i = 0; i < 3; i++) await act(f, { type: "undo" });
  await frames(f);
  assert.deepEqual([await html("#mix"), await html("#two"), await f.evaluate(() => window.same())], [HTML, "line one<br>line two", true]);
  for (let i = 0; i < 3; i++) await act(f, { type: "redo" });
  await frames(f);
  // the note says which words: by the element beside them
  const n = await send(page);
  assert.deepEqual(n.edits.map(({ kind, selector, from, to, textBefore, textAfter }) => ({ kind, selector, from, to, textBefore, textAfter })), [
    { kind: "text", selector: "#mix", from: "Hello world", to: "Hi there", textBefore: "Image · Logo", textAfter: undefined },
    { kind: "text", selector: "#mix", from: "and", to: "or the", textBefore: undefined, textAfter: "Image · Logo" },
    { kind: "text", selector: "#two", from: "line two", to: "second", textBefore: undefined, textAfter: n.edits[2].textAfter },
  ]);
  assert.ok(n.edits[2].textAfter, "after the line break");
  assert.match(await page.evaluate(() => window.__harness.notes[0].prompt), /text "and" → "or the" \(its words after "Image · Logo"; what is inside it stays\)/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("mod+click selects what is under the pointer through whatever is in the way; again, the one behind it; the hover says which", async () => {
  const { page, f, errors } = await open();
  await f.evaluate(() => {
    const d = document.createElement("div");
    d.id = "deep";
    d.innerHTML = `<button id="ib" style="padding: 12px 16px"><span id="ico" style="pointer-events: none; display: inline-block; width: 20px; height: 20px">★</span> Save</button>
      <div id="cardx" style="position: relative; width: 240px; height: 60px; margin-top: 12px"><h4 id="hx" style="margin: 0">Title</h4><a id="cover" href="#x" style="position: absolute; inset: 0"></a></div>`;
    document.querySelector("header").after(d);
  });
  await frames(f);
  const at = async (sel) => {
    const b = await box(f, sel);
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const deep = async (x, y) => {
    await page.keyboard.down(MOD);
    await page.mouse.click(x, y);
    await page.keyboard.up(MOD);
    await frames(f);
  };
  // an icon the page keeps the pointer off: a click gets the button, mod+click the icon
  const ico = await at("#ico");
  await page.mouse.click(...ico);
  await frames(f);
  assert.equal(await selTag(f), "button#ib");
  await page.keyboard.press("Escape");
  await page.keyboard.down(MOD);
  await page.mouse.move(ico[0] + 1, ico[1] + 1);
  await frames(f, 3);
  const hov = await ui(f, (r) => {
    const b = r.querySelector(".box.hover")?.getBoundingClientRect();
    return b ? { x: Math.round(b.x), y: Math.round(b.y) } : null;
  });
  await page.keyboard.up(MOD);
  assert.deepEqual(hov, await near(f, "#ico"), "with the key held, the hover is what the click would select");
  await deep(...ico);
  assert.equal(await selTag(f), "span#ico");
  await deep(...ico);
  assert.equal(await selTag(f), "button#ib", "again: the one behind it");
  await deep(...ico);
  assert.equal(await selTag(f), "div#deep");
  await deep(...ico);
  assert.equal(await selTag(f), "span#ico", "and round again");
  // a link stretched over its card: what it covers
  const hx = await at("#hx");
  await page.mouse.click(...hx);
  await frames(f);
  assert.equal(await selTag(f), "a#cover");
  await deep(...hx);
  assert.equal(await selTag(f), "a#cover");
  await deep(...hx);
  assert.equal(await selTag(f), "h4#hx");
  await deep(...hx);
  assert.equal(await selTag(f), "div#cardx");
  // through the selection's own bands: a click on the gap beside a selected card changes nothing
  await clickAt(page, f, SECOND, 4, 4);
  assert.equal(await selTag(f), "article.card");
  const c = await box(f, SECOND);
  await page.mouse.move(c.x + c.width + 8, c.y + 30);
  await frames(f);
  await page.mouse.click(c.x + c.width + 8, c.y + 30);
  await frames(f);
  assert.equal(await selTag(f), "article.card");
  await deep(c.x + c.width + 8, c.y + 30);
  assert.equal(await selTag(f), "section#plans.row");
  assert.equal(await count(f), "No edits");
  assert.equal(await f.evaluate(() => window.pageClicks), 0, "the page saw no clicks");
  assert.deepEqual(errors, []);
  await page.close();
});
