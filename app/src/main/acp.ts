// The ACP backend: an agent on this computer that speaks the Agent Client Protocol (Claude Code
// through its adapter, Codex, Gemini CLI, `opencode acp`, …), run by the app as a child process
// and spoken to as JSON-RPC over its stdin and stdout. The only file that knows ACP.
//
//   process    one agent process for all of its conversations: started on the first call,
//              started again (with a growing pause) when it dies, ended with everything it
//              started when the app stops listening (quit, or another server)
//   model      each conversation the app has opened in this process is kept here as ChatItems,
//              built by one path (`apply`) from live session/update notifications and from the
//              replay session/load sends, so a re-read gives the same items with the same ids
//              and part keys and never duplicates anything
//   queue      ACP takes one prompt at a time per conversation; the rest wait here, with the
//              inbox and run events an OpenCode server gives, so notes move the same way
//   ledger     what ACP does not keep and the app needs (a file per agent in `stateDir`): the id
//              the app gave each message it sent (ACP lets a client choose none, and the replay
//              names messages its own way), how each turn ended, the folders and names of the
//              conversations, and the messages that were under way when the process ended
//   local      folders, files for `@`, the branch and its changes: read here, since the agent
//              runs on this computer too
//
// What ACP has no way to do (OpenCode's server does): undo, a diff of a turn, the commands the
// agent left running. `can` says so, and those calls throw a sentence for the person.
//
// Agent payloads are untrusted: what is read beyond the SDK's own checks goes through rec/str/num/list.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { client, ndJsonStream, type ClientContext, type Stream } from "@agentclientprotocol/sdk/unstable"
import { thisMachine, type Machine } from "./machine"
import { clip, defined, endMarker, list, num, rec, str, userItem, type Raw } from "./chat-items"
import type { NamePicture } from "./opencode"
import { unifiedPatch } from "./patch"
import type { PictureSource, Wire } from "./pictures"
import type {
  AgentInfo,
  Answer,
  Backend,
  BackendCan,
  BackendEvent,
  ChatAssistant,
  ChatEvent,
  ChatItem,
  ChatPart,
  ChatUser,
  ContextUse,
  DirEntry,
  FileChange,
  Mention,
  MentionOption,
  ModelInfo,
  ModelRef,
  PermissionAsk,
  PermissionDecision,
  PromptFile,
  Question,
  QuestionField,
  RepoChange,
  SessionSummary,
  SlashCommand,
  ToolStatus,
} from "../shared/types"

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

/** The ACP client: a Backend, plus what the controller asks of its backend beyond the contract. */
export type Acp = Backend & {
  mentionAgents(): Promise<MentionOption[]>
  picture(src: PictureSource): Promise<Wire | undefined>
  /** Messages of this conversation that were with the agent, or waiting for it, when its process
   *  ended (the app quit, or the agent died) and will never finish. Each is said once. */
  lost(session: string): string[]
}

/** How the agent is reached. The app starts a process; the tests hand over a stream. */
export type Transport = {
  stream: Stream
  /** Resolves with why it ended, once it has. */
  exited: Promise<string>
  /** Ends it, and whatever it started. */
  kill(): void
}

export type AcpOptions = {
  /** Names the ledger's file: one per agent. */
  id: string
  /** What the person calls it: "Claude Code". */
  name: string
  /** The program and its arguments. */
  command: string[]
  /** The folder the ledger is kept in. Without one it is kept in memory only. */
  stateDir?: string
  log?: Log
  pictures?: NamePicture
  /** The computer the agent runs on, and its folders are: this one unless said. */
  machine?: Machine
  /** For tests: instead of starting `command`. */
  connect?: () => Transport | Promise<Transport>
  /** Waited for after a message's turn is announced (the `run` and `inbox` events) and before
   *  the message goes to the agent: the controller's snapshot of the folder (core.ts, the app's
   *  own file history), so what the agent changes is never in the turn's "before". At most
   *  `timing.beforeTurn`; a failure does not hold the message. */
  beforeTurn?: (session: string) => Promise<unknown> | undefined
  /** Called right before a message goes to the agent without `beforeTurn` having finished (it
   *  took longer than `timing.beforeTurn`, or failed): what the agent changes in that turn may
   *  be in its "before". */
  turnUntrusted?: (session: string) => void
}

/** Exported so tests can shorten them. Milliseconds. */
export const timing = {
  /** npx fetches an adapter the first time it is run. */
  start: 180_000,
  /** Any call but a prompt, which takes as long as the agent works. */
  request: 120_000,
  retryMin: 1_000,
  retryMax: 30_000,
  /** A process that lived this long was not crashing at start: the next pause is short again. */
  healthy: 60_000,
  /** The longest a message waits for `beforeTurn` (a first snapshot of a large folder). */
  beforeTurn: 20_000,
  /** After Stop, how long the agent has to end its turn before its process is ended. */
  stopGrace: 10_000,
  /** An agent that dies this many times in a row soon after starting is not started again by
   *  itself: the window offers Retry. */
  crashes: 5,
  save: 300,
}

const VERSION = "0.1.0"
/** What the ledger keeps, at most. */
const SESSIONS_KEPT = 400
const SENT_KEPT = 400
const DETAIL_MAX = 4096
/** At most this many files and folders per search: what one `@` list shows. */
const FIND_LIMIT = 20
const FILES_MAX = 50_000
const FILES_FRESH_MS = 15_000

// ── the ledger ──────────────────────────────────────────────────────────────────────────────────

/** A message the app sent: its id, a hash of its text (to know it again in a replay), when it was
 *  taken, and how its turn ended when that was not plainly ("interrupted", or failed with a
 *  reason) with when. */
type Sent = { id: string; key: string; time: number; ended?: number; end?: "interrupted" | "failed"; error?: string }
type Kept = {
  cwd: string
  title?: string
  /** The title is the person's (renamed): the agent's own does not replace it. */
  named?: true
  /** The background conversation of another: not in the list. */
  parent?: string
  updated: number
  archived?: true
  sent: Sent[]
  /** The messages waiting here to be sent, so a crash of the app does not leave them "queued". */
  queued?: string[]
  lost?: string[]
}
type Ledger = { version: 1; sessions: Record<string, Kept>; options?: unknown[]; modes?: unknown }

const textKey = (text: string) => crypto.createHash("sha1").update(text.trim()).digest("hex").slice(0, 16)

// ── the conversation as the app shows it ────────────────────────────────────────────────────────

type Queued = { id: string; text: string; files: PromptFile[]; mentions: Mention[]; time: number }

/** The turn under way (live), or being replayed: where the agent's output goes. */
type Turn = {
  user: string
  assistant: string
  time: number
  ordinal: { text: number; reasoning: number }
  /** The part text is being appended to, and the agent's id for its message: a new id, or a
   *  tool call in between, starts a new part. */
  open?: { key: string; message?: string }
  /** Replayed: what the ledger says of how it ended, put in once its output has been read. */
  sent?: Sent
}

type Conv = {
  id: string
  items: ChatItem[]
  /** The process generation it is loaded in; 0 for none. */
  attached: number
  loading?: Promise<void>
  busy: boolean
  /** The message the agent is on, and how its run is going. */
  running?: { id: string; gen: number; cancelled?: true }
  queue: Queued[]
  /** A stop or a failure: what is queued waits until something is sent again. */
  parked: boolean
  turn?: Turn
  /** Tool calls by id, merged as their updates come: the part is built from the whole. */
  tools: Map<string, { item: string; raw: Raw }>
  options: Raw[]
  modes?: Raw
  commands: SlashCommand[]
  context?: ContextUse
  /** During a replay: the user message being read, and where in the ledger the match is. */
  replay?: { cursor: number; group?: { message?: string; text: string; images: { mime: string; data: string }[] }; count: number }
}

type Pending<T> = { session: string; resolve: (value: T) => void }

const TOOL_STATUS: Record<string, ToolStatus> = { pending: "pending", in_progress: "running", completed: "done", failed: "error" }

/** The window's name for a kind of tool (its icon is picked by name, as OpenCode's tools are). */
const TOOL_NAME: Record<string, string> = { edit: "edit", delete: "edit", move: "edit", execute: "shell", read: "read", search: "grep", fetch: "webfetch", think: "think", switch_mode: "mode" }

const STOPPED_BY: Record<string, string> = {
  max_tokens: "the model reached its limit of words for one answer",
  max_turn_requests: "the agent reached its limit of steps for one message",
  refusal: "the model refused",
}

/** An error the agent sent (JSON-RPC), as a sentence. */
function said(err: unknown): string {
  const e = rec(err)
  const data = rec(e.data)
  const msg = str(data.message) ?? str(data.details) ?? str(e.message) ?? String(err)
  return msg.replace(/\s+/g, " ").trim().slice(0, 300)
}
const code = (err: unknown) => num(rec(err).code)

/** ACP's error for "authentication required", and what agents say when no one is signed in
 *  (not any message with "auth" in it: a path in src/auth/, an author). */
const AUTH_REQUIRED = -32000
const SIGN_IN = /\b(authentication required|auth(entication)? method|not (logged|signed) in|(log|sign) ?in (first|required|again)|please (run \/?login|(log|sign) ?in)|run \/login|login required|invalid api key|api key (is )?(missing|not (set|found))|no api key|unauthori[sz]ed)\b/i
export const needsSignIn = (err: unknown) => code(err) === AUTH_REQUIRED || SIGN_IN.test(said(err))

