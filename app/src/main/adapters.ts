// The pinned adapters (Claude Code's, Codex's: agent-pins.json), installed from the app's own
// lockfiles on the computer the agent runs on, this one or another over ssh (`Machine`), and
// started from there: never `npx`, which pins only the adapter itself and lets npm resolve the
// rest of its tree afresh on each computer, running every package's install script as the person.
//
// An install is `npm ci --ignore-scripts` with the lockfile the app carries (adapter-locks/), into
// ~/.bicycle42/adapters/<package>@<version>-<hash of the lockfile>/ on that computer, with that
// computer's own npm and node. npm checks every package it downloads against the sha512 in the
// lockfile and refuses one that differs; no package's script runs. It is done in a folder of its
// own beside the final one, which is renamed to the final name only once npm is done and the
// adapter's program is there: a folder at the final name is a whole install, and one that failed
// or was cut off (the app quit, the link dropped) is never used, and is taken away later.
//
// The lockfiles reach the other computer as two files written through `Machine` before npm runs
// (no change to the helper, and the same code here and there). A changed lockfile is another
// folder: what was installed from the old one is never mixed with the new.
import crypto from "node:crypto"
import { LOCK_FILES } from "./adapter-locks"
import type { Machine, RunResult } from "./machine"

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

/** An adapter as its lockfile has it: what is written into its folder before `npm ci`, the folder's
 *  name, and its program there. */
export type AdapterLock = {
  id: string
  package: string
  version: string
  /** The adapter's program, relative to its folder, "/"-separated:
   *  "node_modules/@agentclientprotocol/codex-acp/dist/index.js". */
  entry: string
  /** package.json and package-lock.json, as written. */
  files: { "package.json": string; "package-lock.json": string }
  /** The first 12 hex digits of the sha256 of both files. */
  hash: string
  /** "@agentclientprotocol+codex-acp@2.9.0-1a2b3c4d5e6f": one level, its package's "/" a "+". */
  folder: string
}

/** How long an install may take before it is given up (a slow link, a 300 MB platform package). */
export const adapterTiming = { install: 15 * 60_000 }

/** About how much an adapter's folder takes (Claude's and Codex's are 440 MB each, most of it
 *  the platform's program): said when a disk is full. */
const SIZE = "about 500 MB"

