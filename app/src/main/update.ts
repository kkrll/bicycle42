// Squirrel (electron-updater) refuses ad-hoc signed builds, so the app updates itself from latest.json.
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import type { UpdateInfo } from "../shared/types"

export type Manifest = { version: string; url: string; sha256: string }

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

export type Updater = {
  state(): UpdateInfo | undefined
  /** Resolves to the newer version found, or undefined when this one is the latest. */
  check(): Promise<string | undefined>
  /** Starts the swap and resolves once the app may quit. Throws when nothing is staged. */
  install(): Promise<void>
  dispose(): void
}

const run = promisify(execFile)

/** 1.2.3 and 1.2.3-preview.4 style versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = "", pre] = v.replace(/^v/, "").split("-", 2)
    return { main: main.split(".").map((n) => Number(n) || 0), pre }
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
  if (typeof version !== "string" || !/^v?\d+\.\d+\.\d+([-.][\w.]+)?$/.test(version)) return undefined
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

/** Arguments: pid, bundle, staged bundle. Puts the old bundle back if the move fails. */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
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
  /** A folder of the updater's own; emptied on start. */
  dir: string
  log: Log
  onChange(): void
  fetch?: typeof fetch
  everyMs?: number
}): Updater {
  const get = opts.fetch ?? fetch
  let info: UpdateInfo | undefined
  let staged: { version: string; app: string } | undefined
  let busy: Promise<string | undefined> | undefined
  fs.rmSync(opts.dir, { recursive: true, force: true })

  const set = (next: UpdateInfo | undefined) => {
    info = next
    opts.onChange()
  }

  async function download(m: Manifest) {
    const blocked = cannotReplace(opts.bundle)
    if (blocked) {
      opts.log("info", `update ${m.version} found; installing it by hand (${blocked})`)
      return set({ version: m.version, status: "manual" })
    }
    set({ version: m.version, status: "downloading" })
    const work = path.join(opts.dir, m.version)
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    const zip = path.join(work, "update.zip")
    const res = await get(m.url)
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    const hash = createHash("sha256")
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream)
    body.on("data", (chunk: Buffer) => hash.update(chunk))
    await pipeline(body, fs.createWriteStream(zip))
    const got = hash.digest("hex")
    if (got !== m.sha256) throw new Error(`checksum mismatch: expected ${m.sha256}, got ${got}`)
    const out = path.join(work, "unpacked")
    // ditto keeps the framework symlinks and signatures that unzip can break.
    await run("/usr/bin/ditto", ["-x", "-k", zip, out])
    fs.rmSync(zip)
    const app = fs.readdirSync(out).find((f) => f.endsWith(".app"))
    if (!app) throw new Error("the download holds no app")
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(out, app)])
    staged = { version: m.version, app: path.join(out, app) }
    opts.log("info", `update ${m.version} is ready`)
    set({ version: m.version, status: "ready" })
  }

  async function check(): Promise<string | undefined> {
    const res = await get(opts.manifestUrl, { cache: "no-store" })
    if (!res.ok) throw new Error(`update check failed: HTTP ${res.status}`)
    const m = parseManifest(await res.json())
    if (!m) throw new Error("update check failed: latest.json is malformed")
    if (compareVersions(m.version, opts.current) <= 0) return undefined
    if (info?.version === m.version && info.status !== "failed") return m.version
    try {
      await download(m)
    } catch (err) {
      opts.log("warn", `update ${m.version} failed`, err instanceof Error ? err.message : err)
      set({ version: m.version, status: "failed" })
    }
    return m.version
  }

  const once = () => (busy ??= check().finally(() => (busy = undefined)))
  const timer = setInterval(() => void once().catch((err) => opts.log("warn", "update check", String(err))), opts.everyMs ?? 6 * 3600_000)
  timer.unref?.()

  return {
    state: () => info,
    check: once,
    async install() {
      if (!staged || !opts.bundle) throw new Error("No update is ready to install.")
      const script = path.join(opts.dir, "swap.sh")
      fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 })
      const child = spawn("/bin/sh", [script, String(process.pid), opts.bundle, staged.app], { detached: true, stdio: "ignore" })
      child.unref()
    },
    dispose: () => clearInterval(timer),
  }
}
