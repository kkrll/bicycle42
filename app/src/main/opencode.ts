// The OpenCode backend: the only file that knows the server's wire format (v2 HTTP API + SSE).
//
//   requests   plain fetch with HTTP Basic auth; every failure becomes an Error a user can act on
//   reading    transcript(): message list + inbox → ChatItems                     (chatItems)
//   live       listen(): one SSE connection → BackendEvents                       (createEventMapper)
//
// The server has no message or part events. A conversation is rebuilt from step / text /
// reasoning / tool events, and the same conversation can be re-read from the message list. Both
// paths go through the same builders (userItem, toolPart, the markers), so they give the same
// items with the same ids and part keys, and a re-read after a reconnect never duplicates or
// reorders anything.
//
// Server payloads are untrusted: every field is read through rec/str/num/list, and anything
// unknown is skipped and logged once.
import { posix } from "node:path"
import type {
  AgentInfo,
  Backend,
  BackendEvent,
  ChatAssistant,
  ChatEvent,
  ChatImage,
  ChatItem,
  ChatMarker,
  ChatPart,
  ChatUser,
  Delivery,
  DirEntry,
  FileChange,
  Mention,
  MentionOption,
  ModelInfo,
  ModelRef,
  PermissionAsk,
  PromptFile,
  Question,
  QuestionField,
  RunningCommand,
  SessionSummary,
  SlashCommand,
  ToolStatus,
} from "../shared/types"

/** The OpenCode client: a Backend, plus the helper agents a message can `@`-name. Those are not
 *  in the Backend contract (its `agents()` lists the ones a person can switch to), so the
 *  controller reaches them through this wider type. */
export type OpenCode = Backend & {
  /** Agents a message can hand work to with `@name`: not primary-only, not hidden. */
  mentionAgents(): Promise<MentionOption[]>
}

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void
type Warn = (msg: string, data?: unknown) => void

/** Exported so tests can shorten them. Milliseconds. */
export const timing = {
  /** The server sends a heartbeat every 15 s; two missed ones and a bit means the line is dead. */
  watchdog: 40_000,
  retryMin: 1_000,
  retryMax: 30_000,
  request: 60_000,
}

/** Exactly the events the mapper and listen() use. The server rejects the whole stream (400) on
 *  a name it does not know, and without a filter it sends catalog noise every few seconds. */
const EVENT_TYPES = [
  "session.created",
  "session.renamed",
  "session.deleted",
  "session.model.selected",
  "session.agent.selected",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
]

/** Events only newer servers have: a summary being written, and undo. Asked for on top of the
 *  list above; a server that refuses the filter because of them is asked again without (see
 *  listen), and the commands that rely on them re-read the conversation instead. */
const OPTIONAL_EVENT_TYPES = [
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.revert.staged",
  "session.revert.cleared",
  "session.revert.committed",
]

/** Without the optional events: what says that a summary asked for has been written, or will
 *  not be. It is written between two steps, or in a run of its own. */
