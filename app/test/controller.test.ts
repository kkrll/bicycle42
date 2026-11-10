// The controller's unhappy paths (src/main/index.ts), in plain Node: the real controller, review,
// store and backend client, with Electron and the page view stubbed (test/stubs) and a fake
// server that keeps a little state. Each test loads a fresh controller with its own profile.
//
// These are the sequences a review found note status lying in: a lost reply, Stop, a deleted
// conversation, a new conversation with work in flight, a relaunch, a server that is down at
// launch. Each asserts what the reviewer at the screen must see.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { AppState, ChatEvent } from "../src/shared/types"
import { start, until, type FakeReply, type FakeServer } from "./fake-server"

const SITE = "http://site.test"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const gone: FakeReply = { status: 404, json: { _tag: "SessionNotFoundError", message: "Session not found" } }

type Stubs = {
  electron: { handlers: Record<string, (e: unknown, ...a: unknown[]) => unknown>; sent: [string, unknown][]; dialogs: unknown[] }
  page: { message(msg: unknown): void; sent: { type: string; [k: string]: unknown }[]; capture?: () => unknown; page?: { load(url: string): void } }
}

type World = {
  sessions: Map<string, Record<string, unknown>>
  /** Per session: ids the agent has not picked up. */
  inbox: Map<string, string[]>
  /** Every message the server holds, in arrival order. A repeated id is not added twice. */
  prompts: { session: string; id: string; text: string }[]
  creates: number
  transcripts: number
  /** Answers the next prompt (after recording it) with this instead of success. */
  nextPromptReply?: FakeReply
}

async function fakeOpenCode() {
  const server = await start()
  const w: World = { sessions: new Map(), inbox: new Map(), prompts: [], creates: 0, transcripts: 0 }
  const sid = (p: string) => p.split("/")[3] ?? ""
  server.route("GET", "/api/model", { json: { data: [{ providerID: "anthropic", id: "sonnet", name: "Sonnet", capabilities: { input: ["text", "image"] }, variants: [], enabled: true, status: "active" }] } })
  server.route("GET", "/api/agent", { json: { data: [] } })
  server.route("GET", "/api/session", () => ({ json: { data: [...w.sessions.values()], cursor: { previous: null, next: null } } }))
  server.route("POST", "/api/session", (req) => {
    const body = (req.body ?? {}) as { parentID?: string }
    const s = { id: `ses_${++w.creates}`, location: { directory: "/repo" }, title: "t", time: { created: 1, updated: 1 }, ...(body.parentID ? { parentID: body.parentID } : {}) }
    w.sessions.set(s.id, s)
    return { json: { data: s } }
  })
  server.route("GET", /^\/api\/session\/[^/]+$/, (req) => (w.sessions.has(sid(req.path)) ? { json: { data: w.sessions.get(sid(req.path)) } } : gone))
  server.route("GET", /^\/api\/session\/[^/]+\/(permission|form)$/, (req) => (w.sessions.has(sid(req.path)) ? { json: { data: [] } } : gone))
  server.route("GET", /^\/api\/session\/[^/]+\/message$/, (req) => {
    w.transcripts++
    return w.sessions.has(sid(req.path)) ? { json: { data: [], cursor: { previous: null, next: null } } } : gone
  })
  server.route("GET", /^\/api\/session\/[^/]+\/inbox$/, (req) =>
    w.sessions.has(sid(req.path))
      ? { json: { data: (w.inbox.get(sid(req.path)) ?? []).map((id) => ({ id, type: "user", time: { created: 1 }, payload: { text: "x" }, delivery: "queue" })) } }
      : gone,
  )
  server.route("POST", /^\/api\/session\/[^/]+\/prompt$/, (req) => {
    const session = sid(req.path)
    if (!w.sessions.has(session)) return gone
    const body = req.body as { id?: string; text: string }
    const id = body.id ?? `msg_server_${w.prompts.length + 1}`
    // Like the real server: a message id it already has is not queued again.
    if (!w.prompts.some((p) => p.id === id)) {
      w.prompts.push({ session, id, text: body.text.split("\n")[1] ?? "" })
      w.inbox.set(session, [...(w.inbox.get(session) ?? []), id])
    }
    const reply = w.nextPromptReply
    w.nextPromptReply = undefined
    return reply ?? { json: { data: { id, sessionID: session, type: "user", delivery: "queue" } } }
  })
  return { server, w }
}

