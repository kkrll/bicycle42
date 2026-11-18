// The generated CSS property list (src/canvas/css-data.js, from scripts/css-data.mjs). Run: bun run test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CSS_PROPS } from "../src/canvas/css-data.js";
import { enough, merge, MIN_PROPS } from "../scripts/css-data.mjs";

const names = Object.keys(CSS_PROPS);
const has = (prop, ...values) => {
  for (const v of values) assert.ok(CSS_PROPS[prop]?.v.includes(v), `${prop} should include ${v}`);
};

test("the list has Chrome's properties, some 600 of them", () => {
  assert.ok(names.length >= MIN_PROPS, `only ${names.length}`);
  assert.equal(enough(CSS_PROPS), names.length);
});

test("no descriptors (src, syntax, unicode-range…): they are not properties", () => {
  const descriptors = ["src", "syntax", "inherits", "initial-value", "unicode-range", "system", "pad", "range", "fallback", "font-display", "symbols", "size-adjust"];
  assert.deepEqual(names.filter((n) => descriptors.includes(n)), []);
  // What is both (a descriptor of @font-face or @page, and a property) stays.
  for (const p of ["font-family", "font-weight", "size", "scrollbar-color"]) assert.ok(p in CSS_PROPS, p);
  assert.deepEqual(names.filter((n) => n.startsWith("-")), []);
});

// ── the generator, on a source laid out as Blink's is not ──────────────────────────────────
const META = `const extraPropertyValues = new Map<string, Set<string>>([
  ['align-items', new Set(['center', '-webkit-box'])],
]);
const Weight = new Map([['width', 300], ['color', 200]]);`;
const blink = (data, after = "") => `{
  parameters: { name: { valid_type: "str" }, keywords: { valid_type: "list" } },
  data: [${data}],${after}
}`;

test("the generator reads a block whatever its indentation, its first key or its comments", () => {
  const out = merge(blink(`
{ name: "width", keywords: ["auto", "fit-content"] },
        {
          // A comment before the name, with a brace } and a "name: " in it.
          field_group: "*",
          logical_property_group: {
            name: "inset",
            resolver: "top",
          },
          name: "top",
          typedom_keywords: ["no"],
          keywords: ["auto",
                     "-webkit-nope"], /* and one after */
        },
    {
      keywords: ["a", "b", "c"],
      devtools_keywords: ["a", "b"],
      name: "color",
    },
    { name: "src", is_descriptor: true, is_property: false },
    { name: "size", is_descriptor: true, keywords: ["auto"] },
    { name: "-internal-thing" }, { name: "-alternative-thing", keywords: ["x"] },
`), META);
  assert.deepEqual(out, {
    "align-items": { v: ["center"], w: 0 },
    color: { v: ["a", "b"], w: 200 }, // (devtools_keywords is Blink's override of keywords)
    size: { v: ["auto"], w: 0 },
    top: { v: ["auto"], w: 0 },
    width: { v: ["auto", "fit-content"], w: 300 },
  });
});

test("the generator fails, and says so, on a source it does not understand", () => {
  // A property that is not in a block of data: it would be dropped without a word.
  assert.throws(() => merge(blink(`{ name: "width" },`, `\n  more: [\n    {\n      name: "height",\n    },\n  ],`), META), /"name:" lines/);
  assert.throws(() => merge(blink(`{ keywords: ["auto"] },`), META), /0 names/);
  assert.throws(() => merge(blink(`{ name: "width", name: "height" },`), META), /2 names/);
  assert.throws(() => merge(`{ properties: [] }`, META), /no "data: \["/);
  assert.throws(() => merge(`{ data: [ { name: "width" },`, META), /never closes/);
  assert.throws(() => merge(blink(`"width",`), META), /not an object/);
  // …and on a list that has lost more than a twentieth of its 600.
  const some = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { v: [], w: 0 }]));
  assert.throws(() => enough(some(MIN_PROPS - 1)), /only 569 properties/);
  assert.equal(enough(some(MIN_PROPS)), 570);
});

test("alignment and display keywords are there", () => {
  has("align-items", "center", "start", "end", "stretch", "baseline");
  has("display", "flex", "grid", "none", "contents", "inline-flex");
});

test("no -webkit- keys or values", () => {
  assert.deepEqual(names.filter((n) => n.startsWith("-webkit-")), []);
  for (const [k, p] of Object.entries(CSS_PROPS)) {
    assert.deepEqual(p.v.filter((v) => v.startsWith("-webkit-")), [], k);
  }
});

test("every weight is a number >= 0, and values are unique", () => {
  for (const [k, p] of Object.entries(CSS_PROPS)) {
    assert.ok(typeof p.w === "number" && p.w >= 0, `${k}: ${p.w}`);
    assert.equal(new Set(p.v).size, p.v.length, `${k} has duplicate values`);
  }
});

test("width and margin are among the 5 most popular properties", () => {
  const top = [...names].sort((a, b) => CSS_PROPS[b].w - CSS_PROPS[a].w).slice(0, 5);
  assert.ok(top.includes("width") && top.includes("margin"), top.join(", "));
});
