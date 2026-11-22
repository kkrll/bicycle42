// How a known agent's adapter is started (main/agents.ts: commandOf, localAgents): the exact
// version agent-pins.json pins, from the app's lockfile of it (node and its program in its folder
// under ~/.bicycle42/adapters; the install itself: adapters.test.ts), npx @latest when the
// reviewer asked for the newest, an adapter installed on its own before either, and a version
// forced with B42_PIN_<ID> (npx) before all; that each pin has its lockfile, fit to install with
// scripts off; and what `npm run agents:check` does with npm's answer, the lockfile npm makes and
// the real check's, all without the network. (The same line on another computer: controller-ssh.test.ts.)
//
//   node scripts/build.mjs --tests && node --test dist/test/agent-pins.test.cjs
import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { LOCK_FILES } from "../src/main/adapter-locks"
import { adapterLock, adapterOf, commandOf, localAgents, PINS, pinEnv, type StartPrefs } from "../src/main/agents"
import type { Machine } from "../src/main/machine"
import { bumped, checksOf, compareVersions, entryOf, formatStatus, LOCK_PLATFORMS, lockManifest, lockProblems, main, pinsText, readNpm, status } from "../scripts/agent-pins.mjs"

/** A computer with these programs on its PATH and nothing else (no sign-in, no files). */
function computer(...programs: string[]): Machine {
  const have = new Set(programs)
  return {
    agentEnv: async () => ({ PATH: "/fake/bin" }),
    which: async (p: string) => (have.has(p) ? `/fake/bin/${p}` : undefined),
    stat: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    readFile: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    path: path.posix,
    home: "/home/someone",
    platform: "linux",
  } as unknown as Machine
}
const none: StartPrefs = { env: {} }
const latest = (...ids: string[]): StartPrefs => ({ env: {}, latest: (id) => ids.includes(id) })
/** The line that starts the pin of `id` on `computer()`: node and its program, in the folder of its lockfile. */
const locked = (id: string) => ["node", `/home/someone/.bicycle42/adapters/${adapterLock(id)!.folder}/node_modules/${PINS[id]!.package}/dist/index.js`]

