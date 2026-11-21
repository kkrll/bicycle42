// The helper's keeping of processes (src/helper/host.ts), without a socket or a real process: the
// order output reaches an app that takes a process up again, the lease that ends what no app is
// attached to, and what is kept of a process that ended while no app was. Then the wire, as
// properties over seeded random cases (src/shared/wire.ts and the host's calls): any cutting of
// the bytes reads the same messages, every request with an id is answered once, stdin gets each
// byte once in order whatever writes are sent again, a spawn sent again is the same process, and
// kill, reap and resume can be asked twice.
//
//   node scripts/build.mjs --tests && node --test dist/test/helper.test.cjs
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { createHost, type Conn } from "../src/helper/host"
import type { Child, Exit, Machine, RunOptions } from "../src/main/machine"
import { lineReader, PROTOCOL } from "../src/shared/wire"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A machine whose processes are stand-ins the test ends, and whose files are in a Map. */
function fakeMachine() {
  const made: Array<Child & { end(e: Exit): void; killed: number }> = []
  const files = new Map<string, string>()
  const runs: RunOptions[] = []
  const machine = {
    home: "/home/t",
    platform: "linux",
    devNull: "/dev/null",
    hostname: () => "t",
    writeFile: async (p: string, data: string) => void files.set(p, data),
    readFile: async (p: string) => {
      const f = files.get(p)
      if (f === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" })
      return f
    },
    stat: async (p: string) => ({ kind: "file", size: Buffer.byteLength(files.get(p) ?? ""), mtimeMs: 1 }),
    readdir: async (p: string) => Array.from({ length: Number(p.split("/").pop()) || 0 }, (_, i) => ({ name: `f${i}`, kind: "file" })),
    run: async (_program: string, _args: string[], o: RunOptions) => (runs.push(o), { code: 0, signal: null, out: "ok", err: "" }),
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
  return { machine, made, files, runs }
}

/** A connection that keeps what it is sent, parsed. */
function conn() {
  const got: Array<Record<string, unknown>> = []
  const c: Conn & { got: typeof got } = { got, send: (line) => void got.push(JSON.parse(line)) }
  return c
}

function host(leaseMs = 60_000, lineMax?: number) {
  const { machine, made, files, runs } = fakeMachine()
  let idle = 0
  const h = createHost({ machine, version: "t", log: () => {}, outMax: 1 << 20, errMax: 1 << 16, leaseMs, idle: () => void idle++, busy: () => {}, shutdown: () => {}, lineMax })
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
  /** A call's whole answer: its result or its error. */
  const ask = async (c: ReturnType<typeof conn>, method: string, params?: unknown) => {
    const mine = ++id
    h.handle(c, JSON.stringify({ id: mine, method, params }))
    for (let i = 0; i < 50; i++) {
      const answer = c.got.find((m) => m.id === mine)
      if (answer) return answer as { result?: Record<string, unknown>; error?: { message: string; code?: string } }
      await sleep(1)
    }
    throw new Error(`no answer to ${method}`)
  }
  return { h, made, files, runs, call, ask, idle: () => idle }
}

/** A seeded random source (mulberry32): the same cases each run, another seed for others. */
function random(seed: number) {
  return {
    next() {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    int(n: number) {
      return Math.floor(this.next() * n)
    },
    pick<T>(xs: readonly T[]): T {
      return xs[this.int(xs.length)]!
    },
  }
}
/** Text with characters of one to four bytes in UTF-8, and the odd quote, backslash and newline. */
const PIECES = ["a", "z", " ", "é", "ß", "€", "中", "文", "😀", "🚲", "\n", '"', "\\", "\u0000", "\r"]
const textOf = (r: ReturnType<typeof random>, n: number) => Array.from({ length: n }, () => r.pick(PIECES)).join("")
/** The bytes cut into random pieces, from one byte to many. */
function cut(r: ReturnType<typeof random>, bytes: Buffer): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < bytes.length; ) {
    const n = 1 + r.int(r.next() < 0.5 ? 4 : 200)
    out.push(bytes.subarray(i, i + n))
    i += n
  }
  return out
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

// ── the wire ───────────────────────────────────────────────────────────────────────────────────

test("any cutting of the bytes reads the same messages, characters of two to four bytes whole (none read as U+FFFD), on the helper's side as on the app's", async () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = random(seed)
    const messages = Array.from({ length: 1 + r.int(8) }, (_, i) => ({ id: i, text: textOf(r, r.int(300)) }))
    const bytes = Buffer.from(messages.map((m) => `${JSON.stringify(m)}${r.next() < 0.2 ? "\r" : ""}\n${r.next() < 0.2 ? "\n" : ""}`).join(""))
    const got: unknown[] = []
    const lines = lineReader({ line: (l) => got.push(JSON.parse(l)), tooLong: () => assert.fail("not too long") })
    for (const piece of cut(r, bytes)) lines.push(piece)
    assert.deepEqual(got, messages, `seed ${seed}`)
    assert.equal(lines.pending, 0)
  }
  // Through the helper's calls: a file written over the wire is the text that was sent.
  const { h, files } = host()
  const c = conn()
  h.attach(c)
  const r = random(7)
  const want = new Map<string, string>()
  const lines = lineReader({ line: (l) => h.handle(c, l), tooLong: () => assert.fail("not too long") })
  const stream: string[] = []
  for (let i = 0; i < 40; i++) {
    const text = textOf(r, 1 + r.int(2000))
    want.set(`/f${i}`, text)
    stream.push(`${JSON.stringify({ id: i + 1, method: "writeFile", params: { path: `/f${i}`, data: text } })}\n`)
  }
  for (const piece of cut(r, Buffer.from(stream.join("")))) lines.push(piece)
  await sleep(20)
  assert.deepEqual(new Map(files), want)
  assert.equal(c.got.length, 40)
  assert.ok([...files.values()].every((t) => !t.includes("\uFFFD")))
})

