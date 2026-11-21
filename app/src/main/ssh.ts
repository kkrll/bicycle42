// Another computer, reached over ssh: a `Machine` (machine.ts) whose commands, files and agent
// process are on it. Like an editor's remote development: the reviewer types a host (`user@host`,
// an alias of their ~/.ssh/config, a Tailscale name), and the app does the rest with the system's
// own `ssh`, their keys, agent, config and jump hosts. No password is asked or kept (BatchMode):
// a host that needs one, or whose key is not known yet, is a sentence telling them to run
// `ssh <host>` once in a terminal.
//
//   one connection   ssh's ControlMaster, its socket under the app's data folder: every call
//                    and every port forward goes over it, signed in once
//   the helper       one bundled file (src/helper/helper.ts, dist/helper.cjs) put at
//                    ~/.bicycle42/helper-<version>.js there and run with that computer's `node`
//                    as a daemon; the app attaches to it with `ssh host node … attach`
//   reconnecting     when the connection drops (the Mac sleeps, the network goes) the agent goes
//                    on working there; the app attaches again, with a growing pause, and reads
//                    what it missed, which the helper kept (machine.Child.onGap when that was too
//                    much). Meanwhile the machine is "down" (reach), and what is written to the
//                    agent waits here.
//   the site         the address the agent reports on its localhost is forwarded here (forward)
import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import type { Child, Entry, Exit, Machine, Reach, RunResult, Stat } from "./machine"

type Log = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void

/** Exported so tests can shorten them. Milliseconds. */
export const sshTiming = {
  /** A call to the helper (not a command, which has its own timeout). */
  call: 60_000,
  /** The steps of connecting: ssh's own ConnectTimeout is 15 s. */
  step: 45_000,
  retryMin: 1_000,
  retryMax: 30_000,
  /** How often what was read of a process's output is told to the helper. */
  ack: 200,
  /** How long ending a process there may take (the helper answers once its group is gone, 2 s
   *  at most), and how long close() waits for that. */
  kill: 5_000,
}

export type RemoteMachine = Machine & {
  readonly host: string
  /** This install of the app's id: what it keeps there is under it, apart from another install's. */
  readonly owner: string
  /** A port on the other computer's localhost, opened here on 127.0.0.1: the local port (`local`
   *  when given, else the same number when it is free here, else any). `host`: the address the
   *  agent's server listens on there. */
  forward(port: number, host?: string, local?: number): Promise<number>
  /** Try to connect again now (the banner's Retry). */
  retry(): void
  /** Ends what the app has there: the connection and its forwards, once the processes being
   *  ended there (and those still starting, which are ended) are, for a few seconds at most. What
   *  runs there is ended by whoever started it (the agent's process is killed by the ACP backend);
   *  what nobody ends is ended by the helper once no app was attached to it for AWAY_HOURS. */
  close(): Promise<void>
}

export type SshOptions = {
  host: string
  /** The app's data folder: the ControlMaster's socket and the app's id go there. */
  dataDir: string
  log?: Log
  /** The ssh program: B42_SSH, else "ssh" (the tests give a stand-in, test/fake-ssh.ts). */
  ssh?: string
  /** The helper's bundled file: dist/helper.cjs unless said. */
  helper?: string
  /** This run of the app (a time): what an earlier run of the same install started there and
   *  left is ended. The tests give one; else when this process started. */
  launch?: number
}

/** This run of the app: processes of an earlier one are ended, never this one's own (two
 *  connections to the same computer, typed two ways, are one run's). */
const LAUNCH = Date.now()

