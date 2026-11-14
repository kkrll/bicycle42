// A note's pictures on disk (src/main/shots.ts).
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createShots } from "../src/main/shots"

test("a note's pictures are saved, read back and dropped; the id never becomes a file name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-shots-"))
  try {
    const shots = createShots(dir)
    const uri = (text: string) => `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`
    const id = "../../etc/passwd"
    assert.deepEqual(shots.read(id), {})
    assert.equal(shots.save(id, "before", uri("one")), true)
    assert.deepEqual(shots.read(id), { before: uri("one") })
    assert.equal(shots.save(id, "after", uri("two")), true)
    assert.deepEqual(shots.read(id), { before: uri("one"), after: uri("two") })
    assert.deepEqual(shots.read("another"), {})
    assert.equal(shots.save(id, "after", "data:text/html,<script>"), false, "only a JPEG data URI is a picture")
    const files = fs.readdirSync(path.join(dir, "shots"))
    assert.equal(files.length, 2)
    assert.ok(files.every((f) => /^[0-9a-f]{40}-(before|after)\.jpg$/.test(f)), files.join(" "))
    shots.drop(id)
    assert.deepEqual(shots.read(id), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
