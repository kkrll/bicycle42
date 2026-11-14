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
  page: { message(msg: unknown): void; sent: { type: string; [k: string]: unknown }[]; capture?: () => unknown; evaluate?: (js: string) => unknown; page?: { load(url: string): void } }
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
  /** A new conversation is called what the app asked for, as on the real server. (Off, it is
   *  "t": a name somebody gave, which the app leaves alone.) */
  named?: boolean
}

async function fakeOpenCode() {
  const server = await start()
  const w: World = { sessions: new Map(), inbox: new Map(), prompts: [], creates: 0, transcripts: 0 }
  const sid = (p: string) => p.split("/")[3] ?? ""
  server.route("GET", "/api/model", { json: { data: [{ providerID: "anthropic", id: "sonnet", name: "Sonnet", capabilities: { input: ["text", "image"] }, variants: [], enabled: true, status: "active" }] } })
  server.route("GET", "/api/agent", { json: { data: [] } })
  const put = (s: Record<string, unknown>) => (s.time as { archived?: number }).archived !== undefined
  server.route("GET", "/api/session", (req) => ({
    json: { data: [...w.sessions.values()].filter((s) => !s.parentID && put(s) === (req.query.get("archived") === "true")).reverse(), cursor: { previous: null, next: null } },
  }))
  server.route("POST", "/api/session", (req) => {
    const body = (req.body ?? {}) as { parentID?: string; title?: string }
    const n = ++w.creates
    const s = { id: `ses_${n}`, location: { directory: "/repo" }, title: w.named ? (body.title ?? "") : "t", time: { created: n, updated: n }, ...(body.parentID ? { parentID: body.parentID } : {}) }
    w.sessions.set(s.id, s)
    return { json: { data: s } }
  })
  server.route("GET", /^\/api\/session\/[^/]+$/, (req) => (w.sessions.has(sid(req.path)) ? { json: { data: w.sessions.get(sid(req.path)) } } : gone))
  server.route("PATCH", /^\/api\/session\/[^/]+$/, (req) => {
    const s = w.sessions.get(sid(req.path)) as { title: string; time: { archived?: number } } | undefined
    if (!s) return gone
    const body = req.body as { title?: string; archived?: boolean }
    if (body.title !== undefined) s.title = body.title
    if (body.archived === true) s.time.archived = 99
    if (body.archived === false) delete s.time.archived
    return { json: { data: s } }
  })
  server.route("DELETE", /^\/api\/session\/[^/]+$/, (req) => (w.sessions.delete(sid(req.path)) ? {} : gone))
  server.route("GET", /^\/api\/session\/[^/]+\/diff$/, (req) => ({
    json: { data: [{ file: "src/a.css", patch: `@@ -1 +1 @@\n-a\n+b ${req.query.get("from")}`, additions: 1, deletions: 1, status: "modified" }] },
  }))
  server.route("GET", "/api/vcs", { json: { data: { provider: "git", branch: { current: "polish", default: "main" } } } })
  server.route("GET", "/api/vcs/status", { json: { data: [{ file: "src/a.css", additions: 1, deletions: 1, status: "modified" }, { file: "src/new.css", additions: 4, deletions: 0, status: "added" }] } })
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

test("the repo comes before the site: its conversation opens with no page, and the first site takes it over", async () => {
  const h = await boot()
  try {
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    assert.equal(h.snap().site, null, "no repo, no page: nowhere yet")
    await h.cmd("setDirectory", "/repo")
    await until(() => !!h.snap().session)
    const first = h.snap().session!.id
    assert.deepEqual([h.snap().site, h.w.creates], [{ origin: "", directory: "/repo" }, 1])

    // The site opens: it works in the repo without being asked, in the same conversation.
    h.page.page!.load(`${SITE}/`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    assert.deepEqual([h.snap().site, h.snap().session!.id, h.w.creates], [{ origin: SITE, directory: "/repo" }, first, 1])
    h.note("a note")
    await until(() => h.w.prompts.length === 1)
    assert.equal(h.w.prompts[0]!.session, first)

    // Another site, later: the same repo, a conversation of its own.
    h.page.page!.load("http://other.test/")
    await until(() => h.snap().site?.origin === "http://other.test" && !!h.snap().session)
    assert.deepEqual([h.snap().site!.directory, h.snap().session!.id !== first, h.w.creates], ["/repo", true, 2])
  } finally {
    await h.close()
  }
})

test("openProject: another repo opens with no page and a conversation of its own; going back brings the site and its conversation", async () => {
  const h = await boot()
  try {
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await h.cmd("setDirectory", "/repo")
    h.page.page!.load(`${SITE}/pricing`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    const first = h.snap().session!.id
    h.note("a note")
    await until(() => h.snap().review.notes.length === 1)

    await h.cmd("openProject", "/other")
    await until(() => h.snap().site?.directory === "/other" && !!h.snap().session)
    assert.deepEqual([h.snap().site, h.snap().page.url, h.snap().review.notes.length], [{ origin: "", directory: "/other" }, "", 0])
    assert.notEqual(h.snap().session!.id, first)
    // Saved a moment after the change: until then there may be no file, or the one before.
    const settings = (): { folder?: string; lastUrl?: string } => {
      try {
        return JSON.parse(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8"))
      } catch {
        return {}
      }
    }
    await until(() => settings().folder === "/other")
    assert.equal(settings().lastUrl, undefined, "the next launch starts in this repo, not on the other one's page")

    // Back: the page it was on, its notes and its conversation.
    await h.cmd("openProject", "/repo")
    await until(() => h.snap().site?.origin === SITE && h.snap().session?.id === first)
    assert.deepEqual([h.snap().page.url, h.snap().site!.directory, h.snap().review.notes.length], [`${SITE}/pricing`, "/repo", 1])

    // Opening the project that is open changes nothing.
    const creates = h.w.creates
    await h.cmd("openProject", "/repo")
    assert.deepEqual([h.snap().page.url, h.snap().session!.id, h.w.creates], [`${SITE}/pricing`, first, creates])
    await assert.rejects(Promise.resolve(h.cmd("openProject", "relative/path")))
  } finally {
    await h.close()
  }
})

test("servers are remembered: a second one starts clean, and going back needs no password and brings the first one's repo, page and notes", async () => {
  const h = await boot()
  const second = await fakeOpenCode()
  try {
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await h.cmd("setDirectory", "/repo")
    h.page.page!.load(`${SITE}/pricing`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    const first = h.snap().session!.id
    h.note("a note")
    await until(() => h.snap().review.notes.length === 1)
    await h.cmd("setServerName", "Studio")

    // Another server: nothing of the first one's is here, and the same address is another site.
    await h.cmd("connect", { url: second.server.url, password: second.server.password })
    await until(() => h.snap().connection.status === "online" && (h.snap().connection as { url: string }).url === second.server.url)
    assert.deepEqual([h.snap().site, h.snap().page.url, h.snap().session, h.snap().serverName], [null, "", null, "fake-box"])
    await h.cmd("setDirectory", "/elsewhere")
    h.page.page!.load(`${SITE}/pricing`)
    await until(() => h.snap().site?.origin === SITE && !!h.snap().session)
    assert.deepEqual([h.snap().site!.directory, h.snap().review.notes.length], ["/elsewhere", 0])

    type Info = { id: string; name?: string; url: string; local: boolean; current: boolean }
    const list = (await h.cmd("servers")) as Info[]
    assert.deepEqual(list.map((x) => [x.url, x.current, x.name]), [[second.server.url, true, "fake-box"], [h.server.url, false, "Studio"]])
    assert.ok(!JSON.stringify(list).includes(h.server.password), "the window gets no password")
    await assert.rejects(Promise.resolve(h.cmd("forgetServer", list[0]!.id)), "not the one in use")

    // Back, by its id alone.
    await h.cmd("useServer", list[1]!.id)
    await until(() => h.snap().session?.id === first)
    assert.deepEqual(
      [h.snap().site, h.snap().page.url, h.snap().review.notes.length, h.snap().serverName],
      [{ origin: SITE, directory: "/repo" }, `${SITE}/pricing`, 1, "Studio"],
    )

    // Forgotten: gone from the list, and no longer to be connected to.
    await h.cmd("forgetServer", list[0]!.id)
    assert.deepEqual(((await h.cmd("servers")) as Info[]).map((x) => x.url), [h.server.url])
    await assert.rejects(Promise.resolve(h.cmd("useServer", list[0]!.id)))
  } finally {
    await h.close()
    await second.server.stop()
  }
})

test("a repo that is not a folder on this server is asked for again; projects of other servers are listed with their server and open there", async () => {
  const h = await boot()
  const second = await fakeOpenCode()
  const missing: FakeReply = { status: 404, json: { _tag: "FileNotFoundError", message: "Directory not found: /home/k/site" } }
  const project = (directory: string) => ({ json: [{ id: "p", canonical: directory, time: { active: 1 } }] })
  try {
    // The first server has /home/k/site; the second does not.
    h.server.route("GET", "/api/project", project("/home/k/site"))
    // The second server lists the other computer's folder too (a conversation was once started for it by mistake).
    second.server.route("GET", "/api/project", { json: [{ id: "x", canonical: "/home/k/site", time: { active: 9 } }, { id: "p", canonical: "/Users/me/app", time: { active: 1 } }] })
    second.server.route("GET", "/api/fs/list", (req) => (req.query.get("path") === "/home/k/site" ? missing : { json: { location: { directory: "/" }, data: [] } }))
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await h.cmd("setDirectory", "/home/k/site")
    await until(() => !!h.snap().session)
    const first = h.snap().session!.id
    await h.cmd("projects")

    await h.cmd("connect", { url: second.server.url, password: second.server.password })
    // A folder of the other computer, typed or kept from an older version: refused, and nothing is made for it.
    await assert.rejects(Promise.resolve(h.cmd("openProject", "/home/k/site")), /not a folder on this server/)
    const creates = second.w.creates
    await h.cmd("setDirectory", "/home/k/site")
    await until(() => h.snap().missingFolder === "/home/k/site")
    assert.deepEqual([h.snap().site?.directory, h.snap().session, second.w.creates], [undefined, null, creates])
    await h.cmd("setDirectory", "/Users/me/app")
    await until(() => !!h.snap().session)
    assert.equal(h.snap().missingFolder, undefined)
    assert.deepEqual(await h.cmd("projects"), ["/Users/me/app"], "a folder that is not there is not offered")

    type P = { directory: string; server?: string; on: string; open?: true }
    const all = (await h.cmd("allProjects")) as P[]
    assert.deepEqual(all.map((p) => [p.directory, p.on, !!p.server, !!p.open]), [["/Users/me/app", "fake-box", false, true], ["/home/k/site", "fake-box", true, false]])

    // One choice: the other server, and its project.
    await h.cmd("openProject", "/home/k/site", all[1]!.server)
    await until(() => h.snap().session?.id === first)
    assert.deepEqual([(h.snap().connection as { url: string }).url, h.snap().site], [h.server.url, { origin: "", directory: "/home/k/site" }])
  } finally {
    await h.close()
    await second.server.stop()
  }
})

test("what the server is still running shows once it has run for a while, the open repo's first, and can be stopped", async () => {
  const h = await boot()
  try {
    const now = Date.now()
    const shell = (id: string, ago: number, status = "running") => ({ id, status, command: `cmd  ${id}`, cwd: "/", shell: "sh", file: "", metadata: {}, time: { started: now - ago } })
    const world: Record<string, ReturnType<typeof shell>[]> = {
      "/repo": [shell("sh_dev", 60_000), shell("sh_step", 1_000), shell("sh_done", 90_000, "exited")],
      "/other": [shell("sh_old", 3_600_000)],
    }
    const killed: string[] = []
    h.server.route("GET", "/api/project", { json: [{ id: "a", canonical: "/other", time: { active: 2 } }, { id: "b", canonical: "/repo", time: { active: 1 } }] })
    h.server.route("GET", "/api/shell", (req) => ({ json: { location: { directory: "/" }, data: world[req.query.get("location[directory]") ?? ""] ?? [] } }))
    h.server.route("DELETE", /^\/api\/shell\/[^/]+$/, (req) => {
      const id = req.path.split("/").pop()!
      killed.push(`${req.query.get("location[directory]")} ${id}`)
      for (const d of Object.keys(world)) world[d] = world[d]!.filter((x) => x.id !== id)
      return { status: 204 }
    })
    await h.ready()
    await h.cmd("refreshRunning")
    // Not the command a second old (a step under way), not the one that has ended; the open repo's first.
    assert.deepEqual(h.snap().running.map((r) => [r.directory, r.id, r.command]), [["/repo", "sh_dev", "cmd sh_dev"], ["/other", "sh_old", "cmd sh_old"]])

    await h.cmd("stopRunning", "/repo", "sh_dev")
    assert.deepEqual([killed, h.snap().running.map((r) => r.id)], [["/repo sh_dev"], ["sh_old"]])
    // Without an id: all that is listed, and never the young one.
    await h.cmd("stopRunning")
    assert.deepEqual([killed, h.snap().running], [["/repo sh_dev", "/other sh_old"], []])
    assert.equal(world["/repo"]!.some((x) => x.id === "sh_step"), true)
  } finally {
    await h.close()
  }
})

test("startSite asks the agent in the repo's conversation, and opens the address its answer ends with", async () => {
  const h = await boot()
  try {
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await assert.rejects(Promise.resolve(h.cmd("startSite")), "no repo: nobody to ask")
    await h.cmd("setDirectory", "/repo")
    await until(() => !!h.snap().session && h.server.streams() === 1)
    const id = h.snap().session!.id
    let said = "Which of the two apps, web or docs?"
    h.server.route("GET", /^\/api\/session\/[^/]+\/message$/, () => ({
      json: { data: [{ id: "msg_a", type: "assistant", time: { created: 1, completed: 2 }, content: [{ type: "text", text: said }] }], cursor: { previous: null, next: null } },
    }))
    const sent: string[] = []
    h.server.route("POST", /^\/api\/session\/[^/]+\/prompt$/, (req) => {
      sent.push((req.body as { text: string }).text)
      return { json: { data: { id: `msg_${sent.length}`, sessionID: id, type: "user", delivery: "queue" } } }
    })
    await h.cmd("startSite")
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /^Get this project's site running/)
    assert.match(sent[0]!, /same computer as you/, "the fake server is on this computer")
    assert.match(sent[0]!, /SITE: <address>$/)
    assert.equal(h.snap().startingSite, true)

    // It asks instead of answering: nothing opens, and the app goes on waiting for an address.
    h.agent.starts(id)
    h.agent.finishes(id)
    await until(() => !h.snap().startingSite)
    await sleep(50)
    assert.equal(h.snap().page.url, "")

    // The answer to the question brings the address, on a line of its own; other addresses in the reply are not it.
    said = "Started `npm run dev` (docs are at http://docs.test/).\n\nSITE: http://127.0.0.1:5173/\n"
    h.agent.starts(id)
    await until(() => h.snap().startingSite === true)
    assert.equal(h.snap().startingSite, true)
    h.agent.finishes(id)
    await until(() => h.snap().page.url !== "")
    assert.equal(h.snap().page.url, "http://127.0.0.1:5173/")
    await until(() => h.snap().site?.origin === "http://127.0.0.1:5173" && h.snap().session?.id === id)
    assert.deepEqual(h.snap().site, { origin: "http://127.0.0.1:5173", directory: "/repo" })

    // Once a page is open, a later reply with such a line moves nothing.
    said = "SITE: http://elsewhere.test/"
    h.agent.starts(id)
    h.agent.finishes(id)
    await sleep(80)
    assert.equal(h.snap().page.url, "http://127.0.0.1:5173/")
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
    const theirs = async () => ((await h.cmd("commands")) as { name: string; builtin?: true }[]).filter((c) => !c.builtin)
    assert.deepEqual(await theirs(), [{ name: "review", description: "review changes" }])
    assert.deepEqual(await theirs(), [{ name: "review", description: "review changes" }])
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

test("cancelNote: a waiting note leaves the queue of the conversation it was sent to, and stays on the list, stopped", async () => {
  const h = await boot()
  try {
    const old = await h.ready()
    h.server.route("DELETE", /\/inbox\//, {})
    const [a, b] = [h.note("a"), h.note("b")]
    await until(() => h.w.prompts.length === 2)
    h.agent.starts(old)
    h.agent.picksUp(old, h.w.prompts[0]!.id)
    await until(() => h.notes() === "1:working 2:queued")
    await assert.rejects(h.cmd("cancelNote", a), /no longer waiting/, "only a waiting note")
    await assert.rejects(h.cmd("cancelNote", "nope"), /no longer waiting/)

    // Another conversation is open by now: the note's own is the one asked.
    await h.cmd("newSession")
    assert.notEqual(h.snap().session!.id, old)
    await h.cmd("cancelNote", b)
    const del = h.server.requests.find((r) => r.method === "DELETE")!
    assert.equal(del.path, `/api/session/${old}/inbox/${h.w.prompts[1]!.id}`)
    h.emit("session.inbox.cancelled", old, { inboxID: h.w.prompts[1]!.id })
    await until(() => h.notes() === "1:working 2:failed")
    const row = h.snap().review.notes[1]!
    assert.deepEqual([row.stopped, row.error], [true, "Cancelled."])
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
    assert.equal(h.notes(), "1:queued")
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
    assert.deepEqual(h.snap().review.notes[0], { id: "s1", n: 1, text: "1 canvas edit: 1 new CSS rule", status: "queued", lane: "main", edits: ["1 new CSS rule."], sent: true, session: h.snap().session!.id, pictures: "before" })
    // Too long to be carried, and nothing else in the note: there is no note.
    h.page.message(canvasNote("s2", { edits: undefined, css: "x".repeat(8001) }))
    await sleep(100)
    assert.equal(h.notes(), "1:queued")
  } finally {
    await h.close()
  }
})

// ── the app's own slash commands ─────────────────────────────────────────────────────────────────

const requestsTo = (h: { server: FakeServer }, end: string) => h.server.requests.filter((r) => r.path.endsWith(end) && r.method !== "GET")

test("commands: the app's own come first and win over a server command of the same name; without the server's list they still work", async () => {
  const h = await boot()
  try {
    await h.ready()
    h.server.route("GET", "/api/command", { json: { data: [{ name: "review", description: "review changes" }, { name: "compact", description: "the server's own" }, { name: "init" }] } })
    const list = (await h.cmd("commands")) as { name: string; description?: string; builtin?: true }[]
    assert.deepEqual(list.map((c) => `${c.builtin ? "*" : ""}${c.name}`), ["*compact", "*new", "*undo", "*redo", "*rename", "*fork", "*checkpoint", "review", "init"])
    assert.ok(list.every((c) => !c.builtin || c.description), "each says what it does")
    // The same name goes to the app, not to the server's /command.
    h.server.route("POST", /\/compact$/, { json: { data: { id: "msg_c", type: "compaction", payload: {}, delivery: "steer" } } })
    h.server.route("POST", /\/command$/, {})
    await h.cmd("runCommand", "compact", "")
    assert.equal(requestsTo(h, "/command").length, 0)
    assert.equal(requestsTo(h, "/compact").length, 1)
  } finally {
    await h.close()
  }
  const down = await boot()
  try {
    await down.ready()
    down.server.route("GET", "/api/command", { status: 500, json: { _tag: "UnknownError", message: "boom" } })
    const list = (await down.cmd("commands")) as { name: string }[]
    assert.deepEqual(list.map((c) => c.name), ["compact", "new", "undo", "redo", "rename", "fork", "checkpoint"])
  } finally {
    await down.close()
  }
})

test("/compact: the request goes out, the summary streams into the conversation, and the notes are not touched", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.server.route("POST", `/api/session/${s}/compact`, { json: { data: { id: "msg_c", type: "compaction", payload: {}, delivery: "steer" } } })
    h.note("a")
    h.note("b")
    await until(() => h.w.prompts.length === 2)
    const [m1, m2] = h.w.prompts.map((p) => p.id)
    h.agent.starts(s)
    h.agent.picksUp(s, m1!)
    await until(() => h.notes() === "1:working 2:queued")

    assert.equal(await h.cmd("runCommand", "compact", "these words go nowhere", [], {}), undefined)
    const sent = requestsTo(h, "/compact")
    assert.deepEqual(sent.map((r) => [r.method, r.path, r.body]), [["POST", `/api/session/${s}/compact`, {}]])
    // While the agent works the message box asks to queue or to interrupt; that is passed on.
    await h.cmd("runCommand", "compact", "", [], { delivery: "queue" })
    assert.deepEqual(requestsTo(h, "/compact")[1]!.body, { delivery: "queue" })

    // The server queues it, takes it at the next step boundary and writes the summary.
    const before = h.chat().length
    h.emit("session.inbox.enqueued", s, { inboxID: "msg_c", item: { type: "compaction", payload: {}, delivery: "steer" } })
    h.emit("session.inbox.delivered", s, { inboxID: "msg_c" })
    h.emit("session.compaction.started", s, { reason: "manual", inputID: "msg_c" })
    h.emit("session.compaction.delta", s, { text: "So far: " })
    h.emit("session.compaction.delta", s, { text: "a is in hand." })
    h.emit("session.compaction.ended", s, { reason: "manual", text: "So far: a is in hand, b waits." })
    await until(() => h.chat().some((e) => e.type === "item" && e.item.kind === "assistant" && e.item.summary === "manual" && e.item.done))
    const events = h.chat().slice(before)
    assert.deepEqual(events.map((e) => e.type), ["item", "part", "delta", "item"])
    assert.deepEqual(events.at(-1), {
      type: "item",
      session: s,
      item: { kind: "assistant", id: "msg_c", time: (events[0] as { item: { time: number } }).item.time, parts: [{ kind: "text", key: "text:0", text: "So far: a is in hand, b waits." }], done: true, summary: "manual" },
    })
    assert.equal(h.notes(), "1:working 2:queued", "the summary's place in the queue is not a note's delivery")
    assert.equal(h.snap().session!.busy, true, "Stop still has something to stop")

    // The run goes on where it was: the queued note is picked up and both finish.
    h.agent.picksUp(s, m2!)
    await until(() => h.notes() === "1:done 2:working")
    h.agent.finishes(s)
    await until(() => h.notes() === "1:done 2:done")

    // Nothing to summarise is an answer in the conversation, and a refusal is passed on as it is.
    h.emit("session.compaction.failed", s, { reason: "manual", inputID: "msg_c2", error: { type: "compaction.unavailable", message: "Nothing to compact yet" } })
    await until(() => h.chat().some((e) => e.type === "item" && e.item.kind === "marker" && e.item.text === "The conversation was not summarised: Nothing to compact yet."))
    h.server.route("POST", `/api/session/${s}/compact`, { status: 409, json: { _tag: "ConflictError", message: "Compaction input ID conflicts with an existing durable record" } })
    await assert.rejects(Promise.resolve(h.cmd("runCommand", "compact", "")), /conflicts with an existing durable record/)
    assert.equal(h.notes(), "1:done 2:done")
  } finally {
    await h.close()
  }
})

test("/undo says what it will take back and waits for a yes; /redo brings it back; both re-read the conversation", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    const note = "UI review note 1 on http://site.test/, window 800×600 @1x.\nNote: make it blue\nMake the smallest change that does this. Don't touch unrelated code. Reply in one line."
    let newestFirst: object[] = [{ id: "msg_3", type: "user", text: "tighter" }, { id: "msg_2", type: "assistant", content: [] }, { id: "msg_1", type: "user", text: note }]
    h.server.route("GET", /^\/api\/session\/[^/]+\/message$/, (req) => ({ json: { data: req.query.get("order") === "desc" ? newestFirst : [...newestFirst].reverse(), cursor: { previous: null, next: null } } }))
    h.server.route("POST", `/api/session/${s}/revert/stage`, (req) => {
      ;(h.w.sessions.get(s) as Record<string, unknown>).revert = { messageID: (req.body as { messageID: string }).messageID }
      return { json: { data: { messageID: (req.body as { messageID: string }).messageID } } }
    })
    h.server.route("DELETE", `/api/session/${s}/revert`, () => {
      delete (h.w.sessions.get(s) as Record<string, unknown>).revert
      return {}
    })

    await assert.rejects(Promise.resolve(h.cmd("runCommand", "redo", "")), /Nothing to redo\./)

    // First: only words. Nothing is asked of the server but what the last message is.
    const asked = (await h.cmd("runCommand", "undo", "")) as { say: string; draft: string }
    assert.equal(asked.draft, "/undo yes")
    assert.equal(asked.say, 'This takes back your message "tighter" and everything after it: the agent\'s replies, and the changes it made to files since then. Press Enter to undo.')
    assert.equal(requestsTo(h, "/revert/stage").length, 0)

    const reloads = () => h.page.sent.filter((m) => m.type === "RELOAD").length
    assert.equal(reloads(), 0)
    const done = (await h.cmd("runCommand", "undo", "yes")) as { say: string; draft?: string }
    assert.deepEqual(requestsTo(h, "/revert/stage").map((r) => r.body), [{ messageID: "msg_3" }])
    assert.equal(reloads(), 1, "the files went back: the page is loaded again to show them")
    assert.equal(done.draft, "tighter", "a typed message comes back into the box")
    assert.match(done.say, /^Took back your message "tighter"\. \/redo brings it back/)
    // The server says so on the stream; the conversation on screen is read again, cut at the boundary.
    h.emit("session.revert.staged", s, { revert: { messageID: "msg_3" } })
    await until(() => h.chat().some((e) => e.type === "reset" && e.items.some((i) => i.id === "undone:msg_3")))
    await until(() => h.snap().session?.undone === "msg_3")

    // The next undo is about the note before it, named as a note; a note does not come back into the box.
    const next = (await h.cmd("runCommand", "undo", "")) as { say: string }
    assert.match(next.say, /^This takes back note 1 \("make it blue"\) and everything after it/)
    const second = (await h.cmd("runCommand", "undo", "yes")) as { say: string; draft?: string }
    assert.equal(second.draft, undefined)
    assert.deepEqual(requestsTo(h, "/revert/stage").at(-1)!.body, { messageID: "msg_1" })
    await assert.rejects(Promise.resolve(h.cmd("runCommand", "undo", "yes")), /Nothing to undo\./)

    const shown = reloads()
    assert.deepEqual(await h.cmd("runCommand", "redo", ""), { say: "Brought back what was undone." })
    assert.equal(reloads(), shown + 1, "…and again when they are brought back")
    assert.equal(requestsTo(h, "/revert").filter((r) => r.method === "DELETE").length, 1)
    h.emit("session.revert.cleared", s)
    await until(() => h.snap().session?.undone === undefined)

    // Not while the agent works: said here, before the server is asked.
    h.agent.starts(s)
    await until(() => h.snap().session!.busy)
    await assert.rejects(Promise.resolve(h.cmd("runCommand", "undo", "yes")), /The agent is working\. Stop it first, then \/undo\./)
    newestFirst = []
  } finally {
    await h.close()
  }
})

test("/rename, /fork and /new: the name goes to the server, a fork becomes the site's conversation, /new starts one", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.server.route("PATCH", `/api/session/${s}`, (req) => {
      Object.assign(h.w.sessions.get(s)!, { title: (req.body as { title: string }).title })
      return {}
    })
    await assert.rejects(Promise.resolve(h.cmd("runCommand", "rename", "  ")), /Type the new name after \/rename\./)
    assert.deepEqual(await h.cmd("runCommand", "rename", " Pricing page "), { say: 'Renamed to "Pricing page".' })
    assert.deepEqual(h.server.requests.find((r) => r.method === "PATCH")!.body, { title: "Pricing page" })
    assert.equal(h.snap().session!.title, "Pricing page")

    h.server.route("POST", `/api/session/${s}/fork`, () => {
      const copy = { id: "ses_copy", location: { directory: "/repo" }, title: "Pricing page (fork)", time: { created: 5, updated: 5 } }
      h.w.sessions.set(copy.id, copy)
      return { json: { data: copy } }
    })
    const forked = (await h.cmd("runCommand", "fork", "")) as { say: string }
    assert.match(forked.say, /^This is a copy\./)
    assert.equal(h.snap().session!.id, "ses_copy")
    h.note("goes to the copy")
    await until(() => h.w.prompts.length === 1)
    assert.equal(h.w.prompts[0]!.session, "ses_copy")

    const creates = h.w.creates
    await h.cmd("runCommand", "new", "")
    assert.equal(h.w.creates, creates + 1)
    assert.notEqual(h.snap().session!.id, "ses_copy")
  } finally {
    await h.close()
  }
})

test("an older server without the events for summaries: the app still connects, and /compact shows the summary once it is written", async () => {
  const fake = await fakeOpenCode()
  fake.server.unknownEvents = /^session\.(compaction|revert)\./
  const h = await boot({ server: fake })
  try {
    const s = await h.ready()
    assert.equal(h.snap().connection.status, "online")
    const filters = h.server.requests.filter((r) => r.path === "/api/event").map((r) => r.query.getAll("types").some((t) => t.startsWith("session.compaction.")))
    assert.deepEqual(filters, [true, false], "asked with the newer names, refused, asked again without")

    // Notes still travel on the events this server has.
    h.note("a")
    await until(() => h.w.prompts.length === 1)
    h.agent.starts(s)
    h.agent.picksUp(s, h.w.prompts[0]!.id)
    await until(() => h.notes() === "1:working")

    // /compact: the request goes out; nothing will announce the summary, so nothing is shown yet.
    const messages: object[] = [{ id: "msg_u", type: "user", time: { created: 1 }, text: "hello" }]
    h.server.route("GET", /^\/api\/session\/[^/]+\/message$/, () => ({ json: { data: messages, cursor: { previous: null, next: null } } }))
    h.server.route("POST", `/api/session/${s}/compact`, { json: { data: { id: "msg_c", type: "compaction", payload: {}, delivery: "steer" } } })
    const before = h.chat().length
    await h.cmd("runCommand", "compact", "")
    await sleep(60)
    assert.deepEqual(h.chat().slice(before).filter((e) => e.type === "reset"), [])

    // The server writes it between two steps; the next step starting is when the app reads it back.
    messages.push({ id: "msg_c", type: "compaction", status: "completed", reason: "manual", summary: "So far: said hello.", time: { created: 5 } })
    h.emit("session.step.started", s, { assistantMessageID: "msg_a9", started: 9 })
    await until(() => h.chat().slice(before).some((e) => e.type === "reset"))
    const reset = h.chat().slice(before).find((e) => e.type === "reset") as Extract<ChatEvent, { type: "reset" }>
    assert.deepEqual(reset.items, [
      { kind: "user", id: "msg_u", time: 1, text: "hello", images: [] },
      { kind: "assistant", id: "msg_c", time: 5, parts: [{ kind: "text", key: "text:0", text: "So far: said hello." }], done: true, summary: "manual" },
    ])
    assert.equal(h.notes(), "1:working", "the note is where it was")
    h.agent.finishes(s)
    await until(() => h.notes() === "1:done")

    // /undo and /redo: read back at once, cut at the boundary and whole again.
    h.server.route("POST", `/api/session/${s}/revert/stage`, (req) => {
      ;(h.w.sessions.get(s) as Record<string, unknown>).revert = { messageID: (req.body as { messageID: string }).messageID }
      return { json: { data: req.body } }
    })
    h.server.route("DELETE", `/api/session/${s}/revert`, () => {
      delete (h.w.sessions.get(s) as Record<string, unknown>).revert
      return {}
    })
    h.server.route("GET", /^\/api\/session\/[^/]+\/message$/, (req) => ({ json: { data: req.query.get("order") === "desc" ? [...messages].reverse() : messages, cursor: { previous: null, next: null } } }))
    await h.cmd("runCommand", "undo", "yes")
    await until(() => h.chat().some((e) => e.type === "reset" && e.items.length === 1 && e.items[0]!.id === "undone:msg_u"))
    await until(() => h.snap().session?.undone === "msg_u")
    const resets = h.chat().filter((e) => e.type === "reset").length
    await h.cmd("runCommand", "redo", "")
    await until(() => h.chat().filter((e) => e.type === "reset").length > resets)
    assert.deepEqual((h.chat().filter((e) => e.type === "reset").at(-1) as Extract<ChatEvent, { type: "reset" }>).items.map((i) => i.id), ["msg_u", "msg_c"])
    await until(() => h.snap().session?.undone === undefined)
  } finally {
    await h.close()
  }
})

// ── the model new conversations start with ───────────────────────────────────────────────────────

const model = (providerID: string, id: string, images = true, variants: string[] = []) => ({ providerID, id, name: id, capabilities: { input: images ? ["text", "image"] : ["text"] }, variants: variants.map((v) => ({ id: v })), enabled: true, status: "active" })
const THREE = [model("local", "text-only", false), model("acme", "vision", true, ["low", "high"]), model("acme", "vision-mini")]
async function withModels(list: unknown[] | FakeReply, settings: Record<string, unknown> = {}) {
  const fake = await fakeOpenCode()
  fake.server.route("GET", "/api/model", Array.isArray(list) ? { json: { data: list } } : list)
  const h = await boot({ server: fake, settings: { ...savedSite(), ...settings } })
  await h.cmd("connect", { url: h.server.url, password: h.server.password })
  const created = () => h.server.requests.filter((r) => r.method === "POST" && r.path === "/api/session").map((r) => (r.body as { model?: unknown }).model)
  return { h, created }
}

test("first launch on a server with several models: the app asks, makes no conversation meanwhile, and the first one starts on the answer", async () => {
  const { h, created } = await withModels(THREE)
  try {
    await until(() => !!h.snap().modelChoice)
    assert.deepEqual(h.snap().modelChoice, { suggested: { providerID: "acme", id: "vision" } }, "the first that takes screenshots is offered")
    await sleep(100)
    assert.equal(h.snap().session, null)
    assert.deepEqual(created(), [], "no conversation on a model nobody chose")

    await assert.rejects(Promise.resolve(h.cmd("setDefaultModel", { providerID: "acme", id: "gone" })), /does not offer that model/)
    await assert.rejects(Promise.resolve(h.cmd("setDefaultModel", null)), /does not offer that model/)
    assert.ok(h.snap().modelChoice, "still asking")

    // An effort level the model does not have is dropped; one it has is kept.
    await h.cmd("setDefaultModel", { providerID: "acme", id: "vision-mini", variant: "high" })
    assert.equal(h.snap().modelChoice, undefined)
    assert.deepEqual(h.snap().defaultModel, { providerID: "acme", id: "vision-mini" })
    await until(() => !!h.snap().session)
    assert.deepEqual(created(), [{ providerID: "acme", id: "vision-mini" }])

    // Changed later (the settings dialog): the open conversation stays as it is, the next new one follows.
    const open = h.snap().session!.id
    await h.cmd("setDefaultModel", { providerID: "acme", id: "vision", variant: "high" })
    assert.equal(h.snap().session!.id, open)
    assert.deepEqual(h.snap().defaultModel, { providerID: "acme", id: "vision", variant: "high" })
    await h.cmd("newSession")
    assert.deepEqual(created(), [{ providerID: "acme", id: "vision-mini" }, { providerID: "acme", id: "vision", variant: "high" }])
    await sleep(400) // the store's debounce
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8")).defaultModel, { providerID: "acme", id: "vision", variant: "high" })
  } finally {
    await h.close()
  }
})

test("a saved model the server still lists: nothing is asked", async () => {
  const { h, created } = await withModels(THREE, { defaultModel: { providerID: "local", id: "text-only" } })
  try {
    await until(() => !!h.snap().session)
    assert.equal(h.snap().modelChoice, undefined)
    assert.deepEqual(created(), [{ providerID: "local", id: "text-only" }], "the person's choice, even one that takes no screenshots")
  } finally {
    await h.close()
  }
})

test("a saved model the server no longer lists: the app asks again and says which one went; the open conversation stays", async () => {
  const fake = await fakeOpenCode()
  fake.w.sessions.set("ses_live", { id: "ses_live", location: { directory: "/repo" }, title: "t", time: { created: 1, updated: 2 } })
  fake.server.route("GET", "/api/model", { json: { data: THREE } })
  const h = await boot({ server: fake, settings: { ...savedSite({ session: "ses_live" }), defaultModel: { providerID: "retired", id: "old-model", variant: "high" } } })
  try {
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    await until(() => !!h.snap().modelChoice && !!h.snap().session)
    assert.deepEqual(h.snap().modelChoice, { suggested: { providerID: "acme", id: "vision" }, previous: { providerID: "retired", id: "old-model", variant: "high" } })
    assert.equal(h.snap().session!.id, "ses_live", "a conversation that exists needs no answer to open")
    assert.equal(h.w.creates, 0)
    await h.cmd("setDefaultModel", { providerID: "acme", id: "vision" })
    assert.equal(h.snap().modelChoice, undefined)
    assert.equal(h.w.creates, 0)
    // Another server, another list: asked as for a first server. The model chosen for the one before is its own.
    const other = await fakeOpenCode()
    other.server.route("GET", "/api/model", { json: { data: [model("zeta", "a"), model("zeta", "b")] } })
    await h.cmd("connect", { url: other.server.url, password: other.server.password })
    await until(() => !!h.snap().modelChoice)
    assert.deepEqual(h.snap().modelChoice, { suggested: { providerID: "zeta", id: "a" } })
    await Promise.resolve(h.cmd("disconnect")).catch(() => undefined)
    assert.equal(h.snap().modelChoice, undefined)
    await other.server.stop()
  } finally {
    await h.close()
  }
})

test("one model, no models, or a list that cannot be read: nothing is asked and setup goes on", async () => {
  const one = await withModels([model("acme", "only", false)])
  try {
    await until(() => !!one.h.snap().session)
    assert.equal(one.h.snap().modelChoice, undefined)
    assert.deepEqual(one.created(), [{ providerID: "acme", id: "only" }])
    await sleep(400)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(one.h.dir, "settings.json"), "utf8")).defaultModel, { providerID: "acme", id: "only" }, "nothing to choose between: it is saved")
  } finally {
    await one.h.close()
  }
  for (const list of [[], { status: 500, json: { _tag: "UnknownError", message: "boom" } }] as const) {
    const none = await withModels(list as unknown[] | FakeReply, { defaultModel: { providerID: "acme", id: "kept" } })
    try {
      await until(() => !!none.h.snap().session)
      assert.equal(none.h.snap().modelChoice, undefined)
      assert.equal(none.h.snap().defaultModel, undefined)
      assert.deepEqual(none.created(), [undefined], "the server's own default, as before")
      assert.deepEqual(none.h.snap().models, [])
      await sleep(400)
      const saved = fs.existsSync(path.join(none.h.dir, "settings.json")) ? JSON.parse(fs.readFileSync(path.join(none.h.dir, "settings.json"), "utf8")) : {}
      assert.deepEqual(saved.defaultModel, { providerID: "acme", id: "kept" }, "an unreadable list does not cost the saved choice")
    } finally {
      await none.h.close()
    }
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

test("a server's name: saved with it, kept when the same server connects again, dropped for another one", async () => {
  const h = await boot()
  try {
    await h.ready()
    assert.equal(h.snap().serverName, "fake-box", "until it is named, it goes by its computer's own name, without .local")
    await h.cmd("setServerName", "  Studio   Mac ")
    assert.equal(h.snap().serverName, "Studio Mac")
    const saved = async () => {
      await sleep(400) // the store's debounce
      return JSON.parse(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8")).server as { name?: string; password?: string }
    }
    const first = await saved()
    assert.deepEqual([first.name, typeof first.password], ["Studio Mac", "string"])
    await h.cmd("setServerName", "x".repeat(200))
    assert.equal(h.snap().serverName?.length, 60, "a label, not a description")
    await h.cmd("setServerName", "Studio Mac")
    // the same server again (the password re-entered): still named
    await h.cmd("connect", { url: h.server.url, password: h.server.password })
    assert.equal(h.snap().serverName, "Studio Mac")
    // an empty name goes back to the computer's own
    await h.cmd("setServerName", "   ")
    assert.equal(h.snap().serverName, "fake-box")
    assert.equal((await saved()).name, undefined)
    // a name does not follow to another server
    await h.cmd("setServerName", "Studio Mac")
    await h.cmd("connect", { url: h.server.url.replace("127.0.0.1", "localhost"), password: h.server.password })
    assert.equal(h.snap().serverName, "fake-box")
    await h.cmd("disconnect")
    await assert.rejects(Promise.resolve(h.cmd("setServerName", "x")), /Connect to a server first/)
  } finally {
    await h.close()
  }
})

// ── conversations: what they are called, and the list ──────────────────────────────────────────

test("a conversation is named after the first thing said in it, once; a name somebody gave is kept", async () => {
  const world = await fakeOpenCode()
  world.w.named = true
  const h = await boot({ server: world })
  try {
    const s = await h.ready()
    assert.equal(h.snap().session!.title, "Review · site.test", "until something is said, it is called where it is")
    h.note("make the  buy button bigger.\nand greener")
    await until(() => h.snap().session!.title === "Make the buy button bigger")
    assert.equal(h.w.sessions.get(s)!.title, "Make the buy button bigger", "the server has the name too")
    assert.deepEqual(h.snap().sessions.map((x) => [x.title, x.notes, x.said]), [["Make the buy button bigger", 1, "make the  buy button bigger.\nand greener"]])
    h.note("the footer is too tall")
    await until(() => h.w.prompts.length === 2)
    await sleep(50)
    assert.equal(h.snap().session!.title, "Make the buy button bigger", "the second note does not rename it")

    // A new conversation, named by a message typed into the chat; then by hand, which stays.
    await h.cmd("newSession")
    await until(() => !!h.snap().session && h.snap().session!.id !== s)
    const second = h.snap().session!.id
    await h.cmd("send", "why is the header sticky?")
    await until(() => h.snap().session!.title === "Why is the header sticky?")
    await h.cmd("renameSession", second, "  Header   questions ")
    assert.equal(h.snap().session!.title, "Header questions")
    await h.cmd("send", "and the footer?")
    await sleep(50)
    assert.equal(h.w.sessions.get(second)!.title, "Header questions")
    await assert.rejects(h.cmd("renameSession", second, "   "), /Type a name/)
  } finally {
    await h.close()
  }
})

test("the list: a pin goes first and is saved; archiving or deleting the open conversation opens the most recent other one", async () => {
  const world = await fakeOpenCode()
  const h = await boot({ server: world })
  try {
    const first = await h.ready()
    await h.cmd("newSession")
    await until(() => !!h.snap().session && h.snap().session!.id !== first)
    const second = h.snap().session!.id
    await h.cmd("newSession")
    await until(() => ![first, second, undefined].includes(h.snap().session?.id))
    const third = h.snap().session!.id
    await until(() => h.snap().sessions.length === 3)
    assert.deepEqual(h.snap().sessions.map((x) => x.id), [third, second, first], "newest first")

    await h.cmd("pinSession", first, true)
    await until(() => h.snap().sessions[0]!.id === first)
    assert.deepEqual(h.snap().sessions.map((x) => [x.id, !!x.pinned]), [[first, true], [third, false], [second, false]])
    const saved = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(h.dir, "settings.json"), "utf8")).sites[SITE]
      } catch {
        return undefined // not written yet
      }
    }
    await until(() => saved()?.pinned?.[0] === first)

    // Archive the open one: out of the list, on the server still, and the site is on another.
    h.note("a")
    await until(() => h.w.prompts.length === 1)
    await h.cmd("archiveSession", third, true)
    await until(() => h.snap().session?.id === second)
    assert.deepEqual(h.snap().sessions.map((x) => x.id), [first, second])
    assert.equal(h.notes(), "1:queued", "its note still runs")
    assert.deepEqual(((await h.cmd("archivedSessions")) as { id: string; archived?: boolean }[]).map((x) => [x.id, x.archived]), [[third, true]])
    await h.cmd("archiveSession", third, false)
    await until(() => h.snap().sessions.length === 3)
    assert.deepEqual(await h.cmd("archivedSessions"), [])

    // Delete the open one: the most recent other one opens, and no new conversation is made.
    const made = h.w.creates
    await h.cmd("deleteSession", second)
    h.emit("session.deleted", second)
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
    h.emit("session.deleted", third)
    await until(() => h.notes() === "1:failed")
    await until(() => !!h.snap().session && h.snap().session!.id !== third)
    assert.equal(h.w.creates, made + 1)
  } finally {
    await h.close()
  }
})