test("a line longer than the most a line may be is said once, and nothing after it is read; one exactly that long is read", () => {
  const max = 64
  const r = random(3)
  for (let n = 0; n < 50; n++) {
    const long = Buffer.from(`${"x".repeat(max + 1 + r.int(100))}\n{"after":1}\n`)
    let said = 0
    const got: string[] = []
    let size = 0
    const lines = lineReader({ max, line: (l) => void got.push(l), tooLong: (n) => void (said++, (size = n)) })
    for (const piece of cut(r, long)) lines.push(piece)
    assert.equal(said, 1)
    assert.ok(size > max, `said as ${size} bytes`)
    assert.deepEqual(got, [])
    assert.equal(lines.pending, 0, "what was held is let go")
  }
  const got: string[] = []
  const lines = lineReader({ max, line: (l) => void got.push(l), tooLong: () => assert.fail("it fits") })
  lines.push(Buffer.from(`${"y".repeat(max)}\n`))
  assert.deepEqual(got, ["y".repeat(max)])
})

test("every request with an id is answered exactly once, whatever it is: an unknown call (constructor, toString, __proto__ too) is an error, params that are not the call's are refused (EINVAL), and a message without an id is never answered", async () => {
  const { h, made } = host()
  const c = conn()
  h.attach(c)
  const spawned = (await (async () => {
    h.handle(c, JSON.stringify({ id: "s", method: "spawn", params: { program: "agent", args: [], key: "k-1" } }))
    await sleep(5)
    return c.got.find((m) => m.id === "s")!.result as { hid: string }
  })()).hid
  // Every one of these must be refused, with the code said.
  const refused: Array<[string, unknown, string]> = [
    ["nope", {}, "ENOSYS"],
    ["constructor", {}, "ENOSYS"],
    ["toString", {}, "ENOSYS"],
    ["__proto__", {}, "ENOSYS"],
    ["hasOwnProperty", {}, "ENOSYS"],
    ["valueOf", {}, "ENOSYS"],
    ["write", { hid: spawned, data: "aGk=" }, "EINVAL"],
    ["write", { hid: spawned, at: "0", data: "aGk=" }, "EINVAL"],
    ["write", { hid: spawned, at: -1, data: "aGk=" }, "EINVAL"],
    ["write", { hid: spawned, at: 0.5, data: "aGk=" }, "EINVAL"],
    ["write", { hid: spawned, at: 0, data: "not base64!" }, "EINVAL"],
    ["write", { hid: spawned, at: 5, data: "aGk=" }, "EINVAL"],
    ["write", { hid: "nobody", at: 0, data: "aGk=" }, "ESRCH"],
    ["stat", { path: 42 }, "EINVAL"],
    ["stat", {}, "EINVAL"],
    ["readFile", { path: ["a"] }, "EINVAL"],
    ["writeFile", { path: "/x" }, "EINVAL"],
    ["writeFile", { path: "/x", data: "d", mode: "0600" }, "EINVAL"],
    ["run", { program: "git", args: "status" }, "EINVAL"],
    ["run", { program: "git", args: [], options: { timeout: -5 } }, "EINVAL"],
    ["run", { program: "git", args: [], options: { env: { A: 1 } } }, "EINVAL"],
    ["spawn", { program: "agent", args: [1] }, "EINVAL"],
    ["spawn", { program: "agent", args: [], env: "PATH=/" }, "EINVAL"],
    ["resume", { hid: spawned, out: "0" }, "EINVAL"],
    ["kill", {}, "EINVAL"],
    ["rename", { from: "/a" }, "EINVAL"],
    ["stat", [], "EINVAL"],
    ["stat", "path", "EINVAL"],
  ]
  let id = 0
  const ids: number[] = []
  for (const [method, params] of refused) {
    ids.push(++id)
    h.handle(c, JSON.stringify({ id, method, params }))
  }
  // Without an id, or not a request at all: no answer.
  for (const line of ['{"method":"nope"}', '{"method":"stat","params":{"path":1}}', "not json", "[1,2]", "null", "42", '{"id":{"x":1},"method":"ping"}', '{"method":"ack","params":{"hid":1}}', '{"method":"ack"}'])
    h.handle(c, line)
  await sleep(20)
  for (const [i, [method, , code]] of refused.entries()) {
    const answers = c.got.filter((m) => m.id === ids[i])
    assert.equal(answers.length, 1, `${method} answered once`)
    const e = answers[0]!.error as { code?: string; message: string } | undefined
    assert.ok(e, `${method} ${JSON.stringify(refused[i]![1])} is refused`)
    assert.equal(e.code, code, `${method} ${JSON.stringify(refused[i]![1])}: ${e.message}`)
  }
  assert.equal(c.got.filter((m) => m.id !== undefined && m.id !== "s").length, ids.length, "nothing else was answered")
  // Nothing was written to the process by the refused writes.
  const stdin: Buffer[] = []
  made[0]!.stdin.on("data", (d: Buffer) => stdin.push(d))
  await sleep(5)
  assert.equal(Buffer.concat(stdin).length, 0)

  // And a fuzz: random messages, each with an id answered once.
  const r = random(11)
  const methods = ["ping", "hello", "info", "stat", "readFile", "write", "kill", "reap", "resume", "nope", "constructor", "__proto__", "toString", "spawn", "rename", "run", "which"]
  const values = [undefined, null, 0, -1, 1.5, "x", "", "/f0", spawned, [], ["a"], {}, { a: 1 }, true]
  const asked: number[] = []
  for (let n = 0; n < 500; n++) {
    const params: Record<string, unknown> = {}
    for (const name of ["hid", "at", "data", "path", "program", "args", "out", "err", "from", "to", "key", "options", "env"]) if (r.next() < 0.3) params[name] = r.pick(values)
    const method = r.pick(methods)
    // No real program is started, nothing ended for good, by the fuzz.
    if (method === "spawn" || method === "kill") continue
    const mine = 1000 + n
    asked.push(mine)
    h.handle(c, JSON.stringify({ id: mine, method, params: r.next() < 0.1 ? r.pick(values) : params }))
  }
  await sleep(50)
  for (const mine of asked) assert.equal(c.got.filter((m) => m.id === mine).length, 1, `request ${mine} answered once`)
})

