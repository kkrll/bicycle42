// What `npm run agents:check` does (scripts/agents-check.mjs runs it): the known agents' adapters
// from npm, as src/main/agent-pins.json pins them, against the newest on npm; with --test, the
// real check (test/acp.real.ts) against the newest; with --bump, the new pin written once that
// passed in full, with its lockfile (src/main/adapter-locks/<id>/: the whole tree npm resolves
// for that version, each package with its sha512, which the app installs from, scripts off); with
// --lock, the lockfile of the version pinned now made again. Nothing here touches the network or a
// file but through `deps`, so the tests give it npm's answer, the lockfile and the check's output.
import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
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

/** Each pinned adapter with the newest on npm, and when each came out (and, given `readLock`, how
 *  its lockfile stands). */
export async function status(pins, view, readLock) {
  return Promise.all(
    Object.entries(pins).map(async ([id, pin]) => {
      const npm = await view(pin.package)
      return {
        ...(readLock ? { lock: lockSummary(id, pin, readLock(id)) } : {}),
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
      return [`${r.id}  ${r.package}`, pinned, ...(r.lock ? [`          ${r.lock}`] : []), newest, verdict].join("\n")
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

/** The package.json an adapter's lockfile is made for: the adapter alone, at the pinned version
 *  (main/adapters.ts writes it beside the lockfile before `npm ci`). */
export const lockManifest = (id, pin) => ({ name: `bicycle42-adapter-${id}`, private: true, dependencies: { [pin.package]: pin.version } })

/** The computers the app's agents run on: a lockfile must hold the per-platform packages of each
 *  (npm resolves all of them into one lockfile; an old npm left out all but its own). */
export const LOCK_PLATFORMS = [
  { os: "darwin", cpu: "arm64" },
  { os: "darwin", cpu: "x64" },
  { os: "linux", cpu: "x64" },
  { os: "linux", cpu: "arm64" },
]

/** What is wrong with an adapter's lockfile for the app to install from, each a sentence: none
 *  when it is fine. The app installs with `npm ci --ignore-scripts`, so a package that needs its
 *  install script to work would be broken there: it is said here, before it is pinned. */
export function lockProblems(lock, pin) {
  const problems = []
  const packages = lock?.packages ?? {}
  if (!(lock?.lockfileVersion >= 2)) problems.push(`its lockfileVersion is ${lock?.lockfileVersion}: npm 7 or newer makes a lockfile the app can read`)
  const top = packages[`node_modules/${pin.package}`]
  if (!top) problems.push(`${pin.package} is not in it`)
  else {
    if (top.version !== pin.version) problems.push(`it has ${pin.package} ${top.version}, not ${pin.version}`)
    if (!entryOf(lock, pin)) problems.push(`${pin.package} has no program "${pin.bin}" in it`)
  }
  const all = Object.entries(packages).filter(([at, p]) => at && !p.link)
  const unsure = all.filter(([, p]) => !/^https?:\/\//.test(p.resolved ?? "") || !/^sha512-/.test(p.integrity ?? "")).map(([at]) => at.replace(/^.*node_modules\//, ""))
  if (unsure.length) problems.push(`${unsure.join(", ")} ${unsure.length === 1 ? "has" : "have"} no address or sha512 in it`)
  const scripted = all.filter(([, p]) => p.hasInstallScript).map(([at]) => at.replace(/^.*node_modules\//, ""))
  if (scripted.length) problems.push(`${scripted.join(", ")} ${scripted.length === 1 ? "has an install script" : "have install scripts"}, which the app does not run: check it works without, or it can't be pinned`)
  const fits = (p, at) => (!p.os || p.os.includes(at.os)) && (!p.cpu || p.cpu.includes(at.cpu))
  const restricted = all.filter(([, p]) => p.os || p.cpu).map(([, p]) => p)
  if (restricted.length) {
    const missing = LOCK_PLATFORMS.filter((at) => !restricted.some((p) => fits(p, at))).map((at) => `${at.os}-${at.cpu}`)
    if (missing.length) problems.push(`it has no package for ${missing.join(", ")}`)
  }
  return problems
}

/** The adapter's program in the folder it is installed in, as the lockfile says (its package's
 *  `bin`): "node_modules/@agentclientprotocol/codex-acp/dist/index.js". */
export function entryOf(lock, pin) {
  const bin = lock?.packages?.[`node_modules/${pin.package}`]?.bin
  const file = typeof bin === "string" ? bin : bin?.[pin.bin]
  return typeof file === "string" ? `node_modules/${pin.package}/${path.posix.normalize(file).replace(/^\.\//, "")}` : undefined
}

/** A summary of a lockfile against its pin, for the status: "lockfile 115 packages" or what to do. */
export function lockSummary(id, pin, lock) {
  if (!lock) return `no lockfile: npm run agents:check -- --lock ${id}`
  const of = lock.packages?.[`node_modules/${pin.package}`]?.version
  if (of !== pin.version) return `lockfile of ${of ?? "another version"}: npm run agents:check -- --lock ${id}`
  const problems = lockProblems(lock, pin)
  const count = Object.keys(lock.packages ?? {}).filter(Boolean).length
  return problems.length ? `lockfile ${count} packages, ${problems.join("; ")}` : `lockfile ${count} packages, each with its sha512`
}

/** The real dependencies, for the app's folder `root`: npm, the build, the check, the pins file. */
export const realDeps = (root) => ({
  view: npmView,
  readPins: () => JSON.parse(fs.readFileSync(path.join(root, "src", "main", "agent-pins.json"), "utf8")),
  writePins: (pins) => fs.writeFileSync(path.join(root, "src", "main", "agent-pins.json"), pinsText(pins)),
  readLock: (id) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "src", "main", "adapter-locks", id, "package-lock.json"), "utf8"))
    } catch {
      return undefined
    }
  },
  /** The lockfile npm makes for `manifest`, in a throwaway folder: only the packages' metadata is
   *  fetched (--package-lock-only), nothing is installed and no script runs. */
  makeLock: (manifest) =>
    new Promise((resolve, reject) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b42-lock-"))
      fs.writeFileSync(path.join(dir, "package.json"), pinsText(manifest))
      execFile("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, shell: process.platform === "win32", maxBuffer: 16 << 20 }, (err, _out, errText) => {
        try {
          if (err) return reject(new Error(`npm could not make the lockfile: ${(errText || err.message).trim()}`))
          resolve(JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")))
        } finally {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      })
    }),
  writeLock: (id, manifest, lock) => {
    const dir = path.join(root, "src", "main", "adapter-locks", id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), pinsText(manifest))
    fs.writeFileSync(path.join(dir, "package-lock.json"), pinsText(lock))
  },
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

const USAGE = `npm run agents:check [-- --test <agent> [--model <model>] [--bump]] [-- --lock <agent>]

  (nothing)        each pinned adapter against the newest on npm, with their dates and lockfiles
  --test <agent>   the real check (test/acp.real.ts) against the newest: it starts the agent with
                   your login and spends your tokens on a few tiny prompts
  --model <model>  the model the check uses (a cheap one: haiku)
  --bump           with --test: writes the newest as the pin, and its lockfile, only if every
                   check passed
  --lock <agent>   makes the lockfile of the version pinned now again (src/main/adapter-locks/)`

/** Makes and writes the lockfile of `pin` (the pin of `id`), or says why not. True when written. */
async function lockPin(id, pin, deps) {
  const manifest = lockManifest(id, pin)
  let lock
  try {
    lock = await deps.makeLock(manifest)
  } catch (err) {
    deps.log(err instanceof Error ? err.message : String(err))
    return false
  }
  const problems = lockProblems(lock, pin)
  if (problems.length) {
    deps.log(`The lockfile of ${pin.package}@${pin.version} can't be used: ${problems.join("; ")}.`)
    return false
  }
  deps.writeLock(id, manifest, lock)
  deps.log(`Wrote src/main/adapter-locks/${id}/ (${Object.keys(lock.packages).filter(Boolean).length} packages, each with its sha512).`)
  return true
}

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
  if (flag("--lock")) {
    const id = value("--lock")
    if (test || !id || !pins[id]) return deps.log(`--lock needs an agent whose adapter is pinned: ${Object.keys(pins).join(", ")}.`), 2
    deps.log(`The lockfile of ${pins[id].package}@${pins[id].version}: what npm resolves for it now, each package with its sha512. Commit it with the pin.`)
    return (await lockPin(id, pins[id], deps)) ? 0 : 1
  }

  const rows = await status(test ? { [test]: pins[test] } : pins, deps.view, deps.readLock)
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
  const next = bumped(pins, test, row.newest, checks, new Date(deps.now()).toISOString().slice(0, 10))
  // The lockfile first: a pin is never written without the lockfile the app installs it from.
  if (!(await lockPin(test, next[test], deps))) return deps.log(`Not bumped: the pin stays ${row.pinned}.`), 1
  if (row.newest === row.pinned && pins[test].tested) deps.log(`The pin was ${row.newest} already: its test date is renewed.`)
  deps.writePins(next)
  deps.log(`Pinned ${spec} in src/main/agent-pins.json. Commit it and its lockfile (the app installs it from its next build).`)
  return 0
}
