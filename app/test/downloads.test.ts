// Downloads a page asks for, as the controller has them (src/main/core.ts): held by the page
// (page.ts, which test/page.e2e.ts drives in Electron) and asked about in the window, one at a
// time, until the reviewer says Save… or Don't, or the page is elsewhere. In plain Node, in the
// shell of test/stubs/host.ts, with a download that is no browser's: a record of what was done to it.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { HeldDownload } from "../src/main/page"
import { playedAgent, type Played } from "./played-agent"
import { testShell } from "./stubs/host"

const SITE = "http://site.test"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => unknown, ms = 8000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(10)
  }
}

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-downloads-")))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const folder = (name: string) => {
  const p = path.join(ROOT, name)
  fs.mkdirSync(p, { recursive: true })
  return p
}

/** A held download: what the controller did to it. `fails` makes its save reject with that;
 *  `slow` leaves it coming until the test says (`progress`, `arrive`, `fail`), and its cancel()
 *  then rejects the save as the page's does. */
function download(file = "report.csv", opts: { site?: string; frame?: true; from?: string; size?: number; fails?: string; slow?: true } = {}) {
  let settle: { resolve(): void; reject(err: Error): void; progress?: (n: number) => void } | undefined
  const d = {
    site: opts.site ?? "site.test",
    ...(opts.frame ? { frame: opts.frame } : {}),
    ...(opts.from ? { from: opts.from } : {}),
    file,
    ...(opts.size !== undefined ? { size: opts.size } : {}),
    saved: [] as string[],
    cancelled: 0,
    save(to: string, progress?: (received: number) => void) {
      d.saved.push(to)
      if (opts.slow) return new Promise<void>((resolve, reject) => (settle = { resolve, reject, ...(progress ? { progress } : {}) }))
      return opts.fails ? Promise.reject(new Error(opts.fails)) : Promise.resolve()
    },
    cancel() {
      d.cancelled++
      settle?.reject(new Error("The download was cancelled."))
    },
    progress: (n: number) => settle?.progress?.(n),
    arrive: () => settle?.resolve(),
    fail: (why: string) => settle?.reject(new Error(why)),
  }
  return d satisfies HeldDownload
}

/** A controller with the played agent, the page at the site. */
async function boot() {
  const dir = fs.mkdtempSync(path.join(ROOT, "profile-"))
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 1, defaultModel: { providerID: "fake", id: "fake/alpha" } }))
  const agents = new Map<string, Played>()
  const agentOf = (command: string) => {
    let w = agents.get(command)
    if (!w) agents.set(command, (w = playedAgent()))
    return w
  }
  const quiet = { log: console.log, warn: console.warn, error: console.error }
  if (!process.env.V) console.log = console.warn = console.error = () => {}
  const shell = testShell(dir, { agent: (command) => agentOf(command.join(" ")).fa.connect() })
  const cmd = (name: string, ...args: unknown[]) => shell.core.invoke(name, args)
  const snap = () => shell.core.snapshot()
  const ask = (d: HeldDownload) => shell.core.pageEvents.onDownload(d)
  /** The line the window shows, without its id. */
  const line = () => {
    const d = snap().page.download
    return d && { site: d.site, file: d.file, ...(d.size !== undefined ? { size: d.size } : {}) }
  }
  const id = () => snap().page.download?.id
  shell.page.load(`${SITE}/orders`)
  return {
    shell,
    cmd,
    snap,
    ask,
    line,
    id,
    async connect(command = "fake-agent") {
      await cmd("connectAgent", { id: "custom", command })
    },
    async close() {
      await Promise.resolve(cmd("disconnect")).catch(() => undefined)
      await shell.core.dispose()
      Object.assign(console, quiet)
    },
  }
}

test("a download the page asks for is a line in the window, with who asked and what; Don't cancels it and the line goes", async () => {
  const h = await boot()
  try {
    assert.equal(h.snap().page.download, undefined)
    const d = download("report.csv", { size: 12_480 })
    h.ask(d)
    assert.deepEqual(h.line(), { site: "site.test", file: "report.csv", size: 12_480 })
    assert.equal(h.snap().page.saving, undefined)
    assert.equal(d.cancelled, 0, "held, not cancelled")

    // An id that is not the one asked about (a line already gone) does nothing.
    await h.cmd("dropDownload", "not-this-one")
    await h.cmd("saveDownload", "not-this-one")
    assert.deepEqual([d.cancelled, d.saved, h.shell.saveDialog.asked], [0, [], []])
    assert.ok(h.line())

    await h.cmd("dropDownload", h.id())
    assert.deepEqual([d.cancelled, d.saved, h.snap().page.download], [1, [], undefined])

    // A size the site did not say is not said.
    h.ask(download("notes.txt"))
    assert.deepEqual(h.line(), { site: "site.test", file: "notes.txt" })

    // A frame of no site of its own (sandboxed, data:) in the page, and a file of another site: both said.
    h.ask(download("x.csv", { site: "site.test", frame: true, from: "files.example", size: 3 }))
    const { id: _id, ...said } = h.snap().page.download!
    assert.deepEqual(said, { site: "site.test", frame: true, from: "files.example", file: "x.csv", size: 3 })
  } finally {
    await h.close()
  }
})

