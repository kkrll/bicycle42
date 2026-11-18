// Unit tests for src/canvas/number.js: the number at the caret in typed CSS, and a step of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { numberAt, numbers, step, stepSize } from "../src/canvas/number.js";

/** `text` with one `|` for the caret (or two, for a selection): the token there, as its text. */
const at = (marked, opts = {}) => {
  const a = marked.indexOf("|"), b = marked.indexOf("|", a + 1);
  const text = marked.replaceAll("|", "");
  const t = numberAt(text, a, { ...opts, ...(b > 0 ? { to: b - 1 } : {}) });
  return t ? text.slice(t.start, t.end) : null;
};
/** The text after one step of the number at the caret. */
const stepped = (marked, delta, opts) => {
  const text = marked.replace("|", "");
  const t = numberAt(text, marked.indexOf("|"), opts);
  return t ? text.slice(0, t.start) + step(t, delta) + text.slice(t.end) : null;
};

test("a number keeps its unit", () => {
  assert.deepEqual(numberAt("12px", 1), { start: 0, end: 4, value: 12, unit: "px" });
  assert.equal(stepped("1|2px", 1), "13px");
  assert.equal(stepped("1.5|rem", 0.1), "1.6rem");
  assert.equal(stepped("50|%", -10), "40%");
  assert.equal(stepped("40|0", 100), "500");
  assert.equal(stepped("2|s", 1), "3s");
});

test("negatives, bare decimals, and through zero", () => {
  assert.equal(stepped("-4|px", 1), "-3px");
  assert.equal(stepped("|-4px", -10), "-14px");
  assert.equal(stepped(".5|", 1), "1.5");
  assert.equal(stepped("-.5|em", 1), "0.5em");
  assert.equal(stepped("1|px", -1), "0px");
  assert.equal(stepped("0|px", -1), "-1px");
  assert.equal(stepped("-0.1|", 0.1), "0");
  assert.equal(stepped("+4|px", 1), "5px");
});

test("rounding: at most two decimals, no trailing zeros, no float noise", () => {
  assert.equal(stepped("0.1|", 0.2), "0.3");
  assert.equal(stepped("1.1|px", 0.1), "1.2px");
  assert.equal(stepped("0.7|", 0.1), "0.8");
  assert.equal(stepped("1.239|px", 0), "1.24px");
  assert.equal(stepped("1.999|px", 0.1), "2.1px");
  assert.equal(stepped("1.9|", 0.1), "2");
  assert.equal(stepped("17.6|px", -0.1), "17.5px");
});

test("the caret: inside the token or touching either edge, not a space away", () => {
  assert.equal(at("|12px"), "12px");
  assert.equal(at("1|2px"), "12px");
  assert.equal(at("12|px"), "12px");
  assert.equal(at("12px|"), "12px");
  assert.equal(at("12px |"), null);
  assert.equal(at("| 12px"), null);
  assert.equal(at("|12px|"), "12px", "the token selected");
  assert.equal(at("1|2p|x"), "12px");
});

test("several values: only the one at the caret", () => {
  assert.equal(at("8px| 12px"), "8px");
  assert.equal(at("8px |12px"), "12px");
  assert.equal(stepped("8px 1|2px", 1), "8px 13px");
  assert.equal(stepped("0 -4|px 8px", 1), "0 -3px 8px");
  assert.equal(at("|8px 12px|"), null, "a selection wider than one number is none");
  assert.equal(at("8px,|12px"), "12px");
  assert.equal(stepped("calc(100% - 8|px)", 1), "calc(100% - 9px)");
  assert.equal(stepped("translate(-4|px, 2px)", -1), "translate(-5px, 2px)");
  assert.equal(stepped("10px-4|px", 1), "10px-5px", "a minus after a unit is not a sign");
  assert.equal(stepped("16px/1|.5", 0.1), "16px/1.6");
});

test("first: the value's first number when the caret is on none", () => {
  assert.equal(at("solid |8px 12px", { first: true }), "8px");
  assert.equal(at("|8px 12px|", { first: true }), "8px");
  assert.equal(at("8px |12px", { first: true }), "12px");
  assert.equal(at("norm|al", { first: true }), null);
  assert.equal(at("#a0b|0c0", { first: true }), null);
});

