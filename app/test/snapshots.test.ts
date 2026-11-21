import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createSnapshots, EMPTY_TREE, parseDiff, Refused } from "../src/main/snapshots"

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `b42-snap-${name}-`))
const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n"
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8")
const write = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), body)
}
/** Replaces line `n` (1-based) of a file. */
const edit = (dir: string, file: string, n: number, to: string) => {
  const all = read(dir, file).split("\n")
  all[n - 1] = to
  write(dir, file, all.join("\n"))
}

/** A folder and the app's data folder, with two turns of an agent: note 1 changes line 2 of
 *  a.css, note 2 changes line 18 and adds a file. */
async function twoTurns(opts: { git?: boolean } = {}) {
  const dir = tmp("work")
  const data = tmp("data")
  write(dir, "a.css", lines(20))
  if (opts.git) execFileSync("git", ["init", "-q"], { cwd: dir })
  const snaps = createSnapshots(data)
  const t0 = (await snaps.snapshot(dir))!
  edit(dir, "a.css", 2, "line 2 NOTE ONE")
  const t1 = (await snaps.snapshot(dir))!
  edit(dir, "a.css", 18, "line 18 NOTE TWO")
  write(dir, "b.css", "new file\n")
  const t2 = (await snaps.snapshot(dir))!
  return { dir, data, snaps, note1: { before: t0, after: t1 }, note2: { before: t1, after: t2 } }
}

test("snapshots: an older note is taken back exactly, the newer one stays", async () => {
  const { dir, snaps, note1 } = await twoTurns()
  const done = await snaps.reverse(dir, [note1])
  assert.ok(done)
  const now = read(dir, "a.css").split("\n")
  assert.deepEqual([now[1], now[17], read(dir, "b.css")], ["line 2", "line 18 NOTE TWO", "new file\n"])
  await snaps.idle()
})

test("snapshots: when a later note changed the same lines, nothing is touched", async () => {
  const { dir, snaps, note1 } = await twoTurns()
  edit(dir, "a.css", 2, "line 2 NOTE THREE ON TOP")
  const before = read(dir, "a.css")
  assert.equal(await snaps.reverse(dir, [note1], true), undefined)
  assert.equal(await snaps.reverse(dir, [note1]), undefined)
  assert.equal(read(dir, "a.css"), before)
  await snaps.idle()
})

test("snapshots: a dry run says it would apply and changes nothing", async () => {
  const { dir, snaps, note1 } = await twoTurns()
  const before = read(dir, "a.css")
  const would = await snaps.reverse(dir, [note1], true)
  assert.ok(would && would.from !== would.to)
  assert.equal(read(dir, "a.css"), before)
  await snaps.idle()
})

test("snapshots: a note's diff is its own turn's, file by file, with counts", async () => {
  const { dir, snaps, note2 } = await twoTurns()
  const diff = await snaps.diff(dir, note2.before, note2.after)
  assert.deepEqual(
    diff.map((f) => [f.file, f.additions, f.deletions]),
    [
      ["a.css", 1, 1],
      ["b.css", 1, 0],
    ],
  )
  assert.match(diff[0]!.patch, /^diff --git a\/a.css b\/a.css\n[\s\S]*-line 18\n\+line 18 NOTE TWO/)
  assert.match(diff[1]!.patch, /new file mode/)
  await snaps.idle()
})

test("snapshots: a folder that is a git repository is never touched in its own .git", async () => {
  const { dir, snaps, note1 } = await twoTurns({ git: true })
  const status = () => execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })
  const own = status()
  assert.ok(await snaps.reverse(dir, [note1]))
  // Its own index has nothing staged, and it still sees the files as untracked.
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
  assert.equal(status(), own)
  await snaps.idle()
})

test("snapshots: what the folder ignores is not in a turn, and node_modules never is", async () => {
  const dir = tmp("ignored")
  const snaps = createSnapshots(tmp("data"))
  write(dir, ".gitignore", "dist/\n*.log\n")
  write(dir, "a.css", lines(3))
  const t0 = (await snaps.snapshot(dir))!
  write(dir, "dist/out.js", "built\n")
  write(dir, "debug.log", "noise\n")
  write(dir, "node_modules/x/index.js", "dep\n")
  edit(dir, "a.css", 1, "changed")
  const t1 = (await snaps.snapshot(dir))!
  assert.deepEqual(
    (await snaps.diff(dir, t0, t1)).map((f) => f.file),
    ["a.css"],
  )
  // Taking it back leaves the ignored files as they are.
  assert.ok(await snaps.reverse(dir, [{ before: t0, after: t1 }]))
  assert.deepEqual([read(dir, "a.css"), read(dir, "dist/out.js"), read(dir, "debug.log")], [lines(3), "built\n", "noise\n"])
  await snaps.idle()
})

