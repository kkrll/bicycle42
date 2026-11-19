// A note's pictures on disk (src/main/shots.ts).
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createShots } from "../src/main/shots"

test("a note's pictures are saved, read back and dropped; the id never becomes a file name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-shots-"))
  try {
    const shots = createShots(dir)
    const uri = (text: string) => `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`
    const id = "../../etc/passwd"
    assert.deepEqual(await shots.read(id), {})
    assert.equal(await shots.save(id, "before", uri("one")), true)
    assert.deepEqual(await shots.read(id), { before: uri("one") })
    assert.equal(await shots.save(id, "after", uri("two")), true)
    assert.deepEqual(await shots.read(id), { before: uri("one"), after: uri("two") })
    assert.deepEqual(await shots.read("another"), {})
    assert.equal(await shots.save(id, "after", "data:text/html,<script>"), false, "only a JPEG data URI is a picture")
    const files = fs.readdirSync(path.join(dir, "shots"))
    assert.equal(files.length, 2)
    assert.ok(
      files.every((f) => /^[0-9a-f]{40}-(before|after)\.jpg$/.test(f)),
      files.join(" "),
    )
    await shots.drop(id)
    assert.deepEqual(await shots.read(id), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a picture dropped while it is being written stays dropped; its bytes are there until then", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-shots-"))
  try {
    const shots = createShots(dir)
    const uri = `data:image/jpeg;base64,${Buffer.from("jpeg bytes").toString("base64")}`
    const saved = shots.save("n1", "before", uri)
    assert.equal((await shots.bytes("n1", "before"))?.toString(), "jpeg bytes", "a read waits for the write before it")
    assert.equal(await saved, true)
    void shots.save("n1", "after", uri)
    void shots.drop("n1")
    await shots.idle()
    assert.deepEqual(fs.readdirSync(path.join(dir, "shots")), [])
    assert.equal(await shots.bytes("n1", "after"), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