const text = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`

/** The adapter's lockfile in the shape installs use, from its two files' contents. Undefined when
 *  they are not of `pkg` at `version` or name no program `bin`: the pin is then started by npx. */
export function lockOf(id: string, pin: { package: string; version: string; bin: string }, manifest: unknown, lock: unknown): AdapterLock | undefined {
  const top = (lock as { packages?: Record<string, { version?: string; bin?: string | Record<string, string> }> } | undefined)?.packages?.[`node_modules/${pin.package}`]
  if (!top || top.version !== pin.version) return undefined
  const bin = typeof top.bin === "string" ? top.bin : top.bin?.[pin.bin]
  if (typeof bin !== "string") return undefined
  const parts = bin.split(/[\\/]+/).filter((p) => p && p !== ".")
  // An entry outside the package's own folder is not one the app starts.
  if (!parts.length || parts.includes("..")) return undefined
  const files = { "package.json": text(manifest), "package-lock.json": text(lock) }
  const hash = crypto.createHash("sha256").update(files["package.json"]).update("\0").update(files["package-lock.json"]).digest("hex").slice(0, 12)
  return { id, package: pin.package, version: pin.version, entry: ["node_modules", pin.package, ...parts].join("/"), files, hash, folder: `${pin.package.replace("/", "+")}@${pin.version}-${hash}` }
}

/** The lockfiles the app carries, by agent id, each made into an `AdapterLock` against its pin by
 *  agents.ts. Replaced by the tests (a fake adapter from a registry of their own). */
export const ADAPTER_LOCKS: Record<string, { manifest: unknown; lock: unknown }> = { ...LOCK_FILES }

/** ~/.bicycle42/adapters on that computer. */
export const adaptersDir = (m: Machine) => m.path.join(m.home, ".bicycle42", "adapters")
/** The folder an adapter is installed in on that computer. */
export const folderOf = (m: Machine, lock: AdapterLock) => m.path.join(adaptersDir(m), lock.folder)
/** Its program there. */
export const entryOf = (m: Machine, lock: AdapterLock) => m.path.join(folderOf(m, lock), ...lock.entry.split("/"))
/** The line that starts it: node on that computer's PATH, with its program. */
export const lineOf = (m: Machine, lock: AdapterLock) => ["node", entryOf(m, lock)]

const isFile = (m: Machine, p: string) => m.stat(p).then((s) => s.kind === "file", () => false)

/** Whether it is installed on that computer: its folder is there (only a whole install is
 *  renamed to it) with its program in it. */
export async function adapterInstalled(m: Machine, lock: AdapterLock): Promise<boolean> {
  return (await isFile(m, entryOf(m, lock))) && (await isFile(m, m.path.join(folderOf(m, lock), DONE)))
}

/** Written last into a whole install, before its folder gets its name: the lockfile's hash. */
const DONE = ".b42-installed"
/** What the folders of an install under way, and of one being taken away, start with. */
const INSTALLING = ".installing-"
const REMOVING = ".removing-"
/** An install folder older than this is one that was cut off (an install gives up after 15 minutes). */
const STALE_MS = 60 * 60_000

/** Installs under way, per computer and folder: two starts at once wait for the one install. */
const underway = new WeakMap<Machine, Map<string, Promise<void>>>()

export type InstallOptions = {
  /** The agent's name, for what is said ("Codex"). */
  name: string
  /** That computer's environment for agents (Machine.agentEnv): its PATH finds npm and node. */
  env: Record<string, string | undefined>
  /** The step under way, said in the window: "Installing the Codex adapter (first start)…". */
  onStep?(text: string): void
  log?: Log
}

/** Installs the adapter on that computer unless it is there already; rejects with a sentence. */
export function installAdapter(m: Machine, lock: AdapterLock, o: InstallOptions): Promise<void> {
  let mine = underway.get(m)
  if (!mine) underway.set(m, (mine = new Map()))
  const running = mine.get(lock.folder)
  if (running) return running
  const p = install(m, lock, o).finally(() => mine.delete(lock.folder))
  mine.set(lock.folder, p)
  return p
}

async function install(m: Machine, lock: AdapterLock, o: InstallOptions): Promise<void> {
  if (await adapterInstalled(m, lock)) return
  const log = o.log ?? (() => undefined)
  const where = m.local ? "this computer" : m.where
  const said = (rest: string) => `The ${o.name} adapter can't be installed on ${where}: ${rest}`
  const npm = await npmOf(m, o.env)
  if (!npm) throw new Error(said(`npm was not found there (it comes with node). Install node 22 or newer there, or the adapter itself: npm install -g ${lock.package}`))
  o.onStep?.(`Installing the ${o.name} adapter${m.local ? "" : ` on ${m.where}`} (first start)…`)
  const dir = adaptersDir(m)
  const tmp = m.path.join(dir, `${INSTALLING}${lock.folder}-${crypto.randomBytes(4).toString("hex")}`)
  const started = Date.now()
  try {
    await m.mkdir(tmp)
    await m.writeFile(m.path.join(tmp, "package.json"), lock.files["package.json"])
    await m.writeFile(m.path.join(tmp, "package-lock.json"), lock.files["package-lock.json"])
  } catch (err) {
    await m.rm(tmp).catch(() => undefined)
    throw new Error(said(fsFailure(err)))
  }
  // Installs cut off before (the app quit, the link dropped) go, by that computer's clock.
  void sweep(m, dir, tmp, log)
  log("info", `installing ${lock.package}@${lock.version} on ${where}`, { folder: lock.folder })
  const node = (await m.which("node", o.env)) ?? "node"
  const r = await m.run(node, ["-e", WATCHDOG, String(adapterTiming.install), npm.program, ...npm.args, ...NPM_CI], {
    cwd: tmp,
    // npm's settings for a script it runs (an app started with `npm start`, the tests under `npm
    // test`: its cache, its prefix, the folder it ran in) are not the person's: left out. Their
    // own ~/.npmrc (a mirror, a proxy) is still read.
    clearPrefix: "npm_config_",
    // That computer's PATH with its login shell's: npm's own `#!/usr/bin/env node` finds node.
    env: { PATH: o.env.PATH ?? "", npm_config_update_notifier: "false", npm_config_progress: "false" },
    // The watchdog ends npm; this is in case the watchdog itself does not.
    timeout: adapterTiming.install + 30_000,
    maxBuffer: 8 << 20,
  })
  if (r.code !== 0) {
    await m.rm(tmp).catch(() => undefined)
    log("warn", `npm ci of ${lock.package}@${lock.version} failed on ${where}`, { code: r.code, signal: r.signal, error: r.error, err: r.err.slice(-4000) })
    throw new Error(npmFailure(r, { name: o.name, where, package: lock.package, version: lock.version }))
  }
  // npm said it was done: the program must be where the lockfile says it is.
  if (!(await isFile(m, m.path.join(tmp, ...lock.entry.split("/"))))) {
    await m.rm(tmp).catch(() => undefined)
    throw new Error(said(`npm installed it, but its program is not where its lockfile says (${lock.entry})`))
  }
  try {
    await m.writeFile(m.path.join(tmp, DONE), `${lock.hash}\n`)
    await m.rename(tmp, folderOf(m, lock))
  } catch (err) {
    await m.rm(tmp).catch(() => undefined)
    // Another install of it (another app on that computer) was done first: that one is used.
    if (await adapterInstalled(m, lock)) return
    throw new Error(said(fsFailure(err)))
  }
  log("info", `installed ${lock.package}@${lock.version} on ${where} in ${Math.round((Date.now() - started) / 1000)} s`, { folder: lock.folder })
}

