// Tests for main/acp.ts against a fake ACP agent (test/fake-agent.ts: the SDK's agent side over
// streams in memory). What the reviewer at the screen must see: the chat as it streams and as it
// reads back after the agent is started again, a permission answered, the queue and its cancel,
// Stop, and an agent whose process ends with work in flight. Then the local parts: folders,
// files for `@`, the repo's state, and the patch of an edit.
import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cmdLine, createAcp, needsSignIn, timing, toolPart, type AcpOptions } from "../src/main/acp"
import { splitCommand } from "../src/main/agents"
import { thisMachine, type Machine, type Reach } from "../src/main/machine"
import { unifiedPatch } from "../src/main/patch"
import type { BackendEvent, ChatEvent, ChatItem } from "../src/shared/types"
import { RequestError } from "@agentclientprotocol/sdk/unstable"
import { fakeAgent, type FakeAgent } from "./fake-agent"

timing.retryMin = 20
timing.retryMax = 50
timing.save = 0

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "b42-acp-"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(5)
  }
}

/** Applies a ChatEvent the way its contract in shared/types.ts says a consumer must. */
function applyChat(items: ChatItem[], event: ChatEvent) {
  if (event.type === "reset") return void items.splice(0, items.length, ...event.items)
  if (event.type === "remove") {
    const at = items.findIndex((i) => i.id === event.item)
    if (at >= 0) items.splice(at, 1)
    return
  }
  if (event.type === "delivered") {
    const at = items.findIndex((i) => i.id === event.item)
    if (at < 0) return
    const [item] = items.splice(at, 1) as [Extract<ChatItem, { kind: "user" }>]
    delete item.pending
    item.time = event.time
    return void items.push(item)
  }
  if (event.type === "item") {
    const at = items.findIndex((i) => i.id === event.item.id)
    items[at < 0 ? items.length : at] = structuredClone(event.item)
    return
  }
  const item = items.find((i) => i.id === event.item)
  if (item?.kind !== "assistant") return
  if (event.type === "part") {
    const at = item.parts.findIndex((p) => p.key === event.part.key)
    item.parts[at < 0 ? item.parts.length : at] = structuredClone(event.part)
    return
  }
  const part = item.parts.find((p) => p.key === event.key)
  if (part && part.kind !== "tool") part.text += event.text
}

function setup(fake: FakeAgent = fakeAgent(), stateDir?: string, beforeTurn?: (session: string) => Promise<unknown> | undefined, extra: Partial<AcpOptions> = {}) {
  const backend = createAcp({ id: "fake", name: "Fake Agent", command: ["fake"], connect: () => fake.connect(), ...(stateDir ? { stateDir } : {}), ...(beforeTurn ? { beforeTurn } : {}), ...extra })
  const events: BackendEvent[] = []
  const items: ChatItem[] = []
  const stop = backend.listen((e) => {
    events.push(e)
    if (e.type === "chat") applyChat(items, e.event)
  })
  stops.push(stop)
  return { backend, fake, events, items, stop }
}

const of = <T extends BackendEvent["type"]>(events: BackendEvent[], type: T) => events.filter((e): e is Extract<BackendEvent, { type: T }> => e.type === type)

test("streaming: a turn's words, thinking and tools show as they come, and the run ends once the queue is dry", async () => {
  const { backend, fake, events, items } = setup()
  fake.onPrompt = async (turn) => {
    await turn.say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me " }, messageId: "r1" })
    await turn.say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "look." }, messageId: "r1" })
    await turn.say({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal", kind: "execute", status: "pending", rawInput: {} })
    await turn.say({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", rawInput: { command: "npm test\nmore" } })
    await turn.say({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "1 passing" } }] })
    await turn.say({ sessionUpdate: "tool_call", toolCallId: "t2", title: "write", kind: "edit", status: "completed", locations: [{ path: "/repo/src/a.css" }], content: [{ type: "diff", path: "/repo/src/a.css", oldText: "a {}\n", newText: "a { color: red }\n" }] })
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Do" }, messageId: "m1" })
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ne." }, messageId: "m1" })
    await turn.say({ sessionUpdate: "usage_update", used: 1200, size: 200000 })
  }
  const s = await backend.createSession({ directory: "/repo", title: "site · new" })
  assert.equal(s.directory, "/repo")
  assert.equal(s.title, "site · new")
  const { id } = await backend.prompt(s.id, { id: "msg_1", text: "UI review note 1 on http://x/\nNote: make it red" })
  assert.equal(id, "msg_1")
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
  const inbox = of(events, "inbox").map((e) => e.status)
  assert.deepEqual(inbox, ["queued", "working"])
  assert.deepEqual(of(events, "run").map((e) => e.status), ["started", "succeeded"])
  assert.deepEqual(of(events, "context").at(-1), { type: "context", session: s.id, context: { used: 1200, limit: 200000 } })
  // The note's own words, as the chat shows a note.
  const user = items[0]
  assert.equal(user?.kind, "user")
  assert.deepEqual(user?.kind === "user" && user.note, { n: 1, text: "make it red" })
  const reply = items[1]
  assert.equal(reply?.kind, "assistant")
  if (reply?.kind !== "assistant") return
  assert.equal(reply.done, true)
  assert.deepEqual(
    reply.parts.map((p) => [p.kind, p.key, p.kind === "tool" ? `${p.name}: ${p.title} (${p.status})` : p.text]),
    [
      ["reasoning", "reasoning:0", "Let me look."],
      ["tool", "t1", "shell: npm test (done)"],
      ["tool", "t2", "edit: edit src/a.css (done)"],
      ["text", "text:0", "Done."],
    ],
  )
  const edit = reply.parts[2]
  assert.ok(edit?.kind === "tool" && edit.changes?.[0]?.file === "src/a.css" && edit.changes[0].additions === 1 && edit.changes[0].deletions === 1)
  // Deltas went out as deltas, not as the whole text again.
  assert.ok(events.some((e) => e.type === "chat" && e.event.type === "delta" && e.event.text === "ne."))
  // What a re-read gives is what the stream built.
  assert.deepEqual((await backend.transcript(s.id)).items, items)
})