test("the pins: an exact version of each adapter, nothing to pin for the person's own CLIs", () => {
  assert.deepEqual(Object.keys(PINS).sort(), ["claude", "codex"])
  for (const pin of Object.values(PINS)) {
    assert.match(pin.version, /^\d+\.\d+\.\d+$/, "an exact version, never a range or a tag")
    assert.match(pin.package, /^@agentclientprotocol\//)
  }
  assert.equal(PINS.claude!.package, "@agentclientprotocol/claude-agent-acp")
  assert.equal(PINS.codex!.package, "@agentclientprotocol/codex-acp")
  assert.equal(adapterOf("gemini"), undefined)
  assert.equal(adapterOf("opencode"), undefined)
})

test("the pin starts from the app's lockfile (node and the adapter's program); Always the newest starts npx @latest, for that agent only", async () => {
  const m = computer("claude", "codex", "node", "npx", "gemini", "opencode")
  assert.deepEqual(await commandOf("claude", m, none), locked("claude"))
  assert.deepEqual(await commandOf("codex", m, none), locked("codex"))
  assert.deepEqual(await commandOf("claude", m, latest("claude")), ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"])
  assert.deepEqual(await commandOf("codex", m, latest("claude")), locked("codex"), "codex stays pinned")
  // The person's own CLIs are started as they are, whatever is asked.
  assert.deepEqual(await commandOf("gemini", m, latest("gemini")), ["gemini", "--experimental-acp"])
  assert.deepEqual(await commandOf("opencode", m, latest("opencode")), ["opencode", "acp"])
  // Without the CLI whose login it uses, or without node (npx for the newest): not startable.
  assert.equal(await commandOf("claude", computer("node"), none), undefined)
  assert.equal(await commandOf("claude", computer("claude", "npx"), none), undefined)
  assert.equal(await commandOf("claude", computer("claude", "node"), latest("claude")), undefined)
})

test("an adapter installed on its own wins over the pin and over latest", async () => {
  const m = computer("claude", "claude-agent-acp", "npx")
  assert.deepEqual(await commandOf("claude", m, none), ["claude-agent-acp"])
  assert.deepEqual(await commandOf("claude", m, latest("claude")), ["claude-agent-acp"])
  // …even with no npx at all.
  assert.deepEqual(await commandOf("claude", computer("claude", "claude-agent-acp"), none), ["claude-agent-acp"])
})

test("B42_PIN_<ID> runs that version, over the pin, latest and an own install; the others stay pinned", async () => {
  assert.equal(pinEnv("claude"), "B42_PIN_CLAUDE")
  const m = computer("claude", "claude-agent-acp", "codex", "npx")
  const env = { B42_PIN_CLAUDE: " 0.110.0 " }
  assert.deepEqual(await commandOf("claude", m, { env, latest: () => true }), ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.110.0"])
  assert.deepEqual(await commandOf("codex", computer("codex", "node"), { env }), locked("codex"))
  assert.deepEqual(adapterOf("claude", { env }), { pin: PINS.claude, version: "0.110.0", tested: false, latest: false, env: "B42_PIN_CLAUDE" })
  // An empty one is no override.
  assert.equal(adapterOf("claude", { env: { B42_PIN_CLAUDE: "" } })!.version, PINS.claude!.version)
  // Read from this process's environment unless given.
  const kept = process.env.B42_PIN_CODEX
  process.env.B42_PIN_CODEX = "2.10.0"
  try {
    assert.deepEqual(await commandOf("codex", computer("codex", "npx")), ["npx", "-y", "@agentclientprotocol/codex-acp@2.10.0"])
  } finally {
    if (kept === undefined) delete process.env.B42_PIN_CODEX
    else process.env.B42_PIN_CODEX = kept
  }
})

test("the connect screen's row says which version runs: pinned and tested from its lockfile, latest, or the person's own install", async () => {
  const of = async (m: Machine, prefs: StartPrefs, id: string) => (await localAgents(m, prefs)).find((a) => a.id === id)!
  const m = computer("claude", "codex", "node", "npx")
  const claude = await of(m, none, "claude")
  assert.equal(claude.command, locked("claude").join(" "))
  assert.deepEqual(claude.adapter, { version: PINS.claude!.version, tested: !!PINS.claude!.tested, latest: false, own: false, locked: true, firstStart: true })
  assert.deepEqual((await of(m, latest("claude"), "claude")).adapter, { version: "latest", tested: false, latest: true, own: false })
  assert.equal((await of(m, latest("claude"), "claude")).command, "npx -y @agentclientprotocol/claude-agent-acp@latest")
  const own = await of(computer("claude", "claude-agent-acp"), latest("claude"), "claude")
  assert.equal(own.command, "claude-agent-acp")
  assert.equal(own.adapter!.own, true)
  assert.equal(own.adapter!.locked, undefined)
  assert.deepEqual((await of(m, { env: { B42_PIN_CLAUDE: "0.110.0" } }, "claude")).adapter, { version: "0.110.0", tested: false, latest: false, own: false, env: "B42_PIN_CLAUDE" })
  // Not installed: the line it would run is still the pinned one.
  const missing = await of(computer(), none, "codex")
  assert.equal(missing.installed, false)
  assert.equal(missing.command, locked("codex").join(" "))
  assert.equal((await of(m, none, "gemini")).adapter, undefined)
})

test("each pin has its lockfile: of the pinned version, every package with its address and sha512, none with an install script, the four platforms in it", () => {
  assert.deepEqual(Object.keys(LOCK_FILES).sort(), Object.keys(PINS).sort())
  for (const [id, pin] of Object.entries(PINS)) {
    const files = LOCK_FILES[id]!
    assert.deepEqual(files.manifest, lockManifest(id, pin), `${id}: the package.json agents:check writes`)
    assert.deepEqual(lockProblems(files.lock, pin), [], id)
    const lock = adapterLock(id)!
    assert.equal(lock.version, pin.version)
    assert.equal(lock.entry, entryOf(files.lock, pin))
    assert.match(lock.folder, /^@agentclientprotocol\+[\w-]+@\d+\.\d+\.\d+-[0-9a-f]{12}$/)
  }
  // Codex's own program comes per platform: each of the four is in its lockfile.
  const codex = LOCK_FILES.codex!.lock as { packages: Record<string, { os?: string[]; cpu?: string[] }> }
  for (const at of LOCK_PLATFORMS) assert.ok(Object.values(codex.packages).some((p) => p.os?.includes(at.os) && p.cpu?.includes(at.cpu)), `${at.os}-${at.cpu}`)
})

test("a lockfile the app can't install from is said so, each thing wrong in a sentence", () => {
  const pin = { package: "@agentclientprotocol/codex-acp", bin: "codex-acp", version: "2.9.0" }
  const pkg = (extra: Record<string, unknown> = {}) => ({ resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz", integrity: "sha512-abc", ...extra })
  const good = {
    lockfileVersion: 3,
    packages: {
      "": { name: "bicycle42-adapter-codex" },
      "node_modules/@agentclientprotocol/codex-acp": pkg({ version: "2.9.0", bin: { "codex-acp": "dist/index.js" } }),
      ...Object.fromEntries(LOCK_PLATFORMS.map((at: { os: string; cpu: string }) => [`node_modules/native-${at.os}-${at.cpu}`, pkg({ version: "1.0.0", os: [at.os], cpu: [at.cpu], optional: true })])),
    },
  }
  assert.deepEqual(lockProblems(good, pin), [])
  assert.equal(entryOf(good, pin), "node_modules/@agentclientprotocol/codex-acp/dist/index.js")
  const bad = structuredClone(good) as unknown as { lockfileVersion: number; packages: Record<string, Record<string, unknown>> }
  bad.packages["node_modules/@agentclientprotocol/codex-acp"]!.version = "2.8.0"
  bad.packages["node_modules/dep"] = pkg({ version: "1.0.0", hasInstallScript: true })
  bad.packages["node_modules/loose"] = { version: "1.0.0", resolved: "git+ssh://git@github.com/x/y.git" }
  delete bad.packages["node_modules/native-linux-arm64"]
  assert.deepEqual(lockProblems(bad, pin), [
    "it has @agentclientprotocol/codex-acp 2.8.0, not 2.9.0",
    "loose has no address or sha512 in it",
    "dep has an install script, which the app does not run: check it works without, or it can't be pinned",
    "it has no package for linux-arm64",
  ])
  assert.deepEqual(lockProblems({ lockfileVersion: 1, packages: {} }, pin), ["its lockfileVersion is 1: npm 7 or newer makes a lockfile the app can read", "@agentclientprotocol/codex-acp is not in it"])
})

// ── npm run agents:check ──────────────────────────────────────────────────────────────────────

test("versions in semver's order, prereleases before their release", () => {
  assert.equal(compareVersions("0.110.0", "0.109.1"), 1)
  assert.equal(compareVersions("0.109.1", "0.110.0"), -1)
  assert.equal(compareVersions("2.9.0", "v2.9.0"), 0)
  assert.equal(compareVersions("2.10.0", "2.9.0"), 1, "numbers, not text")
  assert.equal(compareVersions("0.109.1-preview.10", "0.109.1"), -1)
  assert.equal(compareVersions("0.109.1-preview.10", "0.109.1-preview.9"), 1)
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1)
  assert.equal(compareVersions("1.0.0-alpha.beta", "1.0.0-alpha.1"), 1, "a word after a number")
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0)
})

const npmAnswer = {
  "@agentclientprotocol/claude-agent-acp": { latest: "0.110.0", time: { "0.109.1": "2026-11-21T15:37:49.660Z", "0.110.0": "2026-11-28T09:00:00.000Z" } },
  "@agentclientprotocol/codex-acp": { latest: "2.9.0", time: { "2.9.0": "2026-11-21T15:34:56.302Z" } },
} as Record<string, { latest: string; time: Record<string, string> }>
const pins = {
  claude: { package: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp", version: "0.109.1", tested: "2026-11-21", checks: "21/21" },
  codex: { package: "@agentclientprotocol/codex-acp", bin: "codex-acp", version: "2.9.0", checks: "initialize only" },
}

test("npm's answer read either way it comes, and each pin against the newest with its date", async () => {
  assert.deepEqual(readNpm('[{"dist-tags.latest":"2.9.0","time":{"2.9.0":"x"}}]'), { latest: "2.9.0", time: { "2.9.0": "x" } })
  assert.deepEqual(readNpm('{"dist-tags.latest":"2.9.0","time":{}}'), { latest: "2.9.0", time: {} })
  assert.throws(() => readNpm("{}"), /newest/)
  const rows = await status(pins, async (pkg: string) => npmAnswer[pkg])
  assert.deepEqual(
    rows.map((r: { id: string; newest: string; order: number }) => [r.id, r.newest, r.order]),
    [
      ["claude", "0.110.0", 1],
      ["codex", "2.9.0", 0],
    ],
  )
  const text = formatStatus(rows, Date.parse("2026-11-30T12:00:00Z"))
  assert.match(text, /pinned {2}0\.109\.1 {2}2026-11-21 \(8 days ago\), tested 2026-11-21 \(21\/21\)/)
  assert.match(text, /newest {2}0\.110\.0 {2}2026-11-28 \(2 days ago\)/)
  assert.match(text, /newer than the pin\. npm run agents:check -- --test claude --bump/)
  assert.match(text, /codex[\s\S]*checked: initialize only[\s\S]*up to date/)
})

test("the check's count, and a bump that writes the version, today's date and the count", () => {
  assert.deepEqual(checksOf("ok  a\nFAIL b\n\n20/21 checks passed\n"), { passed: 20, total: 21 })
  assert.equal(checksOf("FAIL Error: not installed"), undefined)
  const next = bumped(pins, "codex", "2.10.0", { passed: 21, total: 21 }, "2026-12-01")
  assert.deepEqual(next.codex, { package: "@agentclientprotocol/codex-acp", bin: "codex-acp", version: "2.10.0", tested: "2026-12-01", checks: "21/21" })
  assert.deepEqual(next.claude, pins.claude, "the other pin is left as it was")
  assert.equal(pinsText(next).endsWith("}\n"), true)
  assert.throws(() => bumped(pins, "gemini", "1.0.0", { passed: 1, total: 1 }, "2026-12-01"), /No pin/)
})

/** The lockfile npm would make for an adapter's package.json: the adapter, and one package of its own for each platform. */
function npmLock(manifest: { dependencies: Record<string, string> }) {
  const [name, version] = Object.entries(manifest.dependencies)[0]!
  const pkg = (extra: Record<string, unknown>) => ({ resolved: `https://registry.npmjs.org/${name}/-/x.tgz`, integrity: "sha512-abc", ...extra })
  return {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: manifest.dependencies },
      [`node_modules/${name}`]: pkg({ version, bin: { [name.split("/")[1]!]: "dist/index.js" } }),
      ...Object.fromEntries(LOCK_PLATFORMS.map((at: { os: string; cpu: string }) => [`node_modules/native-${at.os}-${at.cpu}`, pkg({ version: "1.0.0", os: [at.os], cpu: [at.cpu], optional: true })])),
    },
  }
}

/** `agents:check` with npm, the build, the check, the lockfiles and the pins file all given. */
function deps(checkOutput: { code: number; out: string }, makeLock: (manifest: { dependencies: Record<string, string> }) => Promise<unknown> = async (m) => npmLock(m)) {
  const log: string[] = []
  const runs: { program: string; args: string[]; env?: Record<string, string> }[] = []
  let written: unknown
  const locks: [string, unknown, unknown][] = []
  return {
    log,
    runs,
    written: () => written,
    locks,
    deps: {
      view: async (pkg: string) => npmAnswer[pkg],
      readPins: () => structuredClone(pins),
      writePins: (p: unknown) => void (written = p),
      readLock: (id: string) => (id === "claude" ? npmLock(lockManifest(id, pins.claude)) : undefined),
      makeLock,
      writeLock: (id: string, manifest: unknown, lock: unknown) => void locks.push([id, manifest, lock]),
      log: (line: string) => void log.push(line),
      now: () => Date.parse("2026-12-01T10:00:00Z"),
      run: async (program: string, args: string[], env?: Record<string, string>) => (runs.push({ program, args, ...(env ? { env } : {}) }), args[0] === "scripts/build.mjs" ? { code: 0, out: "" } : checkOutput),
    },
  }
}

test("agents:check alone only asks npm: nothing is built, run or written", async () => {
  const d = deps({ code: 0, out: "" })
  assert.equal(await main([], d.deps), 0)
  assert.equal(d.runs.length, 0)
  assert.equal(d.written(), undefined)
  assert.match(d.log.join("\n"), /claude[\s\S]*codex/)
  // How each pin's lockfile stands: claude's fine, codex's not there.
  assert.match(d.log.join("\n"), /pinned {2}0\.109\.1[^\n]*\n {10}lockfile 5 packages, each with its sha512\n/)
  assert.match(d.log.join("\n"), /no lockfile: npm run agents:check -- --lock codex/)
  assert.equal(d.locks.length, 0)
  // --bump on its own, an unknown agent, --test with no agent: refused before anything runs.
  assert.equal(await main(["--bump"], d.deps), 2)
  assert.equal(await main(["--test", "gemini"], d.deps), 2)
  assert.equal(await main(["--test"], d.deps), 2)
  assert.equal(d.runs.length, 0)
})

test("--test runs the real check against the newest, said first; --bump pins it only when every check passed", async () => {
  const passed = deps({ code: 0, out: "ok  starts\n\n21/21 checks passed\n" })
  assert.equal(await main(["--test", "claude", "--model", "haiku", "--bump"], passed.deps), 0)
  const said = passed.log.join("\n")
  assert.ok(said.indexOf("spends your claude tokens") >= 0 && said.indexOf("spends your claude tokens") < said.indexOf("21/21 checks passed"), "the cost is said before the check runs")
  assert.deepEqual(passed.runs[1], { program: "node", args: ["dist/test/acp.real.cjs", "claude", "haiku"], env: { B42_PIN_CLAUDE: "0.110.0" } })
  assert.deepEqual((passed.written() as typeof pins).claude, { ...pins.claude, version: "0.110.0", tested: "2026-12-01", checks: "21/21" })
  // …with the lockfile of the new version, written beside it.
  assert.deepEqual(passed.locks.map(([id, manifest]) => [id, manifest]), [["claude", lockManifest("claude", { ...pins.claude, version: "0.110.0" })]])
  assert.equal((passed.locks[0]![2] as { packages: Record<string, { version?: string }> }).packages["node_modules/@agentclientprotocol/claude-agent-acp"]!.version, "0.110.0")

  // Every check passed, but its lockfile has a package that needs its install script: not pinned.
  const scripted = deps({ code: 0, out: "21/21 checks passed\n" }, async (m) => {
    const lock = npmLock(m)
    ;(lock.packages as Record<string, unknown>)["node_modules/native-build"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/n/-/n.tgz", integrity: "sha512-x", hasInstallScript: true }
    return lock
  })
  assert.equal(await main(["--test", "claude", "--bump"], scripted.deps), 1)
  assert.equal(scripted.written(), undefined)
  assert.equal(scripted.locks.length, 0)
  assert.match(scripted.log.join("\n"), /can't be used: native-build has an install script, which the app does not run[\s\S]*Not bumped: the pin stays 0\.109\.1/)

  const failed = deps({ code: 1, out: "ok  starts\nFAIL Stop\n\n20/21 checks passed\n" })
  assert.equal(await main(["--test", "claude", "--bump"], failed.deps), 1)
  assert.equal(failed.written(), undefined, "a failed check pins nothing")
  assert.match(failed.log.join("\n"), /Not bumped: the pin stays 0\.109\.1/)

  // Every check passed but the process failed (it crashed on the way out): not pinned either.
  const crashed = deps({ code: 1, out: "21/21 checks passed\n" })
  assert.equal(await main(["--test", "claude", "--bump"], crashed.deps), 1)
  assert.equal(crashed.written(), undefined)

  // Without --bump: tested, nothing written, the exit code says how it went.
  const tried = deps({ code: 0, out: "21/21 checks passed\n" })
  assert.equal(await main(["--test", "codex"], tried.deps), 0)
  assert.equal(tried.written(), undefined)
  assert.deepEqual(tried.runs[1]!.env, { B42_PIN_CODEX: "2.9.0" })
})

test("--lock makes the lockfile of the version pinned now again, and nothing else", async () => {
  const d = deps({ code: 0, out: "" })
  assert.equal(await main(["--lock", "codex"], d.deps), 0)
  assert.deepEqual(d.locks.map(([id, manifest]) => [id, manifest]), [["codex", { name: "bicycle42-adapter-codex", private: true, dependencies: { "@agentclientprotocol/codex-acp": "2.9.0" } }]])
  assert.equal(d.written(), undefined)
  assert.equal(d.runs.length, 0)
  assert.equal(await main(["--lock", "gemini"], d.deps), 2)
  assert.equal(await main(["--lock"], d.deps), 2)
  // npm failing is said, and nothing is written.
  const failed = deps({ code: 0, out: "" }, async () => Promise.reject(new Error("npm could not make the lockfile: ENOTFOUND")))
  assert.equal(await main(["--lock", "claude"], failed.deps), 1)
  assert.equal(failed.locks.length, 0)
  assert.match(failed.log.join("\n"), /ENOTFOUND/)
})