// ── a finished note: the verdict, the diff, taking it back; checkpoints; the repo ───────────────

test("a finished note is accepted, shows what changed for it, and is taken back by asking the agent", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.note("a")
    h.note("b")
    await until(() => h.w.prompts.length === 2)
    h.agent.starts(s)
    h.agent.picksUp(s, h.w.prompts[0]!.id)
    h.agent.picksUp(s, h.w.prompts[1]!.id)
    h.agent.finishes(s)
    await until(() => h.notes() === "1:done 2:done")
    const [a] = h.snap().review.notes
    assert.equal(a!.sent, true)

    await h.cmd("acceptNote", a!.id, true)
    assert.equal(h.snap().review.notes[0]!.accepted, true)
    assert.deepEqual(await h.cmd("noteDiff", a!.id), [{ file: "src/a.css", patch: `@@ -1 +1 @@\n-a\n+b ${h.w.prompts[0]!.id}`, additions: 1, deletions: 1 }])

    // Not the newest message (the fake server lists none): the agent is asked, in the note's conversation.
    const reloads = () => h.page.sent.filter((m) => m.type === "RELOAD").length
    const shown = reloads()
    assert.equal(await h.cmd("takeBackNote", a!.id), "asked")
    assert.equal(h.w.prompts.length, 3)
    // No note is finished by that run, but the files change in it: the page is loaded again
    // when it ends, and only then.
    h.agent.starts(s)
    await sleep(50)
    assert.equal(reloads(), shown)
    h.agent.finishes(s)
    await until(() => reloads() === shown + 1)
    // A later run that takes nothing back leaves the page alone.
    h.agent.starts(s)
    h.agent.finishes(s)
    await sleep(100)
    assert.equal(reloads(), shown + 1)
    assert.equal(h.w.prompts[2]!.session, s)
    const row = h.snap().review.notes[0]!
    assert.deepEqual([row.status, row.takenBack, row.accepted], ["done", "asked", undefined])
    await assert.rejects(h.cmd("takeBackNote", a!.id), /already taken back/)
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
    await h.close()
  }
})

