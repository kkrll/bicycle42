// The app's helper on another computer, reached over ssh (src/main/ssh.ts): one file, run with
// that computer's own `node` (18 or newer), kept at ~/.bicycle42/helper-<version>.js.
//
//   node helper-<v>.js daemon   starts the helper in the background unless it is running (setsid:
//                               it outlives the ssh connection), prints "B42 READY" once it listens
//   node helper-<v>.js serve    the helper itself: a unix socket in ~/.bicycle42/
//   node helper-<v>.js attach   joins this process's stdin and stdout to that socket: what the app
//                               runs over ssh to speak to the helper
//
// The helper is thin. It does what `Machine` (src/main/machine.ts) does on this computer, with that
// very code, as JSON-RPC: commands, files, the PATH; and it keeps the processes the app starts
// there (the agent) alive while no app is attached (the Mac sleeps, the network drops), with their
// output kept until the app says it has read it, up to OUT_MAX per process (beyond that the oldest
// lines go, and the app is told there is a gap). What the agent's protocol means is the app's.
//
// One JSON message per line, both ways:
//   app → helper   {id, method, params}             answered {id, result} or {id, error: {message, code}}
//                  {method: "ack", params}          (no answer) output read up to here
//   helper → app   {ev: "data", hid, fd, at, data}  output of a process, base64, from byte `at` of that stream
//                  {ev: "exit", hid, code, signal, error?}  after all of its output
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createLocalMachine, type Child, type Exit } from "../main/machine"

const DIR = path.join(os.homedir(), ".bicycle42")
const VERSION = /^helper-(.+)\.js$/.exec(path.basename(__filename))?.[1] ?? "dev"
const SOCKET = path.join(DIR, `helper-${VERSION}.sock`)
const LOG = path.join(DIR, "helper.log")
/** A process's output kept for an app that is away, at most (stdout; stderr keeps a tail). */
const OUT_MAX = Number(process.env.B42_HELPER_OUT_MAX) || 8 * 1024 * 1024
const ERR_MAX = 256 * 1024
/** With no app attached and nothing running, the helper ends after this long. */
const IDLE_MS = Number(process.env.B42_HELPER_IDLE_MS) || 10 * 60_000

type Msg = { id?: number; method?: string; params?: Record<string, unknown> }

/** One stream of a process's output: what is kept of it, and where that begins. */
type Kept = { chunks: Buffer[]; start: number; end: number; max: number; gap: boolean }
type Proc = { hid: string; owner: string; child: Child; out: Kept; err: Kept; inAt: number; exit?: Exit; conn?: Conn; closed: boolean }
type Conn = { send(msg: unknown): void }

const mode = process.argv[2]
if (mode === "attach") attach()
else if (mode === "daemon") void daemon()
else if (mode === "serve") serve()
else {
  process.stderr.write("usage: helper.js daemon|serve|attach\n")
  process.exit(2)
}

// ── attach: ssh's stdio ⇄ the socket ────────────────────────────────────────────────────────────

function attach() {
  const sock = net.connect(SOCKET)
  sock.on("connect", () => {
    process.stdin.pipe(sock)
    sock.pipe(process.stdout)
  })
  sock.on("error", (err) => {
    process.stderr.write(`B42 NOHELPER ${String(err)}\n`)
    process.exit(3)
  })
  sock.on("close", () => process.exit(0))
  // The app went (the ssh connection ended): so does this bridge, never the helper.
  process.stdin.on("end", () => sock.end())
  process.stdin.on("error", () => process.exit(0))
  process.stdout.on("error", () => process.exit(0))
}

// ── daemon: start the helper unless it runs ────────────────────────────────────────────────────

