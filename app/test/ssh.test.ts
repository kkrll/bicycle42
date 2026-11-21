// Another computer over ssh (src/main/ssh.ts and its helper, src/helper/helper.ts), against a
// fake ssh (test/fake-ssh.ts) whose "other computer" is this one under a home of its own: the
// helper put there and started as a daemon, every Machine call, the agent's process kept while
// the connection is down with its output read once after, too much output said as a gap, ssh's
// failures as sentences, and a port forwarded.
//
//   node scripts/build.mjs --tests && node --test dist/test/ssh.test.cjs
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { test } from "node:test"
import { checkHost, connectSsh, sshError, sshTiming } from "../src/main/ssh"
import { fakeHost, sleep, until } from "./ssh-fixture"

sshTiming.retryMin = 100
sshTiming.retryMax = 300

/** A program that answers each line of its stdin with "got <line>" and says "ready" first. */
const ECHO = `process.stdout.write("ready\\n"); let b = ""; process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\\n")) >= 0) { process.stdout.write("got " + b.slice(0, i) + "\\n"); b = b.slice(i + 1) } })`

function reader(stream: NodeJS.ReadableStream) {
  let text = ""
  stream.on("data", (d: Buffer) => void (text += d.toString()))
  return () => text
}

test("connect: the helper is put there and runs as a daemon; files, commands, the PATH and home are the other computer's", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      assert.equal(m.local, false)
      assert.equal(m.where, "dev-box")
      assert.equal(m.home, h.home)
      assert.equal(m.reach().status, "up")
      const helpers = fs.readdirSync(path.join(h.home, ".bicycle42"))
      assert.ok(helpers.some((f) => /^helper-[0-9a-f]{12}\.js$/.test(f)), helpers.join(" "))
      assert.ok(helpers.some((f) => /^helper-[0-9a-f]{12}\.sock$/.test(f)), "listening on its socket")
      // Files.
      const dir = path.join(h.home, "work")
      await m.mkdir(path.join(dir, "a", "b"))
      await m.writeFile(path.join(dir, "a", "x.txt"), "hello\n", 0o600)
      assert.equal(await m.readFile(path.join(dir, "a", "x.txt")), "hello\n")
      assert.equal((fs.statSync(path.join(dir, "a", "x.txt")).mode & 0o777).toString(8), "600")
      const st = await m.stat(path.join(dir, "a", "x.txt"))
      assert.equal(st.kind, "file")
      assert.equal(st.size, 6)
      assert.ok(st.mtimeMs > 0)
      fs.symlinkSync(path.join(dir, "a"), path.join(dir, "link"))
      assert.equal((await m.lstat(path.join(dir, "link"))).kind, "link")
      assert.deepEqual((await m.readdir(dir)).sort((p, q) => p.name.localeCompare(q.name)), [{ name: "a", kind: "dir" }, { name: "link", kind: "link" }])
      assert.equal(await m.realpath(path.join(dir, "link")), path.join(dir, "a"))
      await m.rename(path.join(dir, "a", "x.txt"), path.join(dir, "a", "y.txt"))
      await assert.rejects(m.stat(path.join(dir, "a", "x.txt")), (e: NodeJS.ErrnoException) => e.code === "ENOENT")
      await m.rm(path.join(dir, "a"))
      assert.equal(fs.existsSync(path.join(dir, "a")), false)
      // Commands: env laid over theirs, a prefix cleared, stdin, an exit code, a signal.
      process.env.GIT_SOMETHING = "leaks"
      const r = await m.run("sh", ["-c", 'cat; echo "[$FOO][$GIT_SOMETHING][$HOME]"; exit 3'], { input: "in\n", env: { FOO: "bar" }, clearPrefix: "GIT_" })
      delete process.env.GIT_SOMETHING
      assert.deepEqual([r.code, r.signal, r.out], [3, null, `in\n[bar][][${h.home}]\n`])
      const slow = await m.run("sleep", ["5"], { timeout: 200 })
      assert.equal(slow.code, null)
      assert.equal(slow.signal, "SIGTERM")
      const none = await m.run("no-such-program-b42", [])
      assert.equal(none.error?.code, "ENOENT")
      assert.ok(await m.which("sh"))
      assert.equal(await m.which("no-such-program-b42"), undefined)
      assert.ok((await m.agentEnv()).PATH)
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

test("a process there: its streams, its exit, and kill ends it with what it started", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const c = m.spawn(process.execPath, ["-e", ECHO], { cwd: h.home })
      const out = reader(c.stdout)
      await until(() => out().includes("ready"))
      c.stdin.write("one\ntwo\n")
      await until(() => out().includes("got two"))
      const pidFile = path.join(h.root, "child.pid")
      const parent = m.spawn("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: h.home })
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "")
      const grandchild = Number(fs.readFileSync(pidFile, "utf8"))
      parent.kill()
      const ended = await parent.exited
      assert.equal(ended.signal, "SIGTERM")
      await until(() => {
        try {
          process.kill(grandchild, 0)
          return false
        } catch {
          return true
        }
      })
      c.stdin.end()
      c.kill()
      await c.exited
      const bad = m.spawn("no-such-program-b42", [])
      assert.equal((await bad.exited).error?.code, "ENOENT")
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

test("the connection drops: the process goes on there; what it wrote meanwhile is read once, and what was written to it waits and goes once", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    const reaches: string[] = []
    m.onReach!((r) => reaches.at(-1) !== r.status && reaches.push(r.status))
    try {
      // Says a numbered line every 20 ms, and answers its stdin.
      const c = m.spawn(process.execPath, ["-e", `let n = 0; setInterval(() => process.stdout.write("tick " + n++ + "\\n"), 20); ${ECHO}`], { cwd: h.home })
      const out = reader(c.stdout)
      await until(() => out().includes("tick 3"))
      h.drop()
      await until(() => m.reach().status === "down")
      assert.match(m.reach().status === "down" ? (m.reach() as { error: string }).error : "", /dev-box/)
      // Written while away: waits here.
      c.stdin.write("while away\n")
      await sleep(400)
      const seenAway = out()
      h.up()
      await until(() => m.reach().status === "up")
      await until(() => out().includes("got while away"))
      const ticks = out()
        .split("\n")
        .filter((l) => l.startsWith("tick "))
        .map((l) => Number(l.slice(5)))
      // Every tick once, in order, none missing: what was written while away came after.
      assert.deepEqual(ticks, ticks.map((_, i) => i))
      assert.ok(ticks.length > seenAway.split("\n").filter((l) => l.startsWith("tick ")).length)
      assert.equal(out().split("got while away").length, 2, "said once")
      assert.deepEqual(reaches.slice(0, 2), ["down", "up"])
      c.kill()
      await c.exited
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

test("more output while away than the helper keeps: the oldest goes, the app is told of the gap, and reads on from a line's start", async () => {
  const h = fakeHost()
  process.env.B42_HELPER_OUT_MAX = "4096"
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const c = m.spawn(process.execPath, ["-e", `process.stdout.write("ready\\n"); process.stdin.once("data", () => setTimeout(() => { for (let i = 0; i < 2000; i++) process.stdout.write("line " + i + " " + "x".repeat(20) + "\\n") }, 300))`], { cwd: h.home })
      let gaps = 0
      c.onGap!(() => gaps++)
      const out = reader(c.stdout)
      await until(() => out().includes("ready"))
      h.drop()
      await until(() => m.reach().status === "down")
      c.stdin.write("go\n")
      // The write waits for the connection; the output is made once it is there… so drop again
      // right after it goes, to make the output come while away.
      h.up()
      await until(() => m.reach().status === "up")
      await sleep(50)
      h.drop()
      await until(() => m.reach().status === "down")
      await sleep(500)
      h.up()
      await until(() => out().includes("line 1999 "))
      const lines = out().split("\n").filter(Boolean)
      // Every line read is whole.
      assert.ok(lines.every((l) => l === "ready" || /^line \d+ x{20}$/.test(l)), lines.find((l) => l !== "ready" && !/^line \d+ x{20}$/.test(l)))
      assert.ok(lines.length < 2001, "some were dropped there")
      assert.equal(gaps, 1, `a gap (${lines.length} lines read)`)
      c.kill()
    } finally {
      await m.close()
    }
  } finally {
    delete process.env.B42_HELPER_OUT_MAX
    await h.end()
  }
})

test("the site there: its port is forwarded here, to another port when that one is taken here", async () => {
  const h = fakeHost()
  // The "other computer" is this one: its server's port is taken here too.
  const server = http.createServer((_, res) => res.end("from there"))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    let local = 0
    try {
      local = await m.forward(port, "127.0.0.1")
      assert.notEqual(local, port)
      assert.equal(await (await fetch(`http://127.0.0.1:${local}/`)).text(), "from there")
      assert.equal(await m.forward(port, "127.0.0.1"), local, "once")
    } finally {
      await m.close()
    }
    // Torn down with the connection.
    await until(() => fetch(`http://127.0.0.1:${local}/`).then(() => false, () => true))
  } finally {
    server.close()
    await h.end()
  }
})

test("what goes wrong is said in a sentence: no node there, a host key not known, a password-only login, no such host, not a host", async () => {
  const h = fakeHost()
  try {
    // A PATH with a shell and its tools, and no node.
    const bare = path.join(h.root, "bare-bin")
    fs.mkdirSync(bare)
    for (const tool of ["sh", "tail", "mkdir", "cat", "mv"]) fs.symlinkSync(fs.realpathSync(`/usr/bin/${tool}`), path.join(bare, tool))
    process.env.B42_FAKE_SSH_PATH = bare
    // …and a login shell that does not find one either.
    fs.writeFileSync(path.join(bare, "login"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    process.env.B42_FAKE_SSH_SHELL = path.join(bare, "login")
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), /Node 18 or newer on dev-box.*`node` was not found there/)
    delete process.env.B42_FAKE_SSH_PATH
    delete process.env.B42_FAKE_SSH_SHELL
    process.env.B42_FAKE_SSH_FAIL = "Host key verification failed."
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), /dev-box's host key is not known.*Run `ssh dev-box` once in a terminal/)
    process.env.B42_FAKE_SSH_FAIL = "me@dev-box: Permission denied (publickey,password)."
    await assert.rejects(connectSsh({ host: "me@dev-box", dataDir: h.data }), /did not accept a key.*does not type passwords/)
    delete process.env.B42_FAKE_SSH_FAIL
    assert.match(sshError("nope", "ssh: Could not resolve hostname nope: Name or service not known", 255), /no computer called nope/)
    assert.throws(() => checkHost("-oProxyCommand=touch /tmp/x"), /not a host/)
    assert.throws(() => checkHost("a b"), /not a host/)
    assert.equal(checkHost(" me@dev-box "), "me@dev-box")
  } finally {
    delete process.env.B42_FAKE_SSH_PATH
    delete process.env.B42_FAKE_SSH_SHELL
    delete process.env.B42_FAKE_SSH_FAIL
    await h.end()
  }
})

