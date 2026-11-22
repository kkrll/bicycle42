// A fake ACP agent for the tests of main/acp.ts: the SDK's own agent side, over streams in
// memory, with a little state. It keeps what it said in each conversation and replays it on
// session/load the way real agents do (Claude Code's adapter, `opencode acp`): the user's message
// as user_message_chunk, then the agent's output with its chunks joined into one per message.
//
// A test scripts the agent's turns (`onPrompt`) and can end its "process" (`exit`), after which
// the backend's next start gets a new one with the same history, as a restarted agent has.
import fs from "node:fs"
import { agent, type Stream } from "@agentclientprotocol/sdk/unstable"
import type { Transport } from "../src/main/acp"

type Update = Record<string, unknown> & { sessionUpdate: string }
type Session = { id: string; cwd: string; history: Update[]; model: string; effort: string; mode: string; title?: string; archived?: true; cancel?: () => void }
type Turn = {
  session: string
  text: string
  prompt: Record<string, unknown>[]
  /** Sends an update, and keeps it for the replay. */
  say(update: Update): Promise<void>
  /** Asks the client for a permission; resolves with its answer. */
  ask(params: Record<string, unknown>): Promise<unknown>
  /** Resolves when the client cancels this turn. */
  cancelled: Promise<void>
}

export type FakeAgent = {
  /** The backend's way to start it: each start is a new "process" over the same sessions. */
  connect(): Transport
  /** What each turn does; resolves with the stop reason (default "end_turn"). */
  onPrompt: (turn: Turn) => Promise<string | void>
  /** Ends the running "process" as a crash would. */
  exit(reason?: string): void
  sessions: Map<string, Session>
  /** Every request and notification the agent got, by method, in order. */
  calls: { method: string; params: Record<string, unknown> }[]
  starts: number
  steered: Record<string, unknown>[]
  /** Answer `_session/steering` with this outcome. */
  steerOutcome: string
  capabilities: Record<string, unknown>
  /** Awaited by session/load before it answers (a load that hangs, or throws). */
  onLoad?: (session: string) => Promise<void>
  /** A turn goes on after session/cancel, as an agent that ignores it does. */
  ignoreCancel: boolean
  /** Each "process" ends a moment after it answered `initialize`: a crash at start. A string is
   *  the reason it ends with ("it exited with code 1 (Invalid API key)"). */
  dieAfterInit: boolean | string
  /** The "process" is seen to exit while its pipes still carry what it wrote (the exit event
   *  comes before its output closes). */
  holdStreams: boolean
  /** The models begin with a "Default (recommended)" that names its model. */
  defaultModel: boolean
  /** The models it offers; a conversation starts on the first. */
  models: { value: string; name: string; description?: string }[]
  /** The commands it says each new conversation has. */
  commands: { name: string; description?: string }[]
  /** What it says in `initialize` of the ways to sign in (OpenCode: "Run `opencode auth login`…"). */
  authMethods: Record<string, unknown>[]
  /** Asked for the first model, it puts the conversation on the second (an agent that answers a
   *  change of model with another one). */
  swap: Record<string, string>
  /** A conversation's config options as it says them, for a turn to send in config_option_update. */
  options(session: string): unknown[]
}

/** `byDefault`: the models begin with the agent's default, which names the model it is in its
 *  description, as Claude Code's adapter says "Default (recommended)", "Opus 5.5". */
const MODELS = [
  { value: "fake/alpha", name: "fake/Alpha", description: "Quick" },
  { value: "fake/beta", name: "fake/Beta" },
]
const OPTIONS = (s: Session, byDefault = false, models = MODELS) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: [...(byDefault ? [{ value: "default", name: "Default (recommended)", description: "fake/Beta" }] : []), ...models] },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: s.effort, options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
]

/** Chunks of one message joined, as a replay sends them. */
function coalesce(history: Update[]): Update[] {
  const out: Update[] = []
  for (const u of history) {
    const last = out.at(-1)
    const chunk = /_chunk$/.test(u.sessionUpdate)
    if (chunk && last && last.sessionUpdate === u.sessionUpdate && last.messageId === u.messageId && (u.content as { type: string }).type === "text" && (last.content as { type: string }).type === "text") {
      out[out.length - 1] = { ...last, content: { type: "text", text: (last.content as { text: string }).text + (u.content as { text: string }).text } }
    } else out.push(u)
  }
  return out
}

