// Settings and per-site reviews on disk. No electron: the caller passes the directory.
//
//   <dir>/settings.json                       one file, read once at start
//   <dir>/reviews/<origin, as a file name>.json   one per site, read when the site is opened
//
// Writes are collected for a moment and then replace the file whole (write a temp file, fsync,
// rename), so a crash leaves either the old file or the new one. They happen off the main thread,
// one at a time per file, the newest state last; at quit, flush() writes what is left at once.
// A setting that follows a drag (where the window has the page) waits for the drag to end
// (settle): only its last value is worth a write.
// A file we can't read is never written over: it is moved aside as <name>.corrupt-<time> for a
// person to look at. A file written by a newer bicycle 42 is not ours to touch at all: it stays
// as it is, and what would have gone into it stays in memory for this run.
import fs from "node:fs"
import path from "node:path"
import type { Checkpoint, ModelRef, Rect } from "../shared/types"
import { REVIEW_VERSION } from "./review"

/** `pinned`: the conversations kept at the top of the site's list, by id. */
/** `checkpoints`: the named points of its conversations, to go back to. */
type Sites = Record<string, { directory: string; session?: string; bg?: string; url?: string; seen?: number; pinned?: string[]; checkpoints?: Checkpoint[] }>

/** What belongs to one agent: its repo, pages and conversations. Folders and conversations of
 *  one agent mean nothing to another. `prefix` goes before a site's origin in the name of its
 *  notes file ("" for the first one, whose files were there before agents were kept apart). */
export type Space = { folder?: string; lastUrl?: string; defaultModel?: ModelRef; sites: Sites; prefix: string }

/** An agent the app runs over ACP (`connectAgent` in core.ts), kept so it can be gone back to:
 *  which one ("claude", or "custom-…" for a command typed by hand) and the command that starts it;
 *  with `host`, on that computer over ssh (as the reviewer typed it: "me@dev-box", an alias of
 *  their ~/.ssh/config), else on this one. `space` holds what is its own while another agent is
 *  the one in use; the one in use has its space in the settings' own fields. `projects`: the
 *  folders it last listed, so its projects can be offered while another agent is in use.
 *  `computer`: what it calls itself, as it last said; it goes by that until it is given a `name`.
 *  (An OpenCode server an earlier version saved here is put aside at start: `retired`.) */
export type SavedServer = { agent: string; command: string[]; host?: string; id: string; name?: string; computer?: string; space?: Space; projects?: string[] }

export type Settings = {
  version: 1
  /** The agent in use. `name` is the reviewer's own for it ("Studio Mac"); without one it goes by its own. */
  server?: { agent: string; command: string[]; host?: string; name?: string }
  /** Every agent started so far, and which of them the fields below belong to. */
  servers?: SavedServer[]
  current?: string
  /** See Space. */
  prefix?: string
  lastUrl?: string
  /** The repo opened in the app: the folder a site opened for the first time works in. */
  folder?: string
  defaultModel?: ModelRef
  /** Where the window last had the page (CSS px): what the page is laid out to at the next
   *  start, while the window is still loading and can't say. The window's, whatever the agent. */
  pageBounds?: Rect
  /** The page shown as a phone's (Device in shared/types.ts). Absent: as a desktop's. */
  device?: "phone"
  /** Which phone that is (an id in PHONES). Absent: the usual one. */
  phone?: string
  /** Key: the site's origin. */
  /** `url` and `seen`: the page last open on the site and when, to come back to with its project. */
  sites: Sites
  /** Sites of agents on other computers, opened here: by host as typed, the local port the page
   *  opens (http://127.0.0.1:<it>) and the port and address there it is forwarded from, so after
   *  a restart the same port there is forwarded to the same one here again. */
  forwards?: Record<string, Record<string, { port: number; host: string }>>
  /** The known agents whose adapter npx starts at its newest instead of the app's pin, by id
   *  (agents.ts: adapterOf). Absent: all pinned. */
  agentLatest?: string[]
  /** OpenCode servers saved by an earlier bicycle 42, which no longer connects to one: each as it
   *  was saved, without its password, and with what was its own (`space`: its repo, sites and
   *  conversations; its notes files stay under its prefix). Kept, not used. */
  retired?: Record<string, unknown>[]
  /** Saved servers were just retired: the connect screen says so, once. */
  serversRetired?: true
}

