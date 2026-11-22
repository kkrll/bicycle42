// The pinned adapters (Claude Code's, Codex's: agent-pins.json), installed from the app's own
// lockfiles on the computer the agent runs on, this one or another over ssh (`Machine`), and
// started from there: never `npx`, which pins only the adapter itself and lets npm resolve the
// rest of its tree afresh on each computer, running every package's install script as the person.
//
// An install is `npm ci --ignore-scripts` with the lockfile the app carries (adapter-locks/), into
// ~/.bicycle42/adapters/<package>@<version>-<hash of the lockfile>/ on that computer, with that
// computer's own npm and node. npm checks every package it downloads against the sha512 in the
// lockfile and refuses one that differs; no package's script runs. It is done in a folder of its
// own beside the final one, which is renamed to the final name only once npm is done, every
// package the lockfile names for that computer is in npm's record of the install, and the
// adapter's program is there, the lockfile's hash written in it last: a folder at the final name
// with that hash is a whole install (anything else there is moved aside), and one that failed or
// was cut off (the app quit, the link dropped: npm's watchdog then ends npm) is never used, and is
// taken away later. Installs of the same adapter go once unused for 14 days (`tidyAdapters`).
//
// The lockfiles reach the other computer as two files written through `Machine` before npm runs
// (no change to the helper, and the same code here and there). A changed lockfile is another
// folder: what was installed from the old one is never mixed with the new.
import crypto from "node:crypto"
import fs from "node:fs"
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

/** How long an install may take before it is given up (a slow link, a 300 MB platform package);
 *  how long npm runs on once the app no longer says it waits for it (`lease`: the app quit, the
 *  link dropped); and how much longer than `install` the app waits for the watchdog itself. */
export const adapterTiming = { install: 15 * 60_000, lease: 60_000, grace: 30_000 }

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

/** ~/.bicycle42 on that computer. */
const appDir = (m: Machine) => m.path.join(m.home, ".bicycle42")
/** ~/.bicycle42/adapters on that computer. */
export const adaptersDir = (m: Machine) => m.path.join(appDir(m), "adapters")
/** The folder an adapter is installed in on that computer. */
export const folderOf = (m: Machine, lock: AdapterLock) => m.path.join(adaptersDir(m), lock.folder)
/** Its program there. */
export const entryOf = (m: Machine, lock: AdapterLock) => m.path.join(folderOf(m, lock), ...lock.entry.split("/"))
/** The line that starts it: node on that computer's PATH, with its program. */
export const lineOf = (m: Machine, lock: AdapterLock) => ["node", entryOf(m, lock)]

const isFile = (m: Machine, p: string) => m.stat(p).then((s) => s.kind === "file", () => false)

/** Whether it is installed on that computer: its program is in its folder, and the folder says it
 *  is a whole install of this very lockfile (only a whole install is renamed to that name, with
 *  its hash written last). */
export async function adapterInstalled(m: Machine, lock: AdapterLock): Promise<boolean> {
  if (!(await isFile(m, entryOf(m, lock)))) return false
  const done = await m.readFile(m.path.join(folderOf(m, lock), DONE)).catch(() => "")
  return done.trim() === lock.hash
}

/** Written last into a whole install, before its folder gets its name: the lockfile's hash. */
const DONE = ".b42-installed"
/** Written at each start that uses an install: its time (that computer's clock) is its last use. */
const USED = ".b42-used"
/** Written by the app every few seconds while it waits for npm: the watchdog ends npm when it is
 *  not (`adapterTiming.lease`). */
const LEASE = ".b42-lease"
/** What the folders of an install under way, and of one being taken away, start with. */
const INSTALLING = ".installing-"
const REMOVING = ".removing-"
/** An install folder older than this is one that was cut off (an install gives up after 15 minutes). */
const STALE_MS = 60 * 60_000
/** An install of the same adapter not used for this long (by that computer's clock) is taken away. */
export const UNUSED_MS = 14 * 24 * 3600_000

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
  const p = install(m, lock, o)
    .catch((err: unknown) => {
      // The link to that computer dropped on the way (any call of the install's then fails, npm's
      // too, with ssh's words): said as that. npm there is ended by its watchdog once the app no
      // longer writes its lease, and its folder goes with it.
      if (!m.local && m.reach().status === "down") throw new Error(`The connection to ${m.where} ended while installing the ${o.name} adapter; it will be tried again at the next start.`)
      throw err
    })
    .finally(() => mine.delete(lock.folder))
  mine.set(lock.folder, p)
  return p
}

