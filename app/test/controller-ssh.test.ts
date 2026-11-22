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
import http from "node:http"
import type net from "node:net"
import path from "node:path"
import { test } from "node:test"
import { timing } from "../src/main/acp"
import { ADAPTER_LOCKS, adapterTiming } from "../src/main/adapters"
import { adapterLock, PINS } from "../src/main/agents"
import type { LocalAgent, RemoteInfo } from "../src/shared/types"
import { sshTiming } from "../src/main/ssh"
import { testShell, type TestShell } from "./stubs/host"
import { fakeAdapterPackages, fakeRegistry } from "./fake-registry"
import { fakeHost, sleep, until, type FakeHost } from "./ssh-fixture"
import { lockManifest } from "../scripts/agent-pins.mjs"

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
    /** The app quits and starts again (on the same data folder). */
    async restart() {
      await current.core.dispose()
      current = shell()
    },
    /** The app's ssh connections running "there": the helper attached to, one per host. */
    attached: () => {
      const dir = path.join(h.root, "sessions")
      return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => {
        try {
          return fs.readFileSync(path.join(dir, f), "utf8").includes(" attach")
        } catch {
          return false
        }
      }).length
    },
    /** `page: false`: no page is open (the site is to be started). */
    async ready(o: { page?: false } = {}) {
      await cmd("connectSsh", "dev-box")
      await cmd("connectAgent", { id: "custom", command, host: "dev-box" })
      if (o.page !== false) current.page.load(`${SITE}/`)
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
    // The app's file history of the folder is kept there, not here, under this install's own id.
    await until(() => fs.existsSync(path.join(t.h.home, ".bicycle42", "snapshots")))
    assert.deepEqual(fs.readdirSync(path.join(t.h.home, ".bicycle42", "snapshots")), [fs.readFileSync(path.join(t.h.data, "ssh", "owner"), "utf8")])
    assert.equal(fs.existsSync(path.join(t.h.data, "snapshots")), false)
  } finally {
    await t.close()
  }
})

