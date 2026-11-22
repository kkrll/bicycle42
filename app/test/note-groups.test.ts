// Which group of the notes list a note sits in (src/renderer/note-groups.ts).
//
//   node scripts/build.mjs --tests && node --test dist/test/note-groups.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { groupOf } from "../src/renderer/note-groups"
import type { NoteRow, NoteStatus } from "../src/shared/types"

const note = (status: NoteStatus, more: Partial<NoteRow> = {}): NoteRow => ({ id: status, n: 1, text: "", status, lane: "main", ...more })

test("only what the agent has is working; a note still being sent or captured waits", () => {
  assert.equal(groupOf(note("working")), "working")
  assert.equal(groupOf(note("working", { lane: "bg" })), "working")
  assert.equal(groupOf(note("sending")), "waiting")
  assert.equal(groupOf(note("capturing")), "waiting")
  assert.equal(groupOf(note("queued")), "waiting")
})

test("failed and stopped notes need the reviewer; done and taken back ones are done", () => {
  assert.equal(groupOf(note("failed")), "needs")
  assert.equal(groupOf(note("failed", { stopped: true })), "needs")
  assert.equal(groupOf(note("done")), "done")
  assert.equal(groupOf(note("queued", { takenBack: "restored" })), "done")
})
