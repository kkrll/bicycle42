// Where an agent on another computer says its site is (src/main/site-address.ts): forwarded from
// that computer only when the address is its own loopback, read as the browser reads it.
//
//   node scripts/build.mjs --tests && node --test dist/test/site-address.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { siteAt } from "../src/main/site-address"

const on = (there: string, port: number) => ({ on: "computer", there, port })
const elsewhere = { on: "elsewhere" }

test("siteAt: the agent's computer's own loopback is forwarded from there", () => {
  assert.deepEqual(siteAt("http://localhost:3000/"), on("localhost", 3000))
  assert.deepEqual(siteAt("http://LOCALHOST:5173"), on("localhost", 5173))
  assert.deepEqual(siteAt("http://localhost.:3000/"), on("localhost", 3000))
  assert.deepEqual(siteAt("http://app.localhost:3000/"), on("127.0.0.1", 3000))
  assert.deepEqual(siteAt("http://127.0.0.1:8080/x?y=1"), on("127.0.0.1", 8080))
  assert.deepEqual(siteAt("http://127.1.2.3:8080/"), on("127.1.2.3", 8080))
  assert.deepEqual(siteAt("https://127.0.0.1/"), on("127.0.0.1", 443))
  assert.deepEqual(siteAt("http://127.0.0.1/"), on("127.0.0.1", 80))
  assert.deepEqual(siteAt("http://[::1]:4321/"), on("::1", 4321))
  assert.deepEqual(siteAt("http://[0:0:0:0:0:0:0:1]:4321/"), on("::1", 4321))
})

test("siteAt: the unspecified address a server listens on is reached on its loopback", () => {
  assert.deepEqual(siteAt("http://0.0.0.0:3000/"), on("127.0.0.1", 3000))
  assert.deepEqual(siteAt("http://[::]:3000/"), on("::1", 3000))
})

test("siteAt: an IP literal is read as an IP, however it is written", () => {
  // IPv4-mapped IPv6: the review's first bypass, now that computer's loopback like any other.
  assert.deepEqual(siteAt("http://[::ffff:127.0.0.1]:8080/"), on("127.0.0.1", 8080))
  assert.deepEqual(siteAt("http://[::ffff:7f00:1]:8080/"), on("127.0.0.1", 8080))
  assert.deepEqual(siteAt("http://[::ffff:0.0.0.0]:8080/"), on("127.0.0.1", 8080))
  // Forms the URL parser turns into 127.0.0.1.
  assert.deepEqual(siteAt("http://2130706433:3000/"), on("127.0.0.1", 3000))
  assert.deepEqual(siteAt("http://0x7f.1:3000/"), on("127.0.0.1", 3000))
  // Mapped, but not to a loopback.
  assert.deepEqual(siteAt("http://[::ffff:192.168.1.1]:8080/"), elsewhere)
  assert.deepEqual(siteAt("http://[::ffff:c0a8:101]:8080/"), elsewhere)
})

test("siteAt: anything else would load on this computer, and is not forwarded", () => {
  // The review's bypasses: a name that resolves to 127.0.0.1 here, the reviewer's own network, the web.
  assert.deepEqual(siteAt("http://localtest.me:3000/"), elsewhere)
  assert.deepEqual(siteAt("http://192.168.1.1/"), elsewhere)
  assert.deepEqual(siteAt("https://evil.example/"), elsewhere)
  // Names that only look like a loopback.
  assert.deepEqual(siteAt("http://127.0.0.1.nip.io:3000/"), elsewhere)
  assert.deepEqual(siteAt("http://localhost.evil.example/"), elsewhere)
  assert.deepEqual(siteAt("http://mylocalhost:3000/"), elsewhere)
  // Other IPv6: the link-local, IPv4-compatible (deprecated, not mapped), a public one.
  assert.deepEqual(siteAt("http://[fe80::1]:3000/"), elsewhere)
  assert.deepEqual(siteAt("http://[::7f00:1]:3000/"), elsewhere)
  assert.deepEqual(siteAt("http://[2001:db8::1]/"), elsewhere)
  assert.deepEqual(siteAt("http://10.0.0.5:3000/"), elsewhere)
  // Not a web address at all.
  assert.deepEqual(siteAt("file:///etc/passwd"), elsewhere)
  assert.deepEqual(siteAt("not a url"), elsewhere)
})
