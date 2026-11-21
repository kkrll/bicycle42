// The controller (src/main/core.ts) with an ACP agent on another computer over ssh: the fake ssh
// (test/fake-ssh.ts) runs the helper and the fake agent (test/acp-agent.ts) "there", under a home
// of its own. What the reviewer must see: the agents installed there, a note done, the agent's
// process ending with Retry, a connection that drops while the agent works with the note neither
// failed nor lost, a note taken back from the app's file history kept on that computer, and that
// such a take-back never touches a folder of this computer at the same path.
//
//   node scripts/build.mjs --tests && node --test dist/test/controller-ssh.test.cjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { timing } from "../src/main/acp"
import { sshTiming } from "../src/main/ssh"
import { testShell, type TestShell } from "./stubs/host"
import { fakeHost, sleep, until, type FakeHost } from "./ssh-fixture"

timing.retryMin = 50
timing.retryMax = 200
sshTiming.retryMin = 100
sshTiming.retryMax = 300

const SITE = "http://site.test"

/** Whether this computer lets a test give the "other computer" a mount of its own (unshare). */
function canBind() {
  try {
    execFileSync("unshare", ["-rm", "true"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function boot(opts: { bind?: { there: string; here: string } } = {}) {
  const h: FakeHost = fakeHost()
  if (opts.bind) process.env.B42_FAKE_SSH_BIND = `${opts.bind.there}=${opts.bind.here}`
  const repo = opts.bind?.there ?? path.join(h.home, "repo")
  fs.mkdirSync(repo, { recursive: true })
  const state = path.join(h.root, "fake-agent.json")
  const command = `"${process.execPath}" "${path.join(__dirname, "acp-agent.cjs")}" "${state}"`
  const quiet = { log: console.log, warn: console.warn, error: console.error }
  if (!process.env.V) console.log = console.warn = console.error = () => {}
  const shells: TestShell[] = []
  const shell = () => {
    const s = testShell(h.data)
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
    h,
    repo,
    cmd,
    snap,
    notes,
    note,
    shell: () => current,
    async ready() {
      await cmd("connectSsh", "dev-box")
      await cmd("connectAgent", { id: "custom", command, host: "dev-box" })
      current.page.load(`${SITE}/`)
      await cmd("setDirectory", repo)
      await until(() => !!snap().session)
    },
    async close() {
      for (const s of shells) await s.core.dispose()
      Object.assign(console, quiet)
      delete process.env.B42_FAKE_SSH_BIND
      await h.end()
    },
  }
}

test("an agent on another computer: the agents there are listed, it is started there and remembered with its host, a note goes to it and is done", async () => {
  const t = boot()
  try {
    const there = (await t.cmd("connectSsh", "dev-box")) as { host: string; home: string; agents: { id: string; installed: boolean }[] }
    assert.equal(there.host, "dev-box")
    assert.equal(there.home, t.h.home)
    assert.deepEqual(there.agents.map((a) => a.id), ["claude", "codex", "gemini", "opencode"])
    await t.ready()
    const c = t.snap().connection
    assert.equal(c.status, "online")
    assert.match(c.status === "online" ? c.url : "", /^acp:\/\/custom-[0-9a-f]{8}@dev-box$/)
    // The window names it by its program, on dev-box; its folders are shown under that computer's ~.
    assert.deepEqual(t.snap().harness, { kind: "custom", name: path.basename(process.execPath), here: false, host: "dev-box" })
    assert.equal(t.snap().home, t.h.home)
    const saved = (await t.cmd("servers")) as { current: boolean; host?: string; here: boolean }[]
    assert.ok(saved.some((s) => s.current && s.host === "dev-box" && !s.here))
    // Its folders are that computer's: listed through the helper.
    const listed = (await t.cmd("listFolders", t.h.home)) as { name: string }[]
    assert.ok(listed.some((f) => f.name === "repo"))
    t.note("make it blue")
    await until(() => t.notes() === "1:done")
    // The app's file history of the folder is kept there, not here.
    await until(() => fs.existsSync(path.join(t.h.home, ".bicycle42", "snapshots")))
    assert.equal(fs.existsSync(path.join(t.h.data, "snapshots")), false)
  } finally {
    await t.close()
  }
})

test("the agent's process there ends with a note under way: the note fails with Retry and the reason; the agent comes back and Retry sends it", async () => {
  const t = boot()
  try {
    await t.ready()
    const id = t.note("CRASH it")
    await until(() => t.notes() === "1:failed")
    assert.match(t.snap().review.notes[0]!.error ?? "", /stopped: it exited with code 3/)
    await until(() => t.snap().connection.status === "online")
    await t.cmd("retryNote", id)
    await until(() => t.notes() === "1:done")
  } finally {
    await t.close()
  }
})

test("the connection drops while the agent works: the window says the computer can't be reached and that it works on; the note neither fails nor pauses, and is done once it is back", async () => {
  const t = boot()
  try {
    await t.ready()
    t.note("SLOW 1500 then done")
    await until(() => t.notes() === "1:working")
    t.h.drop()
    await until(() => t.snap().connection.status === "offline")
    const c = t.snap().connection
    assert.equal(c.status === "offline" && c.away, true)
    assert.match(c.status === "offline" ? c.error : "", /dev-box/)
    // A note made meanwhile waits.
    t.note("second")
    await sleep(2000)
    assert.equal(t.notes(), "1:working 2:queued")
    t.h.up()
    // Retry (the banner's) tries the connection now.
    await t.cmd("reconnect")
    await until(() => t.snap().connection.status === "online")
    await until(() => t.notes() === "1:done 2:done")
  } finally {
    await t.close()
  }
})

test("take back with an agent there: an older note's files are put back from the history kept on that computer, the later note's stay", async () => {
  const t = boot()
  try {
    const a = path.join(t.repo, "a.css")
    fs.writeFileSync(a, "a { color: black }\n\n\n\n\nb { pad: 4px }\n")
    await t.ready()
    const first = t.note(`EDIT ${a} black red`)
    await until(() => t.notes() === "1:done")
    t.note(`EDIT ${a} 4px 8px`)
    await until(() => t.notes() === "1:done 2:done")
    assert.equal(await t.cmd("takeBackWay", first), "restored")
    assert.equal(await t.cmd("takeBackNote", first, "restored"), "restored")
    assert.equal(fs.readFileSync(a, "utf8"), "a { color: black }\n\n\n\n\nb { pad: 8px }\n")
    const root = path.join(t.h.home, ".bicycle42", "snapshots")
    const log = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root).find((d) => d.endsWith(".git"))!, "b42.json"), "utf8")) as { restores: unknown[]; turns: unknown[] }
    assert.equal(log.turns.length, 2)
    assert.equal(log.restores.length, 1)
    assert.equal(fs.existsSync(path.join(t.h.data, "snapshots")), false)
  } finally {
    await t.close()
  }
})

