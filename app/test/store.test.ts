// Settings and reviews on disk (src/main/store.ts), in plain Node against a temp directory.
//
//   node scripts/build.mjs --tests && node --test dist/test/store.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createStore } from "../src/main/store"
import { createReview } from "../src/main/review"

type Logged = { level: string; msg: string; data?: unknown }

function setup(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-store-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const logs: Logged[] = []
  const log = (level: string, msg: string, data?: unknown) => void logs.push({ level, msg, data })
  // A long debounce, so nothing reaches the disk in a test unless the test says so.
  const open = (debounceMs = 60_000) => createStore(dir, { debounceMs, log })
  return { dir, logs, open, settingsFile: path.join(dir, "settings.json"), reviews: path.join(dir, "reviews") }
}
const readJSON = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = "http://localhost:3000"

test("a new directory starts with defaults and writes nothing by itself", (t) => {
  const { dir, logs, open } = setup(t)
  const store = open()
  assert.deepEqual(store.settings(), { version: 1, sites: {} })
  assert.equal(store.loadReview(ORIGIN), undefined)
  store.flush()
  assert.deepEqual(fs.readdirSync(dir), [])
  assert.deepEqual(logs, [])
})

test("settings round-trip, as strict JSON, private to the user", (t) => {
  const { open, settingsFile, logs } = setup(t)
  const store = open()
  store.update((s) => {
    s.server = { url: "http://box:4096", password: "enc:abc" }
    s.lastUrl = `${ORIGIN}/pricing`
    s.defaultModel = { providerID: "anthropic", id: "sonnet", variant: undefined }
    s.sites[ORIGIN] = { directory: "/home/dev/site", session: "ses_1", bg: undefined }
  })
  assert.equal((store.settings().server as { url?: string } | undefined)?.url, "http://box:4096", "in memory at once")
  assert.equal(fs.existsSync(settingsFile), false, "on disk only after the debounce or a flush")
  store.flush()

  const expected = {
    version: 1,
    server: { url: "http://box:4096", password: "enc:abc" },
    lastUrl: `${ORIGIN}/pricing`,
    defaultModel: { providerID: "anthropic", id: "sonnet" },
    sites: { [ORIGIN]: { directory: "/home/dev/site", session: "ses_1" } },
  }
  assert.deepEqual(readJSON(settingsFile), expected)
  if (process.platform !== "win32") assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600)
  assert.deepEqual(open().settings(), expected, "a new store reads it back")
  assert.deepEqual(logs, [])
})

test("reviews round-trip, one file per origin", (t) => {
  const { open, reviews } = setup(t)
  const store = open()
  const review = createReview()
  review.draft = { text: "half" }
  store.saveReview(ORIGIN, review.toJSON())
  store.saveReview("https://example.com", { version: 1, notes: [], other: true })
  assert.deepEqual(store.loadReview(ORIGIN), review.toJSON(), "readable before it is written")
  store.flush()

  assert.deepEqual(fs.readdirSync(reviews).sort(), ["http%3A%2F%2Flocalhost%3A3000.json", "https%3A%2F%2Fexample.com.json"])
  const again = open()
  assert.deepEqual(again.loadReview(ORIGIN), review.toJSON())
  assert.deepEqual(createReview(again.loadReview(ORIGIN)).draft, { text: "half" })
  assert.deepEqual(again.loadReview("https://example.com"), { version: 1, notes: [], other: true })
  assert.equal(again.loadReview("http://localhost:3001"), undefined)
})

test("an origin can't name a file outside the reviews folder", (t) => {
  const { dir, open, reviews } = setup(t)
  const store = open()
  for (const origin of ["../../escape", "/etc/passwd", "..", "a/b\\c*"]) store.saveReview(origin, { version: 1, origin })
  store.flush()
  assert.deepEqual(fs.readdirSync(dir), ["reviews"])
  assert.equal(fs.readdirSync(reviews).length, 4)
  for (const f of fs.readdirSync(reviews)) assert.equal(fs.statSync(path.join(reviews, f)).isFile(), true)
  assert.deepEqual(open().loadReview("../../escape"), { version: 1, origin: "../../escape" })
})

const BROKEN: Array<[name: string, content: string]> = [
  ["cut off mid-write", '{"version":1,"sites":{"http://x":{"dir'],
  ["empty", ""],
  ["not an object", "[1,2,3]"],
  ["an unknown older version", '{"version":0,"sites":{}}'],
  ["a version that isn't a number", '{"version":"2","sites":{}}'],
  ["no version", '{"sites":{}}'],
]
for (const [name, content] of BROKEN)
  test(`settings file ${name}: moved aside, never written over`, (t) => {
    const { dir, open, logs, settingsFile } = setup(t)
    fs.writeFileSync(settingsFile, content)
    const store = open()
    assert.deepEqual(store.settings(), { version: 1, sites: {} })
    assert.equal(store.readOnly, false)

    const aside = fs.readdirSync(dir).filter((f) => /^settings\.json\.corrupt-\d+$/.test(f))
    assert.equal(aside.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, aside[0]!), "utf8"), content, "kept byte for byte")
    assert.equal(fs.existsSync(settingsFile), false)
    assert.equal(logs.length, 1)
    assert.equal(logs[0]!.level, "warn")
    assert.equal((logs[0]!.data as { file: string }).file, settingsFile)
    assert.ok((logs[0]!.data as { reason: string }).reason)

    // Life goes on: the next save writes a good file beside the kept one.
    store.update((s) => (s.lastUrl = "http://x/"))
    store.flush()
    assert.deepEqual(readJSON(settingsFile), { version: 1, sites: {}, lastUrl: "http://x/" })
    assert.equal(fs.readFileSync(path.join(dir, aside[0]!), "utf8"), content)
  })

