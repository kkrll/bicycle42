// The inspector's suggestions, the pure part (src/canvas/suggest-model.js): what is at the caret,
// what matches, in what order. No browser. Run: bun run test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CSS_PROPS } from "../src/canvas/css-data.js";
import { alone, caretContext, COLOURS, isNumber, matches, propNames, step, valueContext, valuesAt, valuesOf, wants, WIDE } from "../src/canvas/suggest-model.js";

/** The context at `|` in `src`. */
const at = (src, sheet = false) => {
  const caret = src.indexOf("|");
  return caretContext(src.replace("|", ""), caret, sheet);
};
const kind = (src, sheet) => at(src, sheet).kind;
/** A browser that takes every keyword, and a colour where one goes. */
const all = (p, v) => (v !== "red" && v !== "#f00") || /color|^background$|^border$/.test(p);

test("element styles: a name before the colon, a value after it", () => {
  assert.deepEqual(at("al|"), { kind: "name", word: "al", s: 0, e: 2, colon: false });
  assert.deepEqual(at("color: red;\n  al|"), { kind: "name", word: "al", s: 14, e: 16, colon: false });
  assert.deepEqual(at("align-items: c|"), { kind: "value", prop: "align-items", word: "c", s: 13, e: 14, first: true });
  assert.deepEqual(at("align-items:|"), { kind: "value", prop: "align-items", word: "", s: 12, e: 12, first: true });
  assert.equal(at("|").kind, "name");
  assert.equal(at("color: red;|").kind, "name");
});

test("the token is the whole word at the caret; the typed part ends at the caret", () => {
  const c = at("align-items: cen|ter; color: red");
  assert.deepEqual([c.kind, c.word, c.s, c.e], ["value", "cen", 13, 19]);
  const n = at("ali|gn-items: center");
  assert.deepEqual([n.kind, n.word, n.s, n.e, n.colon], ["name", "ali", 0, 11, true]);
  assert.equal(at("ALIGN-items: CEN|").word, "cen");
  assert.equal(at("ALIGN-items: CEN|").prop, "align-items");
});

test("a value of several tokens: only the one at the caret, and whether it is the first", () => {
  const c = at("margin: 0 au|");
  assert.deepEqual([c.kind, c.prop, c.word, c.s, c.e, c.first], ["value", "margin", "au", 10, 12, false]);
  const d = at("border: 1px so|lid red");
  assert.deepEqual([d.word, d.s, d.e], ["so", 12, 17]);
  assert.equal(at("transition: color 1s, op|").word, "op");
});

test("nothing to complete: comments, strings, brackets, custom properties, !important", () => {
  assert.equal(kind("/* al| */"), "none");
  assert.equal(kind("/* never closed al|"), "none");
  assert.equal(kind('content: "al|"'), "none");
  assert.equal(kind("width: calc(100% - a|)"), "none");
  assert.equal(kind("color: var(--a|"), "none");
  assert.equal(kind("--my-col|"), "none");
  assert.equal(kind("--x: re|"), "none");
  assert.equal(kind("color: red !imp|"), "none");
  assert.equal(kind("two words|"), "none");
  assert.equal(kind("color: red; /* why */ al|"), "name");
  assert.equal(at("/* first */ al|").s, 12);
});

test("element styles nest rules: their heads are selectors, their bodies declarations", () => {
  assert.equal(kind("&:hov|"), "selector");
  assert.equal(kind(".on|"), "selector");
  assert.equal(kind("@media (min-wid|"), "none"); // inside brackets
  assert.equal(kind("@med|"), "selector");
  assert.equal(kind("sp|an { color: red }"), "selector");
  assert.equal(kind("a:hov|er { color: red }"), "selector");
  assert.deepEqual([at("&:hover { col| }").kind, at("&:hover { col| }").word], ["name", "col"]);
  assert.equal(at("&:hover { color: r| }").prop, "color");
  assert.equal(kind("&:hover { color: red } al|"), "name");
  assert.equal(kind("@media (min-width: 600px) { al|"), "name");
  // A declaration without its semicolon, above a nested rule: still a declaration.
  assert.equal(kind("color: re|\n&:hover { }"), "value");
});

