// The app's own file history: what each turn of the agent changed in a folder, kept by the app
// and not by the backend, so a note can be taken back exactly when it is not the newest message,
// and a backend with no undo of its own still has one.
//
// Each folder has a shadow git repository of the app's, outside the folder (under the data
// folder: snapshots/<name>-<hash>.git), used with GIT_DIR and GIT_WORK_TREE. The folder's own
// .git is never read or written: it need not be a repository at all. A snapshot is `git add -A`
// and `git write-tree` into the shadow's index, which keeps the files' stat information, so a
// second snapshot reads only what changed. The folder's .gitignore files count, as in the folder's
// own repository (and its .git/info/exclude, copied in); node_modules is left out besides.
//
// A turn is two snapshots, before and after; what it changed is `git diff before after`. Taking
// it back is that diff in reverse, applied to the files as they are now: what was changed since
// on other lines stays, and when a later change touched the same lines nothing is touched at all
// (`git apply` is all or nothing). Several turns are reversed in a scratch index first, newest
// first, and the files are changed once, by the difference that leaves.
//
// The folder's log (`b42.json` in the shadow) lists its turns and what was taken back, so they
// outlive a restart. Trees are kept alive by the log: git's own gc is off, and once a day, on a
// folder's first use, what the log no longer names (older than KEEP_DAYS) is let go.
//
// Two guards against taking back more than a turn changed. A snapshot whose `git add` did not
// finish (a timeout, a signal) is no snapshot at all: its `write-tree` would be the index as it
// was before, or the empty tree, and a turn from there would read as "every file added". And a
// change that would delete much of the folder (a share of it, not a handful of files) is never
// made by the app itself: it is refused with a sentence for the reviewer (`Refused`). A file a
// turn "added" that was on disk before the turn began (it was ignored then, and a .gitignore
// edit let it in) is not deleted by taking the turn back.
//
// Only for a folder on this computer: the caller says when the files are elsewhere.
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FileChange } from "../shared/types"
import { createQueue } from "./queue"

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

/** What one turn of a conversation changed in the folder. `start` is when it began (ms). */
export type Turn = {
  id: string
  session: string
  start: number
  before: string
  after: string
  /** Another conversation ran in the same folder during it: the diff may hold its changes too. */
  shared?: true
  /** Its "before" may hold some of its own changes (the snapshot came late, after the agent had
   *  the message): it is not taken back by the app. */
  untrusted?: true
  /** The messages (review notes) that ran in it. Notes that waited together share a turn. */
  messages: string[]
}

/** Turns taken back by the app: the files went from `from` to `to`. Brought back (redo) by going
 *  the other way, until the agent has been `told`; then it is final. */
export type Restore = {
  id: string
  session: string
  time: number
  turns: string[]
  from: string
  to: string
  /** The notes it took back, by id. */
  notes: string[]
  told?: true
}

/** A change the app will not make by itself; the message is for the reviewer. */
export class Refused extends Error {}

/** git's empty tree: what a folder with no file in it is. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


type History = { turns: Turn[]; restores: Restore[]; pruned?: number }

export type Snapshots = {
  /** The folder's files as they are now, as a tree id; undefined when it can't be read (logged). */
  snapshot(dir: string): Promise<string | undefined>
  /** What changed from one tree to the other, file by file, as `Backend.diff` gives it. */
  diff(dir: string, from: string, to: string): Promise<FileChange[]>
  /** Takes the turns back (oldest first in the list; reversed newest first) on the files as they
   *  are now. Undefined, and nothing touched, when that does not apply cleanly. With `dry`, only
   *  says whether it would. `files`: the paths it changes. A turn's `start`, when given, keeps
   *  the files it added that were on disk before it began. Throws `Refused` (nothing touched)
   *  when it would delete much of the folder. */
  reverse(dir: string, turns: Array<Pick<Turn, "before" | "after"> & { start?: number }>, dry?: boolean): Promise<{ from: string; to: string; files: string[] } | undefined>
  /** Changes the files by the difference between two trees (a redo is a restore's `to` → `from`).
   *  False, and nothing touched, when it does not apply; throws `Refused` as `reverse` does. */
  apply(dir: string, from: string, to: string): Promise<boolean>
  /** The folder's log, read from disk the first time. Change it with the calls below. */
  history(dir: string): Promise<Readonly<History>>
  addTurn(dir: string, turn: Omit<Turn, "id">): Promise<Turn>
  addRestore(dir: string, restore: Omit<Restore, "id">): Promise<Restore>
  /** Changes a restore (`told`), or with null forgets it (it was brought back). */
  updateRestore(dir: string, id: string, change: Partial<Restore> | null): Promise<void>
  /** Resolves once everything asked so far is done and written. */
  idle(): Promise<void>
}