test("snapshots: what the reviewer changed by hand between turns is kept", async () => {
  const { dir, snaps } = await twoTurns()
  // The reviewer changes line 10; the next turn's "before" has it.
  edit(dir, "a.css", 10, "line 10 BY HAND")
  const before = (await snaps.snapshot(dir))!
  edit(dir, "a.css", 5, "line 5 NOTE THREE")
  const after = (await snaps.snapshot(dir))!
  assert.ok(await snaps.reverse(dir, [{ before, after }]))
  const now = read(dir, "a.css").split("\n")
  assert.deepEqual([now[4], now[9]], ["line 5", "line 10 BY HAND"])
  await snaps.idle()
})

test("snapshots: a deleted file comes back, a new one goes", async () => {
  const dir = tmp("files")
  const snaps = createSnapshots(tmp("data"))
  write(dir, "old.css", "old\n")
  const t0 = (await snaps.snapshot(dir))!
  fs.rmSync(path.join(dir, "old.css"))
  write(dir, "new.css", "new\n")
  const t1 = (await snaps.snapshot(dir))!
  assert.ok(await snaps.reverse(dir, [{ before: t0, after: t1 }]))
  assert.deepEqual([fs.existsSync(path.join(dir, "new.css")), read(dir, "old.css")], [false, "old\n"])
  await snaps.idle()
})

test("snapshots: several turns go back together, or not at all", async () => {
  const { dir, snaps, note1, note2 } = await twoTurns()
  // Note 2 on top of note 1 in the same line: one at a time, note 1 can't go first; both can.
  edit(dir, "a.css", 2, "line 2 NOTE ONE AGAIN")
  const again = (await snaps.snapshot(dir))!
  const note3 = { before: note2.after, after: again }
  assert.equal(await snaps.reverse(dir, [note1], true), undefined)
  assert.ok(await snaps.reverse(dir, [note1, note2, note3]))
  assert.equal(read(dir, "a.css"), lines(20))
  assert.equal(fs.existsSync(path.join(dir, "b.css")), false)
  await snaps.idle()
})

test("snapshots: a take-back is brought back by going the other way", async () => {
  const { dir, snaps, note1 } = await twoTurns()
  const done = (await snaps.reverse(dir, [note1]))!
  // The reviewer edits another line meanwhile; the redo keeps it.
  edit(dir, "a.css", 10, "line 10 BY HAND")
  assert.equal(await snaps.apply(dir, done.to, done.from), true)
  const now = read(dir, "a.css").split("\n")
  assert.deepEqual([now[1], now[9], now[17]], ["line 2 NOTE ONE", "line 10 BY HAND", "line 18 NOTE TWO"])
  // Again, it no longer applies: nothing changes.
  const was = read(dir, "a.css")
  assert.equal(await snaps.apply(dir, done.to, done.from), false)
  assert.equal(read(dir, "a.css"), was)
  await snaps.idle()
})

test("snapshots: the log and its trees outlive a restart", async () => {
  const { dir, data, snaps, note1 } = await twoTurns()
  await snaps.addTurn(dir, { session: "ses_1", start: Date.now(), ...note1, messages: ["msg_1"] })
  const r = await snaps.addRestore(dir, { session: "ses_1", time: Date.now(), turns: [], from: note1.after, to: note1.before, notes: ["n1"] })
  await snaps.updateRestore(dir, r.id, { told: true })
  await snaps.idle()
  // A new process: the log is read from disk, and the trees are still there to diff and reverse.
  const again = createSnapshots(data)
  const h = await again.history(dir)
  assert.deepEqual([h.turns.length, h.turns[0]!.messages, h.restores[0]!.told], [1, ["msg_1"], true])
  const t = h.turns[0]!
  assert.deepEqual((await again.diff(dir, t.before, t.after)).map((f) => f.file), ["a.css"])
  assert.ok(await again.reverse(dir, [t]))
  assert.equal(read(dir, "a.css").split("\n")[1], "line 2")
  await again.idle()
})

test("snapshots: a git add that is killed (a timeout, a signal) is no snapshot, whatever it printed first", async () => {
  // A first snapshot of a big folder with a nested repository: git warns about it, then the
  // timeout kills it. Its write-tree would be the empty tree, and a turn from there "every file
  // added", taken back by deleting them all.
  const dir = tmp("killed")
  for (let i = 0; i < 30; i++) write(dir, `f${i}.css`, `file ${i}\n`)
  const snaps = createSnapshots(tmp("data"))
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  const bin = tmp("bin")
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = add ]; then echo "warning: adding embedded git repository: vendor/x" >&2; kill -9 $$; fi\nexec "${real}" "$@"\n`, { mode: 0o755 })
  const was = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${was}`
  try {
    assert.equal(await snaps.snapshot(dir), undefined)
  } finally {
    process.env.PATH = was
  }
  const tree = await snaps.snapshot(dir)
  assert.ok(tree && tree !== EMPTY_TREE)
  await snaps.idle()
})