test("Claude Code there is installed there from the app's lockfile at its first start (said), started from it, @latest through npx once asked for, and as it is now after a restart", async () => {
  const t = boot()
  // A registry of the test's own with a fake adapter at the pinned version; that computer's npm
  // gets packages from it (its own ~/.npmrc), and its PATH has Claude Code, node and npm, and an
  // npx that says what it was asked for, then runs the fake agent. No adapter of its own there.
  const registry = await fakeRegistry(path.join(t.h.root, "registry"), fakeAdapterPackages(path.join(t.h.root, "postinstall-ran")))
  const keptLock = ADAPTER_LOCKS.claude
  ADAPTER_LOCKS.claude = { manifest: lockManifest("claude", PINS.claude!), lock: await registry.lockFor(lockManifest("claude", PINS.claude!)) }
  fs.writeFileSync(path.join(t.h.home, ".npmrc"), `registry=${registry.url}/\nfetch-retries=0\n`)
  process.env.B42_FAKE_ADAPTER_STATE = path.join(t.h.root, "fake-agent.json")
  const bin = path.join(t.h.root, "there-bin")
  const asked = path.join(t.h.root, "npx-asked")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "npx"), `#!/bin/sh\necho "$*" >> "${asked}"\nexec "${process.execPath}" "${path.join(__dirname, "acp-agent.cjs")}" "${path.join(t.h.root, "fake-agent.json")}"\n`, { mode: 0o755 })
  process.env.B42_FAKE_SSH_PATH = `${bin}${path.delimiter}${process.env.PATH}`
  const kept = process.env.B42_PIN_CLAUDE
  delete process.env.B42_PIN_CLAUDE
  const lines = () => (fs.existsSync(asked) ? fs.readFileSync(asked, "utf8").trim().split("\n") : [])
  const lock = adapterLock("claude")!
  const folder = path.join(t.h.home, ".bicycle42", "adapters", lock.folder)
  const line = `node ${path.join(folder, "node_modules", ...PINS.claude!.package.split("/"), "bin", "agent.js")}`
  try {
    const there = (await t.cmd("connectSsh", "dev-box")) as RemoteInfo
    const claude = there.agents.find((a) => a.id === "claude")!
    assert.equal(claude.command, line, "that computer's home, from this computer's lockfile")
    assert.deepEqual(claude.adapter, { version: PINS.claude!.version, tested: !!PINS.claude!.tested, latest: false, own: false, locked: true, firstStart: true })
    // Started: installed there first, the step said while it is.
    const steps: string[] = []
    const watch = setInterval(() => {
      const s = t.snap().agentStep
      if (s && !steps.includes(JSON.stringify(s))) steps.push(JSON.stringify(s))
    }, 5)
    try {
      await t.cmd("connectAgent", { id: "claude", host: "dev-box" })
      await until(() => t.snap().connection.status === "online")
    } finally {
      clearInterval(watch)
    }
    assert.deepEqual(steps.map((s) => JSON.parse(s)), [{ agent: "claude", host: "dev-box", text: "Installing the Claude Code adapter on dev-box (first start)…" }])
    assert.equal(t.snap().agentStep, undefined)
    assert.ok(fs.existsSync(path.join(folder, ".b42-installed")), "installed under that computer's HOME")
    assert.deepEqual(lines(), [], "no npx")
    assert.equal(fs.existsSync(path.join(t.h.root, "postinstall-ran")), false, "no install script ran there")
    assert.equal(registry.tarballs().length, 4)
    // Always the newest: kept in the settings, said for that computer's row, used from the next
    // start, through npx.
    const toggled = (await t.cmd("setAgentLatest", { id: "claude", latest: true, host: "dev-box" })) as LocalAgent
    assert.equal(toggled.command, "npx -y @agentclientprotocol/claude-agent-acp@latest")
    assert.deepEqual(toggled.adapter, { version: "latest", tested: false, latest: true, own: false })
    // After a restart the saved agent starts again as it is now (the saved line was the pinned one).
    await t.restart()
    await until(() => lines().length === 1)
    assert.deepEqual(lines(), ["-y @agentclientprotocol/claude-agent-acp@latest"])
    await until(() => t.snap().connection.status === "online")
    // Turned off: the pin again, installed there already, and the setting gone.
    const back = (await t.cmd("setAgentLatest", { id: "claude", latest: false, host: "dev-box" })) as LocalAgent
    assert.equal(back.command, line)
    assert.deepEqual(back.adapter, { version: PINS.claude!.version, tested: !!PINS.claude!.tested, latest: false, own: false, locked: true })
    await until(() => JSON.parse(fs.readFileSync(path.join(t.h.data, "settings.json"), "utf8")).agentLatest === undefined)
    // Started again from the folder there: nothing fetched again.
    await t.restart()
    await until(() => t.snap().connection.status === "online")
    assert.equal(registry.tarballs().length, 4)
    assert.deepEqual(lines(), ["-y @agentclientprotocol/claude-agent-acp@latest"])
  } finally {
    delete process.env.B42_FAKE_SSH_PATH
    delete process.env.B42_FAKE_ADAPTER_STATE
    if (kept !== undefined) process.env.B42_PIN_CLAUDE = kept
    if (keptLock) ADAPTER_LOCKS.claude = keptLock
    await t.close()
    await registry.close()
  }
})


test("the link drops while the Claude Code adapter is installed there: said in a sentence, and npm there is ended and its folder removed once the app no longer writes its lease", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const t = boot()
  const registry = await fakeRegistry(path.join(t.h.root, "registry"), fakeAdapterPackages(path.join(t.h.root, "postinstall-ran")))
  const keptLock = ADAPTER_LOCKS.claude
  const keptLease = adapterTiming.lease
  ADAPTER_LOCKS.claude = { manifest: lockManifest("claude", PINS.claude!), lock: await registry.lockFor(lockManifest("claude", PINS.claude!)) }
  fs.writeFileSync(path.join(t.h.home, ".npmrc"), `registry=${registry.url}/\nfetch-retries=0\n`)
  const bin = path.join(t.h.root, "there-bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 })
  process.env.B42_FAKE_SSH_PATH = `${bin}${path.delimiter}${process.env.PATH}`
  const kept = process.env.B42_PIN_CLAUDE
  delete process.env.B42_PIN_CLAUDE
  const adapters = path.join(t.h.home, ".bicycle42", "adapters")
  const installing = () => (fs.existsSync(adapters) ? fs.readdirSync(adapters).filter((n) => n.startsWith(".installing-")) : [])
  adapterTiming.lease = 1500
  registry.hold()
  try {
    await t.cmd("connectSsh", "dev-box")
    const started = (t.cmd("connectAgent", { id: "claude", host: "dev-box" }) as Promise<unknown>).then(
      () => "started",
      (e: Error) => e.message,
    )
    // npm there is fetching the packages (held back by the registry) when the link drops.
    await until(() => registry.requests.some((r) => r.endsWith(".tgz")), 30_000)
    assert.equal(installing().length, 1)
    assert.ok(inFolder(adapters).length > 0, "npm runs there")
    t.h.drop()
    assert.equal(await started, "The connection to dev-box ended while installing the Claude Code adapter; it will be tried again at the next start.")
    // The helper there runs on; its watchdog ends npm and removes the folder once no lease comes.
    await until(() => inFolder(adapters).length === 0 && installing().length === 0, 15_000)
    assert.equal(fs.existsSync(path.join(adapters, adapterLock("claude")!.folder)), false)
  } finally {
    registry.release()
    adapterTiming.lease = keptLease
    delete process.env.B42_FAKE_SSH_PATH
    if (kept !== undefined) process.env.B42_PIN_CLAUDE = kept
    if (keptLock) ADAPTER_LOCKS.claude = keptLock
    t.h.up()
    await t.close()
    await registry.close()
  }
})

