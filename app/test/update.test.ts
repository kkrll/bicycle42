// The updater (src/main/update.ts), in plain Node with a fake fetch and a temp directory.
//
//   node scripts/build.mjs --tests && node --test dist/test/update.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundleOf, cannotReplace, compareVersions, createUpdater, parseManifest, SWAP_SCRIPT } from "../src/main/update"

const SHA = "a".repeat(64)

test("versions compare numerically, a prerelease before its release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1)
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0)
  assert.equal(compareVersions("1.2.3-preview.2", "1.2.3"), -1)
  assert.equal(compareVersions("1.2.3-preview.10", "1.2.3-preview.9"), 1)
  assert.equal(compareVersions("1.2", "1.2.1"), -1)
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
  assert.equal(bundleOf("/Applications/bicycle 42.app/Contents/MacOS/bicycle 42"), "/Applications/bicycle 42.app")
  assert.equal(bundleOf("/usr/local/bin/electron"), undefined)
  assert.match(cannotReplace("/private/var/folders/x/AppTranslocation/y/d/bicycle 42.app") ?? "", /translocated/)
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
  const bundle = path.join(root, "Apps", "bicycle 42.app")
  fs.mkdirSync(bundle, { recursive: true })
  const { fetch } = fakeFetch({ "https://m/latest.json": manifest("0.2.0"), "https://dl/app.zip": () => new Response("not the zip") })
  const updater = createUpdater({ current: "0.1.0", manifestUrl: "https://m/latest.json", bundle, dir: path.join(root, "u"), log: () => {}, onChange: () => {}, fetch })
  t.after(() => updater.dispose())
  await updater.check()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "failed" })
  await assert.rejects(updater.install(), /No update/)
})

test("the swap script puts the new bundle in place and keeps the old one when it can't", { skip: process.platform !== "darwin" }, (t) => {
  const root = setup(t)
  const script = path.join(root, "swap.sh")
  fs.writeFileSync(script, SWAP_SCRIPT.replace(/^open .*$/m, ":"))
  const target = path.join(root, "bicycle 42.app")
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
  const app = path.join(root, "src", "bicycle 42.app")
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true })
  fs.copyFileSync("/usr/bin/true", path.join(app, "Contents", "MacOS", "bicycle 42"))
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>bicycle 42</string><key>CFBundleIdentifier</key><string>test.bicycle42</string></dict></plist>`,
  )
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" })
  const zip = path.join(root, "app.zip")
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip])
  const bytes = fs.readFileSync(zip)
  const sha = createHash("sha256").update(bytes).digest("hex")
  const bundle = path.join(root, "Apps", "bicycle 42.app")
  fs.mkdirSync(bundle, { recursive: true })
  const { fetch } = fakeFetch({ "https://m/latest.json": manifest("0.2.0", sha), "https://dl/app.zip": () => new Response(bytes) })
  const updater = createUpdater({ current: "0.1.0", manifestUrl: "https://m/latest.json", bundle, dir: path.join(root, "u"), log: () => {}, onChange: () => {}, fetch })
  t.after(() => updater.dispose())
  await updater.check()
  assert.deepEqual(updater.state(), { version: "0.2.0", status: "ready" })
  assert.ok(fs.existsSync(path.join(root, "u", "0.2.0", "unpacked", "bicycle 42.app", "Contents", "Info.plist")))
})
