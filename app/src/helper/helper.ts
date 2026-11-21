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
// very code, as JSON-RPC: commands, files, the PATH; the app's work on a folder (src/main/ops.ts:
// the repo's line, the file history's git side), each operation one call, done here with the
// app's own code over this computer's files; and it keeps the processes the app starts
// there (the agent) alive while no app is attached (the Mac sleeps, the network drops), with their
// output kept until the app says it has read it, up to OUT_MAX per process (beyond that the oldest
// lines go, and the app is told there is a gap), for at most AWAY_HOURS with no app attached
// (host.ts). What the agent's protocol means is the app's.
//
// Each version of the helper is its own: its file, socket and lock carry the version, so two
// versions of the app (an update, a laptop and a desktop) each have theirs side by side, and none
// ends another's. A version no app uses ends by itself once nothing is attached and nothing kept,
// and its files go when another version's daemon finds its socket dead.
//
// One JSON message per line, both ways (src/shared/wire.ts: lines split on the newline byte and
// decoded whole, LINE_MAX at most; a longer one from the app drops its connection):
//   app → helper   {id, method, params}             answered {id, result} or {id, error: {message, code}}
//                  {method: "ack", params}          (no answer) output read up to here
//   helper → app   {ev: "data", hid, fd, at, data}  output of a process, base64, from byte `at` of that stream
//                  {ev: "exit", hid, code, signal, error?}  after all of its output
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createLocalMachine } from "../main/machine"
import { AWAY_HOURS } from "../shared/types"
import { LINE_MAX, lineReader, sizeOf } from "../shared/wire"
import { createHost, type Conn } from "./host"

const DIR = path.join(os.homedir(), ".bicycle42")
const VERSION = /^helper-(.+)\.js$/.exec(path.basename(__filename))?.[1] ?? "dev"
const SOCKET = path.join(DIR, `helper-${VERSION}.sock`)
const LOCK = path.join(DIR, `helper-${VERSION}.lock`)
const LOG = path.join(DIR, "helper.log")
/** A process's output kept for an app that is away, at most (stdout; stderr keeps a tail). */
const OUT_MAX = Number(process.env.B42_HELPER_OUT_MAX) || 8 * 1024 * 1024
const ERR_MAX = 256 * 1024
/** With no app attached and nothing kept, the helper ends after this long. */
const IDLE_MS = Number(process.env.B42_HELPER_IDLE_MS) || 10 * 60_000
/** A process with no app attached for this long is ended (the banner says the same time). */
const LEASE_MS = Number(process.env.B42_HELPER_LEASE_MS) || AWAY_HOURS * 3600_000
/** What waits to be written to an app, before the helper asks whether it reads at all. Beyond it,
 *  a connection that takes nothing of it for STALL_MS (one gone half-open) is dropped, and the app
 *  takes up again from what it read; one that reads, however slowly, is not: an app taking up five
 *  agents' kept output at once (8 MiB each, a third more as base64) or a few long answers is a
 *  burst of its own making, not a dead link. Beyond WRITE_HARD it is dropped at once: memory. */
const WRITE_MAX = Number(process.env.B42_HELPER_WRITE_MAX) || 64 * 1024 * 1024
const WRITE_HARD = Math.max(WRITE_MAX * 4, Number(process.env.B42_HELPER_WRITE_HARD) || 0)
const STALL_MS = Number(process.env.B42_HELPER_STALL_MS) || 15_000
/** Another version's files with a dead socket are left this long after that version last started. */
const STALE_MS = 3600_000

const mode = process.argv[2]
if (mode === "attach") attach()
else if (mode === "daemon") void daemon()
else if (mode === "serve") void serve()
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

// ── the folder ─────────────────────────────────────────────────────────────────────────────────

/** ~/.bicycle42, only its user's: made so, or made so again when it is theirs and others could
 *  read it. A sentence when it is not a folder of theirs. */
function ownDir(): string | undefined {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(DIR)
  if (!st.isDirectory()) return `${DIR} is not a folder (a link, or a file): move it away and connect again.`
  if (process.getuid && st.uid !== process.getuid()) return `${DIR} belongs to another user of this computer: move it away and connect again.`
  if (st.mode & 0o077) fs.chmodSync(DIR, 0o700)
  return undefined
}

