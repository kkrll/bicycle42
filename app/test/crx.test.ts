// Opening an extension's .crx as the store hands it out (src/main/crx.ts): the signature checked,
// the zip taken apart, the manifest made fit for Electron. With .crx files made here (crx-fixture.ts).
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fitManifest, openCrx, unpackCrx, unzip } from "../src/main/crx"
import { makeCrx, makeZip } from "./crx-fixture"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-crx-"))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const MANIFEST = { manifest_version: 3, name: "Test", version: "1.2.3", permissions: ["storage"], optional_permissions: ["clipboardWrite", "https://*/*"], optional_host_permissions: ["<all_urls>"] }

test("a signed .crx opens: its id, its key, its zip", () => {
  const zip = makeZip({ "manifest.json": JSON.stringify(MANIFEST), "bg.js": "1" })
  const made = makeCrx(zip)
  const crx = openCrx(made.crx, made.id)
  assert.equal(crx.id, made.id)
  assert.deepEqual(crx.zip, zip)
  assert.equal(crx.key, made.key.publicKey.export({ type: "spki", format: "der" }).toString("base64"))
})

test("a .crx is refused when it is another extension, changed, or not one at all", () => {
  const made = makeCrx(makeZip({ "manifest.json": "{}" }))
  assert.throws(() => openCrx(made.crx, "a".repeat(32)), /not the one asked for/)
  const changed = Buffer.from(made.crx)
  changed[changed.length - 30]! ^= 1
  assert.throws(() => openCrx(changed, made.id), /signature does not hold|damaged/)
  assert.throws(() => openCrx(Buffer.from("PK\x03\x04 not a crx")), /not a Chrome extension/)
  // Another extension's header, with this one's zip: its signature is not over this zip.
  const other = makeCrx(makeZip({ "manifest.json": "{\"other\":1}" }))
  const swapped = Buffer.concat([other.crx.subarray(0, 12 + other.crx.readUInt32LE(8)), made.crx.subarray(12 + made.crx.readUInt32LE(8))])
  assert.throws(() => openCrx(swapped, other.id), /signature does not hold/)
})

test("a zip's files, stored or deflated; a path out of the folder refused", () => {
  for (const deflate of [false, true]) {
    const files = unzip(makeZip({ "a.txt": "hello", "js/b.js": "x".repeat(5000), "dir/": "" }, deflate))
    assert.equal(files.get("a.txt")?.toString(), "hello")
    assert.equal(files.get("js/b.js")?.length, 5000)
    assert.equal(files.has("dir/"), false)
  }
  assert.throws(() => unzip(makeZip({ "../evil.js": "1" })), /not allowed/)
  assert.throws(() => unzip(makeZip({ "/etc/evil": "1" })), /not allowed/)
  assert.throws(() => unzip(Buffer.from("nothing")), /damaged/)
})

test("the manifest: the key kept, host access up front, optional permissions granted", () => {
  const fit = fitManifest(MANIFEST, "KEY")
  assert.equal(fit.key, "KEY")
  assert.deepEqual(fit.host_permissions, ["<all_urls>"])
  assert.deepEqual(fit.permissions, ["storage", "clipboardWrite"])
  assert.deepEqual(fit.optional_permissions, [])
  assert.deepEqual(fit.optional_host_permissions, [])
})

test("unpacked into its folder, the store's own records left out", () => {
  const made = makeCrx(makeZip({ "manifest.json": JSON.stringify(MANIFEST), "js/bg.js": "go()", "_metadata/verified_contents.json": "{}" }, true))
  const folder = path.join(ROOT, "ext")
  fs.mkdirSync(folder)
  fs.writeFileSync(path.join(folder, "stale.js"), "old")
  assert.equal(unpackCrx(openCrx(made.crx, made.id), folder), "1.2.3")
  assert.equal(fs.readFileSync(path.join(folder, "js/bg.js"), "utf8"), "go()")
  assert.equal(fs.existsSync(path.join(folder, "_metadata")), false)
  assert.equal(fs.existsSync(path.join(folder, "stale.js")), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")) as Record<string, unknown>
  assert.equal(typeof manifest.key, "string")
  assert.deepEqual(fs.readdirSync(ROOT), ["ext"])
})
