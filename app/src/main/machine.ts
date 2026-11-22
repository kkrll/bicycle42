// Where the code is: the computer the agent runs on and the repo is on, as the main process uses
// it. Everything the app does to that computer goes through `Machine`: running a command (git),
// starting the agent as a long-lived process, reading and writing files, its home folder and its
// PATH. `createLocalMachine()` is this computer, done as the app always did it; ssh.ts gives
// another computer reached over ssh, where the same calls go to a small helper (src/helper/), which
// does them with this very file. So both sides are one implementation.
//
// Nothing here is Electron's, and nothing beyond node's own modules is imported: this file is
// bundled into the helper that runs on the other computer.
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable, Writable } from "node:stream"

export type FileKind = "file" | "dir" | "link" | "other"
export type Stat = { kind: FileKind; size: number; mtimeMs: number }
export type Entry = { name: string; kind: FileKind }

export type RunOptions = {
  cwd?: string
  /** Laid over the machine's own environment; null takes a variable out. */
  env?: Record<string, string | null>
  /** Variables whose names start with this are left out of the machine's own environment
   *  (before `env` is laid over it): "GIT_" for the app's own git. */
  clearPrefix?: string
  /** Written to its stdin, which is then closed. */
  input?: string
  /** Ended (SIGTERM) after this many ms: `code` is null and `signal` says so. */
  timeout?: number
  /** Output beyond this many bytes ends it, as execFile does. */
  maxBuffer?: number
}

/** How a command ended. A timeout or a signal is `code: null`, never one of its own exit codes.
 *  `error`: it could not be started at all (ENOENT), or its output was too long. */
export type RunResult = { code: number | null; signal: string | null; out: string; err: string; error?: { code?: string; message: string } }

/** How a long-lived process ended: `error` when it could not be started (ENOENT). */
export type Exit = { code: number | null; signal: string | null; error?: { code?: string; message: string } }

/** A long-lived process (the agent): its three streams, how it ended, and a way to end it with
 *  everything it started. */
export type Child = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exited: Promise<Exit>
  /** Ends it and its process group (on Windows its tree), also once it has ended by itself:
   *  what it started (a dev server) would live on. Resolves once they are gone, or were sent
   *  SIGKILL (2 s after SIGTERM); another computer's once its helper has done that. Never rejects. */
  kill(): Promise<void>
  /** Some of its output was lost while the app was away (another computer's helper keeps only so
   *  much): what was read since is not the whole story. Never on this computer. */
  onGap?(listener: () => void): void
}

export type SpawnOptions = { cwd?: string; env?: Record<string, string | undefined> }

/** What the app was told of a machine's connection: another computer may be out of reach for a
 *  while, and its agent works on meanwhile. Never on this computer. */
export type Reach = { status: "up" } | { status: "down"; error: string }