test("settings from a newer bicycle 42: left alone, never written, changes kept in memory", (t) => {
  const { dir, open, logs, settingsFile } = setup(t)
  const content = '{"version":2,"sites":{"http://x":{"folder":"/new/shape"}},"future":true}'
  fs.writeFileSync(settingsFile, content)
  const store = open()
  assert.equal(store.readOnly, true)
  assert.deepEqual(store.settings(), { version: 1, sites: {} }, "a shape we don't know is not read as ours")
  assert.deepEqual(logs.map((l) => [l.level, l.msg]), [["error", "store: settings.json was written by a newer bicycle 42 (version 2); this version won't change it"]])

  store.update((s) => (s.lastUrl = "http://x/"))
  store.saveReview(ORIGIN, { version: 1, notes: [] })
  store.flush()
  store.flush()
  assert.equal(store.settings().lastUrl, "http://x/", "usable for this run")
  assert.equal(fs.readFileSync(settingsFile, "utf8"), content, "byte for byte")
  assert.deepEqual(fs.readdirSync(dir).sort(), ["reviews", "settings.json"], "not moved aside either; other files still save")
  assert.equal(logs.length, 1, "said once, not on every save")
})

test("a review from a newer bicycle 42: left alone, this run's notes stay in memory", (t) => {
  const { open, logs, reviews } = setup(t)
  fs.mkdirSync(reviews)
  const file = path.join(reviews, "http%3A%2F%2Flocalhost%3A3000.json")
  const content = '{"version":3,"threads":[]}'
  fs.writeFileSync(file, content)
  const store = open()
  assert.equal(store.readOnly, false, "nothing newer met yet")
  assert.equal(store.loadReview(ORIGIN), undefined)
  assert.equal(store.readOnly, true)
  assert.match(logs[0]!.msg, /http%3A%2F%2Flocalhost%3A3000\.json was written by a newer bicycle 42 \(version 3\); this version won't change it/)
  assert.equal(logs[0]!.level, "error")

  store.saveReview(ORIGIN, { version: 1, notes: ["mine"] })
  store.saveReview("http://other", { version: 1, notes: [] })
  store.update((s) => (s.lastUrl = "http://x/"))
  store.flush()
  assert.deepEqual(store.loadReview(ORIGIN), { version: 1, notes: ["mine"] })
  assert.equal(fs.readFileSync(file, "utf8"), content)
  assert.deepEqual(fs.readdirSync(reviews).sort(), ["http%3A%2F%2Flocalhost%3A3000.json", "http%3A%2F%2Fother.json"])
  assert.equal(open().settings().lastUrl, "http://x/", "settings are a different file and still save")
  assert.equal(logs.length, 1, "said once, not on every save")
})

test("settings without sites get an empty list", (t) => {
  const { open, settingsFile, logs } = setup(t)
  fs.writeFileSync(settingsFile, '{"version":1,"lastUrl":"http://x/","sites":null}')
  assert.deepEqual(open().settings(), { version: 1, lastUrl: "http://x/", sites: {} })
  assert.deepEqual(logs, [])
})

test("a broken review file is moved aside and the site starts fresh", (t) => {
  const { open, logs, reviews } = setup(t)
  fs.mkdirSync(reviews)
  const file = path.join(reviews, "http%3A%2F%2Flocalhost%3A3000.json")
  for (const content of ["{{{", '{"version":0,"notes":[]}']) {
    fs.writeFileSync(file, content)
    const store = open()
    assert.equal(store.loadReview(ORIGIN), undefined)
    assert.equal(fs.existsSync(file), false)
    store.saveReview(ORIGIN, { version: 1, notes: [] })
    store.flush()
    fs.rmSync(file)
  }
  const aside = fs.readdirSync(reviews).filter((f) => f.includes(".corrupt-"))
  assert.ok(aside.length >= 1)
  assert.deepEqual(logs.map((l) => l.level), ["warn", "warn"])
})

test("a file that can't be read at all is reported and left alone", (t) => {
  const { open, logs, settingsFile } = setup(t)
  fs.mkdirSync(settingsFile) // a directory where the file should be
  const store = open()
  assert.deepEqual(store.settings(), { version: 1, sites: {} })
  assert.equal(logs[0]?.level, "error")
  assert.equal(fs.statSync(settingsFile).isDirectory(), true)
  // And a save that can't land is reported too, not thrown.
  store.update((s) => (s.lastUrl = "http://x/"))
  store.flush()
  assert.equal(logs.at(-1)?.level, "error")
  assert.match(logs.at(-1)!.msg, /save failed/)
  assert.deepEqual(fs.readdirSync(path.dirname(settingsFile)), ["settings.json"], "no temp file left behind")
})

test("a save that failed is tried again with the next flush", (t) => {
  const { open, logs, reviews } = setup(t)
  const store = open()
  fs.writeFileSync(reviews, "in the way") // reviews/ can't be created
  store.saveReview(ORIGIN, { version: 1, n: 1 })
  store.flush()
  assert.equal(logs.at(-1)?.level, "error")
  fs.rmSync(reviews)
  store.flush()
  assert.deepEqual(open().loadReview(ORIGIN), { version: 1, n: 1 })
})

test("saves are debounced: many changes, one write of the last state", async (t) => {
  const { open, settingsFile, reviews } = setup(t)
  const store = open(40)
  const file = path.join(reviews, "http%3A%2F%2Flocalhost%3A3000.json")
  for (let i = 1; i <= 50; i++) {
    store.saveReview(ORIGIN, { version: 1, i })
    store.update((s) => (s.lastUrl = `http://x/${i}`))
  }
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(settingsFile), false)
  await sleep(120)
  assert.deepEqual(readJSON(file), { version: 1, i: 50 })
  assert.equal(readJSON(settingsFile).lastUrl, "http://x/50")

  // Later changes start a new wait.
  const written = fs.statSync(file).mtimeMs
  store.saveReview(ORIGIN, { version: 1, i: 51 })
  assert.equal(fs.statSync(file).mtimeMs, written)
  await sleep(120)
  assert.deepEqual(readJSON(file), { version: 1, i: 51 })
})

