// The repo's state for the panel (src/main/vcs.ts): the same branch, changes and line counts as the
// way it was read before (kept below as `before`, which read every untracked file), on this
// computer; and on another computer through the fake ssh, a constant number of calls whatever the
// number of untracked files, with nothing of theirs sent but their counts.
//
//   node scripts/build.mjs --tests && node --test dist/test/vcs.test.cjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createLocalMachine, type Machine } from "../src/main/machine"
import { connectSsh, sshTiming } from "../src/main/ssh"
import { LINES_MAX, parseGrepCounts, parseStatus, vcs } from "../src/main/vcs"
import type { RepoChange } from "../src/shared/types"
import { fakeHost } from "./ssh-fixture"

sshTiming.retryMin = 100
sshTiming.retryMax = 300

// ── the way it was read at 466a477: a stat and a read per untracked file, before the cut ──────────

async function gitBefore(m: Machine, dir: string, args: string[]): Promise<string> {
  const r = await m.run("git", ["-C", dir, ...args], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw new Error(r.error.message)
  if (r.code !== 0) throw new Error(`git ${args[0]}: exit ${r.code}`)
  return r.out
}

async function before(m: Machine, dir: string): Promise<{ branch?: string; changes: RepoChange[] } | undefined> {
  try {
    if ((await gitBefore(m, dir, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return undefined
  } catch {
    return undefined
  }
  const branch = (await gitBefore(m, dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim() || undefined
  const status = await gitBefore(m, dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => "")
  const counts = new Map<string, { additions: number; deletions: number }>()
  const numstat = await gitBefore(m, dir, ["diff", "--numstat", "-z", "HEAD"]).catch(() => "")
  const parts = numstat.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]!)
    if (!match) continue
    const file = match[3] || parts[(i += 2)] || ""
    counts.set(file, { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 })
  }
  const found: Array<{ file: string; status: RepoChange["status"]; untracked: boolean }> = []
  const entries = status.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.length < 4) continue
    const x = e[0]
    const y = e[1]
    const file = e.slice(3)
    if (x === "R" || x === "C") i++
    const untracked = x === "?"
    found.push({ file, untracked, status: untracked || x === "A" ? "added" : x === "D" || y === "D" ? "deleted" : "modified" })
  }
  const changes = await Promise.all(
    found.map(async ({ file, status: kind, untracked }): Promise<RepoChange> => {
      const n = untracked ? { additions: await lineCount(m, m.path.join(dir, file)), deletions: 0 } : (counts.get(file) ?? { additions: 0, deletions: 0 })
      return { file, ...n, status: kind }
    }),
  )
  return { ...(branch ? { branch } : {}), changes }
}

async function lineCount(m: Machine, file: string): Promise<number> {
  try {
    const stat = await m.stat(file)
    if (stat.kind !== "file" || stat.size > 2 * 1024 * 1024) return 0
    const text = await m.readFile(file)
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0
  } catch {
    return 0
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "b42-vcs-"))
const gitIn = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" })
const write = (dir: string, file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
}
const lines = (n: number, width = 20) => `${"x".repeat(width - 1)}\n`.repeat(n)
const byFile = (a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file)

/** A repo with one of each kind of change a reviewer's session leaves, all of it text. */
function normalRepo(dir: string) {
  gitIn(dir, "init", "-q", "-b", "polish")
  write(dir, "src/app.css", "a\nb\nc\n")
  write(dir, "src/old name.ts", lines(30))
  write(dir, "gone.txt", "1\n2\n")
  write(dir, "README.md", "# r\n")
  gitIn(dir, "add", "-A")
  gitIn(dir, "commit", "-qm", "x")
  write(dir, "src/app.css", "a\nc\nd\ne\n")
  fs.rmSync(path.join(dir, "gone.txt"))
  gitIn(dir, "mv", "src/old name.ts", "src/new name.ts")
  write(dir, "staged.ts", "s\n")
  gitIn(dir, "add", "staged.ts")
  write(dir, "new.css", "1\n2\n3\n")
  write(dir, "no newline at end.txt", "1\n2")
  write(dir, "empty.txt", "")
  write(dir, "deep/er/still/file name*:with[odd].md", "one\ntwo\n")
  write(dir, "only newlines", "\n\n\n")
}

test("on this computer, a normal repo reads as it did: branch, changes, their counts", async () => {
  const dir = tmp()
  try {
    const m = createLocalMachine()
    assert.equal(await vcs(m, dir), undefined, "not a repo")
    normalRepo(dir)
    const was = await before(m, dir)
    const now = await vcs(m, dir)
    assert.ok(was && now)
    assert.equal(now.branch, was.branch)
    assert.equal(now.branch, "polish")
    assert.deepEqual(now.changes.slice().sort(byFile), was.changes.slice().sort(byFile))
    assert.equal(now.total, was.changes.length)
    // And what they are, so the comparison is of something.
    assert.deepEqual(now.changes.slice().sort(byFile), [
      { file: "deep/er/still/file name*:with[odd].md", status: "added", additions: 2, deletions: 0 },
      { file: "empty.txt", status: "added", additions: 0, deletions: 0 },
      { file: "gone.txt", status: "deleted", additions: 0, deletions: 2 },
      { file: "new.css", status: "added", additions: 3, deletions: 0 },
      { file: "no newline at end.txt", status: "added", additions: 2, deletions: 0 },
      { file: "only newlines", status: "added", additions: 3, deletions: 0 },
      { file: "src/app.css", status: "modified", additions: 2, deletions: 1 },
      { file: "src/new name.ts", status: "modified", additions: 0, deletions: 0 },
      { file: "staged.ts", status: "added", additions: 1, deletions: 0 },
    ])
    // A detached HEAD has no branch, as before.
    gitIn(dir, "checkout", "-q", "--detach")
    assert.equal((await vcs(m, dir))?.branch, undefined)
    assert.equal((await before(m, dir))?.branch, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a repo with no commit yet, and a folder inside a repo, read as before", async () => {
  const dir = tmp()
  try {
    const m = createLocalMachine()
    gitIn(dir, "init", "-q", "-b", "fresh")
    write(dir, "a.txt", "1\n")
    write(dir, "b.txt", "1\n2\n")
    gitIn(dir, "add", "a.txt")
    const was = await before(m, dir)
    const now = await vcs(m, dir)
    assert.equal(now?.branch, "fresh")
    assert.deepEqual(now?.changes.slice().sort(byFile), was?.changes.slice().sort(byFile))
    // From a folder inside: the paths are the repo's (git status says so), and the new files'
    // lines are counted (before, they were looked for under the folder and read as 0).
    write(dir, "sub/c.txt", "1\n2\n3\n")
    const inner = await vcs(m, path.join(dir, "sub"))
    assert.deepEqual(inner?.changes.find((c) => c.file === "sub/c.txt"), { file: "sub/c.txt", status: "added", additions: 3, deletions: 0 })
    assert.deepEqual(inner?.changes.find((c) => c.file === "b.txt"), { file: "b.txt", status: "added", additions: 2, deletions: 0 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("binary files are marked, not counted; a new file past the line cap is marked large", async () => {
  const dir = tmp()
  try {
    const m = createLocalMachine()
    gitIn(dir, "init", "-q", "-b", "main")
    write(dir, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 10, 3]))
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "x")
    write(dir, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 9, 9, 10, 3]))
    write(dir, "new.bin", Buffer.from([0, 1, 2, 3, 10, 0]))
    write(dir, "huge.log", lines(LINES_MAX + 5, 4))
    write(dir, "fine.txt", "1\n")
    const now = await vcs(m, dir)
    assert.deepEqual(now?.changes.slice().sort(byFile), [
      { file: "fine.txt", status: "added", additions: 1, deletions: 0 },
      { file: "huge.log", status: "added", additions: 0, deletions: 0, uncounted: "large" },
      { file: "logo.png", status: "modified", additions: 0, deletions: 0, uncounted: "binary" },
      { file: "new.bin", status: "added", additions: 0, deletions: 0, uncounted: "binary" },
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the list is cut before anything is counted, and says how many there are", async () => {
  const dir = tmp()
  try {
    gitIn(dir, "init", "-q", "-b", "main")
    write(dir, "t.txt", "1\n")
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "x")
    write(dir, "t.txt", "1\n2\n")
    for (let i = 0; i < 30; i++) write(dir, `n/${String(i).padStart(2, "0")}.txt`, lines(i))
    const runs: string[][] = []
    const local = createLocalMachine()
    const m: Machine = { ...local, run: (program, args, o) => (runs.push(args), local.run(program, args, o)) }
    const now = await vcs(m, dir, 10)
    assert.equal(now?.total, 31)
    assert.deepEqual(
      now?.changes.map((c) => [c.file, c.additions]),
      [["t.txt", 1], ...Array.from({ length: 9 }, (_, i) => [`n/${String(i).padStart(2, "0")}.txt`, i])],
    )
    // Only the nine shown were given to grep.
    for (const args of runs.filter((a) => a.includes("grep"))) assert.equal(args.filter((a) => a.startsWith(":(top,literal)")).length, 9)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("what git says is read: porcelain v2 with renames and unmerged paths, grep's counts", () => {
  const status = [
    "# branch.oid abc",
    "# branch.head topic",
    "1 .M N... 100644 100644 100644 aaa bbb src/a file.ts",
    "2 R. N... 100644 100644 100644 aaa bbb R100 to name.ts",
    "from name.ts",
    "u UU N... 100644 100644 100644 100644 a b c both.ts",
    "1 D. N... 100644 000000 000000 aaa bbb gone.ts",
    "1 A. N... 000000 100644 100644 000 bbb added.ts",
    "? new file.txt",
    "",
  ].join("\0")
  assert.deepEqual(parseStatus(status), {
    branch: "topic",
    found: [
      { file: "src/a file.ts", untracked: false, status: "modified" },
      { file: "to name.ts", untracked: false, status: "modified" },
      { file: "both.ts", untracked: false, status: "modified" },
      { file: "gone.ts", untracked: false, status: "deleted" },
      { file: "added.ts", untracked: false, status: "added" },
      { file: "new file.txt", untracked: true, status: "added" },
    ],
  })
  assert.equal(parseStatus("# branch.head (detached)\0").branch, undefined)
  assert.deepEqual([...parseGrepCounts("a\x003\nb c\nd\x0012\n")], [["a", 3], ["b c\nd", 12]])
})

// ── another computer ─────────────────────────────────────────────────────────────────────────────

/** Every Machine call is one call to the helper over ssh: counted by name. */
function counting(m: Machine) {
  const calls: string[] = []
  const wrapped = new Proxy(m, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown
      if (typeof value !== "function" || key === "reach" || key === "onReach" || key === "hostname") return value
      return (...args: unknown[]) => (calls.push(String(key)), (value as (...a: unknown[]) => unknown).apply(target, args))
    },
  })
  return { m: wrapped, calls }
}

test("over ssh: 5,000 new files take four calls, not two each", async (t) => {
  const h = fakeHost()
  try {
    const remote = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const dir = path.join(h.home, "work")
      fs.mkdirSync(dir)
      gitIn(dir, "init", "-q", "-b", "main")
      write(dir, "README.md", "# r\n")
      gitIn(dir, "add", "-A")
      gitIn(dir, "commit", "-qm", "x")
      write(dir, "README.md", "# r\nmore\n")
      for (let i = 0; i < 5000; i++) write(dir, `node_modules/p${Math.floor(i / 100)}/f${i}.js`, "a\nb\n")
      const now = counting(remote)
      let at = performance.now()
      const repo = await vcs(now.m, dir, 200)
      const nowMs = performance.now() - at
      assert.equal(repo?.total, 5001)
      assert.equal(repo?.changes.length, 200)
      assert.deepEqual(repo?.changes[0], { file: "README.md", status: "modified", additions: 1, deletions: 0 })
      assert.ok(repo?.changes.slice(1).every((c) => c.status === "added" && c.additions === 2), "each new file's two lines")
      assert.deepEqual(now.calls, ["run", "run", "run", "run"])
      // The way it was: a stat and a read for each of the 5,000, before the list was cut.
      const was = counting(remote)
      at = performance.now()
      await before(was.m, dir)
      const wasMs = performance.now() - at
      assert.equal(was.calls.length, 4 + 2 * 5000)
      t.diagnostic(`5,000 untracked: ${now.calls.length} calls in ${nowMs.toFixed(0)} ms, before ${was.calls.length} calls in ${wasMs.toFixed(0)} ms`)
      assert.equal(remote.reach().status, "up")
    } finally {
      await remote.close()
    }
  } finally {
    await h.end()
  }
})

test("over ssh: 20 new files of 1.8 MB are counted there, and the connection stays up", async (t) => {
  const h = fakeHost()
  try {
    const remote = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const downs: string[] = []
      remote.onReach!((r) => r.status === "down" && downs.push(r.error))
      const dir = path.join(h.home, "work")
      fs.mkdirSync(dir)
      gitIn(dir, "init", "-q", "-b", "main")
      write(dir, "README.md", "# r\n")
      gitIn(dir, "add", "-A")
      gitIn(dir, "commit", "-qm", "x")
      const big = `${"y".repeat(80)}\n${`${"z".repeat(99)}\n`.repeat(18000)}`
      for (let i = 0; i < 20; i++) write(dir, `gen/big${String(i).padStart(2, "0")}.json`, big)
      const now = counting(remote)
      const at = performance.now()
      const repo = await vcs(now.m, dir, 200)
      const ms = performance.now() - at
      assert.equal(repo?.total, 20)
      assert.ok(repo?.changes.every((c) => c.additions === 18001 && !c.uncounted), JSON.stringify(repo?.changes[0]))
      assert.deepEqual(now.calls, ["run", "run", "run", "run"])
      // A beat for a drop to be noticed, had there been one.
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual(downs, [])
      assert.equal(remote.reach().status, "up")
      t.diagnostic(`20 × 1.8 MB untracked: ${now.calls.length} calls in ${ms.toFixed(0)} ms, connection up`)
    } finally {
      await remote.close()
    }
  } finally {
    await h.end()
  }
})
