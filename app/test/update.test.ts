// The updater (src/main/update.ts), in plain Node with a fake fetch and a temp directory.
//
//   node scripts/build.mjs --tests && node --test dist/test/update.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { createCore } from "../src/main/core"
import { bundleOf, cannotReplace, compareVersions, createUpdater, parseManifest, SWAP_SCRIPT, wordsOf, type Outcome } from "../src/main/update"
import type { AppState, UpdateInfo } from "../src/shared/types"

const SHA = "a".repeat(64)

test("versions compare numerically, a prerelease before its release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1)
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0)
  assert.equal(compareVersions("1.2.3-preview.2", "1.2.3"), -1)
  assert.equal(compareVersions("1.2.3-preview.10", "1.2.3-preview.9"), 1)
  assert.equal(compareVersions("1.2", "1.2.1"), -1)
})

test("a prerelease with more than one dash is compared, and taken from a manifest, whole", () => {
  assert.equal(compareVersions("1.0.0-beta-2", "1.0.0-beta-1"), 1)
  assert.equal(compareVersions("1.0.0-beta-10", "1.0.0-beta-9"), 1)
  assert.equal(compareVersions("1.0.0-beta-2", "1.0.0"), -1)
  assert.equal(parseManifest({ version: "v1.0.0-beta-2", url: "https://x/a.zip", sha256: SHA })?.version, "1.0.0-beta-2")
  // It names a folder: nothing in it may lead elsewhere.
  assert.equal(parseManifest({ version: "1.0.0-/../../x", url: "https://x/a.zip", sha256: SHA }), undefined)
})

test("a manifest needs a version, an http(s) url and a sha256", () => {
  assert.deepEqual(parseManifest({ version: "v0.2.0", url: "https://x/a.zip", sha256: SHA.toUpperCase() }), {
    version: "0.2.0",
    url: "https://x/a.zip",
    sha256: SHA,
  })
  assert.equal(parseManifest({ version: "latest", url: "https://x/a.zip", sha256: SHA }), undefined)
  assert.equal(parseManifest({ version: "0.2.0", url: "file:///etc/passwd", sha256: SHA }), undefined)
  assert.equal(parseManifest({ version: "0.2.0", url: "https://x/a.zip", sha256: "abc" }), undefined)
  assert.equal(parseManifest(null), undefined)
})

test("the bundle is found from the executable inside it", () => {
  assert.equal(bundleOf("/Applications/Bicycle42.app/Contents/MacOS/Bicycle42"), "/Applications/Bicycle42.app")
  assert.equal(bundleOf("/usr/local/bin/electron"), undefined)
  assert.match(cannotReplace("/private/var/folders/x/AppTranslocation/y/d/Bicycle42.app") ?? "", /translocated/)
  assert.match(cannotReplace(undefined) ?? "", /bundle/)
})

