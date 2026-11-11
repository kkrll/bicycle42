// When the app makes a sound (src/renderer/cues.ts), from snapshots of the state and chat events.
//
//   node scripts/build.mjs --tests && node --test dist/test/cues.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { chatCue, cueFor, hear, type Heard } from "../src/renderer/cues"
import type { AppState, ChatEvent, NoteRow, NoteStatus } from "../src/shared/types"

const S = "ses_1"
const note = (id: string, status: NoteStatus, more: Partial<NoteRow> = {}): NoteRow => ({ id, n: 1, text: "", status, lane: "main", ...more })

function state(over: { busy?: boolean; notes?: NoteRow[]; asks?: string[]; questions?: string[]; link?: AppState["connection"]["status"]; session?: string } = {}): AppState {
  const url = "http://127.0.0.1:4096"
  const link = over.link ?? "online"
  return {
    connection: link === "online" ? { status: link, url, version: "2" } : link === "offline" ? { status: link, url, error: "gone" } : link === "connecting" ? { status: link, url } : { status: link },
    page: { url: "http://localhost:3000/", loading: false, canGoBack: false, canGoForward: false, hmr: false },
    review: { enabled: true, autoReload: false, notes: over.notes ?? [], unplaced: 0 },
    site: { origin: "http://localhost:3000", directory: "/code" },
    session: { id: over.session ?? S, directory: "/code", title: "", updated: 0, busy: !!over.busy },
    sessions: [],
    models: [],
    agents: [],
    permissions: (over.asks ?? []).map((id) => ({ id, session: S, action: "edit", resources: [] })),
    questions: (over.questions ?? []).map((id) => ({ id, session: S, title: "", fields: [] })),
  }
}

/** The cues a run of snapshots makes, one entry per snapshot after the first. */
function cues(...states: AppState[]) {
  let heard: Heard | undefined
  const out: (string | null)[] = []
  for (const s of states) {
    const now = hear(s, heard)
    if (heard) out.push(cueFor(heard, now))
    else assert.equal(cueFor(undefined, now), null, "the first snapshot is how things already were")
    heard = now
  }
  return out
}

test("question: a permission or a question that was not there; not the one still waiting, not one answered", () => {
  assert.deepEqual(cues(state({ busy: true }), state({ busy: true, asks: ["a"] }), state({ busy: true, asks: ["a"] }), state({ busy: true, asks: ["a"], questions: ["a"] }), state({ busy: true, questions: ["a"] })), [
    "question",
    null,
    "question",
    null,
  ])
  // already waiting when the window opens: not announced
  assert.deepEqual(cues(state({ asks: ["a"] }), state({ asks: ["a"] })), [null])
})

test("negative: the server was online and is not; connecting between tries is not a second loss", () => {
  assert.deepEqual(cues(state(), state({ link: "offline" }), state({ link: "connecting" }), state({ link: "offline" }), state(), state({ link: "connecting" }), state({ link: "offline" })), [
    "negative",
    null,
    null,
    null,
    null,
    "negative",
  ])
  // a server that was never reached is not lost
  assert.deepEqual(cues(state({ link: "unconfigured" }), state({ link: "connecting" }), state({ link: "offline" })), [null, null])
})

test("negative: a note fails; one the reviewer stopped is a hush, and neither is followed by routine", () => {
  const run = cues(
    state({ busy: true, notes: [note("1", "working"), note("2", "queued")] }),
    state({ busy: true, notes: [note("1", "failed", { error: "no credit" }), note("2", "working")] }),
    state({ busy: false, notes: [note("1", "failed", { error: "no credit" }), note("2", "failed", { stopped: true })] }),
  )
  assert.deepEqual(run, ["negative", "hush"])
})

test("routine: the run ends, or the last note on its way is done; once, not per note", () => {
  // a typed message: busy, then not
  assert.deepEqual(cues(state(), state({ busy: true }), state({ busy: true }), state()), [null, null, "routine"])
  // three notes through the queue, the run ending a snapshot before the last note is marked done
  assert.deepEqual(
    cues(
      state({ notes: [note("1", "sending")] }),
      state({ busy: true, notes: [note("1", "working"), note("2", "queued"), note("3", "capturing")] }),
      state({ busy: true, notes: [note("1", "done"), note("2", "working"), note("3", "queued")] }),
      state({ busy: true, notes: [note("1", "done"), note("2", "done"), note("3", "working")] }),
      state({ busy: false, notes: [note("1", "done"), note("2", "done"), note("3", "working")] }),
      state({ busy: false, notes: [note("1", "done"), note("2", "done"), note("3", "done")] }),
    ),
    [null, null, null, null, "routine"],
  )
  // a background note finishing while the open conversation was never busy
  assert.deepEqual(cues(state({ notes: [note("1", "working", { lane: "bg" })] }), state({ notes: [note("1", "done", { lane: "bg" })] })), ["routine"])
})

test("no sound for what the reviewer did: a waiting note removed, the list cleared, another conversation", () => {
  assert.deepEqual(cues(state({ notes: [note("1", "queued")] }), state()), [null])
  assert.deepEqual(cues(state({ busy: true, notes: [note("1", "working")] }), state({ busy: false, session: "ses_2" })), [null])
  // …and what waits in the conversation just opened is not news either
  assert.deepEqual(cues(state(), state({ session: "ses_2", asks: ["a"], notes: [note("9", "failed")] })), [null])
})

test("chat: a run's failure line is negative, a stop's is a hush, anything else nothing", () => {
  const item = (more: object): ChatEvent => ({ type: "item", session: S, item: { kind: "marker", id: "m", time: 1, text: "", tone: "error", ...more } })
  assert.equal(chatCue(item({ text: "Failed: no credit", failed: true })), "negative")
  assert.equal(chatCue(item({ text: "Stopped" })), "hush")
  assert.equal(chatCue(item({ text: "Model changed to sonnet", tone: "info" })), null)
  assert.equal(chatCue({ type: "reset", session: S, items: [{ kind: "marker", id: "m", time: 1, text: "Failed: old", tone: "error", failed: true }] }), null)
  assert.equal(chatCue({ type: "item", session: S, item: { kind: "assistant", id: "a", time: 1, parts: [], done: true, error: "x" } }), null)
})
