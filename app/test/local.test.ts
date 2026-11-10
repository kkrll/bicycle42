import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { readLocal, registrationFile } from "../src/main/local"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b42-local-"))
const write = (name: string, body: string) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

test("local server: the registration file gives the address and password", () => {
  const file = write("a.json", JSON.stringify({ id: "x", version: "2.2.6", url: "http://127.0.0.1:49374", pid: 12, password: "secret" }))
  assert.deepEqual(readLocal(file), { url: "http://127.0.0.1:49374", password: "secret" })
})

test("local server: a server without a password is still a server", () => {
  assert.deepEqual(readLocal(write("b.json", JSON.stringify({ url: "http://127.0.0.1:4096", pid: 1 }))), { url: "http://127.0.0.1:4096", password: "" })
})

test("local server: no file, broken JSON, or a file that is not a registration is no server", () => {
  assert.equal(readLocal(path.join(dir, "missing.json")), undefined)
  assert.equal(readLocal(write("c.json", "{ not json")), undefined)
  assert.equal(readLocal(write("d.json", JSON.stringify({ password: "only" }))), undefined)
  assert.equal(readLocal(write("e.json", JSON.stringify({ url: "file:///etc/passwd" }))), undefined)
  assert.equal(readLocal(write("f.json", JSON.stringify({ url: "http://127.0.0.1:1", password: 5 }))), undefined)
  assert.equal(readLocal(write("g.json", "null")), undefined)
})

test("local server: the file is looked for in the user's state folder", () => {
  assert.equal(registrationFile({ XDG_STATE_HOME: "/x/state" }), path.join("/x/state", "opencode", "service.json"))
  assert.equal(registrationFile({}), path.join(os.homedir(), ".local", "state", "opencode", "service.json"))
})
