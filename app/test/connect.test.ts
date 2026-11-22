// Connecting to another computer (src/main/ssh.ts, src/helper/helper.ts), through the fake ssh and
// the real helper bundle: whatever the login shell there (one that reads only plain words, as
// fish's and csh's syntax leaves of sh's, one with a noisy profile, Windows's), with two nodes,
// a folder that can't be written, a home too long for a socket, a helper that stops as it starts,
// a socket that is not the helper's; and a reconnect that attaches first, starting the helper
// only when none runs.
//
//   node scripts/build.mjs --tests && node --test dist/test/connect.test.cjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { failure, socketTooLong } from "../src/helper/failure"
import { connectSsh, nodesSaid, probeScript, saysWindows, sshTiming } from "../src/main/ssh"
import { fakeHost, until, type FakeHost } from "./ssh-fixture"

sshTiming.retryMin = 100
sshTiming.retryMax = 300

const helperDir = (h: { home: string }) => path.join(h.home, ".bicycle42")
/** The command lines run there since the last look. */
function commands(h: FakeHost) {
  let seen = 0
  return () => {
    const all = fs.existsSync(path.join(h.root, "commands")) ? fs.readFileSync(path.join(h.root, "commands"), "utf8").split("\n").filter(Boolean) : []
    const now = all.slice(seen)
    seen = all.length
    return now.map((c) => (/ attach$/.test(c) ? "attach" : c))
  }
}
/** Ends the helpers there, keeping their files. */
async function endHelpers(h: { home: string }) {
  for (const f of fs.existsSync(helperDir(h)) ? fs.readdirSync(helperDir(h)) : [])
    if (f.endsWith(".sock"))
      await new Promise<void>((resolve) => {
        const s = net.connect(path.join(helperDir(h), f))
        const t = setTimeout(() => (s.destroy(), resolve()), 2000)
        s.on("connect", () => s.write(`${JSON.stringify({ id: 1, method: "shutdown" })}\n`))
        s.on("data", () => (clearTimeout(t), s.destroy(), setTimeout(resolve, 300)))
        s.on("error", () => (clearTimeout(t), resolve()))
      })
}

/** A login shell that reads command lines of plain words and single-quoted ones only (no double
 *  quotes, no $, no newline: what fish's and csh's syntax share with sh's), prints a profile's
 *  greeting first, refuses -i with -l together as tcsh does (`tcsh`), and has a PATH of its own
 *  set up by its profile (`loginPath`) before the one it was given. */
function wordShell(h: FakeHost, o: { name: string; loginPath?: string; tcsh?: boolean }) {
  const js = path.join(h.root, `${o.name}.cjs`)
  fs.writeFileSync(
    js,
    `const { spawnSync } = require("child_process")
const [flags, line] = process.argv.slice(2)
if (${!!o.tcsh} && flags !== "-c" && flags !== "-l") { process.stderr.write("Unknown option: " + flags + "\\n"); process.exit(1) }
// A profile that talks.
process.stdout.write("Welcome to ${o.name}, the friendly shell\\nhave a nice day\\n")
const word = /^(?:[\\w@%+=:,./~-]+|'[^'\\n]*')$/
const words = (line || "").split(" ")
if (!line || !words.every((w) => word.test(w))) { process.stderr.write("${o.name}: Unmatched quote, or a word it can't read: " + JSON.stringify(line) + "\\n"); process.exit(127) }
const args = words.map((w) => (w.startsWith("'") ? w.slice(1, -1) : w.startsWith("~/") ? process.env.HOME + w.slice(1) : w))
// Its profile's PATH, for a login or interactive shell only (a plain -c has the one it was
// given); csh's .cshrc is read by every one of its shells.
const PATH = (/[il]/.test(flags) || ${!!o.tcsh}) && ${JSON.stringify(o.loginPath ?? "")} ? ${JSON.stringify(o.loginPath ?? "")} + ":" + process.env.PATH : process.env.PATH
const r = spawnSync(args[0], args.slice(1), { stdio: "inherit", env: { ...process.env, PATH } })
process.exit(r.status === null ? 1 : r.status)
`,
  )
  const bin = path.join(h.root, o.name)
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 })
  return bin
}

