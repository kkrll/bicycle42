// Runs the unit tests (dist/test/*.test.cjs, built by `scripts/build.mjs --tests`) and fails when
// any file's results did not all arrive, which node's own exit code does not.
//
//   node scripts/unit.mjs [dist/test/some.test.cjs ...]
//
// Why: node --test runs each file in a child process that reports over a pipe. With
// --test-force-exit the child calls process.exit() as soon as its tests are done, and what it
// had written that the pipe (64 KiB on Linux) could not hold yet is thrown away: a file whose
// reports are over 64 KiB (review.test, controller.test, acp.test) lost its last results whenever
// the parent was slow to read, and the run still said "pass 349, fail 0" and exited 0. So the
// flag is not used here. Without it a child that leaves a handle open does not end; the watchdog
// below ends the run after UNIT_TIMEOUT_S (600) and names the files that had not finished.
//
// And whatever else may lose a file, the guard checks, from a second reporter's count
// (unit-ledger.mjs), that every file was heard from and that every test a file announced has
// finished. Counting `test(` in the source would miss the tests a loop declares.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { heavyLock } from "./heavy-lock.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const testDir = path.join(root, "dist", "test")
const files = process.argv.length > 2
  ? process.argv.slice(2).map((f) => path.resolve(f))
  : fs.readdirSync(testDir).filter((f) => f.endsWith(".test.cjs")).sort().map((f) => path.join(testDir, f))
if (!files.length) {
  console.error("unit: no test files in dist/test; run `node scripts/build.mjs --tests` first")
  process.exit(1)
}

await heavyLock("unit tests")

const timeout = Number(process.env.UNIT_TIMEOUT_S ?? 600) * 1000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b42-unit-"))
const ledgerFile = path.join(tmp, "ledger.json")
// The test files' own temporary folders go here (TMPDIR), and go with it at the end: a test that
// does not clean up after itself no longer leaves its folders behind in /tmp, which on a machine
// whose /tmp is in memory filled it and made later runs fail on writes. Short, for unix sockets.
const scratch = path.join(tmp, "t")
fs.mkdirSync(scratch)

// Its own process group, so that the watchdog ends the files' processes too.
const child = spawn(
  process.execPath,
  [
    "--test",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${path.join(root, "scripts", "unit-ledger.mjs")}`, `--test-reporter-destination=${ledgerFile}`,
    ...files,
  ],
  { stdio: "inherit", cwd: root, detached: true, env: { ...process.env, TMPDIR: scratch } },
)
let timedOut = false
const watchdog = setTimeout(() => {
  timedOut = true
  try { process.kill(-child.pid, "SIGTERM") } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 5000).unref()
}, timeout)
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { process.kill(-child.pid, sig) } catch {}; fs.rmSync(tmp, { recursive: true, force: true }); process.exit(130) })

child.on("exit", (code) => {
  clearTimeout(watchdog)
  const byName = new Map()
  let ended = false
  try {
    for (const l of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
      if (!l) continue
      const n = JSON.parse(l)
      if (n.ended) ended = true
      else byName.set(path.basename(n.file), n)
    }
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })

  const problems = []
  let tests = 0
  for (const file of files) {
    const name = path.basename(file)
    const n = byName.get(name)
    const announced = n ? n.announced - 1 : 0 // the file itself is one of them
    const finished = n ? n.finished - (n.fileFinished ? 1 : 0) : 0
    if (!n) problems.push(`${name}: ${ended ? "nothing was reported for it" : "it had not started or not finished"}`)
    else if (!n.fileFinished) problems.push(`${name}: it did not finish (${finished} of ${announced} tests had)`)
    else if (announced < 1) problems.push(`${name}: its process ended before it said what it ran`)
    else if (finished < announced) problems.push(`${name}: ${announced} tests announced, ${finished} finished`)
    else tests += finished
  }
  if (timedOut) problems.unshift(`no end after ${timeout / 1000} s (UNIT_TIMEOUT_S): a test left a handle open or hung, and the run was stopped`)
  else if (!ended) problems.unshift("the run ended without the ledger reporter finishing, so no file can be vouched for")

  if (problems.length) {
    console.error(`\nunit: results are missing, so this run cannot count as passing even if the tests above passed:`)
    for (const p of problems) console.error(`  ✖ ${p}`)
    process.exit(1)
  }
  if (code !== 0) process.exit(code ?? 1)
  console.log(`\nunit: all ${files.length} files reported, ${tests} tests, none missing`)
  process.exit(0)
})