export { cmdLine } from "./machine"

/** When a file was last written; now when it can't be told. */
function fileTime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return Date.now()
  }
}

/** `file://` URL of an absolute path. */
const fileUri = (abs: string) => "file://" + abs.split("/").map(encodeURIComponent).join("/")

/** The base64 and type of a `data:` URI, as the app's pictures are. */
function dataUri(uri: string): { mime: string; data: string } | undefined {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/is.exec(uri)
  return m ? { mime: m[1]!.toLowerCase(), data: m[2]! } : undefined
}

export function createAcp(opts: AcpOptions): Acp {
  const log: Log = opts.log ?? (() => {})
  const warned = new Set<string>()
  const warn = (msg: string, data?: unknown) => {
    if (warned.has(msg)) return
    warned.add(msg)
    log("warn", msg, data)
  }
  const name = opts.name
  const machine = opts.machine ?? thisMachine()

  // ── the ledger on disk ──────────────────────────────────────────────────────────────────────

  const file = opts.stateDir ? path.join(opts.stateDir, `${opts.id.replace(/[^a-z0-9_-]/gi, "_")}.json`) : undefined
  let ledger: Ledger = { version: 1, sessions: {} }
  if (file) {
    try {
      const read = rec(JSON.parse(fs.readFileSync(file, "utf8")))
      if (read.version === 1 && typeof read.sessions === "object" && read.sessions) ledger = read as unknown as Ledger
    } catch (err) {
      if (rec(err).code !== "ENOENT") warn("The agent's ledger can't be read; starting a new one", String(err))
    }
  }
  /** The app ended without saying so (a crash, a kill): the agent's process went with it, so a
   *  message that was with it (sent, never ended) or waiting here (queued) will never finish.
   *  Each is lost, said once by `lost`, and a turn's end is "failed" for its line in a re-read. */
  function lostAtLoad(at: number) {
    let changed = false
    for (const k of Object.values(ledger.sessions)) {
      if (!k || !Array.isArray(k.sent)) continue
      const ids = k.queued ?? []
      for (const s of k.sent)
        if (!s.ended) {
          Object.assign(s, { ended: Math.max(at, s.time), end: "failed" as const, error: `${name} was stopped` })
          ids.push(s.id)
        }
      if (k.queued) delete k.queued
      if (!ids.length) continue
      k.lost = [...new Set([...(k.lost ?? []), ...ids])]
      changed = true
    }
    if (changed) save()
  }
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  if (file) lostAtLoad(fileTime(file))
  function save(now = false) {
    if (!file) return
    clearTimeout(saveTimer)
    if (!now) return void (saveTimer = setTimeout(() => save(true), timing.save))
    const ids = Object.keys(ledger.sessions)
    if (ids.length > SESSIONS_KEPT)
      for (const id of ids.sort((a, b) => ledger.sessions[a]!.updated - ledger.sessions[b]!.updated).slice(0, ids.length - SESSIONS_KEPT)) delete ledger.sessions[id]
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      warn("The agent's ledger can't be written", String(err))
    }
  }
  /** Keeps the ids waiting in a conversation's queue with its ledger. */
  function queuedNow(c: Conv) {
    const k = ledger.sessions[c.id]
    if (!k) return
    const ids = c.queue.map((q) => q.id)
    if (ids.join("\n") === (k.queued ?? []).join("\n")) return
    if (ids.length) k.queued = ids
    else delete k.queued
    save()
  }
  const kept = (id: string, cwd?: string): Kept | undefined => {
    let k = ledger.sessions[id]
    if (!k && cwd) k = ledger.sessions[id] = { cwd, updated: Date.now(), sent: [] }
    return k
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────────

  let listener: ((event: BackendEvent) => void) | undefined
  function emit(event: BackendEvent) {
    if (!listener) return
    try {
      listener(event)
    } catch (err) {
      log("error", "The event listener threw", err)
    }
  }
  const chat = (event: ChatEvent) => emit({ type: "chat", event })

  // ── the process ─────────────────────────────────────────────────────────────────────────────

  /** `ended`: resolves with why the process ended, once it has. `ending`: the app ended it, and
   *  why (it would not stop a turn): not a crash, and that is its reason. `why`: once it has
   *  ended, the reason, for a message that was about to go to it. */
  type Proc = { gen: number; agent: ClientContext; init: Raw; transport: Transport; started: number; ended: Promise<string>; ending?: string; why?: string }
  let proc: Proc | undefined
  let starting: Promise<Proc> | undefined
  let gen = 0
  /** The last lines the agent wrote to stderr: what it says when it fails to start. */
  let stderrTail: string[] = []
  /** What the agent said it can do, from its answer to `initialize`. */
  let caps: Raw = {}
  let steering = false
  let promptCaps: Raw = {}

  async function spawnAgent(): Promise<Transport> {
    const env = await machine.agentEnv()
    const [program, ...args] = opts.command
    if (!program) throw new Error(`No command to start ${name} with.`)
    const exe = (await machine.which(program, env)) ?? program
    const child = machine.spawn(exe, args, { cwd: machine.home, env })
    stderrTail = []
    child.stderr.on("data", (d: Buffer) => {
      for (const line of String(d).split("\n")) if (line.trim()) stderrTail.push(line.trim().slice(0, 300))
      if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20)
    })
    const exited = child.exited.then((e) =>
      e.error ? (e.error.code === "ENOENT" ? `${program} was not found on ${machine.where}` : said(e.error)) : e.signal ? `it was ended (${e.signal})` : `it exited with code ${e.code}`,
    )
    return { stream: ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>), exited, kill: child.kill }
  }

  /** The agent's process, started if it is not running. One start at a time. */
  function ensure(): Promise<Proc> {
    if (proc) return Promise.resolve(proc)
    starting ??= start().finally(() => (starting = undefined))
    return starting
  }

  async function start(): Promise<Proc> {
    if (closed) throw new Error(`${name} is not in use any more.`)
    let transport: Transport
    try {
      transport = await (opts.connect ?? spawnAgent)()
    } catch (err) {
      throw new Error(`Can't start ${name}: ${said(err)}`)
    }
    const mine = ++gen
    const app = client({ name: "bicycle42" })
      .onNotification("session/update", ({ params }) => onUpdate(mine, params.sessionId, rec(params.update)))
      .onRequest("session/request_permission", ({ params, signal }) => askPermission(rec(params), signal) as never)
      .onRequest("elicitation/create", ({ params, signal }) => askQuestion(rec(params), signal) as never)
    const conn = app.connect(transport.stream)
    // Its output closes as it exits: the exit, with its code, is the better reason, if it comes.
    const ended = Promise.race([transport.exited, conn.closed.then(() => Promise.race([transport.exited, new Promise<string>((r) => setTimeout(() => r("it closed its output"), 500).unref())]))])
    const why = (reason: string) => {
      const last = stderrTail.filter((l) => !/^npm (notice|warn)/i.test(l)).at(-1)
      return `${name} stopped: ${reason}${last ? ` (${clip(last, 200)})` : ""}`
    }
    let init: Raw
    try {
      init = rec(
        await Promise.race([
          conn.agent.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
              // The agent reads and writes files itself, and runs its own commands: a terminal
              // offered here would not be the one its shell tool uses (see `running`).
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              elicitation: { form: {} },
            },
            clientInfo: { name: "bicycle42", title: "bicycle 42", version: VERSION },
          }),
          ended.then((r) => Promise.reject(new Error(why(r)))),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} did not answer in ${timing.start / 1000} s`)), timing.start).unref()),
        ]),
      )
    } catch (err) {
      transport.kill()
      conn.close()
      throw new Error(`Can't start ${name}: ${err instanceof Error ? err.message.replace(`${name} stopped: `, "") : said(err)}`)
    }
    if (closed) {
      transport.kill()
      conn.close()
      throw new Error(`${name} is not in use any more.`)
    }
    const before = JSON.stringify(can())
    caps = rec(init.agentCapabilities)
    promptCaps = rec(caps.promptCapabilities)
    steering = rec(rec(init._meta).steering).supported === true
    const p: Proc = { gen: mine, agent: conn.agent, init, transport, started: Date.now(), ended }
    proc = p
    void ended.then((reason) => died(p, p.ending ?? why(reason)))
    if (JSON.stringify(can()) !== before) emit({ type: "agent" })
    return p
  }

  /** The process ended by itself (or the app ended it). Nothing in flight will finish: the
   *  message under way fails and what waits is cancelled, each with Retry on its note. */
  function died(p: Proc, why: string) {
    if (proc !== p) return
    proc = undefined
    p.why = why
    p.transport.kill()
    for (const [id, pending] of permissionsPending) if (pending.gen === p.gen) (permissionsPending.delete(id), emit({ type: "permission-done", session: pending.session, id }))
    for (const [id, pending] of questionsPending) if (pending.gen === p.gen) (questionsPending.delete(id), emit({ type: "question-done", session: pending.session, id }))
    for (const conv of convs.values()) {
      if (conv.attached !== p.gen && conv.running?.gen !== p.gen) continue
      if (conv.attached === p.gen) conv.attached = 0
      if (conv.running?.gen === p.gen) finish(conv, conv.running.id, { failed: why })
      if (conv.queue.length) {
        for (const q of conv.queue.splice(0)) {
          emit({ type: "inbox", session: conv.id, id: q.id, status: "cancelled" })
          drop(conv, q.id)
        }
        queuedNow(conv)
      }
      if (conv.busy) setBusy(conv, false)
    }
    if (closed) return
    log("warn", why)
    // Ended by the app (a turn that would not stop) or after a good while: not a crash at start.
    if (p.ending || Date.now() - p.started > timing.healthy) {
      crashes = 0
      retryDelay = timing.retryMin
    } else crashes++
    if (crashes >= timing.crashes) {
      const error = `${why}. It stopped ${crashes} times in a row just after it started, so it is not started again by itself.`
      log("warn", error)
      return emit({ type: "connection", state: { status: "offline", url: url(), error } })
    }
    emit({ type: "connection", state: { status: "offline", url: url(), error: why } })
    if (listener) restartLater()
  }

  let closed = false
  /** The pause before the next start: doubled by each start that fails or dies young. */
  let retryDelay = timing.retryMin
  /** Deaths in a row of a process that had only just started. */
  let crashes = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  function restartLater() {
    clearTimeout(retryTimer)
    const wait = retryDelay
    retryDelay = Math.min(retryDelay * 2, timing.retryMax)
    retryTimer = setTimeout(async () => {
      if (!listener || closed) return
      try {
        await ensure()
        emit({ type: "connection", state: { status: "online", url: url(), version: version() } })
        // What was on screen was read from the process that ended.
        emit({ type: "resync" })
      } catch (err) {
        emit({ type: "connection", state: { status: "offline", url: url(), error: err instanceof Error ? err.message : said(err) } })
        restartLater()
      }
    }, wait)
  }

  const url = () => `acp://${opts.id}`
  const version = () => str(rec(proc?.init.agentInfo).version) ?? "?"
  const sessionCaps = () => rec(caps.sessionCapabilities)
  const has = (cap: string) => sessionCaps()[cap] !== undefined && sessionCaps()[cap] !== null

  /** A request to the agent, read through rec(): a wrong field is skipped, not believed. Rejects
   *  with the agent's own message. */
  async function call(method: string, params: unknown, ms: number | undefined = timing.request): Promise<Raw> {
    const p = await ensure()
    const req = (p.agent.request as (m: string, params: unknown) => Promise<unknown>)(method, params)
    try {
      return rec(ms ? await Promise.race([req, new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} did not answer in ${ms / 1000} s`)), ms).unref())]) : await req)
    } catch (err) {
      if (needsSignIn(err))
        throw Object.assign(new Error(`${name} needs you to sign in first: run it once in a terminal and log in. (${said(err)})`), { code: code(err) })
      throw Object.assign(new Error(said(err)), { code: code(err) })
    }
  }

  // ── conversations ───────────────────────────────────────────────────────────────────────────

  const convs = new Map<string, Conv>()
  const blank = (id: string): Conv => ({ id, items: [], attached: 0, busy: false, queue: [], parked: false, tools: new Map(), options: [], commands: [] })
  function conv(id: string): Conv {
    let c = convs.get(id)
    if (!c) convs.set(id, (c = blank(id)))
    return c
  }

  /** The options the agent offers this conversation, else the last ones seen anywhere. */
  const optionsOf = (c?: Conv): Raw[] => (c?.options.length ? c.options : list(ledger.options).map(rec))
  const optionOf = (c: Conv | undefined, category: string) => optionsOf(c).find((o) => o.category === category && o.type === "select")
  const choices = (o: Raw | undefined) => list(o?.options).flatMap((raw) => {
    // A select's options may come in groups.
    const r = rec(raw)
    return Array.isArray(r.options) ? list(r.options).map(rec) : [r]
  })

  /** ModelRef of an option's value: what is before a "/" (OpenCode's "provider/model") is the
   *  provider the window groups by; without one, the agent is. */
  function modelRef(value: string, variant?: string): ModelRef {
    const cut = value.indexOf("/")
    return defined({ providerID: cut > 0 ? value.slice(0, cut) : name, id: value, variant: variant && variant !== "default" ? variant : undefined })
  }

  function modeOf(c: Conv): string | undefined {
    return str(optionOf(c, "mode")?.currentValue) ?? str(rec(c.modes).currentModeId)
  }

  function summary(c: Conv): SessionSummary {
    const k = ledger.sessions[c.id]
    const model = str(optionOf(c, "model")?.currentValue)
    return defined({
      id: c.id,
      directory: k?.cwd ?? "",
      parent: k?.parent,
      title: k?.title ?? "",
      updated: k?.updated ?? 0,
      busy: c.busy,
      model: model && c.options.length ? modelRef(model, str(optionOf(c, "thought_level")?.currentValue)) : undefined,
      agent: c.options.length || c.modes ? modeOf(c) : undefined,
      archived: k?.archived,
    })
  }
  const told = (c: Conv) => emit({ type: "session", session: summary(c) })

  function setBusy(c: Conv, busy: boolean) {
    if (c.busy === busy) return
    c.busy = busy
    told(c)
  }

  // Items. Each change goes into the model and, live, out as the ChatEvent that says it.

  const copy = <T>(v: T): T => structuredClone(v)
  function upsert(c: Conv, item: ChatItem, live: boolean) {
    const at = c.items.findIndex((i) => i.id === item.id)
    c.items[at < 0 ? c.items.length : at] = item
    if (live) chat({ type: "item", session: c.id, item: copy(item) })
  }
  function drop(c: Conv, id: string) {
    const at = c.items.findIndex((i) => i.id === id)
    if (at < 0) return
    c.items.splice(at, 1)
    chat({ type: "remove", session: c.id, item: id })
  }

  /** The assistant item of the turn under way, made when the agent first says something. */
  function assistant(c: Conv, live: boolean): ChatAssistant {
    c.turn ??= { user: "", assistant: `a_${c.id}_${c.replay ? c.replay.count : c.items.length}`, time: Date.now(), ordinal: { text: 0, reasoning: 0 } }
    const found = c.items.find((i) => i.id === c.turn!.assistant)
    if (found?.kind === "assistant") return found
    const item: ChatAssistant = { kind: "assistant", id: c.turn.assistant, time: c.turn.time, parts: [], done: !live }
    upsert(c, item, live)
    return item
  }

  function text(c: Conv, kind: "text" | "reasoning", content: unknown, message: string | undefined, live: boolean) {
    const block = rec(content)
    const t = block.type === "text" ? (str(block.text) ?? "") : block.type === "resource_link" ? `[${str(block.name) ?? "link"}](${str(block.uri) ?? ""})` : ""
    if (!t) return
    const item = assistant(c, live)
    const turn = c.turn!
    const last = item.parts.at(-1)
    if (last && last.kind === kind && turn.open?.key === last.key && (message === undefined || turn.open.message === undefined || turn.open.message === message)) {
      // A new object: the one before was handed out.
      item.parts[item.parts.length - 1] = { kind, key: last.key, text: last.text + t }
      turn.open.message ??= message
      if (live) chat({ type: "delta", session: c.id, item: item.id, key: last.key, text: t })
      return
    }
    const part: ChatPart = { kind, key: `${kind}:${turn.ordinal[kind]++}`, text: t }
    item.parts.push(part)
    turn.open = { key: part.key, message }
    if (live) chat({ type: "part", session: c.id, item: item.id, part: { ...part } })
  }

  function putPart(c: Conv, itemId: string, part: ChatPart, live: boolean) {
    const item = c.items.find((i) => i.id === itemId)
    if (item?.kind !== "assistant") return
    const at = item.parts.findIndex((p) => p.key === part.key)
    item.parts[at < 0 ? item.parts.length : at] = part
    if (live) chat({ type: "part", session: c.id, item: itemId, part: { ...part } })
  }

  function tool(c: Conv, update: Raw, live: boolean) {
    const id = str(update.toolCallId)
    if (!id) return
    let known = c.tools.get(id)
    if (!known) {
      const item = assistant(c, live)
      c.turn!.open = undefined
      c.tools.set(id, (known = { item: item.id, raw: {} }))
    }
    // An update replaces the fields it has; the rest stay as they were.
    for (const [k, v] of Object.entries(update)) if (v !== undefined && v !== null && k !== "sessionUpdate") known.raw[k] = v
    putPart(c, known.item, toolPart(id, known.raw, ledger.sessions[c.id]?.cwd), live)
  }

  function plan(c: Conv, update: Raw, live: boolean) {
    const entries = list(update.entries).map(rec)
    const item = assistant(c, live)
    c.turn!.open = undefined
    const mark: Record<string, string> = { completed: "[x]", in_progress: "[~]" }
    putPart(
      c,
      item.id,
      defined({
        kind: "tool",
        key: "plan",
        name: "todo",
        status: entries.every((e) => e.status === "completed") ? "done" : "running",
        title: `plan: ${entries.length} step${entries.length === 1 ? "" : "s"}`,
        detail: entries.map((e) => `${mark[str(e.status) ?? ""] ?? "[ ]"} ${str(e.content) ?? ""}`).join("\n") || undefined,
      }) as ChatPart,
      live,
    )
  }

  /** A replayed user message is read to its end (the agent says something else, or the replay
   *  ends) before it becomes an item: its id is found by its whole text. */
  function endGroup(c: Conv) {
    const r = c.replay
    const g = r?.group
    if (!r || !g) return
    r.group = undefined
    const k = ledger.sessions[c.id]
    const key = textKey(g.text)
    let sent: Sent | undefined
    const sents = k?.sent ?? []
    for (let i = r.cursor; i < sents.length; i++)
      if (sents[i]!.key === key) {
        sent = sents[i]
        r.cursor = i + 1
        break
      }
    // Claude Code writes this into the conversation as the user's when a turn is stopped; the
    // chat has its own "Stopped" line for that, from the ledger.
    if (!sent && /^\[Request interrupted by user[^\]\n]*\]$/.test(g.text.trim())) return
    endTurn(c)
    const before = c.items.at(-1)?.time ?? 0
    // A message the app did not send (typed into the agent elsewhere) gets an id of its own place.
    const id = sent?.id ?? `u_${c.id}_${g.message ?? r.count}`
    const time = sent?.time ?? before
    r.count++
    upsert(c, user(c.id, id, time, g.text, g.images, false), false)
    c.turn = defined({ user: id, assistant: `a_${id}`, time, ordinal: { text: 0, reasoning: 0 }, sent })
  }

  /** A replayed turn has been read to its end: what the agent does not keep goes in as it was
   *  live, when it ended and the line its run ended with. */
  function endTurn(c: Conv) {
    const t = c.turn
    if (!t?.sent) return
    const item = c.items.find((i) => i.id === t.assistant)
    if (item?.kind === "assistant" && t.sent.ended) item.ended = t.sent.ended
    endLine(c, t.user, t.sent, false)
    t.sent = undefined
  }

  function user(session: string, id: string, time: number, t: string, images: { mime: string; data: string }[], pending: boolean): ChatUser {
    const named = opts.pictures && ((file: number, mime: string, data?: string) => opts.pictures!({ session, message: id, file }, mime, data))
    return userItem(id, time, { text: t, files: images.map((im, i) => ({ mime: im.mime, data: im.data, name: `image-${i + 1}` })) }, pending, named)
  }

  /** One session/update, live or replayed. */
  function apply(c: Conv, u: Raw, live: boolean) {
    const kind = str(u.sessionUpdate)
    if (kind !== "user_message_chunk") endGroup(c)
    switch (kind) {
      case "user_message_chunk": {
        // Live, the app made the item when it sent the message; only a replay reads them.
        const r = c.replay
        if (!r) return
        const content = rec(u.content)
        const message = str(u.messageId)
        if (r.group && message && r.group.message && message !== r.group.message) endGroup(c)
        r.group ??= { message, text: "", images: [] }
        if (content.type === "text") r.group.text += str(content.text) ?? ""
        else if (content.type === "image" && str(content.data) && str(content.mimeType)) r.group.images.push({ mime: str(content.mimeType)!, data: str(content.data)! })
        return
      }
      case "agent_message_chunk":
        return text(c, "text", u.content, str(u.messageId), live)
      case "agent_thought_chunk":
        return text(c, "reasoning", u.content, str(u.messageId), live)
      case "tool_call":
      case "tool_call_update":
        return tool(c, u, live)
      case "plan":
        return plan(c, u, live)
      case "available_commands_update": {
        const before = JSON.stringify(c.commands)
        c.commands = list(u.availableCommands).flatMap((raw) => {
          const cmd = rec(raw)
          const n = str(cmd.name)?.replace(/^\//, "")
          return n ? [defined({ name: n, description: str(cmd.description) && clip(str(cmd.description)!, 160) })] : []
        })
        if (JSON.stringify(c.commands) !== before) emit({ type: "agent" })
        return
      }
      case "current_mode_update": {
        const mode = str(u.currentModeId)
        if (!mode) return
        if (c.modes) c.modes = { ...c.modes, currentModeId: mode }
        const opt = optionOf(c, "mode")
        if (opt) opt.currentValue = mode
        return told(c)
      }
      case "config_option_update":
        c.options = list(u.configOptions).map(rec)
        ledger.options = c.options
        save()
        told(c)
        return emit({ type: "agent" })
      case "session_info_update": {
        const k = ledger.sessions[c.id]
        if (!k) return
        const title = str(u.title)
        if (title && !k.named) k.title = title
        const at = Date.parse(str(u.updatedAt) ?? "")
        if (Number.isFinite(at)) k.updated = Math.max(k.updated, at)
        save()
        return told(c)
      }
      case "usage_update": {
        const used = num(u.used)
        if (!used) return
        c.context = defined({ used, limit: num(u.size) || undefined })
        if (live) emit({ type: "context", session: c.id, context: c.context })
        return
      }
      case "notice": {
        const title = str(u.title)
        if (!title || !live) return
        const description = str(u.description)
        return upsert(c, { kind: "marker", id: `n_${c.id}_${Date.now()}`, time: Date.now(), text: clip(description ? `${title}: ${description}` : title, 300), tone: u.severity === "error" ? "error" : "info" }, live)
      }
      default:
        // Plans by id, subagents, compaction, suggestions: not shown (the app does not ask for them).
        return warn(`Skipped an update of kind "${String(kind)}"`)
    }
  }

  function onUpdate(fromGen: number, session: string, u: Raw) {
    // From a process that has ended since: what it said is gone with it.
    if (fromGen !== gen) return
    const c = convs.get(session)
    // A conversation not opened here (another client's, or a subagent's): nothing shows it.
    if (!c) return
    apply(c, u, !c.replay)
  }

  /** Makes sure the conversation is loaded in the agent's process, its history read into the
   *  model. A conversation the app made in this process is loaded already. */
  async function attach(c: Conv): Promise<Proc> {
    const p = await ensure()
    if (c.attached === p.gen) return p
    if (c.loading) {
      await c.loading
      return attach(c)
    }
    const k = ledger.sessions[c.id]
    if (!k) throw gone(c.id)
    c.loading = (async () => {
      if (caps.loadSession === true) {
        c.replay = { cursor: 0, count: 0 }
        c.items = []
        c.turn = undefined
        c.tools.clear()
        try {
          const res = await call("session/load", { sessionId: c.id, cwd: k.cwd, mcpServers: [] }, timing.start)
          configured(c, res)
        } catch (err) {
          if (code(err) === -32002 || /not found/i.test(said(err))) throw gone(c.id)
          throw err
        } finally {
          endGroup(c)
          endTurn(c)
          c.replay = undefined
          c.turn = undefined
        }
        for (const item of c.items) if (item.kind === "assistant") item.done = true
      } else if (has("resume")) {
        const res = await call("session/resume", { sessionId: c.id, cwd: k.cwd, mcpServers: [] }, timing.start)
        configured(c, res)
        c.items = [{ kind: "marker", id: `resumed_${c.id}`, time: Date.now(), tone: "info", text: `${name} does not show what was said before it was started again.` }]
      } else throw gone(c.id)
      // The process ended while the conversation was read: it is loaded in none.
      if (proc !== p) throw new Error(p.why ?? `${name} stopped while the conversation was read.`)
      // What waits in the queue is still part of the conversation, at its end.
      for (const q of c.queue) upsert(c, user(c.id, q.id, q.time, q.text, pictures(q.files), true), false)
      c.attached = p.gen
    })()
    try {
      await c.loading
    } finally {
      c.loading = undefined
    }
    return p
  }

  function gone(id: string): Error {
    delete ledger.sessions[id]
    save()
    convs.delete(id)
    emit({ type: "session-gone", session: id })
    return new Error("The conversation no longer exists.")
  }

  /** What models, efforts and modes there are to choose from (not which is chosen): when it
   *  changes, the controller reads them again. */
  const offer = () => JSON.stringify(["model", "thought_level", "mode"].map((k) => choices(optionOf(undefined, k)).map((o) => o.value)).concat([list(rec(ledger.modes).availableModes).map((m) => rec(m).id)]))

  /** What session/new, load, resume and fork answer with: the options and modes. */
  function configured(c: Conv, res: Raw) {
    const before = offer()
    const options = list(res.configOptions).map(rec)
    // Agents from before config options say their models apart.
    const models = rec(res.models)
    if (!options.some((o) => o.category === "model") && Array.isArray(models.availableModels))
      options.push({ id: "model", category: "model", type: "select", currentValue: str(models.currentModelId), options: list(models.availableModels).map((m) => ({ value: str(rec(m).modelId), name: str(rec(m).name) })), legacy: true })
    if (options.length) ((c.options = options), (ledger.options = options))
    if (res.modes) c.modes = rec(res.modes)
    if (c.modes) ledger.modes = c.modes
    save()
    // The first conversation of an agent that says its models only per conversation.
    if (offer() !== before) emit({ type: "agent" })
  }

  function pictures(files: PromptFile[]) {
    return files.flatMap((f) => dataUri(f.uri) ?? [])
  }

  // ── the queue ───────────────────────────────────────────────────────────────────────────────

  /** The blocks of a prompt: its words, its pictures (when the agent takes pictures), and each
   *  `@`-named file or folder as a link. */
  function blocks(q: Queued): unknown[] {
    const out: unknown[] = [{ type: "text", text: q.text }]
    if (promptCaps.image === true) for (const im of pictures(q.files)) out.push({ type: "image", mimeType: im.mime, data: im.data })
    for (const m of q.mentions) {
      if (m.kind !== "file" && m.kind !== "folder") continue
      if (!m.id.startsWith("/")) throw new Error(`Can't attach "${m.id}": its full path is unknown.`)
      const p = m.id.replace(/(.)\/+$/, "$1")
      out.push({ type: "resource_link", uri: fileUri(p), name: path.posix.basename(p) || p })
    }
    return out
  }

  /** Sends the next waiting message when the conversation is free. */
  async function pump(c: Conv) {
    if (c.running || c.parked || !c.queue.length || pumping.has(c.id)) return
    pumping.add(c.id)
    let p: Proc
    const loaded = !!proc && c.attached === proc.gen
    try {
      p = await attach(c)
      // Its history was read just now: what the screen shows of it was not.
      if (!loaded) emit({ type: "resync", session: c.id })
    } catch (err) {
      pumping.delete(c.id)
      const why = err instanceof Error ? err.message : said(err)
      // It could not be loaded: what waits fails, as a message the agent never got.
      for (const q of c.queue.splice(0)) {
        emit({ type: "inbox", session: c.id, id: q.id, status: "cancelled" })
        drop(c, q.id)
      }
      queuedNow(c)
      if (convs.has(c.id)) upsert(c, { kind: "marker", id: `e_${c.id}_${Date.now()}`, time: Date.now(), tone: "error", text: `Failed: ${why}`, failed: true }, true)
      // The run the controller counted on (a typed message makes the conversation busy) ends.
      emit({ type: "run", session: c.id, status: "failed", error: why })
      return
    }
    pumping.delete(c.id)
    // The process ended after the conversation was loaded in it: loaded again in the next one.
    if (proc !== p || c.attached !== p.gen) return void pump(c)
    if (c.running) return
    const q = c.queue.shift()
    if (!q) return
    queuedNow(c)
    take(c, p, q)
  }
  const pumping = new Set<string>()

  function take(c: Conv, p: Proc, q: Queued): void {
    const k = kept(c.id)!
    const now = Date.now()
    c.running = { id: q.id, gen: p.gen }
    k.sent.push({ id: q.id, key: textKey(q.text), time: now })
    if (k.sent.length > SENT_KEPT) k.sent.splice(0, k.sent.length - SENT_KEPT)
    k.updated = now
    save()
    if (!c.busy) {
      emit({ type: "run", session: c.id, status: "started" })
      setBusy(c, true)
    }
    emit({ type: "inbox", session: c.id, id: q.id, status: "working" })
    // It moves to the end, where the agent's answer follows it.
    const at = c.items.findIndex((i) => i.id === q.id)
    const was = at >= 0 ? c.items.splice(at, 1)[0] : undefined
    const item: ChatUser = { ...(was?.kind === "user" ? was : user(c.id, q.id, now, q.text, pictures(q.files), false)), time: now }
    delete item.pending
    c.items.push(item)
    chat({ type: "delivered", session: c.id, item: q.id, time: now })
    c.turn = { user: q.id, assistant: `a_${q.id}`, time: now, ordinal: { text: 0, reasoning: 0 } }
    let prompt: unknown[]
    try {
      prompt = blocks(q)
    } catch (err) {
      return finish(c, q.id, { failed: said(err) })
    }
    const go = (untrusted = false) => {
      if (c.running?.id !== q.id) return
      // Stopped, or the process ended, while the snapshot was taken: the message never went.
      if (c.running.cancelled) return finish(c, q.id, { interrupted: true })
      if (proc !== p) return finish(c, q.id, { failed: p.why ?? `${name} stopped` })
      if (untrusted) opts.turnUntrusted?.(c.id)
      send()
    }
    const ready = opts.beforeTurn?.(c.id)
    if (!ready) return go()
    // It is sent anyway when the snapshot is late or fails (the reviewer is not held up), and the
    // controller is told the turn's "before" may have the agent's first changes in it.
    const late = new Promise<boolean>((r) => setTimeout(() => r(true), timing.beforeTurn).unref())
    void Promise.race([Promise.resolve(ready).then(() => false), late])
      .catch((err) => {
        warn("The folder could not be snapshot before a message", said(err))
        return true
      })
      .then((untrusted) => go(untrusted))

    function send() {
      call("session/prompt", { sessionId: c.id, prompt }, 0).then(
        (res) => {
          const reason = str(res.stopReason)
          if (reason === "cancelled") finish(c, q.id, { interrupted: true })
          else if (reason && STOPPED_BY[reason]) finish(c, q.id, { failed: STOPPED_BY[reason]! })
          else finish(c, q.id, {})
        },
        (err) => {
          if (c.running?.cancelled) return finish(c, q.id, { interrupted: true })
          // The connection closing rejects the prompt before the process is seen to have ended:
          // then the reason is the process's (`died`), not "connection closed".
          void Promise.race([p.ended, new Promise((r) => setTimeout(r, 1000).unref())]).then(() => proc === p && finish(c, q.id, { failed: said(err) }))
        },
      )
    }
  }

  /** A turn ended: the next waiting message goes, or the run ends. `id` is the message it was
   *  asked with; what it says goes with the turn's last message (one steered into it, if any),
   *  where a replay puts it. */
  function finish(c: Conv, id: string, how: { failed?: string; interrupted?: true }): void {
    if (c.running?.id !== id) return
    c.running = undefined
    const now = Date.now()
    const item = c.turn && c.items.find((i) => i.id === c.turn!.assistant)
    if (item?.kind === "assistant") upsert(c, { ...item, done: true, ended: now }, true)
    const last = c.turn?.user || id
    c.turn = undefined
    const sent = ledger.sessions[c.id]?.sent.find((s) => s.id === last)
    if (sent) sent.ended = now
    if (how.failed || how.interrupted) {
      if (sent) Object.assign(sent, defined({ end: how.failed ? ("failed" as const) : ("interrupted" as const), error: how.failed }))
      save()
      // What waits stays waiting, until something is sent again (as on an OpenCode server).
      c.parked = true
      setBusy(c, false)
      emit(defined({ type: "run", session: c.id, status: how.failed ? "failed" : "interrupted", error: how.failed }) as BackendEvent)
      if (sent) endLine(c, last, sent, true)
      return
    }
    save()
    if (c.queue.length && !c.parked && c.attached) {
      const p = proc
      const q = c.queue.shift()!
      if (p && c.attached === p.gen) return (queuedNow(c), take(c, p, q))
      c.queue.unshift(q)
    }
    setBusy(c, false)
    emit({ type: "run", session: c.id, status: "succeeded" })
    void pump(c)
  }

  function endLine(c: Conv, id: string, sent: Sent, live: boolean) {
    const marker = endMarker(`end_${id}`, sent.ended ?? sent.time, sent.end, { message: sent.error })
    if (marker) upsert(c, marker, live)
  }

  // ── permissions and questions ───────────────────────────────────────────────────────────────

  let asked = 0
  const permissionsPending = new Map<string, Pending<unknown> & { gen: number; ask: PermissionAsk; options: Raw[] }>()
  const questionsPending = new Map<string, Pending<unknown> & { gen: number; question: Question }>()

  function askPermission(params: Raw, signal: AbortSignal): Promise<unknown> {
    const session = str(params.sessionId) ?? ""
    const call = rec(params.toolCall)
    const cwd = ledger.sessions[session]?.cwd
    const known = convs.get(session)?.tools.get(str(call.toolCallId) ?? "")?.raw ?? {}
    const whole = { ...known, ...Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined && v !== null)) }
    const input = rec(whole.rawInput)
    const kind = str(whole.kind)
    const resources = [
      ...list(whole.locations).flatMap((l) => str(rec(l).path) ?? []),
      ...(kind === "execute" ? [commandOf(input) ?? ""].filter(Boolean) : []),
      ...(kind === "fetch" ? [str(input.url) ?? ""].filter(Boolean) : []),
    ]
    const id = `perm_${++asked}`
    const ask: PermissionAsk = defined({
      id,
      session,
      action: TOOL_NAME[kind ?? ""] ?? str(whole.name) ?? kind ?? "tool",
      resources: [...new Set(resources)],
      changes: diffs(whole.content, cwd),
      message: str(whole.title),
    })
    return new Promise((resolve) => {
      const done = (value: unknown) => {
        if (!permissionsPending.delete(id)) return
        emit({ type: "permission-done", session, id })
        resolve(value)
      }
      permissionsPending.set(id, { session, resolve: done, gen: gen, ask, options: list(params.options).map(rec) })
      signal.addEventListener("abort", () => done({ outcome: { outcome: "cancelled" } }))
      emit({ type: "permission", ask })
    })
  }

  function askQuestion(params: Raw, signal: AbortSignal): Promise<unknown> {
    // A question about no conversation is about the one at work, when there is one.
    const busy = [...convs.values()].filter((c) => c.running)
    const session = str(params.sessionId) ?? (busy.length === 1 ? busy[0]!.id : undefined)
    if (params.mode !== "form" || !session) return Promise.resolve({ action: "decline" })
    const schema = rec(params.requestedSchema)
    const required = new Set(list(schema.required).filter((r): r is string => typeof r === "string"))
    const fields: QuestionField[] = []
    for (const [key, raw] of Object.entries(rec(schema.properties))) {
      const p = rec(raw)
      const base = { key, title: str(p.title) ?? key, description: str(p.description), required: required.has(key) || undefined }
      const options = [...list(p.enum).flatMap((v) => (typeof v === "string" ? [{ value: v, label: v }] : [])), ...list(p.oneOf).flatMap((o) => (str(rec(o).const) ? [{ value: str(rec(o).const)!, label: str(rec(o).title) ?? str(rec(o).const)! }] : []))]
      const items = rec(p.items)
      const many = [...list(items.enum).flatMap((v) => (typeof v === "string" ? [{ value: v, label: v }] : [])), ...list(items.anyOf).flatMap((o) => (str(rec(o).const) ? [{ value: str(rec(o).const)!, label: str(rec(o).title) ?? str(rec(o).const)! }] : []))]
      if (p.type === "boolean") fields.push(defined({ ...base, type: "boolean" as const }))
      else if (p.type === "number" || p.type === "integer") fields.push(defined({ ...base, type: "number" as const }))
      else if (p.type === "array") fields.push(defined({ ...base, type: "multiselect" as const, options: many.length ? many : undefined }))
      else if (p.type === "string") fields.push(defined({ ...base, type: options.length ? ("multiselect" as const) : ("string" as const), options: options.length ? options : undefined, custom: options.length ? false : undefined }))
    }
    const id = `q_${++asked}`
    const question: Question = { id, session, title: str(params.message) ?? "", fields }
    // A single choice is a multiselect of one here, and goes back as one value.
    const single = new Set(fields.filter((f) => f.type === "multiselect" && rec(rec(schema.properties)[f.key]).type === "string").map((f) => f.key))
    return new Promise((resolve) => {
      const done = (value: unknown) => {
        if (!questionsPending.delete(id)) return
        emit({ type: "question-done", session, id })
        resolve(value)
      }
      questionsPending.set(id, { session, gen, question, resolve: (answer) => done(answer === undefined ? { action: "decline" } : { action: "accept", content: Object.fromEntries(Object.entries(answer as Answer).map(([k, v]) => [k, single.has(k) && Array.isArray(v) ? (v[0] ?? "") : v])) }) })
      signal.addEventListener("abort", () => done({ action: "cancel" }))
      emit({ type: "question", question })
    })
  }

  // ── the backend ─────────────────────────────────────────────────────────────────────────────

  const hasCompact = () => [...convs.values()].some((c) => c.commands.some((x) => x.name === "compact"))
  function can(): BackendCan {
    return defined({
      queue: true,
      // The agent's own extension: a message joins the turn under way.
      steer: steering || undefined,
      fork: has("fork") || undefined,
      archive: has("archive") || undefined,
      // ACP has no request for it; an agent that offers /compact is asked that way.
      compact: hasCompact() || undefined,
    })
  }

  const cannot = (what: string) => new Error(`${name} can't ${what} (ACP has no way to ask for it).`)

  async function newSession(directory: string, extra: Raw = {}): Promise<{ c: Conv; res: Raw }> {
    const p = await ensure()
    const res = await call("session/new", { cwd: directory, mcpServers: [], ...extra })
    const id = str(res.sessionId)
    if (!id) throw new Error(`${name} did not say which conversation it made.`)
    const c = conv(id)
    c.attached = p.gen
    c.items = []
    kept(id, directory)
    configured(c, res)
    return { c, res }
  }

  async function setOption(c: Conv, option: Raw | undefined, value: string) {
    if (!option || str(option.currentValue) === value) return
    if (!choices(option).some((o) => str(o.value) === value)) throw new Error(`${name} does not offer "${value}" here.`)
    await attach(c)
    if (option.legacy) await call("session/set_model", { sessionId: c.id, modelId: value })
    else {
      const res = await call("session/set_config_option", { sessionId: c.id, configId: str(option.id), value })
      if (Array.isArray(res.configOptions)) c.options = list(res.configOptions).map(rec)
    }
    const now = c.options.find((o) => o.id === option.id)
    if (now) now.currentValue = value
    ledger.options = c.options
    save()
    told(c)
  }

  async function sessionsOf(directory: string | undefined, archived: boolean): Promise<void> {
    if (!has("list")) return
    let cursor: string | undefined
    for (let page = 0; page < 4; page++) {
      const res = await call("session/list", defined({ cwd: directory, cursor, archived: has("archive") ? (archived ? "only" : "exclude") : undefined }))
      for (const raw of list(res.sessions)) {
        const s = rec(raw)
        const id = str(s.sessionId)
        const cwd = str(s.cwd)
        if (!id || !cwd) continue
        const k = kept(id, cwd)!
        const title = str(s.title)
        if (title && !k.named && (!k.title || !convs.get(id))) k.title = title
        const at = Date.parse(str(s.updatedAt) ?? "")
        if (Number.isFinite(at)) k.updated = Math.max(k.updated, at)
        if (s.archived === true) k.archived = true
        else if (s.archived === false || (has("archive") && !archived)) delete k.archived
      }
      cursor = str(res.nextCursor)
      if (!cursor) break
    }
    save()
  }

  const backend: Acp = {
    get can() {
      return can()
    },

    async info() {
      const p = await ensure()
      return { version: str(rec(p.init.agentInfo).version) ?? "?", computer: name }
    },

    async projects() {
      await sessionsOf(undefined, false).catch((err) => warn("Could not list the agent's conversations", said(err)))
      const folders = Object.values(ledger.sessions)
        .sort((a, b) => b.updated - a.updated)
        .map((k) => k.cwd)
      return [...new Set(folders)].filter((f) => f && f !== "/")
    },

    listFolders: (dir) => listFolders(machine, dir),

    async models() {
      // What the agent can be asked is known once it has started.
      if (!optionsOf().length) await ensure()
      if (!optionsOf().length && has("options")) {
        const res = await call("session/options", { cwd: machine.home }).catch(() => ({}) as Raw)
        // A conversation of none: what it is told goes into the ledger alone.
        configured(blank(""), res)
      }
      const model = optionOf(undefined, "model")
      const effort = optionOf(undefined, "thought_level")
      const variants = choices(effort).flatMap((o) => (str(o.value) && o.value !== "default" ? [str(o.value)!] : []))
      const all = choices(model)
      /** An option's name without the provider before it ("fake/Alpha" under "fake"). */
      const shown = (o: Raw) => {
        const value = str(o.value) ?? ""
        const label = str(o.name) ?? value
        const provider = modelRef(value).providerID
        return label.startsWith(`${provider}/`) ? label.slice(provider.length + 1) : label
      }
      const names = new Map(all.flatMap((o) => (str(o.name) ? [[str(o.name)!, shown(o)] as const] : [])))
      return all.flatMap((o): ModelInfo[] => {
        const value = str(o.value)
        if (!value) return []
        let label = shown(o)
        // The agent's default says which model it is in its description (Claude Code's adapter:
        // "Default (recommended)", "Opus 5.5"): the reviewer sees the model that works.
        const is = names.get(str(o.description)?.trim() ?? "")
        if (is && (value === "default" || /^default\b/i.test(label))) label = `Default · ${is}`
        return [{ providerID: modelRef(value).providerID, id: value, name: label, images: promptCaps.image === true, variants }]
      })
    },

    async agents() {
      const mode = optionOf(undefined, "mode")
      const modes = mode ? choices(mode) : list(rec(ledger.modes).availableModes).map((m) => ({ value: str(rec(m).id), name: str(rec(m).name) }))
      return modes.flatMap((m): AgentInfo[] => (str(m.value) ? [{ id: str(m.value)!, name: str(m.name) ?? str(m.value)! }] : []))
    },

    async mentionAgents() {
      return []
    },

    async sessions(directory, archived = false) {
      await sessionsOf(directory, archived)
      return Object.entries(ledger.sessions)
        .filter(([, k]) => k.cwd === directory && !k.parent && !!k.archived === archived)
        .sort((a, b) => b[1].updated - a[1].updated)
        .map(([id]) => summary(conv(id)))
    },

    async session(id) {
      if (!ledger.sessions[id]) return null
      return summary(conv(id))
    },

    async createSession(input) {
      const { c } = await newSession(input.directory)
      const k = kept(c.id)!
      if (input.parent) k.parent = input.parent
      if (input.title) k.title = input.title
      if (input.title && has("title")) await call("session/set_title", { sessionId: c.id, title: input.title }).catch((err) => warn("Could not name the conversation", said(err)))
      if (input.model) await backend.setModel(c.id, input.model).catch((err) => warn("Could not set the conversation's model", said(err)))
      save()
      return summary(c)
    },

    async setModel(id, model) {
      const c = conv(id)
      await attach(c)
      await setOption(c, optionOf(c, "model"), model.id)
      const effort = optionOf(c, "thought_level")
      const variant = model.variant ?? (choices(effort).some((o) => o.value === "default") ? "default" : undefined)
      if (effort && variant) await setOption(c, effort, variant)
    },

    async setAgent(id, agent) {
      const c = conv(id)
      await attach(c)
      const mode = optionOf(c, "mode")
      if (mode) return setOption(c, mode, agent)
      await call("session/set_mode", { sessionId: id, modeId: agent })
      if (c.modes) c.modes = { ...c.modes, currentModeId: agent }
      told(c)
    },

    messageId: () => `u_${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`,

    async prompt(id, input) {
      const c = conv(id)
      const k = kept(id)
      if (!k) throw gone(id)
      const mid = input.id ?? backend.messageId()
      // Sent before (a retry after a lost reply): it is not queued twice.
      if (c.running?.id === mid || c.queue.some((q) => q.id === mid)) return { id: mid }
      const q: Queued = { id: mid, text: input.text, files: input.files ?? [], mentions: input.mentions ?? [], time: Date.now() }
      blocks(q) // a mention without a full path fails here, before anything is queued
      const before = k.sent.find((s) => s.id === mid)
      if (before && before.ended && !before.end) {
        // It was answered, and the reply saying so was lost: its run is said again, as it went.
        if (!c.busy) {
          emit({ type: "run", session: id, status: "started" })
          emit({ type: "inbox", session: id, id: mid, status: "working" })
          emit({ type: "run", session: id, status: "succeeded" })
        }
        return { id: mid }
      }
      if (before) {
        // It never finished (stopped, failed, or lost when the agent ended): it goes again, and
        // the earlier try keeps its line in a re-read under an id of its own.
        before.id = `${mid}~${k.sent.filter((s) => s.id.startsWith(`${mid}~`)).length + 1}`
        if (k.lost?.includes(mid)) k.lost = k.lost.filter((x) => x !== mid)
        save()
      }
      if (input.delivery === "steer" && steering && c.running && c.attached && (await steer(c, q))) return { id: mid }
      c.queue.push(q)
      queuedNow(c)
      // Something sent wakes what waited after a stop or a failure; it goes first.
      c.parked = false
      emit({ type: "inbox", session: id, id: mid, status: "queued" })
      upsert(c, user(id, mid, q.time, q.text, pictures(q.files), true), true)
      void pump(c)
      return { id: mid }
    },

    async commands(directory) {
      const here = [...convs.values()].filter((c) => ledger.sessions[c.id]?.cwd === directory && c.commands.length)
      const from = here[0] ?? [...convs.values()].find((c) => c.commands.length)
      return from ? [...from.commands] : []
    },

    async command(id, input) {
      // ACP's slash commands are prompts that start with their name.
      await backend.prompt(id, { text: `/${input.name}${input.text ? ` ${input.text}` : ""}`, files: input.files, mentions: input.mentions, delivery: input.delivery })
    },

    async skills() {
      return []
    },

    findFiles: (directory, query) => findFiles(machine, directory, query),

    async compact(id) {
      if (!hasCompact()) throw cannot("summarise the conversation")
      await backend.command(id, { name: "compact", text: "" })
    },

    async lastTurn() {
      throw cannot("take back a message")
    },
    async undo() {
      throw cannot("take back a message")
    },
    async redo() {
      throw cannot("bring back what was taken back")
    },
    async diff() {
      throw cannot("show what one message changed")
    },

    async rename(id, title) {
      const k = kept(id)
      if (!k) throw gone(id)
      if (has("title")) await call("session/set_title", { sessionId: id, title })
      k.title = title
      k.named = true
      save()
      told(conv(id))
    },

    vcs: (directory) => vcs(machine, directory),

    async archive(id, archived) {
      if (!has("archive")) throw cannot("put a conversation away")
      await call(archived ? "session/archive" : "session/unarchive", { sessionId: id })
      const k = kept(id)
      if (k) archived ? (k.archived = true) : delete k.archived
      save()
    },

    async remove(id) {
      if (!has("delete")) throw cannot("delete a conversation")
      await call("session/delete", { sessionId: id })
      delete ledger.sessions[id]
      convs.delete(id)
      save()
    },

    async fork(id) {
      if (!has("fork")) throw cannot("copy a conversation")
      const k = kept(id)
      if (!k) throw gone(id)
      const p = await ensure()
      const res = await call("session/fork", { sessionId: id, cwd: k.cwd, mcpServers: [] })
      const copied = str(res.sessionId)
      if (!copied) throw new Error(`${name} did not say which conversation it made.`)
      const c = conv(copied)
      kept(copied, k.cwd)!.title = k.title && `${k.title} (copy)`
      configured(c, res)
      // Its history is read from the agent when it is opened.
      c.attached = caps.loadSession === true ? 0 : p.gen
      save()
      return summary(c)
    },

    async cancelQueued(id, item) {
      const c = convs.get(id)
      const at = c?.queue.findIndex((q) => q.id === item) ?? -1
      if (!c || at < 0) return
      c.queue.splice(at, 1)
      queuedNow(c)
      emit({ type: "inbox", session: id, id: item, status: "cancelled" })
      drop(c, item)
    },

    async waiting(id) {
      return convs.get(id)?.queue.map((q) => q.id) ?? []
    },

    async stop(id) {
      const c = convs.get(id)
      if (!c?.running) return false
      // What waits stays waiting (the controller takes it out with cancelQueued, as it does on
      // an OpenCode server); nothing of it starts while the run winds down.
      c.parked = true
      c.running.cancelled = true
      // ACP asks the client to answer what the agent still waits on as cancelled.
      for (const pending of [...permissionsPending.values()]) if (pending.session === id) pending.resolve({ outcome: { outcome: "cancelled" } })
      for (const pending of [...questionsPending.values()]) if (pending.session === id) pending.resolve(undefined)
      const p = proc
      if (!p) return true
      const running = c.running
      // An agent that does not end its turn when asked: after a while the turn is ended here, and
      // so is the agent's process (nothing else stops what it is doing); it is started again.
      setTimeout(() => {
        if (c.running !== running || proc !== p) return
        const why = `${name} did not stop when asked, so it was ended and started again`
        finish(c, running.id, { interrupted: true })
        log("warn", why)
        p.ending = why
        p.transport.kill()
      }, timing.stopGrace).unref()
      await (p.agent.notify as (m: string, params: unknown) => Promise<void>)("session/cancel", { sessionId: id }).catch((err) => warn("Could not cancel", said(err)))
      return true
    },

    async running() {
      // ACP gives the client no list of what the agent's shell is running: a dev server it
      // started lives as long as the agent's process, and ends with it (the app ends the
      // process, and its process group, when it quits or uses another server).
      return []
    },
    async kill() {
      throw cannot("stop a command it left running")
    },

    async transcript(id) {
      const c = conv(id)
      await attach(c)
      return {
        items: copy(c.items),
        permissions: [...permissionsPending.values()].filter((p) => p.session === id).map((p) => p.ask),
        questions: [...questionsPending.values()].filter((q) => q.session === id).map((q) => q.question),
        ...(c.context ? { context: { ...c.context } } : {}),
      }
    },

    async picture() {
      // The pictures of a conversation came with it (see `user`), and are kept by the controller.
      return undefined
    },

    async replyPermission(_session, id, decision) {
      const pending = permissionsPending.get(id)
      if (!pending) throw new Error("That request is no longer waiting.")
      const by = (...kinds: string[]) => kinds.map((k) => pending.options.find((o) => o.kind === k)).find(Boolean)
      const option = decision === "always" ? by("allow_always", "allow_once") : decision === "once" ? by("allow_once", "allow_always") : by("reject_once", "reject_always")
      pending.resolve(option ? { outcome: { outcome: "selected", optionId: str(option.optionId) } } : { outcome: { outcome: "cancelled" } })
    },

    async answerQuestion(_session, id, answer) {
      const pending = questionsPending.get(id)
      if (!pending) throw new Error("That question is no longer waiting.")
      pending.resolve(answer)
    },

    async dismissQuestion(_session, id) {
      questionsPending.get(id)?.resolve(undefined)
    },

    lost(id) {
      const k = ledger.sessions[id]
      const ids = k?.lost ?? []
      if (k?.lost) {
        delete k.lost
        save()
      }
      return ids
    },

    listen(on) {
      listener = on
      closed = false
      emit({ type: "connection", state: { status: "connecting", url: url() } })
      void ensure().then(
        () => emit({ type: "connection", state: { status: "online", url: url(), version: version() } }),
        (err) => {
          emit({ type: "connection", state: { status: "offline", url: url(), error: err instanceof Error ? err.message : said(err) } })
          restartLater()
        },
      )
      return () => {
        if (listener !== on) return
        listener = undefined
        closed = true
        clearTimeout(retryTimer)
        // What was with the agent, or waiting for it, will not finish: said once, next time.
        for (const c of convs.values()) {
          const ids = [...(c.running ? [c.running.id] : []), ...c.queue.map((q) => q.id)]
          const k = ledger.sessions[c.id]
          if (ids.length && k) k.lost = [...new Set([...(k.lost ?? []), ...ids])]
        }
        const p = proc
        proc = undefined
        if (p) died(p, `${name} was stopped`)
        p?.transport.kill()
        save(true)
      }
    },
  }

  /** What `steer` does: the message joins the turn under way. False when the turn had ended
   *  meanwhile, or the agent would not: it is then queued as any other. */
  async function steer(c: Conv, q: Queued): Promise<boolean> {
    let res: Raw
    try {
      res = await call("_session/steering", { sessionId: c.id, prompt: blocks(q), _meta: { steering: { idleBehavior: "promptRequired" } } })
    } catch (err) {
      warn("The agent would not take a message into the turn under way; it waits instead", said(err))
      return false
    }
    if (res.outcome !== "injected") return false
    const k = kept(c.id)!
    const now = Date.now()
    k.sent.push({ id: q.id, key: textKey(q.text), time: now })
    save()
    // The rest of the turn is the answer to it: it goes below it. Where the agent puts it is its
    // own to say, and a re-read from a new process shows that (OpenCode puts it after the step
    // it was given during, so that step's last words move above it).
    c.items.push(user(c.id, q.id, now, q.text, pictures(q.files), false))
    chat({ type: "item", session: c.id, item: copy(c.items.at(-1)!) })
    const before = c.turn && c.items.find((i) => i.id === c.turn!.assistant)
    if (before?.kind === "assistant") upsert(c, { ...before, done: true, ended: now }, true)
    const was = c.turn && k.sent.find((x) => x.id === c.turn!.user)
    if (was) was.ended = now
    c.turn = { user: q.id, assistant: `a_${q.id}`, time: now, ordinal: { text: 0, reasoning: 0 } }
    return true
  }

  return backend
}

