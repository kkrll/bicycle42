// Drives a real ACP agent on this computer through main/acp.ts, the way the controller does, and
// says what worked: not part of `npm test` (it spends the agent's tokens, and needs it installed
// and signed in). Each prompt is tiny, in a throwaway folder that is deleted at the end.
//
//   node scripts/build.mjs --tests && node dist/test/acp.real.cjs opencode [model]
//   node dist/test/acp.real.cjs claude haiku
//
// The agent is one of agents.ts's KNOWN_AGENTS. What it checks: start and initialize, models and
// modes, a note-like turn that writes a file (and the chat items it streams), a re-read in the
// same process, the queue (two messages sent at once go one after the other), Stop, steer, the
// repo's state and @-file search from this computer, and a re-read from a new process (the
// replay of session/load against what streamed).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAcp } from "../src/main/acp"
import { installAdapter, lineOf, markUsed } from "../src/main/adapters"
import { adapterLock, KNOWN_AGENTS, prepareStart } from "../src/main/agents"
import { thisMachine } from "../src/main/machine"
import type { BackendEvent, ChatEvent, ChatItem } from "../src/shared/types"

const [id = "opencode", model] = process.argv.slice(2)
const known = KNOWN_AGENTS.find((a) => a.id === id)
if (!known) throw new Error(`Unknown agent ${id}`)
const results: [string, boolean, string][] = []
const check = (what: string, ok: boolean, detail = "") => {
  results.push([what, ok, detail])
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  (${detail})` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) return false
    await sleep(50)
  }
  return true
}

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

const shape = (items: ChatItem[]) =>
  items.map((i) => (i.kind === "assistant" ? `${i.id}[${i.parts.map((p) => (p.kind === "tool" ? `tool:${p.key}:${p.status}` : `${p.key}`)).join(",")}]` : `${i.kind}:${i.id}`))

async function fromLock(): Promise<string[]> {
  const lock = adapterLock(id)
  if (!lock) throw new Error(`This build has no lockfile of ${known!.name}'s pin.`)
  const m = thisMachine()
  await installAdapter(m, lock, { name: known!.name, env: await m.agentEnv(), onStep: (text) => console.log(text) })
  await markUsed(m, lock)
  console.log(`from the app's lockfile: ${lock.folder}`)
  return lineOf(m, lock)
}