/** A host as typed, or a sentence saying why it is not one. Never an option of ssh's. */
export function checkHost(host: string): string {
  const h = host.trim()
  if (!h) throw new Error("Type the computer to connect to: user@host, or a name from your ~/.ssh/config.")
  if (h.startsWith("-") || /[\s'"`$;&|<>\\]/.test(h)) throw new Error(`"${h}" is not a host ssh can be given: user@host, or a name from your ~/.ssh/config.`)
  return h
}

/** Quoted for the other computer's shell (POSIX sh). */
export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** What ssh said when it failed, as a sentence for the reviewer. */
export function sshError(host: string, stderr: string, code: number | null): string {
  const said = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(Warning: Permanently added|debug\d?:)/.test(l))
  const all = said.join(" ")
  const once = `Run \`ssh ${host}\` once in a terminal`
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (ED25519|ECDSA|RSA)? ?host key is known/i.test(all))
    return `${host}'s host key is not known on this computer yet (or it changed). ${once}, check the fingerprint and answer yes, then connect again.`
  if (/Permission denied|Too many authentication failures|no more authentication methods/i.test(all))
    return `${host} did not accept a key from this computer, and the app does not type passwords. ${once}: if it asks for a password, set up a key (ssh-copy-id ${host}) or start your ssh agent, then connect again.`
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(all)) return `There is no computer called ${host} that this one can find. Check the name, or the Host in your ~/.ssh/config.`
  if (/Connection refused/i.test(all)) return `${host} refused the connection: is ssh running there, on that port?`
  if (/timed out|Network is unreachable|No route to host|Connection closed|Connection reset|Broken pipe/i.test(all)) return `Can't reach ${host}: ${said.at(-1)}`
  return `ssh ${host} failed${said.length ? `: ${said.at(-1)}` : code !== null ? ` (exit ${code})` : ""}`
}

/** The helper's file: built beside main.cjs (dist/helper.cjs), or for the tests one folder up. */
function helperFile(given?: string) {
  const options = [given, process.env.B42_HELPER, path.join(__dirname, "helper.cjs"), path.join(__dirname, "..", "helper.cjs")].filter(Boolean) as string[]
  const found = options.find((f) => fs.existsSync(f))
  if (!found) throw new Error("The app's helper for another computer is missing from this build (dist/helper.cjs).")
  return found
}

/** A folder only this user can use: made so (0700), or a sentence. One that is theirs and others
 *  could use is made theirs alone again, and what others put in it goes; a link, a file or
 *  another user's folder is refused: ssh would trust a connection someone else put there. */
export function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === "win32") return
  const st = fs.lstatSync(dir)
  const uid = process.getuid?.()
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid))
    throw new Error(`The app keeps its ssh connections in ${dir}, which is ${st.isDirectory() ? "another user's folder" : "not a folder"}. Move it away and connect again.`)
  if (st.mode & 0o077) {
    fs.chmodSync(dir, 0o700)
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name)
      if (uid !== undefined && fs.lstatSync(f).uid !== uid) fs.rmSync(f, { recursive: true, force: true })
    }
  }
}

/** This install of the app's id: what it starts on another computer is known as its own there. */
function ownerOf(dataDir: string) {
  const dir = path.join(dataDir, "ssh")
  privateDir(dir)
  const file = path.join(dir, "owner")
  try {
    const id = fs.readFileSync(file, "utf8").trim()
    if (/^[0-9a-f]{16}$/.test(id)) return id
  } catch {}
  const id = crypto.randomBytes(8).toString("hex")
  fs.writeFileSync(file, id, { mode: 0o600 })
  return id
}

/** Where the ControlMaster's socket is: short, since a unix socket's path is (104 bytes on macOS,
 *  and ssh adds 17 while it makes one). Only this user's (privateDir). */
export function controlDir(dataDir: string) {
  const own = path.join(dataDir, "ssh")
  const dir = own.length <= 70 ? own : path.join(os.tmpdir().length <= 40 ? os.tmpdir() : "/tmp", `b42-${os.userInfo().uid}`)
  privateDir(dir)
  return dir
}

/** Run with the other computer's node: its version, whether the helper of this version is there
 *  whole (its hash), and whether ~/.bicycle42 is a folder of its user's only (made so again when
 *  others could read it). Arguments: that folder, the helper's file, its sha1. */