/** ~/.bicycle42 and its adapters folder, made the app's alone (0700). On another computer the
 *  helper makes them so (its umask is 077); here, they are made so, and made so again when an
 *  earlier version left them open to others. */
async function makeDirs(m: Machine): Promise<void> {
  if (!m.local || m.platform === "win32") return m.mkdir(adaptersDir(m))
  for (const d of [appDir(m), adaptersDir(m)]) {
    await fs.promises.mkdir(d, { recursive: true, mode: 0o700 })
    if (((await fs.promises.stat(d)).mode & 0o777) !== 0o700) await fs.promises.chmod(d, 0o700)
  }
}

/** Moves a folder of the adapters out of the way, to be removed (now, but not waited for): renamed
 *  first, so nothing ever finds half of it at its name. */
async function moveAside(m: Machine, p: string, log: Log): Promise<void> {
  const away = m.path.join(adaptersDir(m), `${REMOVING}${m.path.basename(p)}-${crypto.randomBytes(4).toString("hex")}`)
  await m.rename(p, away)
  void m.rm(away).catch((err) => log("warn", "can't remove an adapter's folder moved aside", { folder: away, error: String(err) }))
}

/** Something at the install's name that is not a whole install of this lockfile (a folder copied
 *  in part, one of another lockfile's hash, a file): moved aside, or the install could never be
 *  put there. */
async function clearWay(m: Machine, lock: AdapterLock, log: Log): Promise<void> {
  const final = folderOf(m, lock)
  if (!(await m.lstat(final).then(() => true, () => false))) return
  // Looked at again now that it is there: another app on that computer may have just put a whole one there.
  if (await adapterInstalled(m, lock)) return
  log("info", "moving aside a folder at the adapter's name that is not a whole install", { folder: lock.folder })
  await moveAside(m, final, log)
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
  const final = folderOf(m, lock)
  const tmp = m.path.join(dir, `${INSTALLING}${lock.folder}-${crypto.randomBytes(4).toString("hex")}`)
  const lease = m.path.join(tmp, LEASE)
  const started = Date.now()
  try {
    await makeDirs(m)
    await clearWay(m, lock, log)
    if (await adapterInstalled(m, lock)) return
    await m.mkdir(tmp)
    await m.writeFile(m.path.join(tmp, "package.json"), lock.files["package.json"])
    await m.writeFile(m.path.join(tmp, "package-lock.json"), lock.files["package-lock.json"])
    await m.writeFile(lease, "")
  } catch (err) {
    await m.rm(tmp).catch(() => undefined)
    throw new Error(said(fsFailure(err)))
  }
  // Installs cut off before (the app quit, the link dropped) go, by that computer's clock.
  void sweep(m, dir, tmp, log)
  log("info", `installing ${lock.package}@${lock.version} on ${where}`, { folder: lock.folder })
  const node = (await m.which("node", o.env)) ?? "node"
  // The app says it still waits for npm: written every few seconds while it does. Once it is
  // not (the app quit, the link dropped), the watchdog ends npm and removes the folder.
  const beat = setInterval(() => void m.writeFile(lease, "").catch(() => undefined), Math.max(50, Math.floor(adapterTiming.lease / 6)))
  let r: RunResult
  try {
    r = await m.run(node, ["-e", WATCHDOG, String(adapterTiming.install), LEASE, String(adapterTiming.lease), npm.program, ...npm.args, ...NPM_CI], {
      cwd: tmp,
      // npm's settings for a script it runs (an app started with `npm start`, the tests under `npm
      // test`: its cache, its prefix, the folder it ran in) are not the person's: left out, and
      // NPM_CONFIG_* with them (npm reads either). Their own ~/.npmrc (a mirror, a proxy) is
      // still read; what in it could leave a package out is overruled by NPM_CI's words, and
      // what is installed is checked after against the lockfile.
      clearPrefix: "npm_config_",
      // That computer's PATH with its login shell's: npm's own `#!/usr/bin/env node` finds node.
      env: { PATH: o.env.PATH ?? "", npm_config_update_notifier: "false", npm_config_progress: "false" },
      // The watchdog ends npm; this is in case the watchdog itself does not (it then ends npm too).
      timeout: adapterTiming.install + adapterTiming.grace,
      maxBuffer: 8 << 20,
    })
  } finally {
    clearInterval(beat)
  }
  if (r.code !== 0) {
    await m.rm(tmp).catch(() => undefined)
    log("warn", `npm ci of ${lock.package}@${lock.version} failed on ${where}`, { code: r.code, signal: r.signal, error: r.error, err: r.err.slice(-4000) })
    throw new Error(npmFailure(r, { name: o.name, where, package: lock.package, version: lock.version }))
  }
  // npm said it was done: every package the lockfile names for that computer must be there (an
  // npm setting there may have left some out, or a download of an optional one failed)…
  const left = await leftOut(m, node, tmp, lock).catch((err: Error) => ({ error: err.message }))
  if ("error" in left || left.missing.length) {
    await m.rm(tmp).catch(() => undefined)
    if ("error" in left) throw new Error(said(`what npm installed can't be checked (${left.error}). Nothing of it was kept.`))
    log("warn", `npm ci of ${lock.package}@${lock.version} left packages out on ${where}`, { missing: left.missing, platform: left.platform })
    const named = left.missing.slice(0, 3).join(", ") + (left.missing.length > 3 ? `, and ${left.missing.length - 3} more` : "")
    throw new Error(
      said(
        left.recorded
          ? `npm said it was done, but left out ${left.missing.length === 1 ? "a package" : `${left.missing.length} packages`} its lockfile names for ${left.platform} (${named}): an npm setting there (os, cpu or libc in an npmrc) may leave them out, or a download of one failed. Nothing of it was kept; start it again to try once more.`
          : "npm said it was done, but left no record of what it installed (node_modules/.package-lock.json): npm 7 or newer is needed there. Nothing of it was kept.",
      ),
    )
  }
  // …and the program where the lockfile says it is.
  if (!(await isFile(m, m.path.join(tmp, ...lock.entry.split("/"))))) {
    await m.rm(tmp).catch(() => undefined)
    throw new Error(said(`npm installed it, but its program is not where its lockfile says (${lock.entry})`))
  }
  try {
    await m.rm(lease)
    await m.writeFile(m.path.join(tmp, DONE), `${lock.hash}\n`)
    await m.rename(tmp, final)
  } catch (err) {
    // Another install of it (another app on that computer) was done first: that one is used.
    if (await adapterInstalled(m, lock)) return void (await m.rm(tmp).catch(() => undefined))
    // Something else took its name meanwhile: moved aside, and put there once more.
    try {
      await clearWay(m, lock, log)
      await m.rename(tmp, final)
    } catch (again) {
      await m.rm(tmp).catch(() => undefined)
      if (await adapterInstalled(m, lock)) return
      log("warn", `can't put ${lock.folder} at its name on ${where}`, { first: String(err), then: String(again) })
      throw new Error(said(`its folder can't be put at ~/.bicycle42/adapters/${lock.folder} (${fsFailure(again)}). Move what is there away and start it again.`))
    }
  }
  log("info", `installed ${lock.package}@${lock.version} on ${where} in ${Math.round((Date.now() - started) / 1000)} s`, { folder: lock.folder })
}

