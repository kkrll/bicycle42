// What `npm run agents:check` does (scripts/agents-check.mjs runs it): the known agents' adapters
// from npm, as src/main/agent-pins.json pins them, against the newest on npm; with --test, the
// real check (test/acp.real.ts) against the newest; with --bump, the new pin written once that
// passed in full. Nothing here touches the network or a file but through `deps`, so the tests
// give it npm's answer and the check's output.
import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/** The variable that runs another version than the pin (main/agents.ts: pinEnv, the same name). */
export const pinEnv = (id) => `B42_PIN_${id.toUpperCase()}`

/** -1, 0 or 1, as semver orders two versions ("0.110.0" after "0.109.1"; "1.0.0-rc.1" before
 *  "1.0.0"). A leading "v" and build metadata are ignored. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).trim().replace(/^v/, "").split("+")[0].split(/-(.*)/s)
    return { core: core.split(".").map((n) => Number(n) || 0), pre: pre ? pre.split(".") : [] }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) < (y.core[i] ?? 0) ? -1 : 1
  // A prerelease comes before its release; two prereleases compare part by part.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const np = /^\d+$/.test(p)
    const nq = /^\d+$/.test(q)
    if (np && nq) return Number(p) < Number(q) ? -1 : 1
    if (np !== nq) return np ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** npm's answer to `npm view <pkg> dist-tags.latest time --json` as { latest, time }: an object,
 *  or (npm 11, several fields) a list of one. */
export function readNpm(text) {
  let data = JSON.parse(text)
  if (Array.isArray(data)) data = data.at(-1)
  const latest = data?.["dist-tags.latest"] ?? data?.["dist-tags"]?.latest
  if (typeof latest !== "string") throw new Error("npm did not say which version is the newest.")
  return { latest, time: data.time ?? {} }
}

/** Asks npm about a package (the only network this script uses without --test). */
export const npmView = (pkg) =>
  new Promise((resolve, reject) =>
    execFile("npm", ["view", pkg, "dist-tags.latest", "time", "--json"], { shell: process.platform === "win32", maxBuffer: 16 << 20 }, (err, out, errText) =>
      err ? reject(new Error(`npm view ${pkg}: ${(errText || err.message).trim()}`)) : resolve(readNpm(out)),
    ),
  )

/** Each pinned adapter with the newest on npm, and when each came out. */
export async function status(pins, view) {
  return Promise.all(
    Object.entries(pins).map(async ([id, pin]) => {
      const npm = await view(pin.package)
      return {
        id,
        package: pin.package,
        pinned: pin.version,
        pinnedAt: npm.time[pin.version],
        tested: pin.tested,
        checks: pin.checks,
        newest: npm.latest,
        newestAt: npm.time[npm.latest],
        order: compareVersions(npm.latest, pin.version),
      }
    }),
  )
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : "date unknown")
const ago = (iso, now) => {
  if (!iso) return ""
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000)
  return days <= 0 ? " (today)" : days === 1 ? " (yesterday)" : ` (${days} days ago)`
}

/** The table `agents:check` prints: one block per adapter. */
export function formatStatus(rows, now = Date.now()) {
  return rows
    .map((r) => {
      const pinned = `  pinned  ${r.pinned}  ${day(r.pinnedAt)}${ago(r.pinnedAt, now)}${r.tested ? `, tested ${r.tested}${r.checks ? ` (${r.checks})` : ""}` : r.checks ? `, checked: ${r.checks}` : ", not tested"}`
      const newest = `  newest  ${r.newest}  ${day(r.newestAt)}${ago(r.newestAt, now)}`
      const verdict = r.order > 0 ? `  → newer than the pin. npm run agents:check -- --test ${r.id} --bump` : r.order < 0 ? "  → the pin is ahead of npm's latest" : "  → up to date"
      return [`${r.id}  ${r.package}`, pinned, newest, verdict].join("\n")
    })
    .join("\n\n")
}

/** "21/21 checks passed" at the end of the real check's output, as { passed, total }. */
export function checksOf(output) {
  const all = [...String(output).matchAll(/^(\d+)\/(\d+) checks passed$/gm)]
  const last = all.at(-1)
  return last ? { passed: Number(last[1]), total: Number(last[2]) } : undefined
}

