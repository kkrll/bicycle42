// Which group of the notes list a note sits in (src/renderer/note-groups.ts).
//
//   node scripts/build.mjs --tests && node --test dist/test/note-groups.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { fitShort, groupName, groupOf, rowSaysWord } from "../src/renderer/note-groups"
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

test("while the agent can't be reached and works nowhere else, the working group reads Paused", () => {
  assert.equal(groupName("working", false), "Working")
  assert.equal(groupName("working", true), "Paused")
  assert.equal(groupName("needs", true), "Needs you")
  assert.equal(groupName("waiting", true), "Waiting")
})

test("a row prints its state's word only where its group and badge do not say it", () => {
  // The group says waiting, working, paused and done; a failed row's red badge and its error say failed.
  for (const shown of ["queued", "working", "paused", "done", "failed"]) assert.equal(rowSaysWord(shown, false), false, shown)
  // Stopped is not a failure, and capturing and sending wait among the queued.
  for (const shown of ["stopped", "capturing", "sending"]) assert.equal(rowSaysWord(shown, false), true, shown)
  assert.equal(rowSaysWord("done", true), true, "taken back")
})

test("the short counts drop what is left before anything is cut", () => {
  assert.deepEqual(fitShort("1 failed · 8 left", 200), ["1 failed", "8 left"])
  assert.deepEqual(fitShort("1 failed · 8 left", 60), ["1 failed"])
  assert.deepEqual(fitShort("1 failed · 8 left", 10), ["1 failed"])
  assert.deepEqual(fitShort("8 left", 60), ["8 left"])
  assert.deepEqual(fitShort("8 left", 20), [])
  assert.deepEqual(fitShort("all done", 20), ["all done"])
})