test("a second download while one waits takes its place: the first is cancelled, and an answer meant for it does nothing", async () => {
  const h = await boot()
  try {
    const first = download("one.csv")
    h.ask(first)
    const firstId = h.id()
    const second = download("two.csv")
    h.ask(second)
    assert.deepEqual([first.cancelled, second.cancelled, h.line()?.file], [1, 0, "two.csv"])
    assert.notEqual(h.id(), firstId)

    await h.cmd("saveDownload", firstId)
    await h.cmd("dropDownload", firstId)
    assert.deepEqual([h.shell.saveDialog.asked, second.cancelled, h.line()?.file], [[], 0, "two.csv"])

    // Many in a row (a page clicking a blob link in a loop): one line, the last; every other cancelled.
    const many = Array.from({ length: 5 }, (_, i) => download(`spam-${i}.bin`))
    for (const d of many) h.ask(d)
    assert.deepEqual([second.cancelled, ...many.map((d) => d.cancelled)], [1, 1, 1, 1, 1, 0])
    assert.equal(h.line()?.file, "spam-4.bin")
  } finally {
    await h.close()
  }
})

test("Save… asks where in the system's dialog, by the file's name, and the download goes there; cancelling the dialog is Don't", async () => {
  const h = await boot()
  try {
    const d = download("report.csv")
    h.ask(d)
    h.shell.saveDialog.answer = "/home/me/Downloads/report (1).csv"
    await h.cmd("saveDownload", h.id())
    assert.deepEqual(h.shell.saveDialog.asked, ["report.csv"])
    assert.deepEqual([d.saved, d.cancelled, h.snap().page.download], [["/home/me/Downloads/report (1).csv"], 0, undefined])

    const no = download("other.csv")
    h.ask(no)
    h.shell.saveDialog.answer = undefined
    await h.cmd("saveDownload", h.id())
    assert.deepEqual([no.saved, no.cancelled, h.snap().page.download], [[], 1, undefined])
    assert.deepEqual(h.shell.dialogs, [], "nothing to tell")
  } finally {
    await h.close()
  }
})

test("a download that could not be saved where it was asked for says so, in a dialog", async () => {
  const h = await boot()
  try {
    h.ask(download("big.zip", { fails: "The download stopped before it had all come." }))
    h.shell.saveDialog.answer = "/home/me/Downloads/big.zip"
    await h.cmd("saveDownload", h.id())
    await until(() => h.shell.dialogs.length === 1)
    assert.deepEqual(h.shell.dialogs, [{ type: "warning", message: "big.zip was not saved", detail: "The download stopped before it had all come." }])
  } finally {
    await h.close()
  }
})

test("while the Save dialog is open: Save again opens no second one, and a download that took the place of this one is not saved where this one was to go", async () => {
  const h = await boot()
  try {
    const first = download("one.csv")
    h.ask(first)
    let answer!: (to: string | undefined) => void
    h.shell.saveDialog.answer = new Promise((done) => (answer = done))
    const saving = h.cmd("saveDownload", h.id())
    await h.cmd("saveDownload", h.id())
    assert.deepEqual(h.shell.saveDialog.asked, ["one.csv"], "one dialog")
    assert.ok(h.line(), "the line stays while the dialog is open")

    const second = download("two.csv")
    h.ask(second)
    answer("/home/me/Downloads/one.csv")
    await saving
    assert.deepEqual([first.saved, first.cancelled, second.saved, second.cancelled, h.line()?.file], [[], 1, [], 0, "two.csv"])

    // The page went to another site while the dialog was open: nothing is saved either.
    h.shell.saveDialog.answer = new Promise((done) => (answer = done))
    const again = h.cmd("saveDownload", h.id())
    h.shell.page.load("http://other.test/")
    answer("/home/me/Downloads/two.csv")
    await again
    assert.deepEqual([second.saved, second.cancelled, h.snap().page.download], [[], 1, undefined])
  } finally {
    await h.close()
  }
})