/** The processes whose working folder is in `dir` (Linux). */
function inFolder(dir: string): string[] {
  const found: string[] = []
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue
    try {
      if (fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(dir)) found.push(pid)
    } catch {}
  }
  return found
}
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
    const root = path.join(t.h.home, ".bicycle42", "snapshots", fs.readFileSync(path.join(t.h.data, "ssh", "owner"), "utf8"))
    const log = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root).find((d) => d.endsWith(".git"))!, "b42.json"), "utf8")) as { restores: unknown[]; turns: unknown[] }
    assert.equal(log.turns.length, 2)
    assert.equal(log.restores.length, 1)
    assert.equal(fs.existsSync(path.join(t.h.data, "snapshots")), false)
  } finally {
    await t.close()
  }
})

test("with an agent there, a turn's snapshots are one call each, and a take-back is its dry run and its run with the restore written, one call each", async () => {
  const t = boot()
  try {
    const a = path.join(t.repo, "a.css")
    fs.writeFileSync(a, "a { color: black }\n\n\n\n\nb { pad: 4px }\n")
    await t.ready()
    const first = t.note(`EDIT ${a} black red`)
    await until(() => t.notes() === "1:done")
    /** The turns written down in the folder's log there. */
    const turns = () => {
      try {
        const root = path.join(t.h.home, ".bicycle42", "snapshots", fs.readFileSync(path.join(t.h.data, "ssh", "owner"), "utf8"))
        return (JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root).find((d) => d.endsWith(".git"))!, "b42.json"), "utf8")) as { turns: unknown[] }).turns.length
      } catch {
        return 0
      }
    }
    await until(() => turns() === 1)
    // What the app sends the helper from here on (fake-ssh's `sent`), as calls with their params.
    const sent = path.join(t.h.root, "sent")
    const calls = () =>
      (fs.existsSync(sent) ? fs.readFileSync(sent, "utf8") : "")
        .split("\n")
        .flatMap((l) => {
          try {
            const m = JSON.parse(l) as { method?: string; params?: { path?: string; dir?: string; was?: unknown } }
            return m.method && m.method !== "ack" ? [m] : []
          } catch {
            return []
          }
        })
    /** The calls about the repo's folder: by name, with what they were asked of. */
    const aboutRepo = () => calls().filter((m) => m.params?.dir === t.repo || m.params?.path === t.repo).map((m) => m.method)
    fs.writeFileSync(sent, "")
    t.note(`EDIT ${a} 4px 8px`)
    await until(() => t.notes() === "1:done 2:done")
    // The run's three boundaries (it starts, the agent is handed the note, it ends), a snapshot
    // each in one call with no stat of the folder first, nor before the message goes; the turn
    // written down in one; the panel's line in one each time it is read.
    const tally = () => aboutRepo().filter((m) => m !== "ops.vcs").sort().join(" ")
    await until(() => turns() === 2)
    await until(() => tally() === "ops.editLog ops.snapshot ops.snapshot ops.snapshot").catch(() => assert.fail(tally()))
    fs.writeFileSync(sent, "")
    assert.equal(await t.cmd("takeBackNote", first, "restored"), "restored")
    assert.equal(fs.readFileSync(a, "utf8"), "a { color: black }\n\n\n\n\nb { pad: 8px }\n")
    // Whether the folder is there, the dry run, then the run (given the dry run's answer) with the
    // restore written down in the same call.
    assert.deepEqual(aboutRepo().filter((m) => m !== "ops.vcs"), ["stat", "ops.reverse", "ops.takeBack"])
    const [dry] = calls().filter((m) => m.method === "ops.reverse")
    const [run] = calls().filter((m) => m.method === "ops.takeBack")
    assert.equal(dry!.params?.was, undefined)
    assert.ok(run!.params?.was)
    fs.rmSync(sent)
  } finally {
    await t.close()
  }
})