// ── tool calls ──────────────────────────────────────────────────────────────────────────────────

/** A command as an agent's shell tool has it in its input. */
function commandOf(input: Raw): string | undefined {
  const c = input.command ?? input.cmd
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.filter((x) => typeof x === "string").join(" ")
  return undefined
}

const relative = (p: string, dir: string | undefined) => (dir && p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p)

function diffs(content: unknown, dir: string | undefined): FileChange[] | undefined {
  const out = list(content).flatMap((raw) => {
    const d = rec(raw)
    const p = str(d.path)
    if (d.type !== "diff" || !p || typeof d.newText !== "string") return []
    return [unifiedPatch(relative(p, dir), str(d.oldText) ?? (d.oldText === null ? null : undefined), d.newText)]
  })
  return out.length ? out : undefined
}

/** A tool call as the chat shows it, from everything its updates said so far. */
export function toolPart(key: string, raw: Raw, dir: string | undefined): ChatPart {
  const kind = str(raw.kind) ?? ""
  const input = rec(raw.rawInput)
  const where = str(rec(list(raw.locations)[0]).path) ?? str(input.path) ?? str(input.file_path) ?? str(input.filePath)
  const status = TOOL_STATUS[str(raw.status) ?? ""] ?? "pending"
  let title: string | undefined
  if (kind === "edit" || kind === "delete" || kind === "move") title = where && `edit ${relative(where, dir)}`
  else if (kind === "execute") title = commandOf(input)?.trim().split("\n", 1)[0]?.trim()
  else if (kind === "read") title = where && `read ${relative(where, dir)}`
  title ||= (str(raw.title) ?? "").replaceAll(dir ? dir + "/" : "\u0000", "").trim().split("\n", 1)[0] || str(raw.name) || kind || "tool"
  const texts = list(raw.content).flatMap((c) => {
    const block = rec(rec(c).content)
    return rec(c).type === "content" && block.type === "text" ? (str(block.text) ?? []) : []
  })
  const output = rec(raw.rawOutput)
  let detail = texts.join("\n") || (typeof raw.rawOutput === "string" ? raw.rawOutput : (str(output.output) ?? str(output.stdout) ?? ""))
  // The end of a command's output says how it went; for everything else the start says what it is.
  if (detail.length > DETAIL_MAX) detail = kind === "execute" ? "…" + detail.slice(-DETAIL_MAX) : detail.slice(0, DETAIL_MAX) + "…"
  return defined({
    kind: "tool",
    key,
    name: TOOL_NAME[kind] ?? str(raw.name) ?? (kind || "tool"),
    status,
    title: clip(title, 80),
    detail: status === "error" ? undefined : detail || undefined,
    changes: diffs(raw.content, dir),
    error: status === "error" ? clip(detail || str(output.error) || "failed", 2000) : undefined,
  }) as ChatPart
}