test("transcript after the agent is started again: session/load's replay gives the same items, ids and keys as the stream", async () => {
  const dir = tmp()
  const fake = fakeAgent()
  fake.onPrompt = async (turn) => {
    await turn.say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm, " }, messageId: "r" })
    await turn.say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ok." }, messageId: "r" })
    await turn.say({ sessionUpdate: "tool_call", toolCallId: `t-${turn.text.length}`, title: "Read a.css", kind: "read", status: "pending", locations: [{ path: "/repo/a.css" }] })
    await turn.say({ sessionUpdate: "tool_call_update", toolCallId: `t-${turn.text.length}`, status: "completed", content: [{ type: "content", content: { type: "text", text: "a {}" } }] })
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer " }, messageId: `m-${turn.text}` })
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "to " + turn.text }, messageId: `m-${turn.text}` })
  }
  const first = setup(fake, dir)
  const s = await first.backend.createSession({ directory: "/repo" })
  await first.backend.prompt(s.id, { id: "msg_a", text: "first" })
  await first.backend.prompt(s.id, { id: "msg_b", text: "Get this project's site running so I can review it in Bicycle42.\n\nmore" })
  await until(() => of(first.events, "run").some((e) => e.status === "succeeded"))
  const streamed = structuredClone(first.items)
  assert.equal(streamed.length, 4)
  first.stop()

  // A new process, as after a restart of the app: the ledger on disk gives the messages their ids.
  const again = setup(fake, dir)
  const read = await again.backend.transcript(s.id)
  assert.deepEqual(read.items, streamed)
  const ask = read.items[2]
  assert.deepEqual(ask?.kind === "user" && ask.ask, { title: "Get the site running" })
  assert.equal(fake.calls.filter((c) => c.method === "session/load").length, 1)
  // Read once per process: the second look is the model kept here.
  await again.backend.transcript(s.id)
  assert.equal(fake.calls.filter((c) => c.method === "session/load").length, 1)
})

test("permission: the agent's request is a card with what it acts on, and the answer goes back as the option it named", async () => {
  const { backend, fake, events } = setup()
  let answer: unknown
  fake.onPrompt = async (turn) => {
    await turn.say({ sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit a.css", kind: "edit", status: "pending", locations: [{ path: "/repo/a.css" }] })
    answer = await turn.ask({
      toolCall: { toolCallId: "e1", content: [{ type: "diff", path: "/repo/a.css", oldText: "a\n", newText: "b\n" }] },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    })
  }
  const s = await backend.createSession({ directory: "/repo" })
  await backend.prompt(s.id, { text: "edit" })
  await until(() => of(events, "permission").length > 0)
  const ask = of(events, "permission")[0]!.ask
  assert.equal(ask.session, s.id)
  assert.equal(ask.action, "edit")
  assert.deepEqual(ask.resources, ["/repo/a.css"])
  assert.equal(ask.message, "Edit a.css")
  assert.equal(ask.changes?.[0]?.file, "a.css")
  assert.match(ask.changes?.[0]?.patch ?? "", /-a\n\+b/)
  assert.deepEqual((await backend.transcript(s.id)).permissions.map((p) => p.id), [ask.id])
  await backend.replyPermission(s.id, ask.id, "always")
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
  assert.deepEqual(answer, { outcome: { outcome: "selected", optionId: "always" } })
  assert.deepEqual(of(events, "permission-done").map((e) => e.id), [ask.id])
  await assert.rejects(backend.replyPermission(s.id, ask.id, "once"), /no longer waiting/)
})

test("queue: what is sent while the agent works waits here, can be cancelled, and goes in order; a repeated id is not queued twice", async () => {
  const { backend, fake, events, items } = setup()
  const gates: (() => void)[] = []
  fake.onPrompt = async (turn) => {
    await new Promise<void>((resolve) => gates.push(resolve))
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `re ${turn.text}` } })
  }
  const s = await backend.createSession({ directory: "/repo" })
  await backend.prompt(s.id, { id: "m1", text: "one" })
  await until(() => gates.length === 1)
  await backend.prompt(s.id, { id: "m2", text: "two" })
  await backend.prompt(s.id, { id: "m3", text: "three" })
  await backend.prompt(s.id, { id: "m3", text: "three again" })
  assert.deepEqual(await backend.waiting(s.id), ["m2", "m3"])
  assert.deepEqual(items.filter((i) => i.kind === "user" && i.pending).map((i) => i.id), ["m2", "m3"])
  await backend.cancelQueued(s.id, "m2")
  assert.deepEqual(await backend.waiting(s.id), ["m3"])
  assert.ok(of(events, "inbox").some((e) => e.id === "m2" && e.status === "cancelled"))
  assert.ok(!items.some((i) => i.id === "m2"))
  gates.shift()!()
  await until(() => gates.length === 1)
  assert.deepEqual(of(events, "inbox").filter((e) => e.status === "working").map((e) => e.id), ["m1", "m3"])
  gates.shift()!()
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
  // One run: it started once, and ended when the queue was dry.
  assert.deepEqual(of(events, "run").map((e) => e.status), ["started", "succeeded"])
  assert.deepEqual(fake.calls.filter((c) => c.method === "session/prompt").length, 2)
  assert.deepEqual(items.map((i) => i.id), ["m1", "a_m1", "m3", "a_m3"])
})

test("stop: the turn is cancelled, says Stopped, and what waits stays until something is sent again", async () => {
  const { backend, fake, events, items } = setup()
  fake.onPrompt = async (turn) => {
    if (turn.text === "long") {
      await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } })
      await turn.cancelled
      return "cancelled"
    }
  }
  const s = await backend.createSession({ directory: "/repo" })
  assert.equal(await backend.stop(s.id), false)
  await backend.prompt(s.id, { id: "m1", text: "long" })
  await backend.prompt(s.id, { id: "m2", text: "after" })
  await until(() => items.some((i) => i.kind === "assistant"))
  assert.equal(await backend.stop(s.id), true)
  await until(() => of(events, "run").some((e) => e.status === "interrupted"))
  assert.ok(fake.calls.some((c) => c.method === "session/cancel"))
  assert.ok(items.some((i) => i.kind === "marker" && i.text === "Stopped"))
  assert.equal((await backend.session(s.id))?.busy, false)
  await sleep(30)
  assert.deepEqual(await backend.waiting(s.id), ["m2"])
  assert.equal(fake.calls.filter((c) => c.method === "session/prompt").length, 1)
  // The next message wakes the queue: what waited goes first.
  await backend.prompt(s.id, { id: "m3", text: "next" })
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
  assert.deepEqual(of(events, "inbox").filter((e) => e.status === "working").map((e) => e.id), ["m1", "m2", "m3"])
})