const PROBE = [
  'const fs = require("fs"), c = require("crypto"); const [d, f, h] = process.argv.slice(1); let dir = "none"',
  'try { const s = fs.lstatSync(d); if (!s.isDirectory()) dir = "notdir"; else if (process.getuid && s.uid !== process.getuid()) dir = "notmine"; else { dir = "ok"; if (s.mode & 0o077) fs.chmodSync(d, 0o700) } } catch {}',
  'let have = false; try { have = c.createHash("sha1").update(fs.readFileSync(f)).digest("hex") === h } catch {}',
  'process.stdout.write("B42 " + JSON.stringify({ node: process.execPath, version: process.versions.node, platform: process.platform, have, dir }) + "\\n")',
].join("\n")
/** Exits 9 unless the file has this many bytes and this sha1. Arguments: the file, size, sha1. */
const CHECK = 'const [f, n, h] = process.argv.slice(1); const b = require("fs").readFileSync(f); if (b.length !== Number(n) || require("crypto").createHash("sha1").update(b).digest("hex") !== h) process.exit(9)'

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout> }

/** One process of the agent's on the other computer, as `Child`. Its output comes through the
 *  helper with where it begins, so what is sent again after a reconnect is read once; what is
 *  written to it waits here while the computer can't be reached, and is sent again from where the
 *  helper says it got to. */
type RemoteChild = Child & {
  hid?: string
  out: number
  err: number
  /** Bytes written to stdin, by where each begins, until the helper says it has them. */
  unsent: Array<{ at: number; data: Buffer }>
  inAt: number
  ended: boolean
  data(fd: number, at: number, bytes: Buffer): void
  exit(e: Exit): void
  flush(): void
}

