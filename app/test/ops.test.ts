// The work that runs where the files are (src/main/ops.ts): on another computer, the app asks its
// helper once per operation, and the helper does it with the same code over that computer's own
// files. Through the fake ssh and the real helper bundle: how many calls each operation takes (a
// snapshot 1, the first of a run 2 with the log read for pruning, a take-back's dry and real runs 1
// each, the repo's line 1), that the answers are the same as on this computer, that a dry run's
// answer is reused only while the files are as it found them, and that a refusal comes back as
// one. Then the helper's checks of these calls' params, without a socket.
//
//   node scripts/build.mjs --tests && node --test dist/test/ops.test.cjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createHost, type Conn } from "../src/helper/host"
import { createLocalMachine, thisMachine } from "../src/main/machine"
import { opsOf } from "../src/main/ops"
import { createSnapshots, EMPTY_TREE, Refused } from "../src/main/snapshots"
import { connectSsh, type RemoteMachine } from "../src/main/ssh"
import { vcs } from "../src/main/vcs"
import { fakeHost, sleep } from "./ssh-fixture"

const write = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), body)
}
const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n"

/** The machine, with each call to its helper counted by name. */
function counted(m: RemoteMachine) {
  const calls: string[] = []
  const helper = m.helper.bind(m)
  ;(m as { helper: RemoteMachine["helper"] }).helper = (method, params, ms) => (calls.push(method), helper(method, params, ms))
  return { calls, take: () => calls.splice(0) }
}

