// One heavy test run at a time on this computer: the unit tests, the page and app e2e (headless
// Electron), the screenshots and the overlay's browser tests each take most of a 4-core machine.
// Two or three at once (parallel agents, a merge check beside them) made each several times
// slower and made timing-sensitive checks fail, and every failure cost a full rerun. So each of
// them takes this lock first and waits its turn, saying once whom it waits for.
//
//   import { heavyLock } from "../scripts/heavy-lock.mjs"; await heavyLock("app e2e")
//   node scripts/heavy-lock-run.mjs <command…>          (holds it around a command)
//
// The lock is a folder (mkdir is atomic everywhere, flock is not on a Mac) with its holder's pid:
// one whose process is gone is taken over. A process that holds it says so to its children
// (B42_HEAVY_LOCK_HELD), so nothing waits for itself. B42_NO_LOCK=1 skips it; after
// B42_LOCK_WAIT_S (1800) of waiting a run goes ahead anyway, and says so.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Fixed, not os.tmpdir(): agents and test runs set TMPDIR (and HOME) to folders of their own. */
const LOCK = process.platform === "win32" ? path.join(os.tmpdir(), "bicycle42-heavy.lock") : "/tmp/bicycle42-heavy.lock"
const OWNER = path.join(LOCK, "owner.json")

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}
const owner = () => {
  try {
    return JSON.parse(fs.readFileSync(OWNER, "utf8"))
  } catch {
    return null
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Waits until this process holds the lock (or need not), and lets it go when the process ends. */
export async function heavyLock(label) {
  const t = start(label)
  while (t && !attempt(t)) await sleep(500)
}

/** The same, waiting without the event loop: for a script that must hold the lock before anything
 *  of its own starts, such as the app e2e, whose 90 s watchdog would otherwise count the wait (and
 *  whose Electron must not be ready before its schemes are registered, so it cannot wait after). */
export function heavyLockSync(label) {
  const t = start(label)
  const cell = new Int32Array(new SharedArrayBuffer(4))
  while (t && !attempt(t)) Atomics.wait(cell, 0, 0, 500)
}

/** A wait about to begin, or null when there is none to do. */
function start(label) {
  if (process.env.B42_NO_LOCK === "1" || process.env.B42_HEAVY_LOCK_HELD === "1") return null
  return { label, from: Date.now(), waitMs: Number(process.env.B42_LOCK_WAIT_S ?? 1800) * 1000, said: false }
}

/** One try: true once the lock is held (or the wait is given up), false to wait and try again. */
function attempt(t) {
  try {
    fs.mkdirSync(LOCK)
    fs.writeFileSync(OWNER, JSON.stringify({ pid: process.pid, label: t.label, cwd: process.cwd(), since: new Date().toISOString() }))
    if (t.said) console.error(`[heavy-lock] ${t.label}: going ahead after ${Math.round((Date.now() - t.from) / 1000)} s`)
    process.env.B42_HEAVY_LOCK_HELD = "1"
    process.on("exit", () => {
      if (owner()?.pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true })
    })
    return true
  } catch (e) {
    if (e.code !== "EEXIST") throw e
  }
  const o = owner()
  // Gone, or a folder with no owner written for a while (its holder died between mkdir and write).
  const stale = o ? !alive(o.pid) : Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 5000
  if (stale) {
    fs.rmSync(LOCK, { recursive: true, force: true })
    return attempt(t)
  }
  if (Date.now() - t.from > t.waitMs) {
    console.error(`[heavy-lock] ${t.label}: waited ${Math.round(t.waitMs / 1000)} s for ${o?.label} (pid ${o?.pid}); going ahead anyway`)
    return true
  }
  if (!t.said) {
    console.error(`[heavy-lock] ${t.label}: waiting for ${o ? `${o.label} (pid ${o.pid}, ${o.cwd}, since ${o.since})` : "another run"} to finish…`)
    t.said = true
  }
  return false
}
