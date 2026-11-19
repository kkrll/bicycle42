// What each unfinished note sends, on disk (src/main/outbox.ts).
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createOutbox } from "../src/main/outbox"

test("the outbox writes in the order asked: a read waits for the write before it, a drop wins over a write under way", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-outbox-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outbox = createOutbox(dir)
  const payload = { text: "UI review note 1", files: [{ name: "note-1.jpg", uri: "data:image/jpeg;base64,QUJD" }] }
  const first = outbox.save("../n1", payload)
  // What is written is the payload as it was when asked.
  ;(payload as { id?: string }).id = "msg_later"
  assert.deepEqual(await outbox.read("../n1"), { text: "UI review note 1", files: payload.files })
  assert.equal(await first, true)
  assert.equal(await outbox.save("../n1", payload), true)
  assert.equal((await outbox.read("../n1"))?.id, "msg_later")
  assert.ok(
    fs.readdirSync(path.join(dir, "outbox")).every((f) => /^[0-9a-f]{40}\.json$/.test(f)),
    "the id is never a file name",
  )

  void outbox.save("n2", { text: "two", files: [] })
  void outbox.drop("n2")
  void outbox.drop("../n1")
  await outbox.idle()
  assert.deepEqual(fs.readdirSync(path.join(dir, "outbox")), [])
  assert.equal(await outbox.read("n2"), undefined)
})

test("an outbox that can't be written says false and keeps going", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-outbox-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, "outbox"), "in the way")
  const said: string[] = []
  const outbox = createOutbox(dir, (_level, msg) => void said.push(msg))
  assert.equal(await outbox.save("n1", { text: "x", files: [] }), false)
  assert.deepEqual(said, ["can't save what a note sends"])
  assert.equal(await outbox.read("n1"), undefined)
})
