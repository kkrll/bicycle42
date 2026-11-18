// The generated CSS property list (src/canvas/css-data.js, from scripts/css-data.mjs). Run: bun run test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CSS_PROPS } from "../src/canvas/css-data.js";

const names = Object.keys(CSS_PROPS);
const has = (prop, ...values) => {
  for (const v of values) assert.ok(CSS_PROPS[prop]?.v.includes(v), `${prop} should include ${v}`);
};

test("the list has more than 600 properties", () => {
  assert.ok(names.length > 600, `only ${names.length}`);
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