test("a declaration without its semicolon: the next line is a new one, as number.js has it", () => {
  assert.deepEqual(at("color: red\nal|"), { kind: "name", word: "al", s: 11, e: 13, colon: false });
  assert.deepEqual(at("color: red\n  al|ign-items: center"), { kind: "name", word: "al", s: 13, e: 24, colon: true });
  const v = at("color: red\nwidth: a|");
  assert.deepEqual([v.kind, v.prop, v.word, v.first], ["value", "width", "a", true]);
  assert.equal(at(".a { color: red\n  al|", true).kind, "name");
  // A value goes on over a line only after a comma, the colon or an open bracket.
  assert.deepEqual([at("transition: color 1s,\n  op|").kind, at("transition: color 1s,\n  op|").prop], ["value", "transition"]);
  assert.deepEqual([at("transition: color 1s,\n  opacity 2s,\n  tr|").prop, at("transition: color 1s,\n  opacity 2s,\n  tr|").first], ["transition", false]);
  assert.deepEqual([at("color:\n  re|").kind, at("color:\n  re|").prop, at("color:\n  re|").first], ["value", "color", true]);
  assert.equal(kind("color: red\ntwo words|"), "none");
  assert.equal(kind("color: red\n&:hov|"), "selector");
  assert.equal(kind("color: red\nsp|an { }"), "selector");
});

test("a stylesheet: never inside a selector", () => {
  assert.equal(kind("al|", true), "selector");
  assert.equal(kind(".card:hov|", true), "selector");
  assert.equal(kind(".a { color: red } .b|", true), "selector");
  assert.equal(kind(".card { al|", true), "name");
  assert.equal(at(".card { align-items: c| }", true).prop, "align-items");
  assert.equal(kind("@media (min-width: 600px) { .car|", true), "selector");
  assert.equal(kind("@media (min-width: 600px) { .card { al|", true), "name");
  assert.equal(kind(".card { &:hov|", true), "selector");
  assert.equal(kind(".card { &:hover { al|", true), "name");
  assert.equal(kind("@keyframes spin { fr|", true), "selector");
  assert.equal(kind("@keyframes spin { from { tr|", true), "name");
  assert.equal(kind("@font-face { font-fam|", true), "none");
  assert.equal(kind("@font-face { src: u|", true), "none");
  assert.equal(kind(".a { color: red; } /* x */ .b { c|", true), "name");
});

test("a field with one value (a computed row)", () => {
  assert.deepEqual(valueContext("align-items", "center", 6), { kind: "value", prop: "align-items", word: "center", s: 0, e: 6, first: true });
  assert.deepEqual(valueContext("align-items", "center", 2), { kind: "value", prop: "align-items", word: "ce", s: 0, e: 6, first: true });
  assert.deepEqual(valueContext("align-items", "", 0), { kind: "value", prop: "align-items", word: "", s: 0, e: 0, first: true });
  const c = valueContext("padding", "20px auto", 9);
  assert.deepEqual([c.word, c.s, c.e, c.first], ["auto", 5, 9, false]);
  assert.equal(valueContext("color", "rgb(0 0 0)", 5).kind, "none");
  assert.equal(valueContext("font-family", '"Inter", sans', 4).kind, "none");
  assert.equal(valueContext("font-family", '"Inter", sans', 13).word, "sans");
  assert.equal(valueContext("color", "red; top: 0", 11).kind, "none");
});

test("when a list opens: on a name being typed, after the colon, never on a number", () => {
  assert.equal(wants(at("al|"), false), true);
  assert.equal(wants(at("|"), false), false);
  assert.equal(wants(at("|"), true), true);
  assert.equal(wants(at("color:|"), false), true);
  assert.equal(wants(at("color: |"), false), true);
  assert.equal(wants(at("margin: 0 |"), false), false);
  assert.equal(wants(at("margin: 0 |"), true), true);
  assert.equal(wants(at("margin: 0 a|"), false), true);
  assert.equal(wants(at("width: 12|"), false), false);
  assert.equal(wants(at("width: 12p|"), true), false);
  assert.equal(wants(at("margin: -4|"), false), false);
  assert.equal(wants(at("color: #ff|"), false), false);
  assert.equal(wants(at("margin: -|"), false), true);
  assert.equal(wants(at(".a|"), false), false);
  assert.equal(wants(at("/* a| */"), true), false);
  assert.ok(isNumber("12px") && isNumber("-.5em") && isNumber("+3") && !isNumber("center") && !isNumber("-moz"));
});