test("before a turn: the message waits for the controller's snapshot after its turn is announced; a Stop meanwhile sends nothing", async () => {
  let release!: () => void
  const asked: string[] = []
  const { backend, fake, events } = setup(fakeAgent(), undefined, (session) => {
    asked.push(session)
    return new Promise<void>((r) => (release = r))
  })
  const s = await backend.createSession({ directory: "/repo" })
  await backend.prompt(s.id, { id: "m1", text: "first" })
  await until(() => asked.length === 1)
  // Announced, so the controller has started its snapshot; not yet sent.
  assert.ok(of(events, "inbox").some((e) => e.id === "m1" && e.status === "working"))
  await sleep(30)
  assert.equal(fake.calls.filter((c) => c.method === "session/prompt").length, 0)
  release()
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
  assert.equal(fake.calls.filter((c) => c.method === "session/prompt").length, 1)
  // Stopped while the snapshot is taken: the message never reaches the agent.
  await backend.prompt(s.id, { id: "m2", text: "second" })
  await until(() => asked.length === 2)
  assert.equal(await backend.stop(s.id), true)
  release()
  await until(() => of(events, "run").some((e) => e.status === "interrupted"))
  await sleep(30)
  assert.equal(fake.calls.filter((c) => c.method === "session/prompt").length, 1)
})

test("steer: a message joins the turn under way when the agent offers it; without a turn it is queued", async () => {
  const { backend, fake, events, items } = setup()
  let release!: () => void
  fake.onPrompt = async (turn) => {
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } })
    await new Promise<void>((r) => (release = r))
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } })
  }
  const s = await backend.createSession({ directory: "/repo" })
  assert.equal(backend.can.steer, true)
  await backend.prompt(s.id, { id: "m1", text: "go" })
  await until(() => items.some((i) => i.kind === "assistant"))
  await backend.prompt(s.id, { id: "m2", text: "also this", delivery: "steer" })
  assert.equal(fake.steered.length, 1)
  assert.deepEqual(fake.steered[0]?._meta, { steering: { idleBehavior: "promptRequired" } })
  assert.deepEqual(await backend.waiting(s.id), [])
  release()
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
  assert.deepEqual(items.map((i) => i.id), ["m1", "a_m1", "m2", "a_m2"])
  assert.ok(!of(events, "inbox").some((e) => e.id === "m2"))
  // The agent's turn had ended: it said so, and the message went as a prompt of its own.
  fake.steerOutcome = "promptRequired"
  fake.onPrompt = async () => {
    await new Promise<void>((r) => (release = r))
  }
  await backend.prompt(s.id, { id: "m3", text: "x" })
  await until(() => of(events, "inbox").some((e) => e.id === "m3" && e.status === "working"))
  await backend.prompt(s.id, { id: "m4", text: "y", delivery: "steer" })
  assert.deepEqual(await backend.waiting(s.id), ["m4"])
  release()
})

test("the agent's process ends with work in flight: the message under way fails, what waits is cancelled, the agent is started again", async () => {
  const dir = tmp()
  const { backend, fake, events, items } = setup(fakeAgent(), dir)
  fake.onPrompt = () => new Promise(() => {})
  const s = await backend.createSession({ directory: "/repo" })
  await backend.prompt(s.id, { id: "m1", text: "a" })
  await backend.prompt(s.id, { id: "m2", text: "b" })
  // (The agent has the message: one it never got is not in its history, and so not in a re-read.)
  await until(() => fake.calls.some((c) => c.method === "session/prompt"))
  fake.exit("it exited with code 1")
  await until(() => of(events, "run").some((e) => e.status === "failed"))
  const failed = of(events, "run").find((e) => e.status === "failed")!
  assert.match(failed.error ?? "", /^Fake Agent stopped: it exited with code 1/)
  assert.ok(of(events, "inbox").some((e) => e.id === "m2" && e.status === "cancelled"))
  assert.ok(items.some((i) => i.kind === "marker" && i.failed && /Fake Agent stopped/.test(i.text)))
  assert.ok(of(events, "connection").some((e) => e.state.status === "offline"))
  assert.equal((await backend.session(s.id))?.busy, false)
  // Started again by itself: online, and the screen is told to read again.
  await until(() => fake.starts === 2 && of(events, "resync").length > 0)
  assert.equal(of(events, "connection").at(-1)?.state.status, "online")
  // The conversation is loaded into the new process when it is next used, and its history is there.
  fake.onPrompt = async (turn) => turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "back" } })
  await backend.prompt(s.id, { id: "m3", text: "c" })
  await until(() => of(events, "run").filter((e) => e.status === "succeeded").length === 1)
  const read = await backend.transcript(s.id)
  assert.deepEqual(read.items.filter((i) => i.kind === "user").map((i) => i.id), ["m1", "m3"])
  // The failure's line is still there after the reload: the ledger keeps it.
  assert.ok(read.items.some((i) => i.id === "end_m1" && i.kind === "marker" && i.failed))
})

test("quit with work in flight: next time, what was lost is said once, so its note can be retried", async () => {
  const dir = tmp()
  const fake = fakeAgent()
  fake.onPrompt = () => new Promise(() => {})
  const first = setup(fake, dir)
  const s = await first.backend.createSession({ directory: "/repo" })
  await first.backend.prompt(s.id, { id: "m1", text: "a" })
  await first.backend.prompt(s.id, { id: "m2", text: "b" })
  await until(() => of(first.events, "inbox").some((e) => e.status === "working"))
  first.stop()
  const again = setup(fake, dir)
  assert.deepEqual(again.backend.lost(s.id), ["m1", "m2"])
  assert.deepEqual(again.backend.lost(s.id), [])
  assert.deepEqual(await again.backend.waiting(s.id), [])
})

test("the app ended without a word (a crash, a kill): next time what was with the agent or waiting is lost, said once, and its turn reads failed", async () => {
  const dir = tmp()
  const fake = fakeAgent()
  fake.onPrompt = () => new Promise(() => {})
  const first = setup(fake, dir)
  const s = await first.backend.createSession({ directory: "/repo" })
  await first.backend.prompt(s.id, { id: "m1", text: "a" })
  await first.backend.prompt(s.id, { id: "m2", text: "b" })
  await until(() => of(first.events, "inbox").some((e) => e.id === "m1" && e.status === "working"))
  await sleep(20)
  // No stop(): the ledger is read as the app's crash left it.
  const again = setup(fake, dir)
  assert.deepEqual(again.backend.lost(s.id), ["m2", "m1"])
  assert.deepEqual(again.backend.lost(s.id), [])
  assert.equal((await again.backend.session(s.id))?.busy, false)
  assert.deepEqual(await again.backend.waiting(s.id), [])
  const read = await again.backend.transcript(s.id)
  assert.ok(read.items.some((i) => i.id === "end_m1" && i.kind === "marker" && i.failed), JSON.stringify(read.items))
})