const AFTER_SUMMARY = new Set(["session.step.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/** Events after which a session's summary (title, model, agent, busy) has changed. They carry
 *  only the changed field, so listen() re-reads the session. */
const SUMMARY_EVENTS = new Set([
  "session.created",
  "session.renamed",
  "session.model.selected",
  "session.agent.selected",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.revert.staged",
  "session.revert.cleared",
  "session.revert.committed",
])

// ── reading untrusted JSON ──────────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>

const rec = (v: unknown): Raw => (v !== null && typeof v === "object" ? (v as Raw) : {})
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Drops undefined fields, so an item built from events deep-equals the one built from a re-read. */
function defined<T extends object>(o: T): T {
  for (const k in o) if (o[k] === undefined) delete o[k]
  return o
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s)

// ── wire → chat ─────────────────────────────────────────────────────────────────────────────────

const NOTE_HEAD = /^UI review note (\d+) on /
/** The lines notePrompt (overlay/prompt.js) can put after the note's text. */
const NOTE_END =
  /^(Elements \(page-provided |Marked area: |The reviewer drew \d|Canvas edits, made on the live page |Image 1 is the |The attached screenshot shows |Purple outlines mark |An outline marks |Make the smallest change |Template \/[a-z-]+: )/

/** Finds the reviewer's own words in a review-note prompt, so the chat can show those instead of
 *  the whole prompt. The note may span lines: it runs until the next line the prompt adds. */
export function parseNote(text: string): { n: number; text: string } | undefined {
  const lines = text.split("\n")
  const head = NOTE_HEAD.exec(lines[0] ?? "")
  if (!head || !lines[1]?.startsWith("Note: ")) return undefined
  let end = 2
  while (end < lines.length && !NOTE_END.test(lines[end]!)) end++
  return { n: Number(head[1]), text: lines.slice(1, end).join("\n").slice("Note: ".length) }
}

/** `payload` is a user message or an inbox item's payload: both are `{ text, files? }`. */
function userItem(id: string, time: number, payload: Raw, pending: boolean): ChatUser {
  const text = str(payload.text) ?? ""
  const images: ChatImage[] = []
  for (const raw of list(payload.files)) {
    const file = rec(raw)
    const mime = str(file.mime)
    const data = str(file.data)
    if (mime?.startsWith("image/") && data)
      images.push({ name: str(file.name) ?? "image", src: `data:${mime};base64,${data}` })
  }
  return defined({ kind: "user", id, time, text, images, note: parseNote(text), pending: pending || undefined })
}

function fileChanges(metadata: unknown): FileChange[] | undefined {
  const changes: FileChange[] = []
  for (const raw of list(rec(metadata).files)) {
    const f = rec(raw)
    const file = str(f.file)
    if (file) changes.push({ file, patch: str(f.patch) ?? "", additions: num(f.additions) ?? 0, deletions: num(f.deletions) ?? 0 })
  }
  return changes.length ? changes : undefined
}

/** One line saying what a tool call does. `dir` is the session's folder: paths inside it are
 *  shown relative. */
function toolTitle(name: string, input: unknown, dir: string | undefined): string {
  const i = rec(input)
  const path = str(i.path)
  const rel = path !== undefined && dir && path.startsWith(dir + "/") ? path.slice(dir.length + 1) : path
  let title: string | undefined
  if (name === "edit" || name === "write" || name === "patch") title = rel && `edit ${rel}`
  else if (name === "shell") title = str(i.command)?.trim().split("\n", 1)[0]?.trim()
  else if (name === "read") title = rel && `read ${rel}`
  else if (name === "grep" || name === "glob") title = str(i.pattern) && `${name} ${str(i.pattern)}`
  // Any other tool, or a known one without its usual argument (input still streaming).
  if (!title) title = Object.keys(i).length ? `${name} ${JSON.stringify(i)}` : name
  return clip(title, 80)
}

const TOOL_STATUS: Record<string, ToolStatus> = { streaming: "pending", running: "running", completed: "done", error: "error" }
const DETAIL_MAX = 4096

/** `state` is a tool part's state as the message list has it: `{ status, input, content?,
 *  metadata?, error? }`. The event mapper builds the same shape from tool events. */
function toolPart(key: string, name: string, state: Raw, dir: string | undefined): ChatPart {
  let detail = list(state.content)
    .map((c) => str(rec(c).text) ?? "")
    .filter(Boolean)
    .join("\n")
  // The end of a command's output says how it went; for everything else the start says what it is.
  if (detail.length > DETAIL_MAX)
    detail = name === "shell" ? "…" + detail.slice(-DETAIL_MAX) : detail.slice(0, DETAIL_MAX) + "…"
  return defined({
    kind: "tool",
    key,
    name,
    status: TOOL_STATUS[str(state.status) ?? ""] ?? "pending",
    title: toolTitle(name, state.input, dir),
    detail: detail || undefined,
    changes: fileChanges(state.metadata),
    error: str(rec(state.error).message),
  })
}

function assistantItem(id: string, time: number, m: Raw, dir: string | undefined): ChatAssistant {
  const parts: ChatPart[] = []
  // Text and reasoning are addressed by an ordinal that counts per kind, as in the events.
  const ordinal = { text: 0, reasoning: 0 }
  for (const raw of list(m.content)) {
    const c = rec(raw)
    if (c.type === "text" || c.type === "reasoning")
      parts.push({ kind: c.type, key: `${c.type}:${ordinal[c.type]++}`, text: str(c.text) ?? "" })
    else if (c.type === "tool" && str(c.id)) parts.push(toolPart(str(c.id)!, str(c.name) ?? "tool", rec(c.state), dir))
  }
  return defined({
    kind: "assistant",
    id,
    time,
    parts,
    done: num(rec(m.time).completed) !== undefined,
    error: str(rec(m.error).message),
  })
}

/** The end of a run. A run that succeeded leaves no line. */
function endMarker(id: string, time: number, outcome: unknown, error: unknown): ChatMarker | undefined {
  if (outcome === "interrupted") return { kind: "marker", id, time, text: "Stopped", tone: "error" }
  if (outcome === "failed")
    return { kind: "marker", id, time, text: `Failed: ${str(rec(error).message) ?? "unknown error"}`, tone: "error", failed: true }
  return undefined
}

function modelMarker(id: string, time: number, model: unknown): ChatMarker {
  const m = rec(model)
  const variant = str(m.variant)
  const text = `Model changed to ${str(m.id) ?? "?"}${variant && variant !== "default" ? ` (${variant})` : ""}`
  return { kind: "marker", id, time, text, tone: "info" }
}

// ── summaries (compaction) and undo ─────────────────────────────────────────────────────────────
// The server can replace the conversation so far by a summary, to free up context: by itself
// when the context fills ("auto") or when asked ("manual", /compact). The chat shows it as a
// step of the agent's whose text is the summary. The messages before it stay in the list.

const SUMMARY_KEY = "text:0"
const summaryReason = (reason: unknown): "manual" | "auto" => (reason === "auto" ? "auto" : "manual")

function summaryItem(id: string, time: number, reason: unknown, text: string, done: boolean): ChatAssistant {
  return { kind: "assistant", id, time, parts: text ? [{ kind: "text", key: SUMMARY_KEY, text }] : [], done, summary: summaryReason(reason) }
}

/** A summary that did not happen. "Nothing to compact yet" is an answer, not a fault. */
function summaryFailed(id: string, time: number, error: unknown): ChatMarker {
  const e = rec(error)
  const why = str(e.message)?.replace(/[.\s]+$/, "")
  return { kind: "marker", id, time, text: `The conversation was not summarised${why ? `: ${why}` : ""}.`, tone: e.type === "compaction.unavailable" ? "info" : "error" }
}

/** The line where an undone part of the conversation was. `turns` is how many of the user's
 *  messages went. */
function undoneMarker(boundary: string, time: number, turns: number): ChatMarker {
  const what = turns === 1 ? "Your last message and the agent's work on it are" : `Your last ${turns} messages and the agent's work on them are`
  return { kind: "marker", id: `undone:${boundary}`, time, text: `${what} undone. /redo brings ${turns === 1 ? "it" : "them"} back; your next message makes it final.`, tone: "info" }
}

function agentMarker(id: string, time: number, agent: unknown): ChatMarker {
  return { kind: "marker", id, time, text: `Agent changed to ${str(agent) ?? "?"}`, tone: "info" }
}

/** A conversation from a re-read: the message list (oldest first), then what still waits in the
 *  inbox. `dir` is the session's folder. `undone` is the first message of a part that was undone
 *  and not yet given up for good: the list still has it, the conversation does not. */
export function chatItems(messages: unknown[], inbox: unknown[], dir: string | undefined, warn: Warn = () => {}, undone?: string): ChatItem[] {
  const items: ChatItem[] = []
  const delivered = new Set<string>()
  /** The user's messages from `undone` on, once it is reached. */
  let gone = -1
  let goneAt = 0
  for (const raw of messages) {
    const m = rec(raw)
    const id = str(m.id)
    const time = num(rec(m.time).created) ?? 0
    if (!id) {
      warn("Skipped a message without an id")
      continue
    }
    delivered.add(id)
    if (undone && id === undone) (gone = 0), (goneAt = time)
    if (gone >= 0) {
      if (m.type === "user") gone++
      continue
    }
    let item: ChatItem | undefined
    switch (m.type) {
      case "user":
        item = userItem(id, time, m, false)
        break
      case "assistant":
        item = assistantItem(id, time, m, dir)
        break
      case "idle":
        item = endMarker(id, time, m.outcome, m.error)
        break
      case "model-switched":
        item = modelMarker(id, time, m.model)
        break
      case "agent-switched":
        item = agentMarker(id, time, m.agent)
        break
      // Prompts the server writes for the model, and records this app has no view for.
      case "compaction":
        item =
          m.status === "failed"
            ? summaryFailed(id, time, m.error)
            : summaryItem(id, time, m.reason, str(m.summary) ?? "", m.status !== "running")
        break
      case "synthetic":
      case "system":
      case "skill":
      case "shell":
      case "location-switched":
        break
      default:
        warn(`Skipped a message of unknown type "${String(m.type)}"`)
    }
    if (item) items.push(item)
  }
  if (undone && gone >= 0) items.push(undoneMarker(undone, goneAt, gone))
  for (const raw of inbox) {
    const i = rec(raw)
    const id = str(i.id)
    // The inbox also holds reminders the server queues for the model (type "synthetic").
    if (i.type !== "user" || !id || delivered.has(id)) continue
    items.push(userItem(id, num(rec(i.time).created) ?? 0, rec(i.payload), true))
  }
  return items
}

function permissionAsk(raw: unknown): PermissionAsk | undefined {
  const p = rec(raw)
  const id = str(p.id)
  const session = str(p.sessionID)
  if (!id || !session) return undefined
  return defined({
    id,
    session,
    action: str(p.action) ?? "",
    resources: list(p.resources).filter((r): r is string => typeof r === "string"),
    changes: fileChanges(p.metadata),
    message: str(p.message),
  })
}

const FIELD_TYPE: Record<string, QuestionField["type"]> = {
  string: "string",
  multiselect: "multiselect",
  boolean: "boolean",
  number: "number",
  integer: "number",
}

function question(raw: unknown, warn: Warn): Question | undefined {
  const form = rec(raw)
  const id = str(form.id)
  const session = str(form.sessionID)
  if (!id || !session) return undefined
  const fields: QuestionField[] = []
  for (const rawField of list(form.fields)) {
    const f = rec(rawField)
    const key = str(f.key)
    const type = FIELD_TYPE[str(f.type) ?? ""]
    if (!key || f.hidden === true) continue
    if (!type) {
      // "external" (open a URL) is the one known kind without a form control.
      warn(`Skipped a question field of type "${String(f.type)}"`)
      continue
    }
    const options = list(f.options).flatMap((rawOption) => {
      const o = rec(rawOption)
      const value = str(o.value)
      return value === undefined ? [] : [defined({ value, label: str(o.label) ?? value, description: str(o.description) })]
    })
    fields.push(
      defined({
        key,
        type,
        title: str(f.title),
        description: str(f.description),
        placeholder: str(f.placeholder),
        options: options.length ? options : undefined,
        custom: typeof f.custom === "boolean" ? f.custom : undefined,
        required: typeof f.required === "boolean" ? f.required : undefined,
      }),
    )
  }
  return { id, session, title: str(form.title) ?? "", fields }
}

/** The server fills in "default" when no effort level is chosen. That is not one of the model's
 *  variants, so it stays on this side. */
function modelRef(raw: unknown): ModelRef | undefined {
  const m = rec(raw)
  const providerID = str(m.providerID)
  const id = str(m.id)
  if (!providerID || !id) return undefined
  const variant = str(m.variant)
  return defined({ providerID, id, variant: variant === "default" ? undefined : variant })
}

function sessionSummary(raw: unknown): SessionSummary | undefined {
  const s = rec(raw)
  const id = str(s.id)
  if (!id) return undefined
  const time = rec(s.time)
  const busy = num(time.busy)
  const idle = num(time.idle)
  return defined({
    id,
    directory: str(rec(s.location).directory) ?? "",
    parent: str(s.parentID),
    title: str(s.title) ?? "",
    updated: num(time.updated) ?? num(time.created) ?? 0,
    // There is no status field: a run sets time.busy when it starts and time.idle when it ends.
    busy: busy !== undefined && (idle === undefined || idle < busy),
    model: modelRef(s.model),
    agent: str(s.agent),
    undone: str(rec(s.revert).messageID),
  })
}

// ── events → BackendEvents ──────────────────────────────────────────────────────────────────────

type Step = {
  time: number
  dir: string | undefined
  parts: ChatPart[]
  /** tool.called and tool.success carry neither the name nor the input, so they are kept. */
  tools: Map<string, { name: string; input: unknown }>
}

const TOOL_STATE: Record<string, string> = {
  "session.tool.input.started": "streaming",
  "session.tool.called": "running",
  "session.tool.success": "completed",
  "session.tool.failed": "error",
}

/** A message that a durable event produces (the run-end line, a model switch) carries the
 *  event's id with the other prefix. Seen on every sample; it is what lets a marker built from
 *  an event have the id the message list will give it. */
const messageID = (eventID: unknown) => "msg_" + (str(eventID) ?? "").replace(/^evt_/, "")

/** Turns the server's events into BackendEvents, one connection's worth: make a new one after a
 *  reconnect, because what it remembers (the open steps) is stale by then.
 *
 *  It keeps the steps that are still running, so a step's end can be sent as one whole item.
 *  Deltas pass straight through: a `delta` ChatEvent holds the appended text and nothing else. */
export function createEventMapper(emit: (event: BackendEvent) => void, warn: Warn = () => {}): (raw: unknown) => void {
  const steps = new Map<string, Step>()
  /** Inbox ids of the server's own (non-user) items, which never reach the chat. */
  const notOurs = new Set<string>()
  /** Sessions already told to re-read, until one of their steps starts in view again. */
  const gaps = new Set<string>()
  /** The summary being written in each session: its deltas say only which session. */
  const summaries = new Map<string, { id: string; time: number; reason: unknown; text: string }>()
  const chat = (event: ChatEvent) => emit({ type: "chat", event })

  return (raw) => {
    const ev = rec(raw)
    const type = str(ev.type)
    const d = rec(ev.data)
    if (type === "server.connected") return
    const session = str(d.sessionID) ?? str(rec(d.form).sessionID)
    if (!type || !session) return warn("Skipped an event without a type or a session", type)
    const time = num(ev.created) ?? Date.now()

    switch (type) {
      // listen() re-reads the session for these; only the two switches also leave a line.
      case "session.created":
      case "session.renamed":
        return
      case "session.deleted":
        return emit({ type: "session-gone", session })
      case "session.model.selected":
        return chat({ type: "item", session, item: modelMarker(messageID(ev.id), time, d.model) })
      case "session.agent.selected":
        return chat({ type: "item", session, item: agentMarker(messageID(ev.id), time, d.agent) })

      case "session.inbox.enqueued": {
        const id = str(d.inboxID)
        const item = rec(d.item)
        if (!id) return
        if (item.type !== "user") return void notOurs.add(id)
        emit({ type: "inbox", session, id, status: "queued" })
        return chat({ type: "item", session, item: userItem(id, time, rec(item.payload), true) })
      }
      case "session.inbox.delivered": {
        const id = str(d.inboxID)
        if (!id) return
        if (notOurs.delete(id)) return
        emit({ type: "inbox", session, id, status: "working" })
        // It was shown where it was queued, which may be above the answers to earlier messages;
        // it belongs at the end now, where the message list has it. Only the id travels: the
        // text and screenshots are already there, from `enqueued` or from a re-read if it was
        // queued before this connection.
        return chat({ type: "delivered", session, item: id, time })
      }
      case "session.inbox.cancelled": {
        const id = str(d.inboxID)
        if (!id) return
        if (notOurs.delete(id)) return
        emit({ type: "inbox", session, id, status: "cancelled" })
        return chat({ type: "remove", session, item: id })
      }

      case "session.execution.started":
        return emit({ type: "run", session, status: "started" })
      case "session.execution.succeeded":
        return emit({ type: "run", session, status: "succeeded" })
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const status = type === "session.execution.failed" ? "failed" : "interrupted"
        emit(defined({ type: "run", session, status, error: str(rec(d.error).message) }))
        const marker = endMarker(messageID(ev.id), time, status, d.error)
        if (marker) chat({ type: "item", session, item: marker })
        return
      }

      // A summary of the conversation (see summaryItem). Its message takes the id the request
      // came with, or else the id of the event that started it.
      case "session.compaction.started": {
        const running = { id: str(d.inputID) ?? messageID(ev.id), time, reason: d.reason, text: "" }
        summaries.set(session, running)
        return chat({ type: "item", session, item: summaryItem(running.id, time, d.reason, "", false) })
      }
      case "session.compaction.delta": {
        const running = summaries.get(session)
        const text = str(d.text) ?? ""
        if (!running || !text) return
        const first = !running.text
        running.text += text
        if (first) return chat({ type: "part", session, item: running.id, part: { kind: "text", key: SUMMARY_KEY, text } })
        return chat({ type: "delta", session, item: running.id, key: SUMMARY_KEY, text })
      }
      case "session.compaction.ended": {
        const running = summaries.get(session)
        summaries.delete(session)
        // Started before this connection: the list has it under the id it started with, which
        // this event does not carry. Have the conversation re-read.
        if (!running) return emit({ type: "resync", session })
        return chat({ type: "item", session, item: summaryItem(running.id, running.time, d.reason, str(d.text) ?? running.text, true) })
      }
      case "session.compaction.failed": {
        const running = summaries.get(session)
        summaries.delete(session)
        return chat({ type: "item", session, item: summaryFailed(running?.id ?? str(d.inputID) ?? messageID(ev.id), running?.time ?? time, d.error) })
      }

      // Part of the conversation was undone, brought back, or given up for good: what the
      // conversation holds has changed in a way no single item says.
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
        return emit({ type: "resync", session })

      case "session.step.started": {
        const id = str(d.assistantMessageID)
        if (!id) return
        const step: Step = { time: num(d.started) ?? time, dir: str(rec(ev.location).directory), parts: [], tools: new Map() }
        steps.set(id, step)
        gaps.delete(session)
        return chat({ type: "item", session, item: { kind: "assistant", id, time: step.time, parts: [], done: false } })
      }
      case "session.step.ended":
      case "session.step.failed": {
        const id = str(d.assistantMessageID)
        if (!id) return
        const step = steps.get(id)
        steps.delete(id)
        // It started before this connection, so its parts were never seen. Sending what little
        // is known would replace a fuller item on screen; have that conversation re-read
        // instead. Once is enough: the re-read covers everything up to the next step.
        if (!step) {
          if (!gaps.has(session)) emit({ type: "resync", session })
          return void gaps.add(session)
        }
        const error = type === "session.step.failed" ? str(rec(d.error).message) : undefined
        const item: ChatAssistant = defined({ kind: "assistant", id, time: step.time, parts: step.parts, done: true, error })
        return chat({ type: "item", session, item })
      }

      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        const item = str(d.assistantMessageID) ?? ""
        const step = steps.get(item)
        if (!step) return
        const kind = type.startsWith("session.text.") ? "text" : "reasoning"
        const key = `${kind}:${num(d.ordinal) ?? 0}`
        const at = step.parts.findIndex((p) => p.key === key)
        const old = step.parts[at]
        const before = old && old.kind !== "tool" ? old.text : ""
        if (old && type.endsWith(".delta")) {
          const text = str(d.delta) ?? ""
          // A new object each time: the previous one was handed out and may be anyone's by now.
          step.parts[at] = { kind, key, text: before + text }
          return chat({ type: "delta", session, item, key, text })
        }
        // started: empty. ended: the authoritative full text. A delta whose start was missed
        // opens the part.
        const part: ChatPart = { kind, key, text: str(d.text) ?? str(d.delta) ?? before }
        step.parts[at < 0 ? step.parts.length : at] = part
        return chat({ type: "part", session, item, part: { ...part } })
      }

      case "session.tool.input.started":
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed": {
        const item = str(d.assistantMessageID) ?? ""
        const step = steps.get(item)
        const id = str(d.id)
        if (!step || !id) return
        let tool = step.tools.get(id)
        if (!tool) step.tools.set(id, (tool = { name: str(d.name) ?? "tool", input: undefined }))
        if ("input" in d) tool.input = d.input
        const part = toolPart(id, tool.name, { ...d, status: TOOL_STATE[type], input: tool.input }, step.dir)
        const at = step.parts.findIndex((p) => p.key === id)
        step.parts[at < 0 ? step.parts.length : at] = part
        return chat({ type: "part", session, item, part })
      }

      case "permission.asked": {
        const ask = permissionAsk(d)
        return ask ? emit({ type: "permission", ask }) : warn("Skipped a permission request without an id")
      }
      case "permission.replied": {
        const id = str(d.requestID)
        return id ? emit({ type: "permission-done", session, id }) : undefined
      }
      case "form.created": {
        const q = question(d.form, warn)
        return q ? emit({ type: "question", question: q }) : warn("Skipped a question without an id")
      }
      case "form.replied":
      case "form.cancelled": {
        const id = str(d.id)
        return id ? emit({ type: "question-done", session, id }) : undefined
      }

      default:
        return warn(`Skipped an event of unknown type "${type}"`)
    }
  }
}

