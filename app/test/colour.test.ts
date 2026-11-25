// The picker's colour maths (src/renderer/colour.ts): sRGB to OKLCH and back, what sRGB can show,
// and a colour written in each notation.
//
//   node scripts/build.mjs --tests && node --test dist/test/colour.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { NOTATIONS, contrast, fromOklch, inSrgb, intoSrgb, maxChroma, notationOf, toOklch, write, type Rgb } from "../src/renderer/colour"

const rgb = (hex: string): Rgb => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 })

test("a colour goes to OKLCH and comes back the same hex", () => {
  for (const hex of ["#b1a79f", "#99afb0", "#767584", "#000000", "#ffffff", "#ff0000", "#3b4d22", "#fffaa0"]) assert.equal(write("hex", toOklch(rgb(hex))), hex)
})

test("known colours have their OKLCH numbers; a grey has no chroma", () => {
  const red = toOklch(rgb("#ff0000"))
  assert.ok(Math.abs(red.l - 0.628) < 0.001 && Math.abs(red.c - 0.2577) < 0.001 && Math.abs(red.h - 29.23) < 0.05, JSON.stringify(red))
  assert.deepEqual(toOklch(rgb("#808080")).c, 0)
  assert.ok(Math.abs(toOklch(rgb("#ffffff")).l - 1) < 1e-6)
})

test("what sRGB can't show is brought in by its chroma alone: the lightness and the hue stay", () => {
  const o = { l: 0.7, c: 0.35, h: 145 }
  assert.equal(inSrgb(fromOklch(o)), false)
  const back = toOklch(intoSrgb(o))
  assert.ok(Math.abs(back.l - o.l) < 0.01 && Math.abs(back.h - o.h) < 1 && back.c < o.c, JSON.stringify(back))
  assert.ok(Math.abs(back.c - maxChroma(o.l, o.h)) < 0.003)
})

test("each notation says the colour; the alpha only when it is not 1", () => {
  const o = toOklch(rgb("#b1a79f"))
  assert.equal(write("rgb", o), "rgb(177 167 159)")
  assert.equal(write("hex", o, 0.5), "#b1a79f80")
  assert.match(write("hsl", o), /^hsl\(26\.7 10\.3% 65\.9%\)$/)
  assert.match(write("hwb", o), /^hwb\(26\.7 62\.4% 30\.6%\)$/)
  assert.match(write("oklch", o, 0.25), /^oklch\(0\.73\d? 0\.01\d* \d+(\.\d)? \/ 0\.25\)$/)
  for (const n of NOTATIONS) assert.equal(notationOf(write(n, o)), n)
  assert.equal(notationOf("rebeccapurple"), "hex")
})

test("contrast is WCAG's: black on white is 21", () => {
  assert.ok(Math.abs(contrast(rgb("#000000"), rgb("#ffffff")) - 21) < 1e-9)
})