/** Marks the install as used now (by that computer's clock): installs of the same adapter are
 *  taken away only once unused for `UNUSED_MS`. Never rejects. */
export async function markUsed(m: Machine, lock: AdapterLock, log: Log = () => undefined): Promise<void> {
  await m.writeFile(m.path.join(folderOf(m, lock), USED), `${new Date().toISOString()}\n`).catch((err) => log("warn", "can't mark the adapter as used", String(err)))
}

/** `npm ci` with the lockfile and nothing else: no package's script, no audit or funding call;
 *  the optional and the peer packages too (the platform's program is an optional one; 102 of
 *  Claude's adapter's 115 are peers), laid out as the lockfile is, whatever an npmrc or npm's
 *  environment says (`legacy-peer-deps` or `omit=peer` left Claude's adapter with 6 packages of
 *  108, said to be done); and a download that fails its sha512 (npm tries it again, twice three
 *  times) retried after seconds, not npm's minute, so a refusal is said in under half a minute. */
export const NPM_CI = [
  "ci",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--include=optional",
  "--include=peer",
  "--legacy-peer-deps=false",
  "--install-strategy=hoisted",
  "--fetch-retry-mintimeout=2000",
  "--fetch-retry-maxtimeout=8000",
]

/** Runs npm (argv: the ms it may take, the lease file, the ms it may go unwritten, then npm's
 *  program and words) in a process group of its own, and ends that group with SIGKILL: when its
 *  time is up, exiting 124 (npm ignores SIGTERM while a download hangs, and macOS has no
 *  `timeout`); when the lease file has not been written for its ms (the app quit, or the link to
 *  it dropped: this computer's helper runs on), removing the install's folder too; and when the
 *  watchdog itself is ended (the app's own timeout, its output too long), before it ends the same
 *  way. Its own exit code otherwise; 127 when npm can't be started. */