function setup(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-update-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = []
  const fetch = (async (url: string) => {
    calls.push(url)
    const route = routes[url]
    return route ? route() : new Response("not found", { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const manifest = (version: string, sha256 = SHA) => () => Response.json({ version, url: "https://dl/app.zip", sha256 })

test("the same or an older version is no update, and nothing is downloaded", async (t) => {
  const root = setup(t)
  const { fetch, calls } = fakeFetch({ "https://m/latest.json": manifest("0.1.0") })
  const updater = createUpdater({ current: "0.1.0", manifestUrl: "https://m/latest.json", bundle: undefined, dir: path.join(root, "u"), log: () => {}, onChange: () => {}, fetch })
  t.after(() => updater.dispose())
  assert.equal(await updater.check(), undefined)
  assert.equal(updater.state(), undefined)
  assert.deepEqual(calls, ["https://m/latest.json"])
})

test("a copy that can't replace itself offers the release page instead of downloading", async (t) => {
  const root = setup(t)
  const { fetch, calls } = fakeFetch({ "https://m/latest.json": manifest("0.2.0") })
  const updater = createUpdater({ current: "0.1.0", manifestUrl: "https://m/latest.json", bundle: undefined, dir: path.join(root, "u"), log: () => {}, onChange: () => {}, fetch })
  t.after(() => updater.dispose())
  assert.equal(await updater.check(), "0.2.0")
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "manual" })
  assert.equal(calls.includes("https://dl/app.zip"), false)
  await assert.rejects(updater.install(), /No update/)
})

test("a download whose hash doesn't match is not installed", async (t) => {
  const root = setup(t)
  const bundle = path.join(root, "Apps", "Bicycle42.app")
  fs.mkdirSync(bundle, { recursive: true })
  const { fetch } = fakeFetch({ "https://m/latest.json": manifest("0.2.0"), "https://dl/app.zip": () => new Response("not the zip") })
  const updater = createUpdater({ current: "0.1.0", manifestUrl: "https://m/latest.json", bundle, dir: path.join(root, "u"), log: () => {}, onChange: () => {}, fetch })
  t.after(() => updater.dispose())
  await updater.check()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "failed" })
  await assert.rejects(updater.install(), /No update/)
})

// ── staging, off a Mac: ditto and codesign stood in for ──────────────────────────────────────────

const ZIP = "the zip"
const ZIP_SHA = createHash("sha256").update(ZIP).digest("hex")

/** Where an updater runs: its folder, the bundle it would replace, and its stand-in tools.
 *  `bad`: the versions codesign refuses. */
function place(t: { after(fn: () => void): void }) {
  const root = setup(t)
  const bundle = path.join(root, "Apps", "Bicycle42.app")
  fs.mkdirSync(bundle, { recursive: true })
  const dir = path.join(root, "u")
  const bad = new Set<string>()
  const verified: string[] = []
  const tools = {
    async unpack(zip: string, into: string) {
      assert.ok(fs.existsSync(zip))
      fs.mkdirSync(path.join(into, "Bicycle42.app", "Contents"), { recursive: true })
    },
    async verify(app: string) {
      assert.ok(fs.existsSync(path.join(app, "Contents")))
      verified.push(path.relative(dir, app))
      for (const v of bad) if (app.includes(`${path.sep}${v}${path.sep}`)) throw new Error("a sealed resource is missing or invalid")
    },
  }
  const start = (routes: Parameters<typeof fakeFetch>[0], opts: Partial<Parameters<typeof createUpdater>[0]> = {}) => {
    const { fetch, calls } = fakeFetch(routes)
    const updater = createUpdater({ current: "0.1.0", manifestUrl: "https://m/latest.json", bundle, dir, log: () => {}, onChange: () => {}, fetch, ...tools, ...opts })
    t.after(() => updater.dispose())
    const told: Outcome[] = []
    return { updater, calls, told, asked: () => updater.check((o) => told.push(o)) }
  }
  /** A release an earlier run staged. */
  const stage = (version: string) => fs.mkdirSync(path.join(dir, version, "unpacked", "Bicycle42.app", "Contents"), { recursive: true })
  return { dir, bundle, bad, verified, start, stage, has: () => fs.readdirSync(dir).sort() }
}
const good = (version: string) => ({ "https://m/latest.json": manifest(version, ZIP_SHA), "https://dl/app.zip": () => new Response(ZIP) })
const offline = { "https://m/latest.json": () => new Response("", { status: 503 }) }
const until = async (what: () => unknown) => {
  for (let i = 0; i < 400 && !what(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(what())
}

test("a release whose hash matches is verified, staged under its version and offered", async (t) => {
  const p = place(t)
  const { updater } = p.start(good("0.2.0"))
  assert.equal(await updater.check(), "0.2.0")
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "ready" })
  assert.deepEqual(p.has(), ["0.2.0"])
  assert.deepEqual(p.verified, [path.join("download", "unpacked", "Bicycle42.app")])
  assert.equal(fs.existsSync(path.join(p.dir, "0.2.0", "update.zip")), false)
})

test("a staged release outlives a quit: verified again and offered at the next start, with no network", async (t) => {
  const p = place(t)
  await p.start(good("0.2.0")).updater.check()
  p.verified.length = 0
  let changes = 0
  const next = p.start(offline, { onChange: () => void changes++ })
  await until(() => next.updater.state())
  assert.deepEqual(next.updater.state(), { version: "0.2.0", status: "ready" })
  assert.equal(changes, 1)
  assert.deepEqual(p.verified, [path.join("0.2.0", "unpacked", "Bicycle42.app")])
  // …and it is not downloaded again.
  const third = p.start(good("0.2.0"))
  await third.asked()
  assert.deepEqual(third.told, [{ status: "ready", version: "0.2.0" }])
  assert.equal(third.calls.includes("https://dl/app.zip"), false)
})

test("at a start, only the newest release staged that still verifies is kept", async (t) => {
  const p = place(t)
  for (const v of ["0.0.9", "0.1.0", "0.2.0", "0.3.0", "0.10.0"]) p.stage(v)
  // A download the last run did not finish, the swap's script, a release with no app in it.
  fs.mkdirSync(path.join(p.dir, "download", "unpacked", "Bicycle42.app"), { recursive: true })
  fs.writeFileSync(path.join(p.dir, "download", "update.zip"), "half")
  fs.writeFileSync(path.join(p.dir, "swap.sh"), "")
  fs.mkdirSync(path.join(p.dir, "0.11.0", "unpacked"), { recursive: true })
  p.bad.add("0.10.0")
  const { updater } = p.start(offline)
  await assert.rejects(updater.check(), /HTTP 503/)
  assert.deepEqual(updater.state(), { version: "0.3.0", status: "ready" })
  assert.deepEqual(p.has(), ["0.3.0"])
})

test("a staged release that this copy can't put in place is kept, and not offered as ready", async (t) => {
  const p = place(t)
  p.stage("0.2.0")
  const { updater, told, asked } = p.start(good("0.2.0"), { bundle: undefined })
  await asked()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "manual" })
  assert.deepEqual(told, [{ status: "manual", version: "0.2.0", reason: "not running from an app bundle" }])
  assert.deepEqual(p.has(), ["0.2.0"])
  await assert.rejects(updater.install(), /No update/)
})

