// The controller (src/main/core.ts) with an ACP agent on this computer instead of an OpenCode
// server: the app starts the agent as a process of its own, as it starts Claude Code's adapter
// (here test/acp-agent.ts, the fake agent run as a program), and the notes go to it. What the
// reviewer at the screen must see when that process ends with a note under way, or the app quits
// with one: the note says so, with Retry, and is never called done.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { timing } from "../src/main/acp"
import { testShell, type TestShell } from "./stubs/host"

timing.retryMin = 50
timing.retryMax = 200

const SITE = "http://site.test"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean, ms = 8000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(10)
  }
}

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-acp-"))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-acp-repo-"))
  const state = path.join(dir, "fake-agent.json")
  const command = `"${process.execPath}" "${path.join(__dirname, "acp-agent.cjs")}" "${state}"`
  const quiet = { log: console.log, warn: console.warn, error: console.error }
  if (!process.env.V) console.log = console.warn = console.error = () => {}
  const shells: TestShell[] = []
  const shell = () => {
    const s = testShell(dir)
    shells.push(s)
    return s
  }
  let current = shell()
  const cmd = (name: string, ...args: unknown[]) => current.core.invoke(name, args)
  const snap = () => current.core.snapshot()
  const notes = () => snap().review.notes.map((n) => `${n.n}:${n.status}`).join(" ")
  let k = 0
  const note = (text: string) => {
    const id = `n${++k}`
    current.page.message({ type: "note", note: { id, text, url: `${SITE}/`, viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 }, targets: [], area: null, strokes: [], bounds: { x: 1, y: 2, w: 3, h: 4 } } })
    return id
  }
  return {
    dir,
    repo,
    cmd,
    snap,
    notes,
    note,
    /** Start the agent, open the site, pick its folder; resolves once a conversation is open. */
    async ready() {
      await cmd("connectAgent", { id: "custom", command })
      current.page.load(`${SITE}/`)
      await cmd("setDirectory", repo)
      await until(() => !!snap().session)
    },
    /** The app quits, and starts again on the same data. */
    async relaunch() {
      await current.core.dispose()
      current = shell()
    },
    async close() {
      for (const s of shells) await s.core.dispose()
      Object.assign(console, quiet)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    },
  }
}

test("an agent on this computer: started by its command, remembered, a note goes to it and is done; the window is told what it cannot do", async () => {
  const h = boot()
  try {
    await h.ready()
    const c = h.snap().connection
    assert.equal(c.status, "online")
    assert.match(c.status === "online" ? c.url : "", /^acp:\/\/custom-[0-9a-f]{8}$/)
    assert.equal(c.status === "online" && c.version, "9.9")
    assert.deepEqual(h.snap().can, { queue: true, steer: true, fork: true })
    const saved = (await h.cmd("servers")) as { agent?: string; command?: string; current: boolean }[]
    assert.ok(saved.some((s) => s.current && s.agent?.startsWith("custom-") && s.command?.includes("acp-agent.cjs")))
    h.note("make it blue")
    await until(() => h.notes() === "1:done")
    assert.deepEqual(h.snap().running, [])
    // What it can't do is not offered: Archive is gone from the list's commands, /fork stays.
    const commands = ((await h.cmd("commands")) as { name: string }[]).map((x) => x.name)
    assert.ok(commands.includes("fork") && commands.includes("review"))
    await assert.rejects(h.cmd("archiveSession", h.snap().session!.id, true), /can't put a conversation away/)
    await assert.rejects(h.cmd("stopRunning"), /can't stop what it left running/)
  } finally {
    await h.close()
  }
})

test("the agent's process ends with a note under way: the note fails with Retry and the reason; the agent comes back and Retry sends it", async () => {
  const h = boot()
  try {
    await h.ready()
    const id = h.note("CRASH it")
    await until(() => h.notes() === "1:failed")
    const row = h.snap().review.notes[0]!
    assert.match(row.error ?? "", /stopped: it exited with code 3/)
    assert.ok(!row.stopped, "a failure, not something the reviewer stopped")
    // Started again by itself.
    await until(() => h.snap().connection.status === "online")
    await h.cmd("retryNote", id)
    await until(() => h.notes() === "1:done")
  } finally {
    await h.close()
  }
})

test("the app quits with a note under way: started again, the note is stopped with Retry, not done", async () => {
  const h = boot()
  try {
    await h.ready()
    h.note("HANG here")
    await until(() => h.notes() === "1:working")
    await h.relaunch()
    // The saved agent is started again, its site opens, and what its process lost is said.
    await until(() => h.snap().connection.status === "online" && !!h.snap().session)
    await until(() => h.notes() === "1:failed")
    assert.equal(h.snap().review.notes[0]?.stopped, true)
  } finally {
    await h.close()
  }
})