/** A folder with the tools a computer's sh has, and no node. */
function bare(h: FakeHost) {
  const dir = path.join(h.root, "bare-bin")
  if (fs.existsSync(dir)) return dir
  fs.mkdirSync(dir)
  for (const tool of ["sh", "sed", "awk", "sort", "tail", "cut", "env", "mkdir", "mv", "rm", "cat", "printf", "mktemp", "sleep"]) {
    const at = ["/usr/bin", "/bin"].map((d) => path.join(d, tool)).find((f) => fs.existsSync(f))
    if (at) fs.symlinkSync(fs.realpathSync(at), path.join(dir, tool))
  }
  return dir
}

/** A folder with a `node` that says it is `version` and does nothing else. */
function oldNode(h: FakeHost, version: string) {
  const dir = path.join(h.root, `node-${version}`)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "node"), `#!/bin/sh\n[ "$1" = -v ] && echo v${version} && exit 0\necho "node ${version} can't run this" >&2\nexit 1\n`, { mode: 0o755 })
  return dir
}

const ENV = ["B42_FAKE_SSH_LOGIN", "B42_FAKE_SSH_SHELL", "B42_FAKE_SSH_PATH"] as const
const clean = () => ENV.forEach((k) => delete process.env[k])

test("a login shell that reads only words (fish's, csh's) with a noisy profile: the scripts go on stdin to `sh -s`, attaching is plain words, and node is found on the login shell's PATH, the newest of 18 or later", async () => {
  const h = fakeHost()
  try {
    // That computer's commands find only an old node; its login shell's profile puts this one first.
    const old = oldNode(h, "16.20.0")
    const real = path.join(h.root, "real-node")
    fs.mkdirSync(real)
    fs.symlinkSync(process.execPath, path.join(real, "node"))
    process.env.B42_FAKE_SSH_PATH = `${old}:${bare(h)}`
    process.env.B42_FAKE_SSH_LOGIN = wordShell(h, { name: "fishy", loginPath: real })
    const seen = commands(h)
    const steps: string[] = []
    const m = await connectSsh({ host: "dev-box", dataDir: h.data, onStep: (s) => steps.push(s) })
    try {
      // Every command line was one the shell could read: the probe and the upload as `sh -s`.
      assert.deepEqual(seen(), ["sh -s", "sh -s", "attach"])
      assert.deepEqual(steps, ["Connecting to dev-box…", "Starting the app's helper on dev-box…", "Putting the app's helper on dev-box…"])
      assert.equal((await m.run("sh", ["-c", "echo $HOME"])).out.trim(), h.home)
      // The node chosen is remembered for that computer, by the path the shell found it at.
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.data, "ssh", "nodes.json"), "utf8")), { "dev-box": path.join(real, "node") })
    } finally {
      await m.close()
    }
    // tcsh's way: -i with -l is refused, -l alone or -c is read.
    await endHelpers(h)
    fs.rmSync(path.join(h.data, "ssh", "nodes.json"))
    process.env.B42_FAKE_SSH_LOGIN = wordShell(h, { name: "tcshy", loginPath: real, tcsh: true })
    const n = await connectSsh({ host: "dev-box", dataDir: h.data })
    await n.close()
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.data, "ssh", "nodes.json"), "utf8")), { "dev-box": path.join(real, "node") })
  } finally {
    clean()
    await h.end()
  }
})