test("matching: what starts with the typed word, then what contains it, in the order given", () => {
  const items = ["flex-start", "center", "start", "end", "self-start"];
  assert.deepEqual(matches(items, "st"), ["start", "flex-start", "self-start"]);
  assert.deepEqual(matches(items, "ST"), ["start", "flex-start", "self-start"]);
  assert.deepEqual(matches(items, ""), items);
  assert.notEqual(matches(items, ""), items);
  assert.deepEqual(matches(items, "zz"), []);
  assert.deepEqual(matches(items, "e"), ["end", "flex-start", "center", "self-start"]);
});

test("property names: by weight, then by the alphabet", () => {
  const props = { b: { v: [], w: 1 }, a: { v: [], w: 1 }, z: { v: [], w: 9 }, c: { v: [], w: 0 } };
  assert.deepEqual(propNames(props), ["z", "a", "b", "c"]);
  const names = propNames(CSS_PROPS);
  assert.equal(names.length, Object.keys(CSS_PROPS).length);
  assert.equal(matches(names, "al")[0], "align-items");
  assert.deepEqual(matches(names, "al").slice(0, 3), ["align-items", "align-content", "align-self"]);
  // What starts with the word comes before a more popular name that only contains it.
  const col = matches(names, "col");
  assert.equal(col[0], "color");
  assert.ok(col.indexOf("column-gap") < col.indexOf("background-color"), col.slice(0, 8).join());
  for (let i = 1; i < names.length; i++) assert.ok(CSS_PROPS[names[i - 1]].w >= CSS_PROPS[names[i]].w);
});

test("a property's values: its own as given, auto and none where taken, the CSS-wide ones", () => {
  const props = { "align-items": { v: ["normal", "center", "start"], w: 1 }, display: { v: ["block", "none"], w: 1 }, gap: { v: [], w: 0 } };
  const takes = (p, v) => all(p, v) && !(p === "align-items" && (v === "auto" || v === "none")) && !(p === "gap" && v === "none");
  assert.deepEqual(valuesOf("align-items", props, takes), ["normal", "center", "start", ...WIDE]);
  assert.deepEqual(valuesOf("display", props, all), ["block", "none", "auto", ...WIDE]); // none is listed once, where the data has it
  assert.deepEqual(valuesOf("gap", props, takes), ["auto", ...WIDE]);
  assert.deepEqual(valuesOf("not-there", props, all), ["auto", "none", ...WIDE]);
  assert.deepEqual(valuesOf("not-there", props, () => false), []);
  // What the browser does not take is left out, wherever it came from.
  assert.deepEqual(valuesOf("align-items", props, (p, v) => all(p, v) && v !== "center" && v !== "revert" && v !== "auto" && v !== "none"), ["normal", "start", "inherit", "initial", "unset"]);
  const real = valuesOf("align-items", CSS_PROPS, all);
  assert.ok(real.indexOf("center") < real.indexOf("start") && real.indexOf("start") < real.indexOf("inherit"), real.join());
  assert.equal(matches(real, "c")[0], "center");
});