test("a retry under an id the agent had: one that never finished goes again; one that was answered says so, and is not sent twice", async () => {
  const dir = tmp()
  const fake = fakeAgent()
  fake.onPrompt = () => new Promise(() => {})
  const first = setup(fake, dir)
  const s = await first.backend.createSession({ directory: "/repo" })
  await first.backend.prompt(s.id, { id: "m1", text: "a" })
  await until(() => fake.calls.some((c) => c.method === "session/prompt"))
  await sleep(20)
  // The app crashed with m1 under way; the outbox sends it again under its id.
  const again = setup(fake, dir)
  fake.onPrompt = async (turn) => turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } })
  assert.deepEqual(await again.backend.prompt(s.id, { id: "m1", text: "a" }), { id: "m1" })
  await until(() => of(again.events, "run").some((e) => e.status === "succeeded"))
  assert.deepEqual(of(again.events, "inbox").map((e) => `${e.id}:${e.status}`), ["m1:queued", "m1:working"])
  assert.equal(fake.calls.filter((c) => c.method === "session/prompt").length, 2)
  // It is no longer lost: a settle after this does not call it stopped.
  assert.deepEqual(again.backend.lost(s.id), [])
  // The same id again, answered this time: its run is said as it went, and nothing is sent.
  const before = again.events.length
  await again.backend.prompt(s.id, { id: "m1", text: "a" })
  const said = again.events.slice(before).filter((e) => e.type === "run" || e.type === "inbox").map((e) => (e.type === "run" ? `run:${e.status}` : `${e.id}:${e.status}`))
  assert.deepEqual(said, ["run:started", "m1:working", "run:succeeded"])
  await sleep(20)
  assert.equal(fake.calls.filter((c) => c.method === "session/prompt").length, 2)
  // The re-read has both tries, the first with its failure.
  const read = await again.backend.transcript(s.id)
  assert.deepEqual(read.items.filter((i) => i.kind === "user").map((i) => i.id), ["m1~1", "m1"])
  assert.ok(read.items.some((i) => i.id === "end_m1~1" && i.kind === "marker" && i.failed))
})

test("the process ends while a conversation is read into it: what waits is cancelled and the run fails, never left working", async () => {
  const { backend, fake, events } = setup()
  const s = await backend.createSession({ directory: "/repo" })
  fake.exit()
  await until(() => fake.starts === 2 && of(events, "connection").at(-1)?.state.status === "online")
  let release!: () => void
  fake.onLoad = () => new Promise<void>((r) => (release = r))
  // The exit is seen before the process's output closes, and the load's answer still comes.
  fake.holdStreams = true
  await backend.prompt(s.id, { id: "m1", text: "a" })
  await until(() => !!release)
  fake.exit()
  await until(() => of(events, "connection").at(-1)?.state.status === "offline")
  release()
  await until(() => of(events, "run").some((e) => e.status === "failed"))
  assert.ok(of(events, "inbox").some((e) => e.id === "m1" && e.status === "cancelled"))
  assert.ok(!of(events, "inbox").some((e) => e.id === "m1" && e.status === "working"))
  // The queue is not blocked: the next message goes in the next process.
  fake.holdStreams = false
  fake.onLoad = undefined
  await until(() => of(events, "connection").at(-1)?.state.status === "online")
  await backend.prompt(s.id, { id: "m2", text: "b" })
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
})

test("a conversation that can't be read into the agent: the message fails with the reason, and the run ends", async () => {
  const { backend, fake, events, items } = setup()
  const s = await backend.createSession({ directory: "/repo" })
  fake.exit()
  await until(() => fake.starts === 2 && of(events, "connection").at(-1)?.state.status === "online")
  fake.onLoad = async () => {
    throw new Error("disk full")
  }
  await backend.prompt(s.id, { id: "m1", text: "a" })
  await until(() => of(events, "run").some((e) => e.status === "failed"))
  assert.match(of(events, "run").find((e) => e.status === "failed")?.error ?? "", /disk full/)
  assert.ok(of(events, "inbox").some((e) => e.id === "m1" && e.status === "cancelled"))
  assert.ok(items.some((i) => i.kind === "marker" && i.failed && /disk full/.test(i.text)))
})

test("an agent that dies just after it starts: started again with a growing pause, then left offline for Retry", async () => {
  const fake = fakeAgent()
  fake.dieAfterInit = true
  const crashes = timing.crashes
  timing.crashes = 4
  try {
    const { events } = setup(fake)
    await until(() => fake.starts === 4 && of(events, "connection").at(-1)?.state.status === "offline")
    await sleep(300)
    assert.equal(fake.starts, 4)
    // Each time but the last it is started again by itself, and says so; the last time it is not.
    const offline = of(events, "connection").flatMap((e) => (e.state.status === "offline" ? [e.state] : []))
    assert.deepEqual(offline.map((o) => !!o.retry), [true, true, true, false])
    const last = of(events, "connection").at(-1)!.state
    assert.equal(last.status === "offline" ? last.error : "", "Fake Agent keeps stopping at start: it exited with code 1.")
  } finally {
    timing.crashes = crashes
  }
})

test("an agent that stops at start for want of a sign-in: the connection says so, with the agent's sign-in command", async () => {
  const crashes = timing.crashes
  timing.crashes = 2
  try {
    // A known agent: the command it is signed in with is given.
    const fake = fakeAgent()
    fake.dieAfterInit = "it exited with code 1 (Invalid API key · Please run /login)"
    const { events } = setup(fake, undefined, undefined, { signIn: "fake login" })
    await until(() => fake.starts === 2 && of(events, "connection").at(-1)?.state.status === "offline")
    const offline = of(events, "connection").flatMap((e) => (e.state.status === "offline" ? [e.state] : []))
    // Each time: the one started again by itself and the one left for Retry.
    assert.deepEqual(offline.map((o) => [!!o.retry, o.signIn]), [[true, { command: "fake login" }], [false, { command: "fake login" }]])
    // Another agent: the same, with no command to give.
    const other = fakeAgent()
    other.dieAfterInit = "it exited with code 1 (Error: not logged in)"
    const two = setup(other)
    await until(() => other.starts === 2 && of(two.events, "connection").at(-1)?.state.status === "offline")
    const last = of(two.events, "connection").at(-1)!.state
    assert.deepEqual(last.status === "offline" && last.signIn, {})
    // Not a sign-in: nothing said of one.
    const plain = fakeAgent()
    plain.dieAfterInit = true
    const three = setup(plain, undefined, undefined, { signIn: "fake login" })
    await until(() => plain.starts === 2 && of(three.events, "connection").at(-1)?.state.status === "offline")
    assert.ok(of(three.events, "connection").every((e) => e.state.status !== "offline" || e.state.signIn === undefined))
  } finally {
    timing.crashes = crashes
  }
})

