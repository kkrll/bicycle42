// How a known agent's adapter is started (main/agents.ts: commandOf, localAgents): npx with the
// exact version agent-pins.json pins, "latest" when the reviewer asked for the newest, an adapter
// installed on its own before either, and a version forced with B42_PIN_<ID> before all; and what
// `npm run agents:check` does with npm's answer and the real check's (scripts/agent-pins.mjs),
// all without the network. (The same line on another computer: controller-ssh.test.ts.)
//
//   node scripts/build.mjs --tests && node --test dist/test/agent-pins.test.cjs
import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { adapterOf, commandOf, localAgents, PINS, pinEnv, type StartPrefs } from "../src/main/agents"
import type { Machine } from "../src/main/machine"
import { bumped, checksOf, compareVersions, formatStatus, main, pinsText, readNpm, status } from "../scripts/agent-pins.mjs"

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

test("npx starts the pinned version; Always the newest starts @latest, for that agent only", async () => {
  const m = computer("claude", "codex", "npx", "gemini", "opencode")
  assert.deepEqual(await commandOf("claude", m, none), ["npx", "-y", `@agentclientprotocol/claude-agent-acp@${PINS.claude!.version}`])
  assert.deepEqual(await commandOf("codex", m, none), ["npx", "-y", `@agentclientprotocol/codex-acp@${PINS.codex!.version}`])
  assert.deepEqual(await commandOf("claude", m, latest("claude")), ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"])
  assert.deepEqual(await commandOf("codex", m, latest("claude")), ["npx", "-y", `@agentclientprotocol/codex-acp@${PINS.codex!.version}`], "codex stays pinned")
  // The person's own CLIs are started as they are, whatever is asked.
  assert.deepEqual(await commandOf("gemini", m, latest("gemini")), ["gemini", "--experimental-acp"])
  assert.deepEqual(await commandOf("opencode", m, latest("opencode")), ["opencode", "acp"])
  // Without the CLI whose login it uses, or without npx: not startable.
  assert.equal(await commandOf("claude", computer("npx"), none), undefined)
  assert.equal(await commandOf("claude", computer("claude"), none), undefined)
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
  assert.deepEqual(await commandOf("codex", computer("codex", "npx"), { env }), ["npx", "-y", `@agentclientprotocol/codex-acp@${PINS.codex!.version}`])
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

test("the connect screen's row says which version runs: pinned and tested, latest, or the person's own install", async () => {
  const of = async (m: Machine, prefs: StartPrefs, id: string) => (await localAgents(m, prefs)).find((a) => a.id === id)!
  const m = computer("claude", "codex", "npx")
  const claude = await of(m, none, "claude")
  assert.equal(claude.command, `npx -y @agentclientprotocol/claude-agent-acp@${PINS.claude!.version}`)
  assert.deepEqual(claude.adapter, { version: PINS.claude!.version, tested: !!PINS.claude!.tested, latest: false, own: false })
  assert.deepEqual((await of(m, latest("claude"), "claude")).adapter, { version: "latest", tested: false, latest: true, own: false })
  assert.equal((await of(m, latest("claude"), "claude")).command, "npx -y @agentclientprotocol/claude-agent-acp@latest")
  const own = await of(computer("claude", "claude-agent-acp"), latest("claude"), "claude")
  assert.equal(own.command, "claude-agent-acp")
  assert.equal(own.adapter!.own, true)
  assert.deepEqual((await of(m, { env: { B42_PIN_CLAUDE: "0.110.0" } }, "claude")).adapter, { version: "0.110.0", tested: false, latest: false, own: false, env: "B42_PIN_CLAUDE" })
  // Not installed: the line it would run is still the pinned one.
  const missing = await of(computer(), none, "codex")
  assert.equal(missing.installed, false)
  assert.equal(missing.command, `npx -y @agentclientprotocol/codex-acp@${PINS.codex!.version}`)
  assert.equal((await of(m, none, "gemini")).adapter, undefined)
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

/** `agents:check` with npm, the build, the check and the pins file all given. */
function deps(checkOutput: { code: number; out: string }) {
  const log: string[] = []
  const runs: { program: string; args: string[]; env?: Record<string, string> }[] = []
  let written: unknown
  return {
    log,
    runs,
    written: () => written,
    deps: {
      view: async (pkg: string) => npmAnswer[pkg],
      readPins: () => structuredClone(pins),
      writePins: (p: unknown) => void (written = p),
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