test("a newer version whose download fails leaves the staged one on offer, and is tried again", async (t) => {
  const p = place(t)
  p.stage("0.2.0")
  let up = false
  const { updater, told, asked } = p.start({ "https://m/latest.json": manifest("0.3.0", ZIP_SHA), "https://dl/app.zip": () => (up ? new Response(ZIP) : new Response("", { status: 500 })) })
  await asked()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "ready" })
  assert.deepEqual(told, [{ status: "downloading", version: "0.3.0" }, { status: "failed", version: "0.3.0", reason: "download failed: HTTP 500" }])
  up = true
  await updater.check()
  assert.deepEqual(updater.state(), { version: "0.3.0", status: "ready" })
})

test("whoever asked hears every outcome, of a download already under way too", async (t) => {
  const p = place(t)
  const latest = p.start(good("0.1.0"))
  await latest.asked()
  assert.deepEqual(latest.told, [{ status: "latest" }])

  const down = p.start(offline)
  await assert.rejects(down.asked())
  assert.deepEqual(down.told, [{ status: "failed", reason: "update check failed: HTTP 503" }])

  let go = () => {}
  const held = new Promise<void>((r) => (go = r))
  let unpacking = false
  const one = p.start(good("0.2.0"), {
    async unpack(_zip, into) {
      unpacking = true
      await held
      fs.mkdirSync(path.join(into, "Bicycle42.app", "Contents"), { recursive: true })
    },
  })
  // The app's own check began it; the menu asks in the middle.
  const own = one.updater.check()
  await until(() => unpacking)
  const asked = one.asked()
  assert.deepEqual(one.told, [{ status: "downloading", version: "0.2.0" }])
  go()
  await Promise.all([own, asked])
  assert.deepEqual(one.told, [{ status: "downloading", version: "0.2.0" }, { status: "ready", version: "0.2.0" }])
  assert.equal(one.calls.filter((c) => c === "https://dl/app.zip").length, 1)
})

