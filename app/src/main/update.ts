// Squirrel (electron-updater) refuses ad-hoc signed builds, so the app updates itself from latest.json.
//
// The updater's folder holds, under its version's name, each release downloaded, unpacked and
// verified ("staged"), and `download/`, the one being made, which takes its version's name only
// once all that is done. What is staged and newer than the running app outlives a quit: it is
// verified again at the next start and offered again.
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import type { UpdateInfo } from "../shared/types"

export type Manifest = { version: string; url: string; sha256: string }

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

/** What a check comes to. "downloading" is said at once, and then how that ended ("ready" or
 *  "failed"); every other is the only one of its check. "failed" without a version: the check
 *  itself did not get through. */
export type Outcome =
  | { status: "latest" }
  | { status: "downloading" | "ready"; version: string }
  | { status: "manual"; version: string; reason: string }
  | { status: "failed"; version?: string; reason: string }

export type Updater = {
  state(): UpdateInfo | undefined
  /** Resolves, once any download has ended, to the newer version found, or undefined when this
   *  one is the latest; rejects when the check did not get through. `tell` hears every outcome
   *  as soon as it is known, of a check already under way too: always at least one. */
  check(tell?: (outcome: Outcome) => void): Promise<string | undefined>
  /** Starts the swap and resolves once the app may quit. Throws when nothing is staged. */
  install(): Promise<void>
  dispose(): void
}

const exec = promisify(execFile)
/** A tool of the system's, ended when it takes minutes: a check always comes to its end. */
const run = (file: string, args: string[]) => exec(file, args, { timeout: 5 * 60_000 })

/** The system's rm: Electron's fs takes an app.asar for a folder, and its promises.rm then fails. */
const remove = (at: string) => run("/bin/rm", ["-rf", at])

const VERSION = /^\d+\.\d+\.\d+([-.][\w.-]+)?$/
/** The folder a download is made in: no version's name. */
const DOWNLOAD = "download"

/** Why something failed, for the person: a fetch's own message is only "fetch failed". */
function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  return err.cause instanceof Error && err.cause.message ? `${err.message} (${err.cause.message})` : err.message
}

/** 1.2.3 and 1.2.3-preview.4 style versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const bare = v.replace(/^v/, "")
    // On the first "-" only: a prerelease may have more of them (1.0.0-beta-2).
    const at = bare.indexOf("-")
    return { main: (at < 0 ? bare : bare.slice(0, at)).split(".").map((n) => Number(n) || 0), pre: at < 0 ? undefined : bare.slice(at + 1) }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre.localeCompare(y.pre, "en", { numeric: true }) < 0 ? -1 : 1
}

export function parseManifest(value: unknown): Manifest | undefined {
  if (!value || typeof value !== "object") return undefined
  const { version, url, sha256 } = value as Record<string, unknown>
  if (typeof version !== "string" || !VERSION.test(version.replace(/^v/, ""))) return undefined
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return undefined
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) return undefined
  return { version: version.replace(/^v/, ""), url, sha256: sha256.toLowerCase() }
}

export function bundleOf(exe: string): string | undefined {
  const at = exe.lastIndexOf(".app/Contents/MacOS/")
  return at < 0 ? undefined : exe.slice(0, at + 4)
}

export function cannotReplace(bundle: string | undefined): string | undefined {
  if (!bundle) return "not running from an app bundle"
  // Gatekeeper runs a quarantined app from a read-only copy; the real one is elsewhere.
  if (bundle.includes("/AppTranslocation/")) return "running from a translocated copy"
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
  } catch {
    return `${path.dirname(bundle)} is not writable`
  }
  return undefined
}

/** What the person who asked for a check is told of an outcome; `act`: what its first button
 *  does (installUpdate either way), the second puts it off. */
export function wordsOf(o: Outcome, current: string): { type: "info" | "warning"; message: string; detail: string; act?: string } {
  switch (o.status) {
    case "latest":
      return { type: "info", message: "bicycle 42 is up to date", detail: `Version ${current} is the latest.` }
    case "downloading":
      return { type: "info", message: `Downloading bicycle 42 ${o.version}`, detail: "You can go on working. “Restart to update” appears at the top of the window when it is ready." }
    case "ready":
      return { type: "info", message: `bicycle 42 ${o.version} is ready`, detail: "It is put in place when the app restarts.", act: "Restart to Update" }
    case "manual":
      return { type: "info", message: `bicycle 42 ${o.version} is out`, detail: `This copy can't replace itself: ${o.reason}. The new version is on its release page.`, act: "Open Release Page" }
    case "failed":
      return { type: "warning", message: o.version ? `bicycle 42 ${o.version} could not be downloaded` : "Couldn't check for updates", detail: o.reason }
  }
}

