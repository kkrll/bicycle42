// The pinned adapters installed from the app's lockfile (src/main/adapters.ts, through
// agents.ts's prepareStart): with the real npm, against a registry of the test's own
// (test/fake-registry.ts) that serves a fake Claude Code adapter at the pinned version and a
// package it needs, which has an install script. Installed once and used again; a tarball that
// differs from its sha512 refused with the sentence, nothing installed; an install cut off never
// used; the person's own adapter first; B42_PIN_<ID> and "latest" through npx; older installs
// tidied, never one that runs. (On another computer over ssh: controller-ssh.test.ts.) No network.
//
//   node scripts/build.mjs --tests && node --test dist/test/adapters.test.cjs
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { ADAPTER_LOCKS, adapterTiming, folderOf, lockOf, npmFailure, tidyAdapters, type AdapterLock } from "../src/main/adapters"
import { adapterLock, localAgents, PINS, prepareStart, type StartPrefs } from "../src/main/agents"
import { thisMachine, type Machine } from "../src/main/machine"
import { fakeAdapterPackages, fakeRegistry, type FakeRegistry } from "./fake-registry"
import { lockManifest } from "../scripts/agent-pins.mjs"

const pin = PINS.claude!
const none: StartPrefs = { env: {} }
let root: string
let registry: FakeRegistry
/** Where the fake dependency's install script would leave its mark, had it run. */
let ranScript: string
const kept = { HOME: process.env.HOME, PATH: process.env.PATH, locks: { ...ADAPTER_LOCKS } }

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "b42-adapters-"))
  ranScript = path.join(root, "postinstall-ran")
  registry = await fakeRegistry(path.join(root, "registry"), fakeAdapterPackages(ranScript))
  ADAPTER_LOCKS.claude = { manifest: lockManifest("claude", pin), lock: await registry.lockFor(lockManifest("claude", pin)) }
})
after(async () => {
  Object.assign(ADAPTER_LOCKS, kept.locks)
  process.env.HOME = kept.HOME
  process.env.PATH = kept.PATH
  await registry.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** A computer of its own for each test: this one with a home of its own, and on its PATH `claude`
 *  (the CLI the adapter needs) and whatever else is asked for, before node and npm (this one's).
 *  Its agents' PATH is that one alone, not this login shell's too (which may have anything). */
function computer(...programs: string[]) {
  const home = fs.mkdtempSync(path.join(root, "home-"))
  const bin = path.join(home, "bin")
  fs.mkdirSync(bin)
  for (const p of ["claude", ...programs]) fs.writeFileSync(path.join(bin, p), "#!/bin/sh\n", { mode: 0o755 })
  // Its npm gets packages from the test's registry, as a person's own ~/.npmrc may name a mirror
  // (npm takes a lockfile's address on another host than its registry for a URL, and refuses it).
  fs.writeFileSync(path.join(home, ".npmrc"), `registry=${registry.url}/\nfetch-retries=0\n`)
  process.env.HOME = home
  process.env.PATH = `${bin}${path.delimiter}${kept.PATH}`
  const m: Machine = Object.assign(Object.create(thisMachine()) as Machine, { agentEnv: async () => ({ ...process.env }) as Record<string, string> })
  return { m, home, adapters: path.join(home, ".bicycle42", "adapters") }
}
const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
const lock = () => adapterLock("claude")!

test("the pin starts from its lockfile: installed once at its first start (said), with no package's install script run, and used again after", async () => {
  const c = computer()
  const steps: string[] = []
  const row = async () => (await localAgents(c.m, none)).find((a) => a.id === "claude")!
  assert.deepEqual((await row()).adapter, { version: pin.version, tested: !!pin.tested, latest: false, own: false, locked: true, firstStart: true })
  const before = registry.tarballs().length
  // Two starts at once: one install.
  const [line, again] = await Promise.all([prepareStart("claude", c.m, none, { onStep: (t) => steps.push(t) }), prepareStart("claude", c.m, none)])
  const entry = path.join(c.adapters, lock().folder, "node_modules", ...pin.package.split("/"), "bin", "agent.js")
  assert.deepEqual(line, ["node", entry])
  assert.deepEqual(again, line)
  assert.deepEqual(steps, ["Installing the Claude Code adapter (first start)…"])
  assert.equal(registry.tarballs().length - before, 2, "the adapter and its dependency, once")
  assert.equal(fs.existsSync(ranScript), false, "the dependency's postinstall did not run")
  assert.match(lock().folder, new RegExp(`^@agentclientprotocol\\+claude-agent-acp@${pin.version.replace(/\./g, "\\.")}-[0-9a-f]{12}$`))
  assert.deepEqual(list(c.adapters), [lock().folder], "nothing left of the install but its folder")
  assert.equal(fs.readFileSync(path.join(c.adapters, lock().folder, ".b42-installed"), "utf8").trim(), lock().hash)
  // The lockfile it was installed from is in it.
  assert.equal(fs.readFileSync(path.join(c.adapters, lock().folder, "package-lock.json"), "utf8"), lock().files["package-lock.json"])
  // It runs: the fake agent behind it answers ACP's initialize.
  assert.match(await initialize(line!), /"protocolVersion"/)

  // Later starts: nothing fetched, nothing said; the row says it is installed.
  const later: string[] = []
  assert.deepEqual(await prepareStart("claude", c.m, none, { onStep: (t) => later.push(t) }), line)
  assert.deepEqual(later, [])
  assert.equal(registry.tarballs().length - before, 2)
  assert.deepEqual((await row()).adapter, { version: pin.version, tested: !!pin.tested, latest: false, own: false, locked: true })
  assert.equal((await row()).command, `node ${entry}`)

  // Another lockfile of the same version (its tree resolved again) is another folder, installed anew.
  const other = lockOf("claude", pin, { ...lockManifest("claude", pin), description: "again" }, ADAPTER_LOCKS.claude!.lock)!
  assert.notEqual(other.folder, lock().folder)
})

/** Starts `line` and asks it ACP's initialize: its answer, or what it said before it ended. */
function initialize(line: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(line[0]!, line.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, B42_FAKE_ADAPTER_STATE: path.join(root, "agent-state.json") } })
    let out = ""
    let err = ""
    const done = (s: string) => (child.kill(), resolve(s))
    child.stdout.on("data", (b) => ((out += b), out.includes('"id":1') && done(out)))
    child.stderr.on("data", (b) => (err += b))
    child.on("exit", () => resolve(out || err))
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`)
    setTimeout(() => done(`timed out: ${err}`), 10_000).unref()
  })
}

test("a tarball that differs from its sha512 in the lockfile is refused, with the sentence, and nothing is installed", async () => {
  const c = computer()
  registry.tamper("b42-fake-dep")
  try {
    await assert.rejects(prepareStart("claude", c.m, none), (err: Error) => {
      assert.match(err.message, /^The Claude Code adapter can't be installed on this computer: npm refused it, because what it downloaded \(b42-fake-dep 1\.0\.0\) differs from what the app tested: its sha512 is not the one in the app's lockfile\. Nothing of it was installed\./)
      return true
    })
  } finally {
    registry.tamper("b42-fake-dep", false)
  }
  assert.deepEqual(list(c.adapters), [], "no folder at its name, and none of the install left")
  assert.equal(fs.existsSync(ranScript), false)
})

test("an install cut off is never used: npm ended by the timeout leaves nothing; a folder of one left from before goes once it is an hour old", async () => {
  const c = computer()
  // Left by an install the app quit during, npm done but never renamed: 2 hours old, and a fresh one.
  fs.mkdirSync(c.adapters, { recursive: true })
  const old = path.join(c.adapters, `.installing-${lock().folder}-dead0001`)
  const fresh = path.join(c.adapters, `.installing-${lock().folder}-live0002`)
  for (const d of [old, fresh]) fs.mkdirSync(path.join(d, "node_modules"), { recursive: true })
  const twoHours = (Date.now() - 2 * 3600_000) / 1000
  fs.utimesSync(old, twoHours, twoHours)
  const row = async () => (await localAgents(c.m, none)).find((a) => a.id === "claude")!.adapter
  assert.equal((await row())!.firstStart, true, "not installed: neither counts")

  // npm held up past the time an install may take: given up, nothing kept.
  const was = adapterTiming.install
  adapterTiming.install = 2000
  registry.hold()
  try {
    await assert.rejects(prepareStart("claude", c.m, none), /npm did not finish in 2 s\. Is the link to npm's registry slow\?/)
  } finally {
    adapterTiming.install = was
    registry.release()
  }
  assert.deepEqual(list(c.adapters), [path.basename(fresh)], "the old one swept, this one's own taken away, the fresh one (another install under way) kept")
  // Started again: installed whole.
  await prepareStart("claude", c.m, none)
  assert.deepEqual(list(c.adapters), [path.basename(fresh), lock().folder].sort())
  assert.equal((await row())!.firstStart, undefined)
})

test("the person's own adapter on the PATH is used first, and nothing is installed", async () => {
  const c = computer(pin.bin)
  const before = registry.requests.length
  assert.deepEqual(await prepareStart("claude", c.m, none), [pin.bin])
  const row = (await localAgents(c.m, none)).find((a) => a.id === "claude")!
  assert.deepEqual(row.adapter, { version: pin.version, tested: !!pin.tested, latest: false, own: true })
  assert.equal(registry.requests.length, before)
  assert.equal(fs.existsSync(c.adapters), false)
})

test("B42_PIN_<ID> and Always the newest have no lockfile: npx, as before, and nothing is installed", async () => {
  const c = computer("npx")
  const before = registry.requests.length
  assert.deepEqual(await prepareStart("claude", c.m, { env: { B42_PIN_CLAUDE: "0.110.0" } }), ["npx", "-y", `${pin.package}@0.110.0`])
  assert.deepEqual(await prepareStart("claude", c.m, { env: {}, latest: () => true }), ["npx", "-y", `${pin.package}@latest`])
  const rows = await localAgents(c.m, { env: { B42_PIN_CLAUDE: "0.110.0" } })
  assert.deepEqual(rows.find((a) => a.id === "claude")!.adapter, { version: "0.110.0", tested: false, latest: false, own: false, env: "B42_PIN_CLAUDE" })
  assert.equal(registry.requests.length, before)
  assert.equal(fs.existsSync(c.adapters), false)
})

test("a new install takes away the older ones of the same adapter, unless one runs (it goes at a later start); a newer one and other adapters' stay", async () => {
  const c = computer()
  const prefix = `${pin.package.replace("/", "+")}@`
  const older = `${prefix}0.1.0-aaaaaaaaaaaa`
  const running = `${prefix}0.0.9-bbbbbbbbbbbb`
  const newer = `${prefix}99.0.0-cccccccccccc`
  const codex = "@agentclientprotocol+codex-acp@0.0.1-dddddddddddd"
  for (const d of [older, running, newer, codex]) fs.mkdirSync(path.join(c.adapters, d, "node_modules"), { recursive: true })
  // A process whose command line names the folder, as an adapter started from it does.
  const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", path.join(c.adapters, running, "node_modules", "x.js")], { stdio: "ignore" })
  try {
    await prepareStart("claude", c.m, none)
    await waitFor(() => !list(c.adapters).some((d) => d.endsWith(older)))
    assert.deepEqual(list(c.adapters), [codex, running, lock().folder, newer].sort())
  } finally {
    proc.kill()
    await new Promise((r) => proc.once("exit", r))
  }
  // It ended: the next start takes it away.
  await prepareStart("claude", c.m, none)
  await waitFor(() => !list(c.adapters).some((d) => d.endsWith(running)))
  assert.deepEqual(list(c.adapters), [codex, lock().folder, newer].sort())
  // The same version from another lockfile, installed before this one: older too.
  const sameBefore = `${prefix}${pin.version}-eeeeeeeeeeee`
  fs.mkdirSync(path.join(c.adapters, sameBefore))
  const hourAgo = (Date.now() - 3600_000) / 1000
  fs.utimesSync(path.join(c.adapters, sameBefore), hourAgo, hourAgo)
  assert.deepEqual(await tidyAdapters(c.m, lock()), [sameBefore])
})

async function waitFor(what: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

test("npm's failures as sentences: offline, a full disk, no npm, and its own words otherwise", () => {
  const c = { name: "Codex", where: "dev-box", package: "@agentclientprotocol/codex-acp", version: "2.9.0" }
  const run = (err: string, code: number | null = 1) => ({ code, signal: null, out: "", err })
  assert.equal(
    npmFailure(run("npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND\nnpm error network request to https://registry.npmjs.org/@openai%2fcodex failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n"), c),
    "The Codex adapter can't be installed on dev-box: npm could not reach its registry (registry.npmjs.org). Is dev-box offline? Start it again once it is online.",
  )
  assert.match(npmFailure(run("npm error code ENOSPC\nnpm error syscall write\nnpm error nospc ENOSPC: no space left on device, write\n"), c), /: its disk is full \(an adapter takes about 500 MB\)\. Free some space there and start it again\.$/)
  assert.equal(npmFailure({ code: null, signal: null, out: "", err: "", error: { code: "ENOENT", message: "spawn npm ENOENT" } }, c), "The Codex adapter can't be installed on dev-box: npm was not found there (it comes with node).")
  assert.equal(npmFailure(run("npm error code EUSAGE\nnpm error The `npm ci` command can only install with an existing package-lock.json\nnpm error A complete log of this run can be found in: /x.log\n"), c), "The Codex adapter can't be installed on dev-box: npm ci failed (exit code 1): The `npm ci` command can only install with an existing package-lock.json.")
})

test("no npm on that computer: the start says so, and how to do without", async () => {
  const c = computer()
  // node alone on the PATH: its folder only, npm taken out.
  const nodeOnly = path.join(c.home, "node-only")
  fs.mkdirSync(nodeOnly)
  fs.symlinkSync(process.execPath, path.join(nodeOnly, "node"))
  process.env.PATH = `${path.join(c.home, "bin")}${path.delimiter}${nodeOnly}`
  await assert.rejects(
    prepareStart("claude", c.m, none),
    /^Error: The Claude Code adapter can't be installed on this computer: npm was not found there \(it comes with node\)\. Install node 22 or newer there, or the adapter itself: npm install -g @agentclientprotocol\/claude-agent-acp$/,
  )
  assert.equal(fs.existsSync(path.join(c.adapters, lock().folder)), false)
})

test("a lockfile not of the pinned version, or naming no program, is no lockfile: the pin then goes through npx", () => {
  const files = ADAPTER_LOCKS.claude!
  assert.ok(lockOf("claude", pin, files.manifest, files.lock))
  assert.equal(lockOf("claude", { ...pin, version: "0.0.1" }, files.manifest, files.lock), undefined)
  assert.equal(lockOf("claude", { ...pin, bin: "nope" }, files.manifest, files.lock), undefined)
  const outside = structuredClone(files.lock) as { packages: Record<string, { bin?: unknown }> }
  outside.packages[`node_modules/${pin.package}`]!.bin = { [pin.bin]: "../../../evil.js" }
  assert.equal(lockOf("claude", pin, files.manifest, outside), undefined, "a program outside its package is not started")
  const l: AdapterLock = lock()
  assert.equal(folderOf(thisMachine(), l), path.join(os.homedir(), ".bicycle42", "adapters", l.folder))
})