test("over ssh, each operation on a folder is one call to the helper, and answers as it does here", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const c = counted(m)
      assert.equal(opsOf(m), opsOf(m), "one per connection")
      const root = path.join(h.home, ".bicycle42", "snapshots", "own")
      const dir = path.join(h.home, "work")
      for (let i = 0; i < 40; i++) write(dir, `src/f${i}.css`, lines(20, ` ${i}`))
      let sn = createSnapshots(h.data, { shadows: opsOf(m).shadows(root) })

      // The first snapshot ever: one call; pruning reads, writes and gc's the log beside it, not
      // waited for.
      const first = await sn.snapshot(dir)
      await sn.idle()
      assert.deepEqual(c.take(), ["ops.snapshot", "ops.readLog", "ops.writeLog", "ops.keep"])
      // The next run's first: the snapshot, and the log read (pruned today: nothing more).
      sn = createSnapshots(h.data, { shadows: opsOf(m).shadows(root) })
      assert.equal(await sn.snapshot(dir), first)
      await sn.idle()
      assert.deepEqual(c.take(), ["ops.snapshot", "ops.readLog"])
      // Warm: one.
      const before = (await sn.snapshot(dir))!
      write(dir, "src/f3.css", lines(20, " 3").replace("line 2 3", "line 2 CHANGED"))
      write(dir, "src/new.css", "new\n")
      const start = Date.now() - 5000
      const after = (await sn.snapshot(dir))!
      assert.deepEqual(c.take(), ["ops.snapshot", "ops.snapshot"])
      const turn = await sn.addTurn(dir, { session: "s", start, before, after, messages: ["m"] })
      assert.deepEqual(c.take(), ["ops.writeLog"])
      // The diff is the one this computer's snapshots give of the same folder.
      const diff = await sn.diff(dir, before, after)
      const here = createSnapshots(fs.mkdtempSync(path.join(os.tmpdir(), "b42-ops-here-")))
      const [b2, a2] = [await here.snapshot(dir), await here.snapshot(dir)]
      assert.equal(b2, after, "the same tree for the same files, wherever it is taken")
      assert.equal(a2, after)
      assert.deepEqual(diff.map((f) => [f.file, f.additions, f.deletions]), [
        ["src/f3.css", 1, 1],
        ["src/new.css", 1, 0],
      ])
      assert.deepEqual(c.take(), ["ops.diff"])

      // A take-back: the dry run, then the real one, which takes the dry run's answer as it is.
      const dry = await sn.reverse(dir, [turn], true)
      assert.deepEqual(dry?.files, ["src/f3.css", "src/new.css"])
      const done = await sn.reverse(dir, [turn], false, dry)
      assert.deepEqual(done, dry)
      assert.deepEqual(c.take(), ["ops.reverse", "ops.reverse"])
      assert.equal(fs.readFileSync(path.join(dir, "src/f3.css"), "utf8"), lines(20, " 3"))
      assert.equal(fs.existsSync(path.join(dir, "src/new.css")), false)
      // /redo: one.
      assert.equal(await sn.apply(dir, done!.to, done!.from), true)
      assert.deepEqual(c.take(), ["ops.apply"])
      assert.equal(fs.existsSync(path.join(dir, "src/new.css")), true)

      // A refusal comes back as one, nothing touched.
      await assert.rejects(sn.reverse(dir, [{ before: EMPTY_TREE, after }], true), Refused)
      await assert.rejects(sn.apply(dir, after, EMPTY_TREE), (e: Error) => e instanceof Refused && /would delete 41 of the folder's 41 files/.test(e.message))
      assert.equal(fs.readdirSync(path.join(dir, "src")).length, 41)
      // A folder that is not there: no snapshot, nothing said.
      assert.equal(await sn.snapshot(path.join(h.home, "not-there")), undefined)

      // The repo's line: one call, the same answer as asking git here call by call.
      execFileSync("sh", ["-c", "git init -q -b main && git add src ':!src/new.css' && git -c user.email=a@b -c user.name=a commit -qm x && echo more >> src/f1.css && printf 'a\\nb\\n' > fresh.txt"], { cwd: dir })
      c.take()
      const line = await opsOf(m).vcs(dir, 200)
      assert.deepEqual(c.take(), ["ops.vcs"])
      assert.deepEqual(line, await vcs(thisMachine(), dir, 200))
      assert.deepEqual(line?.changes.map((x) => [x.file, x.status, x.additions]), [
        ["src/f1.css", "modified", 1],
        ["fresh.txt", "added", 2],
        ["src/new.css", "added", 1],
      ])
      assert.equal(await opsOf(m).vcs(path.join(h.home), 200), undefined, "not a work tree: no line")
      await sn.idle()
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

test("over ssh, a dry run's answer is not taken once the files changed since: the take-back is found again and keeps that change", async () => {
  const h = fakeHost()
  try {
    const m = await connectSsh({ host: "dev-box", dataDir: h.data })
    try {
      const dir = path.join(h.home, "work")
      write(dir, "a.css", lines(20))
      const sn = createSnapshots(h.data, { shadows: opsOf(m).shadows(path.join(h.home, ".bicycle42", "snapshots", "own")) })
      const before = (await sn.snapshot(dir))!
      write(dir, "a.css", lines(20).replace("line 2\n", "line 2 AGENT\n"))
      const after = (await sn.snapshot(dir))!
      const dry = (await sn.reverse(dir, [{ before, after }], true))!
      // The reviewer changes another line before pressing Take back.
      write(dir, "a.css", lines(20).replace("line 2\n", "line 2 AGENT\n").replace("line 15\n", "line 15 BY HAND\n"))
      const done = await sn.reverse(dir, [{ before, after }], false, dry)
      assert.ok(done && done.from !== dry.from && done.to !== dry.to)
      assert.equal(fs.readFileSync(path.join(dir, "a.css"), "utf8"), lines(20).replace("line 15\n", "line 15 BY HAND\n"))
      // And one that no longer applies (the same line changed since) is not made from the old answer.
      const b2 = (await sn.snapshot(dir))!
      write(dir, "a.css", lines(20).replace("line 15\n", "line 15 BY HAND\n").replace("line 9\n", "line 9 AGENT\n"))
      const a2 = (await sn.snapshot(dir))!
      const dry2 = (await sn.reverse(dir, [{ before: b2, after: a2 }], true))!
      assert.deepEqual(dry2.files, ["a.css"])
      write(dir, "a.css", lines(20).replace("line 15\n", "line 15 BY HAND\n").replace("line 9\n", "line 9 OTHER\n"))
      assert.equal(await sn.reverse(dir, [{ before: b2, after: a2 }], false, dry2), undefined)
      assert.equal(fs.readFileSync(path.join(dir, "a.css"), "utf8"), lines(20).replace("line 15\n", "line 15 BY HAND\n").replace("line 9\n", "line 9 OTHER\n"))
      await sn.idle()
    } finally {
      await m.close()
    }
  } finally {
    await h.end()
  }
})

test("the helper checks the params of the work it does: a root that is not a full path, turns that are not turns, a dry run's answer that is not one", async () => {
  const h = createHost({ machine: createLocalMachine(), version: "t", log: () => {}, outMax: 1 << 20, errMax: 1 << 16, leaseMs: 60_000, idle: () => {}, busy: () => {}, shutdown: () => {} })
  const got: Array<{ id: number; result?: unknown; error?: { message: string; code?: string } }> = []
  const c: Conn = { send: (line) => void got.push(JSON.parse(line)) }
  h.attach(c)
  let id = 0
  const ask = async (method: string, params: unknown) => {
    const mine = ++id
    h.handle(c, JSON.stringify({ id: mine, method, params }))
    for (let i = 0; i < 200; i++) {
      const a = got.find((x) => x.id === mine)
      if (a) return a
      await sleep(5)
    }
    throw new Error(`no answer to ${method}`)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b42-ops-params-"))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b42-ops-root-"))
  const cases: Array<[string, unknown, RegExp]> = [
    ["ops.snapshot", { root: "relative/root", dir }, /root must be a full path/],
    ["ops.snapshot", { root }, /dir is missing/],
    ["ops.reverse", { root, dir, turns: [{ before: "x" }] }, /turns must be a list of \{before, after, start\?\}/],
    ["ops.reverse", { root, dir, turns: [{ before: "a", after: "b", start: "yesterday" }] }, /turns must be/],
    ["ops.reverse", { root, dir, turns: [], dry: "yes" }, /dry must be true or false/],
    ["ops.reverse", { root, dir, turns: [], was: { from: "a", to: "b" } }, /was must be \{from, to, files\}/],
    ["ops.keep", { root, dir, trees: "all" }, /trees must be a list of strings/],
    ["ops.vcs", { dir, max: -1 }, /max must be a whole number/],
    ["ops.nope", {}, /no such call/],
  ]
  for (const [method, params, want] of cases) {
    const a = await ask(method, params)
    assert.match(a.error?.message ?? "", want, `${method} ${JSON.stringify(params)}`)
    assert.ok(a.error?.code === "EINVAL" || a.error?.code === "ENOSYS")
  }
  // Well asked: answered.
  assert.match(String((await ask("ops.snapshot", { root, dir })).result), /^[0-9a-f]{40}$/)
  assert.equal((await ask("ops.readLog", { root, dir })).result, null)
  h.detach(c)
})