async function boot(opts: { settings?: unknown; reviews?: Record<string, unknown>; server?: { server: FakeServer; w: World } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-ctl-"))
  if (opts.settings) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(opts.settings))
  for (const [origin, review] of Object.entries(opts.reviews ?? {})) {
    fs.mkdirSync(path.join(dir, "reviews"), { recursive: true })
    fs.writeFileSync(path.join(dir, "reviews", `${encodeURIComponent(origin)}.json`), JSON.stringify(review))
  }
  const { server, w } = opts.server ?? (await fakeOpenCode())
  process.env.BICYCLE42_DATA = dir
  process.env.BICYCLE42_TEST = "1"
  const quiet = { log: console.log, warn: console.warn, error: console.error }
  if (!process.env.V) console.log = console.warn = console.error = () => {}
  const built = path.join(__dirname, "controller.cjs")
  delete require.cache[built]
  require(built)
  const g = globalThis as unknown as { __electronStub: Stubs["electron"]; __pageStub: Stubs["page"]; __b42Test: { snapshot(): AppState } }
  const electron = g.__electronStub
  await until(() => !!g.__pageStub.page && !!electron.handlers["b42:command"])
  const page = g.__pageStub
  const hook = g.__b42Test

  const cmd = (name: string, ...args: unknown[]) => electron.handlers["b42:command"]!(null, name, args) as Promise<unknown>
  const snap = () => hook.snapshot()
  const notes = () => snap().review.notes.map((n) => `${n.n}:${n.status}`).join(" ")
  let k = 0
  const note = (text: string, id = `n${++k}`) => {
    page.message({ type: "note", note: { id, text, url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 }, targets: [], area: null, strokes: [], bounds: { x: 1, y: 2, w: 3, h: 4 } } })
    return id
  }
  let seq = 0
  const emit = (type: string, session: string, data: Record<string, unknown> = {}) =>
    server.emit({ id: `evt_${++seq}`, created: Date.now(), type, data: { sessionID: session, ...data } })
  let tick = 10
  const clock = (s: string, key: "busy" | "idle") => {
    const session = w.sessions.get(s) as { time: Record<string, number> } | undefined
    if (session) session.time[key] = ++tick
  }
  const agent = {
    queued: (s: string, id: string) => emit("session.inbox.enqueued", s, { inboxID: id, item: { type: "user", payload: { text: "x" }, delivery: "queue" } }),
    picksUp(s: string, id: string) {
      w.inbox.set(s, (w.inbox.get(s) ?? []).filter((x) => x !== id))
      emit("session.inbox.delivered", s, { inboxID: id })
    },
    // Like the real server: a run sets time.busy when it starts and time.idle when it ends.
    starts(s: string) {
      clock(s, "busy")
      emit("session.execution.started", s)
    },
    finishes(s: string) {
      clock(s, "idle")
      emit("session.execution.succeeded", s)
    },
    isStopped(s: string) {
      clock(s, "idle")
      emit("session.execution.interrupted", s, { reason: "user" })
    },
  }
  return {
    dir, server, w, cmd, snap, notes, note, emit, agent, electron, page,
    chat: () => electron.sent.filter((x) => x[0] === "b42:chat").map((x) => x[1] as ChatEvent),
    /** Connect, open the site, pick its folder; resolves once a conversation is open. */
    async ready() {
      await cmd("connect", { url: server.url, password: server.password })
      page.page!.load(`${SITE}/`)
      await cmd("setDirectory", "/repo")
      await until(() => !!snap().session && server.streams() === 1)
      await sleep(30)
      return snap().session!.id
    },
    async close() {
      await Promise.resolve(cmd("disconnect")).catch(() => undefined)
      await server.stop()
      Object.assign(console, quiet)
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const savedSite = (extra: Record<string, unknown> = {}) => ({ version: 1, lastUrl: `${SITE}/`, sites: { [SITE]: { directory: "/repo", ...extra } } })
const savedNote = (id: string, n: number, status: string, message: string, session: string) => ({ id, n, text: id, status, lane: "main", message, session, anchor: {} })

test("a reply lost on the way back: Retry does not queue the note twice", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.w.nextPromptReply = { status: 502, text: "<html>Bad Gateway</html>" }
    const id = h.note("make it blue")
    await until(() => h.notes() === "1:failed")
    assert.equal(h.w.prompts.length, 1, "the server did take it")
    await h.cmd("retryNote", id)
    await until(() => h.notes() === "1:queued")
    assert.equal(h.w.prompts.length, 1, "the retry carried the same message id")
  } finally {
    await h.close()
  }
})

