// The controller's unhappy paths (src/main/core.ts), in plain Node: the real controller, review,
// store and ACP client (src/main/acp.ts), in a shell that is not Electron (test/stubs/host.ts),
// with the fake ACP agent of test/fake-agent.ts in this process, whose every turn the test plays
// (`h.agent`). The folders it works in are real ones, as an agent on this computer has. Each test
// makes a fresh controller with its own profile.
//
// These are the sequences a review found note status lying in: Stop, a deleted conversation, a
// new conversation with work in flight, a relaunch, an agent that does not start. Each asserts what
// the reviewer at the screen must see.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { timing } from "../src/main/acp"
import { HOSTED_PANES, PHONE, type AppState, type ChatEvent, type Pane } from "../src/shared/types"
import { playedAgent, type Played } from "./played-agent"
import { testShell, type TestShell } from "./stubs/host"

timing.retryMin = 50
timing.retryMax = 200

const SITE = "http://site.test"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => unknown, ms = 8000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(10)
  }
}

/** The folders the agent works in: real ones, since an agent on this computer works in this
 *  computer's. `folder("repo")` makes one; one never made is a folder that is gone. */
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-ctl-folders-")))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const folder = (name: string) => {
  const p = path.join(ROOT, name)
  fs.mkdirSync(p, { recursive: true })
  return p
}
const REPO = folder("repo")
const GONE = path.join(ROOT, "gone")

/** The command the app is given for the fake agent; another word makes another agent. */
const FAKE = "fake-agent"

async function boot(opts: { settings?: Record<string, unknown>; reviews?: Record<string, unknown>; outbox?: Record<string, unknown>; docks?: Pane[]; agent?: (w: Played) => void; dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-ctl-"))
  // What a note sends, as the app left it on disk (src/main/outbox.ts), by the note's id.
  for (const [id, payload] of Object.entries(opts.outbox ?? {})) {
    fs.mkdirSync(path.join(dir, "outbox"), { recursive: true })
    fs.writeFileSync(path.join(dir, "outbox", `${crypto.createHash("sha1").update(id).digest("hex")}.json`), JSON.stringify(payload))
  }
  // A model is saved, so the app does not stop to ask which of the agent's two to start with.
  const settings = opts.settings ?? { version: 1 }
  if (settings.version === 1 && !("defaultModel" in settings)) settings.defaultModel = { providerID: "fake", id: "fake/alpha" }
  if (opts.settings || !opts.dir) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings))
  for (const [origin, review] of Object.entries(opts.reviews ?? {})) {
    fs.mkdirSync(path.join(dir, "reviews"), { recursive: true })
    fs.writeFileSync(path.join(dir, "reviews", `${encodeURIComponent(origin)}.json`), JSON.stringify(review))
  }
  /** The agents, by the command that starts them. */
  const agents = new Map<string, Played>()
  const agentOf = (command = FAKE) => {
    let w = agents.get(command)
    if (!w) agents.set(command, (w = playedAgent())), opts.agent?.(w)
    return w
  }
  const w = agentOf()
  const quiet = { log: console.log, warn: console.warn, error: console.error }
  if (!process.env.V) console.log = console.warn = console.error = () => {}
  const shells: TestShell[] = []
  const shellOn = () => {
    const s = testShell(dir, { docks: opts.docks, agent: (command) => agentOf(command.join(" ")).fa.connect() })
    shells.push(s)
    return s
  }
  let shell = shellOn()
  const cmd = (name: string, ...args: unknown[]) => shell.core.invoke(name, args)
  const snap = () => shell.core.snapshot()
  const notes = () => snap().review.notes.map((n) => `${n.n}:${n.status}`).join(" ")
  let k = 0
  const note = (text: string, id = `n${++k}`) => {
    shell.page.message({ type: "note", note: { id, text, url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 }, targets: [], area: null, strokes: [], bounds: { x: 1, y: 2, w: 3, h: 4 } } })
    return id
  }
  const agent = {
    /** The turn under way in `s` (in any conversation without), the oldest first: once the agent
     *  has the message (a note reads "working" a moment before). */
    async turn(s?: string) {
      const find = () => w.live.find((x) => !x.ended && (!s || x.session === s))
      await until(find).catch(() => {
        throw new Error(`no turn under way${s ? ` in ${s}` : ""}`)
      })
      return find()!
    },
    async finishes(s?: string) {
      ;(await agent.turn(s)).end()
    },
    /** It says it was cancelled (stopped where it was). */
    async isStopped(s?: string) {
      ;(await agent.turn(s)).end("cancelled")
    },
  }
  const h = {
    dir,
    w,
    agents: agentOf,
    cmd,
    snap,
    notes,
    note,
    agent,
    get shell() {
      return shell
    },
    get core() {
      return shell.core
    },
    get page() {
      return shell.page
    },
    chat: () => shell.sent.filter((x) => x[0] === "chat").map((x) => x[1] as ChatEvent),
    /** Starts the agent (the fake, or the one `command` names). */
    connect: (command = FAKE) => cmd("connectAgent", { id: "custom", command }),
    /** Start the agent, open the site, pick its folder; resolves once a conversation is open. */
    async ready(at = REPO) {
      await h.connect()
      shell.page.load(`${SITE}/`)
      await cmd("setDirectory", at)
      await until(() => !!snap().session)
      await sleep(30)
      return snap().session!.id
    },
    /** The app quits, and starts again on the same data. */
    async relaunch() {
      await shell.core.dispose()
      shell = shellOn()
    },
    async close() {
      for (const s of shells) await Promise.resolve(s.core.invoke("disconnect", [])).catch(() => undefined)
      for (const s of shells) await s.core.dispose()
      Object.assign(console, quiet)
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
  return h
}
type H = Awaited<ReturnType<typeof boot>>

/** The agent finishes the turn under way. One note is one turn: the next waiting note is sent
 *  only once this one's run has ended. */
const turn = (h: H, s?: string) => h.agent.finishes(s)
const lastPrompt = (h: H) => h.w.prompts.at(-1)!
const savedSite = (extra: Record<string, unknown> = {}) => ({ version: 1, lastUrl: `${SITE}/`, sites: { [SITE]: { directory: REPO, ...extra } } })
const savedNote = (id: string, n: number, status: string, message: string, session: string) => ({ id, n, text: id, status, lane: "main", message, session, anchor: {} })
const settingsOf = (h: H) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8"))
  } catch {
    return {} // not written yet
  }
}

test("Stop: the working note fails with a way forward, queued ones stay queued, Retry sends anew", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    const [a, b] = [h.note("a"), h.note("b"), h.note("c")]
    await until(() => h.notes() === "1:working 2:queued 3:queued" && h.w.prompts.length > 0)
    await sleep(50)
    assert.equal(h.w.prompts.length, 1, "one note at a time: the others wait in the app")
    // The agent stops where it is (it says its turn was cancelled).
    await h.agent.isStopped(s)
    await until(() => h.notes() === "1:failed 2:queued 3:queued")
    assert.match(h.snap().review.notes[0]!.error ?? "", /Retry/, "the message says what to do")
    await sleep(100)
    assert.equal(h.w.prompts.length, 1, "a stop stops the queue too: nothing goes by itself")

    await h.cmd("retryNote", a)
    await until(() => h.w.prompts.length === 2)
    assert.equal(h.notes(), "1:working 2:queued 3:queued")
    assert.deepEqual(h.snap().review.notes.map((n) => !!n.sent), [true, false, false], "and in its place, before the ones that waited behind it")

    await h.cmd("removeNote", b)
    assert.equal(h.notes(), "1:working 3:queued", "any note can be taken off the list")
  } finally {
    await h.close()
  }
})

test("Stop from the app empties both queues: the notes waiting in the app and what waits for the agent stop, and nothing goes on afterwards", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    const [, b] = [h.note("a"), h.note("b"), h.note("c")]
    await until(() => h.notes() === "1:working 2:queued 3:queued" && h.snap().session?.busy === true)
    // A message typed while it works waits for its turn, not in the app's lane.
    await h.cmd("send", "and this too", [], { delivery: "queue" })
    await sleep(50)
    assert.equal(h.w.prompts.length, 1)

    await h.cmd("stop")
    assert.equal(h.w.fa.calls.filter((c) => c.method === "session/cancel").length, 1)
    await until(() => h.notes() === "1:failed 2:failed 3:failed")
    assert.deepEqual(h.snap().review.notes.map((n) => !!n.stopped), [true, true, true], "each is stopped, with Retry")
    await until(() => h.snap().session?.busy === false)
    await sleep(150)
    assert.equal(h.w.prompts.length, 1, "the typed message is out of the queue: nothing goes by itself")
    assert.equal(h.notes(), "1:failed 2:failed 3:failed")

    await h.cmd("retryNote", b)
    await until(() => h.w.prompts.length === 2)
    assert.equal(h.notes(), "1:failed 2:working 3:failed", "Retry sends the one asked for, and only it")
    assert.equal(lastPrompt(h).session, s)
  } finally {
    await h.close()
  }
})

test("the conversation is deleted while notes are in flight: they fail, and the site gets a new one", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.note("a")
    h.note("b")
    await until(() => h.notes() === "1:working 2:queued")
    await h.cmd("deleteSession", s)
    await until(() => h.notes().startsWith("1:failed"))
    assert.match(h.snap().review.notes[0]!.error ?? "", /deleted/i)
    await until(() => !!h.snap().session && h.snap().session!.id !== s)
    // The note that waited in the app was never in the deleted conversation: it goes to the new one.
    await until(() => h.w.prompts.length === 2)
    assert.equal(h.w.prompts[1]!.session, h.snap().session!.id, "the waiting note goes to the new conversation")
    h.note("c")
    await until(() => h.notes() === "1:failed 2:working 3:queued")
    assert.equal(h.w.prompts.length, 2, "and the next one waits behind it")
  } finally {
    await h.close()
  }
})

test("a new conversation does not finish the old one's notes", async () => {
  const h = await boot()
  try {
    const old = await h.ready()
    h.note("a")
    h.note("b")
    await until(() => h.notes() === "1:working 2:queued")

    await h.cmd("newSession")
    const neu = h.snap().session!.id
    assert.notEqual(neu, old)
    await sleep(100)
    assert.equal(h.notes(), "1:working 2:queued", "opening an idle conversation settles nothing on the old one")

    // A run in the new conversation (a message typed there) is not about the old one's note.
    await h.cmd("send", "a question")
    await until(() => h.w.prompts.length === 2)
    await turn(h, neu)
    await sleep(100)
    assert.equal(h.notes(), "1:working 2:queued")
    assert.equal(h.w.prompts.length, 2, "the waiting note still waits for the one before it")

    // The old conversation is still at it, and its end lands on its note. Then the waiting note
    // goes, to the conversation that is open now.
    await turn(h, old)
    await until(() => h.w.prompts.length === 3)
    assert.equal(h.w.prompts[2]!.session, neu)
    await turn(h, neu)
    await until(() => h.notes() === "1:done 2:done")
  } finally {
    await h.close()
  }
})

test("the page sending one note twice makes one note", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.note("a", "same")
    h.note("a", "same")
    await until(() => h.w.prompts.length >= 1)
    await sleep(100)
    assert.equal(h.w.prompts.length, 1)
    assert.equal(h.notes(), "1:working")
  } finally {
    await h.close()
  }
})