export type Machine = {
  /** "this computer", or the host as the reviewer typed it ("dev-box"): the words of a sentence. */
  readonly where: string
  readonly local: boolean
  /** Its home folder: an agent starts there, and the window shows paths under it as ~. */
  readonly home: string
  readonly platform: NodeJS.Platform
  /** Path functions for its paths (posix on another computer, whatever this one is). */
  readonly path: path.PlatformPath
  /** Its name, as it calls itself. */
  hostname(): string
  /** /dev/null of it. */
  readonly devNull: string
  run(program: string, args: string[], o?: RunOptions): Promise<RunResult>
  /** Starts a long-lived process in its own process group, with pipes for its three streams. */
  spawn(program: string, args: string[], o?: SpawnOptions): Child
  /** Its environment with the PATH its owner's login shell has after its own: what an agent is
   *  started with, so an adapter that runs `claude` or `node` finds them. */
  agentEnv(): Promise<Record<string, string>>
  /** Where `program` is on that PATH (or `env`'s), or undefined. */
  which(program: string, env?: Record<string, string | undefined>): Promise<string | undefined>
  /** These throw node's errors, with their `code` (ENOENT, ENOTDIR, …). */
  stat(p: string): Promise<Stat>
  lstat(p: string): Promise<Stat>
  readdir(p: string): Promise<Entry[]>
  readFile(p: string): Promise<string>
  writeFile(p: string, data: string, mode?: number): Promise<void>
  /** Makes it and the folders above it; fine when it is there. */
  mkdir(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Takes it away, with what is in it; fine when it is not there. */
  rm(p: string): Promise<void>
  realpath(p: string): Promise<string>
  /** Whether it can be reached now; and told when that changes. On this computer always "up". */
  reach(): Reach
  onReach?(listener: (reach: Reach) => void): () => void
}

const kindOf = (s: fs.Stats | fs.Dirent): FileKind => (s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other")
const statOf = (s: fs.Stats): Stat => ({ kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs })

/** A command line for cmd.exe: each word quoted when it needs to be. A word with a character
 *  cmd.exe would act on even inside quotes (`"`, `%`, `!`, `^`, a line break) is refused: the
 *  command was typed by a person, and is run as one program with its arguments, nothing more. */
export function cmdLine(words: string[]): string {
  return words
    .map((w) => {
      if (/["%!^\r\n]/.test(w)) throw new Error(`Can't start a command with ${JSON.stringify(w)} in it on Windows: it has a character cmd.exe would act on.`)
      return w && /^[\w.\-/\\:=@+,]+$/.test(w) ? w : `"${w}"`
    })
    .join(" ")
}

/** This computer. One per process is enough: what it remembers (the login shell's PATH) is
 *  this computer's. */
export function createLocalMachine(): Machine {
  let loginPath: Promise<string> | undefined

  /** The PATH the person's login shell sets up, asked once. Empty when there is no such shell
   *  (Windows) or it does not answer in time. */
  function shellPath(): Promise<string> {
    if (process.platform === "win32") return Promise.resolve("")
    loginPath ??= new Promise((resolve) => {
      const shell = process.env.SHELL || "/bin/sh"
      // -i too: a PATH set in .bashrc or .zshrc only reaches an interactive shell.
      execFile(shell, ["-ilc", 'printf "\\n%s\\n" "$PATH"'], { timeout: 5000, env: { ...process.env, TERM: "dumb" } }, (err, out) => {
        if (err) return resolve("")
        // What a profile prints before the PATH (a greeting) is above the line it is on.
        resolve(String(out).trim().split("\n").pop() ?? "")
      })
    })
    return loginPath
  }

  const own = () => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    return env
  }

  const machine: Machine = {
    where: "this computer",
    local: true,
    // Read each time: HOME may be changed (the tests do).
    get home() {
      return os.homedir()
    },
    platform: process.platform,
    path,
    hostname: () => os.hostname(),
    devNull: os.devNull,

    run(program, args, o = {}) {
      const env: NodeJS.ProcessEnv = {}
      for (const [k, v] of Object.entries(process.env)) if (!o.clearPrefix || !k.startsWith(o.clearPrefix)) env[k] = v
      for (const [k, v] of Object.entries(o.env ?? {})) v === null ? delete env[k] : (env[k] = v)
      return new Promise((resolve) => {
        let child: ChildProcess
        try {
          child = spawn(program, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], ...(o.timeout ? { timeout: o.timeout } : {}), windowsHide: true })
        } catch (err) {
          return resolve({ code: null, signal: null, out: "", err: "", error: { message: String(err) } })
        }
        const out: Buffer[] = []
        const err: Buffer[] = []
        let size = 0
        let error: RunResult["error"]
        const take = (into: Buffer[]) => (b: Buffer) => {
          size += b.length
          if (o.maxBuffer && size > o.maxBuffer && !error) {
            error = { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: `${program}: its output was longer than ${o.maxBuffer} bytes` }
            child.kill()
            return
          }
          into.push(b)
        }
        child.stdout!.on("data", take(out))
        child.stderr!.on("data", take(err))
        child.on("error", (e) => {
          error ??= { code: (e as NodeJS.ErrnoException).code, message: e.message }
        })
        // A timeout or a signal is `code: null`: never read as one of the program's own exit codes.
        child.on("close", (code, signal) => {
          // Output too long for a string (512 MiB, with no maxBuffer): said, never thrown from
          // here, where nothing would catch it (in the helper, that ended it and every agent).
          let text: { out: string; err: string }
          try {
            text = { out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }
          } catch (e) {
            error ??= { code: (e as NodeJS.ErrnoException).code ?? "ERR_STRING_TOO_LONG", message: `${program}: its output was too long to read (${size} bytes)` }
            text = { out: "", err: "" }
          }
          resolve({ code: error ? null : code, signal, ...text, ...(error ? { error } : {}) })
        })
        child.stdin!.on("error", () => undefined)
        child.stdin!.end(o.input ?? "")
      })
    },

    spawn(program, args, o = {}) {
      const windows = process.platform === "win32"
      // Windows runs a .cmd or .bat (npx is one) only through cmd.exe, which reads the whole line:
      // it is given one line, quoted, and refused when a word could make cmd.exe do anything else.
      const viaCmd = windows && /\.(cmd|bat)$/i.test(program)
      const child: ChildProcess = viaCmd
        ? spawn(cmdLine([program, ...args]), [], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true })
        : spawn(program, args, {
            cwd: o.cwd,
            env: o.env,
            stdio: ["pipe", "pipe", "pipe"],
            // Its own process group, so what it starts (a dev server) ends with it.
            detached: !windows,
            windowsHide: true,
          })
      const exited = new Promise<Exit>((resolve) => {
        child.on("error", (err) => resolve({ code: null, signal: null, error: { code: (err as NodeJS.ErrnoException).code, message: err.message } }))
        child.on("exit", (code, signal) => resolve({ code, signal }))
      })
      // What it started is ended too, also when it has ended already (a crash leaves its dev
      // server running otherwise): the whole group, or on Windows the tree under it.
      const kill = (): Promise<void> => {
        const pid = child.pid
        if (!pid) return Promise.resolve()
        if (windows) return new Promise((resolve) => void execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()))
        const group = (signal: NodeJS.Signals | 0) => {
          try {
            process.kill(-pid, signal)
            return true
          } catch (err) {
            // ESRCH: nothing of it is left
            return (err as NodeJS.ErrnoException).code === "EPERM"
          }
        }
        group("SIGTERM")
        // Until the group is gone, at most 2 s; then SIGKILL, only if anything of it is left (its
        // number could be another's by then otherwise). The wait does not keep this process up.
        const end = Date.now() + 2000
        return new Promise((resolve) => {
          const tick = () => {
            if (!group(0)) return resolve()
            if (Date.now() >= end) return (group("SIGKILL"), resolve())
            setTimeout(tick, 50).unref()
          }
          setTimeout(tick, 20).unref()
        })
      }
      return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited, kill }
    },

    async agentEnv() {
      const extra = await shellPath()
      const mine = own()
      const seen = new Set<string>()
      const joined = [...(mine.PATH ?? "").split(path.delimiter), ...extra.split(path.delimiter)].filter((d) => d && !seen.has(d) && seen.add(d)).join(path.delimiter)
      return { ...mine, PATH: joined }
    },

    async which(program, env) {
      if (program.includes("/")) return fs.existsSync(program) ? program : undefined
      const dirs = ((env ?? (await machine.agentEnv())).PATH ?? "").split(path.delimiter)
      const names = process.platform === "win32" ? [program, `${program}.cmd`, `${program}.exe`] : [program]
      for (const dir of dirs)
        for (const name of names) {
          const file = path.join(dir || ".", name)
          try {
            fs.accessSync(file, fs.constants.X_OK)
            if (fs.statSync(file).isFile()) return file
          } catch {
            // not here
          }
        }
      return undefined
    },

    stat: async (p) => statOf(await fs.promises.stat(p)),
    lstat: async (p) => statOf(await fs.promises.lstat(p)),
    readdir: async (p) => (await fs.promises.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, kind: kindOf(e) })),
    readFile: (p) => fs.promises.readFile(p, "utf8"),
    writeFile: (p, data, mode) => fs.promises.writeFile(p, data, mode === undefined ? undefined : { mode }),
    mkdir: async (p) => void (await fs.promises.mkdir(p, { recursive: true })),
    rename: (from, to) => fs.promises.rename(from, to),
    rm: (p) => fs.promises.rm(p, { recursive: true, force: true }),
    realpath: (p) => fs.promises.realpath(p),
    reach: () => ({ status: "up" }),
  }
  return machine
}

let local: Machine | undefined
/** This computer, made once. */
export const thisMachine = (): Machine => (local ??= createLocalMachine())
