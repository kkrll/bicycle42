// What the context meter shows (src/renderer/context.ts), from the numbers in the state.
//
//   node scripts/build.mjs --tests && node --test dist/test/context.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { meter, tokens } from "../src/renderer/context"

test("tokens: a count as a person says it", () => {
  assert.deepEqual([0, 950, 1000, 1499, 123_600, 200_000, 999_499, 999_500, 1_000_000, 1_048_576, 1_500_000].map(tokens), ["0", "950", "1k", "1k", "124k", "200k", "999k", "1M", "1M", "1M", "1.5M"])
})

test("meter: nothing under half, quiet from half, a warning from 80%", () => {
  const at = (used: number, limit?: number) => meter(limit === undefined ? { used } : { used, limit })
  assert.equal(at(0, 200_000), undefined)
  assert.equal(at(99_999, 200_000), undefined, "one token short of half")
  assert.deepEqual(at(100_000, 200_000), { percent: 50, warn: false, numbers: "100k of 200k tokens" })
  assert.deepEqual(at(124_000, 200_000), { percent: 62, warn: false, numbers: "124k of 200k tokens" })
  // Rounded down: 79.9% is neither called 80% nor coloured as it.
  assert.deepEqual(at(159_999, 200_000), { percent: 79, warn: false, numbers: "160k of 200k tokens" })
  assert.deepEqual(at(160_000, 200_000), { percent: 80, warn: true, numbers: "160k of 200k tokens" })
  assert.deepEqual(at(900_000, 1_048_576), { percent: 85, warn: true, numbers: "900k of 1M tokens" })
  // Past the window the number says so.
  assert.deepEqual(at(210_000, 200_000), { percent: 105, warn: true, numbers: "210k of 200k tokens" })
})

test("meter: nothing without a count or a window", () => {
  assert.equal(meter(undefined), undefined)
  assert.equal(meter({ used: 150_000 }), undefined, "the server gave no limit")
  assert.equal(meter({ used: 150_000, limit: 0 }), undefined)
  assert.equal(meter({ used: Number.NaN, limit: 200_000 }), undefined)
})
