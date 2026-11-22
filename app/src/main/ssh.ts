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
//                    as a daemon; the app attaches to it with `ssh host <node> ~/… attach`
//   connecting       attach first: a helper that runs is all a reconnect (or the app's next
//                    start) needs. Only when none does is it started, by scripts sent on stdin
//                    to `sh -s` (whatever the login shell: bash, zsh, fish, csh; Windows's is
//                    said), which find the newest node of 18 or later on both PATHs (said in
//                    marker lines, so a noisy profile is not read), start the helper in the same
//                    session when it is there, and put it there when not. The node chosen is
//                    remembered per host (data/ssh/nodes.json). Why it did not start is the
//                    daemon's "B42 FAILED <code> <sentence>"
//   reconnecting     when the connection drops (the Mac sleeps, the network goes) the agent goes
//                    on working there; the app attaches again, with a growing pause, and reads
//                    what it missed, which the helper kept (machine.Child.onGap when that was too
//                    much). Meanwhile the machine is "down" (reach), and what is written to the
//                    agent waits here.
//   the site         the address the agent reports on its localhost is forwarded here (forward)
//   the wire         one JSON message per line (src/shared/wire.ts): split on the newline byte and
//                    decoded whole, LINE_MAX at most each way (a longer one from there drops the
//                    link with a sentence; one the app would send is refused before it goes); a
//                    helper that does not speak PROTOCOL is refused; each spawn has a key, so one
//                    sent again after a drop is the same process there
import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import { LINE_MAX, lineReader, PROTOCOL, sizeOf, WRITE_CHUNK } from "../shared/wire"
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

/** What the app keeps of what an ssh command (the probe, the upload, the daemon's start, a control
 *  command) prints, each stream: its last bytes. Theirs is a line or two; a login shell's banner
 *  is less than this. More on stdout ends the command: no answer of the helper's is that long. */
export const SSH_OUT_MAX = 1024 * 1024

export type RemoteMachine = Machine & {
  readonly host: string
  /** This install of the app's id: what it keeps there is under it, apart from another install's. */
  readonly owner: string
  /** A port on the other computer's localhost, opened here on 127.0.0.1: the local port (`local`
   *  when given, else the same number when it is free here, else any). `host`: the address the
   *  agent's server listens on there. */
  forward(port: number, host?: string, local?: number): Promise<number>
  /** A call to the helper there, answered or failed (no time limit with `ms` 0): what ops.ts asks
   *  of it, the work done where the files are. */
  helper<T>(method: string, params: Record<string, unknown>, ms?: number): Promise<T>
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
  /** The step of connecting under way ("Starting the app's helper on dev-box…"), for a window
   *  that waits on a slow link. */
  onStep?(text: string): void
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
  // A key that changed is not one to accept: never "answer yes".
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed|Offending .* key in/i.test(all))
    return `${host}'s host key has changed since this computer last connected to it. That can mean someone is between you and ${host} (an attack), or that ${host} was set up again. Don't connect until whoever runs ${host} has told you its new key's fingerprint and you have checked it; the app will not connect meanwhile.`
  if (/Host key verification failed|No (ED25519|ECDSA|RSA)? ?host key is known/i.test(all))
    return `${host}'s host key is not known on this computer yet. ${once}, check the fingerprint and answer yes, then connect again.`
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
export function ownerOf(dataDir: string) {
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
 *  others could use it, and what others put in it then goes). Arguments: that folder, the helper's
 *  file, its sha1. Exits 0 when the helper is there and the folder is fine: the daemon is started
 *  next, in the same session. */