test("hello and ping say the protocol the helper speaks", async () => {
  const { h, call } = host()
  const c = conn()
  h.attach(c)
  assert.equal((await call(c, "hello", { owner: "me", launch: 1 })).protocol, PROTOCOL)
  assert.equal((await call(c, "ping")).protocol, PROTOCOL)
})

test("whatever writes are sent again, overlapping or repeated from any byte the helper has, the process's stdin gets each byte exactly once, in order; a write from beyond what it has is refused and writes nothing", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = random(seed)
    const { h, made, ask } = host()
    const c = conn()
    h.attach(c)
    const { hid } = (await ask(c, "spawn", { program: "agent", args: [], key: `k-${seed}` })).result as { hid: string }
    const stdin: Buffer[] = []
    made[0]!.stdin.on("data", (d: Buffer) => stdin.push(d))
    const all = Buffer.from(textOf(r, 400))
    let inAt = 0
    for (let n = 0; n < 40 && inAt < all.length; n++) {
      // From any byte it has (a write sent again after a reconnect), or now and then beyond it.
      const beyond = r.next() < 0.1
      const at = beyond ? inAt + 1 + r.int(10) : r.int(inAt + 1)
      const len = r.int(60)
      const answer = await ask(c, "write", { hid, at, data: all.subarray(at, at + len).toString("base64") })
      if (beyond) {
        assert.equal(answer.error?.code, "EINVAL", `seed ${seed}`)
        continue
      }
      inAt = Math.max(inAt, Math.min(all.length, at + len))
      assert.equal(answer.result?.inAt, inAt, `seed ${seed}`)
    }
    await sleep(1)
    assert.deepEqual(Buffer.concat(stdin), all.subarray(0, inAt), `seed ${seed}`)
  }
})