test("a take-back with an agent on another computer never touches this computer's folder at the same path", { skip: !canBind() && "unshare -rm is not allowed here" }, async () => {
  // The same path, two folders: `here` is what this computer has there; the other computer sees `theirs` at it.
  const base = fs.mkdtempSync(path.join(fs.realpathSync(require("node:os").tmpdir()), "b42-same-path-"))
  const here = path.join(base, "repo")
  const theirs = path.join(base, "theirs")
  fs.mkdirSync(here)
  fs.mkdirSync(theirs)
  const mine = "a { color: black }\n\n\n\n\nb { pad: 4px }\n/* this computer's own */\n"
  fs.writeFileSync(path.join(here, "a.css"), mine)
  fs.writeFileSync(path.join(theirs, "a.css"), "a { color: black }\n\n\n\n\nb { pad: 4px }\n")
  const t = boot({ bind: { there: here, here: theirs } })
  try {
    const a = path.join(here, "a.css")
    await t.ready()
    const first = t.note(`EDIT ${a} black red`)
    await until(() => t.notes() === "1:done")
    t.note(`EDIT ${a} 4px 8px`)
    await until(() => t.notes() === "1:done 2:done")
    // The agent changed its computer's file, not this one's.
    assert.equal(fs.readFileSync(path.join(theirs, "a.css"), "utf8"), "a { color: red }\n\n\n\n\nb { pad: 8px }\n")
    assert.equal(fs.readFileSync(a, "utf8"), mine)
    assert.equal(await t.cmd("takeBackNote", first, "restored"), "restored")
    assert.equal(fs.readFileSync(path.join(theirs, "a.css"), "utf8"), "a { color: black }\n\n\n\n\nb { pad: 8px }\n")
    assert.equal(fs.readFileSync(a, "utf8"), mine, "this computer's file at the same path is as it was")
    await t.cmd("runCommand", "redo", "")
    assert.equal(fs.readFileSync(path.join(theirs, "a.css"), "utf8"), "a { color: red }\n\n\n\n\nb { pad: 8px }\n")
    assert.equal(fs.readFileSync(a, "utf8"), mine)
    assert.equal(fs.existsSync(path.join(t.h.data, "snapshots")), false)
  } finally {
    await t.close()
    fs.rmSync(base, { recursive: true, force: true })
  }
})