test("each outcome has words, and a failure its reason", () => {
  assert.match(wordsOf({ status: "latest" }, "0.1.0").detail, /0\.1\.0 is the latest/)
  assert.match(wordsOf({ status: "downloading", version: "0.2.0" }, "0.1.0").message, /Downloading .*0\.2\.0/)
  assert.equal(wordsOf({ status: "ready", version: "0.2.0" }, "0.1.0").act, "Restart to Update")
  assert.match(wordsOf({ status: "manual", version: "0.2.0", reason: "/Applications is not writable" }, "0.1.0").detail, /not writable/)
  assert.deepEqual(wordsOf({ status: "failed", reason: "HTTP 503" }, "0.1.0"), { type: "warning", message: "Couldn't check for updates", detail: "HTTP 503" })
  assert.match(wordsOf({ status: "failed", version: "0.2.0", reason: "x" }, "0.1.0").message, /0\.2\.0 could not be downloaded/)
})

// ── a server that goes quiet (a real one: the aborts go through the real fetch) ──────────────────

async function server(t: { after(fn: () => void): void }, answer: http.RequestListener) {
  const s = http.createServer(answer)
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  t.after(() => (s.closeAllConnections(), void s.close()))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

test("a manifest that never comes ends the check, and the next one gets through", async (t) => {
  const p = place(t)
  let quiet = true
  const url = await server(t, (_req, res) => void (quiet ? undefined : res.end(JSON.stringify({ version: "0.1.0", url: "https://dl/app.zip", sha256: SHA }))))
  const { updater, told, asked } = p.start({}, { fetch, manifestUrl: url, manifestMs: 100 })
  await assert.rejects(asked(), /no answer in 0\.1 seconds/)
  assert.deepEqual(told, [{ status: "failed", reason: "update check failed: no answer in 0.1 seconds" }])
  quiet = false
  assert.equal(await updater.check(), undefined)
})

test("a download that stops coming is given up; a slow one that still comes is not", async (t) => {
  const p = place(t)
  let slow = false
  const url: string = await server(t, (req, res) => {
    if (req.url === "/latest.json") return void res.end(JSON.stringify({ version: "0.2.0", url: `${url}/app.zip`, sha256: ZIP_SHA }))
    const letters = [...ZIP]
    const next = () => {
      const c = letters.shift()
      if (c === undefined) return void res.end()
      res.write(c)
      // Stalled, it is one byte and no more; slow, one each 60 ms: 420 ms in all.
      if (slow) setTimeout(next, 60)
    }
    next()
  })
  const { updater, told, asked } = p.start({}, { fetch, manifestUrl: `${url}/latest.json`, stallMs: 300 })
  await asked()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "failed" })
  assert.deepEqual(told[1], { status: "failed", version: "0.2.0", reason: "the download stalled: nothing came for 0.3 seconds" })
  slow = true
  await updater.check()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "ready" })
})

// ── the swap, the window ─────────────────────────────────────────────────────────────────────────

