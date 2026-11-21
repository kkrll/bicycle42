// The helper's keeping of processes (src/helper/host.ts), without a socket or a real process: the
// order output reaches an app that takes a process up again, the lease that ends what no app is
// attached to, and what is kept of a process that ended while no app was.
//
//   node scripts/build.mjs --tests && node --test dist/test/helper.test.cjs
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { createHost, type Conn } from "../src/helper/host"
import type { Child, Exit, Machine } from "../src/main/machine"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A machine whose processes are stand-ins the test ends. */
function fakeMachine() {
  const made: Array<Child & { end(e: Exit): void; killed: number }> = []
  const machine = {
    spawn() {
      let end!: (e: Exit) => void
      const exited = new Promise<Exit>((r) => (end = r))
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = {
        stdin: new PassThrough(),
        stdout,
        stderr,
        exited,
        killed: 0,
        end(e: Exit) {
          stdout.end()
          stderr.end()
          end(e)
        },
        kill() {
          child.killed++
          child.end({ code: null, signal: "SIGTERM" })
          return Promise.resolve()
        },
      }
      made.push(child)
      return child
    },
  } as unknown as Machine
  return { machine, made }
}

/** A connection that keeps what it is sent, parsed. */
function conn() {
  const got: Array<Record<string, unknown>> = []
  const c: Conn & { got: typeof got } = { got, send: (m) => void got.push(JSON.parse(JSON.stringify(m))) }
  return c
}

function host(leaseMs = 60_000) {
  const { machine, made } = fakeMachine()
  let idle = 0
  const h = createHost({ machine, version: "t", log: () => {}, outMax: 1 << 20, errMax: 1 << 16, leaseMs, idle: () => void idle++, busy: () => {}, shutdown: () => {} })
  let id = 0
  /** A call, answered (each op answers within a tick or two here). */
  const call = async (c: ReturnType<typeof conn>, method: string, params: Record<string, unknown> = {}) => {
    const mine = ++id
    h.handle(c, JSON.stringify({ id: mine, method, params }))
    for (let i = 0; i < 50; i++) {
      const answer = c.got.find((m) => m.id === mine)
      if (answer) return answer.result as Record<string, unknown>
      await sleep(1)
    }
    throw new Error(`no answer to ${method}`)
  }
  return { h, made, call, idle: () => idle }
}

const data = (c: ReturnType<typeof conn>) => c.got.filter((m) => m.ev === "data").map((m) => ({ at: m.at, text: Buffer.from(String(m.data), "base64").toString() }))

test("an app takes a process up again: what was kept reaches it before anything the process says after, in the same call", async () => {
  const { h, call } = host()
  const a = conn()
  h.attach(a)
  const { hid } = (await call(a, "spawn", { program: "agent", args: [], owner: "me", launch: 1 })) as { hid: string }
  h.take(hid, 1, Buffer.from('{"answer":1}\n'))
  // The connection drops before the app read that.
  h.detach(a)
  const b = conn()
  h.attach(b)
  h.handle(b, JSON.stringify({ id: 1, method: "resume", params: { hid, out: 0, err: 0 } }))
  // The process says more at once, before anything else of the helper's runs.
  h.take(hid, 1, Buffer.from('{"next":2}\n'))
  // The app reads what is sent in order: the kept answer first, at 0, then what came after it.
  assert.deepEqual(data(b), [
    { at: 0, text: '{"answer":1}\n' },
    { at: 13, text: '{"next":2}\n' },
  ])
})

test("a process no app is attached to is ended once its lease runs out, and forgotten once it has ended; one attached again is not", async () => {
  const { h, made, call, idle } = host(80)
  const a = conn()
  h.attach(a)
  const first = (await call(a, "spawn", { program: "agent", args: [], owner: "me", launch: 1 })) as { hid: string }
  const second = (await call(a, "spawn", { program: "agent", args: [], owner: "me", launch: 1 })) as { hid: string }
  h.detach(a)
  await sleep(40)
  // The app is back for the second within the lease.
  const b = conn()
  h.attach(b)
  await call(b, "resume", { hid: second.hid, out: 0, err: 0 })
  await sleep(120)
  assert.equal(made[0]!.killed, 1, "the first was ended")
  assert.equal(made[1]!.killed, 0, "the second was not")
  assert.deepEqual(
    h.procs().map((p) => p.hid),
    [second.hid],
  )
  void first
  h.detach(b)
  await sleep(120)
  assert.equal(made[1]!.killed, 1)
  assert.deepEqual(h.procs(), [])
  assert.ok(idle() > 0, "nothing kept: the helper may end")
})

test("a process that ended while no app was attached: its output and how it ended are kept for the app, and the helper does not end meanwhile", async () => {
  const { h, made, call, idle } = host(60_000)
  const a = conn()
  h.attach(a)
  const { hid } = (await call(a, "spawn", { program: "agent", args: [], owner: "me", launch: 1 })) as { hid: string }
  h.detach(a)
  const before = idle()
  h.take(hid, 1, Buffer.from("last words\n"))
  made[0]!.end({ code: 0, signal: null })
  await sleep(20)
  assert.equal(idle(), before, "something is kept: the helper does not end")
  assert.equal(h.procs()[0]?.exited, true)
  const b = conn()
  h.attach(b)
  await call(b, "resume", { hid, out: 0, err: 0 })
  assert.deepEqual(data(b), [{ at: 0, text: "last words\n" }])
  assert.deepEqual(
    b.got.filter((m) => m.ev === "exit").map((m) => [m.code, m.signal]),
    [[0, null]],
  )
  await call(b, "reap", { hid })
  assert.deepEqual(h.procs(), [])
})