test("a note's row names its conversation; take back says which way it will go, and does not go the other way", async () => {
  const h = await boot()
  try {
    const old = await h.ready()
    const text = (n: number) => `UI review note ${n} on http://site.test/, window 800×600 @1x.\nNote: x\nMake the smallest change that does this.`
    // The old conversation's newest message is note 2; the new one's is a typed message after note 3.
    const newestFirst = (s: string): object[] =>
      s === old
        ? [{ id: h.w.prompts[1]!.id, type: "user", text: text(2) }, { id: h.w.prompts[0]!.id, type: "user", text: text(1) }]
        : [{ id: "msg_typed", type: "user", text: "and the footer" }, { id: h.w.prompts[2]!.id, type: "user", text: text(3) }]
    h.server.route("GET", /^\/api\/session\/[^/]+\/message$/, (req) => {
      const list = newestFirst(req.path.split("/")[3]!)
      return { json: { data: req.query.get("order") === "desc" ? list : [...list].reverse(), cursor: { previous: null, next: null } } }
    })
    h.server.route("POST", /\/revert\/stage$/, (req) => ({ json: { data: { messageID: (req.body as { messageID: string }).messageID } } }))

    h.note("a")
    h.note("b")
    await until(() => h.w.prompts.length === 2)
    h.agent.starts(old)
    h.agent.picksUp(old, h.w.prompts[0]!.id)
    h.agent.picksUp(old, h.w.prompts[1]!.id)
    h.agent.finishes(old)
    await until(() => h.notes() === "1:done 2:done")
    await h.cmd("newSession")
    const neu = h.snap().session!.id
    h.note("c")
    await until(() => h.w.prompts.length === 3)
    h.agent.starts(neu)
    h.agent.picksUp(neu, h.w.prompts[2]!.id)
    h.agent.finishes(neu)
    await until(() => h.notes() === "1:done 2:done 3:done")

    const [a, b, c] = h.snap().review.notes
    assert.deepEqual([a!.session, b!.session, c!.session], [old, old, neu], "each note says where it went, the open conversation or not")

    // Note 1 has note 2 on top of it, note 3 a typed message: the agent is asked. Note 2 is the
    // newest message of its conversation, which is idle and not the open one: an exact undo.
    assert.equal(await h.cmd("takeBackWay", a!.id), "asked")
    assert.equal(await h.cmd("takeBackWay", c!.id), "asked")
    assert.equal(await h.cmd("takeBackWay", b!.id), "undone")
    assert.equal(h.w.prompts.length, 3, "asking how changes nothing")
    assert.equal(requestsTo(h, "/revert/stage").length, 0)
    assert.deepEqual(h.snap().review.notes.map((n) => n.takenBack), [undefined, undefined, undefined])
    // A busy conversation cannot be undone, whatever its newest message is.
    h.agent.starts(old)
    await sleep(50)
    assert.equal(await h.cmd("takeBackWay", b!.id), "asked")
    h.agent.finishes(old)
    await sleep(50)
    assert.equal(await h.cmd("takeBackWay", b!.id), "undone")

    // The question said "asked"; by now it would be an exact undo, or the other way round: nothing is done.
    await assert.rejects(h.cmd("takeBackNote", b!.id, "asked"), /changed meanwhile/)
    await assert.rejects(h.cmd("takeBackNote", a!.id, "undone"), /changed meanwhile/)
    assert.equal(h.w.prompts.length, 3)
    assert.equal(requestsTo(h, "/revert/stage").length, 0)

    assert.equal(await h.cmd("takeBackNote", b!.id, "undone"), "undone")
    assert.deepEqual(requestsTo(h, "/revert/stage").map((r) => [r.path, r.body]), [[`/api/session/${old}/revert/stage`, { messageID: h.w.prompts[1]!.id }]])
    assert.equal(await h.cmd("takeBackNote", a!.id, "asked"), "asked")
    assert.equal(h.w.prompts[3]!.session, old, "the agent of the note's own conversation is asked")
    assert.deepEqual(h.snap().review.notes.map((n) => n.takenBack), ["asked", "undone", undefined])

    await assert.rejects(h.cmd("takeBackWay", b!.id), /already taken back/)
    await assert.rejects(h.cmd("takeBackWay", "nope"), /Only a finished note/)
  } finally {
    await h.close()
  }
})