/** The pins with `id` moved to `version`, tested today with every check passed. */
export function bumped(pins, id, version, checks, today) {
  if (!pins[id]) throw new Error(`No pin for ${id}.`)
  const { tested: _t, checks: _c, ...rest } = pins[id]
  return { ...pins, [id]: { ...rest, version, tested: today, checks: `${checks.passed}/${checks.total}` } }
}

/** The pins file as written: two spaces, a newline at the end (as the repo keeps it). */
export const pinsText = (pins) => `${JSON.stringify(pins, null, 2)}\n`

/** The real dependencies, for the app's folder `root`: npm, the build, the check, the pins file. */
export const realDeps = (root) => ({
  view: npmView,
  readPins: () => JSON.parse(fs.readFileSync(path.join(root, "src", "main", "agent-pins.json"), "utf8")),
  writePins: (pins) => fs.writeFileSync(path.join(root, "src", "main", "agent-pins.json"), pinsText(pins)),
  log: (line) => console.log(line),
  now: () => Date.now(),
  /** Runs a command in the app's folder, its output shown as it comes and returned. */
  run: (program, args, env = {}) =>
    new Promise((resolve) => {
      const child = spawn(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["inherit", "pipe", "pipe"] })
      let out = ""
      child.stdout.on("data", (b) => (process.stdout.write(b), (out += b)))
      child.stderr.on("data", (b) => (process.stderr.write(b), (out += b)))
      child.on("error", (err) => resolve({ code: 1, out: `${out}${err.message}\n` }))
      child.on("close", (code) => resolve({ code, out }))
    }),
})

const USAGE = `npm run agents:check [-- --test <agent> [--model <model>] [--bump]]

  (nothing)        each pinned adapter against the newest on npm, with their dates
  --test <agent>   the real check (test/acp.real.ts) against the newest: it starts the agent with
                   your login and spends your tokens on a few tiny prompts
  --model <model>  the model the check uses (a cheap one: haiku)
  --bump           with --test: writes the newest as the pin, only if every check passed`

/** The whole command. Resolves with its exit code. */
export async function main(argv, deps) {
  const flag = (name) => argv.includes(name)
  const value = (name) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  if (flag("--help") || flag("-h")) return deps.log(USAGE), 0
  const test = value("--test")
  const model = value("--model")
  if (flag("--test") && !test) return deps.log(`--test needs an agent.\n\n${USAGE}`), 2
  if (flag("--bump") && !test) return deps.log("--bump writes a pin only after the real check passed: give it with --test <agent>."), 2
  const pins = deps.readPins()
  if (test && !pins[test]) return deps.log(`No adapter is pinned for "${test}": ${Object.keys(pins).join(", ")} are.`), 2

  const rows = await status(test ? { [test]: pins[test] } : pins, deps.view)
  deps.log(formatStatus(rows, deps.now()))
  if (!test) return 0

  const row = rows[0]
  const spec = `${row.package}@${row.newest}`
  deps.log(
    `\nThe real check of ${spec}: it starts ${test} through npx with your login, in a throwaway folder, and spends your ${test} tokens on a few tiny prompts${model ? ` (model ${model})` : ""}. ${pinEnv(test)}=${row.newest} runs it instead of the pin (and instead of an adapter you installed yourself).\n`,
  )
  const built = await deps.run("node", ["scripts/build.mjs", "--tests"])
  if (built.code !== 0) return deps.log("The build failed: nothing was checked."), 1
  const ran = await deps.run("node", ["dist/test/acp.real.cjs", test, ...(model ? [model] : [])], { [pinEnv(test)]: row.newest })
  const checks = checksOf(ran.out)
  const passed = ran.code === 0 && !!checks && checks.total > 0 && checks.passed === checks.total
  deps.log(`\n${spec}: ${checks ? `${checks.passed}/${checks.total} checks passed` : "the check did not finish"}.`)
  if (!flag("--bump")) return passed ? 0 : 1
  if (!passed) return deps.log(`Not bumped: the pin stays ${row.pinned}.`), 1
  if (row.newest === row.pinned && pins[test].tested) deps.log(`The pin was ${row.newest} already: its test date is renewed.`)
  deps.writePins(bumped(pins, test, row.newest, checks, new Date(deps.now()).toISOString().slice(0, 10)))
  deps.log(`Pinned ${spec} in src/main/agent-pins.json. Commit it (the app starts it from its next build).`)
  return 0
}
