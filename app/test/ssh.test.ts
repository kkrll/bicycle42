// Another computer over ssh (src/main/ssh.ts and its helper, src/helper/helper.ts), against a
// fake ssh (test/fake-ssh.ts) whose "other computer" is this one under a home of its own: the
// helper put there and started as a daemon, every Machine call, the agent's process kept while
// the connection is down with its output read once after, too much output said as a gap, ssh's
// failures as sentences, and a port forwarded. Then the wire (after the review of Nov 21): text of
// any language whole both ways, a computer that floods the app or a helper that floods nothing,
// a helper of another protocol, a spawn whose answer was lost, stdin's writes joined, and a
// changed host key said as what it may be.
//
//   node scripts/build.mjs --tests && node --test dist/test/ssh.test.cjs
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { test } from "node:test"
import { checkHost, connectSsh, SSH_OUT_MAX, sshError, sshTiming } from "../src/main/ssh"
import { LINE_MAX, WRITE_CHUNK } from "../src/shared/wire"
import { fakeHost, sleep, until } from "./ssh-fixture"

sshTiming.retryMin = 100
sshTiming.retryMax = 300

/** A program that answers each line of its stdin with "got <line>" and says "ready" first. */
const ECHO = `process.stdout.write("ready\\n"); let b = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\\n")) >= 0) { process.stdout.write("got " + b.slice(0, i) + "\\n"); b = b.slice(i + 1) } })`

function reader(stream: NodeJS.ReadableStream) {
  let text = ""
  // Decoded as a stream: a character cut between two reads is read whole.
  stream.setEncoding("utf8")
  stream.on("data", (d: string) => void (text += d))
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
  // An upload cut short long ago left its temp file; one under way now is left alone.
  const cut = path.join(helperDir(h), "helper-0123456789ab.js.4242.tmp")
  const now = path.join(helperDir(h), "helper-0123456789ab.js.4243.tmp")
  fs.writeFileSync(cut, "// half")
  fs.writeFileSync(now, "// half")
  fs.utimesSync(cut, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000))
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
      assert.ok(!files.includes(path.basename(cut)) && files.includes(path.basename(now)), files.join(" "))
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

// ── the wire ───────────────────────────────────────────────────────────────────────────────────

/** How many processes run with `marker` in their command line. */
const count = (marker: string) =>
  fs.readdirSync("/proc").filter((pid) => {
    try {
      return /^\d+$/.test(pid) && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").includes(marker)
    } catch {
      return false
    }
  }).length