test("the repo comes before the site: its conversation opens with no page, and the first site takes it over", async () => {
  const h = await boot()
  try {
    await h.connect()
    assert.equal(h.snap().site, null, "no repo, no page: nowhere yet")
    await h.cmd("setDirectory", REPO)
    await until(() => !!h.snap().session)
    const first = h.snap().session!.id
    assert.deepEqual([h.snap().site, h.w.creates], [{ origin: "", directory: REPO }, 1])

    // The site opens: it works in the repo without being asked, in the same conversation.
    h.page.load(`${SITE}/`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    assert.deepEqual([h.snap().site, h.snap().session!.id, h.w.creates], [{ origin: SITE, directory: REPO }, first, 1])
    h.note("a note")
    await until(() => h.w.prompts.length === 1)
    assert.equal(h.w.prompts[0]!.session, first)

    // Another site, later: the same repo, a conversation of its own.
    h.page.load("http://other.test/")
    await until(() => h.snap().site?.origin === "http://other.test" && !!h.snap().session)
    assert.deepEqual([h.snap().site!.directory, h.snap().session!.id !== first, h.w.creates], [REPO, true, 2])
  } finally {
    await h.close()
  }
})

test("openProject: another repo opens with no page and a conversation of its own; going back brings the site and its conversation", async () => {
  const h = await boot()
  const OTHER = folder("other")
  try {
    await h.connect()
    await h.cmd("setDirectory", REPO)
    h.page.load(`${SITE}/pricing`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    const first = h.snap().session!.id
    h.note("a note")
    await until(() => h.snap().review.notes.length === 1)

    await h.cmd("openProject", OTHER)
    await until(() => h.snap().site?.directory === OTHER && !!h.snap().session)
    assert.deepEqual([h.snap().site, h.snap().page.url, h.snap().review.notes.length], [{ origin: "", directory: OTHER }, "", 0])
    assert.notEqual(h.snap().session!.id, first)
    // Saved a moment after the change: until then there may be no file, or the one before.
    await until(() => settingsOf(h).folder === OTHER)
    assert.equal(settingsOf(h).lastUrl, undefined, "the next launch starts in this repo, not on the other one's page")

    // Back: the page it was on, its notes and its conversation.
    await h.cmd("openProject", REPO)
    await until(() => h.snap().site?.origin === SITE && h.snap().session?.id === first)
    assert.deepEqual([h.snap().page.url, h.snap().site!.directory, h.snap().review.notes.length], [`${SITE}/pricing`, REPO, 1])

    // Opening the project that is open changes nothing.
    const creates = h.w.creates
    await h.cmd("openProject", REPO)
    assert.deepEqual([h.snap().page.url, h.snap().session!.id, h.w.creates], [`${SITE}/pricing`, first, creates])
    await assert.rejects(Promise.resolve(h.cmd("openProject", "relative/path")))
  } finally {
    await h.close()
  }
})

test("an address belongs to the project that is open: the same one in another project is another site, and each keeps its notes and conversation", async () => {
  const h = await boot()
  const OTHER = folder("other")
  try {
    await h.connect()
    await h.cmd("setDirectory", REPO)
    h.page.load(`${SITE}/pricing`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    const first = h.snap().session!.id
    h.note("the first project's note")
    await until(() => h.snap().review.notes.length === 1)

    // Another project, and its server now answers at the address the first one's did (a port is
    // whoever's dev server took it): the address is this project's, not a way back to the first.
    await h.cmd("openProject", OTHER)
    await until(() => h.snap().site?.directory === OTHER && !!h.snap().session)
    const second = h.snap().session!.id
    h.page.load(`${SITE}/`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    assert.deepEqual([h.snap().site, h.snap().session!.id, h.snap().review.notes.length], [{ origin: SITE, directory: OTHER }, second, 0])
    h.note("the second project's note")
    await until(() => h.w.prompts.length === 2)
    // The first project's note may reach the agent after this one: found by its words.
    const sent = h.w.prompts.find((p) => p.text.includes("the second project's note"))
    assert.deepEqual([sent?.session, h.snap().review.notes.map((n) => n.text)], [second, ["the second project's note"]])

    // Each project opens on its own page at that address, with its own notes and conversation.
    await h.cmd("openProject", REPO)
    await until(() => h.snap().session?.id === first)
    assert.deepEqual([h.snap().page.url, h.snap().site, h.snap().review.notes.map((n) => n.text)], [`${SITE}/pricing`, { origin: SITE, directory: REPO }, ["the first project's note"]])
    await h.cmd("openProject", OTHER)
    await until(() => h.snap().session?.id === second)
    assert.deepEqual([h.snap().page.url, h.snap().site, h.snap().review.notes.map((n) => n.text)], [`${SITE}/`, { origin: SITE, directory: OTHER }, ["the second project's note"]])

    // The same page in both: the project changes under it, and what is shown with it.
    h.page.load(`${SITE}/pricing`)
    await until(() => h.snap().page.url === `${SITE}/pricing`)
    await h.cmd("openProject", REPO)
    await until(() => h.snap().session?.id === first)
    assert.deepEqual([h.snap().site!.directory, h.snap().review.notes.map((n) => n.text)], [REPO, ["the first project's note"]])
  } finally {
    await h.close()
  }
})

test("setDirectory: the site on screen goes to the folder with its notes, unless the folder has this address already", async () => {
  const h = await boot()
  const [MOVED, OTHER] = [folder("moved"), folder("other")]
  try {
    await h.ready()
    const first = h.snap().session!.id
    h.note("made before the code moved")
    await until(() => h.snap().review.notes.length === 1)
    // The code moved (or the folder was the wrong one): the notes stay with the page.
    await h.cmd("setDirectory", MOVED)
    await until(() => !!h.snap().session && h.snap().session!.id !== first)
    const moved = h.snap().session!.id
    assert.deepEqual([h.snap().site, h.snap().review.notes.length], [{ origin: SITE, directory: MOVED }, 1])

    // Another project at the address, then the first one's folder chosen from there: its own place opens, and this one is kept.
    await h.cmd("openProject", OTHER)
    h.page.load(`${SITE}/`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    const other = h.snap().session!.id
    assert.deepEqual([h.snap().site!.directory, h.snap().review.notes.length], [OTHER, 0])
    await h.cmd("setDirectory", MOVED)
    await until(() => h.snap().session?.id === moved)
    assert.deepEqual([h.snap().site, h.snap().review.notes.length], [{ origin: SITE, directory: MOVED }, 1])
    await h.cmd("openProject", OTHER)
    await until(() => h.snap().session?.id === other)
    assert.deepEqual([h.snap().site, h.snap().review.notes.length], [{ origin: SITE, directory: OTHER }, 0])
  } finally {
    await h.close()
  }
})

test("the next launch: the address is opened in the project that was open, though another project had it first", async () => {
  const OTHER = folder("other")
  const sites = { [SITE]: { directory: REPO, session: "s_repo" }, [`${SITE}#2`]: { directory: OTHER, url: `${SITE}/about`, seen: 2 } }
  const note = (id: string) => ({ version: 1, enabled: true, draft: null, notes: [savedNote(id, 1, "done", `msg_${id}`, "s_gone")] })
  const h = await boot({ settings: { version: 1, folder: OTHER, lastUrl: `${SITE}/about`, sites }, reviews: { [SITE]: note("firsts"), [`${SITE}#2`]: note("seconds") } })
  try {
    // The shell loads the last address by itself (stubs/host.ts).
    await h.connect()
    await until(() => !!h.snap().session)
    assert.deepEqual([h.snap().page.url, h.snap().site, h.snap().review.notes.map((n) => n.text)], [`${SITE}/about`, { origin: SITE, directory: OTHER }, ["seconds"]])
  } finally {
    await h.close()
  }
})

test("a project whose folder is gone, at an address another project had first: the folder is asked for, now and at the next launch, and nothing of the project is lost", async () => {
  const sites = { [SITE]: { directory: REPO }, [`${SITE}#2`]: { directory: GONE, session: "s_x", pinned: ["s_x"] } }
  const note = (id: string) => ({ version: 1, enabled: true, draft: null, notes: [savedNote(id, 1, "done", `msg_${id}`, "s_gone")] })
  const reviews = { [SITE]: note("firsts"), [`${SITE}#2`]: note("seconds") }
  const shown = (h: { snap(): AppState }) => [h.snap().site, h.snap().missingFolder, h.snap().session, h.snap().review.notes.map((n) => n.text)]
  let h = await boot({ settings: { version: 1, folder: GONE, lastUrl: `${SITE}/about`, sites }, reviews })
  let saved: { folder?: string; lastUrl?: string; sites: Record<string, { directory: string; pinned?: string[] }> }
  try {
    await h.connect()
    await until(() => h.snap().missingFolder === GONE)
    // The page goes on meanwhile (it finishes loading, a link is followed).
    h.page.load(`${SITE}/pricing`)
    await sleep(30)
    assert.deepEqual(shown(h), [{ origin: SITE }, GONE, null, ["seconds"]])
    // Quit before a folder was chosen: what the project had is still on disk.
    await sleep(400)
    saved = settingsOf(h)
    const kept = saved.sites[`${SITE}#2`] as { directory: string; session?: string; pinned?: string[] }
    assert.deepEqual([saved.folder, kept.directory, kept.session, kept.pinned], [GONE, GONE, "s_x", ["s_x"]])
  } finally {
    await h.close()
  }
  // The next launch, with what was saved.
  h = await boot({ settings: { version: 1, folder: saved.folder, lastUrl: saved.lastUrl, sites: saved.sites }, reviews })
  try {
    await h.connect()
    await until(() => h.snap().missingFolder === GONE)
    assert.deepEqual(shown(h), [{ origin: SITE }, GONE, null, ["seconds"]])
    const FOUND = folder("found")
    await h.cmd("setDirectory", FOUND)
    await until(() => !!h.snap().session)
    assert.deepEqual([h.snap().site, h.snap().review.notes.map((n) => n.text)], [{ origin: SITE, directory: FOUND }, ["seconds"]])
  } finally {
    await h.close()
  }
})

test("a project whose folder is gone leaves its notes to no one: another project at its address starts with none", async () => {
  const note = { version: 1, enabled: true, draft: null, notes: [savedNote("the gone project's", 1, "done", "msg_1", "s_gone")] }
  const h = await boot({ settings: { version: 1, folder: GONE, lastUrl: `${SITE}/`, sites: { [SITE]: { directory: GONE } } }, reviews: { [SITE]: note } })
  const NEW = folder("new")
  try {
    await h.connect()
    await until(() => h.snap().missingFolder === GONE)
    await h.cmd("openProject", NEW)
    h.page.load(`${SITE}/`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    assert.deepEqual([h.snap().site, h.snap().review.notes.length], [{ origin: SITE, directory: NEW }, 0])
  } finally {
    await h.close()
  }
})

test("a project with no page keeps its conversation while another project is open", async () => {
  const h = await boot()
  const [A, B] = [folder("a"), folder("b")]
  try {
    await h.connect()
    await h.cmd("setDirectory", A)
    await until(() => !!h.snap().session)
    const a = h.snap().session!.id
    await h.cmd("openProject", B)
    await until(() => !!h.snap().session && h.snap().session!.id !== a)
    const b = h.snap().session!.id
    await h.cmd("openProject", A)
    await until(() => !!h.snap().session && h.snap().session!.id !== b)
    assert.deepEqual([h.snap().site, h.snap().session!.id, h.w.creates], [{ origin: "", directory: A }, a, 2])
    await h.cmd("openProject", B)
    await until(() => h.snap().session?.id === b)
    assert.equal(h.w.creates, 2)
  } finally {
    await h.close()
  }
})

test("openProject goes back to the site that was open last, though another one's address changed last", async () => {
  const h = await boot()
  const ELSEWHERE = folder("elsewhere")
  try {
    await h.connect()
    await h.cmd("setDirectory", REPO)
    for (const url of [`${SITE}/a`, "http://other.test/b", `${SITE}/a`]) {
      h.page.load(url)
      await until(() => h.snap().page.url === url && !!h.snap().session)
      await sleep(5) // the clock moves between visits
    }
    await h.cmd("openProject", ELSEWHERE)
    await until(() => h.snap().site?.directory === ELSEWHERE)
    await h.cmd("openProject", REPO)
    await until(() => h.snap().site?.directory === REPO)
    assert.equal(h.snap().page.url, `${SITE}/a`)
  } finally {
    await h.close()
  }
})

type Info = { id: string; name?: string; url: string; current: boolean; agent?: string; command?: string }

test("agents are remembered: a second one starts clean, and going back to the first brings its repo, page and notes", async () => {
  const h = await boot()
  const ELSEWHERE = folder("elsewhere")
  try {
    await h.connect()
    await h.cmd("setDirectory", REPO)
    h.page.load(`${SITE}/pricing`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    const first = h.snap().session!.id
    h.note("a note")
    await until(() => h.snap().review.notes.length === 1)
    await h.cmd("setServerName", "Studio")

    // Another agent: nothing of the first one's is here, and the same address is another site.
    await h.connect("fake-agent --second")
    await until(() => h.snap().connection.status === "online" && h.snap().harness?.name === "fake-agent" && !h.snap().site)
    assert.deepEqual([h.snap().site, h.snap().page.url, h.snap().session], [null, "", null])
    await h.cmd("setDirectory", ELSEWHERE)
    h.page.load(`${SITE}/pricing`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    assert.deepEqual([h.snap().site!.directory, h.snap().review.notes.length], [ELSEWHERE, 0])

    const list = (await h.cmd("servers")) as Info[]
    assert.deepEqual(list.map((x) => [x.command, x.current, x.name]), [["fake-agent --second", true, "fake-agent"], ["fake-agent", false, "Studio"]])
    await assert.rejects(Promise.resolve(h.cmd("forgetServer", list[0]!.id)), "not the one in use")

    // Back, by its id alone.
    await h.cmd("useServer", list[1]!.id)
    await until(() => h.snap().session?.id === first)
    assert.deepEqual([h.snap().site, h.snap().page.url, h.snap().review.notes.length, h.snap().serverName], [{ origin: SITE, directory: REPO }, `${SITE}/pricing`, 1, "Studio"])

    // Forgotten: gone from the list, and no longer to be connected to.
    await h.cmd("forgetServer", list[0]!.id)
    assert.deepEqual(((await h.cmd("servers")) as Info[]).map((x) => x.command), ["fake-agent"])
    await assert.rejects(Promise.resolve(h.cmd("useServer", list[0]!.id)))
  } finally {
    await h.close()
  }
})

test("a folder that is not there is not opened, nor offered; projects of other agents are listed with their agent and open there", async () => {
  const h = await boot()
  const [SITE_DIR, APP] = [folder("site"), folder("app")]
  try {
    await h.connect()
    await h.cmd("setDirectory", SITE_DIR)
    await until(() => !!h.snap().session)
    const first = h.snap().session!.id
    // The agent once worked in a folder that is gone since: it is not offered.
    h.w.fa.sessions.set("s_old", { id: "s_old", cwd: GONE, history: [], model: "fake/alpha", effort: "default", mode: "build" })
    assert.deepEqual(await h.cmd("projects"), [SITE_DIR])

    await h.connect("fake-agent --second")
    await assert.rejects(Promise.resolve(h.cmd("openProject", GONE)), /is not a folder/)
    const creates = h.agents("fake-agent --second").creates
    await h.cmd("setDirectory", GONE)
    await until(() => h.snap().missingFolder === GONE)
    assert.deepEqual([h.snap().site?.directory, h.snap().session, h.agents("fake-agent --second").creates], [undefined, null, creates])
    await h.cmd("setDirectory", APP)
    await until(() => !!h.snap().session)
    assert.equal(h.snap().missingFolder, undefined)

    type P = { directory: string; server?: string; on: string; open?: true }
    const all = (await h.cmd("allProjects")) as P[]
    assert.deepEqual(all.map((p) => [p.directory, !!p.server, !!p.open]), [[APP, false, true], [SITE_DIR, true, false]])

    // One choice: the other agent, and its project.
    await h.cmd("openProject", SITE_DIR, all[1]!.server)
    await until(() => h.snap().session?.id === first)
    assert.deepEqual([(await h.cmd("servers") as Info[]).find((x) => x.current)!.command, h.snap().site], ["fake-agent", { origin: "", directory: SITE_DIR }])
  } finally {
    await h.close()
  }
})

test("startSite asks the agent in the repo's conversation, and opens the address its answer ends with", async () => {
  const h = await boot()
  try {
    await h.connect()
    await assert.rejects(Promise.resolve(h.cmd("startSite")), "no repo: nobody to ask")
    await h.cmd("setDirectory", REPO)
    await until(() => !!h.snap().session)
    const id = h.snap().session!.id
    await h.cmd("startSite")
    await until(() => h.w.prompts.length === 1)
    const sent = h.w.prompts[0]!.text
    assert.match(sent, /^Get this project's site running/)
    assert.doesNotMatch(sent, /another computer/, "the agent is on this computer: localhost opens")
    assert.match(sent, /background command of your shell tool/)
    assert.match(sent, /SITE: <address>$/)
    assert.equal(h.snap().startingSite, true)

    // It asks instead of answering: nothing opens, and the app goes on waiting for an address.
    await (await h.agent.turn(id)).say("Which of the two apps, web or docs?")
    await turn(h, id)
    await until(() => !h.snap().startingSite)
    await sleep(50)
    assert.equal(h.snap().page.url, "")

    // The answer to the question brings the address, on a line of its own; other addresses in the reply are not it.
    await h.cmd("send", "web")
    await until(() => h.w.prompts.length === 2)
    await (await h.agent.turn(id)).say("Started `npm run dev` (docs are at http://docs.test/).\n\nSITE: http://127.0.0.1:5173/\n")
    await turn(h, id)
    await until(() => h.snap().page.url !== "")
    assert.equal(h.snap().page.url, "http://127.0.0.1:5173/")
    await until(() => h.snap().site?.origin === "http://127.0.0.1:5173" && h.snap().session?.id === id)
    assert.deepEqual(h.snap().site, { origin: "http://127.0.0.1:5173", directory: REPO })

    // Once a page is open, a later reply with such a line moves nothing.
    await h.cmd("send", "and docs?")
    await until(() => h.w.prompts.length === 3)
    await (await h.agent.turn(id)).say("SITE: http://elsewhere.test/")
    await turn(h, id)
    await sleep(80)
    assert.equal(h.snap().page.url, "http://127.0.0.1:5173/")
  } finally {
    await h.close()
  }
})

test("a note fired while the site's conversation is still opening does not create a second one", async () => {
  const h = await boot()
  try {
    await h.connect()
    h.page.load(`${SITE}/`)
    const opening = h.cmd("setDirectory", REPO) // not awaited: the reviewer is fast
    h.note("first")
    await opening
    await until(() => h.w.prompts.length === 1)
    assert.equal(h.w.creates, 1)
    assert.equal(h.w.prompts[0]!.session, h.snap().session!.id)
  } finally {
    await h.close()
  }
})

test("relaunch after the conversation was deleted: its notes fail, they are not called done", async () => {
  const h = await boot({
    settings: savedSite({ session: "s_gone" }),
    reviews: { [SITE]: { version: 1, notes: [savedNote("a", 1, "working", "msg_a", "s_gone"), savedNote("b", 2, "queued", "msg_b", "s_gone")] } },
  })
  try {
    assert.equal(h.notes(), "1:working 2:queued", "before connecting nothing is known")
    await h.connect()
    await until(() => !!h.snap().session)
    await until(() => h.notes() === "1:failed 2:failed")
    assert.notEqual(h.snap().session!.id, "s_gone")
  } finally {
    await h.close()
  }
})

test("relaunch: the conversation is the one saved, finished notes stay done, and nothing is sent again", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.note("a")
    await until(() => h.notes() === "1:working")
    await turn(h, s)
    await until(() => h.notes() === "1:done")
    await sleep(400) // the store's debounce
    await h.relaunch()
    await h.connect()
    await until(() => !!h.snap().session)
    await sleep(100)
    assert.equal(h.snap().session!.id, s, "the saved conversation is reused")
    assert.deepEqual([h.notes(), h.w.creates, h.w.prompts.length], ["1:done", 1, 1])
  } finally {
    await h.close()
  }
})

test("one note is one turn: the next goes when the one before is done, and not while a typed message runs", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.note("a")
    h.note("b")
    h.note("c")
    await until(() => h.notes() === "1:working 2:queued 3:queued" && h.w.prompts.length === 1)
    assert.deepEqual(h.snap().review.notes.map((n) => !!n.sent), [true, false, false], "only the first is with the agent")
    await turn(h, s)
    await until(() => h.w.prompts.length === 2 && h.notes() === "1:done 2:working 3:queued")
    await turn(h, s)
    await until(() => h.w.prompts.length === 3)
    await turn(h, s)
    await until(() => h.notes() === "1:done 2:done 3:done")

    // A message typed in the chat starts a run: a note made right after waits, even before the
    // agent has it.
    const before = h.w.prompts.length
    await h.cmd("send", "make the header blue")
    h.note("d")
    await until(() => h.notes() === "1:done 2:done 3:done 4:queued")
    await sleep(100)
    assert.equal(h.w.prompts.length, before + 1, "only the typed message went; the note waits")
    assert.equal(h.snap().review.notes[3]?.sent, undefined)
    await turn(h, s)
    await until(() => h.w.prompts.length === before + 2)
    await turn(h, s)
    await until(() => h.notes() === "1:done 2:done 3:done 4:done")
  } finally {
    await h.close()
  }
})

test("a prompt of the app's own holds a note like a typed one, and so does the agent's /compact", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.note("a")
    await until(() => h.w.prompts.length === 1)
    await turn(h, s)
    await until(() => h.notes() === "1:done")
    await sleep(50)

    // Commit changes starts a run before the agent has it: the note made right after waits.
    const before = h.w.prompts.length
    await h.cmd("commitChanges", "Tidy the hero")
    h.note("b")
    await until(() => h.notes() === "1:done 2:queued")
    await sleep(100)
    assert.equal(h.w.prompts.length, before + 1, "only the commit prompt went; the note waits")
    await turn(h, s)
    await until(() => h.w.prompts.length === before + 2)
    await turn(h, s)
    await until(() => h.notes() === "1:done 2:done")
    await sleep(50)

    // The agent's own /compact is a turn of its: the note waits for it, then goes.
    await until(() => h.snap().can?.compact === true)
    await h.cmd("runCommand", "compact", "")
    h.note("c")
    await until(() => h.w.prompts.length === before + 3)
    assert.equal(lastPrompt(h).text, "/compact")
    await sleep(100)
    assert.equal(h.w.prompts.length, before + 3, "the note waits for the summary")
    await turn(h, s)
    await until(() => h.w.prompts.length === before + 4)
  } finally {
    await h.close()
  }
})

test("the page is laid out where the window last put it, hidden, before it loads; the window's word is kept for the next start", async () => {
  const at = { x: 12, y: 60, width: 900, height: 700 }
  const h = await boot({ settings: { ...savedSite(), pageBounds: at } })
  const saved = () => settingsOf(h).pageBounds as unknown
  try {
    // As the shell starts it (stubs/host.ts, like index.ts): its place of last time, out of sight, the last address.
    assert.deepEqual(h.core.lastPageBounds(), at)
    assert.deepEqual(h.page.calls.slice(0, 3), [["bounds", at], ["bounds", null], ["load", `${SITE}/`]])
    // What was sent to the window before it could listen is there for it to ask for.
    assert.equal(h.snap().page.url, `${SITE}/`)
    // The window's own word shows the page, and is where the next start begins.
    const now = { x: 12, y: 60, width: 640, height: 700 }
    await h.cmd("setPageBounds", now)
    assert.deepEqual(h.page.calls.at(-1), ["bounds", now])
    await until(() => JSON.stringify(saved()) === JSON.stringify(now))
    // A dialog over the page hides it; that is no place to come back to.
    await h.cmd("setPageBounds", null)
    assert.deepEqual(h.page.calls.at(-1), ["bounds", null])
    await sleep(400)
    assert.deepEqual(saved(), now)
  } finally {
    await h.close()
  }
})

test("the page's place, said many times a second while the window is resized, is written once it has come to rest, and at quit", async () => {
  const h = await boot({ settings: savedSite() })
  const file = path.join(h.dir, "settings.json")
  const saved = () => JSON.parse(fs.readFileSync(file, "utf8")).pageBounds as unknown
  // Every write of a file ends in a rename onto it (store.ts): counted, not timed.
  const rename = fs.renameSync
  let writes = 0
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (to === file) writes++
    rename(from, to)
  }) as typeof fs.renameSync
  try {
    await sleep(600) // (what the start has to write is written)
    writes = 0
    // A second of a window being resized: another place every 40 ms.
    const place = (i: number) => ({ x: 12, y: 60, width: 900 - i, height: 700 })
    for (let i = 1; i <= 25; i++) {
      await h.cmd("setPageBounds", place(i))
      await sleep(40)
    }
    assert.equal(writes, 0, "nothing is written while the place keeps changing")
    // (In memory it is the newest at once: whoever asks the controller gets that.)
    assert.deepEqual(h.core.lastPageBounds(), place(25))
    await until(() => writes > 0)
    await sleep(500)
    assert.equal(writes, 1, "one write, once it has come to rest")
    assert.deepEqual(saved(), place(25))
    // A quit in the middle of a resize: the last place is on disk all the same.
    await h.cmd("setPageBounds", place(30))
    await h.core.dispose()
    assert.deepEqual(saved(), place(30))
  } finally {
    fs.renameSync = rename
    await h.close()
  }
})

test("a first start, or a place on disk that is no rectangle: the page still loads hidden, with no place of last time", async () => {
  for (const pageBounds of [undefined, { x: 0, y: 0, width: 0, height: 700 }, { x: 0, y: 0, width: Infinity, height: 700 }, "wide"]) {
    const h = await boot({ settings: { ...savedSite(), ...(pageBounds === undefined ? {} : { pageBounds }) } })
    try {
      assert.equal(h.core.lastPageBounds(), undefined)
      assert.deepEqual(h.page.calls.slice(0, 2), [["bounds", null], ["load", `${SITE}/`]])
    } finally {
      await h.close()
    }
  }
})

test("relaunch with a note that was waiting in the app: it is sent, pictures and all, from what was kept on disk", async () => {
  const held = { id: "b", n: 1, text: "b", status: "queued", lane: "main", held: true, anchor: {} }
  const lost = { id: "c", n: 2, text: "c", status: "queued", lane: "main", held: true, anchor: {} }
  const h = await boot({
    settings: savedSite(),
    reviews: { [SITE]: { version: 1, notes: [held, lost] } },
    outbox: { b: { text: "UI review note 1\nNote: b", files: [{ name: "note-1.jpg", uri: `data:image/jpeg;base64,${Buffer.from("ABC").toString("base64")}` }] } },
  })
  try {
    await h.connect()
    // The lane is free, so the waiting one goes.
    await until(() => h.w.prompts.length === 1)
    assert.deepEqual([lastPrompt(h).text, lastPrompt(h).images], ["UI review note 1\nNote: b", ["ABC"]])
    await until(() => h.notes() === "1:working 2:queued")
    // The one after it has nothing on disk to send: it fails when its turn comes, and says so.
    await turn(h)
    await until(() => h.notes() === "1:done 2:failed")
    assert.match(h.snap().review.notes[1]!.error ?? "", /screenshot is gone/)
  } finally {
    await h.close()
  }
})

test("an OpenCode server saved by an earlier version is put aside at start: not connected to, its password gone, what was its own kept on disk, and said once", async () => {
  const space = { folder: "/agent-repo", sites: { [`${SITE}#a`]: { directory: "/agent-repo" } }, prefix: "srv_b~" }
  const settings = {
    version: 1,
    server: { url: "http://box.example:4096", password: "plain:secret-pw", name: "Studio" },
    current: "srv_a",
    servers: [
      { id: "srv_a", url: "http://box.example:4096", password: "plain:secret-pw", name: "Studio" },
      { id: "srv_l", local: true },
      { id: "srv_b", agent: "claude", command: ["claude-agent-acp"], space },
    ],
    prefix: "",
    folder: "/repo",
    lastUrl: `${SITE}/`,
    sites: { [SITE]: { directory: "/repo", session: "ses_9" } },
    defaultModel: { providerID: "anthropic", id: "sonnet" },
  }
  const review = { version: 1, notes: [savedNote("n1", 1, "done", "msg_1", "ses_9")] }
  const h = await boot({ settings, reviews: { [SITE]: review } })
  try {
    await sleep(300)
    assert.equal(h.snap().connection.status, "unconfigured", "nothing is connected to")
    assert.equal(h.w.fa.starts, 0)
    assert.equal(h.snap().harness, undefined)
    assert.equal(h.snap().serversRetired, true, "the connect screen says so")
    assert.equal(h.core.lastUrl(), "", "its page is not opened")
    assert.equal(h.snap().site, null)
    const saved = settingsOf(h)
    assert.ok(!JSON.stringify(saved).includes("secret-pw"), "the password is gone from the settings")
    assert.deepEqual(saved.servers, [{ id: "srv_b", agent: "claude", command: ["claude-agent-acp"], space }], "the agent stays, with what is its own")
    assert.equal(saved.server, undefined)
    assert.equal(saved.current, undefined)
    assert.deepEqual(saved.sites, {})
    assert.notEqual(saved.prefix, "", "the next agent's notes are kept under a prefix of its own")
    assert.deepEqual(
      saved.retired,
      [
        { id: "srv_a", url: "http://box.example:4096", name: "Studio", space: { folder: "/repo", lastUrl: `${SITE}/`, defaultModel: settings.defaultModel, sites: settings.sites, prefix: "" } },
        { id: "srv_l", local: true },
      ],
      "what was the server's own is kept as it was",
    )
    assert.ok(fs.existsSync(path.join(h.dir, "reviews", `${encodeURIComponent(SITE)}.json`)), "its notes stay on disk")
    assert.deepEqual(h.snap().review.notes, [], "and are not reached")
    // The connect screen closes: said once.
    await h.cmd("leaveSsh")
    await sleep(350)
    assert.equal(h.snap().serversRetired, undefined)
    assert.equal(settingsOf(h).serversRetired, undefined)
    // An agent started now starts clean.
    await h.ready()
    assert.deepEqual([h.snap().site, h.snap().review.notes], [{ origin: SITE, directory: REPO }, []])
  } finally {
    await h.close()
  }
})

test("the agent does not start at launch, and can later: the app tries again by itself", async () => {
  const h = await boot()
  try {
    await h.ready()
    await sleep(400) // the store's debounce
    await h.relaunch()
    // The saved agent dies at once each time it is started: offline, and tried again.
    h.w.fa.dieAfterInit = true
    await until(() => h.snap().connection.status === "offline", 10_000)
    const starts = h.w.fa.starts
    h.w.fa.dieAfterInit = false
    await until(() => h.snap().connection.status === "online", 10_000)
    assert.ok(h.w.fa.starts > starts, "started again without being asked")
    await until(() => !!h.snap().session)
  } finally {
    await h.close()
  }
})

test("settings from a newer version are left alone, and the user is told", async () => {
  const future = { version: 2, shape: "unknown to this build" }
  const h = await boot({ settings: future })
  try {
    await until(() => h.shell.dialogs.length === 1)
    await h.connect()
    await sleep(400) // longer than the store's debounce
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8")), future)
    assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f.includes("corrupt")), [])
  } finally {
    await h.close()
  }
})