test("the named colours, wherever a colour goes: after the property's own keywords, before the CSS-wide ones", () => {
  assert.equal(COLOURS.length, 149);
  assert.equal(new Set(COLOURS).size, 149);
  for (const c of ["red", "rebeccapurple", "gray", "grey", "aliceblue", "yellowgreen", "transparent"]) assert.ok(COLOURS.includes(c), c);
  assert.ok(COLOURS.every((c) => /^[a-z]+$/.test(c)));
  const color = valuesOf("color", CSS_PROPS, all);
  assert.deepEqual(color.slice(0, 2), ["currentcolor", "black"], "its own first");
  assert.deepEqual(color.slice(-4), WIDE);
  assert.equal(color.filter((v) => v === "black").length, 1);
  assert.equal(color.length, new Set([...CSS_PROPS.color.v, ...COLOURS, ...WIDE, "auto", "none"]).size);
  assert.deepEqual(matches(color, "re").slice(0, 3), ["rebeccapurple", "red", "revert"]);
  assert.deepEqual(matches(color, "red"), ["red", "darkred", "indianred", "mediumvioletred", "orangered", "palevioletred"]);
  // A shorthand that takes a colour has them after its own.
  const border = valuesOf("border", CSS_PROPS, all);
  assert.ok(border.includes("tomato") && border.indexOf("solid") < border.indexOf("aliceblue"), border.slice(0, 20).join());
  // Not where `red` is only a name (a font's, an animation's): there `#f00` is nothing.
  const names = (p, v) => v !== "#f00";
  assert.ok(!valuesOf("font-family", CSS_PROPS, names).includes("red"));
  assert.ok(!valuesOf("align-items", CSS_PROPS, all).includes("red"));
});

test("the CSS-wide keywords stand alone: not offered beside another token", () => {
  const ctx = (src) => [src.replace("|", ""), at(src)];
  assert.equal(alone(...ctx("margin: au|to")), true);
  assert.equal(alone(...ctx("margin: au|to;\ncolor: red")), true);
  assert.equal(alone(...ctx("margin: au|to\ncolor: red")), true);
  assert.equal(alone(...ctx("margin: auto| !important;")), true);
  assert.equal(alone(...ctx(".a { margin: au|to }")), true);
  assert.equal(alone(...ctx("margin: 0 au|to")), false);
  assert.equal(alone(...ctx("margin: au|to 0")), false);
  assert.equal(alone(...ctx("transition: al|l 1s,\n  color 2s")), false);
  assert.equal(alone("auto", valueContext("margin", "auto", 2)), true);
  assert.equal(alone("0 auto", valueContext("margin", "0 auto", 6)), false);
  const margin = valuesOf("margin", CSS_PROPS, (p, v) => v !== "none" && all(p, v));
  assert.deepEqual(margin, ["auto", ...WIDE]);
  assert.deepEqual(valuesAt(margin, ...ctx("margin: au|to")), margin);
  assert.deepEqual(valuesAt(margin, ...ctx("margin: 0 au|to")), ["auto"]);
  // ↑/↓ on the `auto` of `0 auto` has nowhere to go: never `0 revert`, never `0 inherit`.
  assert.equal(step(valuesAt(margin, ...ctx("margin: 0 au|to")), "auto", -1), "auto");
  assert.equal(step(valuesAt(margin, ...ctx("margin: 0 au|to")), "auto", 1), "auto");
  assert.equal(step(valuesAt(margin, ...ctx("margin: au|to")), "auto", -1), "revert");
});

test("stepping through a property's keywords", () => {
  const v = valuesOf("align-items", CSS_PROPS, (p, k) => k !== "auto" && k !== "none");
  assert.equal(step(v, "center", 1), "start");
  assert.equal(step(v, "start", -1), "center");
  assert.equal(step(v, "CENTER", 1), "start");
  assert.equal(step(v, v[0], -1), v[v.length - 1]);
  assert.equal(step(v, v[v.length - 1], 1), v[0]);
  assert.equal(step(v, "12px", 1), null);
  assert.equal(step([], "center", 1), null);
});

test("a { in a comment or a string after the caret opens nothing (review: DeepSeek 2)", () => {
  assert.deepEqual([at("align-items: st| /* { */").kind, at("align-items: st| /* { */").word], ["value", "st"]);
  assert.equal(at('content: |"a { b"').kind, "value");
  assert.equal(at('font-family: st|, "a { b"').kind, "value");
  // a real one still makes it a rule's head
  assert.equal(at("li:hover| {").kind, "selector");
});