export const WATCHDOG = [
  'const { spawn } = require("child_process")',
  'const fs = require("fs")',
  "const [ms, lease, leaseMs, program, ...args] = process.argv.slice(1)",
  'const windows = process.platform === "win32"',
  'const child = spawn(program, args, { stdio: "inherit", detached: !windows, windowsHide: true })',
  "let lost = false",
  "const end = (why) => {",
  "  if (why) process.stderr.write(`b42: ${why}\\n`)",
  "  try { if (windows || !child.pid) child.kill(\"SIGKILL\"); else process.kill(-child.pid, \"SIGKILL\") } catch {}",
  "}",
  'const timer = setTimeout(() => end("npm ran out of time"), Number(ms))',
  "const beat = setInterval(() => {",
  "  let at = 0",
  "  try { at = fs.statSync(lease).mtimeMs } catch {}",
  '  if (Date.now() - at > Number(leaseMs)) { lost = true; clearInterval(beat); end("the app stopped waiting for npm") }',
  "}, Math.max(50, Math.floor(Number(leaseMs) / 6)))",
  'for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => { end(); process.removeAllListeners(sig); process.kill(process.pid, sig) })',
  'child.on("error", (e) => { process.stderr.write(`b42: cannot start npm: ${e.code} ${e.message}\\n`); process.exit(127) })',
  'child.on("exit", (code, signal) => {',
  "  clearTimeout(timer)",
  "  clearInterval(beat)",
  "  if (lost) { try { fs.rmSync(process.cwd(), { recursive: true, force: true }) } catch {} process.exit(125) }",
  "  process.exit(signal ? 124 : code)",
  "})",
].join("\n")

/** Run on that computer in the install's folder once npm is done: its platform as npm reads it
 *  (os, cpu, and on Linux libc: /usr/bin/ldd, else node's report, as npm-install-checks does), and
 *  each package npm recorded as installed (node_modules/.package-lock.json, npm's own record) with
 *  its version; `packages` null when there is no record. */
const INSTALLED = [
  'const fs = require("fs")',
  "let libc = null",
  'if (process.platform === "linux") {',
  '  try { const t = fs.readFileSync("/usr/bin/ldd", "utf8"); libc = t.includes("musl") ? "musl" : t.includes("GNU C Library") ? "glibc" : null }',
  "  catch {",
  "    try { const r = process.report.getReport(); libc = r.header && r.header.glibcVersionRuntime ? \"glibc\" : (r.sharedObjects || []).some((f) => f.includes(\"libc.musl-\") || f.includes(\"ld-musl-\")) ? \"musl\" : null } catch {}",
  "  }",
  "}",
  "let packages = null",
  'try { packages = {}; for (const [k, p] of Object.entries(JSON.parse(fs.readFileSync("node_modules/.package-lock.json", "utf8")).packages || {})) packages[k] = p && p.version } catch { packages = null }',
  "process.stdout.write(JSON.stringify({ os: process.platform, cpu: process.arch, libc, packages }))",
].join("\n")

export type Platform = { os: string; cpu: string; libc: string | null }
type LockEntry = { version?: string; link?: boolean; dev?: boolean; os?: string | string[]; cpu?: string | string[]; libc?: string | string[] }

/** Whether a package of the lockfile is for that platform, as npm decides (npm-install-checks'
 *  checkPlatform): its os, cpu and libc lists, "!x" meaning not x. */
export function fitsPlatform(p: LockEntry, at: Platform): boolean {
  const ok = (value: string | null, list: string | string[] | undefined) => {
    if (!list) return true
    const all = typeof list === "string" ? [list] : list
    if (value === null) return false
    if (all.length === 1 && all[0] === "any") return true
    let negated = 0
    let match = false
    for (const e of all) {
      if (e.startsWith("!")) {
        negated++
        if (e.slice(1) === value) return false
      } else match ||= e === value
    }
    return match || negated === all.length
  }
  return ok(at.os, p.os) && ok(at.cpu, p.cpu) && (!p.libc || ok(at.libc, p.libc))
}

/** The packages of the lockfile for that platform that npm's record does not have at their
 *  version ("name version"), every one when there is no record. */