test("a spawn sent again with the same key (its answer was lost when the link dropped) is the same process, not a second one; it is taken up from the start of its output", async () => {
  const { h, made, call } = host()
  const a = conn()
  h.attach(a)
  const first = await call(a, "spawn", { program: "agent", args: [], owner: "me", launch: 1, key: "abc-1" })
  h.take(String(first.hid), 1, Buffer.from("ready\n"))
  // The answer never reached the app: the link dropped.
  h.detach(a)
  const b = conn()
  h.attach(b)
  const hello = await call(b, "hello", { owner: "me", launch: 1 })
  assert.deepEqual(
    (hello.procs as Array<{ key?: string }>).map((p) => p.key),
    ["abc-1"],
  )
  const again = await call(b, "spawn", { program: "agent", args: [], owner: "me", launch: 1, key: "abc-1" })
  assert.deepEqual(again, { hid: first.hid, again: true })
  assert.equal(made.length, 1, "one process")
  await call(b, "resume", { hid: again.hid, out: 0, err: 0 })
  assert.deepEqual(data(b), [{ at: 0, text: "ready\n" }])
  // Another key is another process; once the first is reaped, its key is free again.
  const other = await call(b, "spawn", { program: "agent", args: [], key: "abc-2" })
  assert.notEqual(other.hid, first.hid)
  made[0]!.end({ code: 0, signal: null })
  await sleep(5)
  await call(b, "reap", { hid: first.hid })
  const fresh = await call(b, "spawn", { program: "agent", args: [], key: "abc-1" })
  assert.notEqual(fresh.hid, first.hid)
  assert.equal(made.length, 3)
})

test("kill, reap and resume can be asked twice, or of a process the helper does not have, and answer the same", async () => {
  const { h, made, call } = host()
  const c = conn()
  h.attach(c)
  const { hid } = (await call(c, "spawn", { program: "agent", args: [], key: "k-1" })) as { hid: string }
  h.take(hid, 1, Buffer.from("one\n"))
  h.take(hid, 2, Buffer.from("warn\n"))
  c.got.length = 0
  const r1 = await call(c, "resume", { hid, out: 0, err: 0 })
  const sent1 = data(c)
  c.got.length = 0
  const r2 = await call(c, "resume", { hid, out: 0, err: 0 })
  assert.deepEqual(r1, r2)
  assert.deepEqual(data(c), sent1, "the same bytes at the same places: the app reads them once")
  assert.deepEqual(await call(c, "kill", { hid }), {})
  assert.deepEqual(await call(c, "kill", { hid }), {})
  assert.equal(made[0]!.killed, 2, "asked twice: each is answered once it is gone")
  await sleep(5)
  assert.deepEqual(await call(c, "reap", { hid }), {})
  assert.deepEqual(await call(c, "reap", { hid }), {})
  assert.deepEqual(h.procs(), [])
  assert.deepEqual(await call(c, "resume", { hid, out: 0, err: 0 }), { gone: true })
  assert.deepEqual(await call(c, "kill", { hid: "nobody" }), {})
  assert.deepEqual(await call(c, "reap", { hid: "nobody" }), {})
})

test("an answer longer than a line may be is an error saying so (E2BIG), its one answer, and the connection goes on; a file longer than that is refused before it is read; a command's output is held to it", async () => {
  const { h, files, runs, ask } = host(60_000, 1000)
  const c = conn()
  h.attach(c)
  const big = await ask(c, "readdir", { path: "/dir/200" })
  assert.equal(big.error?.code, "E2BIG")
  assert.match(big.error!.message, /the answer is .* more than the 1000 bytes a message may be/)
  files.set("/huge", "x".repeat(5000))
  const huge = await ask(c, "readFile", { path: "/huge" })
  assert.equal(huge.error?.code, "EFBIG")
  assert.match(huge.error!.message, /\/huge is 5 KB, more than the 1000 bytes the app reads over ssh/)
  assert.deepEqual((await ask(c, "readdir", { path: "/dir/2" })).result, [
    { name: "f0", kind: "file" },
    { name: "f1", kind: "file" },
  ])
  await ask(c, "run", { program: "git", args: [] })
  await ask(c, "run", { program: "git", args: [], options: { maxBuffer: 1 << 30 } })
  await ask(c, "run", { program: "git", args: [], options: { maxBuffer: 10 } })
  assert.deepEqual(
    runs.map((o) => o.maxBuffer),
    [1000, 1000, 10],
  )
})