/** `npm ci` with the lockfile and nothing else: no package's script, no audit or funding call;
 *  the optional packages too (the platform's program is one), whatever an npmrc says; and a
 *  download that fails its sha512 (npm tries it again, twice three times) retried after seconds,
 *  not npm's minute, so a refusal is said in under half a minute. */
const NPM_CI = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--include=optional", "--fetch-retry-mintimeout=2000", "--fetch-retry-maxtimeout=8000"]

/** Runs npm (argv: the ms it may take, then npm's program and words) and ends it with SIGKILL when
 *  that time is up, exiting 124: npm ignores SIGTERM while a download hangs (it ran on for good),
 *  and macOS has no `timeout`. Its own exit code otherwise; 127 when npm can't be started. */
const WATCHDOG = [
  'const { spawn } = require("child_process")',
  "const [ms, program, ...args] = process.argv.slice(1)",
  'const child = spawn(program, args, { stdio: "inherit" })',
  'const timer = setTimeout(() => { process.stderr.write("b42: npm ran out of time\\n"); child.kill("SIGKILL") }, Number(ms))',
  'child.on("error", (e) => { process.stderr.write(`b42: cannot start npm: ${e.code} ${e.message}\\n`); process.exit(127) })',
  'child.on("exit", (code, signal) => { clearTimeout(timer); process.exit(signal ? 124 : code) })',
].join("\n")

/** npm on that computer, as a program and the words before its own: on Windows npm is a .cmd,
 *  which is run only through cmd.exe, so its script is run with node instead. */