export function missingPackages(lock: unknown, installed: Record<string, string | undefined> | null, at: Platform): string[] {
  const packages = (lock as { packages?: Record<string, LockEntry> } | undefined)?.packages ?? {}
  const missing: string[] = []
  for (const [key, p] of Object.entries(packages)) {
    if (!key || p.link || p.dev || !fitsPlatform(p, at)) continue
    if (installed?.[key] !== p.version) missing.push(`${key.replace(/^.*node_modules\//, "")} ${p.version}`)
  }
  return missing
}

/** What npm left out of an install in `tmp`, by its own record, for the platform of that computer. */
async function leftOut(m: Machine, node: string, tmp: string, lock: AdapterLock): Promise<{ missing: string[]; recorded: boolean; platform: string }> {
  const r = await m.run(node, ["-e", INSTALLED], { cwd: tmp, timeout: 60_000, maxBuffer: 32 << 20 })
  if (r.code !== 0) throw new Error(r.error?.message ?? (lastLines(r.err, 1) || `node exited ${r.code}`))
  const got = JSON.parse(r.out) as Platform & { packages: Record<string, string> | null }
  return {
    missing: missingPackages(JSON.parse(lock.files["package-lock.json"]), got.packages, got),
    recorded: !!got.packages,
    platform: `${got.os} ${got.cpu}${got.libc ? ` ${got.libc}` : ""}`,
  }
}

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
  if (r.code === 125 && /b42: the app stopped waiting for npm/.test(r.err)) return `${head}: npm was ended there, because the app's word that it still waited (written every few seconds) did not reach it for ${Math.round(adapterTiming.lease / 1000)} s. Start it again to try once more.`
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

/** Takes away the folders of other installs of the same adapter on that computer that have not
 *  been used for `UNUSED_MS` (14 days) by that computer's clock (each start marks the one it uses:
 *  `markUsed`; one from before that mark counts from when it was installed). Two builds of the app
 *  with the same version from other lockfiles, or two apps reaching that computer over ssh, each
 *  keep their own, used now and then: neither takes the other's away. The current one is never
 *  taken, nor one whose program is running now (any process's command line names its folder: an
 *  agent the helper keeps while the app is away, or another app's), nor any when the processes
 *  can't be listed. A folder is renamed away before it is removed, so a start never finds half of
 *  one, and put back if it was marked used meanwhile. Never rejects. */
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

/** When an install was last used, by that computer's clock: its mark, else when it was installed,
 *  else its folder's time. */
async function lastUsed(m: Machine, folder: string): Promise<number | undefined> {
  for (const p of [m.path.join(folder, USED), m.path.join(folder, DONE), folder]) {
    const at = await m.stat(p).then((s) => s.mtimeMs, () => undefined)
    if (at !== undefined) return at
  }
  return undefined
}

async function tidy(m: Machine, lock: AdapterLock, log: Log): Promise<string[]> {
  const removed: string[] = []
  try {
    const dir = adaptersDir(m)
    const prefix = `${lock.package.replace("/", "+")}@`
    // Now, by that computer's clock: the current install's mark, just written.
    const now = await m.stat(m.path.join(folderOf(m, lock), USED)).then((s) => s.mtimeMs, () => undefined)
    if (now === undefined) return removed
    const unused = (at: number | undefined) => at !== undefined && now - at > UNUSED_MS
    const stale: string[] = []
    for (const e of await m.readdir(dir).catch(() => [])) {
      if (e.kind !== "dir" || !e.name.startsWith(prefix) || e.name === lock.folder) continue
      if (!/^.+-[0-9a-f]{12}$/.test(e.name.slice(prefix.length))) continue
      if (unused(await lastUsed(m, m.path.join(dir, e.name)))) stale.push(e.name)
    }
    if (!stale.length) return removed
    const lines = await processLines(m)
    if (!lines) {
      log("info", "kept unused adapters: the processes there can't be listed", { stale })
      return removed
    }
    for (const name of stale) {
      if (lines.some((l) => l.includes(name))) {
        log("info", "kept an unused adapter: it is running", { folder: name })
        continue
      }
      const at = m.path.join(dir, name)
      const away = m.path.join(dir, `${REMOVING}${name}`)
      await m.rename(at, away)
      // Marked used since it was looked at (another app's start): put back.
      if (!unused(await lastUsed(m, away))) {
        await m.rename(away, at).catch(() => m.rm(away))
        continue
      }
      await m.rm(away)
      removed.push(name)
    }
    if (removed.length) log("info", `removed unused adapters on ${m.where}`, { removed })
  } catch (err) {
    log("warn", "can't tidy the adapters", String(err))
  }
  return removed
}
