// A phone's frame (src/renderer/phone.ts) and the phones' figures (PHONES in src/shared/types.ts):
// the strips and the page's box add up, the page's corners stay inside the screen's, and the ink
// on a strip reads.
//
//   node scripts/build.mjs --tests && node --test dist/test/phone.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { frameOf, inkOn } from "../src/renderer/phone"
import { PHONES, viewportOf, viewRadius, type Phone } from "../src/shared/types"

test("every phone has its browser's strips: an island's 59 to 68 above and 34 below, a notch's 47, the SE's 20 and nothing below, an Android's 24 to 32 and a gesture bar", () => {
  for (const p of PHONES) {
    if (p.cutout === "island") assert.ok(p.top >= 59 && p.top <= 68 && p.bottom === 34 && p.home, p.name)
    else if (p.cutout === "notch") assert.ok(p.top === 47 && p.bottom === 34 && p.home, p.name)
    else if (p.cutout === "none") assert.ok(p.top === 20 && p.bottom === 0 && !p.home && p.radius === 0, p.name)
    else assert.ok(p.top >= 24 && p.top <= 32 && p.bottom >= 16 && p.bottom <= 24 && p.home, p.name)
    assert.deepEqual(viewportOf(p), { width: p.width, height: p.height - p.top - p.bottom })
  }
})

/** Whether (x, y) is on the screen of a phone drawn W by H with corners of radius R (a hair of
 *  rounding's leeway). */
function onScreen(x: number, y: number, W: number, H: number, R: number) {
  if (x < -1e-6 || y < -1e-6 || x > W + 1e-6 || y > H + 1e-6) return false
  const cx = x < R ? R : x > W - R ? W - R : x
  const cy = y < R ? R : y > H - R ? H - R : y
  return Math.hypot(x - cx, y - cy) <= R + 1e-6
}
/** Points around the outline of the page's box between the strips, its corners rounded by `rv`. */
function outline(p: Phone, rv: number) {
  const [x0, x1, y0, y1] = [0, p.width, p.top, p.height - p.bottom]
  const points: [number, number][] = []
  const corners: [number, number, number][] = [
    [x0 + rv, y0 + rv, Math.PI],
    [x1 - rv, y0 + rv, 1.5 * Math.PI],
    [x1 - rv, y1 - rv, 0],
    [x0 + rv, y1 - rv, 0.5 * Math.PI],
  ]
  for (const [cx, cy, from] of corners) for (let i = 0; i <= 32; i++) points.push([cx + rv * Math.cos(from + (i / 32) * (Math.PI / 2)), cy + rv * Math.sin(from + (i / 32) * (Math.PI / 2))])
  const along = (a: number, b: number, i: number) => a + rv + ((b - a - 2 * rv) * i) / 64
  for (let i = 0; i <= 64; i++) points.push([x0, along(y0, y1, i)], [x1, along(y0, y1, i)], [along(x0, x1, i), y0], [along(x0, x1, i), y1])
  return points
}

test("the page's box stays inside the screen's rounded corners, which square it would not where a strip is less tall than a corner is round", () => {
  for (const p of PHONES) {
    const out = outline(p, viewRadius(p)).filter(([x, y]) => !onScreen(x, y, p.width, p.height, p.radius))
    assert.deepEqual(out, [], `${p.name}: rounded ${viewRadius(p)}`)
    // No rounder than it has to be: 2 px over what the shorter strip leaves of the corner.
    assert.ok(viewRadius(p) <= Math.max(0, p.radius - Math.min(p.top, p.bottom) + 2), p.name)
  }
  // Why it is rounded at all: an iPhone's square page reaches past the screen's corners below.
  const iphone = PHONES.find((p) => p.cutout === "island")!
  assert.ok(outline(iphone, 0).some(([x, y]) => !onScreen(x, y, iphone.width, iphone.height, iphone.radius)))
})

test("the frame adds up to the body at any size: strips and the page's box on whole pixels, the box the viewport at the page's scale", () => {
  for (const p of PHONES)
    for (const fit of [1, 0.94, 0.8, 0.737, 0.5, 0.3]) {
      const f = frameOf(p, fit)
      const at = `${p.name} at ${fit}`
      assert.ok([f.width, f.height, f.top, f.screen, f.bottom].every(Number.isInteger), at)
      assert.equal(f.top + f.screen + f.bottom, f.height, at)
      assert.equal(f.scale, f.width / p.width, at)
      assert.ok(Math.abs(f.screen - viewportOf(p).height * f.scale) <= 0.5, at)
      assert.ok(Math.abs(f.top - p.top * f.scale) <= 1 && Math.abs(f.bottom - p.bottom * f.scale) <= 1.5, at)
    }
  assert.deepEqual(frameOf(PHONES.find((p) => p.id === "iphone-18-pro-max")!, 1), { width: 440, height: 956, top: 62, screen: 860, bottom: 34, scale: 1, radius: 62 })
})

test("a strip's time and icons are black or white, whichever reads on its colour", () => {
  assert.equal(inkOn("#000000"), "#ffffff")
  assert.equal(inkOn("#ffffff"), "#000000")
  assert.equal(inkOn("#121212"), "#ffffff")
  assert.equal(inkOn("#fffaa0"), "#000000") // the app's light accent
  assert.equal(inkOn("#3b4d22"), "#ffffff") // its dark one
  assert.equal(inkOn("#0a84ff"), "#000000") // a mid blue: black reads better (5.0 against 4.2)
  assert.equal(inkOn("not a colour"), "#ffffff")
})