// ── the message box ─────────────────────────────────────────────────────────────────────────────

test("send: a file mention goes as a link to the file under the site's folder; steer joins the turn under way, queue waits", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    const text = "make @hero.tsx and @src/ui match"
    await h.cmd("send", text, [], {
      mentions: [
        { kind: "file", id: "src/hero.tsx", start: 5, end: 14 },
        { kind: "folder", id: "src/ui", start: 19, end: 26 },
        { kind: "nonsense", id: "x", start: 0, end: 1 },
      ],
      delivery: "steer",
    })
    // Nothing under way: it is a turn of its own.
    await until(() => h.w.prompts.length === 1)
    assert.deepEqual(lastPrompt(h), { session: s, text, images: [], links: [`file://${REPO}/src/hero.tsx`, `file://${REPO}/src/ui`] })
    // While that turn goes on, steer joins it; queue waits for it to end.
    await h.cmd("send", "and smaller", [], { delivery: "steer" })
    await until(() => h.w.fa.steered.length === 1)
    await h.cmd("send", "plain")
    await sleep(50)
    assert.equal(h.w.prompts.length, 1)
    await turn(h, s)
    await until(() => h.w.prompts.length === 2)
    assert.equal(lastPrompt(h).text, "plain")
  } finally {
    await h.close()
  }
})

