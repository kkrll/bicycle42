// What the helper (helper.ts) keeps on the other computer, apart from its socket: Machine's calls
// as JSON-RPC methods, and the processes the app starts there, with their output kept for an app
// that is away. Here so the tests can drive it without a socket (test/helper.test.ts).
//
// A process belongs to the app that started it (`owner`: one install of the app, `launch`: one
// run of it, a time) and is attached to one connection at a time, which its output goes to. With
// none attached for `leaseMs` (the app quit without ending it, or its computer was away too long)
// it is ended; once it has ended, what it said and how it ended are kept until the app has read
// them (reap) or that long has passed with no app attached.
import type { Child, Exit, Machine } from "../main/machine"

export type Conn = { send(msg: unknown): void }
type Kept = { chunks: Buffer[]; start: number; end: number; max: number; gap: boolean }
type Proc = {
  hid: string
  owner: string
  launch: number
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
}

export function createHost(o: HostOptions) {
  const { machine, log } = o
  const procs = new Map<string, Proc>()
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
    p.conn?.send({ ev: "data", hid: p.hid, fd, at, data: data.toString("base64") })
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
        conn.send({ ev: "data", hid: p.hid, fd, at, data: c.toString("base64") })
        at += c.length
      }
    }
    if (p.exit && p.closed) conn.send({ ev: "exit", hid: p.hid, ...p.exit })
  }

  const procsOf = () => [...procs.values()].map((p) => ({ hid: p.hid, owner: p.owner, launch: p.launch, ...(p.exit ? { exited: true } : {}) }))

  const ops: Record<string, (params: Record<string, unknown>, conn: Conn) => unknown> = {
    ping: () => ({ version: o.version }),
    hello: () => ({ version: o.version, pid: process.pid, procs: procsOf() }),
    info: () => ({ home: machine.home, platform: machine.platform, hostname: machine.hostname(), devNull: machine.devNull }),
    run: (q) => machine.run(String(q.program), q.args as string[], q.options as never),
    agentEnv: () => machine.agentEnv(),
    which: (q) => machine.which(String(q.program), q.env as never).then((x) => x ?? null),
    stat: (q) => machine.stat(String(q.path)),
    lstat: (q) => machine.lstat(String(q.path)),
    readdir: (q) => machine.readdir(String(q.path)),
    readFile: (q) => machine.readFile(String(q.path)),
    writeFile: (q) => machine.writeFile(String(q.path), String(q.data), typeof q.mode === "number" ? q.mode : undefined),
    mkdir: (q) => machine.mkdir(String(q.path)),
    rename: (q) => machine.rename(String(q.from), String(q.to)),
    rm: (q) => machine.rm(String(q.path)),
    realpath: (q) => machine.realpath(String(q.path)),

    spawn(q, conn) {
      const hid = `p${process.pid.toString(36)}${(++next).toString(36)}`
      const child = machine.spawn(String(q.program), q.args as string[], { cwd: q.cwd as string, env: q.env as never })
      const p: Proc = { hid, owner: String(q.owner ?? ""), launch: Number(q.launch) || 0, child, out: kept(o.outMax), err: kept(o.errMax), inAt: 0, conn: conns.has(conn) ? conn : undefined, closed: false }
      procs.set(hid, p)
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
        p.conn?.send({ ev: "exit", hid, ...p.exit })
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
      log("spawn", hid, String(q.program))
      check()
      return { hid }
    },
    /** Bytes for its stdin, from byte `at` on: what came before (sent again after a reconnect) is skipped. */
    write(q) {
      const p = procs.get(String(q.hid))
      if (!p) throw Object.assign(new Error("no such process"), { code: "ESRCH" })
      let data = Buffer.from(String(q.data), "base64")
      const at = Number(q.at)
      if (at > p.inAt) throw new Error(`a write from ${at} when ${p.inAt} were written`)
      data = data.subarray(Math.min(data.length, p.inAt - at))
      if (data.length && !p.exit) p.child.stdin.write(data)
      p.inAt += data.length
      return { inAt: p.inAt }
    },
    /** Answered once it and what it started are gone (or were sent SIGKILL). */
    async kill(q) {
      const p = procs.get(String(q.hid))
      if (p) await p.child.kill()
      return {}
    },
    /** The app takes a process up (again): its output from these bytes on comes to this connection.
     *  What is kept is sent before anything new can be: in this very call, with nothing between. */
    resume(q, conn) {
      const p = procs.get(String(q.hid))
      if (!p) return { gone: true }
      const from = { out: Number(q.out) || 0, err: Number(q.err) || 0 }
      const gap = from.out < p.out.start
      replay(p, conn, from)
      p.conn = conns.has(conn) ? conn : undefined
      lease(p)
      return { inAt: p.inAt, gap }
    },
    /** The app knows it has ended: it is forgotten. */
    reap(q) {
      const p = procs.get(String(q.hid))
      if (p?.exit) forget(p)
      return {}
    },
    /** Ends everything it runs, waits for that (each with what it started), and ends. */
    async shutdown() {
      log("shutdown")
      await Promise.race([Promise.all([...procs.values()].map((p) => p.child.kill())), new Promise((r) => setTimeout(r, 3000))])
      setTimeout(o.shutdown, 50)
      return {}
    },
  }

  /** One JSON line from a connection. Answers go to the same connection. */
  function handle(conn: Conn, line: string) {
    let msg: { id?: number; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const params = msg.params ?? {}
    if (msg.method === "ack") {
      const p = procs.get(String(params.hid))
      if (p) (trim(p.out, Number(params.out) || 0), trim(p.err, Number(params.err) || 0))
      return
    }
    const op = msg.method ? ops[msg.method] : undefined
    void (async () => {
      try {
        if (!op) throw new Error(`no such call: ${msg.method}`)
        const result = await op(params, conn)
        if (msg.id !== undefined) conn.send({ id: msg.id, result: result ?? null })
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (msg.id !== undefined) conn.send({ id: msg.id, error: { message: e?.message ?? String(err), ...(e?.code ? { code: e.code } : {}) } })
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