/** How long a turn can be taken back exactly. Older ones go to the agent, as before. */
export const KEEP_DAYS = 30
/** At most this many turns per folder are kept, newest first. */
const KEEP_TURNS = 2000
const DAY = 86_400_000
/** A snapshot of a large folder with nothing ignored should not hang a turn. */
const GIT_TIMEOUT = 60_000
/** A change that deletes at least this many files, and this share of the folder's, is refused. */
const GONE_MIN = 20
const GONE_SHARE = 0.5
/** Always left out, whatever the folder ignores: a folder that is not a repository has no .gitignore. */
const EXCLUDE = ["node_modules/", ".DS_Store"]

const id = () => `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`

/** One unified patch, split per file, with each file's counts from --numstat. */
export function parseDiff(numstat: string, patch: string): FileChange[] {
  // -z numstat: "added\tdeleted\tpath\0" per file ("-\t-" for a binary file).
  const stats = numstat.split("\0").filter(Boolean).map((entry) => {
    const [a, d, ...rest] = entry.split("\t")
    return { file: rest.join("\t"), additions: Number(a) || 0, deletions: Number(d) || 0 }
  })
  const chunks = patch ? patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git ")) : []
  return stats.map((s, i) => ({ ...s, patch: (chunks[i] ?? "").replace(/\n$/, "") }))
}

