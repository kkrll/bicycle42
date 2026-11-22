// A phone's frame (src/renderer/phone.ts) and the phones' figures (PHONES in src/shared/types.ts):
// the status strip and the page's box add up, the page's box is square and only its bottom
// corners are past the screen's (the overlay draws them, phoneEdge), and the ink on the strip reads.
//
//   node scripts/build.mjs --tests && node --test dist/test/phone.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { frameOf, inkOn } from "../src/renderer/phone"
import { PHONES, phoneEdge, viewportOf, type Phone } from "../src/shared/types"

test("every phone has its browser's status bar (an island's 59 to 68, a notch's 47, the SE's 20, an Android's 24 to 32) and its home indicator's strip below, which the page runs under", () => {
  for (const p of PHONES) {
    if (p.cutout === "island") assert.ok(p.top >= 59 && p.top <= 68 && p.bottom === 34 && p.home, p.name)
    else if (p.cutout === "notch") assert.ok(p.top === 47 && p.bottom === 34 && p.home, p.name)
    else if (p.cutout === "none") assert.ok(p.top === 20 && p.bottom === 0 && !p.home && p.radius === 0, p.name)
    else assert.ok(p.top >= 24 && p.top <= 32 && p.bottom >= 16 && p.bottom <= 24 && p.home, p.name)
    // As in iOS 26's Safari: the page runs to the screen's bottom edge, under the home indicator.
    assert.deepEqual(viewportOf(p), { width: p.width, height: p.height - p.top })
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
/** Points around the outline of the page's box, square, from under the status bar to the screen's bottom edge. */
function outline(p: Phone) {
  const [x0, x1, y0, y1] = [0, p.width, p.top, p.height]
  const points: [number, number][] = []
  for (let i = 0; i <= 256; i++) {
    const t = i / 256
    points.push([x0, y0 + (y1 - y0) * t], [x1, y0 + (y1 - y0) * t], [x0 + (x1 - x0) * t, y0], [x0 + (x1 - x0) * t, y1])
  }
  return points
}

test("the page's box is square: its top corners are inside the screen (every status bar is as tall as its corners are round), and only its bottom corners reach past the screen's, where the overlay draws them", () => {
  for (const p of PHONES) {
    assert.ok(p.top >= p.radius, `${p.name}: a status bar of ${p.top} under corners of ${p.radius}`)
    const out = outline(p).filter(([x, y]) => !onScreen(x, y, p.width, p.height, p.radius))
    // What is past the screen is in the two squares of its bottom corners, the radius on a side:
    // there the overlay draws what the window has outside the screen (phoneEdge's corners).
    assert.ok(out.every(([x, y]) => y >= p.height - p.radius && (x <= p.radius || x >= p.width - p.radius)), `${p.name}: ${JSON.stringify(out.slice(0, 3))}`)
    assert.equal(out.length > 0, p.radius > 0, p.name)
  }
})

test("what the overlay draws over a phone's page: the home indicator at the phone's own size and place, the corners at the size the window draws them, in the page's px", () => {
  const max = PHONES.find((p) => p.id === "iphone-18-pro-max")!
  const pixel = PHONES.find((p) => p.id === "pixel-11")!
  const se = PHONES.find((p) => p.id === "iphone-se")!
  const around = { shape: "superellipse(1.333)", ring: 8, ringColour: "#e6e6e6", around: "#f5f5f5" }
  assert.deepEqual(phoneEdge(max, 1, around), { radius: 62, shape: "superellipse(1.333)", ring: 8, ringColour: "#e6e6e6", around: "#f5f5f5", home: { width: 134, height: 5, bottom: 8 } })
  // An Android's gesture handle: shorter, thinner, in the middle of its bar.
  assert.deepEqual(phoneEdge(pixel, 1, around)!.home, { width: 108, height: 4, bottom: 10 })
  // Drawn at 80%, the window's corner is rounded to its own pixels and its ring is 8 of them:
  // in the page's px (the page is drawn at 80%), 50 / 0.8 and 8 / 0.8.
  const small = phoneEdge(max, 0.8, around)!
  assert.equal(small.radius, Math.round(62 * 0.8) / 0.8)
  assert.equal(small.ring, 10)
  assert.deepEqual(small.home, { width: 134, height: 5, bottom: 8 }, "the page's own px: the phone's sizes")
  // Not told what is around the screen: no corners (radius 0), the home indicator all the same.
  assert.deepEqual(phoneEdge(max, 1, undefined), { radius: 0, home: { width: 134, height: 5, bottom: 8 } })
  // An iPhone SE: a home button, a square screen. Nothing.
  assert.equal(phoneEdge(se, 1, around), null)
})

test("the frame adds up to the body at any size: the status strip and the page's box on whole pixels, the box the viewport at the page's scale", () => {
  for (const p of PHONES)
    for (const fit of [1, 0.94, 0.8, 0.737, 0.5, 0.3]) {
      const f = frameOf(p, fit)
      const at = `${p.name} at ${fit}`
      assert.ok([f.width, f.height, f.top, f.screen].every(Number.isInteger), at)
      assert.equal(f.top + f.screen, f.height, at)
      assert.equal(f.scale, f.width / p.width, at)
      assert.ok(Math.abs(f.screen - viewportOf(p).height * f.scale) <= 0.5, at)
      assert.ok(Math.abs(f.top - p.top * f.scale) <= 1, at)
    }
  assert.deepEqual(frameOf(PHONES.find((p) => p.id === "iphone-18-pro-max")!, 1), { width: 440, height: 956, top: 62, screen: 894, scale: 1, radius: 62 })
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