/** The folder's log there, as it is on disk. */
function logThere(t: ReturnType<typeof boot>) {
  const root = path.join(t.h.home, ".bicycle42", "snapshots", fs.readFileSync(path.join(t.h.data, "ssh", "owner"), "utf8"))
  const file = path.join(root, fs.readdirSync(root).find((d) => d.endsWith(".git"))!, "b42.json")
  return { file, read: () => JSON.parse(fs.readFileSync(file, "utf8")) as { turns: Array<{ messages: string[] }>; restores: Array<{ told?: true; notes: string[] }> } }
}
/** That computer's git, slow while the returned flag file is there. */
function slowGit(t: ReturnType<typeof boot>, seconds: number) {
  const bin = path.join(t.h.root, "slowbin")
  const flag = path.join(t.h.root, "slow")
  fs.mkdirSync(bin, { recursive: true })
  const real = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "git")).find((f) => fs.existsSync(f))!
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n[ -f "${flag}" ] && sleep ${seconds}\nexec "${real}" "$@"\n`, { mode: 0o755 })
  process.env.B42_FAKE_SSH_PATH = `${bin}${path.delimiter}${process.env.PATH}`
  return flag
}

test("the link drops while a take-back runs there: the files and its record are both made, the reviewer is told the link dropped, and once back the note says it is taken back (the agent is never asked to reverse it again)", async () => {
  const t = boot()
  try {
    const flag = slowGit(t, 0.4)
    const a = path.join(t.repo, "a.css")
    fs.writeFileSync(a, "a { color: black }\n\n\n\n\nb { pad: 4px }\n")
    await t.ready()
    const first = t.note(`EDIT ${a} black red`)
    await until(() => t.notes() === "1:done")
    t.note(`EDIT ${a} 4px 8px`)
    await until(() => t.notes() === "1:done 2:done")
    await until(() => logThere(t).read().turns.length === 2)
    const sent = path.join(t.h.root, "sent")
    fs.writeFileSync(sent, "")
    fs.writeFileSync(flag, "")
    const taking = (t.cmd("takeBackNote", first, "restored") as Promise<unknown>).then(String, (e: Error) => e.message)
    await until(() => /"ops\.takeBack".*"was"/.test(fs.readFileSync(sent, "utf8")), 30_000)
    await sleep(100)
    t.h.drop()
    assert.equal(await taking, "The connection to dev-box ended while the app was taking this back there, so it may have been done. Look at the note again once dev-box is back.")
    // Done there all the same, with its record.
    await until(() => fs.readFileSync(a, "utf8").startsWith("a { color: black }") && logThere(t).read().restores.length === 1, 20_000)
    fs.rmSync(flag)
    fs.rmSync(sent)
    t.h.up()
    await t.cmd("reconnect")
    await until(() => t.snap().connection.status === "online", 20_000)
    await assert.rejects(t.cmd("takeBackWay", first), /This note was already taken back/)
    assert.equal(t.snap().review.notes[0]!.takenBack, "restored")
    assert.equal(fs.readFileSync(a, "utf8"), "a { color: black }\n\n\n\n\nb { pad: 8px }\n")
  } finally {
    delete process.env.B42_FAKE_SSH_PATH
    await t.close()
  }
})

test("the app starts again and the link drops while it first reads the folder's log there: the log is read again once back, nothing of it is lost, and the take-back it holds is told with the next note", async () => {
  const t = boot()
  try {
    const a = path.join(t.repo, "a.css")
    fs.writeFileSync(a, "a { color: black }\n\n\n\n\nb { pad: 4px }\n\n\n\n\nc { gap: 1px }\n")
    await t.ready()
    const first = t.note(`EDIT ${a} black red`)
    await until(() => t.notes() === "1:done")
    const second = t.note(`EDIT ${a} 4px 8px`)
    await until(() => t.notes() === "1:done 2:done")
    assert.equal(await t.cmd("takeBackNote", first, "restored"), "restored")
    await until(() => logThere(t).read().turns.length === 2 && logThere(t).read().restores.length === 1)
    // Quit; the log's file is held (a pipe nobody writes to) as the next run first reads it, and
    // the link drops then: that read fails, as any call under way does.
    const { file } = logThere(t)
    const sent = path.join(t.h.root, "sent")
    await t.restart()
    fs.renameSync(file, `${file}.real`)
    execFileSync("mkfifo", [file])
    fs.writeFileSync(sent, "")
    t.shell().page.load(`${SITE}/`)
    await until(() => /"ops\.readLog"/.test(fs.readFileSync(sent, "utf8")), 20_000)
    await sleep(200)
    t.h.drop()
    await until(() => t.snap().connection.status === "offline", 20_000)
    const fd = fs.openSync(file, "r+")
    fs.rmSync(file)
    fs.closeSync(fd)
    fs.renameSync(`${file}.real`, file)
    fs.rmSync(sent)
    t.h.up()
    await t.cmd("reconnect")
    await until(() => t.snap().connection.status === "online", 20_000)
    assert.equal(await t.cmd("takeBackWay", second), "restored", "the second note's turn is still in the history")
    t.note(`EDIT ${a} 1px 2px`)
    await until(() => /3:done/.test(t.notes()), 20_000)
    // Its turn is added to the log as it was; the take-back is kept, and told with note 3.
    await until(() => logThere(t).read().turns.length === 3)
    await until(() => logThere(t).read().restores[0]?.told === true)
    assert.equal(logThere(t).read().restores.length, 1)
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
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test("Connect pressed for the computer of the agent in use while it can't be reached: its connection is tried again, the agent and its note go on", async () => {
  const t = boot()
  try {
    await t.ready()
    t.note("SLOW 1500 then done")
    await until(() => t.notes() === "1:working")
    t.h.drop()
    await until(() => t.snap().connection.status === "offline")
    t.h.up()
    const there = (await t.cmd("connectSsh", "dev-box")) as { host: string; agents: unknown[] }
    assert.equal(there.host, "dev-box")
    assert.ok(there.agents.length)
    await until(() => t.snap().connection.status === "online")
    await until(() => t.notes() === "1:done")
  } finally {
    await t.close()
  }
})

test("a computer connected to only to list its agents is let go when the connect screen closes; the one the agent in use is on is kept", async () => {
  const t = boot()
  try {
    await t.ready()
    await until(() => t.attached() === 1)
    await t.cmd("connectSsh", "k@dev-box")
    await until(() => t.attached() === 2)
    await t.cmd("leaveSsh")
    await until(() => t.attached() === 1)
    t.note("still here")
    await until(() => t.notes() === "1:done")
  } finally {
    await t.close()
  }
})

test("the site the agent starts there opens here on 127.0.0.1; after a restart the same port there is forwarded to the same one here before the page opens; when that can't be, it is said and this computer's own site never shows", async () => {
  // The other computer is this one: its site's port is taken here too, so it opens at another.
  const site = http.createServer((_, res) => res.end("from there"))
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r))
  const port = (site.address() as net.AddressInfo).port
  process.env.B42_FAKE_SITE = `http://localhost:${port}/`
  const t = boot()
  let mine: http.Server | undefined
  try {
    await t.ready({ page: false })
    await t.cmd("startSite")
    const loads = () => t.shell().page.calls.filter(([k]) => k === "load").map(([, v]) => String(v))
    await until(() => loads().some((u) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(u)))
    const opened = loads().find((u) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(u))!
    const local = Number(new URL(opened).port)
    assert.notEqual(local, port)
    assert.equal(await (await fetch(opened)).text(), "from there")
    // Quit and start again: the page waits for the forward, then opens the same address.
    await t.restart()
    assert.equal(loads()[0], "", "nothing opened before the forward is there")
    await until(() => loads().includes(opened))
    assert.equal(await (await fetch(opened)).text(), "from there")
    // Again, with that port taken here meanwhile by a site of this computer's.
    await t.shell().core.dispose()
    await until(() => fetch(opened).then(() => false, () => true))
    mine = http.createServer((_, res) => res.end("this computer's own"))
    await new Promise<void>((r) => mine!.listen(local, "127.0.0.1", r))
    await t.restart()
    await until(() => /can't be opened here/.test(t.snap().page.error ?? ""))
    assert.match(t.snap().page.error ?? "", /dev-box.*taken on this computer/)
    assert.equal(t.snap().page.url, opened)
    assert.ok(!loads().includes(opened), "this computer's site at that address never opened")
  } finally {
    delete process.env.B42_FAKE_SITE
    mine?.close()
    site.close()
    await t.close()
  }
})