// ── the client ──────────────────────────────────────────────────────────────────────────────────

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let idTime = 0
let idCount = 0

/** A message id made the way the server makes its own (packages/schema/src/identifier.ts):
 *  48 bits of milliseconds × 4096 + a counter within the millisecond, as hex, then 14 random
 *  characters. Ids sort by time, and the server orders messages by id, so an invented format
 *  could put a message in the wrong place. */
function newMessageId(): string {
  const now = Date.now()
  if (now !== idTime) {
    idTime = now
    idCount = 0
  }
  idCount++
  const time = ((BigInt(now) * 0x1000n + BigInt(idCount)) & 0xffff_ffff_ffffn).toString(16).padStart(12, "0")
  const random = crypto.getRandomValues(new Uint8Array(14))
  return "msg_" + time + Array.from(random, (byte) => ID_CHARS[byte % 62]).join("")
}

const PAGE = 200
/** At most this many files and folders per search: what one `@` list shows. */
const FIND_LIMIT = 20
const DETAIL_MAX_CHARS = 160

/** `file://` URL of an absolute path on the server. Built by hand, not with pathToFileURL: the
 *  server may be another machine, and its paths are POSIX whatever this one runs. */
const fileUri = (abs: string) => "file://" + abs.split("/").map(encodeURIComponent).join("/")