const PROBE = [
  'const fs = require("fs"), c = require("crypto"), p = require("path"); const [d, f, h] = process.argv.slice(1); let dir = "none"',
  'try { const s = fs.lstatSync(d); const uid = process.getuid && process.getuid(); if (!s.isDirectory()) dir = "notdir"; else if (uid !== undefined && s.uid !== uid) dir = "notmine"; else { dir = "ok"; if (s.mode & 0o077) { fs.chmodSync(d, 0o700); for (const n of fs.readdirSync(d)) { try { if (uid !== undefined && fs.lstatSync(p.join(d, n)).uid !== uid) fs.rmSync(p.join(d, n), { recursive: true, force: true }) } catch {} } } } } catch {}',
  'let have = false; try { have = c.createHash("sha1").update(fs.readFileSync(f)).digest("hex") === h } catch {}',
  'process.stdout.write("B42 " + JSON.stringify({ node: process.execPath, version: process.versions.node, platform: process.platform, have, dir }) + "\\n")',
  'process.exit(have && (dir === "ok" || dir === "none") ? 0 : 5)',
].join("\n")
/** Reads the helper as base64 from stdin, and writes it to a file of its own only when it has this
 *  many bytes and this sha1 (else exits 9). Arguments: the file, size, sha1. */
const WRITE = 'const [f, n, h] = process.argv.slice(1); const fs = require("fs"); const parts = []; process.stdin.on("data", (d) => parts.push(d)); process.stdin.on("end", () => { const b = Buffer.from(Buffer.concat(parts).toString("latin1"), "base64"); if (b.length !== Number(n) || require("crypto").createHash("sha1").update(b).digest("hex") !== h) process.exit(9); fs.writeFileSync(f, b, { mode: 0o600 }) })'

/** The helper's folder and file there, as the scripts (POSIX sh, on stdin) name them. */
const HELPER_DIR = '"$HOME/.bicycle42"'
const helperAt = (version: string) => `"$HOME/.bicycle42/helper-${version}.js"`

/** What `sh -s` reads there to find its node and start the helper. Every shell a login can have
 *  (bash, zsh, fish, csh, even PowerShell) runs `sh -s` the same way, and this script is sh's
 *  alone, whatever the login shell's own syntax: no command line of the app's is a script.
 *
 *  Node is looked for where a command finds it (this shell's PATH) and where an interactive login
 *  shell does (its PATH, read with `env` from the login shell, which every shell runs the same
 *  way: nvm, mise, Homebrew), and at the path that worked last time; each is said on a line of its
 *  own ("B42NODE <path> <version>"), so whatever a noisy profile prints around them is not read.
 *  The newest of 18 or later is used: it says what it found ("B42 {…}"), and when this version's
 *  helper is there whole, starts it ("B42 READY", or "B42 FAILED <code> <sentence>"). */
export function probeScript(o: { version: string; digest: string; remembered?: string }): string {
  return [
    "set -f",
    `D=${HELPER_DIR}`,
    `F=${helperAt(o.version)}`,
    `H=${o.digest}`,
    `R=${shq(o.remembered ?? "")}`,
    "nl='",
    "'",
    "cands=",
    'add() { [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] || return 0; case "$nl$cands" in *"$nl$1$nl"*) return 0 ;; esac; cands="$cands$1$nl"; }',
    'add "$R"',
    'add "$(command -v node 2>/dev/null)"',
    "was=$IFS",
    "IFS=:",
    'for d in $PATH; do add "${d:-.}/node"; done',
    "IFS=$was",
    // The login shell's PATH: as an interactive login shell has it, else a login shell, else any
    // (tcsh takes -l only alone). What its profile prints is not a line starting PATH=.
    // A profile that never finishes (a loop, one that waits for a terminal) is ended after 10 s
    // with SIGKILL, which an interactive shell can't ignore as it does SIGTERM (so `timeout`
    // would not do, and macOS has none): the shell runs in the background beside a watchdog,
    // its output to a file of its own. Then no other way of asking it is tried, and it is said.
    "lp=",
    "slow=",
    'tmp=$(mktemp 2>/dev/null) || tmp=',
    'if [ -n "$tmp" ]; then',
    "  for f in -ilc -lc -c; do",
    `    "\${SHELL:-/bin/sh}" $f env </dev/null >"$tmp" 2>/dev/null &`,
    "    p=$!",
    "    ( trap 'kill $s 2>/dev/null; exit 0' TERM; sleep 10 & s=$!; wait $s; kill -9 $p 2>/dev/null ) >/dev/null 2>&1 &",
    "    w=$!",
    "    wait $p",
    "    st=$?",
    "    kill $w 2>/dev/null",
    `    [ "$st" -eq 137 ] && { slow=1; echo "B42 SLOWPROFILE"; break; }`,
    `    lp=$(sed -n 's/^PATH=//p' "$tmp" | tail -n 1)`,
    '    [ -n "$lp" ] && break',
    "  done",
    '  rm -f "$tmp"',
    "fi",
    "IFS=:",
    'for d in $lp; do add "${d:-.}/node"; done',
    "IFS=$was",
    "found=",
    'while IFS= read -r c; do',
    '  [ -n "$c" ] || continue',
    '  v=$("$c" -v </dev/null 2>/dev/null) || continue',
    '  case "$v" in v[0-9]*) echo "B42NODE $c ${v#v}"; found="${found}B42NODE $c ${v#v}$nl" ;; esac',
    "done <<B42EOF",
    "$cands",
    "B42EOF",
    // The newest of 18 or later, and of two the same, the one found first: versions as numbers,
    // padded, then the order found, backwards, sorted as text.
    `best=$(printf '%s' "$found" | awk '{ v = $NF; split(v, a, "."); if (a[1] + 0 >= 18) printf "%09d%09d%09d%09d %s\\n", a[1], a[2], a[3], 999999999 - NR, substr($0, 9, length($0) - 9 - length(v)) }' | sort | tail -n 1 | cut -c38-)`,
    '[ -n "$best" ] || { echo "B42 NONODE${slow:+ SLOWPROFILE}"; exit 0; }',
    `if "$best" -e ${shq(PROBE)} "$D" "$F" "$H"; then exec "$best" "$F" daemon; fi`,
    "exit 0",
    "",
  ].join("\n")
}