test("snapshots: a change that would delete much of the folder is refused, and nothing is touched", async () => {
  const dir = tmp("gone")
  for (let i = 0; i < 30; i++) write(dir, `f${i}.css`, `file ${i}\n`)
  const snaps = createSnapshots(tmp("data"))
  const all = (await snaps.snapshot(dir))!
  // A turn whose "before" is the empty tree reads as "every file added".
  await assert.rejects(snaps.reverse(dir, [{ before: EMPTY_TREE, after: all }], true), Refused)
  await assert.rejects(snaps.reverse(dir, [{ before: EMPTY_TREE, after: all }]), /would delete 30 of the folder's 30 files/)
  await assert.rejects(snaps.apply(dir, all, EMPTY_TREE), Refused)
  assert.equal(fs.readdirSync(dir).length, 30)
  // A few files are not "much of the folder".
  write(dir, "x.css", "x\n")
  write(dir, "y.css", "y\n")
  const more = (await snaps.snapshot(dir))!
  const back = await snaps.reverse(dir, [{ before: all, after: more }])
  assert.deepEqual(back?.files, ["x.css", "y.css"])
  assert.equal(fs.existsSync(path.join(dir, "x.css")), false)
  await snaps.idle()
})

test("snapshots: a file the turn's .gitignore edit let in, on disk before the turn, is not deleted by taking it back", async () => {
  const dir = tmp("unignored")
  const snaps = createSnapshots(tmp("data"))
  write(dir, ".gitignore", "secret.env\ndist/\n")
  write(dir, "secret.env", "KEY=1\n")
  write(dir, "dist/out.js", "built\n")
  write(dir, "a.css", lines(3))
  const before = (await snaps.snapshot(dir))!
  await new Promise((r) => setTimeout(r, 20))
  const start = Date.now()
  // (The file system's clock is coarser than Date.now(): a file written at once may read older.)
  await new Promise((r) => setTimeout(r, 20))
  // The agent's turn: takes the patterns out, changes a.css, adds a file.
  write(dir, ".gitignore", "")
  edit(dir, "a.css", 1, "changed")
  write(dir, "new.css", "new\n")
  const after = (await snaps.snapshot(dir))!
  assert.deepEqual((await snaps.diff(dir, before, after)).map((f) => f.file).sort(), [".gitignore", "a.css", "dist/out.js", "new.css", "secret.env"])
  assert.ok(await snaps.reverse(dir, [{ before, after, start }]))
  assert.deepEqual(
    [read(dir, ".gitignore"), read(dir, "a.css"), read(dir, "secret.env"), read(dir, "dist/out.js"), fs.existsSync(path.join(dir, "new.css"))],
    ["secret.env\ndist/\n", lines(3), "KEY=1\n", "built\n", false],
  )
  await snaps.idle()
})

test("snapshots: a take-back the agent was not told of outlives the 30-day cut with its turns; a told one goes", async () => {
  const { dir, data, snaps, note1, note2 } = await twoTurns()
  const old = Date.now() - 40 * 86_400_000
  const t1 = await snaps.addTurn(dir, { session: "s", start: old, ...note1, messages: ["m1"] })
  const t2 = await snaps.addTurn(dir, { session: "s", start: old, ...note2, messages: ["m2"] })
  await snaps.addTurn(dir, { session: "s", start: old, ...note2, messages: ["m3"] })
  const untold = await snaps.addRestore(dir, { session: "s", time: old, turns: [t1.id], from: note1.after, to: note1.before, notes: ["n1"] })
  await snaps.addRestore(dir, { session: "s", time: old, turns: [t2.id], from: note2.after, to: note2.before, notes: ["n2"], told: true })
  await snaps.idle()
  // The next run's first snapshot prunes (it was not pruned today).
  const log = path.join(data, "snapshots", fs.readdirSync(path.join(data, "snapshots"))[0]!, "b42.json")
  fs.writeFileSync(log, JSON.stringify({ ...JSON.parse(fs.readFileSync(log, "utf8")), pruned: 0 }))
  const again = createSnapshots(data)
  await again.snapshot(dir)
  await again.idle()
  const h = await again.history(dir)
  assert.deepEqual([h.restores.map((r) => r.id), h.turns.map((t) => t.id)], [[untold.id], [t1.id]])
})

test("snapshots: a folder that is not there has no snapshot", async () => {
  const snaps = createSnapshots(tmp("data"))
  assert.equal(await snaps.snapshot(path.join(os.tmpdir(), "b42-snap-not-there-at-all")), undefined)
})

test("snapshots: a diff is split per file with its counts", () => {
  const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\nBinary files a/y and b/y differ\n"
  assert.deepEqual(parseDiff("1\t1\tx\0-\t-\ty\0", patch), [
    { file: "x", additions: 1, deletions: 1, patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" },
    { file: "y", additions: 0, deletions: 0, patch: "diff --git a/y b/y\nBinary files a/y and b/y differ" },
  ])
})