type WireMention = { start: number; end: number; text: string }

/** A mention's place in the text, or undefined when the range does not fit the text (the
 *  attachment still goes, just without a place). */
function wireMention(text: string, m: Mention): WireMention | undefined {
  const { start, end } = m
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return undefined
  return { start, end, text: text.slice(start, end) }
}

/** The attachments of a prompt or command: pasted pictures plus whatever the text `@`-names.
 *  A file or folder mention's id must be absolute by now; it travels as a file:// attachment and
 *  its `@path` stays in the text. Empty lists are left out. */
function attachments(text: string, files: PromptFile[] = [], mentions: Mention[] = []) {
  const out: {
    files: { uri: string; name: string; mention?: WireMention }[]
    agents: { name: string; mention?: WireMention }[]
    skills: { id: string; mention?: WireMention }[]
  } = { files: files.map((f) => ({ uri: f.uri, name: f.name })), agents: [], skills: [] }
  for (const m of mentions) {
    const mention = wireMention(text, m)
    if (m.kind === "file" || m.kind === "folder") {
      if (!m.id.startsWith("/")) throw new Error(`Can't attach "${m.id}": its full path is unknown.`)
      const path = m.id.replace(/(.)\/+$/, "$1")
      out.files.push(defined({ uri: fileUri(path), name: posix.basename(path) || path, mention }))
    } else if (m.kind === "agent") out.agents.push(defined({ name: m.id, mention }))
    else if (m.kind === "skill") out.skills.push(defined({ id: m.id, mention }))
  }
  return defined({
    files: out.files.length ? out.files : undefined,
    agents: out.agents.length ? out.agents : undefined,
    skills: out.skills.length ? out.skills : undefined,
  })
}

