// What the helper (helper.ts) keeps on the other computer, apart from its socket: Machine's calls
// as JSON-RPC methods, the app's work on a folder (`ops.*`, src/main/ops.ts), and the processes the app starts there, with their output kept for an app
// that is away. Here so the tests can drive it without a socket (test/helper.test.ts).
//
// A process belongs to the app that started it (`owner`: one install of the app, `launch`: one
// run of it, a time) and is attached to one connection at a time, which its output goes to. With
// none attached for `leaseMs` (the app quit without ending it, or its computer was away too long)
// it is ended; once it has ended, what it said and how it ended are kept until the app has read
// them (reap) or that long has passed with no app attached.
//
// Each process also has the `key` the app gave its spawn (one connection of the app, and a count):
// a spawn sent again after the link dropped before its answer came gets the process the first one
// started, never a second one.
//
// Every call is looked up among the calls below and nothing else (not `constructor`, not
// `toString`), its params are checked before anything is done (EINVAL, saying which), and every
// call with an id gets exactly one answer: an answer too long for a line (LINE_MAX) becomes an
// error saying so (E2BIG), and the connection stays.
import type { Child, Exit, Machine } from "../main/machine"
import { localOps, OPS } from "../main/ops"
import { LINE_MAX, PROTOCOL, sizeOf } from "../shared/wire"

/** A connection: each message is given as its JSON line, without the newline. */
export type Conn = { send(line: string): void }
type Kept = { chunks: Buffer[]; start: number; end: number; max: number; gap: boolean }
type Proc = {
  hid: string
  owner: string
  launch: number
  /** What the app called this spawn: the same key again is this process again. */
  key?: string
  child: Child
  out: Kept
  err: Kept
  inAt: number
  exit?: Exit
  conn?: Conn
  closed: boolean
  /** Ends it (or forgets it, once it has ended) after `leaseMs` with no connection attached. */
  lease?: ReturnType<typeof setTimeout>
  /** Its lease ran out: forgotten once it has ended. */
  orphan?: true
}

export type HostOptions = {
  machine: Machine
  version: string
  log(...words: unknown[]): void
  outMax: number
  errMax: number
  leaseMs: number
  /** Nothing is attached and nothing is kept (called again whenever that becomes so). */
  idle(): void
  /** Something is attached or kept again. */
  busy(): void
  /** The `shutdown` call: what runs was ended. */
  shutdown(): void
  /** The longest line sent or taken (LINE_MAX unless said, for the tests). */
  lineMax?: number
}

// ── params ─────────────────────────────────────────────────────────────────────────────────────

/** What a param must be: "?" after it, it may be left out (or null). */
type Kind = "string" | "uint" | "number" | "strings" | "env" | "object" | "base64" | "boolean" | "turns"
type Shape = Record<string, Kind | `${Kind}?`>

const isUint = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const fits: Record<Kind, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  uint: isUint,
  number: (v) => typeof v === "number" && Number.isFinite(v),
  strings: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  // Variables to set (a string) or take out (null).
  env: (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string" || x === null),
  object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
  base64: (v) => typeof v === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0,
  boolean: (v) => typeof v === "boolean",
  // A take-back's turns: their two trees, and when each began.
  turns: (v) => Array.isArray(v) && v.every((t) => !!t && typeof t === "object" && typeof t.before === "string" && typeof t.after === "string" && (t.start === undefined || (typeof t.start === "number" && Number.isFinite(t.start)))),
}
const said: Record<Kind, string> = {
  string: "a string",
  uint: "a whole number, 0 or more",
  number: "a number",
  strings: "a list of strings",
  env: "an object of strings (or null)",
  object: "an object",
  base64: "base64",
  boolean: "true or false",
  turns: "a list of {before, after, start?}",
}

/** Refused: a param missing, or not what the call takes. */
const einval = (message: string) => Object.assign(new Error(message), { code: "EINVAL" })

function checkParams(method: string, shape: Shape, params: Record<string, unknown>) {
  for (const [name, want] of Object.entries(shape)) {
    const optional = want.endsWith("?")
    const kind = want.replace("?", "") as Kind
    const v = params[name]
    if (v === undefined || v === null) {
      if (optional) continue
      throw einval(`${method}: ${name} is missing (it must be ${said[kind]})`)
    }
    if (!fits[kind](v)) throw einval(`${method}: ${name} must be ${said[kind]}`)
  }
}

/** run's options, checked as its params are. */
const RUN_OPTIONS: Shape = { cwd: "string?", env: "env?", clearPrefix: "string?", input: "string?", timeout: "uint?", maxBuffer: "uint?" }