test("mentions: files and folders of the site's code, best first, at most 20", async () => {
  const h = await boot()
  const work = folder("mentions")
  fs.mkdirSync(path.join(work, "src"), { recursive: true })
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(work, "src", `store${i}.ts`), "")
  fs.writeFileSync(path.join(work, "README.md"), "")
  try {
    await h.ready(work)
    const found = (await h.cmd("mentions", "store")) as { kind: string; id: string }[]
    assert.equal(found.length, 20)
    assert.ok(found.every((o) => o.kind === "file" && /^src\/store\d+\.ts$/.test(o.id)), JSON.stringify(found))
    const folders = (await h.cmd("mentions", "src")) as { kind: string; id: string }[]
    assert.deepEqual([folders[0]!.kind, folders[0]!.id], ["folder", "src"], "the folder itself first")
  } finally {
    await h.close()
  }
})

test("commands, runCommand, cancelQueued: the agent's own, run in the open conversation; a waiting message is taken out of the queue", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    const theirs = async () => ((await h.cmd("commands")) as { name: string; builtin?: true }[]).filter((c) => !c.builtin)
    await until(() => h.snap().can?.compact === true)
    assert.deepEqual(await theirs(), [{ name: "review", description: "Review" }])

    await h.cmd("runCommand", "review", "the hero")
    await until(() => h.w.prompts.length === 1)
    assert.deepEqual([lastPrompt(h).session, lastPrompt(h).text], [s, "/review the hero"])

    // A message sent while that runs waits; taken out, it never goes.
    await h.cmd("send", "never mind")
    const waiting = [...new Set(h.chat().flatMap((e) => (e.type === "item" && e.item.kind === "user" && e.item.pending && e.item.text === "never mind" ? [e.item.id] : [])))]
    assert.equal(waiting.length, 1)
    await h.cmd("cancelQueued", waiting[0])
    await until(() => h.chat().some((e) => e.type === "remove" && e.item === waiting[0]))
    await turn(h, s)
    await sleep(100)
    assert.equal(h.w.prompts.length, 1)
  } finally {
    await h.close()
  }
})

test("cancelNote: a note waiting in the app is stopped and stays on the list; one the agent has is no longer waiting", async () => {
  const h = await boot()
  try {
    await h.ready()
    const [a, b] = [h.note("a"), h.note("b")]
    await until(() => h.notes() === "1:working 2:queued" && h.w.prompts.length === 1)
    await assert.rejects(h.cmd("cancelNote", "nope"), /no longer waiting/)
    await h.cmd("cancelNote", b)
    assert.equal(h.notes(), "1:working 2:failed")
    assert.deepEqual([h.snap().review.notes[1]!.stopped, h.snap().review.notes[1]!.error], [true, "Cancelled."])
    await assert.rejects(h.cmd("cancelNote", a), /no longer waiting/, "only a waiting note")
    await sleep(50)
    assert.equal(h.w.prompts.length, 1, "nothing of it reached the agent")
  } finally {
    await h.close()
  }
})

// ── canvas notes ─────────────────────────────────────────────────────────────────────────────────

const EDITS = [
  { kind: "gap", selector: "main", tag: "main", label: "Section · Plans", prop: "gap", from: "16px", to: "32px" },
  { kind: "hide", selector: "span.badge", tag: "span", label: "Badge · New" },
]
const EDITS_NAME = '2 canvas edits: gap 16px → 32px, removed "Badge · New"'
const canvasNote = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "note",
  note: { id, text: "", url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 }, targets: [], area: null, strokes: [], bounds: { x: 100, y: 100, w: 200, h: 100 }, edits: EDITS, ...extra },
})
/** A picture stand-in whose JPEG is its name (every crop and resize of it is still "it"). */
const shot = (name: string) => {
  const s = { getSize: () => ({ width: 800, height: 600 }), crop: () => s, resize: () => s, toJPEG: () => Buffer.from(name) }
  return s
}

test("a canvas note: before and after pictures, the edits switched off only for the first, then on again", async () => {
  const h = await boot()
  try {
    await h.ready()
    // What the page shows decides the picture: the edits are on until the overlay is told otherwise.
    let on = true
    h.page.capture = () => shot(on ? "after" : "before")
    h.page.sent.length = 0
    h.page.message(canvasNote("c1"))
    await until(() => h.page.sent.some((m) => m.type === "edits"))
    assert.deepEqual(h.page.sent.find((m) => m.type === "edits"), { type: "edits", id: "c1", show: false })
    assert.equal(h.page.sent.some((m) => m.type === "captured"), false, "the note card stays hidden until both pictures are taken")
    assert.equal(h.w.prompts.length, 0)
    // An answer about another note, or about the wrong state, is not the one waited for.
    h.page.message({ type: "edits-shown", id: "other", show: false })
    h.page.message({ type: "edits-shown", id: "c1", show: true })
    await sleep(50)
    assert.equal(h.page.sent.filter((m) => m.type === "edits").length, 1)

    on = false
    h.page.message({ type: "edits-shown", id: "c1", show: false })
    await until(() => h.page.sent.filter((m) => m.type === "edits").length === 2)
    assert.deepEqual(h.page.sent.filter((m) => m.type === "edits")[1], { type: "edits", id: "c1", show: true })
    on = true
    h.page.message({ type: "edits-shown", id: "c1", show: true })

    await until(() => h.w.prompts.length === 1)
    const order = h.page.sent.filter((m) => m.type === "edits" || m.type === "captured").map((m) => (m.type === "edits" ? `edits:${m.show}` : "captured"))
    assert.deepEqual(order, ["edits:false", "edits:true", "captured"])
    const body = lastPrompt(h)
    assert.deepEqual(body.images, ["before", "after", "after"], "the area before, after, and the viewport")
    assert.match(body.text, /^Image 1 is the edited area before the canvas edits and image 2 is the same area after them/m)
    assert.match(body.text, /^1\. Gap in "Section · Plans": 16px → 32px\. \[main\]$/m)
    assert.match(body.text, /made on the live page at 800px wide/)
    // Named the same in the list, on the pin and in the prompt's Note line (which the chat shows).
    const row = h.snap().review.notes[0]!
    assert.equal(row.text, EDITS_NAME)
    assert.deepEqual(row.edits, ['Gap in "Section · Plans": 16px → 32px.', 'Removed "Badge · New".'])
    assert.equal(body.text.split("\n")[1], `Note: ${EDITS_NAME}`)
    const pins = h.page.sent.filter((m) => m.type === "pins").at(-1) as unknown as { pins: { note?: string }[] }
    assert.equal(pins.pins[0]!.note, EDITS_NAME)
  } finally {
    await h.close()
  }
})

test("a canvas note whose overlay never answers: it goes with the after picture only, and the edits are turned back on", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.page.capture = () => shot("after")
    h.page.sent.length = 0
    const started = Date.now()
    h.page.message(canvasNote("c1", { text: "more room", bounds: null }))
    await until(() => h.w.prompts.length === 1, 5000)
    assert.ok(Date.now() - started >= 900, "it did wait for the overlay")
    const order = h.page.sent.filter((m) => m.type === "edits" || m.type === "captured").map((m) => (m.type === "edits" ? `edits:${m.show}` : "captured"))
    assert.deepEqual(order, ["edits:false", "edits:true", "captured"])
    const body = lastPrompt(h)
    assert.deepEqual(body.images, ["after"])
    assert.doesNotMatch(body.text, /before the canvas edits/)
    assert.match(body.text, /^The screenshot was taken after the canvas edits/m)
    assert.equal(body.text.split("\n")[1], "Note: more room")
    assert.equal(h.snap().review.notes[0]!.text, "more room")
    // An answer that comes too late changes nothing.
    h.page.message({ type: "edits-shown", id: "c1", show: false })
    await sleep(50)
    assert.equal(h.page.sent.filter((m) => m.type === "edits").length, 2)
  } finally {
    await h.close()
  }
})

test("a canvas note with no screenshot at all still goes, and a plain note asks the overlay nothing", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.page.sent.length = 0
    h.page.message(canvasNote("c1"))
    h.note("plain")
    await until(() => h.notes() === "1:working 2:queued")
    assert.equal(h.page.sent.some((m) => m.type === "edits"), false)
    await until(() => h.w.prompts.length === 1)
    const first = h.w.prompts[0]!
    assert.deepEqual(first.images, [])
    assert.match(first.text, /^Canvas edits, made on the live page/m)
    assert.doesNotMatch(first.text, /Image 1|screenshot/)
    // Edits the page made up are dropped; with no words either, there is no note.
    h.page.message(canvasNote("c2", { edits: [{ kind: "teleport", selector: "x" }] }))
    await sleep(100)
    assert.equal(h.notes(), "1:working 2:queued")
  } finally {
    await h.close()
  }
})

test("a note the app does not take is answered, so the page never shows it as sent; a second one with the same id is left alone", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.page.sent.length = 0
    const answers = () => h.page.sent.filter((m) => m.type === "captured")
    // Edits the page made up are dropped; with no words either there is nothing to send.
    h.page.message(canvasNote("empty", { edits: [{ kind: "teleport", selector: "x" }] }))
    // Not a note at all.
    h.page.message({ type: "note", note: { id: "broken", text: 5 } })
    h.page.message({ type: "note", note: "nothing" })
    await sleep(50)
    assert.deepEqual(answers(), [
      { type: "captured", id: "empty", ok: false, why: "there is nothing in it the app can send" },
      { type: "captured", id: "broken", ok: false, why: "the app could not read the note" },
    ])
    assert.equal(h.notes(), "")
    // A note that is taken is answered once, without `ok`; its double gets no answer of its own
    // (it has the same id: a refusal would take the first one back in the page).
    h.page.sent.length = 0
    h.note("a", "same")
    h.note("a", "same")
    await until(() => h.w.prompts.length >= 1)
    await sleep(100)
    assert.deepEqual(answers(), [{ type: "captured", id: "same" }])
    assert.equal(h.notes(), "1:working")
  } finally {
    await h.close()
  }
})