const deliveryOf = (d: Delivery | undefined): Delivery => (d === "steer" ? "steer" : "queue")

const atLocation = (directory: string) => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`

/** Reads `data:` frames off an SSE body until it ends. The server sends nothing else: no
 *  `event:` or `id:` lines, and a `: heartbeat` comment to keep the line open. */
async function readEvents(body: ReadableStream<Uint8Array>, alive: () => void, onEvent: (raw: unknown) => void, warn: Warn) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    alive()
    buf += decoder.decode(value, { stream: true })
    let start = 0
    let end: number
    while ((end = buf.indexOf("\n\n", start)) >= 0) {
      let data = ""
      for (const line of buf.slice(start, end).split("\n"))
        if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(line[5] === " " ? 6 : 5)
      start = end + 2
      if (!data) continue
      let event: unknown
      try {
        event = JSON.parse(data)
      } catch {
        warn("Skipped an event that is not JSON")
        continue
      }
      onEvent(event)
    }
    buf = buf.slice(start)
  }
}

/** Resolves after `ms`, or at once when aborted. Leaves no timer behind either way. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done)
  })
}

export function createOpenCode(opts: { url: string; password: string; fetch?: typeof fetch; log?: Log }): OpenCode {
  const log: Log = opts.log ?? (() => {})
  const warned = new Set<string>()
  /** Once per message: a server that sends one odd thing sends it a thousand times. */
  const warn: Warn = (msg, data) => {
    if (warned.has(msg)) return
    warned.add(msg)
    log("warn", msg, data)
  }

  // The same code serves http://127.0.0.1:<port> and the server's HTTPS tunnel. Credentials typed
  // into the URL are dropped: fetch refuses such URLs, and the password has its own field.
  let base: string | undefined
  let host = opts.url
  try {
    const url = new URL(opts.url)
    base = url.origin + url.pathname.replace(/\/+$/, "")
    host = url.host
  } catch {
    // Reported by the first request, where the caller is listening for a rejection.
  }
  const authorization = "Basic " + Buffer.from(`opencode:${opts.password}`).toString("base64")

  function unreachable(err: unknown): Error {
    const e = rec(err)
    const cause = rec(e.cause)
    const code = str(cause.code) ?? str(e.code)
    const why =
      code === "ECONNREFUSED"
        ? "connection refused"
        : code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? "address not found"
          : code === "ECONNRESET" || code === "UND_ERR_SOCKET"
            ? "connection dropped"
            : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || e.name === "TimeoutError"
              ? "no answer"
              : str(cause.message) || str(e.message) || "network error"
    return new Error(`Can't reach ${host} (${why})`)
  }

  function refused(status: number, body: string): Error {
    let detail = ""
    try {
      const json = rec(JSON.parse(body))
      const tag = str(json._tag)
      detail = [str(json.message), tag && `(${tag})`].filter(Boolean).join(" ")
    } catch {
      // Not the server's own error (a proxy's HTML page, say): the status has to do.
    }
    const message = status === 401 ? "Wrong password" : `The server answered ${status}${detail ? `: ${detail}` : ""}`
    return Object.assign(new Error(message), { status })
  }

  /** Resolves with a response whose status is 2xx. `signal` belongs to the caller: when it
   *  fires, the rejection is the abort itself, not a "can't reach". */
  async function send(method: string, path: string, body: unknown, signal: AbortSignal, accept: string): Promise<Response> {
    if (!base) throw new Error(`"${opts.url}" is not a server address`)
    const headers: Record<string, string> = { Authorization: authorization, Accept: accept }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    let res: Response
    try {
      res = await (opts.fetch ?? fetch)(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
    } catch (err) {
      // A request that ran out of time is the server's silence, not the caller's abort.
      throw signal.reason === err && rec(err).name !== "TimeoutError" ? err : unreachable(err)
    }
    if (res.ok) return res
    throw refused(res.status, await res.text().catch(() => ""))
  }

  /** One JSON call. Resolves `undefined` for an empty answer (204). */
  async function api(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timing.request)
    const res = await send(method, path, body, signal ? AbortSignal.any([signal, timeout]) : timeout, "application/json")
    let text: string
    try {
      text = await res.text()
    } catch (err) {
      throw signal?.aborted ? err : unreachable(err)
    }
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      // Any web server answers 200 with a page; only this one answers JSON.
      throw new Error(`${host} doesn't answer like an OpenCode server`)
    }
  }

  const data = async (method: string, path: string, body?: unknown, signal?: AbortSignal) => rec(await api(method, path, body, signal)).data
  const sessionPath = (id: string) => `/api/session/${encodeURIComponent(id)}`

  /** The server refused the optional events (OPTIONAL_EVENT_TYPES), so this client goes without
   *  them for as long as it lives: what they would have said is read back instead. */
  let limited = false
  /** The open listen(): where a re-read can be asked for from outside the event stream. */
  let live: { emit(event: BackendEvent): void; refresh(session: string): void } | undefined
  /** Sessions with a summary asked for whose end no event will tell (limited). */
  const summarising = new Set<string>()
  /** After a command whose events this server does not send: have the conversation read again. */
  const reread = (id: string) => {
    if (!limited || !live) return
    live.emit({ type: "resync", session: id })
    live.refresh(id)
  }

  async function info(signal?: AbortSignal): Promise<{ version: string; computer?: string }> {
    const said = rec(await api("GET", "/api/info", undefined, signal))
    const version = str(said.version)
    if (!version) throw new Error(`${host} doesn't answer like an OpenCode server`)
    // "kkrll.local" → "kkrll": the computer's own name, as a person would say it.
    const computer = (str(said.hostname) ?? "").replace(/[\x00-\x1f]+/g, " ").trim().replace(/\.(local|lan|home|localdomain)$/i, "").slice(0, 60)
    return { version, ...(computer ? { computer } : {}) }
  }

  async function session(id: string, signal?: AbortSignal): Promise<SessionSummary | null> {
    try {
      return sessionSummary(await data("GET", sessionPath(id), undefined, signal)) ?? null
    } catch (err) {
      if (rec(err).status === 404) return null
      throw err
    }
  }

  return {
    info: () => info(),

    async projects() {
      const projects = list(await api("GET", "/api/project")).map(rec)
      projects.sort((a, b) => (num(rec(b.time).active) ?? 0) - (num(rec(a.time).active) ?? 0))
      // The server can list one folder under several project ids, and keeps a catch-all at "/".
      const folders = new Set<string>()
      for (const p of projects) {
        const folder = str(p.canonical)
        if (folder && folder !== "/") folders.add(folder)
      }
      return [...folders]
    },

    async listFolders(path) {
      // Entries come back relative to the server's location, not to `path`: "code/site/"
      // when it runs in /home/dev, "../../tmp/x/" for a folder outside it. The answer says which
      // location that was. No location is sent: naming one makes the server register a project
      // for it, and browsing must not leave projects behind.
      const res = rec(await api("GET", `/api/fs/list?path=${encodeURIComponent(path)}`))
      const from = str(rec(res.location).directory) ?? "/"
      const folders: DirEntry[] = []
      for (const raw of list(res.data)) {
        const entry = rec(raw)
        const rel = str(entry.path)
        if (entry.type !== "directory" || !rel) continue
        const abs = posix.resolve(from, rel)
        folders.push({ name: posix.basename(abs), path: abs })
      }
      const hidden = (e: DirEntry) => e.name.startsWith(".")
      return folders.sort((a, b) => Number(hidden(a)) - Number(hidden(b)) || a.name.localeCompare(b.name))
    },

    async models() {
      const models: ModelInfo[] = []
      for (const raw of list(await data("GET", "/api/model"))) {
        const m = rec(raw)
        const providerID = str(m.providerID)
        const id = str(m.id)
        if (!providerID || !id || m.enabled === false) continue
        models.push({
          providerID,
          id,
          name: str(m.name) ?? id,
          images: list(rec(m.capabilities).input).includes("image"),
          variants: list(m.variants).flatMap((v) => str(rec(v).id) ?? []),
        })
      }
      return models
    },

    async agents() {
      const agents: AgentInfo[] = []
      for (const raw of list(await data("GET", "/api/agent"))) {
        const a = rec(raw)
        const id = str(a.id)
        if (id && a.mode !== "subagent" && a.hidden !== true) agents.push({ id, name: str(a.name) ?? id })
      }
      return agents
    },

    async mentionAgents() {
      // As OpenCode's own message box: every agent that is not primary-only and not hidden. The
      // wire names an agent by its id (`agents: [{ name: id }]`), so the id is what is kept.
      const agents: MentionOption[] = []
      for (const raw of list(await data("GET", "/api/agent"))) {
        const a = rec(raw)
        const id = str(a.id)
        if (!id || a.mode === "primary" || a.hidden === true) continue
        const description = str(a.description)
        agents.push(defined({ kind: "agent", id, label: str(a.name) ?? id, detail: description && clip(description, DETAIL_MAX_CHARS) }))
      }
      return agents
    },

    async commands(directory) {
      const commands: SlashCommand[] = []
      for (const raw of list(await data("GET", `/api/command?${atLocation(directory)}`))) {
        const c = rec(raw)
        const name = str(c.name)
        if (name) commands.push(defined({ name, description: str(c.description) }))
      }
      return commands
    },

    async skills(directory) {
      // Each skill comes with its whole SKILL.md (`content`); only the name and summary are kept.
      const skills: MentionOption[] = []
      for (const raw of list(await data("GET", `/api/skill?${atLocation(directory)}`))) {
        const s = rec(raw)
        const id = str(s.id)
        if (!id) continue
        const description = str(s.description)
        skills.push(defined({ kind: "skill", id, label: str(s.name) ?? id, detail: description && clip(description, DETAIL_MAX_CHARS) }))
      }
      return skills
    },

    async findFiles(directory, query) {
      // Paths come back relative to the folder asked about; a folder's ends in "/". Best match
      // first, as the server ranks them.
      const q = `query=${encodeURIComponent(query)}&limit=${FIND_LIMIT}&${atLocation(directory)}`
      const found: MentionOption[] = []
      for (const raw of list(await data("GET", `/api/fs/find?${q}`))) {
        const e = rec(raw)
        const kind = e.type === "directory" ? "folder" : e.type === "file" ? "file" : undefined
        const path = str(e.path)?.replace(/\/+$/, "")
        if (!kind || !path) continue
        const cut = path.lastIndexOf("/")
        found.push(defined({ kind, id: path, label: path.slice(cut + 1), detail: cut > 0 ? path.slice(0, cut) : undefined }))
      }
      return found
    },

    async sessions(directory) {
      // `directory` is an exact match. Without `archived` the list has archived sessions too, and
      // without `parentID=null` it has the background children.
      const query = `directory=${encodeURIComponent(directory)}&archived=false&parentID=null&order=desc`
      return list(await data("GET", `/api/session?${query}`)).flatMap((raw) => sessionSummary(raw) ?? [])
    },

    session: (id) => session(id),

    async createSession(input) {
      // No `permissions`: the server's default (the agent's own rules) applies.
      const created = sessionSummary(
        await data("POST", "/api/session", {
          location: { directory: input.directory },
          model: input.model,
          title: input.title,
          parentID: input.parent,
        }),
      )
      if (!created) throw new Error(`${host} doesn't answer like an OpenCode server`)
      return created
    },

    async setModel(id, model) {
      await api("POST", `${sessionPath(id)}/model`, { model })
    },

    async setAgent(id, agent) {
      await api("POST", `${sessionPath(id)}/agent`, { agent })
    },

    messageId: newMessageId,

    async prompt(id, input) {
      // "queue" unless asked otherwise. The server's default, "steer", folds the message into the
      // running turn, and the work before it never gets its own answer. An id must start with
      // "msg_" (400 otherwise) and comes back unchanged, here and in the inbox events.
      const body = { id: input.id, text: input.text, ...attachments(input.text, input.files, input.mentions), delivery: deliveryOf(input.delivery) }
      let sent: Raw
      try {
        sent = rec(await data("POST", `${sessionPath(id)}/prompt`, body))
      } catch (err) {
        // Seen on 2.2.6: sending an id again answers 200 with the message it already has (the
        // new text is ignored, nothing is queued twice), queued, being worked on or long done.
        // Its spec also allows 409 ConflictError for a reused id; both mean "already have it".
        if (input.id && rec(err).status === 409) return { id: input.id }
        throw err
      }
      const message = str(sent.id)
      if (!message) throw new Error(`${host} doesn't answer like an OpenCode server`)
      return { id: message }
    },

    async command(id, input) {
      // Answers 204; an unknown name is a 404 CommandNotFoundError, whose message says so.
      await api("POST", `${sessionPath(id)}/command`, {
        name: input.name,
        text: input.text,
        ...attachments(input.text, input.files, input.mentions),
        delivery: deliveryOf(input.delivery),
      })
    },

    async compact(id, input) {
      // Answers with the inbox item it made. Without `delivery` the server steers: the summary is
      // written at the next step boundary, not after everything that is queued. "Nothing to
      // compact yet" is not an error here: it arrives as session.compaction.failed.
      await api("POST", `${sessionPath(id)}/compact`, input?.delivery ? { delivery: input.delivery } : {})
      // No events for it: the summary is read back once the run has moved past it.
      if (limited) summarising.add(id)
    },

    async lastTurn(id) {
      // The newest page is enough: what is undone is the end of the conversation.
      const [info, page] = await Promise.all([data("GET", sessionPath(id)), data("GET", `${sessionPath(id)}/message?order=desc&limit=${PAGE}`)])
      const boundary = str(rec(rec(info).revert).messageID)
      // Newest first: everything down to the boundary is already undone.
      let undone = !!boundary
      for (const raw of list(page)) {
        const m = rec(raw)
        const message = str(m.id)
        if (undone) {
          if (message === boundary) undone = false
          continue
        }
        const text = str(m.text) ?? ""
        if (m.type === "user" && message && text.trim()) return defined({ id: message, text, note: parseNote(text) })
      }
      return null
    },

    async undo(id, message) {
      // Stages a boundary: the server hides the conversation from `message` on and puts the
      // files its steps changed back (in a git repository). 409 SessionBusyError while it runs.
      await api("POST", `${sessionPath(id)}/revert/stage`, { messageID: message })
      reread(id)
    },

    async redo(id) {
      await api("DELETE", `${sessionPath(id)}/revert`)
      reread(id)
    },

    async rename(id, title) {
      await api("PATCH", sessionPath(id), { title })
    },

    async fork(id) {
      // Without `before` the copy holds the whole history.
      const made = sessionSummary(await data("POST", `${sessionPath(id)}/fork`, {}))
      if (!made) throw new Error(`${host} doesn't answer like an OpenCode server`)
      return made
    },

    async cancelQueued(id, item) {
      // The inbox id is the message id prompt() returned. Cancelling one already delivered is a
      // no-op on the server (204 all the same); the session.inbox.cancelled event is what
      // takes it off the screen.
      await api("DELETE", `${sessionPath(id)}/inbox/${encodeURIComponent(item)}`)
    },

    async waiting(id) {
      // The inbox also holds reminders the server queues for the model (type "synthetic").
      return list(await data("GET", `${sessionPath(id)}/inbox`)).flatMap((raw) => (rec(raw).type === "user" ? (str(rec(raw).id) ?? []) : []))
    },

    // Seen on 2.2.6: this ends the run in progress and nothing else. Messages still queued stay
    // in the inbox, untouched and without any event, and the session goes idle with them in it
    // (20 s watched). They are delivered when the next prompt arrives, ahead of it: any POST to
    // /prompt wakes the queue, even a repeat of an id the server already has.
    async stop(id) {
      await api("POST", `${sessionPath(id)}/interrupt`)
    },

    async running(directory) {
      const res = rec(await api("GET", `/api/shell?${atLocation(directory)}`))
      const out: RunningCommand[] = []
      for (const raw of list(res.data)) {
        const s = rec(raw)
        const id = str(s.id)
        if (!id || str(s.status) !== "running") continue
        out.push({ id, directory, command: (str(s.command) ?? "").replace(/\s+/g, " ").trim().slice(0, 300), started: num(rec(s.time).started) ?? 0 })
      }
      return out
    },
    async kill(directory, id) {
      await api("DELETE", `/api/shell/${encodeURIComponent(id)}?${atLocation(directory)}`)
    },

    async transcript(id) {
      // The queue is read before the messages. A message delivered in between then shows up in
      // both (and is dropped from the queue's half); read the other way round it would be in
      // neither.
      const [info, inbox, permissions, forms] = await Promise.all([
        data("GET", sessionPath(id)),
        data("GET", `${sessionPath(id)}/inbox`),
        data("GET", `${sessionPath(id)}/permission`),
        data("GET", `${sessionPath(id)}/form`),
      ])
      const messages: unknown[] = []
      let query = `order=asc&limit=${PAGE}`
      for (;;) {
        const page = rec(await api("GET", `${sessionPath(id)}/message?${query}`))
        const batch = list(page.data)
        messages.push(...batch)
        // `cursor.next` is set even on the last page, so a short page is the cheaper end test.
        // A cursor carries the order with it; sending `order` again is an error.
        const next = str(rec(page.cursor).next)
        if (batch.length < PAGE || !next) break
        query = `cursor=${encodeURIComponent(next)}&limit=${PAGE}`
      }
      return {
        items: chatItems(messages, list(inbox), str(rec(rec(info).location).directory), warn, str(rec(rec(info).revert).messageID)),
        permissions: list(permissions).flatMap((raw) => permissionAsk(raw) ?? []),
        questions: list(forms).flatMap((raw) => question(raw, warn) ?? []),
      }
    },

    async replyPermission(id, request, decision) {
      await api("POST", `${sessionPath(id)}/permission/${encodeURIComponent(request)}/reply`, { decision })
    },

    async answerQuestion(id, form, answer) {
      await api("POST", `${sessionPath(id)}/form/${encodeURIComponent(form)}/reply`, { answer })
    },

    async dismissQuestion(id, form) {
      await api("DELETE", `${sessionPath(id)}/form/${encodeURIComponent(form)}`)
    },

    listen(on) {
      const stop = new AbortController()
      const emit = (event: BackendEvent) => {
        if (stop.signal.aborted) return
        try {
          on(event)
        } catch (err) {
          // A listener that throws must not look like a broken connection.
          log("error", "The event listener threw", err)
        }
      }

      /** session id → whether it changed again while its re-read was under way. One read at a
       *  time per session, so an older answer can never overwrite a newer one. */
      const reading = new Map<string, boolean>()
      async function refresh(id: string) {
        if (reading.has(id)) return void reading.set(id, true)
        try {
          do {
            reading.set(id, false)
            const summary = await session(id, stop.signal)
            emit(summary ? { type: "session", session: summary } : { type: "session-gone", session: id })
          } while (reading.get(id))
        } catch (err) {
          if (!stop.signal.aborted) log("warn", "Could not re-read a session", err instanceof Error ? err.message : err)
        } finally {
          reading.delete(id)
        }
      }

      live = { emit, refresh: (id) => void refresh(id) }
      stop.signal.addEventListener("abort", () => (live = undefined))
      const subscribe = (names: string[], signal: AbortSignal) =>
        send("GET", `/api/event?${names.map((t) => `types=${t}`).join("&")}`, undefined, signal, "text/event-stream")

      void (async () => {
        let delay = timing.retryMin
        let connectedBefore = false
        emit({ type: "connection", state: { status: "connecting", url: opts.url } })
        while (!stop.signal.aborted) {
          const conn = new AbortController()
          const abort = () => conn.abort()
          stop.signal.addEventListener("abort", abort)
          let stalled = false
          let open = false
          let watchdog: ReturnType<typeof setTimeout> | undefined
          const alive = () => {
            clearTimeout(watchdog)
            watchdog = setTimeout(() => {
              stalled = true
              conn.abort()
            }, timing.watchdog)
          }
          alive()
          let error = `Lost the connection to ${host}`
          try {
            // Asked first for the version, and because its errors are the clear ones.
            const { version } = await info(conn.signal)
            let res: Response
            try {
              res = await subscribe(limited ? EVENT_TYPES : [...EVENT_TYPES, ...OPTIONAL_EVENT_TYPES], conn.signal)
            } catch (err) {
              // A 400 is the server not knowing a name in the filter, and it refuses the whole
              // stream for it. Only the optional names can be new to it: go on without them,
              // from now on. Anything else (the password, the network) is not about the filter.
              if (limited || rec(err).status !== 400) throw err
              limited = true
              log("warn", `${host} does not send the events for summaries and undo (an older server?). Going on without them: those are read back instead.`, err instanceof Error ? err.message : err)
              res = await subscribe(EVENT_TYPES, conn.signal)
            }
            if (!res.body) throw new Error(`${host} doesn't answer like an OpenCode server`)
            open = true
            delay = timing.retryMin
            emit({ type: "connection", state: { status: "online", url: opts.url, version } })
            // The stream has no replay: whatever happened while it was down is gone.
            if (connectedBefore) emit({ type: "resync" })
            connectedBefore = true
            const map = createEventMapper(emit, warn)
            await readEvents(
              res.body,
              alive,
              (raw) => {
                map(raw)
                const type = str(rec(raw).type)
                const id = str(rec(rec(raw).data).sessionID)
                if (type && id && SUMMARY_EVENTS.has(type)) void refresh(id)
                if (type && id && AFTER_SUMMARY.has(type) && summarising.delete(id)) emit({ type: "resync", session: id })
              },
              warn,
            )
          } catch (err) {
            // Once open, the reason a read failed is plumbing ("terminated"); say what it means.
            if (!open && err instanceof Error) error = err.message
          } finally {
            clearTimeout(watchdog)
            stop.signal.removeEventListener("abort", abort)
            conn.abort()
          }
          if (stop.signal.aborted) return
          if (stalled) error = `No data from ${host} for ${Math.round(timing.watchdog / 1000)} s`
          emit({ type: "connection", state: { status: "offline", url: opts.url, error } })
          await sleep(delay, stop.signal)
          delay = Math.min(delay * 2, timing.retryMax)
        }
      })()

      return () => stop.abort()
    },
  }
}