test("stop, with an agent that ignores it: the turn ends as stopped after a while, and its process is ended and started again", async () => {
  const fake = fakeAgent()
  fake.ignoreCancel = true
  fake.onPrompt = () => new Promise(() => {})
  const grace = timing.stopGrace
  timing.stopGrace = 50
  try {
    const { backend, events, items } = setup(fake)
    const s = await backend.createSession({ directory: "/repo" })
    await backend.prompt(s.id, { id: "m1", text: "long" })
    await until(() => fake.calls.some((c) => c.method === "session/prompt"))
    assert.equal(await backend.stop(s.id), true)
    await until(() => of(events, "run").some((e) => e.status === "interrupted"))
    assert.ok(items.some((i) => i.kind === "marker" && i.text === "Stopped"))
    assert.ok(!of(events, "run").some((e) => e.status === "failed"))
    await until(() => fake.starts === 2 && of(events, "connection").at(-1)?.state.status === "online")
    assert.equal((await backend.session(s.id))?.busy, false)
  } finally {
    timing.stopGrace = grace
  }
})

/** This computer, as another one would be: the test says whether it can be reached. */
function awayMachine() {
  let reach: Reach = { status: "up" }
  const listeners = new Set<(r: Reach) => void>()
  const machine: Machine = Object.assign(Object.create(thisMachine()) as Machine, {
    where: "dev-box",
    local: false,
    reach: () => reach,
    onReach: (l: (r: Reach) => void) => (listeners.add(l), () => void listeners.delete(l)),
  })
  return {
    machine,
    set(status: "up" | "down") {
      reach = status === "up" ? { status } : { status, error: "Can't reach dev-box." }
      for (const l of [...listeners]) l(reach)
    },
  }
}

test("stop while the agent's computer can't be reached: the agent is not ended for it; the wait for it to stop starts once it is back", async () => {
  const fake = fakeAgent()
  fake.ignoreCancel = true
  fake.onPrompt = () => new Promise(() => {})
  const away = awayMachine()
  const grace = timing.stopGrace
  timing.stopGrace = 80
  try {
    const { backend, events } = setup(fake, undefined, undefined, { machine: away.machine })
    const s = await backend.createSession({ directory: "/repo" })
    await backend.prompt(s.id, { id: "m1", text: "long" })
    await until(() => fake.calls.some((c) => c.method === "session/prompt"))
    away.set("down")
    assert.equal(await backend.stop(s.id), true)
    await sleep(300)
    assert.ok(!of(events, "run").some((e) => e.status === "interrupted"), "not ended while away")
    assert.equal(fake.starts, 1)
    away.set("up")
    await until(() => of(events, "run").some((e) => e.status === "interrupted"))
    await until(() => fake.starts === 2)
  } finally {
    timing.stopGrace = grace
  }
})

test("a request in flight when the agent's computer can't be reached does not time out while it is away: only the time it can be reached counts", async () => {
  const fake = fakeAgent()
  const away = awayMachine()
  const start = timing.start
  try {
    const dir = tmp()
    const first = setup(fake, dir)
    const s = await first.backend.createSession({ directory: "/repo" })
    first.stop()
    timing.start = 150
    let answer!: () => void
    fake.onLoad = () => new Promise<void>((r) => (answer = r))
    const { backend } = setup(fake, dir, undefined, { machine: away.machine })
    const read = backend.transcript(s.id)
    let failed: unknown
    read.catch((err) => (failed = err))
    await until(() => fake.calls.some((c) => c.method === "session/load"))
    away.set("down")
    await sleep(400)
    away.set("up")
    await sleep(50)
    answer()
    await read
    assert.equal(failed, undefined)
  } finally {
    timing.start = start
  }
})

test("some of the agent's output was lost during a run (its computer away too long): the run fails saying so, the agent is asked to stop it, and the conversation is read again", async () => {
  const fake = fakeAgent()
  // Its answer is among what was lost: it never comes.
  fake.onPrompt = () => new Promise(() => {})
  let gap: (() => void) | undefined
  const { backend, events } = setup(fake, undefined, undefined, { connect: () => ({ ...fake.connect(), onGap: (l: () => void) => void (gap = l) }) })
  const s = await backend.createSession({ directory: "/repo" })
  await backend.prompt(s.id, { id: "m1", text: "long" })
  await until(() => fake.calls.some((c) => c.method === "session/prompt"))
  gap!()
  await until(() => of(events, "run").some((e) => e.status === "failed"))
  assert.match(of(events, "run").find((e) => e.status === "failed")!.error ?? "", /was lost while .* could not be reached/)
  await until(() => fake.calls.some((c) => c.method === "session/cancel"))
  await until(() => of(events, "resync").some((e) => e.session === s.id))
  assert.equal((await backend.session(s.id))?.busy, false)
})

test("before a turn, too slow or failed: the message goes anyway, and the controller is told the turn's before is not to be trusted", async () => {
  const untrusted: string[] = []
  let sent = 0
  const answers: (() => Promise<unknown>)[] = [() => new Promise(() => {}), () => Promise.reject(new Error("no space")), () => Promise.resolve()]
  const wait = timing.beforeTurn
  timing.beforeTurn = 50
  try {
    const { backend, fake, events } = setup(fakeAgent(), undefined, () => answers[sent++]!(), {
      turnUntrusted: (session) => untrusted.push(`${session}@${fake.calls.filter((c) => c.method === "session/prompt").length}`),
    })
    const s = await backend.createSession({ directory: "/repo" })
    for (const [i, id] of ["m1", "m2", "m3"].entries()) {
      await backend.prompt(s.id, { id, text: id })
      await until(() => of(events, "run").filter((e) => e.status === "succeeded").length === i + 1)
    }
    // Told right before the message went (no prompt of it yet), once each for the late and the failed one.
    assert.deepEqual(untrusted, [`${s.id}@0`, `${s.id}@1`])
    assert.equal(fake.calls.filter((c) => c.method === "session/prompt").length, 3)
  } finally {
    timing.beforeTurn = wait
  }
})

test("an agent process that crashes takes what it started with it (a dev server keeps no port)", async () => {
  const dir = tmp()
  const pidFile = path.join(dir, "server.pid")
  const backend = createAcp({ id: "real", name: "Real Agent", command: [process.execPath, path.join(__dirname, "acp-agent.cjs"), path.join(dir, "state.json")] })
  const events: BackendEvent[] = []
  stops.push(backend.listen((e) => events.push(e)))
  const s = await backend.createSession({ directory: dir })
  await backend.prompt(s.id, { id: "m1", text: `SPAWN ${pidFile}` })
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0, 10_000)
  const pid = Number(fs.readFileSync(pidFile, "utf8"))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  assert.ok(alive())
  await until(() => of(events, "run").some((e) => e.status === "failed"), 10_000)
  await until(() => !alive(), 5000)
})