async function main() {
  // As the app starts it: the pinned adapter installed from the app's lockfile first (in
  // ~/.bicycle42/adapters), or B42_PIN_<ID>'s version through npx. With B42_REAL_FROM_LOCK (what
  // `agents:check --bump` and `--from-lock` set), from the lockfile whatever else is installed
  // (your own adapter on the PATH would come first otherwise), and said so: what is checked is
  // the tree the app installs.
  const command = process.env.B42_REAL_FROM_LOCK ? await fromLock() : await prepareStart(id, undefined, {}, { onStep: (text) => console.log(text) })
  if (!command) throw new Error(`${known!.name} is not installed: ${known!.install}`)
  console.log(`${known!.name}: ${command.join(" ")}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b42-real-${id}-`))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `b42-real-state-`))
  execFileSync("git", ["init", "-q", "-b", "main", dir])
  const log = (level: string, msg: string, data?: unknown) => process.env.V && console.log(`[${level}] ${msg}`, data ?? "")
  const make = () => createAcp({ id, name: known!.name, command, stateDir, log })
  let backend = make()
  const events: BackendEvent[] = []
  const items: ChatItem[] = []
  const on = (e: BackendEvent) => {
    events.push(e)
    if (e.type === "chat") applyChat(items, e.event)
    if (e.type === "permission") {
      console.log(`  permission: ${e.ask.action} ${e.ask.resources.join(" ")}`)
      void backend.replyPermission(e.ask.session, e.ask.id, "once")
    }
  }
  const t0 = Date.now()
  const info = await backend.info()
  check("starts and answers initialize", true, `${info.computer} ${info.version}, ${Math.round((Date.now() - t0) / 1000)} s`)
  let stop = backend.listen(on)
  check("can", true, JSON.stringify(backend.can))
  const session = await backend.createSession({ directory: dir, title: "bicycle 42 real test" })
  const models = await backend.models()
  check("models from the agent's options", models.length > 0, `${models.length}, first ${models[0]?.id}; current ${session.model?.id}`)
  check("modes", true, (await backend.agents()).map((a) => a.id).join(", "))
  if (model) {
    const m = models.find((x) => x.id === model || x.id.endsWith(`/${model}`))
    if (m) await backend.setModel(session.id, { providerID: m.providerID, id: m.id }).then(() => check("setModel", true, m.id), (err) => check("setModel", false, String(err)))
    else check("setModel", false, `no model ${model}`)
  }
  const ends = () => events.filter((e) => e.type === "run" && e.status !== "started").length

  // A note-like turn.
  const note = "UI review note 1 on http://localhost:3000/\nNote: add hello.txt\nMake the smallest change. Create a file named hello.txt in the current folder containing the single word hi. Then reply with one word: done."
  await backend.prompt(session.id, { id: "msg_real_1", text: note })
  const ended = await until(() => ends() >= 1, 240_000)
  const run = events.find((e) => e.type === "run" && e.status !== "started") as Extract<BackendEvent, { type: "run" }> | undefined
  check("a note-like turn runs and ends", ended && run?.status === "succeeded", run ? `${run.status}${run.error ? `: ${run.error}` : ""}` : "no end")
  check("the agent wrote the file", fs.existsSync(path.join(dir, "hello.txt")))
  check("inbox: queued then working", JSON.stringify(events.filter((e) => e.type === "inbox").map((e) => (e as { status: string }).status)) === '["queued","working"]')
  const reply = items.find((i) => i.kind === "assistant")
  check("the chat has the note and the agent's step", items[0]?.kind === "user" && !!items[0].note && reply?.kind === "assistant", shape(items).join(" "))
  const read = await backend.transcript(session.id)
  check("a re-read in the same process equals the stream", JSON.stringify(read.items) === JSON.stringify(items))
  const ctx = events.filter((e) => e.type === "context").at(-1) as Extract<BackendEvent, { type: "context" }> | undefined
  check("context use", !!ctx?.context, JSON.stringify(ctx?.context))
  check("commands", true, (await backend.commands(dir)).map((c) => c.name).slice(0, 12).join(", "))

  // The queue: two at once go one after the other, in one run.
  const before = events.length
  await backend.prompt(session.id, { id: "msg_real_2", text: "Reply with exactly the word one." })
  await backend.prompt(session.id, { id: "msg_real_3", text: "Reply with exactly the word two." })
  const waitingThen = await backend.waiting(session.id)
  await until(() => ends() >= 2, 180_000)
  const later = events.slice(before)
  const working = later.filter((e) => e.type === "inbox" && e.status === "working").map((e) => (e as { id: string }).id)
  check("queue: the second waits, then goes after the first", JSON.stringify(waitingThen) === '["msg_real_3"]' && JSON.stringify(working) === '["msg_real_2","msg_real_3"]', `waiting ${JSON.stringify(waitingThen)}, working ${JSON.stringify(working)}`)
  check("queue: one run for both", later.filter((e) => e.type === "run").map((e) => (e as { status: string }).status).join(",") === "started,succeeded", later.filter((e) => e.type === "run").map((e) => (e as { status: string }).status).join(","))

  // Stop.
  await backend.prompt(session.id, { id: "msg_real_4", text: "Write the numbers from 1 to 400, one per line, with no other words." })
  await until(() => items.some((i) => i.id === "a_msg_real_4" && i.kind === "assistant" && i.parts.some((p) => p.kind === "text" && p.text.length > 20)), 120_000)
  const stopped = await backend.stop(session.id)
  await until(() => ends() >= 3, 60_000)
  const third = events.filter((e) => e.type === "run" && e.status !== "started")[2] as { status: string } | undefined
  check("stop: cancelled, the run says interrupted", stopped && third?.status === "interrupted", `stop() ${stopped}, run ${third?.status}`)
  check("stop: the chat says Stopped", items.some((i) => i.kind === "marker" && i.text === "Stopped"))

  // Steer.
  if (backend.can.steer) {
    await backend.prompt(session.id, { id: "msg_real_5", text: "Write the numbers from 1 to 300, one per line, with no other words." })
    await until(() => items.some((i) => i.id === "a_msg_real_5" && i.kind === "assistant" && i.parts.length > 0), 120_000)
    await backend.prompt(session.id, { id: "msg_real_6", text: "Stop counting now and reply with exactly the word steered.", delivery: "steer" })
    const queued = (await backend.waiting(session.id)).includes("msg_real_6")
    await until(() => ends() >= 4, 180_000)
    const steeredItem = items.find((i) => i.id === "msg_real_6")
    check("steer: the message joins the turn under way", !queued && steeredItem?.kind === "user" && !steeredItem.pending, queued ? "it was queued instead" : shape(items.slice(-3)).join(" "))
  }

  // This computer's side.
  const repo = await backend.vcs(dir)
  check("vcs: the branch and the new file", repo?.branch === "main" && repo.changes.some((c) => c.file === "hello.txt" && c.status === "added"), JSON.stringify(repo))
  check("@-file search", (await backend.findFiles(dir, "hel"))[0]?.id === "hello.txt")

  // A new process: the replay against what streamed.
  const streamed = structuredClone(items)
  stop()
  backend = make()
  events.length = 0
  stop = backend.listen(on)
  const t1 = Date.now()
  const again = await backend.transcript(session.id)
  const a = shape(again.items)
  const b = shape(streamed)
  check("a re-read from a new process has the same items and keys", JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b) ? `${a.length} items, ${Date.now() - t1} ms` : `replay ${a.join(" ")}\n   stream ${b.join(" ")}`)
  const sameText = again.items.every((x, i) => JSON.stringify(x.kind === "assistant" ? x.parts.map((p) => (p.kind === "tool" ? p.title : p.text)) : x.kind === "user" ? x.text : x.kind === "marker" ? x.text : "") === JSON.stringify(((y) => (y?.kind === "assistant" ? y.parts.map((p) => (p.kind === "tool" ? p.title : p.text)) : y?.kind === "user" ? y.text : y?.kind === "marker" ? y.text : ""))(streamed[i])))
  check("…with the same words and tool titles", sameText)
  if (!sameText || JSON.stringify(a) !== JSON.stringify(b)) fs.writeFileSync(path.join(os.tmpdir(), `b42-real-${id}-items.json`), JSON.stringify({ streamed, replayed: again.items }, null, 1))

  // Clean up: the conversation, the folder, the process.
  await backend.remove(session.id).catch((err) => console.log(`  (could not delete the conversation: ${err.message})`))
  stop()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
  const failed = results.filter((r) => !r[1]).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  setTimeout(() => process.exit(failed ? 1 : 0), 500)
}

main().catch((err) => {
  console.error("FAIL", err)
  process.exit(1)
})