test("Retry of a canvas note sends its edits and both pictures again", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    let on = true
    h.page.capture = () => shot(on ? "after" : "before")
    h.page.sent.length = 0
    h.page.message(canvasNote("c1"))
    await until(() => h.page.sent.some((m) => m.type === "edits"))
    on = false
    h.page.message({ type: "edits-shown", id: "c1", show: false })
    await until(() => h.page.sent.filter((m) => m.type === "edits").length === 2)
    on = true
    h.page.message({ type: "edits-shown", id: "c1", show: true })
    await until(() => h.notes() === "1:working" && h.w.prompts.length === 1)
    const first = lastPrompt(h)

    await h.agent.isStopped(s)
    await until(() => h.notes() === "1:failed")
    await h.cmd("retryNote", "c1")
    await until(() => h.notes() === "1:working" && h.w.prompts.length === 2)

    const again = lastPrompt(h)
    assert.equal(again.text, first.text)
    assert.match(again.text, /^2\. Removed "Badge · New"\. \[span\.badge\]$/m)
    assert.deepEqual(again.images, first.images)
    assert.equal(again.images.length, 3)
    assert.equal(h.page.sent.filter((m) => m.type === "edits").length, 2, "no second round of pictures")
    assert.deepEqual(h.snap().review.notes[0]!.edits, ['Gap in "Section · Plans": 16px → 32px.', 'Removed "Badge · New".'])
  } finally {
    await h.close()
  }
})

test("a note that is only new CSS rules is a note: named, pictured before and after, sent fenced", async () => {
  const h = await boot()
  try {
    await h.ready()
    let on = true
    h.page.capture = () => shot(on ? "after" : "before")
    h.page.sent.length = 0
    const css = ".bg-stripes {\n  --stripe-period: 6px;\n}"
    h.page.message(canvasNote("s1", { edits: undefined, css, bounds: null }))
    await until(() => h.page.sent.some((m) => m.type === "edits"))
    on = false
    h.page.message({ type: "edits-shown", id: "s1", show: false })
    await until(() => h.page.sent.filter((m) => m.type === "edits").length === 2)
    on = true
    h.page.message({ type: "edits-shown", id: "s1", show: true })
    await until(() => h.w.prompts.length === 1)
    const body = lastPrompt(h)
    assert.deepEqual(body.images, ["before", "after"])
    assert.ok(body.text.includes(`New CSS rules to add (put them where this project keeps its styles, renamed to its conventions if needed):\n\`\`\`css\n${css}\n\`\`\`\n`))
    assert.equal(body.text.split("\n")[1], "Note: 1 canvas edit: 1 new CSS rule")
    assert.deepEqual(h.snap().review.notes[0], { id: "s1", n: 1, text: "1 canvas edit: 1 new CSS rule", status: "working", lane: "main", edits: ["1 new CSS rule."], sent: true, session: h.snap().session!.id, pictures: "before" })
    // Too long to be carried, and nothing else in the note: there is no note.
    h.page.message(canvasNote("s2", { edits: undefined, css: "x".repeat(8001) }))
    await sleep(100)
    assert.equal(h.notes(), "1:working")
  } finally {
    await h.close()
  }
})

// ── the app's own slash commands ─────────────────────────────────────────────────────────────────

test("commands: the app's own come first and win over the agent's of the same name; an agent that offers none still has them", async () => {
  const h = await boot()
  try {
    await h.ready()
    await until(() => h.snap().can?.compact === true)
    const list = (await h.cmd("commands")) as { name: string; description?: string; builtin?: true }[]
    assert.deepEqual(list.map((c) => `${c.builtin ? "*" : ""}${c.name}`), ["*compact", "*new", "*undo", "*redo", "*rename", "*fork", "*checkpoint", "review"])
    assert.ok(list.every((c) => !c.builtin || c.description), "each says what it does")
  } finally {
    await h.close()
  }
  // An agent that says no commands has no /compact to be asked: the app's own leaves it out too.
  const none = await boot({ agent: (w) => (w.fa.commands = []) })
  try {
    await none.ready()
    await sleep(100)
    const list = (await none.cmd("commands")) as { name: string }[]
    assert.deepEqual(list.map((c) => c.name), ["new", "undo", "redo", "rename", "fork", "checkpoint"])
  } finally {
    await none.close()
  }
})

test("/rename, /fork and /new: the name is the conversation's, a fork becomes the site's conversation, /new starts one", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    await assert.rejects(Promise.resolve(h.cmd("runCommand", "rename", "  ")), /Type the new name after \/rename\./)
    assert.deepEqual(await h.cmd("runCommand", "rename", " Pricing page "), { say: 'Renamed to "Pricing page".' })
    assert.equal(h.snap().session!.title, "Pricing page")

    const forked = (await h.cmd("runCommand", "fork", "")) as { say: string }
    assert.match(forked.say, /^This is a copy\./)
    const copy = h.snap().session!.id
    assert.notEqual(copy, s)
    assert.deepEqual(h.w.fa.calls.filter((c) => c.method === "session/fork").map((c) => c.params.sessionId), [s])
    h.note("goes to the copy")
    await until(() => h.w.prompts.length === 1)
    assert.equal(h.w.prompts[0]!.session, copy)

    const creates = h.w.creates
    await h.cmd("runCommand", "new", "")
    assert.equal(h.w.creates, creates + 1)
    assert.notEqual(h.snap().session!.id, copy)
  } finally {
    await h.close()
  }
})

test("the context: its count is the agent's, against the window it says; a new conversation starts with nothing counted", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    const context = () => h.snap().context
    assert.equal(context(), undefined, "nothing has been counted yet")
    h.note("a")
    await until(() => h.w.prompts.length === 1)
    await (await h.agent.turn(s)).usage(124000, 200000)
    await until(() => !!context())
    assert.deepEqual(context(), { used: 124000, limit: 200000 })
    await (await h.agent.turn(s)).usage(130000, 200000)
    await until(() => context()?.used === 130000)
    await turn(h, s)
    await until(() => h.notes() === "1:done")
    assert.deepEqual(context(), { used: 130000, limit: 200000 })

    // Another conversation starts with nothing counted.
    await h.cmd("newSession")
    await until(() => !!h.snap().session && h.snap().session!.id !== s)
    assert.equal(context(), undefined)
  } finally {
    await h.close()
  }
})

// ── the model new conversations start with ───────────────────────────────────────────────────────

/** An agent that says its models before any conversation (session/options), as Claude Code's adapter does. */
const MODELS = [
  { value: "acme/text-only", name: "Text only" },
  { value: "acme/vision", name: "Vision" },
  { value: "acme/vision-mini", name: "Vision mini" },
]
async function withModels(models: { value: string; name: string }[], settings: Record<string, unknown> = {}) {
  const h = await boot({
    settings: { ...savedSite(), defaultModel: undefined, ...settings },
    agent: (w) => {
      w.fa.models = models
      w.fa.capabilities = { ...w.fa.capabilities, sessionCapabilities: { ...(w.fa.capabilities.sessionCapabilities as object), options: {} } }
    },
  })
  await h.connect()
  const created = () => h.w.fa.calls.filter((c) => c.method === "session/set_config_option" && c.params.configId === "model").map((c) => c.params.value)
  return { h, created }
}

test("first launch with an agent of several models: the app asks, makes no conversation meanwhile, and the first one starts on the answer", async () => {
  const { h, created } = await withModels(MODELS)
  try {
    await until(() => !!h.snap().modelChoice)
    assert.deepEqual(h.snap().modelChoice, { suggested: { providerID: "acme", id: "acme/text-only" } }, "the first is offered: every one takes screenshots")
    await sleep(100)
    assert.equal(h.snap().session, null)
    assert.equal(h.w.creates, 0, "no conversation on a model nobody chose")

    await assert.rejects(Promise.resolve(h.cmd("setDefaultModel", { providerID: "acme", id: "gone" })), /does not offer that model/)
    await assert.rejects(Promise.resolve(h.cmd("setDefaultModel", null)), /does not offer that model/)
    assert.ok(h.snap().modelChoice, "still asking")

    await h.cmd("setDefaultModel", { providerID: "acme", id: "acme/vision-mini" })
    assert.equal(h.snap().modelChoice, undefined)
    assert.deepEqual(h.snap().defaultModel, { providerID: "acme", id: "acme/vision-mini" })
    await until(() => !!h.snap().session)
    assert.equal(h.w.creates, 1)
    assert.deepEqual(created(), ["acme/vision-mini"])

    // Changed later (the settings dialog): the open conversation stays as it is, the next new one follows.
    const open = h.snap().session!.id
    await h.cmd("setDefaultModel", { providerID: "acme", id: "acme/vision" })
    assert.equal(h.snap().session!.id, open)
    await h.cmd("newSession")
    assert.deepEqual(created(), ["acme/vision-mini", "acme/vision"])
    await sleep(400) // the store's debounce
    assert.deepEqual(settingsOf(h).defaultModel, { providerID: "acme", id: "acme/vision" })
  } finally {
    await h.close()
  }
})

test("the picker under the box shows the model the agent says the conversation is on, not only the one asked for", async () => {
  const { h } = await withModels(MODELS, { defaultModel: { providerID: "acme", id: "acme/vision" } })
  try {
    await until(() => !!h.snap().session)
    assert.equal(h.snap().session!.model?.id, "acme/vision")
    // Asked for the small one, the agent keeps the conversation on another.
    h.w.fa.swap["acme/vision-mini"] = "acme/text-only"
    await h.cmd("setModel", { providerID: "acme", id: "acme/vision-mini" })
    assert.equal(h.snap().session!.model?.id, "acme/text-only")
    // What was asked for is still the person's choice for new conversations.
    assert.deepEqual(h.snap().defaultModel, { providerID: "acme", id: "acme/vision-mini" })
  } finally {
    await h.close()
  }
})

test("a saved model the agent still offers: nothing is asked", async () => {
  const { h, created } = await withModels(MODELS, { defaultModel: { providerID: "acme", id: "acme/vision" } })
  try {
    await until(() => !!h.snap().session)
    assert.equal(h.snap().modelChoice, undefined)
    assert.deepEqual(created(), ["acme/vision"])
  } finally {
    await h.close()
  }
})

test("a saved model the agent no longer offers: the app asks again and says which one went", async () => {
  const { h } = await withModels(MODELS, { defaultModel: { providerID: "retired", id: "old-model", variant: "high" } })
  try {
    await until(() => !!h.snap().modelChoice)
    assert.deepEqual(h.snap().modelChoice, { suggested: { providerID: "acme", id: "acme/text-only" }, previous: { providerID: "retired", id: "old-model", variant: "high" } })
    await h.cmd("setDefaultModel", { providerID: "acme", id: "acme/vision" })
    assert.equal(h.snap().modelChoice, undefined)
    await until(() => !!h.snap().session)
    // Another agent, another list: asked as for a first one. The model chosen for the one before is its own.
    const other = h.agents("fake-agent --other")
    other.fa.models = [{ value: "zeta/a", name: "A" }, { value: "zeta/b", name: "B" }]
    other.fa.capabilities = { ...other.fa.capabilities, sessionCapabilities: { ...(other.fa.capabilities.sessionCapabilities as object), options: {} } }
    await h.connect("fake-agent --other")
    await until(() => !!h.snap().modelChoice)
    assert.deepEqual(h.snap().modelChoice, { suggested: { providerID: "zeta", id: "zeta/a" } })
    await Promise.resolve(h.cmd("disconnect")).catch(() => undefined)
    assert.equal(h.snap().modelChoice, undefined)
  } finally {
    await h.close()
  }
})

test("one model: nothing is asked, it is saved, and setup goes on", async () => {
  const one = await withModels([{ value: "acme/only", name: "Only" }])
  try {
    await until(() => !!one.h.snap().session)
    assert.equal(one.h.snap().modelChoice, undefined)
    await sleep(400)
    assert.deepEqual(settingsOf(one.h).defaultModel, { providerID: "acme", id: "acme/only" }, "nothing to choose between: it is saved")
  } finally {
    await one.h.close()
  }
})

test("the top bar's switch: Preview, Notes and Edit, and the brush, go to the page; what the page says back is what shows", async () => {
  const h = await boot()
  try {
    await h.ready()
    const review = () => {
      const r = h.snap().review
      return `${r.mode}${r.brush ? "+brush" : ""}${r.enabled ? "" : " off"}`
    }
    const sent = () => h.page.sent.filter((m) => m.type === "mode" || m.type === "enabled").map((m) => JSON.stringify(m))
    h.page.message({ type: "ready" })
    assert.equal(review(), "notes")

    h.page.sent.length = 0
    await h.cmd("setMode", "edit")
    assert.deepEqual([review(), sent()], ["edit", ['{"type":"mode","mode":"canvas"}']])
    // The overlay's own keys (mod+U/P/O/I, Esc) change it too.
    h.page.message({ type: "mode", mode: "notes", brush: false })
    assert.equal(review(), "notes")
    h.page.message({ type: "mode", mode: "canvas", brush: false })
    assert.equal(review(), "edit")

    // Preview is review off; the page keeps its mode for when review comes back.
    h.page.sent.length = 0
    await h.cmd("setMode", "preview")
    assert.deepEqual([review(), sent()], ["preview off", ['{"type":"enabled","enabled":false}']])
    await h.cmd("toggleReview")
    assert.equal(review(), "edit")

    // The brush belongs to notes mode, and turns review on.
    await h.cmd("setMode", "preview")
    h.page.sent.length = 0
    await h.cmd("toggleBrush")
    assert.deepEqual([review(), sent()], ["notes+brush", ['{"type":"enabled","enabled":true}', '{"type":"mode","brush":true}']])
    h.page.message({ type: "mode", mode: "notes", brush: true })
    await h.cmd("toggleBrush")
    assert.equal(review(), "notes")
    await h.cmd("toggleBrush")
    await h.cmd("setMode", "edit")
    assert.equal(review(), "edit", "edit mode has no brush")

    // A new document starts in notes mode until its overlay says otherwise (a reload while editing).
    h.page.message({ type: "ready" })
    assert.equal(review(), "notes")
    h.page.message({ type: "mode", mode: "canvas", brush: false })
    assert.equal(review(), "edit")
    // Anything else in the message is not a mode.
    h.page.message({ type: "mode", mode: "everything", brush: "yes" })
    assert.equal(review(), "notes")
  } finally {
    await h.close()
  }
})