test("Stop: the working note fails with a way forward, queued ones stay queued, Retry sends anew", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    const [a, b] = [h.note("a"), h.note("b"), h.note("c")]
    await until(() => h.w.prompts.length === 3)
    const [m1] = h.w.prompts.map((p) => p.id)
    h.agent.starts(s)
    h.agent.picksUp(s, m1!)
    await until(() => h.notes() === "1:working 2:queued 3:queued")
    h.agent.isStopped(s)
    await until(() => h.notes() === "1:failed 2:queued 3:queued")
    assert.match(h.snap().review.notes[0]!.error ?? "", /Retry/, "the message says what to do")

    await h.cmd("retryNote", a)
    await until(() => h.notes() === "1:queued 2:queued 3:queued")
    assert.equal(h.w.prompts.length, 4, "an accepted note goes again as a new message")
    assert.notEqual(h.w.prompts[3]!.id, m1)

    // The connection drops and comes back while the conversation sits idle with its queue full.
    h.server.drop()
    await until(() => h.server.streams() === 1, 8000)
    await sleep(150)
    assert.equal(h.notes(), "1:queued 2:queued 3:queued", "what still waits on the server is not called done")

    await h.cmd("removeNote", b)
    assert.equal(h.notes(), "1:queued 3:queued", "any note can be taken off the list")
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
    await until(() => h.w.prompts.length === 2)
    h.agent.starts(s)
    h.agent.picksUp(s, h.w.prompts[0]!.id)
    await until(() => h.notes() === "1:working 2:queued")
    h.w.sessions.delete(s)
    h.emit("session.deleted", s)
    await until(() => h.notes() === "1:failed 2:failed")
    assert.match(h.snap().review.notes[1]!.error ?? "", /deleted/i)
    await until(() => !!h.snap().session && h.snap().session!.id !== s)
    h.note("c")
    await until(() => h.w.prompts.length === 3)
    assert.equal(h.w.prompts[2]!.session, h.snap().session!.id, "the next note goes to the new conversation")
    // The server has it; the note is queued once its answer is back here.
    await until(() => h.notes() === "1:failed 2:failed 3:queued")
    assert.equal(h.notes(), "1:failed 2:failed 3:queued")
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
    await until(() => h.w.prompts.length === 2)
    h.agent.starts(old)
    h.agent.picksUp(old, h.w.prompts[0]!.id)
    await until(() => h.notes() === "1:working 2:queued")

    await h.cmd("newSession")
    const neu = h.snap().session!.id
    assert.notEqual(neu, old)
    await sleep(100)
    assert.equal(h.notes(), "1:working 2:queued", "opening an idle conversation settles nothing on the old one")

    h.note("c")
    await until(() => h.w.prompts.length === 3)
    h.agent.starts(neu)
    h.agent.picksUp(neu, h.w.prompts[2]!.id)
    h.agent.finishes(neu)
    await until(() => h.notes() === "1:working 2:queued 3:done")

    // The old conversation is still at it, and its events still land on its notes.
    h.agent.picksUp(old, h.w.prompts[1]!.id)
    h.agent.finishes(old)
    await until(() => h.notes() === "1:done 2:done 3:done")
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
    assert.equal(h.notes(), "1:queued")
  } finally {
    await h.close()
  }
})