async function npmOf(m: Machine, env: Record<string, string | undefined>): Promise<{ program: string; args: string[] } | undefined> {
  if (m.platform !== "win32") {
    const npm = await m.which("npm", env)
    return npm ? { program: npm, args: [] } : undefined
  }
  const node = await m.which("node", env)
  if (!node) return undefined
  const cli = m.path.join(m.path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js")
  return (await isFile(m, cli)) ? { program: node, args: [cli] } : undefined
}

/** What went wrong with a file of the install, as the end of a sentence. */
function fsFailure(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  if (e?.code === "ENOSPC") return `its disk is full (an adapter takes ${SIZE}). Free some space there and start it again`
  if (e?.code === "EACCES" || e?.code === "EPERM") return `the app may not write in ~/.bicycle42/adapters there (${e.message})`
  return e?.message ?? String(err)
}

/** Why `npm ci` failed, as the sentence the window says. Offline, a full disk, a package whose
 *  sha512 differs from the lockfile's (refused: never installed), a timeout, or npm's own words. */
export function npmFailure(r: RunResult, c: { name: string; where: string; package: string; version: string }): string {
  const head = `The ${c.name} adapter can't be installed on ${c.where}`
  if (r.error?.code === "ENOENT" || (r.code === 127 && /b42: cannot start npm: ENOENT/.test(r.err))) return `${head}: npm was not found there (it comes with node).`
  if ((r.code === 124 && /b42: npm ran out of time/.test(r.err)) || (r.code === null && !r.error)) return `${head}: npm did not finish in ${adapterTiming.install >= 60_000 ? `${Math.round(adapterTiming.install / 60_000)} minutes` : `${Math.round(adapterTiming.install / 1000)} s`}${r.signal ? ` (it was ended, ${r.signal})` : ""}. Is the link to npm's registry slow? Start it again to try once more.`
  const said = `${r.err}\n${r.out}`
  const code = /npm (?:error|ERR!) code (\w+)/.exec(said)?.[1] ?? /\b(E[A-Z]{3,})\b/.exec(said)?.[1]
  if (code === "EINTEGRITY" || /integrity checksum failed/i.test(said)) {
    // npm names the package whose download is not what it should be in its warning before.
    const name = /tarball data for ((?:@[\w.-]+\/)?[\w.-]+)@/.exec(said)?.[1]
    const base = name?.split("/").pop()?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const version = base && new RegExp(`/${base}-(\\d[^/\\s]*?)\\.tgz`).exec(said)?.[1]
    const of = name ? ` (${name}${version ? ` ${version}` : ""})` : ""
    return `${head}: npm refused it, because what it downloaded${of} differs from what the app tested: its sha512 is not the one in the app's lockfile. Nothing of it was installed. If ${c.where === "this computer" ? "this computer" : c.where} gets npm packages through a mirror or a proxy, it may be serving other files.`
  }
  if (code === "ENOSPC" || /no space left on device/i.test(said)) return `${head}: its disk is full (an adapter takes ${SIZE}). Free some space there and start it again.`
  if (code && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ERR_SOCKET_TIMEOUT"].includes(code)) {
    const host = /(?:request to |getaddrinfo \w+ |connect \w+ )(?:https?:\/\/)?([^/\s:]+)/.exec(said)?.[1]
    return `${head}: npm could not reach its registry${host ? ` (${host})` : ""}. Is ${c.where === "this computer" ? "this computer" : c.where} offline? Start it again once it is online.`
  }
  if (code === "E404" || code === "ETARGET") return `${head}: npm's registry no longer has a package of it (${lastLines(said, 1)}).`
  if (code === "EACCES" || code === "EPERM") return `${head}: npm was not allowed to write there (${lastLines(said, 1)}).`
  if (r.error) return `${head}: ${r.error.message}.`
  return `${head}: npm ci failed (exit code ${r.code}): ${lastLines(said, 3) || "it said nothing"}.`
}

/** npm's last error lines, without its "npm error" and its log's address. */
function lastLines(said: string, n: number): string {
  return said
    .split("\n")
    .map((l) => l.replace(/^npm (?:error|ERR!)\s*/, "").trim())
    .filter((l) => l && !/complete log of this run|^A complete log|^code \w+$|^\d{4}-\d\d-\d\dT/.test(l))
    .slice(-n)
    .join(" ")
}

/** Takes away install folders older than an hour (each cut off: an install gives up after 15
 *  minutes), and what was left of folders being taken away. `now` is a file just written there,
 *  whose time is that computer's clock. Never rejects. */
async function sweep(m: Machine, dir: string, now: string, log: Log): Promise<void> {
  try {
    const at = (await m.stat(m.path.join(now, "package.json"))).mtimeMs
    for (const e of await m.readdir(dir)) {
      if (e.kind !== "dir") continue
      const p = m.path.join(dir, e.name)
      if (p === now) continue
      if (e.name.startsWith(REMOVING)) await m.rm(p)
      else if (e.name.startsWith(INSTALLING) && at - (await m.stat(p)).mtimeMs > STALE_MS) {
        log("info", "removing an adapter install that was cut off", { folder: e.name })
        await m.rm(p)
      }
    }
  } catch (err) {
    log("warn", "can't tidy the adapters' installs", String(err))
  }
}

/** -1, 0 or 1 as semver orders two versions (as scripts/agent-pins.mjs does). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("+")[0]!.split(/-(.*)/s)
    return { core: core.split(".").map((n) => Number(n) || 0), pre: pre ? pre.split(".") : [] }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) < (y.core[i] ?? 0) ? -1 : 1
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

/** The command lines of every process on that computer, or undefined when they can't be read
 *  (then nothing is taken away). `ps` on macOS and Linux (-ww: whole lines); PowerShell on Windows. */
export async function processLines(m: Machine): Promise<string[] | undefined> {
  const tries: [string, string[]][] =
    m.platform === "win32"
      ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"]]]
      : [
          ["ps", ["-A", "-ww", "-o", "args="]],
          // busybox's ps knows none of those, and lists every process anyway.
          ["ps", ["-o", "args"]],
        ]
  for (const [program, args] of tries) {
    const r = await m.run(program, args, { timeout: 15_000, maxBuffer: 32 << 20 }).catch(() => undefined)
    if (r && r.code === 0 && r.out.trim()) return r.out.split("\n")
  }
  return undefined
}

/** Takes away the folders of older installs of the same adapter on that computer: those of an
 *  older version, and those of the same version from another lockfile that were installed before
 *  this one. A newer version's (another app on that computer, of a newer build) is kept. One
 *  whose program is running now (any process's command line names its folder: an agent the
 *  helper keeps while the app is away, or another app's) is kept too, and goes at a later start;
 *  so is every one when the processes can't be listed. A folder is renamed away before it is
 *  removed, so a start never finds half of one. Never rejects. */
export function tidyAdapters(m: Machine, lock: AdapterLock, log: Log = () => undefined): Promise<string[]> {
  // One at a time per computer and adapter: a second waits for the first, then looks again.
  let mine = tidying.get(m)
  if (!mine) tidying.set(m, (mine = new Map()))
  const next = (mine.get(lock.package) ?? Promise.resolve([])).then(() => tidy(m, lock, log))
  mine.set(lock.package, next)
  void next.finally(() => mine.get(lock.package) === next && mine.delete(lock.package))
  return next
}
const tidying = new WeakMap<Machine, Map<string, Promise<string[]>>>()

async function tidy(m: Machine, lock: AdapterLock, log: Log): Promise<string[]> {
  const removed: string[] = []
  try {
    const dir = adaptersDir(m)
    const prefix = `${lock.package.replace("/", "+")}@`
    const entries = await m.readdir(dir).catch(() => [])
    const mineAt = (await m.stat(folderOf(m, lock)).catch(() => undefined))?.mtimeMs
    const older: string[] = []
    for (const e of entries) {
      if (e.kind !== "dir" || !e.name.startsWith(prefix) || e.name === lock.folder) continue
      const version = /^(.*)-[0-9a-f]{12}$/.exec(e.name.slice(prefix.length))?.[1]
      if (!version) continue
      const order = compareVersions(version, lock.version)
      if (order > 0) continue
      if (order === 0) {
        const at = (await m.stat(m.path.join(dir, e.name)).catch(() => undefined))?.mtimeMs
        if (mineAt === undefined || at === undefined || at >= mineAt) continue
      }
      older.push(e.name)
    }
    if (!older.length) return removed
    const lines = await processLines(m)
    if (!lines) {
      log("info", "kept older adapters: the processes there can't be listed", { older })
      return removed
    }
    for (const name of older) {
      if (lines.some((l) => l.includes(name))) {
        log("info", "kept an older adapter: it is running", { folder: name })
        continue
      }
      const away = m.path.join(dir, `${REMOVING}${name}`)
      await m.rename(m.path.join(dir, name), away)
      await m.rm(away)
      removed.push(name)
    }
    if (removed.length) log("info", `removed older adapters on ${m.where}`, { removed })
  } catch (err) {
    log("warn", "can't tidy the adapters", String(err))
  }
  return removed
}