test("an agent's name: saved with it, kept when the same agent is started again, its own for another one", async () => {
  const h = await boot()
  try {
    await h.ready()
    assert.equal(h.snap().serverName, "fake-agent", "until it is named, it goes by its program's name")
    assert.deepEqual(h.snap().harness, { kind: "custom", name: "fake-agent", here: true })
    await h.cmd("setServerName", "  Studio   Mac ")
    assert.equal(h.snap().serverName, "Studio Mac")
    assert.equal(h.snap().harness?.name, "Studio Mac", "the reviewer's name wins in the window too")
    const listed = (await h.cmd("servers")) as { current: boolean; kind: string; here: boolean; name?: string }[]
    assert.deepEqual(listed.filter((x) => x.current).map((x) => [x.kind, x.here, x.name]), [["custom", true, "Studio Mac"]])
    const saved = async () => {
      await sleep(400) // the store's debounce
      return settingsOf(h).server as { name?: string }
    }
    assert.equal((await saved()).name, "Studio Mac")
    await h.cmd("setServerName", "x".repeat(200))
    assert.equal(h.snap().serverName?.length, 60, "a label, not a description")
    await h.cmd("setServerName", "Studio Mac")
    // the same agent again: still named
    await h.connect()
    assert.equal(h.snap().serverName, "Studio Mac")
    // an empty name goes back to its own
    await h.cmd("setServerName", "   ")
    assert.equal(h.snap().serverName, "fake-agent")
    assert.equal((await saved()).name, undefined)
    // a name does not follow to another agent
    await h.cmd("setServerName", "Studio Mac")
    await h.connect("fake-agent --other")
    assert.equal(h.snap().serverName, "fake-agent")
    await h.cmd("disconnect")
    assert.equal(h.snap().harness, undefined, "nothing is in use")
    await assert.rejects(Promise.resolve(h.cmd("setServerName", "x")), /Connect/)
  } finally {
    await h.close()
  }
})

// ── conversations: what they are called, and the list ──────────────────────────────────────────

test("a conversation is named after the first thing said in it, once; a name somebody gave is kept", async () => {
  const h = await boot({ agent: (w) => (w.fa.capabilities = { ...w.fa.capabilities, sessionCapabilities: { ...(w.fa.capabilities.sessionCapabilities as object), title: {} } }) })
  const titled = (s: string) => h.w.fa.calls.filter((c) => c.method === "session/set_title" && c.params.sessionId === s).map((c) => c.params.title).at(-1)
  try {
    const s = await h.ready()
    assert.equal(h.snap().session!.title, "Review · site.test", "until something is said, it is called where it is")
    h.note("make the  buy button bigger.\nand greener")
    await until(() => h.snap().session!.title === "Make the buy button bigger")
    await until(() => titled(s) === "Make the buy button bigger", 2000)
    assert.deepEqual(h.snap().sessions.map((x) => [x.title, x.notes, x.said]), [["Make the buy button bigger", 1, "make the  buy button bigger.\nand greener"]])
    await turn(h, s)
    await until(() => h.notes() === "1:done")
    h.note("the footer is too tall")
    await until(() => h.w.prompts.length === 2)
    await sleep(50)
    assert.equal(h.snap().session!.title, "Make the buy button bigger", "the second note does not rename it")
    await turn(h, s)

    // A new conversation, named by a message typed into the chat; then by hand, which stays.
    await h.cmd("newSession")
    await until(() => !!h.snap().session && h.snap().session!.id !== s)
    const second = h.snap().session!.id
    await h.cmd("send", "why is the header sticky?")
    await until(() => h.snap().session!.title === "Why is the header sticky?")
    await h.cmd("renameSession", second, "  Header   questions ")
    assert.equal(h.snap().session!.title, "Header questions")
    await turn(h, second)
    await h.cmd("send", "and the footer?")
    await sleep(50)
    assert.equal(titled(second), "Header questions")
    assert.equal(h.snap().session!.title, "Header questions")
    await assert.rejects(h.cmd("renameSession", second, "   "), /Type a name/)
  } finally {
    await h.close()
  }
})

test("the list: a pin goes first and is saved; archiving or deleting the open conversation opens the most recent other one", async () => {
  const h = await boot({ agent: (w) => (w.fa.capabilities = { ...w.fa.capabilities, sessionCapabilities: { ...(w.fa.capabilities.sessionCapabilities as object), archive: {} } }) })
  try {
    const first = await h.ready()
    await h.cmd("newSession")
    await until(() => !!h.snap().session && h.snap().session!.id !== first)
    const second = h.snap().session!.id
    await sleep(5)
    await h.cmd("newSession")
    await until(() => ![first, second, undefined].includes(h.snap().session?.id))
    const third = h.snap().session!.id
    await until(() => h.snap().sessions.length === 3)
    assert.deepEqual(h.snap().sessions.map((x) => x.id), [third, second, first], "newest first")

    await h.cmd("pinSession", first, true)
    await until(() => h.snap().sessions[0]!.id === first)
    assert.deepEqual(h.snap().sessions.map((x) => [x.id, !!x.pinned]), [[first, true], [third, false], [second, false]])
    const saved = () => settingsOf(h).sites?.[SITE]
    await until(() => saved()?.pinned?.[0] === first)

    // Archive the open one: out of the list, kept by the agent, and the site is on another.
    h.note("a")
    await until(() => h.w.prompts.length === 1)
    await h.cmd("archiveSession", third, true)
    await until(() => h.snap().session?.id === second)
    assert.deepEqual(h.snap().sessions.map((x) => x.id), [first, second])
    assert.equal(h.notes(), "1:working", "its note still runs")
    assert.deepEqual(((await h.cmd("archivedSessions")) as { id: string; archived?: boolean }[]).map((x) => [x.id, x.archived]), [[third, true]])
    await h.cmd("archiveSession", third, false)
    await until(() => h.snap().sessions.length === 3)
    assert.deepEqual(await h.cmd("archivedSessions"), [])

    // Delete the open one: the most recent other one opens, and no new conversation is made.
    const made = h.w.creates
    await h.cmd("deleteSession", second)
    await until(() => !!h.snap().session && h.snap().session!.id !== second)
    await sleep(50)
    assert.equal(h.snap().session!.id, third)
    assert.equal(h.w.creates, made)
    assert.deepEqual(h.snap().sessions.map((x) => x.id), [first, third])

    // Delete a pinned one that is not open: its pin goes with it, the site stays where it is.
    await h.cmd("deleteSession", first)
    await until(() => saved()?.pinned === undefined)
    assert.equal(h.snap().session!.id, third)
    assert.deepEqual(h.snap().sessions.map((x) => x.id), [third])

    // Delete the last one, with a note in flight: the note fails, and the site gets a new one.
    await h.cmd("deleteSession", third)
    await until(() => h.notes() === "1:failed")
    await until(() => !!h.snap().session && h.snap().session!.id !== third)
    assert.equal(h.w.creates, made + 1)
  } finally {
    await h.close()
  }
})

// ── a finished note: the diff, taking it back; checkpoints; the repo ────────────────────────────

/** A git repository with one commit on branch "polish", and a.css of 20 lines in it. */
function gitRepo(name: string) {
  const work = folder(name)
  const git = (...args: string[]) => execFileSync("git", ["-C", work, ...args], { stdio: "ignore" })
  git("init", "-q", "-b", "polish")
  fs.writeFileSync(path.join(work, "a.css"), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n")
  git("add", ".")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first")
  return work
}

/** A site whose folder (20 lines of a.css) is on this computer, its conversation open; the app
 *  keeps its own history of the folder at every turn of the agent's. */
async function historyOf(opts: { work?: string } = {}) {
  const work = opts.work ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b42-work-")))
  const css = path.join(work, "a.css")
  if (!fs.existsSync(css)) fs.writeFileSync(css, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n")
  const h = await boot()
  const root = path.join(h.dir, "snapshots")
  const log = () => {
    // The work folder's own (snapshots.ts: its name, then a hash of its path).
    const shadow = fs.existsSync(root) ? fs.readdirSync(root).find((d) => d.startsWith(`${path.basename(work)}-`) && d.endsWith(".git")) : undefined
    try {
      return JSON.parse(fs.readFileSync(path.join(root, shadow ?? "-", "b42.json"), "utf8")) as { turns: Array<{ untrusted?: true; shared?: true }>; restores: Array<{ told?: true }> }
    } catch {
      return { turns: [], restores: [] }
    }
  }
  const s = await h.ready(work)
  return {
    h,
    s,
    work,
    root,
    log,
    line: (n: number) => fs.readFileSync(css, "utf8").split("\n")[n - 1],
    edit(n: number, to: string) {
      const all = fs.readFileSync(css, "utf8").split("\n")
      all[n - 1] = to
      fs.writeFileSync(css, all.join("\n"))
    },
    /** The agent's turn on the newest message: it changes the files while it works; resolves
     *  once `done` notes are, and the app has kept `kept` turns. */
    async agentTurn(change: () => void, done: string, kept?: number) {
      const l = await h.agent.turn(s)
      await sleep(100)
      change()
      l.end()
      await until(() => h.notes() === done && (kept === undefined || log().turns.length === kept), 8000)
    },
    async close() {
      await h.close()
      if (!opts.work) fs.rmSync(work, { recursive: true, force: true })
    },
  }
}
type History = Awaited<ReturnType<typeof historyOf>>

/** Two notes, each one turn: note 1 changes line 2, note 2 line 18. */
async function twoNotes(t: History) {
  const a = t.h.note("a")
  await until(() => t.h.w.prompts.length === 1)
  await t.agentTurn(() => t.edit(2, "line 2 NOTE ONE"), "1:done", 1)
  const b = t.h.note("b")
  await until(() => t.h.w.prompts.length === 2)
  await t.agentTurn(() => t.edit(18, "line 18 NOTE TWO"), "1:done 2:done", 2)
  return { a, b }
}

test("a finished note shows what changed for it, and is taken back by asking the agent when later work changed the same lines", async () => {
  const t = await historyOf()
  const { h, s } = t
  try {
    const a = h.note("a")
    await until(() => h.w.prompts.length === 1)
    await t.agentTurn(() => t.edit(2, "line 2 NOTE ONE"), "1:done", 1)
    h.note("b")
    await until(() => h.w.prompts.length === 2)
    await t.agentTurn(() => t.edit(2, "line 2 NOTE TWO"), "1:done 2:done", 2)
    const row = () => h.snap().review.notes[0]!
    assert.equal(row().sent, true)

    const diff = (await h.cmd("noteDiff", a)) as { file: string; patch: string; additions: number; deletions: number }[]
    assert.deepEqual(diff.map((f) => [f.file, f.additions, f.deletions]), [["a.css", 1, 1]])
    assert.match(diff[0]!.patch, /-line 2\n\+line 2 NOTE ONE/)

    // Note 2 changed the same line since: the app can't put back note 1's alone, so the agent is
    // asked, in the note's conversation.
    const reloads = () => h.page.sent.filter((m) => m.type === "RELOAD").length
    const shown = reloads()
    assert.equal(await h.cmd("takeBackWay", a), "asked")
    assert.equal(await h.cmd("takeBackNote", a), "asked")
    await until(() => h.w.prompts.length === 3)
    assert.match(lastPrompt(h).text, /note 1/)
    // No note is finished by that run, but the files change in it: the page is loaded again
    // when it ends, and only then.
    await sleep(50)
    assert.equal(reloads(), shown)
    await turn(h, s)
    await until(() => reloads() === shown + 1)
    // A later run that takes nothing back leaves the page alone.
    await h.cmd("send", "thanks")
    await until(() => h.w.prompts.length === 4)
    await turn(h, s)
    await sleep(100)
    assert.equal(reloads(), shown + 1)
    assert.equal(h.w.prompts[2]!.session, s)
    assert.deepEqual([row().status, row().takenBack], ["done", "asked"])
    await assert.rejects(h.cmd("takeBackNote", a), /already taken back/)
    await assert.rejects(h.cmd("noteDiff", "nope"), /has not reached the agent/)
    // The verdict is saved with the note.
    await until(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(h.dir, "reviews", `${encodeURIComponent(SITE)}.json`), "utf8")).notes[0].takenBack === "asked"
      } catch {
        return false
      }
    })
  } finally {
    await t.close()
  }
})