test("steady changes don't push the save back forever", async (t) => {
  const { open, settingsFile } = setup(t)
  const store = open(50)
  const t0 = Date.now()
  while (Date.now() - t0 < 200 && !fs.existsSync(settingsFile)) {
    store.update((s) => (s.lastUrl = `http://x/${Date.now()}`))
    await sleep(10)
  }
  assert.equal(fs.existsSync(settingsFile), true, "written while changes kept coming")
  store.flush()
})

test("flush writes at once and cancels the pending timer", async (t) => {
  const { open, reviews } = setup(t)
  const store = open(40)
  const file = path.join(reviews, "http%3A%2F%2Flocalhost%3A3000.json")
  store.saveReview(ORIGIN, { version: 1, i: 1 })
  store.flush()
  assert.deepEqual(readJSON(file), { version: 1, i: 1 })
  const written = fs.statSync(file).mtimeMs
  await sleep(100)
  assert.equal(fs.statSync(file).mtimeMs, written, "not written a second time")
})

test("a write replaces the file whole: readers see the old one or the new one", (t) => {
  const { dir, open, settingsFile, reviews } = setup(t)
  const store = open()
  store.update((s) => (s.lastUrl = "http://old/"))
  store.saveReview(ORIGIN, { version: 1, text: "old" })
  store.flush()
  const file = path.join(reviews, "http%3A%2F%2Flocalhost%3A3000.json")
  const inode = fs.statSync(file).ino

  // Watch every rename and write the store makes: the real file name must only ever appear as
  // the target of a rename from a finished temp file, never be opened for writing.
  const opened: string[] = []
  const renamed: Array<[string, string, string]> = []
  const realOpen = fs.openSync
  const realRename = fs.renameSync
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => (opened.push(String(args[0])), realOpen(...args)))
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    // At the moment of the swap: the temp file is complete, the real one still the old version.
    renamed.push([from, to, fs.readFileSync(from, "utf8")])
    assert.ok(readJSON(to).lastUrl === "http://old/" || readJSON(to).text === "old")
    realRename(from, to)
  })
  store.update((s) => (s.lastUrl = "http://new/"))
  store.saveReview(ORIGIN, { version: 1, text: "new ".repeat(50_000) })
  store.flush()
  t.mock.restoreAll()

  assert.equal(opened.includes(settingsFile), false)
  assert.equal(opened.includes(file), false)
  assert.deepEqual(renamed.map(([, to]) => to).sort(), [file, settingsFile].sort())
  for (const [from, , content] of renamed) {
    assert.match(path.basename(from), /\.tmp-\d+$/)
    assert.doesNotThrow(() => JSON.parse(content), "the temp file was complete before the swap")
  }
  assert.notEqual(fs.statSync(file).ino, inode, "a new file took the name; the old one was never edited")
  assert.equal(readJSON(settingsFile).lastUrl, "http://new/")
  assert.equal(readJSON(file).text.length, 200_000)
  const leftovers = [...fs.readdirSync(dir), ...fs.readdirSync(reviews)].filter((f) => f.includes(".tmp-"))
  assert.deepEqual(leftovers, [])
})

test("a temp file left by a crash is ignored", (t) => {
  const { open, settingsFile } = setup(t)
  const store = open()
  store.update((s) => (s.lastUrl = "http://x/"))
  store.flush()
  fs.writeFileSync(`${settingsFile}.tmp-99999`, '{"version":1,"sit')
  assert.equal(open().settings().lastUrl, "http://x/")
})