function ping(socket: string, ms = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socket)
    const timer = setTimeout(() => (sock.destroy(), resolve(false)), ms)
    let buf = ""
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, method: "ping" })}\n`))
    sock.on("data", (d) => {
      buf += d
      if (buf.includes("\n")) (clearTimeout(timer), sock.destroy(), resolve(true))
    })
    sock.on("error", () => (clearTimeout(timer), resolve(false)))
  })
}

async function daemon() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  if (!(await ping(SOCKET))) {
    fs.rmSync(SOCKET, { force: true })
    const log = fs.openSync(LOG, "a")
    // Its own session (setsid): the ssh connection that started it ending does not end it.
    const child = spawn(process.execPath, [__filename, "serve"], { detached: true, stdio: ["ignore", log, log], cwd: os.homedir() })
    child.unref()
    const end = Date.now() + 10_000
    while (!(await ping(SOCKET, 500))) {
      if (Date.now() > end) {
        let tail = ""
        try {
          tail = fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-3).join(" | ")
        } catch {}
        process.stdout.write(`B42 FAILED ${tail}\n`)
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  // An older helper (the app was updated) ends, with what it runs, and its file goes.
  for (const name of fs.readdirSync(DIR)) {
    const m = /^helper-(.+)\.(sock|js)$/.exec(name)
    if (!m || m[1] === VERSION) continue
    if (m[2] === "sock") await shutdown(path.join(DIR, name))
    fs.rmSync(path.join(DIR, name), { force: true })
  }
  process.stdout.write("B42 READY\n")
  process.exit(0)
}

function shutdown(socket: string): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect(socket)
    const timer = setTimeout(() => (sock.destroy(), resolve()), 2000)
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, method: "shutdown" })}\n`))
    sock.on("data", () => (clearTimeout(timer), sock.destroy(), resolve()))
    sock.on("error", () => (clearTimeout(timer), resolve()))
  })
}

// ── serve: the helper ───────────────────────────────────────────────────────────────────────────

function serve() {
  const machine = createLocalMachine()
  const procs = new Map<string, Proc>()
  const conns = new Set<Conn>()
  let next = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const log = (...words: unknown[]) => process.stdout.write(`${new Date().toISOString()} ${words.map(String).join(" ")}\n`)

  function idle() {
    clearTimeout(idleTimer)
    if (conns.size || [...procs.values()].some((p) => !p.exit)) return
    idleTimer = setTimeout(() => {
      log("idle: ending")
      fs.rmSync(SOCKET, { force: true })
      process.exit(0)
    }, IDLE_MS)
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

  const ops: Record<string, (params: Record<string, unknown>, conn: Conn) => unknown> = {
    ping: () => ({ version: VERSION }),
    hello: () => ({
      version: VERSION,
      pid: process.pid,
      procs: [...procs.values()].map((p) => ({ hid: p.hid, owner: p.owner, ...(p.exit ? { exited: true } : {}) })),
    }),
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
      const p: Proc = { hid, owner: String(q.owner ?? ""), child, out: kept(OUT_MAX), err: kept(ERR_MAX), inAt: 0, conn, closed: false }
      procs.set(hid, p)
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
        idle()
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
      clearTimeout(idleTimer)
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
    kill(q) {
      procs.get(String(q.hid))?.child.kill()
      return {}
    },
    /** The app takes a process up (again): its output from these bytes on comes to this connection. */
    resume(q, conn) {
      const p = procs.get(String(q.hid))
      if (!p) return { gone: true }
      p.conn = conn
      const from = { out: Number(q.out) || 0, err: Number(q.err) || 0 }
      const gap = from.out < p.out.start
      setImmediate(() => replay(p, conn, from))
      return { inAt: p.inAt, gap }
    },
    /** The app knows it has ended: it is forgotten. */
    reap(q) {
      const p = procs.get(String(q.hid))
      if (p?.exit) procs.delete(p.hid)
      idle()
      return {}
    },
    shutdown() {
      log("shutdown")
      for (const p of procs.values()) p.child.kill()
      setTimeout(() => {
        fs.rmSync(SOCKET, { force: true })
        process.exit(0)
      }, 300)
      return {}
    },
  }

  const server = net.createServer((sock) => {
    const conn: Conn = {
      send(msg) {
        if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`)
      },
    }
    conns.add(conn)
    clearTimeout(idleTimer)
    let buf = ""
    sock.on("data", (d) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) handle(line)
      }
    })
    function handle(line: string) {
      let msg: Msg
      try {
        msg = JSON.parse(line) as Msg
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
    const gone = () => {
      if (!conns.delete(conn)) return
      for (const p of procs.values()) if (p.conn === conn) p.conn = undefined
      idle()
    }
    sock.on("close", gone)
    sock.on("error", gone)
  })
  server.on("error", (err) => {
    log("can't listen", String(err))
    process.exit(1)
  })
  const was = process.umask(0o077)
  server.listen(SOCKET, () => {
    process.umask(was)
    log("listening", SOCKET, "node", process.version)
    idle()
  })
  process.on("SIGTERM", () => {
    fs.rmSync(SOCKET, { force: true })
    process.exit(0)
  })
}