test("text of any language goes whole both ways: a file of 200 KB of é written and read, a command's input and output, and the agent's stdin and stdout, with no U+FFFD anywhere", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const text = "é".repeat(100_000) + "中文🚲".repeat(20_000) + "\n"
      const file = path.join(h.home, "utf8.txt")
      await m.writeFile(file, text)
      assert.equal(fs.readFileSync(file, "utf8"), text, "on disk there as it was sent")
      fs.writeFileSync(path.join(h.home, "there.txt"), text)
      assert.equal(await m.readFile(path.join(h.home, "there.txt")), text, "read as it is there")
      const r = await m.run("cat", [], { input: text })
      assert.equal(r.out, text)
      // The agent: lines of many-byte characters out of it, cut wherever its pipe cuts them.
      const c = m.spawn(process.execPath, ["-e", ECHO], { cwd: h.home })
      const out = reader(c.stdout)
      await until(() => out().includes("ready"))
      const line = "ü🚲".repeat(50_000)
      c.stdin.write(`${line}\n`)
      await until(() => out().includes("got "))
      await until(() => out().endsWith("\n") && out().length > line.length)
      assert.equal(out(), `ready\ngot ${line}\n`)
      assert.ok(!out().includes("�"))
      c.kill()
      await c.exited
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

/** An ssh whose "other computer" answers the way `how` says: it passes the connecting steps
 *  (probe, daemon) unless told not to, and on the attach channel does what is asked. */
function scriptedSsh(h: { root: string }, how: "flood" | "protocol-none" | "protocol-2" | "probe-flood") {
  const js = path.join(h.root, "scripted-ssh.cjs")
  fs.writeFileSync(
    js,
    `const how = ${JSON.stringify(how)}
const a = process.argv.slice(2)
const cmd = a[a.length - 1]
if (a.includes("-O")) process.exit(0)
const flood = () => {
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x41)
  const go = () => { while (process.stdout.write(chunk)); process.stdout.once("drain", go) }
  go()
}
if (/ attach$/.test(cmd)) {
  // Answers hello, then info (the app is connected), then floods.
  const protocol = how === "protocol-none" ? {} : { protocol: how === "protocol-2" ? 2 : 1 }
  let buf = ""
  process.stdin.on("data", (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf("\\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (m.method === "hello") process.stdout.write(JSON.stringify({ id: m.id, result: { version: "x", ...protocol, pid: 1, procs: [] } }) + "\\n")
      if (m.method === "info") {
        process.stdout.write(JSON.stringify({ id: m.id, result: { home: "/home/u", platform: "linux", hostname: "h", devNull: "/dev/null" } }) + "\\n")
        if (how === "flood") flood()
      }
    }
  })
  process.stdin.on("end", () => process.exit(0))
} else if (/NONODE/.test(cmd)) {
  if (how === "probe-flood") flood()
  else process.stdout.write('B42 {"node":"/usr/bin/node","version":"22.0.0","platform":"linux","have":true,"dir":"ok"}\\n')
} else if (/ daemon$/.test(cmd)) process.stdout.write("B42 READY\\n")
else process.exit(0)
`,
  )
  const bin = path.join(h.root, `scripted-${how}`)
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 })
  return bin
}

test("a computer that sends bytes with no line's end: the app holds one line's worth at most, lets go of the link with a sentence, and its memory stays bounded; a connecting step that prints without end is stopped too", async () => {
  const h = fakeHost()
  try {
    const before = process.memoryUsage().rss
    let peak = before
    const watch = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20)
    const m = await connectSsh({ host: "hostile-box", dataDir: h.data, ssh: scriptedSsh(h, "flood") })
    try {
      await until(() => m.reach().status === "down", 20_000)
      const reach = m.reach() as { error: string }
      assert.match(reach.error, /hostile-box sent the app a message of .* and more, longer than any its helper sends \(64 MiB\): the app let go of the connection/)
    } finally {
      clearInterval(watch)
      await m.close()
    }
    // One line of 64 MiB, held as its pieces, and a few of the pipe's reads: never the flood.
    assert.ok(peak - before < 4 * LINE_MAX, `grew ${Math.round((peak - before) / 1048576)} MB`)
    await assert.rejects(connectSsh({ host: "hostile-box", dataDir: h.data, ssh: scriptedSsh(h, "probe-flood") }), (e: Error) => e.message.includes(`printed more than ${SSH_OUT_MAX / 1048576} MiB, which no step of connecting does`))
  } finally {
    await h.end()
  }
})

test("a helper that does not speak the app's protocol is refused with a sentence, and nothing is asked of it", async () => {
  const h = fakeHost()
  try {
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data, ssh: scriptedSsh(h, "protocol-none") }), /helper on dev-box speaks no protocol the app knows, and this app speaks version 1\. Quit the app's other versions, or move ~\/\.bicycle42 away on dev-box/)
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data, ssh: scriptedSsh(h, "protocol-2") }), /helper on dev-box speaks version 2 of its protocol, and this app speaks version 1/)
  } finally {
    await h.end()
  }
})