// ── after the review ────────────────────────────────────────────────────────────────────────────

const bundle = () => path.join(__dirname, "..", "helper.cjs")
const helperDir = (h: { home: string }) => path.join(h.home, ".bicycle42")
/** Ends the helpers there (as fixture.end does), keeping their files. */
async function endHelpers(h: { home: string }) {
  for (const f of fs.readdirSync(helperDir(h)))
    if (f.endsWith(".sock"))
      await new Promise<void>((resolve) => {
        const s = net.connect(path.join(helperDir(h), f))
        s.on("connect", () => s.write(`${JSON.stringify({ id: 1, method: "shutdown" })}\n`))
        s.on("data", () => (s.destroy(), setTimeout(resolve, 300)))
        s.on("error", () => resolve())
      })
}
/** Whether a process whose command line has `marker` in it runs. */
const running = (marker: string) =>
  fs.readdirSync("/proc").some((pid) => {
    try {
      return /^\d+$/.test(pid) && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").includes(marker)
    } catch {
      return false
    }
  })
const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8)

test("another version of the app connects to the same computer: each has its own helper there, and the first one's agent works on", async () => {
  const h = fakeHost()
  const other = path.join(h.root, "helper-other.cjs")
  fs.writeFileSync(other, `${fs.readFileSync(bundle(), "utf8")}\n// another version\n`)
  // A third version's file, long unused, with no helper running: it goes.
  fs.mkdirSync(helperDir(h), { recursive: true, mode: 0o700 })
  const stale = path.join(helperDir(h), "helper-0123456789ab.js")
  fs.writeFileSync(stale, "// old")
  fs.utimesSync(stale, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000))
  try {
    const a = await connectSsh({ host: "dev-box", dataDir: path.join(h.root, "dataA") })
    const b = await connectSsh({ host: "dev-box", dataDir: path.join(h.root, "dataB"), helper: other })
    try {
      // Started before the other version came, too.
      const c = a.spawn(process.execPath, ["-e", ECHO], { cwd: h.home })
      const out = reader(c.stdout)
      await until(() => out().includes("ready"))
      let ended: unknown
      void c.exited.then((e) => (ended = e))
      const b2 = await connectSsh({ host: "dev-box", dataDir: path.join(h.root, "dataC"), helper: other })
      await b2.close()
      await sleep(300)
      c.stdin.write("still here\n")
      await until(() => out().includes("got still here"))
      assert.equal(ended, undefined)
      assert.equal(a.reach().status, "up")
      // The other version's helper works as well.
      const d = b.spawn(process.execPath, ["-e", ECHO], { cwd: h.home })
      const dOut = reader(d.stdout)
      await until(() => dOut().includes("ready"))
      const files = fs.readdirSync(helperDir(h))
      assert.equal(files.filter((f) => /^helper-.*\.sock$/.test(f)).length, 2, files.join(" "))
      assert.ok(!files.includes("helper-0123456789ab.js"), "the long-unused version's file went")
      void d.kill()
    } finally {
      await a.close()
      await b.close()
    }
  } finally {
    await h.end()
  }
})