test("a note fired while the site's conversation is still opening does not create a second one", async () => {
  const h = await boot()
  try {
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    h.page.page!.load(`${SITE}/`)
    const opening = h.cmd("setDirectory", "/repo") // not awaited: the reviewer is fast
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
    settings: savedSite({ session: "ses_gone" }),
    reviews: { [SITE]: { version: 1, notes: [savedNote("a", 1, "working", "msg_a", "ses_gone"), savedNote("b", 2, "queued", "msg_b", "ses_gone")] } },
  })
  try {
    assert.equal(h.notes(), "1:working 2:queued", "before connecting nothing is known")
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await until(() => !!h.snap().session)
    await until(() => h.notes() === "1:failed 2:failed")
    assert.notEqual(h.snap().session!.id, "ses_gone")
  } finally {
    await h.close()
  }
})

test("relaunch with an idle conversation: finished notes are done, a still-waiting one stays queued", async () => {
  const fake = await fakeOpenCode()
  fake.w.sessions.set("ses_live", { id: "ses_live", location: { directory: "/repo" }, title: "t", time: { created: 1, updated: 2, busy: 3, idle: 4 } })
  fake.w.inbox.set("ses_live", ["msg_b"])
  const h = await boot({
    server: fake,
    settings: savedSite({ session: "ses_live" }),
    reviews: { [SITE]: { version: 1, notes: [savedNote("a", 1, "working", "msg_a", "ses_live"), savedNote("b", 2, "queued", "msg_b", "ses_live")] } },
  })
  try {
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await until(() => h.notes() === "1:done 2:queued")
    assert.equal(h.snap().session!.id, "ses_live", "the saved conversation is reused")
    assert.equal(h.w.creates, 0)
  } finally {
    await h.close()
  }
})

test("a gap in someone else's conversation does not re-read the one on screen", async () => {
  const h = await boot()
  try {
    await h.ready()
    const before = h.w.transcripts
    for (let i = 0; i < 10; i++) h.emit("session.step.ended", "ses_someone_else", { assistantMessageID: `msg_x${i}`, finish: "stop", cost: 0, tokens: {} })
    await sleep(200)
    assert.equal(h.w.transcripts, before)
  } finally {
    await h.close()
  }
})

test("the server is down at launch and comes up later: the app connects by itself", async () => {
  // An address nothing listens on yet.
  const probe = await start()
  const url = probe.url
  await probe.stop()
  const h = await boot({ settings: { ...savedSite(), server: { url, password: "plain:pw" } } })
  let late: FakeServer | undefined
  try {
    await until(() => h.snap().connection.status === "offline")
    late = await start(Number(new URL(url).port))
    // Any password is "wrong" for a new fake; what matters is that the app asks again by itself.
    await until(() => late!.requests.length > 0, 8000)
    assert.equal(late.requests[0]!.path, "/api/info")
  } finally {
    await late?.stop()
    await h.close()
  }
})

test("settings from a newer version are left alone, and the user is told", async () => {
  const future = { version: 2, shape: "unknown to this build" }
  const h = await boot({ settings: future })
  try {
    await until(() => h.electron.dialogs.length === 1)
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await sleep(400) // longer than the store's debounce
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8")), future)
    assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f.includes("corrupt")), [])
  } finally {
    await h.close()
  }
})

// ── the message box ─────────────────────────────────────────────────────────────────────────────