// ── the agent's computer's folders, files and repository ───────────────────────────────────────

async function listFolders(m: Machine, dir: string): Promise<DirEntry[]> {
  let entries: Awaited<ReturnType<Machine["readdir"]>>
  try {
    entries = await m.readdir(dir)
  } catch (err) {
    const e = rec(err)
    // The same words as OpenCode's answer, which the controller knows (folderExists).
    if (e.code === "ENOENT" || e.code === "ENOTDIR") throw Object.assign(new Error(`Directory not found: ${dir}`), { status: 404 })
    throw new Error(`Can't read ${dir}: ${str(e.code) ?? said(err)}`)
  }
  const isDir = (p: string) => m.stat(p).then((s) => s.kind === "dir", () => false)
  const kept = await Promise.all(entries.map(async (e) => e.kind === "dir" || (e.kind === "link" && (await isDir(m.path.join(dir, e.name))))))
  const folders = entries.filter((_, i) => kept[i]).map((e) => ({ name: e.name, path: m.path.join(dir, e.name) }))
  const hidden = (e: DirEntry) => e.name.startsWith(".")
  return folders.sort((a, b) => Number(hidden(a)) - Number(hidden(b)) || a.name.localeCompare(b.name))
}

async function git(m: Machine, dir: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  const r = await m.run("git", ["-C", dir, ...args], { timeout: 10_000, maxBuffer })
  if (r.error) throw new Error(r.error.message)
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.signal ? `killed (${r.signal})` : r.err.trim() || `exit ${r.code}`}`)
  return r.out
}

async function vcs(m: Machine, dir: string): Promise<{ branch?: string; changes: RepoChange[] } | undefined> {
  try {
    if ((await git(m, dir, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return undefined
  } catch {
    return undefined
  }
  const branch = (await git(m, dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim() || undefined
  const status = await git(m, dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => "")
  const counts = new Map<string, { additions: number; deletions: number }>()
  const numstat = await git(m, dir, ["diff", "--numstat", "-z", "HEAD"]).catch(() => "")
  // -z: "<add>\t<del>\t<path>\0", or for a rename "<add>\t<del>\t\0<from>\0<to>\0".
  const parts = numstat.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]!)
    if (!match) continue
    const file = match[3] || parts[(i += 2)] || ""
    counts.set(file, { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 })
  }
  const found: Array<{ file: string; status: RepoChange["status"]; untracked: boolean }> = []
  const entries = status.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.length < 4) continue
    const x = e[0]
    const y = e[1]
    const file = e.slice(3)
    // A rename's old path follows it.
    if (x === "R" || x === "C") i++
    const untracked = x === "?"
    found.push({ file, untracked, status: untracked || x === "A" ? "added" : x === "D" || y === "D" ? "deleted" : "modified" })
  }
  // The lines of new files are counted side by side: on another computer each is a round trip.
  const changes = await Promise.all(
    found.map(async ({ file, status: kind, untracked }): Promise<RepoChange> => {
      const n = untracked ? { additions: await lineCount(m, m.path.join(dir, file)), deletions: 0 } : (counts.get(file) ?? { additions: 0, deletions: 0 })
      return { file, ...n, status: kind }
    }),
  )
  return defined({ branch, changes })
}

async function lineCount(m: Machine, file: string): Promise<number> {
  try {
    const stat = await m.stat(file)
    if (stat.kind !== "file" || stat.size > 2 * 1024 * 1024) return 0
    const text = await m.readFile(file)
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0
  } catch {
    return 0
  }
}

/** Per machine: the same path on two computers is two folders. */
const fileLists = new WeakMap<Machine, Map<string, { at: number; files: Promise<string[]> }>>()
const SKIPPED = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache", "target", "vendor", ".venv"])

/** The folder's files, relative: what git tracks or would (ignored ones left out), else a walk
 *  that skips what is never source. Kept a few seconds: a mention is typed a letter at a time. */
function filesOf(m: Machine, dir: string): Promise<string[]> {
  let lists = fileLists.get(m)
  if (!lists) fileLists.set(m, (lists = new Map()))
  const known = lists.get(dir)
  if (known && Date.now() - known.at < FILES_FRESH_MS) return known.files
  const files = git(m, dir, ["ls-files", "-co", "--exclude-standard", "-z"], 64 * 1024 * 1024)
    .then((out) => out.split("\0").filter(Boolean).slice(0, FILES_MAX))
    .catch(async () => {
      const out: string[] = []
      const walk = async (rel: string) => {
        if (out.length >= FILES_MAX) return
        let entries: Awaited<ReturnType<Machine["readdir"]>>
        try {
          entries = await m.readdir(rel ? m.path.join(dir, rel) : dir)
        } catch {
          return
        }
        for (const e of entries) {
          const p = rel ? `${rel}/${e.name}` : e.name
          if (e.kind === "dir") !SKIPPED.has(e.name) && !e.name.startsWith(".") && (await walk(p))
          else if (e.kind === "file") out.push(p)
          if (out.length >= FILES_MAX) return
        }
      }
      await walk("")
      return out
    })
  lists.set(dir, { at: Date.now(), files })
  if (lists.size > 8) lists.delete(lists.keys().next().value!)
  return files
}

async function findFiles(m: Machine, dir: string, query: string): Promise<MentionOption[]> {
  const files = await filesOf(m, dir)
  const q = query.trim().toLowerCase()
  const folders = new Set<string>()
  for (const f of files) for (let at = f.indexOf("/"); at > 0; at = f.indexOf("/", at + 1)) folders.add(f.slice(0, at))
  const score = (p: string) => {
    const lower = p.toLowerCase()
    const base = lower.slice(lower.lastIndexOf("/") + 1)
    if (!q) return 3
    if (base === q) return 0
    if (base.startsWith(q)) return 1
    if (base.includes(q)) return 2
    if (lower.includes(q)) return 3
    return -1
  }
  const ranked = [...[...folders].map((p) => ({ p, kind: "folder" as const })), ...files.map((p) => ({ p, kind: "file" as const }))]
    .map((e) => ({ ...e, s: score(e.p) }))
    .filter((e) => e.s >= 0)
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, FIND_LIMIT)
  return ranked.map(({ p, kind }) => {
    const cut = p.lastIndexOf("/")
    return defined({ kind, id: p, label: p.slice(cut + 1), detail: cut > 0 ? p.slice(0, cut) : undefined })
  })
}