test("a note's row names its conversation; take back says which way it will go, and does not go the other way", async () => {
  const t = await historyOf()
  const { h, s: old } = t
  try {
    const { a, b } = await twoNotes(t)
    await h.cmd("newSession")
    const neu = h.snap().session!.id
    h.note("c")
    await until(() => h.w.prompts.length === 3)
    // Note 3 changes note 2's line again.
    const l = await h.agent.turn(neu)
    t.edit(18, "line 18 NOTE THREE")
    l.end()
    await until(() => h.notes() === "1:done 2:done 3:done" && t.log().turns.length === 3)

    const [ra, rb, rc] = h.snap().review.notes
    assert.deepEqual([ra!.session, rb!.session, rc!.session], [old, old, neu], "each note says where it went, the open conversation or not")
    // Note 1's line is its own: put back from the app's history. Note 2's line was changed since: asked.
    assert.equal(await h.cmd("takeBackWay", a), "restored")
    assert.equal(await h.cmd("takeBackWay", b), "asked")
    assert.equal(h.w.prompts.length, 3, "asking how changes nothing")
    assert.deepEqual(h.snap().review.notes.map((n) => n.takenBack), [undefined, undefined, undefined])

    // The question said one way; by now it would go the other: nothing is done.
    await assert.rejects(h.cmd("takeBackNote", a, "asked"), /changed meanwhile/)
    await assert.rejects(h.cmd("takeBackNote", b, "restored"), /changed meanwhile/)
    assert.equal(h.w.prompts.length, 3)
    assert.equal(t.line(2), "line 2 NOTE ONE")

    assert.equal(await h.cmd("takeBackNote", a, "restored"), "restored")
    assert.equal(t.line(2), "line 2")
    assert.equal(await h.cmd("takeBackNote", b, "asked"), "asked")
    await until(() => h.w.prompts.length === 4)
    assert.equal(h.w.prompts[3]!.session, old, "the agent of the note's own conversation is asked")
    assert.deepEqual(h.snap().review.notes.map((n) => n.takenBack), ["restored", "asked", undefined])

    await assert.rejects(h.cmd("takeBackWay", b), /already taken back/)
    await assert.rejects(h.cmd("takeBackWay", "nope"), /Only a finished note/)
  } finally {
    await t.close()
  }
})

test("a checkpoint is a line in the conversation, kept by the app; the repo's branch and changes are told, and a commit is asked of the agent", async () => {
  const work = gitRepo("checkpoint")
  fs.appendFileSync(path.join(work, "a.css"), "line 21\n")
  fs.writeFileSync(path.join(work, "new.css"), "a\nb\nc\nd\n")
  const h = await boot()
  try {
    const s = await h.ready(work)
    await until(() => !!h.snap().repo)
    assert.deepEqual(h.snap().repo, { branch: "polish", changes: [{ file: "a.css", additions: 1, deletions: 0, status: "modified" }, { file: "new.css", additions: 4, deletions: 0, status: "added" }], total: 2 })

    await h.cmd("addCheckpoint", "  before  the hero ")
    const marker = h.chat().flatMap((e) => (e.type === "item" && e.item.kind === "marker" && e.item.checkpoint ? [e.item] : []))[0]!
    assert.equal(marker.text, "before the hero")
    await assert.rejects(h.cmd("returnToCheckpoint", marker.checkpoint), /The agent has changed no file since this checkpoint/)
    await assert.rejects(h.cmd("returnToCheckpoint", "nope"), /checkpoint is gone/)
    // It comes back with the conversation when that is read again.
    await h.cmd("openSession", s)
    await until(() => h.chat().some((e) => e.type === "reset" && e.items.some((i) => i.kind === "marker" && i.checkpoint === marker.checkpoint)))
    await h.cmd("removeCheckpoint", marker.checkpoint)
    assert.ok(h.chat().some((e) => e.type === "remove" && e.item === marker.id))

    await h.cmd("commitChanges", "Tidy the hero\n\n- more air")
    await until(() => h.w.prompts.length === 1)
    assert.equal(h.w.prompts[0]!.session, s)
    await assert.rejects(h.cmd("commitChanges", "  "), /Write what the commit is/)
  } finally {
    await h.close()
  }
})

test("the newest note is taken back and a checkpoint is returned to, from the app's history: the page shows the files again, and a note taken back gets no second picture", async () => {
  const t = await historyOf()
  const { h, s } = t
  try {
    h.page.capture = () => shot("p")
    h.page.viewport = { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 }
    const row = (id: string) => h.snap().review.notes.find((r) => r.id === id)!
    const reloads = () => h.page.sent.filter((m) => m.type === "RELOAD").length

    // A finished note is pictured again a moment later.
    const a = h.note("a")
    await until(() => h.w.prompts.length === 1)
    await t.agentTurn(() => t.edit(2, "line 2 NOTE ONE"), "1:done", 1)
    assert.equal(row(a).pictures, "before")
    h.page.sent.length = 0
    await until(() => row(a).pictures === "both", 6000)
    // For that picture the overlay is asked, by message: how wide the page is, then to take
    // the layer out and put the page where the note was made, then to give both back.
    const frames = h.page.sent.filter((m) => m.type === "frame").map(({ id: _, type: __, ...ask }) => ask)
    assert.deepEqual(frames, [{}, { hold: true, scroll: [0, 0] }, { hold: false }])
    // A note is shown on the page by its pin, which the overlay finds; an unknown one is not asked for.
    await h.cmd("showNote", a)
    await h.cmd("showNote", "nope")
    assert.deepEqual(h.page.sent.filter((m) => m.type === "show"), [{ type: "show", id: a }])

    await h.cmd("addCheckpoint", "after a")
    const cp = h.chat().flatMap((e) => (e.type === "item" && e.item.kind === "marker" && e.item.checkpoint ? [e.item.checkpoint] : []))[0]!

    // The newest one, taken back before its second picture: the files go back, the page is
    // loaded again, and no picture of an area that is as it was before the note.
    const b = h.note("b")
    await until(() => h.w.prompts.length === 2)
    await t.agentTurn(() => t.edit(18, "line 18 NOTE TWO"), "1:done 2:done", 2)
    const shown = reloads()
    assert.equal(await h.cmd("takeBackNote", b), "restored")
    assert.equal(t.line(18), "line 18")
    assert.equal(reloads(), shown + 1)
    await sleep(2600)
    assert.equal(row(b).pictures, "before")
    assert.equal(row(a).pictures, "both")

    // /redo brings it back; then back to the checkpoint: every turn after it, files only.
    await h.cmd("runCommand", "redo", "")
    assert.equal(t.line(18), "line 18 NOTE TWO")
    assert.deepEqual(await h.cmd("returnToCheckpoint", cp), { taken: 1 })
    assert.deepEqual([t.line(2), t.line(18)], ["line 2 NOTE ONE", "line 18"])
    assert.equal(reloads(), shown + 3)
    void s
  } finally {
    await t.close()
  }
})

test("the conversation's pictures reach the window as b42-img addresses, served by main, and nothing else is", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.page.capture = () => shot("the area")
    h.note("make it blue")
    await until(() => h.w.prompts.length === 1)
    await turn(h, s)
    await until(() => h.notes() === "1:done")
    await h.cmd("send", "and this", [{ name: "p.png", uri: `data:image/png;base64,${Buffer.from("pasted").toString("base64")}` }])
    await until(() => h.w.prompts.length === 2)
    await turn(h, s)
    await until(() => h.snap().session?.busy === false)
    h.shell.sent.length = 0
    h.core.chat()
    await until(() => h.chat().some((e) => e.type === "reset"))
    const reset = h.chat().find((e) => e.type === "reset") as Extract<ChatEvent, { type: "reset" }>
    assert.equal(JSON.stringify(reset).includes(";base64,"), false, "no picture travels in the reset")
    const users = reset.items.filter((i) => i.kind === "user")
    const images = users.flatMap((i) => (i.kind === "user" ? i.images : []))
    // The note's two (its area and the viewport), and the one pasted with the typed message.
    assert.equal(images.length, 3)
    assert.ok(images.every((i) => i.src.startsWith(`b42-img://pic/${s}/`)), JSON.stringify(images))
    const serve = (url: string) => h.core.picture(url)
    const got = await serve(images[0]!.src)
    assert.equal(got.status, 200)
    assert.equal(got.headers.get("content-type"), "image/jpeg")
    assert.equal(Buffer.from(await got.arrayBuffer()).toString(), "the area")
    assert.equal(Buffer.from(await (await serve(images[2]!.src)).arrayBuffer()).toString(), "pasted")
    assert.equal((await serve(`b42-img://pic/${s}/msg_unknown/0`)).status, 404)
    assert.equal((await serve(images[2]!.src.replace(/\/0$/, "/1"))).status, 404)
  } finally {
    await h.close()
  }
})

test("the page as a phone's: the page is told, the window is told, and the next start remembers", async () => {
  const h = await boot()
  const devices = (shell: TestShell) => shell.page.calls.filter((c) => c[0] === "device").map((c) => c[1])
  try {
    assert.equal(h.snap().page.device, "desktop")
    assert.deepEqual(devices(h.shell), []) // a page is a desktop's until told otherwise
    await h.cmd("setDevice", "phone")
    assert.equal(h.snap().page.device, "phone")
    assert.deepEqual(devices(h.shell), ["phone"])
    await h.cmd("setDevice", "phone") // already so: the page is not asked again
    await h.cmd("setDevice", "tablet") // not a device: a desktop's
    assert.deepEqual(devices(h.shell), ["phone", "desktop"])
    await h.cmd("setDevice", "phone")
    // Which phone: the usual one until another is chosen; the page is told of a new one at once.
    const phones = (shell: TestShell) => shell.page.calls.filter((c) => c[0] === "phone").map((c) => c[1])
    assert.equal(h.snap().page.phone, PHONE.id)
    assert.equal(phones(h.shell).at(-1), PHONE.id)
    await h.cmd("setPhone", "iphone-se")
    assert.equal(h.snap().page.phone, "iphone-se")
    assert.equal(phones(h.shell).at(-1), "iphone-se")
    const told = h.shell.page.calls.length
    await h.cmd("setPhone", "iphone-se") // already so
    assert.equal(h.shell.page.calls.length, told)
    await h.cmd("setPhone", "a-brick") // not a phone on the list: the usual one
    assert.equal(h.snap().page.phone, PHONE.id)
    // As a desktop's the choice is kept, and the page is not told until it is a phone's again.
    await h.cmd("setDevice", "desktop")
    await h.cmd("setPhone", "pixel-11")
    assert.equal(phones(h.shell).at(-1), PHONE.id)
    await h.cmd("setDevice", "phone")
    assert.equal(phones(h.shell).at(-1), "pixel-11")
    // A second start on the same profile, as after a relaunch (once the setting is on disk).
    await until(() => fs.existsSync(path.join(h.dir, "settings.json")) && /"phone":\s*"pixel-11"/.test(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8")) && /"device":\s*"phone"/.test(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8")))
    const again = testShell(h.dir)
    assert.equal(again.core.snapshot().page.device, "phone")
    assert.equal(again.core.snapshot().page.phone, "pixel-11")
    assert.deepEqual(devices(again), ["phone"])
    assert.deepEqual(phones(again), ["pixel-11"])
    await again.core.dispose()
  } finally {
    await h.close()
  }
})

test("a dock the window draws: the overlay is told after every state, its views reach the window, and the window's acts reach it; nothing for a dock that is not hosted", async () => {
  const h = await boot({ docks: ["motion"] })
  const toOverlay = (type: string) => h.page.sent.filter((m) => m.type === type)
  const toWindow = () => h.shell.sent.filter((x) => x[0] === "panel").map((x) => x[1])
  try {
    await h.ready()
    assert.deepEqual(h.snap().review.docks, ["motion"])
    h.page.message({ type: "ready", url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 } })
    const order = h.page.sent.map((m) => m.type)
    assert.deepEqual(order.slice(order.lastIndexOf("state")), ["state", "docks"])
    assert.deepEqual(toOverlay("docks").at(-1), { type: "docks", hosted: ["motion"] })
    // overlay → window: as it came, and only for the hosted dock.
    h.page.message({ type: "panel", panel: "motion", view: { open: "spin" } })
    h.page.message({ type: "panel", panel: "motion", pong: 5 })
    h.page.message({ type: "panel", panel: "motion", part: { clock: { pos: 0.5 } } })
    h.page.message({ type: "panel", panel: "canvas", view: { tree: [] } })
    h.page.message({ type: "panel", panel: "nope", view: {} })
    assert.deepEqual(toWindow(), [{ type: "panel", panel: "motion", view: { open: "spin" } }, { type: "panel", panel: "motion", pong: 5 }, { type: "panel", panel: "motion", part: { clock: { pos: 0.5 } } }])
    // window → overlay: the same.
    await h.cmd("panel", { panel: "motion", act: { type: "ping", id: 1 } })
    await h.cmd("panel", { panel: "canvas", act: { type: "ping", id: 2 } })
    await h.cmd("panel", { panel: "motion" })
    await h.cmd("panel", null)
    assert.deepEqual(toOverlay("panel"), [{ type: "panel", panel: "motion", act: { type: "ping", id: 1 } }])
    // Send in the window's dock: the page view is told to let the note it brings through, once
    // for each Send, and for nothing else the dock does or a dock that is not the window's.
    const admits = () => h.page.calls.filter((c) => c[0] === "admit").length
    assert.equal(admits(), 0)
    await h.cmd("panel", { panel: "motion", act: { type: "send", background: false } })
    await h.cmd("panel", { panel: "canvas", act: { type: "send" } })
    assert.equal(admits(), 1)
  } finally {
    await h.close()
  }
})