test("not a number: colours, names, strings, urls, comments", () => {
  assert.equal(at("#a0b|0c0"), null);
  assert.equal(at("#12|3"), null);
  assert.equal(at("rgb(12|0, 0, 0)"), null);
  assert.equal(at("rgb(0 0 0 / 5|0%)"), null);
  assert.equal(at("oklch(7|0% 0.1 200)"), null);
  assert.equal(at("color-mix(in srgb, red 4|0%, blue)"), null);
  assert.equal(at("1px solid #11|1"), null);
  assert.equal(at("1|px solid #111"), "1px");
  assert.equal(at("linear-gradient(9|0deg, #000 10%, rgb(0, 0, 0) 50%)"), "90deg");
  assert.equal(at("linear-gradient(90deg, #000 10%, rgb(0, 0, 0) 5|0%)"), "50%");
  assert.equal(at("var(--space-2|)"), null);
  assert.equal(at("h|1"), null);
  assert.equal(at('"Inter 1|8", serif'), null);
  assert.equal(at("url(img-2|.png)"), null);
  assert.equal(at("/* 1|2px */ 4px"), null);
  assert.deepEqual(numbers("1px /* 2px */ 3px 'x 4' #555 rgb(6,7,8) 9%").map((t) => t.value), [1, 3, 9]);
});

test("element styles: only in a declaration's value", () => {
  const css = { context: "css" };
  assert.equal(at("width: 1|2px;", css), "12px");
  assert.equal(at("width: 12px|;", css), "12px");
  assert.equal(at("width: 12px;|", css), null);
  assert.equal(at("width:1|2px", css), "12px", "no space, no semicolon");
  assert.equal(at("margin: -4|px 8px", css), "-4px");
  assert.equal(at("width: 12px;\nheight: 3|0px", css), "30px");
  assert.equal(at("width: 12px\nheight: 3|0px", css), "30px", "a value ends with its line");
  assert.equal(at("width: 1|2px\nheight: 30px", css), "12px");
  assert.equal(at("a: 1px; b: 2|px", css), "2px");
  assert.equal(at("--step-2|: 4px", css), null, "a property name");
  assert.equal(at("--step-2: 4|px", css), "4px");
  assert.equal(at("h|1", css), null);
  assert.equal(at("12|px", css), null, "no property, no value");
  assert.equal(at("color: #a0b|0c0;", css), null);
  assert.equal(at("/* width: 1|2px; */", css), null);
  assert.equal(at("width: /* 1|0px */ 12px;", css), null);
  assert.equal(at("width: /* 10px */ 1|2px;", css), "12px");
  assert.equal(at("transition: opacity 1s,\n  transform 2|s;", css), "2s", "a value over two lines");
  assert.equal(at("&:nth-child(2|) { width: 12px; }", css), null, "a nested selector");
  assert.equal(at("& > h|2 { width: 12px; }", css), null);
  assert.equal(at("&:nth-child(2) { width: 1|2px; }", css), "12px");
  assert.equal(at("@media (min-width: 60|0px) { width: 12px; }", css), null, "an at-rule's head");
  assert.equal(at("width: 1|2px; height: 30p|x", css), null, "a selection over two declarations");
  assert.equal(stepped("padding: 20px 4|0px;\ncolor: red;", 10, css), "padding: 20px 50px;\ncolor: red;");
});

test("the stylesheet: in a rule's declarations, never in a selector or outside a rule", () => {
  const sheet = { context: "sheet" };
  assert.equal(at(".a { width: 1|2px }", sheet), "12px");
  assert.equal(at(".a {\n  width: 12px;\n  margin: 0 1|6px;\n}", sheet), "16px");
  assert.equal(at("h|1 { width: 12px }", sheet), null);
  assert.equal(at(".col-1|2 { width: 12px }", sheet), null);
  assert.equal(at("li:nth-child(2|) { width: 12px }", sheet), null);
  assert.equal(at("li:nth-child(2|)", sheet), null, "a selector still being typed");
  assert.equal(at("width: 1|2px;", sheet), null, "outside a rule");
  assert.equal(at(".a { width: 12px }\nh|2 { }", sheet), null);
  assert.equal(at("@media (min-width: 60|0px) {\n  .a { width: 12px }\n}", sheet), null);
  assert.equal(at("@media (min-width: 600px) {\n  .a { width: 1|2px }\n}", sheet), "12px");
  assert.equal(at("@media (min-width: 600px) {\n  .col-1|2 { width: 12px }\n}", sheet), null);
  assert.equal(at("/* .a { width: 1|2px } */", sheet), null);
  assert.equal(at(".a { color: #12|3 }", sheet), null);
});

test("stepSize: 1; shift 10; alt 0.1; ctrl or ⌘ 100", () => {
  assert.equal(stepSize({}), 1);
  assert.equal(stepSize({ shift: true }), 10);
  assert.equal(stepSize({ alt: true }), 0.1);
  assert.equal(stepSize({ mod: true }), 100);
  assert.equal(stepSize({ mod: true, shift: true }), 100);
});