export type Store = {
  /** Current, in memory. */
  settings(): Settings
  /** Mutate, and schedule a save. */
  update(change: (s: Settings) => void): void
  /** Mutate now, and save once no such change has come for a second: for a setting that changes
   *  with every frame of a drag, which `update` would write (and fsync) four times a second for
   *  as long as it lasts. In memory it is the newest at once; another save takes it along, and
   *  a flush or idle does not wait for it. */
  settle(change: (s: Settings) => void): void
  /** The raw saved JSON, or undefined. */
  loadReview(origin: string): unknown
  /** Debounced per origin: the last one given within the window is what gets written. `data`
   *  may be a function that returns it, called when the write is due, so a burst of changes
   *  is serialised once. */
  saveReview(origin: string, data: unknown): void
  /** Writes everything pending now, and whatever a write under way still has in hand,
   *  synchronously. For quit. */
  flush(): void
  /** Writes everything pending now, off the main thread, and resolves once all of it is on disk. */
  idle(): Promise<void>
  /** A file read so far was written by a newer bicycle 42, so changes to it are not being saved.
   *  The log says which file; the user should hear that this run won't remember them. */
  readonly readOnly: boolean
}

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

export function createStore(dir: string, opts: { debounceMs?: number; settleMs?: number; log?: Log } = {}): Store {
  const debounceMs = opts.debounceMs ?? 250
  const settleMs = opts.settleMs ?? 1000
  const log: Log = opts.log ?? (() => undefined)
  const settingsFile = path.join(dir, "settings.json")
  // An origin has ":" and "/" in it; percent-encoding keeps the name readable and one-to-one.
  const reviewFile = (origin: string) => path.join(dir, "reviews", `${encodeURIComponent(origin).replace(/\*/g, "%2A")}.json`)

  /** Files a newer bicycle 42 wrote. Never written for the rest of the run. */
  const newer = new Set<string>()

  /** Parsed contents when the file holds this version's JSON object; undefined when there is no
   *  such file, it was unusable (and is now moved aside), or it is from a newer version (and is
   *  now in `newer`). Indented or not, it reads the same. */
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

  /** The temp file of a write; its name is swapped in once it is complete. A write at quit has
   *  its own, so it never meets one still under way. */
  const tmpOf = (file: string, later: boolean) => `${file}.tmp-${process.pid}${later ? "-w" : ""}`

  /** Writes `text` now, on this thread. For quit, and for nothing else. */
  function writeNow(file: string, text: string): boolean {
    if (newer.has(file)) return false
    const tmp = tmpOf(file, false)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      // 0600: settings hold what the reviewer was working on, reviews the text from their pages.
      const fd = fs.openSync(tmp, "w", 0o600)
      try {
        fs.writeSync(fd, text)
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

  /** Files waiting to be written, by path: what makes their text, called when the write is due. */
  const pending = new Map<string, () => string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  /** Per file: the number of the newest text handed to a write, that text until it is on disk
   *  (what a read gets, and what a quit must still write), and the end of its chain of writes.
   *  One write of a file at a time, in the order asked for, so the last state is the one left. */
  const latest = new Map<string, number>()
  const handed = new Map<string, { n: number; text: string }>()
  const chains = new Map<string, Promise<void>>()
  let count = 0

  /** Writes `text` off the main thread, after the writes of this file before it. Opening,
   *  writing and fsync are asynchronous; the rename is not, so nothing can come between the
   *  check that this is still the newest text and the swap. */
  function writeLater(file: string, text: string) {
    const n = ++count
    latest.set(file, n)
    handed.set(file, { n, text })
    const step = async () => {
      // A newer text is queued behind this one, or was written at once by a flush.
      if (newer.has(file) || latest.get(file) !== n) return
      const tmp = tmpOf(file, true)
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        const handle = await fs.promises.open(tmp, "w", 0o600)
        try {
          await handle.writeFile(text)
          // On disk before the rename, or a power cut could leave the new name on an empty file.
          await handle.sync()
        } finally {
          await handle.close()
        }
        if (latest.get(file) !== n) return void (await fs.promises.rm(tmp, { force: true }).catch(() => undefined))
        fs.renameSync(tmp, file)
      } catch (err) {
        log("error", "store: save failed, will try again with the next save", { file, error: String(err) })
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        // Tried again with the next save, unless something newer is already waiting.
        if (latest.get(file) === n && !pending.has(file)) pending.set(file, () => text)
      } finally {
        if (handed.get(file)?.n === n) handed.delete(file)
      }
    }
    const chain = (chains.get(file) ?? Promise.resolve()).then(step)
    chains.set(file, chain)
    void chain.then(() => chains.get(file) === chain && chains.delete(file))
  }

  /** The wait is over: everything pending goes to disk, off the main thread. */
  function due() {
    clearTimeout(timer)
    timer = undefined
    const now = [...pending]
    pending.clear()
    for (const [file, text] of now) writeLater(file, text())
  }

  function flush() {
    clearTimeout(timer)
    timer = undefined
    settled()
    // A write under way may not finish before the app is gone: what it holds is written here.
    for (const [file, { text }] of handed) if (!pending.has(file)) pending.set(file, () => text)
    handed.clear()
    for (const [file, text] of pending) {
      // Whatever a write under way has in hand is older than this, and is not swapped in after it.
      latest.set(file, ++count)
      if (writeNow(file, text())) pending.delete(file)
    }
  }

  // The first change starts the clock and later ones ride along, so steady changes (a draft being
  // typed) still reach the disk every `debounceMs` instead of pushing the save back forever.
  function schedule() {
    timer ??= setTimeout(due, debounceMs)
  }

  const saved = read(settingsFile, 1)
  const settings = { ...saved, version: 1, sites: isObj(saved?.sites) ? saved.sites : {} } as Settings

  /** Set while a change that settles waits for its kind to stop coming. */
  let settling: ReturnType<typeof setTimeout> | undefined
  /** The settings as they are now are to be written: what waited to settle goes with them. */
  function saveSettings() {
    clearTimeout(settling)
    settling = undefined
    // Small, and opened by people now and then: indented.
    pending.set(settingsFile, () => JSON.stringify(settings, null, 2))
  }
  /** What waits to settle waits no longer (a flush, an idle): it is pending like any change. */
  function settled() {
    if (settling) saveSettings()
  }

  return {
    settings: () => settings,
    update(change) {
      change(settings)
      saveSettings()
      schedule()
    },
    settle(change) {
      change(settings)
      clearTimeout(settling)
      settling = setTimeout(() => {
        saveSettings()
        schedule()
      }, settleMs)
    },
    loadReview(origin) {
      const file = reviewFile(origin)
      const waiting = pending.get(file)
      if (waiting) return JSON.parse(waiting())
      // Handed to a write that has not finished: the file still has what was before.
      const writing = handed.get(file)
      if (writing) return JSON.parse(writing.text)
      return read(reviewFile(origin), REVIEW_VERSION)
    },
    saveReview(origin, data) {
      // One line: a review with its notes is large, and only this app reads it.
      pending.set(reviewFile(origin), () => JSON.stringify(typeof data === "function" ? data() : data))
      schedule()
    },
    flush,
    async idle() {
      settled()
      while (pending.size || chains.size) {
        if (pending.size) due()
        await Promise.all(chains.values())
      }
    },
    get readOnly() {
      return newer.size > 0
    },
  }
}
