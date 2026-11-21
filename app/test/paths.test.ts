// How the window shows a path (src/renderer/paths.ts): under the home folder, and cut to fit.
//
//   node scripts/build.mjs --tests && node --test dist/test/paths.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { atHome, middleCut } from "../src/renderer/paths"

test("atHome: the home folder is ~, what is outside it stays as it is", () => {
  assert.equal(atHome("/home/k/cde/bicycle42", "/home/k"), "~/cde/bicycle42")
  assert.equal(atHome("/home/k", "/home/k/"), "~")
  assert.equal(atHome("/home/kate/site", "/home/k"), "/home/kate/site")
  assert.equal(atHome("/srv/www", "/home/k"), "/srv/www")
  assert.equal(atHome("/srv/www", undefined), "/srv/www")
  assert.equal(atHome("/x", "/"), "/x")
})

// One character, one pixel: what fits is a count of characters.
const chars = (t: string) => t.length

test("middleCut: a path that fits is whole", () => {
  assert.equal(middleCut("~/code/site", 20, chars), "~/code/site")
})

test("middleCut: whole folders leave from the middle, the last ones kept first", () => {
  const p = "~/code/a-long-organisation/internal-tools/storefront"
  assert.equal(middleCut(p, 40, chars), "~/code/…/internal-tools/storefront")
  assert.equal(middleCut(p, 33, chars), "~/…/internal-tools/storefront")
  assert.equal(middleCut(p, 20, chars), "~/code/…/storefront")
  assert.equal(middleCut(p, 14, chars), "~/…/storefront")
  assert.equal(middleCut("/home/dev/code/site", 13, chars), "/…/code/site")
})

test("middleCut: with no room even for ~/…/last, characters go, the end kept longer", () => {
  const cut = middleCut("~/code/a-very-long-folder-name", 12, chars)
  assert.ok(cut.length <= 12 && cut.includes("…") && cut.endsWith("name"), cut)
})