export function createHost(o: HostOptions) {
  const { machine, log } = o
  const lineMax = o.lineMax ?? LINE_MAX
  const procs = new Map<string, Proc>()
  /** Each spawn's key, to its process. */
  const keys = new Map<string, string>()
  const conns = new Set<Conn>()
  let next = 0

  function check() {
    if (conns.size || procs.size) o.busy()
    else o.idle()
  }

  /** No connection is attached to it: its lease runs. */
  function lease(p: Proc) {
    clearTimeout(p.lease)
    p.lease = undefined
    if (p.conn) return
    p.lease = setTimeout(() => {
      p.lease = undefined
      if (p.conn) return
      if (p.closed) {
        log("lease ended: forgotten", p.hid)
        return forget(p)
      }
      log("lease ended: ending", p.hid)
      p.orphan = true
      void p.child.kill()
    }, o.leaseMs)
  }
  function forget(p: Proc) {
    clearTimeout(p.lease)
    procs.delete(p.hid)
    if (p.key && keys.get(p.key) === p.hid) keys.delete(p.key)
    check()
  }

  const kept = (max: number): Kept => ({ chunks: [], start: 0, end: 0, max, gap: false })
  /** Output comes in: kept, and sent to the app attached to the process, if any. */
  function take(p: Proc, fd: 1 | 2, data: Buffer) {
    const k = fd === 1 ? p.out : p.err
    const at = k.end
    k.chunks.push(data)
    k.end += data.length
    // Too much for an app that is away: the oldest goes, from a line's start on, and the app is
    // told by the gap between what it read and where the data it gets begins.
    if (k.end - k.start > k.max) {
      while (k.chunks.length > 1 && k.end - k.start > k.max) k.start += k.chunks.shift()!.length
      if (k.end - k.start > k.max) {
        const cut = k.end - k.start - k.max
        k.chunks[0] = k.chunks[0]!.subarray(cut)
        k.start += cut
      }
      const first = k.chunks[0]!
      const nl = first.indexOf(10)
      if (fd === 1 && nl >= 0) (k.chunks[0] = first.subarray(nl + 1)), (k.start += nl + 1)
      k.gap = true
    }
    if (p.conn) send(p.conn, { ev: "data", hid: p.hid, fd, at, data: data.toString("base64") })
  }

  /** A message, as its line. An answer longer than a line may be is an error saying so, sent in
   *  its place: the call gets its one answer, and the connection stays. */
  function send(conn: Conn, msg: { id?: number; [k: string]: unknown }) {
    let line = JSON.stringify(msg)
    // Bytes are at least as many as UTF-16 units, and at most three times as many.
    if (line.length * 3 > lineMax && Buffer.byteLength(line) > lineMax) {
      const size = Buffer.byteLength(line)
      if (msg.id === undefined) return log("a message too long to send was let go", sizeOf(size))
      line = JSON.stringify({ id: msg.id, error: { message: `the answer is ${sizeOf(size)}, more than the ${sizeOf(lineMax)} a message may be`, code: "E2BIG" } })
    }
    conn.send(line)
  }

  /** What the app has read is no longer kept. */
  function trim(k: Kept, upTo: number) {
    while (k.chunks.length && k.start + k.chunks[0]!.length <= upTo) k.start += k.chunks.shift()!.length
    if (k.chunks.length && upTo > k.start) {
      k.chunks[0] = k.chunks[0]!.subarray(upTo - k.start)
      k.start = upTo
    }
  }

  /** Sends what is kept from `from` on, then the exit if it has come. */
  function replay(p: Proc, conn: Conn, from: { out: number; err: number }) {
    for (const [fd, k] of [[1, p.out], [2, p.err]] as const) {
      trim(k, fd === 1 ? from.out : from.err)
      let at = k.start
      for (const c of k.chunks) {
        send(conn, { ev: "data", hid: p.hid, fd, at, data: c.toString("base64") })
        at += c.length
      }
    }
    if (p.exit && p.closed) send(conn, { ev: "exit", hid: p.hid, ...p.exit })
  }

  /** The work done where the files are (ops.ts), over this computer's own files. */
  const repo = localOps(machine)

  const procsOf = () => [...procs.values()].map((p) => ({ hid: p.hid, owner: p.owner, launch: p.launch, ...(p.key ? { key: p.key } : {}), ...(p.exit ? { exited: true } : {}) }))

  type Op = { params: Shape; run(params: Record<string, unknown>, conn: Conn): unknown }
  const str = (v: unknown) => v as string
  /** The calls, and nothing else: a Map, so no name of an object's own (constructor, toString,
   *  __proto__) is ever one. */
  const ops = new Map<string, Op>([
    ["ping", { params: {}, run: () => ({ version: o.version, protocol: PROTOCOL }) }],
    ["hello", { params: { owner: "string?", launch: "number?" }, run: () => ({ version: o.version, protocol: PROTOCOL, pid: process.pid, procs: procsOf() }) }],
    ["info", { params: {}, run: () => ({ home: machine.home, platform: machine.platform, hostname: machine.hostname(), devNull: machine.devNull }) }],
    [
      "run",
      {
        params: { program: "string", args: "strings", options: "object?" },
        run: (q) => {
          const options = (q.options ?? {}) as Record<string, unknown>
          checkParams("run", RUN_OPTIONS, options)
          // Output beyond a line could never be sent back: the command is ended there, as one
          // with a smaller maxBuffer is, before the helper holds it all.
          const maxBuffer = Math.min(typeof options.maxBuffer === "number" && options.maxBuffer > 0 ? options.maxBuffer : lineMax, lineMax)
          return machine.run(str(q.program), q.args as string[], { ...(options as object), maxBuffer })
        },
      },
    ],
    ["agentEnv", { params: {}, run: () => machine.agentEnv() }],
    ["which", { params: { program: "string", env: "env?" }, run: (q) => machine.which(str(q.program), (q.env ?? undefined) as never).then((x) => x ?? null) }],
    ["stat", { params: { path: "string" }, run: (q) => machine.stat(str(q.path)) }],
    ["lstat", { params: { path: "string" }, run: (q) => machine.lstat(str(q.path)) }],
    ["readdir", { params: { path: "string" }, run: (q) => machine.readdir(str(q.path)) }],
    [
      "readFile",
      {
        params: { path: "string" },
        run: async (q) => {
          // A file longer than a line could never be sent back: said before it is read.
          const st = await machine.stat(str(q.path))
          if (st.kind === "file" && st.size > lineMax) throw Object.assign(new Error(`${str(q.path)} is ${sizeOf(st.size)}, more than the ${sizeOf(lineMax)} the app reads over ssh`), { code: "EFBIG" })
          return machine.readFile(str(q.path))
        },
      },
    ],
    ["writeFile", { params: { path: "string", data: "string", mode: "uint?" }, run: (q) => machine.writeFile(str(q.path), str(q.data), (q.mode ?? undefined) as number | undefined) }],
    ["mkdir", { params: { path: "string" }, run: (q) => machine.mkdir(str(q.path)) }],
    ["rename", { params: { from: "string", to: "string" }, run: (q) => machine.rename(str(q.from), str(q.to)) }],
    ["rm", { params: { path: "string" }, run: (q) => machine.rm(str(q.path)) }],
    ["realpath", { params: { path: "string" }, run: (q) => machine.realpath(str(q.path)) }],

    [
      "spawn",
      {
        params: { program: "string", args: "strings", cwd: "string?", env: "env?", owner: "string?", launch: "number?", key: "string?" },
        run(q, conn) {
          // Sent again (the link dropped before its answer): the process the first one started.
          // The app takes it up with resume, from the start of its output.
          const known = typeof q.key === "string" ? procs.get(keys.get(q.key) ?? "") : undefined
          if (known) return { hid: known.hid, again: true }
          const hid = `p${process.pid.toString(36)}${(++next).toString(36)}`
          const child = machine.spawn(str(q.program), q.args as string[], { cwd: (q.cwd ?? undefined) as string | undefined, env: (q.env ?? undefined) as never })
          const key = typeof q.key === "string" ? q.key : undefined
          const p: Proc = { hid, owner: String(q.owner ?? ""), launch: Number(q.launch) || 0, key, child, out: kept(o.outMax), err: kept(o.errMax), inAt: 0, conn: conns.has(conn) ? conn : undefined, closed: false }
          procs.set(hid, p)
          if (key) keys.set(key, hid)
          lease(p)
          child.stdout.on("data", (d: Buffer) => take(p, 1, d))
          child.stderr.on("data", (d: Buffer) => take(p, 2, d))
          child.stdin.on("error", () => undefined)
          let outDone = false
          let errDone = false
          const settle = () => {
            if (!p.exit || !outDone || !errDone || p.closed) return
            p.closed = true
            log("exit", hid, JSON.stringify(p.exit))
            if (p.conn) send(p.conn, { ev: "exit", hid, ...p.exit })
            if (p.orphan) forget(p)
          }
          child.stdout.on("close", () => ((outDone = true), settle()))
          child.stderr.on("close", () => ((errDone = true), settle()))
          void child.exited.then((exit) => {
            p.exit = exit
            // Not started at all: its streams may never say "close".
            if (exit.error) outDone = errDone = true
            settle()
          })
          log("spawn", hid, str(q.program))
          check()
          return { hid }
        },
      },
    ],
    [
      "write",
      {
        params: { hid: "string", at: "uint", data: "base64" },
        /** Bytes for its stdin, from byte `at` on: what came before (sent again after a reconnect)
         *  is skipped, so each byte reaches it once, in order. */
        run(q) {
          const p = procs.get(str(q.hid))
          if (!p) throw Object.assign(new Error("no such process"), { code: "ESRCH" })
          let data = Buffer.from(str(q.data), "base64")
          const at = q.at as number
          if (at > p.inAt) throw einval(`write: a write from ${at} when ${p.inAt} were written`)
          data = data.subarray(Math.min(data.length, p.inAt - at))
          if (data.length && !p.exit) p.child.stdin.write(data)
          p.inAt += data.length
          return { inAt: p.inAt }
        },
      },
    ],
    [
      "kill",
      {
        params: { hid: "string" },
        /** Answered once it and what it started are gone (or were sent SIGKILL). Again, or for a
         *  process the helper does not have, it is answered the same. */
        async run(q) {
          const p = procs.get(str(q.hid))
          if (p) await p.child.kill()
          return {}
        },
      },
    ],
    [
      "resume",
      {
        params: { hid: "string", out: "uint?", err: "uint?" },
        /** The app takes a process up (again): its output from these bytes on comes to this
         *  connection. What is kept is sent before anything new can be: in this very call, with
         *  nothing between. */
        run(q, conn) {
          const p = procs.get(str(q.hid))
          if (!p) return { gone: true }
          const from = { out: (q.out as number | undefined) ?? 0, err: (q.err as number | undefined) ?? 0 }
          const gap = from.out < p.out.start
          replay(p, conn, from)
          p.conn = conns.has(conn) ? conn : undefined
          lease(p)
          return { inAt: p.inAt, gap }
        },
      },
    ],
    [
      "reap",
      {
        params: { hid: "string" },
        /** The app knows it has ended: it is forgotten. */
        run(q) {
          const p = procs.get(str(q.hid))
          if (p?.exit) forget(p)
          return {}
        },
      },
    ],
    [
      "shutdown",
      {
        params: {},
        /** Ends everything it runs, waits for that (each with what it started), and ends. */
        async run() {
          log("shutdown")
          await Promise.race([Promise.all([...procs.values()].map((p) => p.child.kill())), new Promise((r) => setTimeout(r, 3000))])
          setTimeout(o.shutdown, 50)
          return {}
        },
      },
    ],
    // The app's work on a folder here, each one call: ops.vcs, ops.snapshot, ops.reverse, ...
    ...Object.entries(OPS).map(([name, op]): [string, Op] => [
      `ops.${name}`,
      {
        params: op.params,
        run(q) {
          // Where the app keeps its history of folders here: a full path, never one read from wherever the helper runs.
          if (typeof q.root === "string" && !machine.path.isAbsolute(q.root)) throw einval(`ops.${name}: root must be a full path`)
          return op.run(repo, q)
        },
      },
    ]),
  ])

  /** One JSON line from a connection. Answers go to the same connection: one for each message
   *  with an id, whatever it is. A line that is not JSON, or has no id, can't be answered. */
  function handle(conn: Conn, line: string) {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return log("a line that is not JSON was let go")
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return
    const { id, method, params: raw } = msg as { id?: unknown; method?: unknown; params?: unknown }
    // An id the app can match: a number (what the app sends) or a string.
    const answerable = typeof id === "number" || typeof id === "string"
    const answer = (m: Record<string, unknown>) => answerable && send(conn, { id: id as number, ...m })
    const params = (raw ?? {}) as Record<string, unknown>
    if (method === "ack") {
      // Told, not asked: never answered. One that does not make sense is let go.
      if (!fits.object(params) || typeof params.hid !== "string" || !isUint(params.out) || !isUint(params.err)) return
      const p = procs.get(params.hid)
      if (p) (trim(p.out, params.out as number), trim(p.err, params.err as number))
      return
    }
    void (async () => {
      try {
        const op = typeof method === "string" ? ops.get(method) : undefined
        if (!op) throw Object.assign(new Error(`no such call: ${typeof method === "string" ? method.slice(0, 80) : JSON.stringify(method ?? null)}`), { code: "ENOSYS" })
        if (!fits.object(params)) throw einval(`${method}: params must be an object`)
        checkParams(method as string, op.params, params)
        const result = await op.run(params, conn)
        answer({ result: result ?? null })
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        answer({ error: { message: e?.message ?? String(err), ...(e?.code ? { code: e.code } : {}) } })
      }
    })()
  }

  return {
    handle,
    attach(conn: Conn) {
      conns.add(conn)
      check()
    },
    detach(conn: Conn) {
      if (!conns.delete(conn)) return
      for (const p of procs.values())
        if (p.conn === conn) {
          p.conn = undefined
          lease(p)
        }
      check()
    },
    /** For the tests: a process's output as if its child had said it. */
    take: (hid: string, fd: 1 | 2, data: Buffer) => {
      const p = procs.get(hid)
      if (p) take(p, fd, data)
    },
    procs: () => procsOf(),
  }
}