test("sign-in: the agent's auth error and its words for it ask for a sign-in; a path or a word with auth in it does not", () => {
  assert.equal(needsSignIn({ code: -32000, message: "Authentication required" }), true)
  assert.equal(needsSignIn(new Error("Invalid API key · Please run /login")), true)
  assert.equal(needsSignIn(new Error("Not logged in")), true)
  assert.equal(needsSignIn(new Error("ENOENT: no such file, open '/repo/src/auth/session.ts'")), false)
  assert.equal(needsSignIn(new Error("The author field is required")), false)
  assert.equal(needsSignIn({ code: -32603, message: "Internal error" }), false)
})

test("Windows: a .cmd agent's command line is quoted for cmd.exe, and a word cmd.exe would act on is refused", () => {
  assert.equal(cmdLine(["C:\\Program Files\\nodejs\\npx.cmd", "-y", "@agentclientprotocol/claude-agent-acp"]), '"C:\\Program Files\\nodejs\\npx.cmd" -y @agentclientprotocol/claude-agent-acp')
  assert.equal(cmdLine(["agent.cmd", "a & b", "x|y"]), 'agent.cmd "a & b" "x|y"')
  assert.throws(() => cmdLine(["agent.cmd", "%PATH%"]), /cmd\.exe would act on/)
  assert.throws(() => cmdLine(["agent.cmd", 'a"&calc'], ), /cmd\.exe would act on/)
})

test("models: the agent's default says which model it is, as the reviewer reads it; asked before any conversation", async () => {
  const fake = fakeAgent()
  fake.defaultModel = true
  fake.capabilities = { ...fake.capabilities, sessionCapabilities: { list: {}, options: {} } }
  const { backend } = setup(fake)
  const models = await backend.models()
  assert.ok(fake.calls.some((c) => c.method === "session/options"))
  // Only a description that is another model's name is taken: "Quick" is not one.
  assert.deepEqual(models.map((m) => [m.id, m.name]), [
    ["default", "Default · Beta"],
    ["fake/alpha", "Alpha"],
    ["fake/beta", "Beta"],
  ])
  // Nothing of the asking became a conversation.
  assert.equal(fake.sessions.size, 0)
  assert.equal(await backend.session("\u0000options"), null)
})

test("models, modes and commands come from what the agent offers; setModel sets the option and its effort", async () => {
  const { backend, fake, events } = setup()
  assert.deepEqual(await backend.models(), [])
  const s = await backend.createSession({ directory: "/repo", model: { providerID: "fake", id: "fake/beta", variant: "high" } })
  // Said with the first conversation: the controller is told to read them again.
  assert.ok(of(events, "agent").length > 0)
  assert.deepEqual(s.model, { providerID: "fake", id: "fake/beta", variant: "high" })
  assert.equal(s.agent, "build")
  const models = await backend.models()
  assert.deepEqual(models.map((m) => [m.providerID, m.id, m.name, m.images, m.variants]), [
    ["fake", "fake/alpha", "Alpha", true, ["high"]],
    ["fake", "fake/beta", "Beta", true, ["high"]],
  ])
  assert.deepEqual(await backend.agents(), [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }])
  await backend.setAgent(s.id, "plan")
  assert.equal((await backend.session(s.id))?.agent, "plan")
  await until(() => backend.can.compact === true)
  assert.deepEqual((await backend.commands("/repo")).map((c) => c.name), ["compact", "review"])
  assert.equal(backend.can.compact, true)
  // /compact is the agent's own command, sent as a prompt.
  await backend.compact(s.id)
  await until(() => fake.calls.some((c) => c.method === "session/prompt"))
  assert.equal((fake.calls.find((c) => c.method === "session/prompt")!.params.prompt as { text: string }[])[0]!.text, "/compact")
  await assert.rejects(backend.setModel(s.id, { providerID: "x", id: "nope" }), /does not offer/)
})