test("the same computer typed two ways in one run: neither connection ends the other's agent; a later run ends what an earlier one left there", async () => {
  const h = fakeHost()
  try {
    const a = await connectSsh({ host: "dev-box", dataDir: h.data, launch: 1000 })
    const c = a.spawn(process.execPath, ["-e", ECHO], { cwd: h.home })
    const out = reader(c.stdout)
    await until(() => out().includes("ready"))
    let ended: { signal: string | null } | undefined
    void c.exited.then((e) => (ended = e))
    const b = await connectSsh({ host: "k@dev-box", dataDir: h.data, launch: 1000 })
    await sleep(300)
    c.stdin.write("one\n")
    await until(() => out().includes("got one"))
    assert.equal(ended, undefined, "the other connection of this run left it alone")
    await b.close()
    assert.equal(ended, undefined)
    // The next run of the app (this one went without ending it: a crash): it is ended.
    const later = await connectSsh({ host: "dev-box", dataDir: h.data, launch: 2000 })
    await until(() => ended !== undefined)
    assert.equal(ended!.signal, "SIGTERM")
    await later.close()
    await a.close()
  } finally {
    await h.end()
  }
})

test("the helper's file there is used only when it is whole: one cut short is put there again, and nothing is left half-written", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    await m.close()
    await endHelpers(h)
    const js = fs.readdirSync(helperDir(h)).find((f) => f.endsWith(".js"))!
    fs.writeFileSync(path.join(helperDir(h), js), fs.readFileSync(bundle()).subarray(0, 9000))
    const again = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      assert.equal(again.reach().status, "up")
      assert.ok(fs.readFileSync(path.join(helperDir(h), js)).equals(fs.readFileSync(bundle())), "the whole file")
      assert.deepEqual(
        fs.readdirSync(helperDir(h)).filter((f) => f.endsWith(".tmp")),
        [],
      )
    } finally {
      await again.close()
    }
  } finally {
    await h.end()
  }
})