test("the facts pane is relayed as a dock is: its views (null too) reach the window, its acts reach the overlay; Note puts the keys on the page", async () => {
  const h = await boot({ docks: ["facts"] })
  const toOverlay = (type: string) => h.page.sent.filter((m) => m.type === type)
  const toWindow = () => h.shell.sent.filter((x) => x[0] === "panel").map((x) => x[1])
  try {
    await h.ready()
    h.page.message({ type: "ready", url: `${SITE}/`, viewport: { w: 390, h: 844, dpr: 3, scrollX: 0, scrollY: 0 } })
    assert.deepEqual(toOverlay("docks").at(-1), { type: "docks", hosted: ["facts"] })
    const view = { viewport: { w: 390, h: 844 }, doc: { w: 520, h: 2000 }, meta: true, partial: false, wide: { items: [{ id: 1, label: "<b>Banner</b>", detail: "+130 px" }], total: 1 }, taps: { items: [], total: 0 }, small: { items: [], total: 0 } }
    h.page.message({ type: "panel", panel: "facts", view: null })
    h.page.message({ type: "panel", panel: "facts", view })
    h.page.message({ type: "panel", panel: "facts", pong: 3 })
    h.page.message({ type: "panel", panel: "motion", view: { open: "spin" } })
    assert.deepEqual(toWindow(), [{ type: "panel", panel: "facts", view: null }, { type: "panel", panel: "facts", view }, { type: "panel", panel: "facts", pong: 3 }])
    const focus = () => h.page.calls.filter((c) => c[0] === "focus").length
    const was = focus()
    for (const act of [{ type: "view" }, { type: "hover", id: 1 }, { type: "show", id: 1 }, { type: "stop" }]) await h.cmd("panel", { panel: "facts", act })
    await h.cmd("panel", { panel: "canvas", act: { type: "ping", id: 2 } })
    assert.deepEqual(toOverlay("panel").map((m) => (m as unknown as { act: unknown }).act), [{ type: "view" }, { type: "hover", id: 1 }, { type: "show", id: 1 }, { type: "stop" }])
    assert.equal(focus(), was)
    // Note: the card opens on the page, and what is typed next goes there. Nothing for the overlay to admit.
    await h.cmd("panel", { panel: "facts", act: { type: "note", id: 1 } })
    await h.cmd("panel", { panel: "facts", act: { type: "send" } })
    assert.equal(focus(), was + 1)
    assert.equal(h.page.calls.filter((c) => c[0] === "admit").length, 0)
  } finally {
    await h.close()
  }
})

test("the window draws the docks in HOSTED_PANES unless the shell says otherwise; with none, the overlay is told nothing and draws its own", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.page.message({ type: "ready", url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 } })
    assert.deepEqual(h.snap().review.docks, [...HOSTED_PANES])
    assert.deepEqual(h.page.sent.filter((m) => m.type === "docks"), HOSTED_PANES.length ? [{ type: "docks", hosted: [...HOSTED_PANES] }] : [])
  } finally {
    await h.close()
  }
  const none = await boot({ docks: [] })
  try {
    await none.ready()
    none.page.message({ type: "ready", url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 } })
    assert.deepEqual(none.snap().review.docks, [])
    assert.equal(none.page.sent.some((m) => m.type === "docks"), false)
  } finally {
    await none.close()
  }
})

// ── the app's own file history (snapshots.ts) ───────────────────────────────────────────────────

test("file history: a turn that changed no file the app sees is asked of the agent, its diff is known to be empty", async () => {
  const t = await historyOf()
  try {
    // Note 1: the agent works where the app does not look (nothing changes in the folder).
    const a = t.h.note("a")
    await until(() => t.h.w.prompts.length === 1)
    await t.agentTurn(() => undefined, "1:done", 1)
    const b = t.h.note("b")
    await until(() => t.h.w.prompts.length === 2)
    await t.agentTurn(() => t.edit(18, "line 18 NOTE TWO"), "1:done 2:done", 2)
    assert.equal(await t.h.cmd("takeBackWay", a), "asked")
    assert.deepEqual(await t.h.cmd("takeBackPlan", a), { how: "asked" })
    assert.deepEqual(await t.h.cmd("noteDiff", a), [])
    assert.deepEqual(await t.h.cmd("takeBackPlan", b), { how: "restored", files: ["a.css"] })
  } finally {
    await t.close()
  }
})

test("file history: the take-back question lists the files it puts back; a stale index.lock asks the agent instead of failing", async () => {
  const t = await historyOf()
  try {
    const { a } = await twoNotes(t)
    assert.deepEqual(await t.h.cmd("takeBackPlan", a), { how: "restored", files: ["a.css"] })
    // The app was killed during a snapshot: git's lock is left in the shadow.
    const lock = path.join(t.root, fs.readdirSync(t.root).find((d) => d.startsWith(`${path.basename(t.work)}-`))!, "index.lock")
    fs.writeFileSync(lock, "")
    assert.equal(await t.h.cmd("takeBackWay", a), "asked")
    fs.rmSync(lock)
    assert.equal(await t.h.cmd("takeBackWay", a), "restored")
  } finally {
    await t.close()
  }
})

test("file history: /undo says what it will take back and waits for a yes, the conversation staying as it is; /redo brings it back", async () => {
  const t = await historyOf()
  const { h } = t
  try {
    await assert.rejects(Promise.resolve(h.cmd("runCommand", "undo", "")), /Nothing to undo/)
    await twoNotes(t)
    const asked = (await h.cmd("runCommand", "undo", "")) as { say: string; draft: string }
    assert.equal(asked.draft, "/undo yes")
    assert.match(asked.say, /^This takes back the changes the agent made to files for note 2 \("b"\)\. The conversation stays as it is/)
    assert.equal(t.line(18), "line 18 NOTE TWO", "nothing yet")
    const reloads = () => h.page.sent.filter((m) => m.type === "RELOAD").length
    const shown = reloads()
    const done = (await h.cmd("runCommand", "undo", "yes")) as { say: string }
    assert.match(done.say, /^Took back the agent's changes to files for note 2/)
    assert.deepEqual([t.line(2), t.line(18)], ["line 2 NOTE ONE", "line 18"])
    assert.equal(reloads(), shown + 1, "the files went back: the page is loaded again to show them")
    assert.deepEqual(await h.cmd("runCommand", "redo", ""), { say: "Brought back what was taken back." })
    assert.equal(t.line(18), "line 18 NOTE TWO")
    // Not while the agent works.
    await h.cmd("send", "and the footer")
    await until(() => h.snap().session?.busy === true)
    await assert.rejects(Promise.resolve(h.cmd("runCommand", "undo", "yes")), /The agent is working\. Stop it first, then \/undo\./)
  } finally {
    await t.close()
  }
})

test("file history: a take-back is told only once the agent has the message; until then /redo has it, while the agent works it waits, and once told nothing is left to redo", async () => {
  const t = await historyOf()
  const { h, s } = t
  try {
    const { a } = await twoNotes(t)
    assert.equal(await h.cmd("takeBackNote", a, "restored"), "restored")
    // Nothing said since: /redo brings it back.
    assert.deepEqual(await h.cmd("runCommand", "redo", ""), { say: "Brought back what was taken back." })
    assert.equal(t.line(2), "line 2 NOTE ONE")

    // Taken back again; the next message says so first.
    assert.equal(await h.cmd("takeBackNote", a, "restored"), "restored")
    await h.cmd("send", "and the footer", [])
    await until(() => h.w.prompts.length === 3)
    assert.match(lastPrompt(h).text, /^\(bicycle 42: I took back note 1 .*\)\n\nand the footer$/)
    // The agent has it (it is working on it): /redo would make what it says untrue.
    await assert.rejects(h.cmd("runCommand", "redo", ""), /Nothing to redo/)
    await turn(h, s)
    await until(() => t.log().restores.at(-1)?.told === true)
    await assert.rejects(h.cmd("runCommand", "redo", ""), /^Error: Nothing to redo\.$/)
    assert.equal(t.line(2), "line 2")
    await h.cmd("send", "and the nav", [])
    await until(() => h.w.prompts.length === 4)
    assert.equal(lastPrompt(h).text, "and the nav", "only once")
  } finally {
    await t.close()
  }
})

test("file history: before a summary or an agent's own command, the line about what was taken back goes alone, first", async () => {
  const t = await historyOf()
  const { h, s } = t
  try {
    const { a } = await twoNotes(t)
    await until(() => h.snap().can?.compact === true)
    assert.equal(await h.cmd("takeBackNote", a, "restored"), "restored")
    await h.cmd("runCommand", "compact", "")
    await until(() => h.w.prompts.length === 3)
    assert.match(lastPrompt(h).text, /^\(bicycle 42: I took back note 1 \("a"\) myself, before this message: [^\n]*\)$/)
    await turn(h, s)
    await until(() => h.w.prompts.length === 4)
    assert.equal(lastPrompt(h).text, "/compact")
    await turn(h, s)
    await until(() => t.log().restores[0]?.told === true)
    // Once the agent has it, the agent's own command goes alone.
    await h.cmd("runCommand", "review", "")
    await until(() => h.w.prompts.length === 5)
    assert.equal(lastPrompt(h).text, "/review")
  } finally {
    await t.close()
  }
})

test("file history: an older note is taken back exactly from the app's snapshots, later work and the reviewer's own edits kept; /redo brings it back; the agent is told with the next message", async () => {
  const t = await historyOf()
  const { h, s } = t
  try {
    const { a, b } = await twoNotes(t)
    // The reviewer changes a line by hand.
    t.edit(10, "line 10 BY HAND")

    assert.equal(await h.cmd("takeBackWay", b), "restored")
    assert.equal(await h.cmd("takeBackWay", a), "restored")
    const diff = (await h.cmd("noteDiff", a)) as Array<{ file: string; patch: string }>
    assert.deepEqual(diff.map((f) => f.file), ["a.css"])
    assert.match(diff[0]!.patch, /\+line 2 NOTE ONE/)
    assert.doesNotMatch(diff[0]!.patch, /NOTE TWO|BY HAND/, "its own turn's changes only")

    assert.equal(await h.cmd("takeBackNote", a, "restored"), "restored")
    assert.deepEqual([t.line(2), t.line(10), t.line(18)], ["line 2", "line 10 BY HAND", "line 18 NOTE TWO"])
    assert.equal(h.w.prompts.length, 2, "the agent is not asked")
    assert.deepEqual(h.snap().review.notes.map((n) => n.takenBack), ["restored", undefined])

    // /redo brings note 1 back, and the hand edit stays.
    assert.deepEqual(await h.cmd("runCommand", "redo", ""), { say: "Brought back what was taken back." })
    assert.deepEqual([t.line(2), t.line(10), t.line(18)], ["line 2 NOTE ONE", "line 10 BY HAND", "line 18 NOTE TWO"])
    assert.deepEqual(h.snap().review.notes.map((n) => n.takenBack), [undefined, undefined])

    // Taken back again; the next message to the conversation says so first, and makes it final.
    assert.equal(await h.cmd("takeBackNote", a, "restored"), "restored")
    await h.cmd("send", "and the footer", [])
    await until(() => h.w.prompts.length === 3)
    assert.match(lastPrompt(h).text, /^\(bicycle 42: I took back note 1 \("a"\) myself, before this message: .*\)\n\nand the footer$/)
    await assert.rejects(h.cmd("runCommand", "redo", ""), /Nothing to redo|working in this folder/)
    assert.equal(t.line(2), "line 2")
    // Only once.
    await turn(h, s)
    await until(() => h.snap().session?.busy === false)
    await h.cmd("send", "and the header", [])
    await until(() => h.w.prompts.length === 4)
    assert.equal(lastPrompt(h).text, "and the header")
  } finally {
    await t.close()
  }
})

test("file history: a conversation in a parent folder of the site's, working at the same time, shares its turns", async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b42-parent-")))
  const work = path.join(parent, "site")
  fs.mkdirSync(work)
  const t = await historyOf({ work })
  const { h, s } = t
  try {
    const a = h.note("a")
    await until(() => h.w.prompts.length === 1)
    // While the agent works on it, the parent folder's own project has a message going too.
    await h.cmd("openProject", parent)
    await until(() => h.snap().site?.directory === parent && !!h.snap().session)
    const other = h.snap().session!.id
    await h.cmd("send", "tidy everything")
    await until(() => h.w.prompts.length === 2)
    await sleep(100)
    t.edit(2, "line 2 NOTE ONE")
    await h.agent.finishes(other)
    await h.agent.finishes(s)
    await h.cmd("openProject", work)
    await until(() => h.snap().site?.directory === work && h.notes() === "1:done" && t.log().turns.length === 1)
    h.note("b")
    await until(() => h.w.prompts.length === 3)
    await t.agentTurn(() => t.edit(18, "line 18 NOTE TWO"), "1:done 2:done", 2)
    assert.equal(await h.cmd("takeBackWay", a), "asked")
  } finally {
    await t.close()
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test("file history: a turn another conversation shared the folder with is not reversed by itself, and the agent is asked", async () => {
  const t = await historyOf()
  const { h, s } = t
  try {
    // A note, and while the agent works on it a background note (alt+Enter) in a conversation
    // of its own, in the same folder.
    h.note("a")
    await until(() => h.w.prompts.length === 1)
    h.page.message({ type: "note", note: { id: "bg1", text: "in the background", url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 }, targets: [], area: null, strokes: [], bounds: { x: 1, y: 2, w: 3, h: 4 }, lane: "bg" } })
    await until(() => h.w.prompts.length === 2)
    const bg = h.w.prompts[1]!.session
    assert.notEqual(bg, s)
    await sleep(100)
    t.edit(5, "line 5 BY ONE OF THEM")
    await h.agent.finishes(bg)
    await h.agent.finishes(s)
    await until(() => h.notes() === "1:done 2:done" && t.log().turns.length >= 1)
    await sleep(300)
    const first = h.snap().review.notes.find((n) => n.lane === "main")!
    assert.equal(await h.cmd("takeBackWay", first.id), "asked")
    assert.equal(await h.cmd("takeBackNote", first.id, "asked"), "asked")
    assert.equal(t.line(5), "line 5 BY ONE OF THEM", "nothing is reversed by the app")
  } finally {
    await t.close()
  }
})