test("a checkpoint is a line in the conversation, kept by the app; the repo's branch and changes are told, and a commit is asked of the agent", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    await until(() => !!h.snap().repo)
    assert.deepEqual(h.snap().repo, { branch: "polish", changes: [{ file: "src/a.css", additions: 1, deletions: 1, status: "modified" }, { file: "src/new.css", additions: 4, deletions: 0, status: "added" }] })

    await h.cmd("addCheckpoint", "  before  the hero ")
    const marker = h.chat().flatMap((e) => (e.type === "item" && e.item.kind === "marker" && e.item.checkpoint ? [e.item] : []))[0]!
    assert.equal(marker.text, "before the hero")
    await assert.rejects(h.cmd("returnToCheckpoint", marker.checkpoint), /Nothing has been said since/)
    await assert.rejects(h.cmd("returnToCheckpoint", "nope"), /checkpoint is gone/)
    // It comes back with the conversation when that is read again.
    await h.cmd("openSession", s)
    await until(() => h.chat().some((e) => e.type === "reset" && e.items.some((i) => i.kind === "marker" && i.checkpoint === marker.checkpoint)))
    await h.cmd("removeCheckpoint", marker.checkpoint)
    assert.ok(h.chat().some((e) => e.type === "remove" && e.item === marker.id))

    await h.cmd("commitChanges", "Tidy the hero\n\n- more air")
    assert.equal(h.w.prompts.length, 1)
    assert.equal(h.w.prompts[0]!.session, s)
    await assert.rejects(h.cmd("commitChanges", "  "), /Write what the commit is/)
  } finally {
    await h.close()
  }
})