/** Arguments: pid, bundle, staged bundle, and for how many fifths of a second to wait for the
 *  app to quit (300, a minute): still there then, it goes on as it is, rather than being swapped
 *  and started again at some later quit. Puts the old bundle back if the move fails. */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; left="\${4:-300}"
while kill -0 "$pid" 2>/dev/null; do
  [ "$left" -gt 0 ] || exit 1
  left=$((left - 1))
  sleep 0.2
done
backup="$target.previous"
rm -rf "$backup"
if mv "$target" "$backup"; then
  if mv "$staged" "$target"; then rm -rf "$backup"; else mv "$backup" "$target"; fi
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null
open "$target"
`

export function createUpdater(opts: {
  current: string
  manifestUrl: string
  bundle: string | undefined
  /** A folder of the updater's own. Only one updater may have it at a time: at its start it
   *  removes what another's download would be. */
  dir: string
  log: Log
  onChange(): void
  fetch?: typeof fetch
  everyMs?: number
  /** For how long the manifest may take, and a download may go without a byte. */
  manifestMs?: number
  stallMs?: number
  /** The system's tools (macOS), for tests on another system. */
  unpack?: (zip: string, into: string) => Promise<unknown>
  verify?: (app: string) => Promise<unknown>
}): Updater {
  const get = opts.fetch ?? fetch
  const manifestMs = opts.manifestMs ?? 20_000
  const stallMs = opts.stallMs ?? 60_000
  // ditto keeps the framework symlinks and signatures that unzip can break.
  const unpack = opts.unpack ?? ((zip, into) => run("/usr/bin/ditto", ["-x", "-k", zip, into]))
  const verify = opts.verify ?? ((bundle) => run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]))

  let info: UpdateInfo | undefined
  let staged: { version: string; app: string } | undefined
  /** The version coming, while one is. */
  let loading: string | undefined
  let busy: Promise<string | undefined> | undefined
  let swapping = false
  const tellers = new Set<(outcome: Outcome) => void>()

  const set = (next: UpdateInfo) => {
    info = next
    opts.onChange()
  }
  const say = (outcome: Outcome) => {
    for (const tell of tellers) tell(outcome)
  }

  function appIn(dir: string) {
    const name = fs.readdirSync(dir).find((f) => f.endsWith(".app"))
    if (!name) throw new Error("the download holds no app")
    return path.join(dir, name)
  }

  /** At the start: the newest release staged by an earlier run is offered again, if it still
   *  verifies. Everything else there is stale: this version or older, a half-finished download. */
  async function restore() {
    const names = await fs.promises.readdir(opts.dir).catch(() => [] as string[])
    const newer = names.filter((n) => VERSION.test(n) && compareVersions(n, opts.current) > 0).sort((a, b) => compareVersions(b, a))
    const stale = new Set(names)
    for (const version of newer) {
      try {
        const app = appIn(path.join(opts.dir, version, "unpacked"))
        await verify(app)
        staged = { version, app }
        stale.delete(version)
        break
      } catch (err) {
        opts.log("warn", `update ${version}, staged earlier, is not usable`, reasonOf(err))
      }
    }
    for (const name of stale) await remove(path.join(opts.dir, name)).catch((err) => opts.log("warn", `update: ${name} not removed`, reasonOf(err)))
    if (!staged) return
    const blocked = cannotReplace(opts.bundle)
    if (blocked) return opts.log("info", `update ${staged.version} is staged; not offered (${blocked})`)
    opts.log("info", `update ${staged.version} is ready, from an earlier run`)
    set({ version: staged.version, status: "ready" })
  }
  const restored = restore().catch((err) => opts.log("warn", "update folder", reasonOf(err)))

  /** Writes the release to `zip`; throws when its hash is another, or nothing of it comes for a while. */
  async function fetchZip(m: Manifest, zip: string) {
    const stall = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const alive = () => {
      clearTimeout(timer)
      timer = setTimeout(() => stall.abort(new Error(`the download stalled: nothing came for ${stallMs / 1000} seconds`)), stallMs)
    }
    const hash = createHash("sha256")
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        alive()
        hash.update(chunk)
        done(null, chunk)
      },
    })
    alive()
    try {
      const res = await get(m.url, { signal: stall.signal })
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
      const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream)
      await pipeline(body, hashing, fs.createWriteStream(zip), { signal: stall.signal })
    } catch (err) {
      throw stall.signal.aborted ? stall.signal.reason : err
    } finally {
      clearTimeout(timer)
    }
    const got = hash.digest("hex")
    if (got !== m.sha256) throw new Error(`checksum mismatch: expected ${m.sha256}, got ${got}`)
  }

  /** Downloads, unpacks, verifies and stages a release. An earlier one staged stays on offer
   *  until this one is, and its files until the next start: a swap may be about to move them. */
  async function download(m: Manifest) {
    const work = path.join(opts.dir, DOWNLOAD)
    await remove(work)
    fs.mkdirSync(work, { recursive: true })
    const zip = path.join(work, "update.zip")
    await fetchZip(m, zip)
    const out = path.join(work, "unpacked")
    await unpack(zip, out)
    fs.rmSync(zip)
    await verify(appIn(out))
    const home = path.join(opts.dir, m.version)
    await remove(home)
    fs.renameSync(work, home)
    staged = { version: m.version, app: appIn(path.join(home, "unpacked")) }
  }

  async function manifest(): Promise<Manifest> {
    const signal = AbortSignal.timeout(manifestMs)
    try {
      const res = await get(opts.manifestUrl, { cache: "no-store", signal })
      if (!res.ok) throw new Error(`update check failed: HTTP ${res.status}`)
      const m = parseManifest(await res.json())
      if (!m) throw new Error("update check failed: latest.json is malformed")
      return m
    } catch (err) {
      throw signal.aborted ? new Error(`update check failed: no answer in ${manifestMs / 1000} seconds`) : err
    }
  }

  async function look(): Promise<string | undefined> {
    await restored
    let m: Manifest
    try {
      m = await manifest()
    } catch (err) {
      say({ status: "failed", reason: reasonOf(err) })
      throw err
    }
    const blocked = cannotReplace(opts.bundle)
    if (staged && !blocked && compareVersions(m.version, staged.version) <= 0) {
      if (info?.status !== "ready") set({ version: staged.version, status: "ready" })
      say({ status: "ready", version: staged.version })
      return staged.version
    }
    if (compareVersions(m.version, opts.current) <= 0) {
      say({ status: "latest" })
      return undefined
    }
    if (blocked) {
      if (info?.version !== m.version || info.status !== "manual") {
        opts.log("info", `update ${m.version} found; installing it by hand (${blocked})`)
        set({ version: m.version, status: "manual" })
      }
      say({ status: "manual", version: m.version, reason: blocked })
      return m.version
    }
    loading = m.version
    if (!staged) set({ version: m.version, status: "downloading" })
    say({ status: "downloading", version: m.version })
    try {
      await download(m)
      opts.log("info", `update ${m.version} is ready`)
      set({ version: m.version, status: "ready" })
      say({ status: "ready", version: m.version })
    } catch (err) {
      const reason = reasonOf(err)
      opts.log("warn", `update ${m.version} failed`, reason)
      if (!staged) set({ version: m.version, status: "failed" })
      say({ status: "failed", version: m.version, reason })
    } finally {
      loading = undefined
    }
    return m.version
  }

  function check(tell?: (outcome: Outcome) => void) {
    if (tell) {
      tellers.add(tell)
      if (loading) tell({ status: "downloading", version: loading })
    }
    return (busy ??= look().finally(() => {
      busy = undefined
      tellers.clear()
    }))
  }
  const timer = setInterval(() => void check().catch((err) => opts.log("warn", "update check", reasonOf(err))), opts.everyMs ?? 6 * 3600_000)
  timer.unref?.()

  return {
    state: () => info,
    check,
    async install() {
      if (!staged || !opts.bundle || info?.status !== "ready") throw new Error("No update is ready to install.")
      // One script at a time: the first still waits for the app to quit.
      if (swapping) return
      const script = path.join(opts.dir, "swap.sh")
      fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 })
      const child = spawn("/bin/sh", [script, String(process.pid), opts.bundle, staged.app], { detached: true, stdio: "ignore" })
      swapping = true
      child.once("exit", () => (swapping = false))
      try {
        await once(child, "spawn")
      } catch (err) {
        swapping = false
        throw err
      }
      child.unref()
    },
    dispose: () => clearInterval(timer),
  }
}