/** What `sh -s` reads there to put the helper in place whole (written to a name of its own,
 *  checked, only then given its name) and start it: the file itself is in the script, as base64. */
export function uploadScript(o: { version: string; node: string; bundle: Buffer; digest: string }): string {
  const b64 = o.bundle.toString("base64").replace(/.{1,76}/g, "$&\n")
  return [
    `D=${HELPER_DIR}`,
    `F=${helperAt(o.version)}`,
    `N=${shq(o.node)}`,
    'umask 077 && mkdir -p "$D" || exit 1',
    't="$F.$$.tmp"',
    `"$N" -e ${shq(WRITE)} "$t" ${o.bundle.length} ${o.digest} <<'B42EOF' || { rm -f "$t"; echo "B42 BROKEN"; exit 1; }`,
    `${b64}B42EOF`,
    'mv -f "$t" "$F" || exit 1',
    'exec "$N" "$F" daemon',
    "",
  ].join("\n")
}

/** Whether what a login shell said is Windows's: cmd.exe's or PowerShell's word for a command it
 *  does not have (`sh`). */
export const saysWindows = (said: string) => /is not recognized as an internal or external command|CommandNotFoundException|The term 'sh' is not recognized/i.test(said)

/** The nodes the probe found there, by its marker lines. */
export function nodesSaid(out: string): Array<{ path: string; version: string }> {
  const found: Array<{ path: string; version: string }> = []
  for (const line of out.split("\n")) {
    const m = /^B42NODE (.+) (\d+\.\d+\.\d+\S*)$/.exec(line.trim())
    if (m) found.push({ path: m[1]!, version: m[2]! })
  }
  return found
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout> }

/** One process of the agent's on the other computer, as `Child`. Its output comes through the
 *  helper with where it begins, so what is sent again after a reconnect is read once; what is
 *  written to it waits here while the computer can't be reached, and is sent again from where the
 *  helper says it got to. */