export async function connectSsh(o: SshOptions): Promise<RemoteMachine> {
  const host = checkHost(o.host)
  const log: Log = o.log ?? (() => {})
  const ssh = o.ssh ?? process.env.B42_SSH ?? "ssh"
  const owner = ownerOf(o.dataDir)
  const launch = o.launch ?? LAUNCH
  const ctlDir = controlDir(o.dataDir)
  const ctl = path.join(ctlDir, crypto.createHash("sha1").update(`${host}\0${owner}`).digest("hex").slice(0, 10))
  const helperPath = helperFile(o.helper)
  const bundle = fs.readFileSync(helperPath)
  const digest = crypto.createHash("sha1").update(bundle).digest("hex")
  const version = digest.slice(0, 12)

  const common = [
    "-o", "BatchMode=yes",
    "-o", `ControlPath="${ctl.replace(/%/g, "%%")}"`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
  ]

  /** ssh with these words, to its end (or the timeout): what it printed. */
  function sshRun(args: string[], input?: Buffer | string, ms = sshTiming.step): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(ssh, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => child.kill(), ms)
      child.stdout.on("data", (b: Buffer) => out.push(b))
      child.stderr.on("data", (b: Buffer) => err.push(b))
      child.on("error", (e) => {
        clearTimeout(timer)
        resolve({ code: null, out: "", err: (e as NodeJS.ErrnoException).code === "ENOENT" ? `ssh was not found on this computer (${ssh})` : String(e) })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") })
      })
      child.stdin.on("error", () => undefined)
      child.stdin.end(input ?? "")
    })
  }
  /** A command on the other computer, over the shared connection. */
  const remote = (command: string, input?: Buffer | string, ms?: number) => sshRun([...common, "-o", "ControlMaster=no", "-T", "--", host, command], input, ms)

  /** The shared connection, made when there is none. Its own process (ssh -fN): it lives on
   *  after this call (ControlPersist), its output to a file so nothing waits for its pipes. One
   *  at a time: calls meanwhile wait for the same one. */
  let mastering: Promise<void> | undefined
  const master = () => (mastering ??= makeMaster().finally(() => (mastering = undefined)))
  async function makeMaster() {
    const check = await sshRun([...common, "-O", "check", "--", host], undefined, 10_000)
    if (check.code === 0) return
    const errFile = `${ctl}.err`
    const fd = fs.openSync(errFile, "w")
    try {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(ssh, [...common, "-o", "ControlMaster=yes", "-o", "ControlPersist=600", "-f", "-N", "--", host], { stdio: ["ignore", "ignore", fd], windowsHide: true, detached: process.platform !== "win32" })
        const timer = setTimeout(() => child.kill(), sshTiming.step)
        child.on("error", () => (clearTimeout(timer), resolve(null)))
        child.on("exit", (c) => (clearTimeout(timer), resolve(c)))
      })
      if (code !== 0) {
        let said = ""
        try {
          said = fs.readFileSync(errFile, "utf8")
        } catch {}
        throw new Error(sshError(host, said || (code === null ? `ssh was not found on this computer (${ssh})` : ""), code))
      }
    } finally {
      fs.closeSync(fd)
      fs.rmSync(errFile, { force: true })
    }
  }

  const dir = "$HOME/.bicycle42"
  const file = `${dir}/helper-${version}.js`
  let node = "node"

  /** The other computer's node, found as an interactive login shell finds it (nvm, mise), and
   *  whether the helper of this version is there. */
  async function probe() {
    const script = [
      'n=$(command -v node 2>/dev/null)',
      '[ -n "$n" ] || n=$("${SHELL:-/bin/sh}" -ilc "command -v node" </dev/null 2>/dev/null | tail -n 1)',
      'if [ -z "$n" ] || [ ! -x "$n" ]; then echo "B42 NONODE"; exit 0; fi',
      `"$n" -e ${shq(PROBE)} "${dir}" "${file}" ${digest}`,
    ].join("\n")
    const r = await remote(`sh -c ${shq(script)}`)
    if (r.code !== 0) throw new Error(sshError(host, r.err, r.code))
    const line = r.out.split("\n").reverse().find((l) => l.startsWith("B42 "))
    if (!line) throw new Error(`${host} did not answer as expected: ${r.out.trim().slice(-200) || r.err.trim().slice(-200)}`)
    if (line === "B42 NONODE") throw new Error(`The app needs Node 18 or newer on ${host} for its helper, and \`node\` was not found there. Install it (nodejs.org, or your package manager) and connect again.`)
    const found = JSON.parse(line.slice(4)) as { node: string; version: string; platform: string; have: boolean; dir?: string }
    if (found.dir === "notdir") throw new Error(`~/.bicycle42 on ${host} is not a folder (a link, or a file): move it away there and connect again.`)
    if (found.dir === "notmine") throw new Error(`~/.bicycle42 on ${host} belongs to another user there: move it away and connect again.`)
    if (found.platform === "win32") throw new Error(`${host} runs Windows, which the app can't work on over ssh yet.`)
    if (Number(found.version.split(".")[0]) < 18) throw new Error(`${host} has Node ${found.version}; the app's helper needs 18 or newer. Update it and connect again.`)
    node = found.node
    return found
  }

  /** The helper's file, put there whole or not at all: written to a name of its own, checked
   *  (its size and hash) and only then given its name. A connection that drops halfway leaves
   *  nothing under the name the probe looks for. */
  async function upload() {
    const script = [
      `umask 077 && mkdir -p "${dir}" || exit 1`,
      `t="${file}.$$.tmp"`,
      `cat > "$t" && ${shq(node)} -e ${shq(CHECK)} "$t" ${bundle.length} ${digest} && mv -f "$t" "${file}" && exit 0`,
      'rm -f "$t"; exit 1',
    ].join("\n")
    const r = await remote(`sh -c ${shq(script)}`, bundle)
    if (r.code !== 0) throw new Error(`Can't put the app's helper on ${host}: ${r.err.trim() ? sshError(host, r.err, r.code) : "it did not arrive whole; connect again"}`)
  }

  async function daemon() {
    const r = await remote(`${shq(node)} "${file}" daemon`)
    if (/^B42 READY$/m.test(r.out)) return
    const failed = /^B42 FAILED (.*)$/m.exec(r.out)?.[1]?.trim()
    throw new Error(`The app's helper did not start on ${host}: ${failed || ((r.out + r.err).trim().split("\n").at(-1) ?? `exit ${r.code}`)}`)
  }

  /** Everything up to a helper that runs: the connection, node, the helper's file, the daemon. */
  async function bootstrap() {
    await master()
    const found = await probe()
    if (!found.have) await upload()
    await daemon()
  }

  // ── the attached helper ────────────────────────────────────────────────────────────────────────

  let link: ChildProcess | undefined
  let reach: Reach = { status: "down", error: `Connecting to ${host}…` }
  const reachListeners = new Set<(r: Reach) => void>()
  const setReach = (r: Reach) => {
    if (r.status === reach.status && (r.status === "up" || (reach.status === "down" && reach.error === r.error))) return
    reach = r
    for (const l of reachListeners) l(r)
  }
  let seq = 0
  const pending = new Map<number, Pending>()
  const children = new Map<string, RemoteChild>()
  /** Started here, not yet known there (the spawn's answer did not come yet). */
  const starting = new Set<RemoteChild>()
  /** Spawns whose answer has not come, and kills whose answer has not: close() waits for them. */
  const spawning = new Set<Promise<void>>()
  const killing = new Set<Promise<void>>()
  /** close() was called: nothing is tried again, and once what is being ended is, `closed`. */
  let closing: Promise<void> | undefined
  let closed = false
  let info: { home: string; platform: NodeJS.Platform; hostname: string; devNull: string } | undefined

  function send(msg: unknown) {
    if (link?.stdin?.writable) link.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  function call<T>(method: string, params: Record<string, unknown> = {}, ms = sshTiming.call): Promise<T> {
    if (closed) return Promise.reject(new Error(`The connection to ${host} was closed.`))
    if (reach.status !== "up" || !link) return Promise.reject(new Error(`Can't reach ${host} now.`))
    const id = ++seq
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject }
      if (ms) p.timer = setTimeout(() => (pending.delete(id), reject(new Error(`${host} did not answer in ${ms / 1000} s`))), ms)
      pending.set(id, p)
      send({ id, method, params })
    })
  }

  function onLine(line: string) {
    let msg: { id?: number; result?: unknown; error?: { message: string; code?: string }; ev?: string; hid?: string; fd?: number; at?: number; data?: string; code?: number | null; signal?: string | null }
    try {
      msg = JSON.parse(line)
    } catch {
      return log("warn", `the helper on ${host} said something that is not JSON`, line.slice(0, 200))
    }
    if (msg.ev) {
      const c = msg.hid ? children.get(msg.hid) : undefined
      if (!c) return
      if (msg.ev === "data") c.data(msg.fd ?? 1, msg.at ?? 0, Buffer.from(msg.data ?? "", "base64"))
      else if (msg.ev === "exit") c.exit({ code: msg.code ?? null, signal: msg.signal ?? null, ...(msg.error ? { error: msg.error } : {}) })
      return
    }
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined
    if (!p) return
    pending.delete(msg.id!)
    clearTimeout(p.timer)
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), msg.error.code ? { code: msg.error.code } : {}))
    else p.resolve(msg.result)
  }

  /** Attaches to the helper (`ssh host node helper attach`): resolves once it answered hello. */
  function attachOnce(): Promise<{ procs: Array<{ hid: string; owner: string; launch?: number; exited?: true }> }> {
    return new Promise((resolve, reject) => {
      const child = spawn(ssh, [...common, "-o", "ControlMaster=no", "-T", "--", host, `${shq(node)} "${file}" attach`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      link = child
      let buf = ""
      let err = ""
      let hello = false
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString("utf8")
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim()) onLine(line)
        }
      })
      child.stderr!.on("data", (d: Buffer) => void (err = (err + d.toString("utf8")).slice(-4000)))
      child.stdin!.on("error", () => undefined)
      child.on("error", (e) => {
        if (!hello) reject(e)
      })
      child.on("close", (code) => {
        if (link !== child) return
        link = undefined
        const why = sshError(host, err, code)
        for (const [id, p] of pending) (pending.delete(id), clearTimeout(p.timer), p.reject(new Error(`Can't reach ${host}: the connection ended.`)))
        if (!hello) return reject(new Error(why))
        log("warn", `the connection to ${host} ended`, why)
        down(`Can't reach ${host}.`)
      })
      // hello is sent before "up": calls wait for it.
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        child.kill()
        reject(new Error(`The app's helper on ${host} did not answer.`))
      }, sshTiming.step)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          hello = true
          resolve(v as never)
        },
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      send({ id, method: "hello", params: { owner, launch } })
    })
  }

  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = sshTiming.retryMin
  let connecting: Promise<void> | undefined

  /** Until the first connect is done, a failure is the reviewer's to read, and nothing is tried again. */
  let first = true
  function down(error: string) {
    setReach({ status: "down", error })
    if (!closed && !closing && !first) later()
  }
  function later() {
    clearTimeout(retryTimer)
    const wait = retryDelay
    retryDelay = Math.min(retryDelay * 2, sshTiming.retryMax)
    retryTimer = setTimeout(() => void reconnect().catch(() => undefined), wait)
  }

  /** Everything again: the connection, the helper (it may have been ended: a reboot), attaching;
   *  then each process of the app's is taken up where its output was read to, its forwards made
   *  again. A process the helper no longer has ended while the app was away, with the helper. */
  function reconnect(): Promise<void> {
    connecting ??= (async () => {
      try {
        await bootstrap()
        const hello = await attachOnce()
        const theirs = new Set(hello.procs.map((p) => p.hid))
        retryDelay = sshTiming.retryMin
        setReach({ status: "up" })
        info ??= await call("info")
        // What this install of the app started there in an earlier run, and no longer knows:
        // ended, as an agent on this computer ends with the app. Never this run's own, which
        // another connection of it to the same computer (typed another way) may be using.
        for (const p of hello.procs)
          if (p.owner === owner && (p.launch ?? 0) < launch && !children.has(p.hid)) void call("kill", { hid: p.hid }).then(() => call("reap", { hid: p.hid })).catch(() => undefined)
        for (const [hid, c] of children) {
          if (!theirs.has(hid)) {
            c.exit({ code: null, signal: null, error: { message: `it was lost on ${host} (the app's helper there was ended)` } })
            continue
          }
          // Ended while the computer could not be reached: ended now.
          if (c.ended) void killThere(hid)
          void resume(c)
        }
        for (const c of starting) void start(c)
        for (const [port, f] of forwards) await openForward(port, f.local, f.host).catch((err) => log("warn", `can't forward port ${port} from ${host} again`, String(err)))
      } catch (err) {
        if (!closed) down(err instanceof Error ? err.message : String(err))
        throw err
      } finally {
        connecting = undefined
      }
    })()
    return connecting
  }

  async function resume(c: RemoteChild) {
    try {
      const r = await call<{ gone?: true; inAt: number; gap: boolean }>("resume", { hid: c.hid, out: c.out, err: c.err })
      if (r.gone) return c.exit({ code: null, signal: null, error: { message: `it was lost on ${host}` } })
      c.inAt = r.inAt
      c.flush()
    } catch (err) {
      log("warn", `can't take up the agent's process on ${host} again`, String(err))
    }
  }

  // ── processes ─────────────────────────────────────────────────────────────────────────────────

  /** Asks the helper to end a process there; settles once it is ended (it answers after its
   *  group is gone), or could not be asked. */
  function killThere(hid: string): Promise<void> {
    const k = call("kill", { hid }, sshTiming.kill).then(
      () => undefined,
      () => undefined,
    )
    killing.add(k)
    void k.finally(() => killing.delete(k))
    return k
  }

  function start(c: RemoteChild & { spawnArgs?: Record<string, unknown> }): Promise<void> {
    const s = startOnce(c)
    spawning.add(s)
    void s.finally(() => spawning.delete(s))
    return s
  }
  async function startOnce(c: RemoteChild & { spawnArgs?: Record<string, unknown> }) {
    if (c.ended) {
      starting.delete(c)
      return c.exit({ code: null, signal: "SIGTERM" })
    }
    try {
      const r = await call<{ hid: string }>("spawn", { ...c.spawnArgs, owner, launch })
      starting.delete(c)
      c.hid = r.hid
      children.set(r.hid, c)
      // Ended while it was starting: ended now that it has (its exit comes as any other's).
      if (c.ended) return void (await killThere(r.hid))
      c.flush()
    } catch (err) {
      // Not reachable now: tried again on the next attach. Any other failure ends it.
      if (reach.status === "up") {
        starting.delete(c)
        c.exit({ code: null, signal: null, error: { message: err instanceof Error ? err.message : String(err) } })
      }
    }
  }

  function spawnRemote(program: string, args: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}): Child {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const gapListeners = new Set<() => void>()
    let resolveExit!: (e: Exit) => void
    const exited = new Promise<Exit>((r) => (resolveExit = r))
    let ackTimer: ReturnType<typeof setTimeout> | undefined
    let writing = false
    let finished = false
    const c: RemoteChild & { spawnArgs: Record<string, unknown> } = {
      spawnArgs: { program, args, cwd: o.cwd, env: o.env },
      out: 0,
      err: 0,
      unsent: [],
      inAt: 0,
      ended: false,
      stdout,
      stderr,
      exited,
      stdin: new Writable({
        write(chunk: Buffer, _enc, done) {
          const at = c.unsent.length ? c.unsent.at(-1)!.at + c.unsent.at(-1)!.data.length : c.inAt
          c.unsent.push({ at, data: Buffer.from(chunk) })
          c.flush()
          done()
        },
      }),
      kill() {
        c.ended = true
        // Still starting: ended once it has (start). Out of reach: ended when it is back (reconnect).
        return c.hid ? killThere(c.hid) : Promise.resolve()
      },
      onGap: (l) => void gapListeners.add(l),
      data(fd, at, bytes) {
        const read = fd === 1 ? c.out : c.err
        // Sent again after a reconnect: read once.
        if (at + bytes.length <= read) return
        if (at < read) bytes = bytes.subarray(read - at)
        // What came between was dropped there: a partial line is ended, and the reader told.
        else if (at > read && fd === 1) {
          log("warn", `some of the agent's output on ${host} was lost while the app was away`)
          stdout.write("\n")
          for (const l of gapListeners) l()
        }
        const now = Math.max(at, read) + bytes.length
        if (fd === 1) (c.out = now), stdout.write(bytes)
        else (c.err = now), stderr.write(bytes)
        // At most every so often, however much comes: the helper lets go of what was read.
        ackTimer ??= setTimeout(() => {
          ackTimer = undefined
          if (c.hid) send({ method: "ack", params: { hid: c.hid, out: c.out, err: c.err } })
        }, sshTiming.ack)
      },
      exit(e) {
        if (finished) return
        finished = true
        if (c.hid) {
          children.delete(c.hid)
          void call("reap", { hid: c.hid }).catch(() => undefined)
        }
        clearTimeout(ackTimer)
        stdout.end()
        stderr.end()
        resolveExit(e)
      },
      /** Sends what waits for stdin, in order, one write at a time. */
      flush() {
        if (writing || !c.hid || reach.status !== "up") return
        const first = c.unsent[0]
        if (!first) return
        writing = true
        call<{ inAt: number }>("write", { hid: c.hid, at: first.at, data: first.data.toString("base64") })
          .then((r) => {
            c.inAt = r.inAt
            while (c.unsent.length && c.unsent[0]!.at + c.unsent[0]!.data.length <= r.inAt) c.unsent.shift()
          })
          .catch((err) => {
            // Not reachable: the next attach sends it. Refused by the helper (the process has
            // ended there): it never will be, and is let go.
            if (reach.status !== "up" || !link) return
            log("warn", `can't write to the agent's process on ${host}`, String(err))
            c.unsent = []
          })
          .finally(() => {
            writing = false
            if (reach.status === "up") c.flush()
          })
      },
    }
    starting.add(c)
    void start(c)
    return c
  }

  // ── port forwards ────────────────────────────────────────────────────────────────────────────

  const forwards = new Map<number, { local: number; host: string }>()
  /** The port free on 127.0.0.1 here (where ssh listens for a forward, and what the page opens). */
  const free = (port: number) =>
    new Promise<number | undefined>((resolve) => {
      const s = net.createServer()
      s.once("error", () => resolve(undefined))
      s.listen(port, "127.0.0.1", () => {
        const got = (s.address() as net.AddressInfo).port
        s.close(() => resolve(got))
      })
    })
  async function openForward(port: number, local: number, there: string) {
    await master()
    // An IPv6 address in brackets, as ssh reads it.
    const to = there.includes(":") ? `[${there}]` : there
    const r = await sshRun([...common, "-O", "forward", "-L", `127.0.0.1:${local}:${to}:${port}`, "--", host], undefined, 15_000)
    if (r.code !== 0) throw new Error(`Can't forward port ${port} from ${host}: ${sshError(host, r.err, r.code)}`)
  }

  // ── the machine ──────────────────────────────────────────────────────────────────────────────

  const P = path.posix
  const machine: RemoteMachine = {
    host,
    owner,
    where: host,
    local: false,
    get home() {
      return info?.home ?? "/"
    },
    get platform() {
      return info?.platform ?? "linux"
    },
    path: P,
    get devNull() {
      return info?.devNull ?? "/dev/null"
    },
    hostname: () => info?.hostname ?? host,
    run: (program, args, options) => call<RunResult>("run", { program, args, options }, 0),
    spawn: spawnRemote,
    agentEnv: () => call<Record<string, string>>("agentEnv"),
    which: (program, env) => call<string | null>("which", { program, env }).then((x) => x ?? undefined),
    stat: (p) => call<Stat>("stat", { path: p }),
    lstat: (p) => call<Stat>("lstat", { path: p }),
    readdir: (p) => call<Entry[]>("readdir", { path: p }),
    readFile: (p) => call<string>("readFile", { path: p }),
    writeFile: (p, data, mode) => call<void>("writeFile", { path: p, data, ...(mode !== undefined ? { mode } : {}) }),
    mkdir: (p) => call<void>("mkdir", { path: p }),
    rename: (from, to) => call<void>("rename", { from, to }),
    rm: (p) => call<void>("rm", { path: p }),
    realpath: (p) => call<string>("realpath", { path: p }),
    reach: () => reach,
    onReach(l) {
      reachListeners.add(l)
      return () => reachListeners.delete(l)
    },

    async forward(port, there = "localhost", want) {
      const known = forwards.get(port)
      if (known && (!want || known.local === want)) return known.local
      const local = want ? await free(want) : ((await free(port)) ?? (await free(0)))
      if (!local) throw new Error(want ? `Port ${want} is taken on this computer, so ${host}'s port ${port} can't be opened at it.` : "No port is free on this computer for the site.")
      await openForward(port, local, there)
      forwards.set(port, { local, host: there })
      log("info", `forwarded ${host}'s port ${port} to localhost:${local}`)
      return local
    },

    retry() {
      if (closed || closing || reach.status === "up") return
      clearTimeout(retryTimer)
      retryDelay = sshTiming.retryMin
      void reconnect().catch(() => undefined)
    },

    close() {
      closing ??= (async () => {
        clearTimeout(retryTimer)
        // Nothing this connection started there is left to no one: what still runs is ended, what
        // is still starting is ended once it has, and that is waited for, a few seconds at most
        // (a host that answers slowly; one out of reach is not waited for: its helper ends them).
        for (const c of [...children.values(), ...starting]) void c.kill()
        await Promise.race([
          Promise.allSettled([...spawning]).then(() => Promise.allSettled([...killing])),
          new Promise((r) => setTimeout(r, sshTiming.kill)),
        ])
        closed = true
        for (const [id, p] of pending) (pending.delete(id), clearTimeout(p.timer), p.reject(new Error(`The connection to ${host} was closed.`)))
        link?.stdin?.end()
        link?.kill()
        link = undefined
        forwards.clear()
        await sshRun([...common, "-O", "exit", "--", host], undefined, 5_000)
        setReach({ status: "down", error: `The connection to ${host} was closed.` })
      })()
      return closing
    },
  }

  // The first connect: a failure is the reviewer's to read, not something to try again.
  try {
    await reconnect()
  } catch (err) {
    closed = true
    link?.kill()
    throw err
  }
  first = false
  return machine
}