test("the newest note is taken back exactly and a checkpoint is returned to: the page shows the files again, and a note taken back gets no second picture", async () => {
  const h = await boot()
  try {
    const s = await h.ready()
    h.page.capture = () => shot("p")
    h.page.evaluate = (js) => (js === "innerWidth" ? 800 : [0, 0])
    const finish = async (text: string) => {
      const id = h.note(text)
      const n = h.w.prompts.length
      await until(() => h.w.prompts.length === n + 1)
      h.agent.starts(s)
      h.agent.picksUp(s, h.w.prompts[n]!.id)
      h.agent.finishes(s)
      await until(() => h.snap().review.notes.find((r) => r.id === id)?.status === "done")
      return id
    }
    const row = (id: string) => h.snap().review.notes.find((r) => r.id === id)!
    const reloads = () => h.page.sent.filter((m) => m.type === "RELOAD").length
    // The server's side: the conversation's messages, and an undo that it holds.
    // The first note is from before the checkpoint, what follows from after it.
    const later = Date.now() + 60_000
    const messages = () => h.w.prompts.map((p, i) => ({ id: p.id, type: "user", text: p.text, time: { created: i ? later + i : 1 } }))
    h.server.route("GET", /^\/api\/session\/[^/]+\/message$/, (req) => ({ json: { data: req.query.get("order") === "desc" ? messages().reverse() : messages(), cursor: { previous: null, next: null } } }))
    h.server.route("POST", `/api/session/${s}/revert/stage`, (req) => ({ json: { data: { messageID: (req.body as { messageID: string }).messageID } } }))

    // A finished note is pictured again a moment later.
    const a = await finish("a")
    assert.equal(row(a).pictures, "before")
    await until(() => row(a).pictures === "both", 6000)

    await h.cmd("addCheckpoint", "after a")
    const cp = h.chat().flatMap((e) => (e.type === "item" && e.item.kind === "marker" && e.item.checkpoint ? [e.item.checkpoint] : []))[0]!

    // The newest one, taken back before that moment: the server's undo, the page loaded again,
    // and no picture of an area that is as it was before the note.
    const b = await finish("b")
    const shown = reloads()
    assert.equal(await h.cmd("takeBackNote", b), "undone")
    assert.deepEqual(requestsTo(h, "/revert/stage").map((r) => r.body), [{ messageID: h.w.prompts[1]!.id }])
    assert.equal(reloads(), shown + 1)
    await sleep(2600)
    assert.equal(row(b).pictures, "before")
    assert.equal(row(a).pictures, "both")

    // Back to the checkpoint: everything said after it, files included, so the page again.
    assert.equal(await h.cmd("returnToCheckpoint", cp), 1)
    assert.deepEqual(requestsTo(h, "/revert/stage").at(-1)!.body, { messageID: h.w.prompts[1]!.id })
    assert.equal(reloads(), shown + 2)
  } finally {
    await h.close()
  }
})