test("an address the agent there says its site is at that is not on that computer is offered, never opened by itself; Open it here opens it", async () => {
  // A name that resolves to 127.0.0.1 on this computer: it would load this computer's own site.
  process.env.B42_FAKE_SITE = "http://localtest.me:3000/"
  const t = boot()
  try {
    await t.ready({ page: false })
    await t.cmd("startSite")
    await until(() => !!t.snap().page.elsewhere)
    const loads = () => t.shell().page.calls.filter(([k]) => k === "load").map(([, v]) => String(v))
    assert.deepEqual(t.snap().page.elsewhere, { url: "http://localtest.me:3000/", computer: "dev-box" })
    assert.equal(t.snap().page.url, "")
    assert.ok(!loads().some((u) => u.includes("localtest.me")), "not opened by itself")
    assert.ok(!loads().some((u) => u.includes("127.0.0.1")), "nothing forwarded for it")
    await t.cmd("navigate", "http://localtest.me:3000/")
    assert.equal(loads().at(-1), "http://localtest.me:3000/")
    assert.equal(t.snap().page.elsewhere, undefined)
  } finally {
    delete process.env.B42_FAKE_SITE
    await t.close()
  }
})

test("each computer's sites are in a session of their own: the page moves to another computer's before anything of it loads, and back to this computer's (the one sites were always in)", async () => {
  const t = boot()
  try {
    const page = () => t.shell().page
    assert.equal(page().partition, "persist:review", "this computer's, before any agent")
    await t.ready()
    const box = page().partition
    assert.match(box, /^persist:review-[0-9a-f]{16}$/)
    // Moved before the address of the agent's computer loads (the test's page load comes after).
    const calls = page().calls.map(([k, v]) => `${k} ${String(v)}`)
    assert.ok(calls.indexOf(`partition ${box}`) >= 0 && calls.indexOf(`partition ${box}`) < calls.lastIndexOf(`load ${SITE}/`), calls.join(", "))
    // Started again: the page is made in that computer's session from the first, and not moved.
    await t.restart()
    assert.equal(page().partition, box)
    await until(() => t.snap().connection.status === "online")
    assert.ok(!page().calls.some(([k]) => k === "partition"), "not moved")
    // The same computer by another name is another session (the host as typed).
    await t.cmd("connectSsh", "k@dev-box")
    await t.cmd("connectAgent", { id: "custom", command: `"${process.execPath}" "${path.join(__dirname, "acp-agent.cjs")}" "${path.join(t.h.root, "fake-agent.json")}"`, host: "k@dev-box" })
    await until(() => page().partition !== box)
    assert.match(page().partition, /^persist:review-[0-9a-f]{16}$/)
    // No agent: this computer's again.
    await t.cmd("disconnect")
    assert.equal(page().partition, "persist:review")
  } finally {
    await t.close()
  }
})

test("the agent's own loopback however it is written (IPv4-mapped IPv6) is that computer's: forwarded from there, never this computer's", async () => {
  const site = http.createServer((_, res) => res.end("from there"))
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r))
  const port = (site.address() as net.AddressInfo).port
  process.env.B42_FAKE_SITE = `http://[::ffff:127.0.0.1]:${port}/`
  const t = boot()
  try {
    await t.ready({ page: false })
    await t.cmd("startSite")
    const loads = () => t.shell().page.calls.filter(([k]) => k === "load").map(([, v]) => String(v))
    await until(() => loads().some((u) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(u)))
    const opened = loads().find((u) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(u))!
    assert.notEqual(Number(new URL(opened).port), port)
    assert.equal(await (await fetch(opened)).text(), "from there")
    assert.ok(!loads().some((u) => u.includes("::ffff")), "the address as said never opened")
  } finally {
    delete process.env.B42_FAKE_SITE
    site.close()
    await t.close()
  }
})
