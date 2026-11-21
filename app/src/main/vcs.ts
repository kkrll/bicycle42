// The repo's state for the panel: its branch, and what is changed and not committed, with the lines
// each change adds and takes away. Everything is asked of git on the machine where the repo is, in
// a constant number of commands whatever the number of files: on another computer each command is
// a round trip over ssh, and a file read there is the whole file sent over the link.
//
//   1  status (porcelain v2, with the branch; it fails outside a work tree) and
//      `diff --numstat HEAD`, side by side
//   2  only when untracked files are among those shown: `grep -c ''` counts their lines, and
//      `grep -l ''` beside it finds the binary ones (listed, but not by the grep that skips them)
//
// Nothing here is Electron's or the agent's: it needs only a Machine's `run`, so the helper on
// another computer can do the whole of it as one call.
import type { Machine } from "./machine"
import type { Repo, RepoChange } from "../shared/types"

/** Lines past which an untracked file is not counted (it is read only up to them). */
export const LINES_MAX = 100_000

export async function git(m: Machine, dir: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  const r = await m.run("git", ["-C", dir, ...args], { timeout: 10_000, maxBuffer })
  if (r.error) throw new Error(r.error.message)
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.signal ? `killed (${r.signal})` : r.err.trim() || `exit ${r.code}`}`)
  return r.out
}

/** The folder's branch and what is not committed, the first `max` changes with their line counts
 *  (`total` says how many there are). Undefined when the folder is not in a git work tree. */
export async function vcs(m: Machine, dir: string, max = Infinity): Promise<Repo | undefined> {
  const [status, numstat] = await Promise.all([
    git(m, dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).catch(() => undefined),
    git(m, dir, ["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
  ])
  // Not a work tree (status says so, and fails), or one whose status could not be read: no line.
  if (status === undefined) return undefined
  const { branch, found } = parseStatus(status)
  const shown = found.slice(0, max)
  const counts = parseNumstat(numstat)
  const untracked = shown.filter((f) => f.untracked).map((f) => f.file)
  const lines = untracked.length ? await untrackedLines(m, dir, untracked) : new Map<string, Count>()
  const changes = shown.map(({ file, status: kind, untracked }): RepoChange => {
    const n = (untracked ? lines.get(file) : counts.get(file)) ?? { additions: 0, deletions: 0 }
    return { file, status: kind, ...n }
  })
  return { ...(branch ? { branch } : {}), changes, total: found.length }
}

type Count = Pick<RepoChange, "additions" | "deletions" | "uncounted">
type Found = { file: string; status: RepoChange["status"]; untracked: boolean }

/** `git status --porcelain=v2 --branch -z`: "# branch.head <name>|(detached)", then a record per
 *  path, "1 XY …8 fields… <path>", "2 XY …9 fields… <path>\0<from>" (a rename or copy),
 *  "u XY …10 fields… <path>" (unmerged), "? <path>". Paths are the repo's, whatever the folder. */
export function parseStatus(out: string): { branch?: string; found: Found[] } {
  let branch: string | undefined
  const found: Found[] = []
  const records = out.split("\0")
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    const after = (fields: number) => {
      let at = 0
      for (let n = 0; n < fields && at >= 0; n++) at = r.indexOf(" ", at + 1)
      return at < 0 ? "" : r.slice(at + 1)
    }
    if (r.startsWith("# branch.head ")) {
      const head = r.slice("# branch.head ".length)
      if (head !== "(detached)") branch = head
    } else if (r.startsWith("? ")) found.push({ file: r.slice(2), status: "added", untracked: true })
    else if (r[0] === "1" || r[0] === "2" || r[0] === "u") {
      const file = after(r[0] === "1" ? 8 : r[0] === "2" ? 9 : 10)
      if (r[0] === "2") i++
      const x = r[2]
      const y = r[3]
      if (file) found.push({ file, untracked: false, status: x === "A" ? "added" : x === "D" || y === "D" ? "deleted" : "modified" })
    }
  }
  return { ...(branch ? { branch } : {}), found }
}

/** `git diff --numstat -z`: "<add>\t<del>\t<path>\0", a rename "<add>\t<del>\t\0<from>\0<to>\0",
 *  and "-\t-" for a binary file. */
export function parseNumstat(out: string): Map<string, Count> {
  const counts = new Map<string, Count>()
  const parts = out.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]!)
    if (!match) continue
    const file = match[3] || parts[(i += 2)] || ""
    const binary = match[1] === "-" && match[2] === "-"
    counts.set(file, { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0, ...(binary ? { uncounted: "binary" as const } : {}) })
  }
  return counts
}

/** `git grep -c -z`: "<path>\0<count>\n" per file with a line (a path may hold a newline). */
export function parseGrepCounts(out: string): Map<string, number> {
  const counts = new Map<string, number>()
  const parts = out.split("\0")
  let file = parts[0]!
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i]!.indexOf("\n")
    if (end < 0) break
    if (file) counts.set(file, Number(parts[i]!.slice(0, end)) || 0)
    file = parts[i]!.slice(end + 1)
  }
  return counts
}

/** The lines of untracked files, counted by git where they are: nothing of theirs is sent but the
 *  counts. A file grep skips as binary is marked, and one with `LINES_MAX` lines or more is marked
 *  large; an empty file is neither listed nor marked (0 lines). */
async function untrackedLines(m: Machine, dir: string, files: string[]): Promise<Map<string, Count>> {
  // Paths as status gave them (the repo's, literal), and named as such in what grep says.
  const paths = ["--", ...files.map((f) => `:(top,literal)${f}`)]
  const grep = async (args: string[]) => {
    const r = await m.run("git", ["-C", dir, "grep", "--untracked", "--no-color", "--full-name", "-z", ...args, "-e", "", ...paths], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    // 1: no file had a line.
    if (r.error || (r.code !== 0 && r.code !== 1)) throw new Error(`git grep: ${r.error?.message ?? (r.err.trim() || `exit ${r.code}`)}`)
    return r.out
  }
  // --max-count is git 2.38's; an older git counts every line of every file.
  const counting = grep(["-I", "-c", `--max-count=${LINES_MAX}`]).catch(() => grep(["-I", "-c"]))
  const [text, listed] = await Promise.all([counting.catch(() => undefined), grep(["-l"]).catch(() => "")])
  const counts = parseGrepCounts(text ?? "")
  const lines = new Map<string, Count>()
  for (const [file, n] of counts) lines.set(file, n >= LINES_MAX ? { additions: 0, deletions: 0, uncounted: "large" } : { additions: n, deletions: 0 })
  if (text !== undefined)
    for (const file of listed.split("\0"))
      if (file && !counts.has(file)) lines.set(file, { additions: 0, deletions: 0, uncounted: "binary" })
  return lines
}