test("the helper itself: a connection that sends a line longer than any the app sends is dropped and the helper goes on; one that reads nothing is dropped once it has taken nothing for a while; one that reads slowly is not", async () => {
  const h = fakeHost()
  const dir = helperDir(h)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const js = path.join(dir, "helper-wiretest.js")
  fs.copyFileSync(bundle(), js)
  const sock = path.join(dir, "helper-wiretest.sock")
  const log = () => fs.readFileSync(path.join(dir, "helper.log"), "utf8")
  execFileSync(process.execPath, [js, "daemon"], { env: { ...process.env, HOME: h.home, B42_HELPER_WRITE_MAX: "65536", B42_HELPER_WRITE_HARD: String(64 << 20), B42_HELPER_STALL_MS: "400" }, encoding: "utf8" })
  /** A connection to it, with what it read. */
  const open = () => {
    const s = net.connect(sock)
    let got = Buffer.alloc(0)
    let closed = false
    s.on("data", (d: Buffer) => void (got = Buffer.concat([got, d])))
    s.on("close", () => void (closed = true))
    s.on("error", () => undefined)
    return { s, got: () => got, closed: () => closed }
  }
  const big = (marker: string) => ({ program: process.execPath, args: ["-e", `process.stdout.write("x".repeat(1 << 20)); setInterval(() => {}, 1e6) // ${marker}`], cwd: h.home, key: marker })
  try {
    // A line of LINE_MAX and more.
    const flood = open()
    const mb = Buffer.alloc(1024 * 1024, 0x41)
    // Until it is dropped: a write the helper will never take waits for nothing after that.
    for (let i = 0; i <= LINE_MAX / mb.length + 1 && !flood.closed(); i++)
      await new Promise<void>((r) => {
        if (flood.s.write(mb)) return r()
        flood.s.once("drain", () => r())
        flood.s.once("close", () => r())
      })
    await until(() => flood.closed())
    assert.match(log(), /a connection sent a line of .* longer than any the app sends: dropped/)
    const ping = open()
    ping.s.write(`${JSON.stringify({ id: 1, method: "ping" })}\n`)
    await until(() => ping.got().includes(0x0a))
    assert.match(ping.got().toString(), /"protocol":1/)
    ping.s.destroy()
    // One that reads nothing: its 1 MiB is far more than 64 KB waiting.
    const deaf = open()
    deaf.s.pause()
    deaf.s.write(`${JSON.stringify({ id: 1, method: "spawn", params: big(`deaf-${process.pid}`) })}\n`)
    await until(() => /reads nothing: dropped/.test(log()), 10_000)
    // One that reads, slowly: a pause after each read, shorter than the helper waits.
    const slow = open()
    slow.s.on("data", () => (slow.s.pause(), setTimeout(() => slow.s.resume(), 60)))
    slow.s.write(`${JSON.stringify({ id: 1, method: "spawn", params: big(`slow-${process.pid}`) })}\n`)
    // All of it: 1 MiB as base64, in data messages.
    const read = () =>
      slow
        .got()
        .toString()
        .split("\n")
        // Whole lines only: the last may be on its way.
        .slice(0, -1)
        .filter((l) => l.includes('"ev":"data"'))
        .reduce((n, l) => n + Buffer.from(JSON.parse(l).data, "base64").length, 0)
    await until(() => read() >= 1 << 20, 20_000)
    assert.equal(slow.closed(), false)
    assert.equal(log().match(/reads nothing: dropped/g)!.length, 1, "only the one that read nothing")
    slow.s.destroy()
    deaf.s.destroy()
  } finally {
    await endHelpers(h)
    await h.end()
  }
})