test("the page going to another site cancels the download it asked for; a move within the site (a reload, a #hash, another query or path, a pushState) does not", async () => {
  const h = await boot()
  try {
    const d = download()
    h.ask(d)
    h.shell.page.load(`${SITE}/orders#total`)
    h.shell.page.load(`${SITE}/orders`)
    h.shell.page.load(`${SITE}/orders?page=2`)
    // "Start the download, then go to /thanks": the site's own way, the line stays.
    h.shell.page.load(`${SITE}/thanks`)
    assert.deepEqual([d.cancelled, h.line()?.file], [0, "report.csv"])
    // Another port is another site.
    h.shell.page.load("http://site.test:8080/orders")
    assert.deepEqual([d.cancelled, h.snap().page.download], [1, undefined])

    // The page closed, or made again in another computer's session (setPartition): nothing loaded.
    h.shell.page.load(`${SITE}/orders`)
    const e = download()
    h.ask(e)
    h.shell.page.load("")
    assert.deepEqual([e.cancelled, h.snap().page.download], [1, undefined])
  } finally {
    await h.close()
  }
})

test("a download saved and still coming is a line of how much has come, until it is in place; Cancel on it stops it with no dialog", async () => {
  const h = await boot()
  try {
    const d = download("big.zip", { size: 1000, slow: true })
    h.ask(d)
    h.shell.saveDialog.answer = "/home/me/Downloads/big.zip"
    const id = h.id()!
    await h.cmd("saveDownload", id)
    assert.deepEqual([h.snap().page.download, h.snap().page.saving], [undefined, [{ id, file: "big.zip", received: 0, size: 1000 }]])
    d.progress(250)
    assert.deepEqual(h.snap().page.saving, [{ id, file: "big.zip", received: 250, size: 1000 }])
    // Another one asked about meanwhile has its own line, and does not cancel this one.
    const other = download("other.csv")
    h.ask(other)
    assert.deepEqual([d.cancelled, h.line()?.file, h.snap().page.saving?.length], [0, "other.csv", 1])
    // A move to another site does not stop it either: the reviewer said Save.
    h.shell.page.load("http://other.test/")
    assert.deepEqual([d.cancelled, other.cancelled, h.snap().page.saving?.length], [0, 1, 1])
    d.arrive()
    await until(() => !h.snap().page.saving)
    assert.deepEqual(h.shell.dialogs, [])

    // Cancel while it comes: stopped, the line goes, and no dialog says it failed.
    const e = download("again.zip", { slow: true })
    h.ask(e)
    const eid = h.id()!
    await h.cmd("saveDownload", eid)
    assert.deepEqual(h.snap().page.saving, [{ id: eid, file: "again.zip", received: 0 }])
    await h.cmd("dropDownload", eid)
    await until(() => !h.snap().page.saving)
    assert.deepEqual([e.cancelled, h.shell.dialogs], [1, []])

    // One that fails as it comes: its line goes, and a dialog says why.
    const f = download("fails.zip", { slow: true })
    h.ask(f)
    await h.cmd("saveDownload", h.id())
    f.fail("The download stopped before it had all come.")
    await until(() => !h.snap().page.saving && h.shell.dialogs.length === 1)
    assert.deepEqual(h.shell.dialogs, [{ type: "warning", message: "fails.zip was not saved", detail: "The download stopped before it had all come." }])
  } finally {
    await h.close()
  }
})

test("a download that ended before it was answered (it failed there) takes its line with it; another's end does not", async () => {
  const h = await boot()
  try {
    const old = download("old.csv")
    h.ask(old)
    const d = download("new.csv")
    h.ask(d)
    h.shell.core.pageEvents.onDownloadGone(old)
    assert.equal(h.line()?.file, "new.csv")
    h.shell.core.pageEvents.onDownloadGone(d)
    assert.deepEqual([h.snap().page.download, d.cancelled], [undefined, 0])
  } finally {
    await h.close()
  }
})

test("opening another project, or another agent, cancels the download waiting", async () => {
  const h = await boot()
  const REPO = folder("repo")
  const OTHER = folder("other")
  try {
    await h.connect()
    await h.cmd("setDirectory", REPO)
    await until(() => !!h.snap().session)

    // The project that is open, opened again: nothing changes.
    const d = download()
    h.ask(d)
    await h.cmd("openProject", REPO)
    assert.deepEqual([d.cancelled, h.line()?.file], [0, "report.csv"])
    // Another project.
    await h.cmd("openProject", OTHER)
    assert.deepEqual([d.cancelled, h.snap().page.download], [1, undefined])

    h.shell.page.load(`${SITE}/orders`)
    const e = download()
    h.ask(e)
    await h.connect("fake-agent --second")
    await until(() => h.snap().harness?.name === "fake-agent" && h.snap().connection.status === "online")
    assert.deepEqual([e.cancelled, h.snap().page.download], [1, undefined])
  } finally {
    await h.close()
  }
})
