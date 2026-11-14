// What a conversation is called (src/main/naming.ts).
import assert from "node:assert/strict"
import { test } from "node:test"
import { isPlaceholder, placeholderTitle, titleFrom } from "../src/main/naming"

test("a placeholder is a name nobody chose", () => {
  assert.equal(isPlaceholder(placeholderTitle("localhost:3000")), true)
  assert.equal(isPlaceholder(""), true)
  assert.equal(isPlaceholder("  "), true)
  assert.equal(isPlaceholder("Pricing page"), false)
  assert.equal(isPlaceholder("Background notes"), false)
})

test("a name from what was said: the first line with words, tidied, cut at a word", () => {
  assert.equal(titleFrom("make this button bigger"), "Make this button bigger")
  assert.equal(titleFrom("\n\n  - too   much space here.\nand there"), "Too much space here")
  assert.equal(titleFrom("## 2. Hero: tighter!"), "Hero: tighter")
  assert.equal(titleFrom("---\nреже отступы"), "Реже отступы")
  const long = titleFrom("the heading and the paragraph under it are too far apart on narrow screens, and the button wraps")
  assert.equal(long, "The heading and the paragraph under it are too far…")
  assert.ok(long!.length <= 57)
  assert.equal(titleFrom("a".repeat(80)), `A${"a".repeat(55)}…`)
  assert.equal(titleFrom(""), undefined)
  assert.equal(titleFrom("  \n ... "), undefined)
  assert.equal(titleFrom("/compact"), undefined)
})
