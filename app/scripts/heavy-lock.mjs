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
  if (process.env.B42_NO_LOCK === "1" || process.env.B42_HEAVY_LOCK_HELD === "1") return
  const waitMs = Number(process.env.B42_LOCK_WAIT_S ?? 1800) * 1000
  const from = Date.now()
  let said = false
  for (;;) {
    try {
      fs.mkdirSync(LOCK)
      fs.writeFileSync(OWNER, JSON.stringify({ pid: process.pid, label, cwd: process.cwd(), since: new Date().toISOString() }))
      break
    } catch (e) {
      if (e.code !== "EEXIST") throw e
    }
    const o = owner()
    // Gone, or a folder with no owner written for a while (its holder died between mkdir and write).
    const stale = o ? !alive(o.pid) : Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 5000
    if (stale) {
      fs.rmSync(LOCK, { recursive: true, force: true })
      continue
    }
    if (Date.now() - from > waitMs) {
      console.error(`[heavy-lock] ${label}: waited ${Math.round(waitMs / 1000)} s for ${o?.label} (pid ${o?.pid}); going ahead anyway`)
      return
    }
    if (!said) {
      console.error(`[heavy-lock] ${label}: waiting for ${o ? `${o.label} (pid ${o.pid}, ${o.cwd}, since ${o.since})` : "another run"} to finish…`)
      said = true
    }
    await sleep(500)
  }
  if (said) console.error(`[heavy-lock] ${label}: going ahead after ${Math.round((Date.now() - from) / 1000)} s`)
  process.env.B42_HEAVY_LOCK_HELD = "1"
  process.on("exit", () => {
    if (owner()?.pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true })
  })
}
