// Settings and per-site reviews on disk. No electron: the caller passes the directory.
//
//   <dir>/settings.json                       one file, read once at start
//   <dir>/reviews/<origin, as a file name>.json   one per site, read when the site is opened
//
// Writes are collected for a moment and then replace the file whole (write a temp file, rename),
// so a crash leaves either the old file or the new one. A file we can't read is never written
// over: it is moved aside as <name>.corrupt-<time> for a person to look at. A file written by a
// newer bicycle 42 is not ours to touch at all: it stays as it is, and what would have gone into
// it stays in memory for this run.
import fs from "node:fs"
import path from "node:path"
import type { Checkpoint, ModelRef } from "../shared/types"
import { REVIEW_VERSION } from "./review"

/** `pinned`: the conversations kept at the top of the site's list, by id. */
/** `checkpoints`: the named points of its conversations, to go back to. */
type Sites = Record<string, { directory: string; session?: string; bg?: string; url?: string; seen?: number; pinned?: string[]; checkpoints?: Checkpoint[] }>

/** What belongs to one server: its repo, pages and conversations. Folders and conversations
 *  of one server mean nothing on another. `prefix` goes before a site's origin in the name of
 *  its notes file ("" for the first server, whose files were there before servers were kept). */
export type Space = { folder?: string; lastUrl?: string; defaultModel?: ModelRef; sites: Sites; prefix: string }

/** A server the app has connected to, kept so it can be gone back to. `space` holds what is
 *  its own while another server is the one in use; the one in use has its space in the
 *  settings' own fields. */
/** `projects`: the folders it last listed, so its projects can be offered while another server is in use.
 *  `computer`: what the machine calls itself, as it last said; the server goes by it until it is given a `name`. */
export type SavedServer = ({ url: string; password: string } | { local: true }) & { id: string; name?: string; computer?: string; space?: Space; projects?: string[] }

export type Settings = {
  version: 1
  /** `password` is already encrypted by the caller; here it is an opaque string. */
  /** `name` is the reviewer's own for it ("Studio Mac"); without one it is called by its address. */
  server?: ({ url: string; password: string } | { local: true }) & { name?: string }
  /** Every server connected to so far, and which of them the fields below belong to. */
  servers?: SavedServer[]
  current?: string
  /** See Space. */
  prefix?: string
  lastUrl?: string
  /** The repo opened in the app: the server folder a site opened for the first time works in. */
  folder?: string
  defaultModel?: ModelRef
  /** Key: the site's origin. */
  /** `url` and `seen`: the page last open on the site and when, to come back to with its project. */
  sites: Sites
}

export type Store = {
  /** Current, in memory. */
  settings(): Settings
  /** Mutate, and schedule a save. */
  update(change: (s: Settings) => void): void
  /** The raw saved JSON, or undefined. */
  loadReview(origin: string): unknown
  /** Debounced per origin: the last one given within the window is what gets written. */
  saveReview(origin: string, data: unknown): void
  /** Writes everything pending now, synchronously. For quit. */
  flush(): void
  /** A file read so far was written by a newer bicycle 42, so changes to it are not being saved.
   *  The log says which file; the user should hear that this run won't remember them. */
  readonly readOnly: boolean
}

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

export function createStore(dir: string, opts: { debounceMs?: number; log?: Log } = {}): Store {
  const debounceMs = opts.debounceMs ?? 250
  const log: Log = opts.log ?? (() => undefined)
  const settingsFile = path.join(dir, "settings.json")
  // An origin has ":" and "/" in it; percent-encoding keeps the name readable and one-to-one.
  const reviewFile = (origin: string) => path.join(dir, "reviews", `${encodeURIComponent(origin).replace(/\*/g, "%2A")}.json`)

  /** Files a newer bicycle 42 wrote. Never written for the rest of the run. */
  const newer = new Set<string>()

  /** Parsed contents when the file holds this version's JSON object; undefined when there is no
   *  such file, it was unusable (and is now moved aside), or it is from a newer version (and is
   *  now in `newer`). */
  function read(file: string, version: number): Record<string, unknown> | undefined {
    if (newer.has(file)) return
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch (err) {
      // Not there yet is the normal first run. Anything else (permissions, a directory in the
      // way) we can't fix here; say so, and leave the file alone.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log("error", "store: can't read file", { file, error: String(err) })
      return
    }
    let reason: string
    try {
      const data: unknown = JSON.parse(text)
      if (isObj(data) && data.version === version) return data
      if (isObj(data) && typeof data.version === "number" && data.version > version) {
        // Downgrading must not cost the newer version its data: moving the file aside would.
        newer.add(file)
        log("error", `store: ${path.basename(file)} was written by a newer bicycle 42 (version ${data.version}); this version won't change it`, {
          file,
          version: data.version,
          understands: version,
        })
        return
      }
      reason = isObj(data) ? `version ${JSON.stringify(data.version)}, expected ${version}` : "not a JSON object"
    } catch (err) {
      reason = String(err)
    }
    const aside = `${file}.corrupt-${Date.now()}`
    try {
      fs.renameSync(file, aside)
      log("warn", "store: unreadable file moved aside, starting from defaults", { file, aside, reason })
    } catch (err) {
      log("error", "store: unreadable file could not be moved aside; the next save will replace it", { file, reason, error: String(err) })
    }
    return
  }

  function write(file: string, data: unknown): boolean {
    if (newer.has(file)) return false
    const tmp = `${file}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      // 0600: settings hold the server password, reviews hold text from the reviewer's pages.
      const fd = fs.openSync(tmp, "w", 0o600)
      try {
        fs.writeSync(fd, JSON.stringify(data, null, 2))
        // On disk before the rename, or a power cut could leave the new name on an empty file.
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, file)
      return true
    } catch (err) {
      log("error", "store: save failed, will try again with the next save", { file, error: String(err) })
      try {
        fs.rmSync(tmp, { force: true })
      } catch {} // nothing more to do about a temp file we can't even remove; flush runs at quit and must not throw
      return false
    }
  }

  const saved = read(settingsFile, 1)
  const settings = { ...saved, version: 1, sites: isObj(saved?.sites) ? saved.sites : {} } as Settings

  let settingsDirty = false
  /** Reviews waiting to be written, by origin. */
  const pending = new Map<string, unknown>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    clearTimeout(timer)
    timer = undefined
    if (settingsDirty && write(settingsFile, settings)) settingsDirty = false
    for (const [origin, data] of pending) if (write(reviewFile(origin), data)) pending.delete(origin)
  }

  // The first change starts the clock and later ones ride along, so steady changes (a draft being
  // typed) still reach the disk every `debounceMs` instead of pushing the save back forever.
  function schedule() {
    timer ??= setTimeout(flush, debounceMs)
  }

  return {
    settings: () => settings,
    update(change) {
      change(settings)
      settingsDirty = true
      schedule()
    },
    loadReview(origin) {
      if (pending.has(origin)) return pending.get(origin)
      return read(reviewFile(origin), REVIEW_VERSION)
    },
    saveReview(origin, data) {
      pending.set(origin, data)
      schedule()
    },
    flush,
    get readOnly() {
      return newer.size > 0
    },
  }
}