test("the folders of the connection are this user's only: made 0700, loose ones made so, a link refused with a sentence; the same for ~/.bicycle42 there", async () => {
  const h = fakeHost()
  try {
    fs.mkdirSync(path.join(h.data, "ssh"))
    fs.chmodSync(path.join(h.data, "ssh"), 0o755)
    fs.mkdirSync(helperDir(h))
    fs.chmodSync(helperDir(h), 0o755)
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    await m.close()
    assert.equal(mode(path.join(h.data, "ssh")), "700")
    assert.equal(mode(helperDir(h)), "700")
    assert.equal(mode(path.join(h.data, "ssh", "owner")), "600")
    // Another place's folder, linked in: ssh would trust a connection in it.
    const linked = path.join(h.root, "data-linked")
    fs.mkdirSync(linked)
    fs.mkdirSync(path.join(h.root, "elsewhere"))
    fs.symlinkSync(path.join(h.root, "elsewhere"), path.join(linked, "ssh"))
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: linked }), /ssh connections in .* which is not a folder/)
    await endHelpers(h)
    // ~/.bicycle42 there a link.
    fs.renameSync(helperDir(h), path.join(h.home, "b42-real"))
    fs.symlinkSync(path.join(h.home, "b42-real"), helperDir(h))
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), /~\/\.bicycle42 on dev-box is not a folder/)
    fs.rmSync(helperDir(h))
    fs.renameSync(path.join(h.home, "b42-real"), helperDir(h))
  } finally {
    await h.end()
  }
})