const lastPrompt = (h: { server: FakeServer }) => [...h.server.requests].reverse().find((r) => r.method === "POST" && r.path.endsWith("/prompt"))

test("send: a file mention goes as a file:// attachment under the site's folder, with the delivery asked for", async () => {
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
    const req = lastPrompt(h)!
    assert.equal(req.path, `/api/session/${s}/prompt`)
    assert.deepEqual(req.body, {
      text,
      files: [
        { uri: "file:///repo/src/hero.tsx", name: "hero.tsx", mention: { start: 5, end: 14, text: "@hero.tsx" } },
        { uri: "file:///repo/src/ui", name: "ui", mention: { start: 19, end: 26, text: "@src/ui" } },
      ],
      delivery: "steer",
    })
    // Without options it is queued, as before.
    await h.cmd("send", "plain")
    assert.deepEqual(lastPrompt(h)!.body, { text: "plain", delivery: "queue" })
  } finally {
    await h.close()
  }
})

test("mentions: skills and helper agents for an empty query; files first for a typed one, at most 20", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.server.route("GET", "/api/skill", { json: { data: [{ id: "opencode", name: "OpenCode", description: "About it" }, { id: "store-tips", name: "Store tips" }] } })
    h.server.route("GET", "/api/agent", { json: { data: [{ id: "build", name: "Build", mode: "primary" }, { id: "explore", name: "Explore", mode: "subagent" }] } })
    h.server.route("GET", "/api/fs/find", (req) => ({
      json: { data: Array.from({ length: Number(req.query.get("limit")) }, (_, i) => ({ path: `src/store${i}.ts`, type: "file" })) },
    }))
    const all = (await h.cmd("mentions", "")) as { kind: string; id: string }[]
    assert.deepEqual(all.map((o) => `${o.kind}:${o.id}`), ["skill:opencode", "skill:store-tips", "agent:explore"])

    const found = (await h.cmd("mentions", "Store")) as { kind: string; id: string }[]
    assert.equal(found.length, 20)
    assert.equal(found[0]!.id, "src/store0.ts")
    assert.deepEqual(found.at(-1), { kind: "skill", id: "store-tips", label: "Store tips" })
    const find = h.server.requests.filter((r) => r.path === "/api/fs/find")
    assert.equal(find.length, 1)
    assert.equal(find[0]!.query.get("query"), "Store")
    assert.equal(find[0]!.query.get("location[directory]"), "/repo")
    // Skills and agents were read once for both lookups.
    assert.equal(h.server.requests.filter((r) => r.path === "/api/skill").length, 1)
  } finally {
    await h.close()
  }
})

