// The calls every version of the helper answers alike (src/shared/wire.ts LIFECYCLE), across two
// versions of it on one computer, through the fake ssh and the real helper bundle: after an
// update, the new version's helper ends what an earlier run of the same install left with the old
// version's (endOwner), and nothing of another install's or of a later run's; a helper from before
// endOwner is let be.
//
//   node scripts/build.mjs --tests && node --test dist/test/lifecycle.test.cjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { test } from "node:test"
import { connectSsh, sshTiming } from "../src/main/ssh"
import { lineReader } from "../src/shared/wire"
import { fakeHost, until } from "./ssh-fixture"

sshTiming.retryMin = 100
sshTiming.retryMax = 300

const bundle = () => path.join(__dirname, "..", "helper.cjs")

/** A connection to a helper's socket: calls, answered. */
function rpc(socket: string) {
  const s = net.connect(socket)
  const waiting = new Map<number, (m: { result?: unknown; error?: { code?: string } }) => void>()
  const lines = lineReader({ line: (t) => {
    const m = JSON.parse(t) as { id?: number }
    if (m.id !== undefined) waiting.get(m.id)?.(m as never)
  }, tooLong: () => undefined })
  s.on("data", (d: Buffer) => lines.push(d))
  let id = 0
  return {
    call: <T>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        const n = ++id
        waiting.set(n, (m) => (m.error ? reject(Object.assign(new Error(JSON.stringify(m.error)), m.error)) : resolve(m.result as T)))
        s.write(`${JSON.stringify({ id: n, method, params })}\n`)
      }),
    close: () => s.destroy(),
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("after an update, the earlier version's helper ends what the install's earlier run left with it; another install's and a later run's stay; a helper older than endOwner is let be", async () => {
  const h = fakeHost()
  const OWNER = "0123456789abcdef"
  const dir = path.join(h.home, ".bicycle42")
  const pids: number[] = []
  try {
    // This install's id, as the app keeps it.
    fs.mkdirSync(path.join(h.data, "ssh"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(h.data, "ssh", "owner"), OWNER, { mode: 0o600 })
    // Version aaaa of the helper: the one the app had before its update, running.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.copyFileSync(bundle(), path.join(dir, "helper-aaaa.js"))
    assert.match(execFileSync(process.execPath, [path.join(dir, "helper-aaaa.js"), "daemon"], { env: { ...process.env, HOME: h.home }, encoding: "utf8" }), /^B42 READY$/m)
    const a = rpc(path.join(dir, "helper-aaaa.sock"))
    await a.call("hello", { owner: OWNER, launch: 1000 })
    /** A process that says its pid, then waits. */
    const start = async (owner: string, launch: number) => {
      const file = path.join(h.root, `pid-${owner}-${launch}`)
      const { hid } = await a.call<{ hid: string }>("spawn", { program: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1e6)`], owner, launch })
      await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").length > 0)
      const pid = Number(fs.readFileSync(file, "utf8"))
      pids.push(pid)
      return { hid, pid }
    }
    const left = await start(OWNER, 1000)
    const another = await start("fedcba9876543210", 1000)
    const later = await start(OWNER, 3000)
    // The app quits (or crashes) with its agent there, and is updated.
    a.close()
    // A helper from before endOwner there too: it answers nothing of it.
    const asked: string[] = []
    const old = net.createServer((s) => {
      const lines = lineReader({ line: (t) => {
        const m = JSON.parse(t) as { id: number; method: string }
        asked.push(m.method)
        s.write(`${JSON.stringify({ id: m.id, error: { message: `no such call: ${m.method}`, code: "ENOSYS" } })}\n`)
      }, tooLong: () => undefined })
      s.on("data", (d: Buffer) => lines.push(d))
    })
    await new Promise<void>((r) => old.listen(path.join(dir, "helper-old0.sock"), r))
    try {
      // The updated app (its helper is another version) starts its run 2000 and connects.
      const m = await connectSsh({ host: "dev-box", dataDir: h.data, launch: 2000 })
      try {
        await until(() => !alive(left.pid))
        const b = rpc(path.join(dir, "helper-aaaa.sock"))
        const listed = async () => (await b.call<{ procs: Array<{ hid: string }> }>("hello", {})).procs.map((p) => p.hid).sort().join(" ")
        // Forgotten once its output has closed, a moment after it is gone.
        await until(async () => (await listed()) === [another.hid, later.hid].sort().join(" ")).catch(async () => assert.fail(`the earlier run's is ended and forgotten, the others stay: ${await listed()}`))
        b.close()
        assert.ok(alive(another.pid) && alive(later.pid))
        assert.deepEqual(asked, ["endOwner"])
        await until(() => /version old0's helper is older than endOwner/.test(fs.readFileSync(path.join(dir, "helper.log"), "utf8")))
        // Once per run: attaching again asks nothing more.
        await m.close()
        const again = await connectSsh({ host: "dev-box", dataDir: h.data, launch: 2000 })
        await again.close()
        assert.deepEqual(asked, ["endOwner"])
      } finally {
        await m.close()
      }
    } finally {
      old.close()
    }
  } finally {
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    }
    await h.end()
  }
})

test("endOwner's params are checked, and an install's processes are its own to end", async () => {
  const h = fakeHost()
  const dir = path.join(h.home, ".bicycle42")
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.copyFileSync(bundle(), path.join(dir, "helper-cccc.js"))
    execFileSync(process.execPath, [path.join(dir, "helper-cccc.js"), "daemon"], { env: { ...process.env, HOME: h.home }, encoding: "utf8" })
    const c = rpc(path.join(dir, "helper-cccc.sock"))
    await assert.rejects(c.call("endOwner", { owner: "x" }), (e: { code?: string }) => e.code === "EINVAL")
    await assert.rejects(c.call("endOwner", { owner: 1, before: 1 }), (e: { code?: string }) => e.code === "EINVAL")
    assert.deepEqual(await c.call("endOwner", { owner: "nobody", before: Date.now() }), { ended: 0 })
    c.close()
  } finally {
    await h.end()
  }
})