test("what ACP cannot do says so; fork, delete and the list work where the agent has them", async () => {
  const { backend } = setup()
  const s = await backend.createSession({ directory: "/repo" })
  assert.deepEqual({ ...backend.can }, { queue: true, steer: true, fork: true })
  await assert.rejects(backend.archive(s.id, true), /Fake Agent can't put a conversation away/)
  const copy = await backend.fork(s.id)
  assert.notEqual(copy.id, s.id)
  assert.deepEqual((await backend.sessions("/repo")).map((x) => x.id).sort(), [s.id, copy.id].sort())
  await backend.rename(s.id, "Named")
  assert.equal((await backend.session(s.id))?.title, "Named")
  await backend.remove(copy.id)
  assert.equal(await backend.session(copy.id), null)
  assert.deepEqual(await backend.projects(), ["/repo"])
})

test("an agent that cannot be started: the reason is the person's to read", async () => {
  const backend = createAcp({ id: "nope", name: "Nope", command: ["/nonexistent/agent-b42"] })
  await assert.rejects(backend.info(), /Can't start Nope: .*\/nonexistent\/agent-b42 was not found on this computer/)
})

test("tool parts: a command's title is its first line, paths are relative, a failure is its error", () => {
  assert.deepEqual(toolPart("t", { kind: "execute", status: "failed", rawInput: { command: ["npm", "run", "build"] }, content: [{ type: "content", content: { type: "text", text: "boom" } }] }, "/r"), {
    kind: "tool",
    key: "t",
    name: "shell",
    status: "error",
    title: "npm run build",
    error: "boom",
  })
  assert.equal((toolPart("t", { kind: "search", title: "grep foo in /r/src", status: "completed" }, "/r") as { title: string }).title, "grep foo in src")
  assert.equal((toolPart("t", { title: "mcp__x__y", name: "mcp__x__y", status: "in_progress" }, "/r") as { name: string }).name, "mcp__x__y")
})

test("local: folders, files for @, and the repository's branch and changes are this computer's", async () => {
  const dir = tmp()
  const { backend } = setup()
  fs.mkdirSync(path.join(dir, "src/components"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".hidden"))
  fs.writeFileSync(path.join(dir, "src/components/Button.tsx"), "x\n")
  fs.writeFileSync(path.join(dir, "src/app.css"), "a\nb\n")
  assert.deepEqual((await backend.listFolders(dir)).map((e) => e.name), ["src", ".hidden"])
  await assert.rejects(backend.listFolders(path.join(dir, "missing")), (err: Error & { status?: number }) => err.status === 404 && /Directory not found/.test(err.message))
  assert.equal(await backend.vcs(dir), undefined)
  const found = await backend.findFiles(dir, "button")
  assert.deepEqual(found[0], { kind: "file", id: "src/components/Button.tsx", label: "Button.tsx", detail: "src/components" })
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" })
  g("init", "-q", "-b", "polish")
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x")
  fs.writeFileSync(path.join(dir, "src/app.css"), "a\nc\nd\n")
  fs.writeFileSync(path.join(dir, "new.css"), "1\n2\n3\n")
  const repo = await backend.vcs(dir)
  assert.equal(repo?.branch, "polish")
  assert.deepEqual(repo?.changes.sort((a, b) => a.file.localeCompare(b.file)), [
    { file: "new.css", additions: 3, deletions: 0, status: "added" },
    { file: "src/app.css", additions: 2, deletions: 1, status: "modified" },
  ])
})

test("patch: an edit as a unified diff, with context and counts", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
  const after = before.replace("line 10\n", "line ten\n").replace("line 20\n", "line 20\nline 21\n")
  const p = unifiedPatch("a.txt", before, after)
  assert.equal(p.additions, 2)
  assert.equal(p.deletions, 1)
  assert.equal(p.patch.split("\n").filter((l) => l.startsWith("@@")).length, 2)
  assert.match(p.patch, /@@ -7,7 \+7,7 @@\n line 7\n line 8\n line 9\n-line 10\n\+line ten\n line 11/)
  const fresh = unifiedPatch("n.txt", null, "a\nb\n")
  assert.equal(fresh.patch, "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b")
})

test("a custom command line is split as a shell would, without running one", () => {
  assert.deepEqual(splitCommand(`my-agent --acp "a b" 'c d' e\\ f`), ["my-agent", "--acp", "a b", "c d", "e f"])
  assert.throws(() => splitCommand(`x "open`), /not closed/)
})

// ── the model, honestly ─────────────────────────────────────────────────────────────────────────

/** What `opencode acp` offered in the incident: two providers with a "Kimi K3.1 Pro" each, its
 *  free alpha default (text only), and what its CLI says of them (model-facts.ts). */
const OPENCODE = [
  { value: "opencode/tidepool-alpha-free", name: "opencode/Tidepool Alpha Free" },
  { value: "kimi-code-plan-global/k3.1-pro", name: "kimi-code-plan-global/Kimi K3.1 Pro" },
  { value: "moonshotai/kimi-k3.1-pro", name: "moonshotai/Kimi K3.1 Pro" },
]
const OPENCODE_FACTS = async () =>
  new Map([
    ["opencode/tidepool-alpha-free", { images: false, tags: ["free" as const] }],
    ["kimi-code-plan-global/k3.1-pro", { images: true }],
    ["moonshotai/kimi-k3.1-pro", { images: true }],
  ])
const PICTURE = { uri: "data:image/png;base64,iVBORw0KGgo=", name: "note.png" }

function openCode(extra: Partial<AcpOptions> = {}) {
  const fake = fakeAgent()
  fake.models = OPENCODE
  fake.authMethods = [{ id: "opencode-login", name: "Login with opencode", description: "Run `opencode auth login` in the terminal" }]
  return setup(fake, undefined, undefined, { modelFacts: OPENCODE_FACTS, ...extra })
}

test("models: two providers' models of one name keep their providers apart; the free alpha is labelled and marked as seeing no pictures", async () => {
  const { backend } = openCode()
  await backend.createSession({ directory: "/repo" })
  const models = await backend.models()
  assert.deepEqual(
    models.map((m) => [m.providerID, m.id, m.name, m.images, m.tags]),
    [
      ["opencode", "opencode/tidepool-alpha-free", "Tidepool Alpha", false, ["free", "alpha"]],
      ["kimi-code-plan-global", "kimi-code-plan-global/k3.1-pro", "Kimi K3.1 Pro", true, undefined],
      ["moonshotai", "moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro", true, undefined],
    ],
  )
})

test("models: what the agent says of them that comes late is read again (an agent event), not waited for", async () => {
  timing.facts = 10
  let release!: () => void
  const later = new Promise<void>((r) => (release = r))
  const { backend, events } = openCode({ modelFacts: () => later.then(OPENCODE_FACTS) })
  try {
    await backend.createSession({ directory: "/repo" })
    const first = await backend.models()
    // Without the CLI's word, the name alone says it is free and an alpha; pictures are the agent's.
    assert.deepEqual(first.map((m) => [m.name, m.images, m.tags]).at(0), ["Tidepool Alpha", true, ["free", "alpha"]])
    const before = of(events, "agent").length
    release()
    await until(() => of(events, "agent").length > before)
    assert.equal((await backend.models())[0]!.images, false)
  } finally {
    timing.facts = 4_000
  }
})

test("provider refused: an auth error on a prompt of a signed-in multi-provider agent names the model and provider, and offers another model and the agent's way to add a key", async () => {
  const { backend, fake, events, items } = openCode()
  fake.onPrompt = async () => {
    throw RequestError.authRequired({}, "provider authentication required")
  }
  const s = await backend.createSession({ directory: "/repo", model: { providerID: "kimi-code-plan-global", id: "kimi-code-plan-global/k3.1-pro" } })
  await backend.prompt(s.id, { id: "m1", text: "less space above the plans" })
  await until(() => of(events, "run").some((e) => e.status === "failed"))
  const failed = of(events, "run").find((e) => e.status === "failed")!
  assert.match(failed.error!, /^kimi-code-plan-global refused the key Fake Agent has for it, so Kimi K3\.1 Pro could not answer\. Fake Agent itself is signed in\. Choose another model, or add a key in a terminal: opencode auth login\.$/)
  assert.doesNotMatch(failed.error!, /sign in first/)
  const line = items.at(-1)
  assert.equal(line?.kind, "marker")
  assert.deepEqual(line?.kind === "marker" && line.refused, { model: "Kimi K3.1 Pro", provider: "kimi-code-plan-global", agent: "Fake Agent", fix: "opencode auth login" })
})

test("sign-in: the agent's own auth error at the start of a conversation, or on a prompt of a one-provider agent, still asks for its sign-in", async () => {
  const one = setup()
  one.fake.onPrompt = async () => {
    throw RequestError.authRequired({}, "Authentication required")
  }
  const s = await one.backend.createSession({ directory: "/repo" })
  await one.backend.prompt(s.id, { id: "m1", text: "hi" })
  await until(() => of(one.events, "run").some((e) => e.status === "failed"))
  assert.match(of(one.events, "run").find((e) => e.status === "failed")!.error!, /Fake Agent needs you to sign in first/)
  const marker = one.items.at(-1)
  assert.ok(marker?.kind === "marker" && !marker.refused)

  // OpenCode's words name a provider, but at a new conversation it is OpenCode's own sign-in.
  const fake = fakeAgent()
  fake.models = OPENCODE
  // The fake keeps the conversation it makes in session/new: refusing there refuses the request.
  fake.sessions.set = () => {
    throw RequestError.authRequired({}, "provider authentication required")
  }
  const { backend } = setup(fake)
  await assert.rejects(backend.createSession({ directory: "/repo" }), /Fake Agent needs you to sign in first/)
})

test("the chip follows the agent: a model it changes by itself, and one it answers a change with, are what the conversation shows", async () => {
  const { backend, fake, events, items } = openCode()
  const s = await backend.createSession({ directory: "/repo" })
  assert.equal(s.model?.id, "opencode/tidepool-alpha-free")
  // Asked for one Kimi, the agent puts the conversation on the other: the summary says the other.
  fake.swap["moonshotai/kimi-k3.1-pro"] = "kimi-code-plan-global/k3.1-pro"
  await backend.setModel(s.id, { providerID: "moonshotai", id: "moonshotai/kimi-k3.1-pro" })
  assert.equal((await backend.session(s.id))?.model?.id, "kimi-code-plan-global/k3.1-pro")
  // During a turn the agent changes the model by itself, and says so.
  fake.onPrompt = async (turn) => {
    fake.sessions.get(turn.session)!.model = "opencode/tidepool-alpha-free"
    await turn.say({ sessionUpdate: "config_option_update", configOptions: fake.options(turn.session) as never })
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" }, messageId: "m" })
  }
  await backend.prompt(s.id, { id: "m1", text: "hi" })
  await until(() => of(events, "run").some((e) => e.status === "succeeded"))
  assert.equal(of(events, "session").at(-1)?.session.model?.id, "opencode/tidepool-alpha-free")
  assert.ok(items.some((i) => i.kind === "marker" && i.text === "Fake Agent changed the model to Tidepool Alpha"))
})

test("a model the conversation could not start on: it says so, and which model it is on instead", async () => {
  const { backend } = openCode()
  const s = await backend.createSession({ directory: "/repo", model: { providerID: "x", id: "x/gone" } })
  assert.equal(s.model?.id, "opencode/tidepool-alpha-free")
  const line = (await backend.transcript(s.id)).items.find((i) => i.kind === "marker")
  assert.match(line?.kind === "marker" ? line.text : "", /^Could not start on gone: Fake Agent does not offer "x\/gone" here\. This conversation is on Tidepool Alpha\.$/)
})

test("each reply says its model: the conversation's when the turn began, or the one the agent reported (Claude Code's _claude/model); again after a re-read", async () => {
  const dir = tmp()
  const fake = fakeAgent()
  fake.models = [
    { value: "default", name: "Default (recommended)", description: "Opus 5.5" },
    { value: "opus", name: "Opus 5.5" },
    { value: "sonnet", name: "Sonnet 5.5" },
  ]
  fake.onPrompt = async (turn) => {
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" }, messageId: `m-${turn.text}` })
    if (turn.text === "reported") await turn.say({ sessionUpdate: "usage_update", used: 10, size: 100, _meta: { "_claude/model": "claude-sonnet-5-5" } })
  }
  const first = setup(fake, dir)
  const s = await first.backend.createSession({ directory: "/repo", model: { providerID: "Fake Agent", id: "opus" } })
  await first.backend.prompt(s.id, { id: "m1", text: "plain" })
  await until(() => of(first.events, "run").filter((e) => e.status === "succeeded").length === 1)
  await first.backend.prompt(s.id, { id: "m2", text: "reported" })
  await until(() => of(first.events, "run").filter((e) => e.status === "succeeded").length === 2)
  const said = first.items.flatMap((i) => (i.kind === "assistant" ? [i.model] : []))
  assert.deepEqual(said, ["Opus 5.5", "Sonnet 5.5"])
  first.stop()
  const again = setup(fake, dir)
  const read = await again.backend.transcript(s.id)
  assert.deepEqual(read.items.flatMap((i) => (i.kind === "assistant" ? [i.model] : [])), ["Opus 5.5", "Sonnet 5.5"])
})

test("pictures not seen: a note's pictures to a model that takes text only are marked on it, and still go; also after a re-read", async () => {
  const dir = tmp()
  const fake = fakeAgent()
  fake.models = OPENCODE
  const first = setup(fake, dir, undefined, { modelFacts: OPENCODE_FACTS })
  const s = await first.backend.createSession({ directory: "/repo" })
  await first.backend.models()
  await first.backend.prompt(s.id, { id: "m1", text: "UI review note 3 on http://x/\nNote: round it", files: [PICTURE] })
  await until(() => of(first.events, "run").some((e) => e.status === "succeeded"))
  const note = first.items.find((i) => i.id === "m1")
  assert.deepEqual(note?.kind === "user" && note.unseen, { by: "Tidepool Alpha" })
  // Nothing was held back: the picture went with the words.
  const sent = fake.calls.find((c) => c.method === "session/prompt")!.params.prompt as { type: string }[]
  assert.deepEqual(sent.map((b) => b.type), ["text", "image"])
  first.stop()
  const again = setup(fake, dir, undefined, { modelFacts: OPENCODE_FACTS })
  const read = (await again.backend.transcript(s.id)).items.find((i) => i.id === "m1")
  assert.deepEqual(read?.kind === "user" && read.unseen, { by: "Tidepool Alpha" })
})

test("pictures not seen: an agent that takes no pictures at all, and a model that says it could not read them, mark the message; a model that sees them does not", async () => {
  const none = fakeAgent()
  none.capabilities = { ...none.capabilities, promptCapabilities: { image: false } }
  const a = setup(none)
  const s1 = await a.backend.createSession({ directory: "/repo" })
  await a.backend.prompt(s1.id, { id: "m1", text: "look", files: [PICTURE] })
  await until(() => of(a.events, "run").some((e) => e.status === "succeeded"))
  assert.deepEqual(a.items.find((i) => i.id === "m1")?.kind === "user" && (a.items.find((i) => i.id === "m1") as { unseen?: unknown }).unseen, { by: "Alpha" })

  const { backend, fake, events, items } = setup()
  fake.onPrompt = async (turn) => {
    const text = turn.text === "blind" ? "The images attached to this note could not be read by the model (it does not support image input)." : "I see a red button."
    await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId: `m-${turn.text}` })
  }
  const s = await backend.createSession({ directory: "/repo" })
  await backend.prompt(s.id, { id: "m1", text: "seeing", files: [PICTURE] })
  await until(() => of(events, "run").filter((e) => e.status === "succeeded").length === 1)
  await backend.prompt(s.id, { id: "m2", text: "blind", files: [PICTURE] })
  await until(() => of(events, "run").filter((e) => e.status === "succeeded").length === 2)
  const user = (id: string) => items.find((i) => i.id === id) as { unseen?: unknown }
  assert.equal(user("m1").unseen, undefined)
  assert.deepEqual(user("m2").unseen, { by: "Alpha" })
})