// ── daemon: start the helper unless it runs ────────────────────────────────────────────────────

/** Whether a helper answers on that socket: "up"; "dead" only when nothing can (nothing listens,
 *  or there is no socket); "busy" when it is there and did not answer in time. */
function ping(socket: string, ms = 2000): Promise<"up" | "dead" | "busy"> {
  return new Promise((resolve) => {
    const sock = net.connect(socket)
    const timer = setTimeout(() => (sock.destroy(), resolve("busy")), ms)
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, method: "ping" })}\n`))
    // Any answer at all, a line's end: nothing of it is read or kept.
    sock.on("data", (d: Buffer) => {
      if (d.includes(0x0a)) (clearTimeout(timer), sock.destroy(), resolve("up"))
    })
    sock.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "dead" : "busy")
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function daemon() {
  const fail = (why: string) => {
    process.stdout.write(`B42 FAILED ${why}\n`)
    process.exit(1)
  }
  const bad = ownDir()
  if (bad) return fail(bad)
  // This version is in use: its files are not another version's to take away.
  try {
    const now = new Date()
    fs.utimesSync(__filename, now, now)
  } catch {}
  let state = await ping(SOCKET)
  // Not answering, but there: a helper that is busy. Never taken away from under it.
  if (state === "dead") {
    const log = fs.openSync(LOG, "a")
    // Its own session (setsid): the ssh connection that started it ending does not end it.
    const child = spawn(process.execPath, [__filename, "serve"], { detached: true, stdio: ["ignore", log, log], cwd: os.homedir() })
    child.unref()
  }
  const end = Date.now() + (Number(process.env.B42_HELPER_START_MS) || 10_000)
  while (state !== "up") {
    if (Date.now() > end) {
      let tail = ""
      try {
        tail = fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-3).join(" | ")
      } catch {}
      return fail(state === "busy" ? "the app's helper there is running and does not answer" : tail)
    }
    await sleep(100)
    state = await ping(SOCKET, 1000)
  }
  // Another version's files go only when its socket is dead and it has not been started for a
  // while: a helper that runs, or an app of that version on its way to start one, is left alone.
  for (const name of fs.readdirSync(DIR)) {
    // An upload whose connection dropped halfway leaves its temp file (ssh.ts upload).
    if (/^helper-.+\.js\.\d+\.tmp$/.test(name)) {
      try {
        if (Date.now() - fs.statSync(path.join(DIR, name)).mtimeMs > STALE_MS) fs.rmSync(path.join(DIR, name), { force: true })
      } catch {}
      continue
    }
    const m = /^helper-(.+)\.js$/.exec(name)
    if (!m || m[1] === VERSION) continue
    const base = path.join(DIR, `helper-${m[1]}`)
    try {
      if (Date.now() - fs.statSync(`${base}.js`).mtimeMs < STALE_MS) continue
    } catch {
      continue
    }
    if ((await ping(`${base}.sock`, 1000)) !== "dead") continue
    if (lockHolder(`${base}.lock`)) continue
    for (const ext of [".js", ".sock", ".lock"]) fs.rmSync(`${base}${ext}`, { force: true })
  }
  process.stdout.write("B42 READY\n")
  process.exit(0)
}

/** The live process that holds a lock, if any. */
function lockHolder(lock: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(lock, "utf8"))
    if (!pid || pid === process.pid) return undefined
    process.kill(pid, 0)
    return pid
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? -1 : undefined
  }
}

// ── serve: the helper ───────────────────────────────────────────────────────────────────────────

async function serve() {
  const log = (...words: unknown[]) => process.stdout.write(`${new Date().toISOString()} ${words.map(String).join(" ")}\n`)
  if (ownDir()) process.exit(1)
  // One helper of a version at a time: it holds the lock while it runs. A lock whose process is
  // gone is taken over; so is one whose number another process has now, once it is old and no
  // helper answers.
  for (let tries = 0; ; tries++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: "wx", mode: 0o600 })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || tries > 2) {
        log("can't take the lock", String(err))
        process.exit(1)
      }
      const holder = lockHolder(LOCK)
      let old = false
      try {
        old = Date.now() - fs.statSync(LOCK).mtimeMs > 60_000
      } catch {}
      if (holder && !(old && (await ping(SOCKET, 1000)) === "dead")) {
        log("another helper of this version runs", holder)
        process.exit(0)
      }
      fs.rmSync(LOCK, { force: true })
    }
  }
  let ino: number | undefined
  /** The socket goes on the way out only when it is this helper's own (not one that took over). */
  const leave = (code: number) => {
    try {
      if (ino !== undefined && fs.statSync(SOCKET).ino === ino) fs.rmSync(SOCKET, { force: true })
    } catch {}
    try {
      if (fs.readFileSync(LOCK, "utf8") === String(process.pid)) fs.rmSync(LOCK, { force: true })
    } catch {}
    process.exit(code)
  }
  // A socket left by a helper that is gone: taken over. One that answers is another's.
  const there = await ping(SOCKET)
  if (there !== "dead") {
    log("a helper answers on the socket already", there)
    leave(0)
  }
  fs.rmSync(SOCKET, { force: true })

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const host = createHost({
    machine: createLocalMachine(),
    version: VERSION,
    log,
    outMax: OUT_MAX,
    errMax: ERR_MAX,
    leaseMs: LEASE_MS,
    idle() {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        log("idle: ending")
        leave(0)
      }, IDLE_MS)
    },
    busy: () => clearTimeout(idleTimer),
    shutdown: () => leave(0),
  })

  const server = net.createServer((sock) => {
    let dropped = false
    const drop = (why: string) => {
      if (dropped) return
      dropped = true
      log(why)
      lines.stop()
      sock.destroy()
    }
    /** Bytes given to the socket. Whether any have gone since: a write the socket has finished
     *  (writableLength falls, though only once a whole batch of writes is out), or one under way
     *  that has gone in part (libuv's queue, which falls as the other end reads). */
    let queued = 0
    const inLibuv = () => (sock as unknown as { _handle?: { writeQueueSize?: number } })._handle?.writeQueueSize ?? 0
    let stall: ReturnType<typeof setTimeout> | undefined
    const watch = () => {
      if (sock.writableLength > WRITE_HARD) return drop(`a connection has ${sizeOf(sock.writableLength)} waiting to be read: dropped`)
      if (stall || sock.writableLength <= WRITE_MAX) return
      const done = queued - sock.writableLength
      const going = inLibuv()
      stall = setTimeout(() => {
        stall = undefined
        if (sock.writableLength <= WRITE_MAX) return
        // An app that reads nothing (the connection is half-open): dropped, its output kept.
        if (queued - sock.writableLength === done && inLibuv() >= going) return drop("a connection reads nothing: dropped")
        watch()
      }, STALL_MS)
    }
    sock.on("drain", () => (clearTimeout(stall), (stall = undefined)))
    const conn: Conn = {
      send(line) {
        if (sock.destroyed || dropped) return
        const bytes = Buffer.from(`${line}\n`)
        queued += bytes.length
        sock.write(bytes)
        watch()
      },
    }
    host.attach(conn)
    const lines = lineReader({
      max: LINE_MAX,
      line: (text) => host.handle(conn, text),
      tooLong: (n) => drop(`a connection sent a line of ${sizeOf(n)} and more, longer than any the app sends: dropped`),
    })
    sock.on("data", (d: Buffer) => lines.push(d))
    const gone = () => (clearTimeout(stall), host.detach(conn))
    sock.on("close", gone)
    sock.on("error", gone)
  })
  server.on("error", (err) => {
    log("can't listen", String(err))
    leave(1)
  })
  const was = process.umask(0o077)
  server.listen(SOCKET, () => {
    process.umask(was)
    try {
      ino = fs.statSync(SOCKET).ino
    } catch {}
    log("listening", SOCKET, "node", process.version)
    // Nothing attached yet: the idle wait starts.
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => (log("idle: ending"), leave(0)), IDLE_MS)
  })
  process.on("SIGTERM", () => leave(0))
}