test("the daemon never takes away the socket of a helper that answers slowly, and takes over one whose helper is gone", async () => {
  const h = fakeHost()
  const dir = helperDir(h)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const js = path.join(dir, "helper-sockettest.js")
  fs.copyFileSync(bundle(), js)
  const sock = path.join(dir, "helper-sockettest.sock")
  const env = { ...process.env, HOME: h.home, B42_HELPER_START_MS: "1500" }
  const daemon = () => {
    try {
      return execFileSync(process.execPath, [js, "daemon"], { env, encoding: "utf8" })
    } catch (err) {
      return String((err as { stdout?: string }).stdout)
    }
  }
  // A helper that is busy: it takes the connection and answers nothing.
  const busy = net.createServer(() => undefined)
  await new Promise<void>((r) => busy.listen(sock, r))
  try {
    assert.match(daemon(), /^B42 FAILED the app's helper there is running and does not answer/m)
    assert.ok(fs.existsSync(sock), "its socket is still there")
    await new Promise((r) => busy.close(r))
    // A helper that died without taking its socket away.
    const dead = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => process.stdout.write("up\\n"))`], { stdio: ["ignore", "pipe", "ignore"] })
    await new Promise((r) => dead.stdout!.once("data", r))
    dead.kill("SIGKILL")
    await new Promise((r) => dead.once("exit", r))
    assert.ok(fs.existsSync(sock), "a socket with nothing behind it")
    assert.match(daemon(), /^B42 READY$/m)
  } finally {
    busy.close()
    await endHelpers(h)
    await h.end()
  }
})

test("closing ends what the connection started there, also a process whose start had not been answered yet; one left with no app attached is ended after its lease", async () => {
  const h = fakeHost()
  process.env.B42_HELPER_LEASE_MS = "700"
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    const marker = `31.${process.pid}1`
    m.spawn("sh", ["-c", `exec sleep ${marker}`], { cwd: h.home })
    await m.close()
    await sleep(100)
    assert.equal(running(`sleep ${marker}`), false, "ended before close was done")
    // Left by an app that went without a word (the connection dropped, and it never came back).
    const n = await connectSsh({ host: "dev-box", dataDir: h.data })
    const left = `32.${process.pid}1`
    const c = n.spawn("sh", ["-c", `exec sleep ${left}`], { cwd: h.home })
    await until(() => running(`sleep ${left}`))
    h.drop()
    await sleep(300)
    assert.equal(running(`sleep ${left}`), true, "within its lease it works on")
    await until(() => !running(`sleep ${left}`), 5000)
    h.up()
    const e = await c.exited
    assert.ok(e.error || e.signal, JSON.stringify(e))
    await n.close()
  } finally {
    delete process.env.B42_HELPER_LEASE_MS
    await h.end()
  }
})

test("the shared connection is made once when two calls need it at the same time; a site on the other computer's [::1] is forwarded; a port asked for that is taken here is said", async () => {
  const h = fakeHost()
  const v6 = http.createServer((_, res) => res.end("from ::1"))
  const listening = await new Promise<boolean>((r) => {
    v6.once("error", () => r(false))
    v6.listen(0, "::1", () => r(true))
  })
  const taken = net.createServer()
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r))
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const masters = () => fs.readFileSync(path.join(h.root, "masters"), "utf8").trim().split("\n").length
      fs.rmSync(path.join(h.root, "master"))
      const before = masters()
      const servers = await Promise.all(
        [0, 1].map(
          () =>
            new Promise<http.Server>((r) => {
              const s = http.createServer((_, res) => res.end("x"))
              s.listen(0, "127.0.0.1", () => r(s))
            }),
        ),
      )
      await Promise.all(servers.map((s) => m.forward((s.address() as net.AddressInfo).port, "127.0.0.1")))
      assert.equal(masters(), before + 1, "one ssh -N")
      for (const s of servers) s.close()
      if (listening) {
        const local = await m.forward((v6.address() as net.AddressInfo).port, "::1")
        assert.equal(await (await fetch(`http://127.0.0.1:${local}/`)).text(), "from ::1")
      }
      await assert.rejects(m.forward(4321, "127.0.0.1", (taken.address() as net.AddressInfo).port), /is taken on this computer/)
    } finally {
      await m.close()
    }
  } finally {
    v6.close()
    taken.close()
    await h.end()
  }
})