/** With `file`, the sessions are kept there, so a fake run as a process of its own (test/acp-agent.ts)
 *  remembers them when it is started again, as a real agent does. */
export function fakeAgent(opts: { file?: string } = {}): FakeAgent {
  let n = 0
  let current: { exit(reason: string): void } | undefined
  const fake: FakeAgent = {
    sessions: new Map(),
    calls: [],
    starts: 0,
    steered: [],
    steerOutcome: "injected",
    ignoreCancel: false,
    dieAfterInit: false,
    holdStreams: false,
    defaultModel: false,
    models: MODELS,
    commands: [{ name: "compact", description: "Summarise" }, { name: "review", description: "Review" }],
    authMethods: [],
    swap: {},
    options: (session) => OPTIONS(fake.sessions.get(session)!, fake.defaultModel, fake.models),
    capabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, fork: {}, delete: {} } },
    onPrompt: async (turn) => {
      await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" }, messageId: "m1" })
    },
    exit(reason = "it exited with code 1") {
      current?.exit(reason)
    },
    connect() {
      fake.starts++
      if (opts.file && fs.existsSync(opts.file)) {
        const kept = JSON.parse(fs.readFileSync(opts.file, "utf8")) as { n: number; sessions: Session[] }
        n = kept.n
        for (const s of kept.sessions) fake.sessions.set(s.id, s)
      }
      // Two pipes of JSON-RPC messages, one each way.
      const toAgent = new TransformStream()
      const toClient = new TransformStream()
      const clientSide: Stream = { writable: toAgent.writable, readable: toClient.readable }
      const agentSide: Stream = { writable: toClient.writable, readable: toAgent.readable }
      let exited!: (reason: string) => void
      const ended = new Promise<string>((resolve) => (exited = resolve))
      const record = (method: string) => (params: unknown) => {
        fake.calls.push({ method, params: params as Record<string, unknown> })
        return params
      }
      const app = agent({ name: "fake" })
        .onRequest("initialize", ({ params }) => {
          record("initialize")(params)
          if (fake.dieAfterInit) setTimeout(() => exit(typeof fake.dieAfterInit === "string" ? fake.dieAfterInit : "it exited with code 1"), 5)
          return { protocolVersion: 1, agentCapabilities: fake.capabilities as never, agentInfo: { name: "fake", version: "9.9" }, authMethods: fake.authMethods as never, _meta: { steering: { supported: true } } }
        })
        .onRequest("session/new", ({ params, client }) => {
          record("session/new")(params)
          const s: Session = { id: `s${++n}`, cwd: params.cwd, history: [], model: fake.models[0]?.value ?? "fake/alpha", effort: "default", mode: "build" }
          fake.sessions.set(s.id, s)
          setTimeout(() => void client.notify("session/update", { sessionId: s.id, update: { sessionUpdate: "available_commands_update", availableCommands: fake.commands } }))
          return { sessionId: s.id, configOptions: OPTIONS(s, fake.defaultModel, fake.models) as never }
        })
        .onRequest("session/load", async ({ params, client }) => {
          record("session/load")(params)
          await fake.onLoad?.(params.sessionId)
          const s = fake.sessions.get(params.sessionId)
          if (!s) throw Object.assign(new Error("Session not found"), { code: -32002 })
          for (const update of coalesce(s.history)) await client.notify("session/update", { sessionId: s.id, update: update as never })
          return { configOptions: OPTIONS(s, fake.defaultModel, fake.models) as never }
        })
        .onRequest("session/options", ({ params }) => {
          record("session/options")(params)
          return { configOptions: OPTIONS({ id: "", cwd: "", history: [], model: "default", effort: "default", mode: "build" }, fake.defaultModel, fake.models) as never }
        })
        .onRequest("session/list", ({ params }) => {
          record("session/list")(params)
          const archived = (params as { archived?: string }).archived
          return {
            sessions: [...fake.sessions.values()]
              .filter((s) => (!params.cwd || s.cwd === params.cwd) && (archived === "only" ? !!s.archived : archived === "exclude" ? !s.archived : true))
              .map((s) => ({ sessionId: s.id, cwd: s.cwd, title: s.title ?? `Session ${s.id}`, ...(archived ? { archived: !!s.archived } : {}) })),
          }
        })
        .onRequest("session/set_config_option", ({ params }) => {
          record("session/set_config_option")(params)
          const s = fake.sessions.get(params.sessionId)!
          const value = (params as { value: string }).value
          if (params.configId === "model") s.model = fake.swap[value] ?? value
          if (params.configId === "effort") s.effort = value
          if (params.configId === "mode") s.mode = value
          return { configOptions: OPTIONS(s, fake.defaultModel, fake.models) as never }
        })
        .onRequest("session/fork", ({ params }) => {
          record("session/fork")(params)
          const from = fake.sessions.get(params.sessionId)!
          const s: Session = { ...from, id: `s${++n}`, history: [...from.history] }
          fake.sessions.set(s.id, s)
          return { sessionId: s.id, configOptions: OPTIONS(s, fake.defaultModel, fake.models) as never }
        })
        .onRequest("session/delete", ({ params }) => {
          record("session/delete")(params)
          fake.sessions.delete(params.sessionId)
          return {}
        })
        .onRequest("session/archive", (p) => p as Record<string, unknown>, ({ params }) => {
          record("session/archive")(params)
          const s = fake.sessions.get(params.sessionId as string)
          if (s) s.archived = true
          return {}
        })
        .onRequest("session/unarchive", (p) => p as Record<string, unknown>, ({ params }) => {
          record("session/unarchive")(params)
          const s = fake.sessions.get(params.sessionId as string)
          if (s) delete s.archived
          return {}
        })
        .onRequest("session/set_title", (p) => p as Record<string, unknown>, ({ params }) => {
          record("session/set_title")(params)
          const s = fake.sessions.get(params.sessionId as string)
          if (s) s.title = params.title as string
          return {}
        })
        .onRequest("_session/steering", (p) => p as Record<string, unknown>, ({ params }) => {
          record("_session/steering")(params)
          fake.steered.push(params)
          return { outcome: fake.steerOutcome }
        })
        .onNotification("session/cancel", ({ params }) => {
          record("session/cancel")(params)
          fake.sessions.get(params.sessionId)?.cancel?.()
        })
        .onRequest("session/prompt", async ({ params, client }) => {
          record("session/prompt")(params)
          const s = fake.sessions.get(params.sessionId)!
          const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("")
          const user = `u${s.history.length}`
          for (const block of params.prompt) s.history.push({ sessionUpdate: "user_message_chunk", content: block as never, messageId: user })
          let cancel!: () => void
          const cancelled = new Promise<void>((resolve) => (cancel = resolve))
          s.cancel = cancel
          const turn: Turn = {
            session: s.id,
            text,
            prompt: params.prompt as never,
            async say(update) {
              s.history.push(update)
              await client.notify("session/update", { sessionId: s.id, update: update as never })
            },
            ask: (p) => client.request("session/request_permission", { sessionId: s.id, ...(p as object) } as never),
            cancelled,
          }
          const stop = await (fake.ignoreCancel ? fake.onPrompt(turn) : Promise.race([fake.onPrompt(turn), cancelled.then(() => "cancelled")]))
          s.cancel = undefined
          return { stopReason: (stop || "end_turn") as never }
        })
      if (opts.file) {
        const file = opts.file
        const keep = () => fs.writeFileSync(file, JSON.stringify({ n, sessions: [...fake.sessions.values()].map(({ cancel: _, ...s }) => s) }))
        // Often enough for a test: what a turn said is on disk before the process can be ended.
        const timer = setInterval(keep, 20)
        void ended.then(() => clearInterval(timer))
      }
      app.connect(agentSide)
      const exit = (reason: string) => {
        exited(reason)
        if (fake.holdStreams) return
        void toClient.writable.abort(new Error(reason)).catch(() => {})
        void toAgent.writable.abort(new Error(reason)).catch(() => {})
      }
      current = { exit }
      return { stream: clientSide, exited: ended, kill: () => exit("it was ended (SIGTERM)") }
    },
  }
  return fake
}