type RemoteChild = Child & {
  hid?: string
  /** Its spawn's key there: the same spawn sent again is the same process. */
  key: string
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
  /** This connection's own: each process it starts there has a key under it (spawn), so one sent
   *  again is known, and on attaching again what it started and no longer knows of is ended. */
  const instance = crypto.randomBytes(6).toString("hex")
  let spawned = 0

  const common = [
    "-o", "BatchMode=yes",
    // The reviewer's ssh agent and display are not lent to the other computer: what runs there
    // (the agent, what it starts) could use them for as long as the connection lasts, whatever
    // their ~/.ssh/config says for that host.
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ForwardX11Trusted=no",
    "-o", `ControlPath="${ctl.replace(/%/g, "%%")}"`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
  ]

  /** ssh with these words, to its end (or the timeout): what it printed, the last SSH_OUT_MAX
   *  bytes of each stream. More than that on stdout ends it, and its last line says so. */
  function sshRun(args: string[], input?: Buffer | string, ms = sshTiming.step): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(ssh, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      const tail = () => {
        let bufs: Buffer[] = []
        let size = 0
        return {
          total: 0,
          push(b: Buffer) {
            this.total += b.length
            bufs.push(b)
            size += b.length
            while (size - bufs[0]!.length >= SSH_OUT_MAX) size -= bufs.shift()!.length
          },
          text() {
            const all = Buffer.concat(bufs)
            bufs = []
            return all.subarray(Math.max(0, all.length - SSH_OUT_MAX)).toString("utf8")
          },
        }
      }
      const out = tail()
      const err = tail()
      let flood = false
      const timer = setTimeout(() => child.kill(), ms)
      child.stdout.on("data", (b: Buffer) => {
        out.push(b)
        if (out.total > SSH_OUT_MAX && !flood) (flood = true), child.kill()
      })
      child.stderr.on("data", (b: Buffer) => err.push(b))
      child.on("error", (e) => {
        clearTimeout(timer)
        resolve({ code: null, out: "", err: (e as NodeJS.ErrnoException).code === "ENOENT" ? `ssh was not found on this computer (${ssh})` : String(e) })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        const said = err.text()
        resolve(flood ? { code: null, out: out.text(), err: `${said}\n${host} printed more than ${sizeOf(SSH_OUT_MAX)}, which no step of connecting does: it was stopped` } : { code, out: out.text(), err: said })
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

  /** The node there that runs the helper: the one the probe chose, remembered for this host
   *  (attaching needs it before anything else is asked). */
  const nodesFile = path.join(o.dataDir, "ssh", "nodes.json")
  const nodes = (): Record<string, string> => {
    try {
      const all = JSON.parse(fs.readFileSync(nodesFile, "utf8")) as Record<string, unknown>
      return Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => typeof e[1] === "string"))
    } catch {
      return {}
    }
  }
  let node: string | undefined = nodes()[host]
  const remember = (found: string) => {
    if (node === found && nodes()[host] === found) return
    node = found
    try {
      const tmp = `${nodesFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ ...nodes(), [host]: found }), { mode: 0o600 })
      fs.renameSync(tmp, nodesFile)
    } catch (err) {
      log("warn", `can't remember ${host}'s node`, String(err))
    }
  }
  /** The step of connecting under way, said for a slow link. */
  const step = (text: string) => {
    if (first) o.onStep?.(text)
  }

  /** A script for `sh -s` there, on its stdin: the command line is those two words, which every
   *  login shell runs the same way. */
  const script = (text: string) => sshRun([...common, "-o", "ControlMaster=no", "-T", "--", host, "sh -s"], text)

  /** What a step's script said: the helper started, or why not, as a sentence. */
  function started(r: { code: number | null; out: string; err: string }, at: string) {
    if (/^B42 READY$/m.test(r.out)) return
    const failed = /^B42 FAILED (\S+) (.*)$/m.exec(r.out)
    if (failed) throw new Error(`The app's helper did not start on ${host}: ${failed[2]!.trim()} (${failed[1]}, with Node ${at}).`)
    // Node's own dump of an error, if that is what came: its line that names the error, never
    // its last ("Node.js v22.12.0", "}").
    const lines = (r.out + r.err).split("\n").map((l) => l.trim()).filter((l) => l && !/^Node\.js v[\d.]+$/.test(l) && !/^[{}\]^]+$/.test(l))
    const said = lines.filter((l) => /^\w*Error\b|\berror:/.test(l)).at(-1) ?? lines.at(-1)
    throw new Error(`The app's helper did not start on ${host}: ${said ?? `exit ${r.code}`} (with Node ${at}).`)
  }

  /** Finds the node there and starts the helper when it is there whole. Says what it found. */
  async function probe() {
    const r = await script(probeScript({ version, digest, remembered: node }))
    const line = r.out.split("\n").reverse().find((l) => l.startsWith("B42 ") && !/^B42 (READY|FAILED|SLOWPROFILE)/.test(l))
    if (/^B42 SLOWPROFILE$/m.test(r.out)) log("warn", `the login shell's profile on ${host} did not finish in 10 s: node was looked for without it`)
    if (!line) {
      // Only a computer whose shell never ran the script (no answer of its) is said to be Windows:
      // a profile that merely prints PowerShell's words is not.
      if (saysWindows(r.out + r.err)) throw new Error(`${host} runs Windows (its login shell is cmd.exe or PowerShell), which the app can't work on over ssh yet.`)
      // ssh's own failure, or a step stopped (it printed without end): what was said of it.
      if (r.code !== 0 || !r.out.trim()) throw new Error(sshError(host, r.err, r.code))
      throw new Error(`${host} did not answer as expected: ${r.out.trim().slice(-200) || r.err.trim().slice(-200)}`)
    }
    const all = nodesSaid(r.out)
    if (line.startsWith("B42 NONODE")) {
      if (/SLOWPROFILE/.test(line) && !all.length)
        throw new Error(`The app needs Node 18 or newer on ${host} for its helper. \`node\` was not found on the PATH there, and its login shell's profile did not finish in 10 s, so the PATH it sets up could not be read. Look at the profile (~/.bashrc, ~/.zshrc, ~/.config/fish) for something that waits, then connect again.`)
      if (all.length)
        throw new Error(`The app needs Node 18 or newer on ${host} for its helper, and found only ${all.map((n) => `Node ${n.version} (${n.path})`).join(", ")}. Install a newer one (nodejs.org, nvm, or your package manager) and connect again.`)
      throw new Error(`The app needs Node 18 or newer on ${host} for its helper, and \`node\` was not found there. Install it (nodejs.org, or your package manager) and connect again.`)
    }
    const found = JSON.parse(line.slice(4)) as { node: string; version: string; platform: string; have: boolean; dir?: string }
    if (found.dir === "notdir") throw new Error(`~/.bicycle42 on ${host} is not a folder (a link, or a file): move it away there and connect again.`)
    if (found.dir === "notmine") throw new Error(`~/.bicycle42 on ${host} belongs to another user there: move it away and connect again.`)
    if (found.platform === "win32") throw new Error(`${host} runs Windows, which the app can't work on over ssh yet.`)
    const at = `${found.version} at ${found.node}`
    // The path the probe ran, as the shell found it (process.execPath may be a link's target).
    const chosen = all.find((n) => n.version === found.version)?.path ?? found.node
    remember(chosen)
    // The helper was there: the daemon ran next, in the same session.
    if (found.have) started(r, at)
    return { ...found, at }
  }

  /** The helper's file, put there whole or not at all (written to a name of its own, checked by
   *  its size and hash, only then given its name), and started. */
  async function upload(at: string) {
    const r = await script(uploadScript({ version, node: node!, bundle, digest }))
    if (/^B42 BROKEN$/m.test(r.out)) throw new Error(`Can't put the app's helper on ${host}: it did not arrive whole; connect again.`)
    if (r.code === 255 && !/^B42 /m.test(r.out)) throw new Error(`Can't put the app's helper on ${host}: ${sshError(host, r.err, r.code)}`)
    started(r, at)
  }

  /** Everything up to a helper that runs: node there, the helper's file, the daemon. The
   *  connection is made before. */
  async function bootstrap() {
    step(`Starting the app's helper on ${host}…`)
    const found = await probe()
    if (!found.have) {
      step(`Putting the app's helper on ${host}…`)
      await upload(found.at)
    }
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

  /** A message as its line, or a sentence: one longer than the helper takes is never sent (it
   *  would drop the connection, and everything waiting on it). */
  function lineOf(msg: unknown): Buffer {
    const line = Buffer.from(`${JSON.stringify(msg)}\n`)
    if (line.length - 1 > LINE_MAX) throw Object.assign(new Error(`That is ${sizeOf(line.length - 1)} to send to ${host}, more than the ${sizeOf(LINE_MAX)} the app sends at once.`), { code: "E2BIG" })
    return line
  }
  function send(msg: unknown) {
    if (link?.stdin?.writable) link.stdin.write(lineOf(msg))
  }

  function call<T>(method: string, params: Record<string, unknown> = {}, ms = sshTiming.call): Promise<T> {
    if (closed) return Promise.reject(new Error(`The connection to ${host} was closed.`))
    if (reach.status !== "up" || !link) return Promise.reject(new Error(`Can't reach ${host} now.`))
    const id = ++seq
    let line: Buffer
    try {
      line = lineOf({ id, method, params })
    } catch (err) {
      return Promise.reject(err)
    }
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject }
      if (ms) p.timer = setTimeout(() => (pending.delete(id), reject(new Error(`${host} did not answer in ${ms / 1000} s`))), ms)
      pending.set(id, p)
      if (link?.stdin?.writable) link.stdin.write(line)
    })
  }

  function onLine(line: string) {
    let msg: { id?: number; result?: unknown; error?: { message: string; code?: string }; ev?: string; hid?: string; fd?: number; at?: number; data?: string; code?: number | null; signal?: string | null }
    try {
      msg = JSON.parse(line)
    } catch {
      return log("warn", `the helper on ${host} said something that is not JSON`, line.slice(0, 200))
    }
    if (!msg || typeof msg !== "object") return log("warn", `the helper on ${host} said something that is not a message`, line.slice(0, 200))
    if (msg.ev) {
      const c = msg.hid ? children.get(msg.hid) : undefined
      if (!c) return
      if (msg.ev === "data" && typeof msg.data === "string" && Number.isSafeInteger(msg.at) && msg.at! >= 0) c.data(msg.fd === 2 ? 2 : 1, msg.at!, Buffer.from(msg.data, "base64"))
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

  /** Attaches to the helper (`ssh host <node> ~/.bicycle42/helper-<version>.js attach`: words
   *  every login shell reads alike): resolves once it answered hello, in this app's protocol.
   *  Rejects with `noHelper` when nothing of this version listens there (or its file or that node
   *  is gone): the helper is to be started. */
  function attachOnce(): Promise<{ protocol?: number; procs: Array<{ hid: string; owner: string; launch?: number; key?: string; exited?: true }> }> {
    return new Promise((resolve, reject) => {
      const child = spawn(ssh, [...common, "-o", "ControlMaster=no", "-T", "--", host, `${shq(node ?? "node")} ~/.bicycle42/helper-${version}.js attach`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      link = child
      let err = ""
      let hello = false
      /** Why the app ended this link itself: said instead of ssh's words. */
      let why: string | undefined
      const lines = lineReader({
        max: LINE_MAX,
        line: onLine,
        tooLong(n) {
          why = `${host} sent the app a message of ${sizeOf(n)} and more, longer than any its helper sends (${sizeOf(LINE_MAX)}): the app let go of the connection. If it happens again, something on ${host} is not the app's helper.`
          log("error", why)
          child.kill()
        },
      })
      child.stdout!.on("data", (d: Buffer) => lines.push(d))
      child.stderr!.on("data", (d: Buffer) => void (err = (err + d.toString("utf8")).slice(-4000)))
      child.stdin!.on("error", () => undefined)
      child.on("error", (e) => {
        if (!hello) reject(e)
      })
      child.on("close", (code) => {
        lines.stop()
        if (link !== child) return
        link = undefined
        const said = why ?? sshError(host, err, code)
        // Ended before hello: said here, not as the calls waiting on it are.
        if (!hello) pending.delete(helloId)
        for (const [id, p] of pending) (pending.delete(id), clearTimeout(p.timer), p.reject(new Error(why ?? `Can't reach ${host}: the connection ended.`)))
        if (!hello) clearTimeout(timer)
        // Before hello, an end that is neither ssh's own (255) nor the app's: no helper of this
        // version listens there (3, "B42 NOHELPER"), or its file or that node is gone or broken
        // (127, node's "Cannot find module", a file cut short): the helper is to be started.
        if (!hello && !why && code !== 255 && code !== null)
          return reject(Object.assign(new Error(`No helper of this version runs on ${host}: ${err.trim().split("\n").at(-1) ?? `exit ${code}`}`), { noHelper: true }))
        if (!hello) return reject(new Error(said))
        log("warn", `the connection to ${host} ended`, said)
        down(why ?? `Can't reach ${host}.`)
      })
      // hello is sent before "up": calls wait for it.
      const id = ++seq
      const helloId = id
      const timer = setTimeout(() => {
        pending.delete(id)
        child.kill()
        reject(new Error(`The app's helper on ${host} did not answer.`))
      }, sshTiming.step)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          const got = (v as { protocol?: unknown } | null)?.protocol
          // Another version's helper (or something else) on the socket: nothing is asked of it.
          if (got !== PROTOCOL) {
            why = `The app's helper on ${host} speaks ${typeof got === "number" ? `version ${got} of its protocol` : "no protocol the app knows"}, and this app speaks version ${PROTOCOL}. Quit the app's other versions, or move ~/.bicycle42 away on ${host}, and connect again.`
            child.kill()
            return reject(new Error(why))
          }
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
        if (first) step(`Connecting to ${host}…`)
        await master()
        // The helper there is attached to first: it runs (a reconnect, a restart of the app),
        // and nothing else is asked. Only when it does not is it started (and put there).
        let hello: Awaited<ReturnType<typeof attachOnce>> | undefined
        if (node) {
          if (first) step(`Attaching to the app's helper on ${host}…`)
          hello = await attachOnce().catch((err: Error & { noHelper?: true }) => {
            if (!err.noHelper) throw err
            return undefined
          })
        }
        if (!hello) {
          await bootstrap()
          hello = await attachOnce()
        }
        const theirs = new Set(hello.procs.map((p) => p.hid))
        retryDelay = sshTiming.retryMin
        setReach({ status: "up" })
        info ??= await call("info")
        // What this install of the app started there in an earlier run, and no longer knows:
        // ended, as an agent on this computer ends with the app. Never this run's own, which
        // another connection of it to the same computer (typed another way) may be using; but
        // what this very connection started and no longer knows of (it was ended here while its
        // start was not answered, and the answer was lost) is ended too. One still starting is
        // known: its spawn, sent again below, takes it up.
        const startingKeys = new Set([...starting].filter((c) => !c.ended).map((c) => c.key))
        const mine = (p: { owner: string; launch?: number; key?: string }) => p.owner === owner && (p.launch ?? 0) === launch && p.key?.startsWith(`${instance}-`) && !startingKeys.has(p.key)
        for (const p of hello.procs)
          if (p.owner === owner && ((p.launch ?? 0) < launch || mine(p)) && !children.has(p.hid)) void call("kill", { hid: p.hid }).then(() => call("reap", { hid: p.hid })).catch(() => undefined)
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
      const r = await call<{ hid: string; again?: true }>("spawn", { ...c.spawnArgs, owner, launch, key: c.key })
      starting.delete(c)
      c.hid = r.hid
      children.set(r.hid, c)
      // Ended while it was starting: ended now that it has (its exit comes as any other's).
      if (c.ended) return void (await killThere(r.hid))
      // Started by the spawn sent before the link dropped: its output so far went to that link,
      // and is taken up from the start (resume flushes what waits for its stdin).
      if (r.again) return void (await resume(c))
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
      key: `${instance}-${++spawned}`,
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
      /** Sends what waits for stdin, in order: all of it joined into one write (WRITE_CHUNK at
       *  most), one write at a time. What comes meanwhile goes in the next, whole. The helper
       *  skips what it has, so a write that overlaps one it got is fine. */
      flush() {
        if (writing || !c.hid || reach.status !== "up") return
        // What the helper has (it said so on taking the process up again) waits no longer.
        while (c.unsent.length && c.unsent[0]!.at + c.unsent[0]!.data.length <= c.inAt) c.unsent.shift()
        const first = c.unsent[0]
        if (!first) return
        const from = Math.max(first.at, c.inAt)
        const parts: Buffer[] = []
        let size = 0
        for (const u of c.unsent) {
          if (size >= WRITE_CHUNK) break
          const piece = u.data.subarray(Math.max(0, from - u.at), Math.max(0, from - u.at) + WRITE_CHUNK - size)
          parts.push(piece)
          size += piece.length
        }
        writing = true
        call<{ inAt: number }>("write", { hid: c.hid, at: from, data: (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString("base64") })
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
    helper: (method, params, ms) => call(method, params, ms),
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