test("commands, runCommand, cancelQueued: read once per folder, run in the open conversation, take a message out of the queue", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.server.route("GET", "/api/command", { json: { data: [{ name: "review", description: "review changes" }] } })
    h.server.route("POST", /\/command$/, {})
    h.server.route("DELETE", /\/inbox\//, {})
    assert.deepEqual(await h.cmd("commands"), [{ name: "review", description: "review changes" }])
    assert.deepEqual(await h.cmd("commands"), [{ name: "review", description: "review changes" }])
    assert.equal(h.server.requests.filter((r) => r.path === "/api/command").length, 1)

    await h.cmd("runCommand", "review", "@pr", [], { mentions: [{ kind: "agent", id: "explore", start: 0, end: 3 }] })
    const run = h.server.requests.find((r) => r.method === "POST" && r.path.endsWith("/command"))!
    assert.equal(run.path, `/api/session/${s}/command`)
    assert.deepEqual(run.body, { name: "review", text: "@pr", agents: [{ name: "explore", mention: { start: 0, end: 3, text: "@pr" } }], delivery: "queue" })

    await h.cmd("cancelQueued", "msg_9")
    const del = h.server.requests.find((r) => r.method === "DELETE")!
    assert.equal(del.path, `/api/session/${s}/inbox/msg_9`)
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
type Sent = { text: string; files?: { name: string; uri: string }[] }
const jpegOf = (f: { uri: string }) => Buffer.from(f.uri.split(",")[1]!, "base64").toString()
/** A picture stand-in whose JPEG is its name (test/stubs/page.ts has the same for other tests). */
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

    await until(() => h.notes() === "1:queued")
    const order = h.page.sent.filter((m) => m.type === "edits" || m.type === "captured").map((m) => (m.type === "edits" ? `edits:${m.show}` : "captured"))
    assert.deepEqual(order, ["edits:false", "edits:true", "captured"])
    const body = lastPrompt(h)!.body as Sent
    assert.deepEqual(body.files!.map((f) => `${f.name}=${jpegOf(f)}`), ["note-1-before-area.jpg=before", "note-1-after-area.jpg=after", "note-1-viewport.jpg=after"])
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
    await until(() => h.notes() === "1:queued", 5000)
    assert.ok(Date.now() - started >= 900, "it did wait for the overlay")
    const order = h.page.sent.filter((m) => m.type === "edits" || m.type === "captured").map((m) => (m.type === "edits" ? `edits:${m.show}` : "captured"))
    assert.deepEqual(order, ["edits:false", "edits:true", "captured"])
    const body = lastPrompt(h)!.body as Sent
    assert.deepEqual(body.files!.map((f) => `${f.name}=${jpegOf(f)}`), ["note-1.jpg=after"])
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
    await until(() => h.notes() === "1:queued 2:queued")
    assert.equal(h.page.sent.some((m) => m.type === "edits"), false)
    const first = h.server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/prompt"))[0]!.body as Sent
    assert.equal(first.files, undefined)
    assert.match(first.text, /^Canvas edits, made on the live page/m)
    assert.doesNotMatch(first.text, /Image 1|screenshot/)
    // Edits the page made up are dropped; with no words either, there is no note.
    h.page.message(canvasNote("c2", { edits: [{ kind: "teleport", selector: "x" }] }))
    await sleep(100)
    assert.equal(h.notes(), "1:queued 2:queued")
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
    await until(() => h.notes() === "1:queued")
    const first = lastPrompt(h)!.body as Sent & { id: string }

    h.agent.starts(s)
    h.agent.picksUp(s, first.id)
    await until(() => h.notes() === "1:working")
    h.agent.isStopped(s)
    await until(() => h.notes() === "1:failed")
    await h.cmd("retryNote", "c1")
    await until(() => h.notes() === "1:queued")

    const again = lastPrompt(h)!.body as Sent & { id: string }
    assert.notEqual(again.id, first.id, "a new message")
    assert.equal(again.text, first.text)
    assert.match(again.text, /^2\. Removed "Badge · New"\. \[span\.badge\]$/m)
    assert.deepEqual(again.files, first.files)
    assert.equal(again.files!.length, 3)
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
    await until(() => h.notes() === "1:queued")
    const body = lastPrompt(h)!.body as Sent
    assert.deepEqual(body.files!.map((f) => `${f.name}=${jpegOf(f)}`), ["note-1-before.jpg=before", "note-1-after.jpg=after"])
    assert.ok(body.text.includes(`New CSS rules to add (put them where this project keeps its styles, renamed to its conventions if needed):\n\`\`\`css\n${css}\n\`\`\`\n`))
    assert.equal(body.text.split("\n")[1], "Note: 1 canvas edit: 1 new CSS rule")
    assert.deepEqual(h.snap().review.notes[0], { id: "s1", n: 1, text: "1 canvas edit: 1 new CSS rule", status: "queued", lane: "main", edits: ["1 new CSS rule."] })
    // Too long to be carried, and nothing else in the note: there is no note.
    h.page.message(canvasNote("s2", { edits: undefined, css: "x".repeat(8001) }))
    await sleep(100)
    assert.equal(h.notes(), "1:queued")
  } finally {
    await h.close()
  }
})