test("only an old node there: said with its version and where it is; none at all: said so", async () => {
  const h = fakeHost()
  try {
    const old = oldNode(h, "16.20.0")
    process.env.B42_FAKE_SSH_PATH = `${old}:${bare(h)}`
    process.env.B42_FAKE_SSH_LOGIN = wordShell(h, { name: "plain" })
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), (e: Error) => e.message === `The app needs Node 18 or newer on dev-box for its helper, and found only Node 16.20.0 (${path.join(old, "node")}). Install a newer one (nodejs.org, nvm, or your package manager) and connect again.`)
    process.env.B42_FAKE_SSH_PATH = bare(h)
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), /Node 18 or newer on dev-box for its helper, and `node` was not found there/)
  } finally {
    clean()
    await h.end()
  }
})

test("a computer whose login shell is cmd.exe or PowerShell is said to run Windows", async () => {
  const h = fakeHost()
  try {
    const say = (name: string, words: string) => {
      const bin = path.join(h.root, name)
      fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\r\\n' ${words} >&2\nexit 1\n`, { mode: 0o755 })
      return bin
    }
    process.env.B42_FAKE_SSH_LOGIN = say("cmd", `"'sh' is not recognized as an internal or external command," "operable program or batch file."`)
    await assert.rejects(connectSsh({ host: "win-box", dataDir: h.data }), /^Error: win-box runs Windows \(its login shell is cmd\.exe or PowerShell\), which the app can't work on over ssh yet\.$/)
    process.env.B42_FAKE_SSH_LOGIN = say("pwsh", `"sh : The term 'sh' is not recognized as a name of a cmdlet, function, script file, or executable program." "    + CategoryInfo          : ObjectNotFound: (sh:String) [], CommandNotFoundException"`)
    await assert.rejects(connectSsh({ host: "win-box", dataDir: h.data }), /win-box runs Windows/)
    assert.equal(saysWindows("bash: sh: command not found"), false)
  } finally {
    clean()
    await h.end()
  }
})

test("a reconnect attaches first: a helper that runs is only attached to; one that was ended is started (not put there again); a socket that is not the helper's is never spoken to, and taken over", async () => {
  const h = fakeHost()
  try {
    const seen = commands(h)
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    assert.deepEqual(seen(), ["sh -s", "sh -s", "attach"])
    // The link drops: attached again, nothing else.
    const up = new Promise<void>((r) => {
      const off = m.onReach!((x) => x.status === "up" && (off(), r()))
    })
    for (const pid of fs.readdirSync(path.join(h.root, "sessions"))) {
      try {
        process.kill(Number(pid), "SIGTERM")
      } catch {}
    }
    await up
    assert.deepEqual(seen(), ["attach"])
    await m.close()
    // The app starts again: attached, nothing else.
    const steps: string[] = []
    const again = await connectSsh({ host: "dev-box", dataDir: h.data, onStep: (s) => steps.push(s) })
    await again.close()
    assert.deepEqual(seen(), ["attach"])
    assert.deepEqual(steps, ["Connecting to dev-box…", "Attaching to the app's helper on dev-box…"])
    // The helper was ended (a reboot): attaching says so, and the probe starts it, as it is there.
    await endHelpers(h)
    const third = await connectSsh({ host: "dev-box", dataDir: h.data })
    assert.deepEqual(seen(), ["attach", "sh -s", "attach"])
    await third.close()
    // A file where the socket would be (another user's, or anything but the helper's): never
    // connected to; the daemon takes the place.
    await endHelpers(h)
    const sock = fs.readdirSync(helperDir(h)).find((f) => /^helper-.*\.js$/.test(f))!.replace(/\.js$/, ".sock")
    fs.writeFileSync(path.join(helperDir(h), sock), "not a socket")
    const fourth = await connectSsh({ host: "dev-box", dataDir: h.data })
    assert.deepEqual(seen(), ["attach", "sh -s", "attach"])
    assert.ok(fs.lstatSync(path.join(helperDir(h), sock)).isSocket())
    await fourth.close()
  } finally {
    await h.end()
  }
})

test("the helper not starting is said with its code and a sentence, never node's last line: a folder that can't be written, a home too long for a socket, a helper that stops as it starts", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    await m.close()
    await endHelpers(h)
    if (process.getuid?.() !== 0) {
      // ~/.bicycle42 there can no longer be written (its mode was changed).
      fs.chmodSync(helperDir(h), 0o500)
      try {
        await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), (e: Error) => {
          assert.match(e.message, /^The app's helper did not start on dev-box: can't (write|take) ~\/\.bicycle42\/helper-[0-9a-f]+\.(start\.log|lock): permission denied: ~\/\.bicycle42 there, or the home folder, is not writable by this user \(its owner or its permissions were changed\)\. \(EACCES, with Node [\d.]+ at .+\)\.$/)
          return true
        })
      } finally {
        fs.chmodSync(helperDir(h), 0o700)
      }
    }
    // The helper stops as it starts (its lock is a folder, which it can't take away).
    const lock = path.join(helperDir(h), fs.readdirSync(helperDir(h)).find((f) => /^helper-.*\.js$/.test(f))!.replace(/\.js$/, ".lock"))
    fs.mkdirSync(lock)
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), (e: Error) => {
      assert.match(e.message, /^The app's helper did not start on dev-box: the app's helper stopped as it started: .*\((ERR_FS_EISDIR|EISDIR|EPERM), with Node /)
      assert.doesNotMatch(e.message, /Node\.js v|^\s*at /m)
      return true
    })
    fs.rmdirSync(lock)
  } finally {
    await h.end()
  }
  // A home whose path leaves no room for the socket's name.
  const deep = fakeHost({ under: path.join(os.tmpdir(), `b42-long-${"x".repeat(60)}`) })
  try {
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: deep.data }), (e: Error) => {
      assert.match(e.message, /^The app's helper did not start on dev-box: The app's helper can't listen there: its socket would be .*\.sock, \d+ bytes, and a socket's path may be 10[37] at most on this system: the home folder's path is too long for it\. \(ENAMETOOLONG, with Node /)
      return true
    })
  } finally {
    await deep.end()
    fs.rmSync(path.join(os.tmpdir(), `b42-long-${"x".repeat(60)}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test("each errno the helper can meet as it starts has its sentence; a socket path is measured in bytes", () => {
  const said = (code: string) => failure(Object.assign(new Error("x"), { code }), "can't listen at ~/.bicycle42/helper-v.sock")
  assert.deepEqual(said("EROFS"), { code: "EROFS", sentence: "can't listen at ~/.bicycle42/helper-v.sock: the home folder there is on a read-only file system." })
  assert.deepEqual(said("ENOSPC"), { code: "ENOSPC", sentence: "can't listen at ~/.bicycle42/helper-v.sock: the disk there is full." })
  assert.match(said("EACCES").sentence, /permission denied/)
  assert.match(said("EAGAIN").sentence, /would not start another process/)
  assert.deepEqual(failure(new Error("Something odd\n    at x"), "can't start"), { code: "ERROR", sentence: "can't start: Something odd." })
  assert.equal(socketTooLong(`/h/${"é".repeat(50)}/x.sock`, "linux") !== undefined, true, "100 characters, 155 bytes")
  assert.equal(socketTooLong(`/h/${"e".repeat(50)}/x.sock`, "linux"), undefined)
  assert.match(socketTooLong(`/h/${"e".repeat(100)}/x.sock`, "darwin")!, /may be 103 at most/)
})

test("the probe's script: only sh reads it, and what it says is read by its marker lines", () => {
  const script = probeScript({ version: "abc", digest: "0".repeat(40), remembered: "/opt/my node/bin/node" })
  // The remembered path is sh's to read, quoted for sh.
  assert.match(script, /^R='\/opt\/my node\/bin\/node'$/m)
  // A profile's noise around the marker lines is not read.
  assert.deepEqual(nodesSaid("Welcome!\nB42NODE /usr/bin/node 16.20.0\nB42NODE /opt/my node/bin/node 22.11.0\nhave a nice day B42NODE x 1.0.0\n"), [
    { path: "/usr/bin/node", version: "16.20.0" },
    { path: "/opt/my node/bin/node", version: "22.11.0" },
  ])
})

test("a login shell whose profile never finishes (bash, which ignores SIGTERM when interactive) holds connecting 10 s at most, leaves nothing running there, and is said when node could only have come from it", { skip: !fs.existsSync("/bin/bash") && "no bash here" }, async () => {
  const h = fakeHost()
  const step = sshTiming.step
  sshTiming.step = 30_000
  try {
    process.env.B42_FAKE_SSH_SHELL = "/bin/bash"
    fs.writeFileSync(path.join(h.home, ".bashrc"), "while :; do sleep 1; done\n")
    fs.writeFileSync(path.join(h.home, ".bash_profile"), ". ~/.bashrc\n")
    let t = Date.now()
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    await m.close()
    const took = Date.now() - t
    assert.ok(took < 20_000, `connected in ${took} ms`)
    const left = () => spawnSync("pgrep", ["-f", `${h.home}|bash -ilc env|bash -lc env`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).filter((pid) => fs.existsSync(`/proc/${pid}`) && /bash/.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")))
    await until(() => left().length === 0, 5000).catch(() => assert.fail(`left running there: ${left().join(" ")}`))
    // With no node on the plain PATH, the profile's not finishing is what is said.
    await endHelpers(h)
    fs.rmSync(path.join(h.data, "ssh", "nodes.json"))
    process.env.B42_FAKE_SSH_PATH = bare(h)
    t = Date.now()
    await assert.rejects(connectSsh({ host: "dev-box", dataDir: h.data }), /`node` was not found on the PATH there, and its login shell's profile did not finish in 10 s/)
    assert.ok(Date.now() - t < 20_000)
  } finally {
    sshTiming.step = step
    clean()
    spawnSync("pkill", ["-9", "-f", "bash -ilc env"])
    await h.end()
  }
})

test("a Linux computer whose profile prints PowerShell's words (oh-my-posh not found) is not said to run Windows", async () => {
  const h = fakeHost()
  try {
    const login = path.join(h.root, "posh-like")
    fs.writeFileSync(login, `#!/bin/sh\necho "oh-my-posh: The term 'oh-my-posh' is not recognized as a name of a cmdlet. CommandNotFoundException" >&2\nexec /bin/sh "$@"\n`, { mode: 0o755 })
    process.env.B42_FAKE_SSH_LOGIN = login
    process.env.B42_FAKE_SSH_SHELL = "/bin/sh"
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    assert.equal(m.platform, "linux")
    await m.close()
  } finally {
    clean()
    await h.end()
  }
})

test("the steps of connecting are said for the first connect only: a reconnect that starts the helper again says none (the window's step line does not outlive the connect)", async () => {
  const h = fakeHost()
  try {
    const steps: string[] = []
    const m = await connectSsh({ host: "dev-box", dataDir: h.data, onStep: (s) => steps.push(s) })
    assert.equal(steps.length, 3)
    steps.length = 0
    await endHelpers(h)
    await until(() => m.reach().status === "down")
    await until(() => m.reach().status === "up", 20_000)
    assert.deepEqual(steps, [])
    await m.close()
  } finally {
    await h.end()
  }
})

test("attaching first never uses a ~/.bicycle42 that others could write in: the probe runs and makes it this user's alone again", async () => {
  const h = fakeHost()
  try {
    const seen = commands(h)
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    await m.close()
    seen()
    fs.chmodSync(helperDir(h), 0o777)
    const again = await connectSsh({ host: "dev-box", dataDir: h.data })
    await again.close()
    assert.deepEqual(seen(), ["attach", "sh -s", "attach"])
    assert.equal((fs.statSync(helperDir(h)).mode & 0o777).toString(8), "700")
  } finally {
    await h.end()
  }
})