test("the swap leaves everything as it is when the app doesn't quit", { skip: process.platform === "win32" }, (t) => {
  const root = setup(t)
  const script = path.join(root, "swap.sh")
  fs.writeFileSync(script, SWAP_SCRIPT.replace(/^open .*$/m, ":"))
  const target = path.join(root, "Bicycle42.app")
  const staged = path.join(root, "staged.app")
  for (const [dir, v] of [[target, "old"], [staged, "new"]] as const) {
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "v"), v)
  }
  // This process is the app: still here when the wait (two fifths of a second) is over.
  assert.throws(() => execFileSync("/bin/sh", [script, String(process.pid), target, staged, "2"], { stdio: "ignore" }))
  assert.equal(fs.readFileSync(path.join(target, "v"), "utf8"), "old")
  assert.equal(fs.readFileSync(path.join(staged, "v"), "utf8"), "new")
  assert.equal(fs.existsSync(`${target}.previous`), false)
})

test("the window is told of an update, and its button reaches the shell", async (t) => {
  const root = setup(t)
  const states: AppState[] = []
  let update: UpdateInfo | undefined
  let installs = 0
  const host = { dataDir: path.join(root, "data"), emit: (stream: string, value: unknown) => void (stream === "state" && states.push(value as AppState)), dialog() {}, saveDialog: async () => undefined, log() {} }
  const core = createCore({ ...host, update: () => update, installUpdate: async () => void installs++ })
  t.after(() => core.dispose())
  assert.equal("update" in core.snapshot(), false)
  update = { version: "0.2.0", status: "ready" }
  core.refresh()
  await until(() => states.length)
  assert.deepEqual(states.at(-1)!.update, update)
  await core.invoke("installUpdate", [])
  assert.equal(installs, 1)
  const plain = createCore({ ...host, dataDir: path.join(root, "other") })
  t.after(() => plain.dispose())
  await assert.rejects(plain.invoke("installUpdate", []), /does not update itself/)
})

test("the swap script puts the new bundle in place and keeps the old one when it can't", { skip: process.platform !== "darwin" }, (t) => {
  const root = setup(t)
  const script = path.join(root, "swap.sh")
  fs.writeFileSync(script, SWAP_SCRIPT.replace(/^open .*$/m, ":"))
  const target = path.join(root, "Bicycle42.app")
  const staged = path.join(root, "staged.app")
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, "v"), "old")
  fs.mkdirSync(staged)
  fs.writeFileSync(path.join(staged, "v"), "new")
  const run = (from: string) => execFileSync("/bin/sh", [script, "999999", target, from], { stdio: "ignore" })
  run(staged)
  assert.equal(fs.readFileSync(path.join(target, "v"), "utf8"), "new")
  assert.equal(fs.existsSync(`${target}.previous`), false)
  run(path.join(root, "missing.app"))
  assert.equal(fs.readFileSync(path.join(target, "v"), "utf8"), "new")
})

test("a real zip with a matching hash is unpacked, verified and staged", { skip: process.platform !== "darwin" }, async (t) => {
  const root = setup(t)
  const app = path.join(root, "src", "Bicycle42.app")
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true })
  fs.copyFileSync("/usr/bin/true", path.join(app, "Contents", "MacOS", "Bicycle42"))
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Bicycle42</string><key>CFBundleIdentifier</key><string>test.bicycle42</string></dict></plist>`,
  )
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" })
  const zip = path.join(root, "app.zip")
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip])
  const bytes = fs.readFileSync(zip)
  const sha = createHash("sha256").update(bytes).digest("hex")
  const bundle = path.join(root, "Apps", "Bicycle42.app")
  fs.mkdirSync(bundle, { recursive: true })
  const { fetch } = fakeFetch({ "https://m/latest.json": manifest("0.2.0", sha), "https://dl/app.zip": () => new Response(bytes) })
  const updater = createUpdater({ current: "0.1.0", manifestUrl: "https://m/latest.json", bundle, dir: path.join(root, "u"), log: () => {}, onChange: () => {}, fetch })
  t.after(() => updater.dispose())
  await updater.check()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "ready" })
  assert.ok(fs.existsSync(path.join(root, "u", "0.2.0", "unpacked", "Bicycle42.app", "Contents", "Info.plist")))
})