test("a spawn whose answer was lost when the link dropped is the same process once the app is back, read from its start; one the app ended meanwhile is ended there", async () => {
  const h = fakeHost()
  const mute = path.join(h.root, "mute")
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const marker = `lost-answer-${process.pid}`
      fs.writeFileSync(mute, "")
      const c = m.spawn(process.execPath, ["-e", ECHO, marker], { cwd: h.home })
      const out = reader(c.stdout)
      // It runs there; the app never heard so.
      await until(() => count(marker) === 1)
      h.drop()
      await until(() => m.reach().status === "down")
      fs.rmSync(mute)
      h.up()
      await until(() => out().includes("ready"))
      c.stdin.write("still one\n")
      await until(() => out().includes("got still one"))
      assert.equal(out(), "ready\ngot still one\n", "its output from the start, once")
      assert.equal(count(marker), 1, "one process, not two")

      // Ended here while its start was not answered: ended there once the app is back.
      const gone = `ended-starting-${process.pid}`
      fs.writeFileSync(mute, "")
      const d = m.spawn(process.execPath, ["-e", ECHO, gone], { cwd: h.home })
      await until(() => count(gone) === 1)
      await d.kill()
      h.drop()
      await until(() => m.reach().status === "down")
      fs.rmSync(mute)
      h.up()
      await until(() => count(gone) === 0)
      assert.equal((await d.exited).signal, "SIGTERM")
      // The first works on.
      c.stdin.write("after\n")
      await until(() => out().includes("got after"))
      c.kill()
      await c.exited
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

test("what is written to the agent while a write is on its way goes in one write, not one each: 20 lines in 2 writes; a write larger than a piece goes in pieces, every byte once", async () => {
  const h = fakeHost()
  const sent = path.join(h.root, "sent")
  const writes = () => (fs.existsSync(sent) ? fs.readFileSync(sent, "utf8").split("\n").filter((l) => l.includes('"method":"write"')).length : 0)
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const c = m.spawn(process.execPath, ["-e", ECHO], { cwd: h.home })
      const out = reader(c.stdout)
      await until(() => out().includes("ready"))
      fs.writeFileSync(sent, "")
      for (let i = 0; i < 20; i++) c.stdin.write(`line ${i}\n`)
      await until(() => out().includes("got line 19"))
      assert.deepEqual(
        out().split("\n").filter((l) => l.startsWith("got ")),
        Array.from({ length: 20 }, (_, i) => `got line ${i}`),
      )
      assert.equal(writes(), 2, "the first at once, the other 19 joined")
      c.kill()
      await c.exited

      // 9 MB in one write: pieces of WRITE_CHUNK, and what arrives hashes the same.
      const crypto = await import("node:crypto")
      const COUNT = `const h = require("crypto").createHash("sha1"); let n = 0; process.stdout.write("ready\\n"); process.stdin.on("data", (d) => { h.update(d); n += d.length; if (d[d.length - 1] === 10) process.stdout.write(n + " " + h.digest("hex") + "\\n") })`
      const k = m.spawn(process.execPath, ["-e", COUNT], { cwd: h.home })
      const kOut = reader(k.stdout)
      await until(() => kOut().includes("ready"))
      fs.writeFileSync(sent, "")
      const blob = Buffer.from(`${"é🚲".repeat(1_500_000)}\n`)
      k.stdin.write(blob)
      await until(() => /\d+ [0-9a-f]{40}/.test(kOut()), 20_000)
      assert.equal(kOut().trim().split("\n").at(-1), `${blob.length} ${crypto.createHash("sha1").update(blob).digest("hex")}`)
      assert.equal(writes(), Math.ceil(blob.length / WRITE_CHUNK))
      k.kill()
      await k.exited
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

test("a host key that changed is said as what it may be (an attack), never with \"answer yes\"; one not known yet is said as before", () => {
  const changed = `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
Someone could be eavesdropping on you right now (man-in-the-middle attack)!
The fingerprint for the ED25519 key sent by the remote host is
SHA256:AAAA.
Offending ED25519 key in /home/u/.ssh/known_hosts:12
Host key for dev-box has changed and you have requested strict checking.
Host key verification failed.`
  const said = sshError("dev-box", changed, 255)
  assert.match(said, /dev-box's host key has changed since this computer last connected to it\. That can mean someone is between you and dev-box \(an attack\)/)
  assert.match(said, /Don't connect until whoever runs dev-box has told you its new key's fingerprint/)
  assert.doesNotMatch(said, /answer yes/)
  const unknown = sshError("dev-box", "No ED25519 host key is known for dev-box and you have requested strict checking.\nHost key verification failed.", 255)
  assert.match(unknown, /dev-box's host key is not known on this computer yet\. Run `ssh dev-box` once in a terminal, check the fingerprint and answer yes/)
  assert.doesNotMatch(unknown, /changed/)
})