export function createSnapshots(dataDir: string, opts: { log?: Log } = {}): Snapshots {
  const log: Log = opts.log ?? (() => {})
  const root = path.join(dataDir, "snapshots")
  /** One git operation at a time per folder: they share the shadow's index. */
  const queue = createQueue()
  const histories = new Map<string, Promise<History>>()
  const ready = new Map<string, Promise<string>>()
  /** Folders whose log was looked at for pruning in this run. */
  const pruneSeen = new Set<string>()
  const pruning = new Set<Promise<void>>()

  const shadowOf = (dir: string) => {
    const name = path.basename(dir).replace(/[^\w.-]+/g, "_").slice(0, 40) || "root"
    return path.join(root, `${name}-${createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 16)}.git`)
  }

  /** git, in the folder, on the shadow: none of the person's own git settings or environment
   *  (a pager, colour, an external diff, a hook's index) gets in the way. */
  function git(dir: string, args: string[], o: { input?: string; index?: string } = {}): Promise<{ code: number | null; signal: string | null; out: string; err: string }> {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v
    Object.assign(env, {
      GIT_DIR: shadowOf(dir),
      GIT_WORK_TREE: dir,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      ...(o.index ? { GIT_INDEX_FILE: o.index } : {}),
    })
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on("data", (b: Buffer) => out.push(b))
      child.stderr.on("data", (b: Buffer) => err.push(b))
      child.on("error", reject)
      // A timeout or a signal is `code: null`: never read as one of git's own exit codes.
      child.on("close", (code, signal) => resolve({ code, signal, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }))
      child.stdin.on("error", () => undefined)
      child.stdin.end(o.input ?? "")
    })
  }
  async function must(dir: string, args: string[], o?: { input?: string; index?: string }) {
    const r = await git(dir, args, o)
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.signal ? `killed (${r.signal})` : r.err.trim() || `exit ${r.code}`}`)
    return r.out
  }

  /** Makes the shadow the first time, and brings its excludes up to date once per run. */
  function open(dir: string): Promise<string> {
    let made = ready.get(dir)
    if (!made) {
      made = (async () => {
        const shadow = shadowOf(dir)
        if (!fs.existsSync(path.join(shadow, "HEAD"))) {
          fs.mkdirSync(shadow, { recursive: true })
          await must(dir, ["init", "--quiet", "--template="])
        }
        for (const [k, v] of [
          ["core.bare", "false"],
          ["core.autocrlf", "false"],
          ["core.quotepath", "false"],
          ["core.untrackedCache", "true"],
          ["core.fsmonitor", "false"],
          // Nothing is thrown away behind the log's back (see prune).
          ["gc.auto", "0"],
        ])
          await must(dir, ["config", k!, v!])
        let own = ""
        try {
          own = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")
        } catch {
          // Not a repository, or one without excludes.
        }
        fs.mkdirSync(path.join(shadow, "info"), { recursive: true })
        fs.writeFileSync(path.join(shadow, "info", "exclude"), [...EXCLUDE, "", own].join("\n"))
        return shadow
      })()
      ready.set(dir, made)
      // A failure is tried again next time (the folder may come back).
      made.catch(() => ready.delete(dir))
    }
    return made
  }

  const logFile = (dir: string) => path.join(shadowOf(dir), "b42.json")

  function history(dir: string): Promise<History> {
    let h = histories.get(dir)
    if (!h) {
      h = (async () => {
        try {
          const raw = JSON.parse(await fs.promises.readFile(logFile(dir), "utf8")) as Partial<History>
          return {
            turns: Array.isArray(raw.turns) ? raw.turns.filter((t) => t && typeof t.before === "string" && typeof t.after === "string" && typeof t.session === "string") : [],
            restores: Array.isArray(raw.restores) ? raw.restores.filter((r) => r && typeof r.from === "string" && typeof r.to === "string" && Array.isArray(r.turns)) : [],
            ...(typeof raw.pruned === "number" ? { pruned: raw.pruned } : {}),
          }
        } catch {
          return { turns: [], restores: [] }
        }
      })()
      histories.set(dir, h)
    }
    return h
  }

  /** Writes the log whole, atomically, after the change `edit` makes to it. */
  function write(dir: string, edit: (h: History) => void) {
    return queue.run(`log:${dir}`, async () => {
      const h = await history(dir)
      edit(h)
      const file = logFile(dir)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify(h))
      await fs.promises.rename(tmp, file)
    })
  }

  /** Once a day per folder: turns older than KEEP_DAYS (or beyond KEEP_TURNS) leave the log, and
   *  the trees it no longer names go with git's gc. A tree younger than an hour is kept whatever
   *  the log says: it may be the "before" of a turn under way. Not waited for. */
  function prune(dir: string) {
    const run = (async () => {
      const h = await history(dir)
      if (h.pruned && Date.now() - h.pruned < DAY) return
      const cut = Date.now() - KEEP_DAYS * DAY
      await write(dir, (x) => {
        // A take-back the agent has not been told of stays, old or not, with its turns: /redo can
        // still bring it back, and the next message must still say it.
        const untold = new Set(x.restores.filter((r) => !r.told).flatMap((r) => r.turns))
        const recent = new Set(x.turns.filter((t) => t.start >= cut).slice(-KEEP_TURNS).map((t) => t.id))
        x.turns = x.turns.filter((t) => recent.has(t.id) || untold.has(t.id))
        const kept = new Set(x.turns.map((t) => t.id))
        x.restores = x.restores.filter((r) => !r.told || (r.time >= cut && r.turns.some((t) => kept.has(t))))
        x.pruned = Date.now()
      })
      const now = await history(dir)
      const trees = new Set([...now.turns.flatMap((t) => [t.before, t.after]), ...now.restores.flatMap((r) => [r.from, r.to])])
      await queue.run(dir, async () => {
        const refs = new Set((await must(dir, ["for-each-ref", "--format=%(refname)", "refs/b42/"])).split("\n").filter(Boolean))
        const lines = [
          ...[...refs].filter((r) => !trees.has(r.slice("refs/b42/".length))).map((r) => `delete ${r}`),
          ...[...trees].filter((t) => !refs.has(`refs/b42/${t}`)).map((t) => `update refs/b42/${t} ${t}`),
        ]
        if (lines.length) await must(dir, ["update-ref", "--stdin"], { input: `${lines.join("\n")}\n` })
      })
      // Beside the queue: gc is safe beside other git commands, and may take a while.
      await must(dir, ["gc", "--quiet", "--prune=1.hour.ago"])
    })().catch((err) => log("warn", "can't prune the file history", String(err)))
    pruning.add(run)
    void run.finally(() => pruning.delete(run))
  }

  async function snap(dir: string): Promise<string> {
    const r = await git(dir, ["add", "--all", "--ignore-errors", "--", "."])
    // --ignore-errors exits 1 when a file could not be read; the rest is in the index. Anything
    // else (a timeout, a signal, a fatal error) left the index as it was: no snapshot, since its
    // tree would be an older one, or the empty tree.
    if (r.code !== 0 && r.code !== 1) throw new Error(`git add: ${r.signal ? `killed (${r.signal}), maybe after ${GIT_TIMEOUT / 1000} s` : r.err.trim() || `exit ${r.code}`}`)
    return (await must(dir, ["write-tree"])).trim()
  }

  const patchOf = (dir: string, from: string, to: string) => must(dir, ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-renames", from, to])
  /** The paths that differ between two trees; with a filter, only those added (A), deleted (D)... */
  const namesOf = async (dir: string, from: string, to: string, filter?: string) =>
    (await must(dir, ["diff", "--name-only", "-z", "--no-renames", ...(filter ? [`--diff-filter=${filter}`] : []), from, to])).split("\0").filter(Boolean)

  /** Throws `Refused` when going from one tree to the other deletes much of the folder. */
  async function guard(dir: string, from: string, to: string) {
    const gone = (await namesOf(dir, from, to, "D")).length
    if (gone < GONE_MIN) return
    const all = (await must(dir, ["ls-tree", "-r", "-z", "--name-only", from])).split("\0").filter(Boolean).length
    if (gone >= all * GONE_SHARE)
      throw new Refused(`That would delete ${gone} of the folder's ${all} files, which the app does not do by itself. Ask the agent to reverse it instead.`)
  }

  /** The difference between two trees, applied to the files: all of it or none. */
  async function move(dir: string, from: string, to: string): Promise<boolean> {
    if (from === to) return true
    await guard(dir, from, to)
    const patch = await patchOf(dir, from, to)
    if (!patch.trim()) return true
    const r = await git(dir, ["apply", "--whitespace=nowarn", "-"], { input: patch })
    return r.code === 0
  }

  /** Of the files a reversal would delete, those a turn "added" that were on disk before it began:
   *  they were ignored then (a .gitignore the turn changed let them in), not made by the agent. */
  async function onDiskBefore(dir: string, turns: Array<{ before: string; after: string; start?: number }>, deleted: string[]) {
    if (!deleted.length) return []
    const since = new Map<string, number>()
    for (const t of turns) {
      if (t.start === undefined) continue
      for (const p of await namesOf(dir, t.before, t.after, "A")) since.set(p, Math.max(since.get(p) ?? 0, t.start))
    }
    return deleted.filter((p) => {
      const start = since.get(p)
      if (start === undefined) return false
      try {
        return fs.lstatSync(path.join(dir, p)).mtimeMs < start
      } catch {
        return false
      }
    })
  }

  return {
    async snapshot(dir) {
      try {
        if (!fs.statSync(dir).isDirectory()) return undefined
        await open(dir)
        const tree = await queue.run(dir, () => snap(dir))
        if (!pruneSeen.has(dir)) pruneSeen.add(dir), prune(dir)
        return tree
      } catch (err) {
        log("warn", "can't take a snapshot of the folder", String(err))
        return undefined
      }
    },

    async diff(dir, from, to) {
      await open(dir)
      return queue.run(dir, async () => {
        const flags = ["--no-color", "--no-ext-diff", "--no-renames", from, to]
        const [numstat, patch] = await Promise.all([must(dir, ["diff", "--numstat", "-z", ...flags]), must(dir, ["diff", "-U3", ...flags])])
        return parseDiff(numstat, patch)
      })
    },

    async reverse(dir, turns, dry = false) {
      await open(dir)
      return queue.run(dir, async () => {
        const now = await snap(dir)
        // A scratch index of the files as they are now; the turns come out of it newest first.
        const index = path.join(shadowOf(dir), `index.${randomBytes(4).toString("hex")}`)
        try {
          await must(dir, ["read-tree", now], { index })
          for (const t of [...turns].reverse()) {
            const patch = await patchOf(dir, t.before, t.after)
            if (!patch.trim()) continue
            const r = await git(dir, ["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], { input: patch, index })
            if (r.code !== 0) return undefined
          }
          let to = (await must(dir, ["write-tree"], { index })).trim()
          // What was on disk before the turn stays, as it is now.
          const keep = new Set(await onDiskBefore(dir, turns, await namesOf(dir, now, to, "D")))
          if (keep.size) {
            const entries = (await must(dir, ["ls-tree", "-r", "-z", "--full-tree", now])).split("\0").filter((e) => keep.has(e.slice(e.indexOf("\t") + 1)))
            await must(dir, ["update-index", "-z", "--index-info"], { input: entries.map((e) => `${e}\0`).join(""), index })
            to = (await must(dir, ["write-tree"], { index })).trim()
          }
          await guard(dir, now, to)
          const done = { from: now, to, files: now === to ? [] : await namesOf(dir, now, to) }
          if (dry) return done
          return (await move(dir, now, to)) ? done : undefined
        } finally {
          fs.rmSync(index, { force: true })
        }
      })
    },

    async apply(dir, from, to) {
      await open(dir)
      return queue.run(dir, () => move(dir, from, to))
    },

    history,

    async addTurn(dir, turn) {
      const made: Turn = { id: id(), ...turn }
      await write(dir, (h) => void h.turns.push(made))
      return made
    },
    async addRestore(dir, restore) {
      const made: Restore = { id: id(), ...restore }
      await write(dir, (h) => void h.restores.push(made))
      return made
    },
    async updateRestore(dir, rid, change) {
      await write(dir, (h) => {
        const i = h.restores.findIndex((r) => r.id === rid)
        if (i < 0) return
        if (change === null) h.restores.splice(i, 1)
        else h.restores[i] = { ...h.restores[i]!, ...change, id: rid }
      })
    },

    async idle() {
      while (pruning.size) await Promise.all(pruning)
      await queue.idle()
    },
  }
}
