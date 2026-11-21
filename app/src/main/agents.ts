// The ACP agents this computer can run for the app, and how each is started.
//
// An agent here is a program that speaks ACP (the Agent Client Protocol) on its stdin and
// stdout; acp.ts starts it and talks to it. Some speak it themselves (`opencode acp`, `gemini
// --experimental-acp`); Claude Code and Codex need an adapter from npm, which npx fetches the
// first time (it then uses the person's own login of that tool).
//
// What is on the PATH of an app started from the desktop is often not what a terminal has
// (mise, nvm, npm's global folder are set up by the shell's profile), so a command is looked
// for on both: this process's PATH, then the one the person's login shell has.
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LocalAgent } from "../shared/types"

type Known = {
  id: string
  name: string
  /** How to start it: an adapter installed on its own wins over fetching it with npx. */
  commands: string[][]
  /** The program it needs to be of any use (the CLI whose login the adapter uses). */
  needs: string
  /** What to tell the person who does not have it. */
  install: string
}

/** Checked on 2026-11-21: Claude Code's adapter is @agentclientprotocol/claude-agent-acp (the
 *  @zed-industries one is deprecated), Codex's is @agentclientprotocol/codex-acp (it brings its
 *  own Codex, and uses the person's `codex login`), Gemini CLI 0.70 documents
 *  `--experimental-acp`, OpenCode 2.3 has `opencode acp`. */
export const KNOWN_AGENTS: readonly Known[] = [
  {
    id: "claude",
    name: "Claude Code",
    commands: [["claude-agent-acp"], ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]],
    needs: "claude",
    install: "Install Claude Code and sign in: npm install -g @anthropic-ai/claude-code, then claude",
  },
  {
    id: "codex",
    name: "Codex",
    commands: [["codex-acp"], ["npx", "-y", "@agentclientprotocol/codex-acp"]],
    needs: "codex",
    install: "Install Codex and sign in: npm install -g @openai/codex, then codex login",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    commands: [["gemini", "--experimental-acp"]],
    needs: "gemini",
    install: "Install Gemini CLI and sign in: npm install -g @google/gemini-cli, then gemini",
  },
  {
    id: "opencode",
    name: "OpenCode",
    commands: [["opencode", "acp"]],
    needs: "opencode",
    install: "Install OpenCode: npm install -g opencode-ai",
  },
]

/** A command typed by hand, as the connect screen's "Other" field takes it. */
export const CUSTOM = "custom"

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

/** This process's PATH with the login shell's after it: what a started agent is given, so an
 *  adapter that runs `claude` or `node` finds them too. */
export async function agentEnv(): Promise<NodeJS.ProcessEnv> {
  const extra = await shellPath()
  const own = process.env.PATH ?? ""
  const seen = new Set<string>()
  const joined = [...own.split(path.delimiter), ...extra.split(path.delimiter)].filter((d) => d && !seen.has(d) && seen.add(d)).join(path.delimiter)
  return { ...process.env, PATH: joined }
}

/** Where `program` is on that PATH, or undefined. */
export async function which(program: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (program.includes("/")) return fs.existsSync(program) ? program : undefined
  const dirs = ((env ?? (await agentEnv())).PATH ?? "").split(path.delimiter)
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
}

/** How to start a known agent on this computer: its own adapter if one is installed, else the
 *  first way whose program is there. Undefined when what it needs is not installed. */
export async function commandOf(id: string): Promise<string[] | undefined> {
  const known = KNOWN_AGENTS.find((a) => a.id === id)
  if (!known) return undefined
  const env = await agentEnv()
  if (!(await which(known.needs, env))) return undefined
  for (const command of known.commands) if (await which(command[0]!, env)) return command
  return undefined
}

/** The known agents, each with whether it can run here, for the connect screen. */
export async function localAgents(): Promise<LocalAgent[]> {
  return Promise.all(
    KNOWN_AGENTS.map(async (a) => {
      const command = await commandOf(a.id)
      return { id: a.id, name: a.name, command: (command ?? a.commands.at(-1)!).join(" "), installed: !!command, ...(command ? {} : { needs: a.install }) }
    }),
  )
}

/** A command line split into words, as a shell would for the simple cases: spaces separate,
 *  quotes ("…" or '…') keep spaces in, a backslash keeps the next character. No variables, no
 *  globs, no pipes: it is run as one program with its arguments, never through a shell. */
export function splitCommand(line: string): string[] {
  const words: string[] = []
  let word = ""
  let quote: string | undefined
  let started = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += c
    } else if (c === '"' || c === "'") (quote = c), (started = true)
    else if (c === "\\" && i + 1 < line.length) (word += line[++i]), (started = true)
    else if (/\s/.test(c)) {
      if (started) words.push(word)
      word = ""
      started = false
    } else (word += c), (started = true)
  }
  if (quote) throw new Error("A quote in the command is not closed.")
  if (started) words.push(word)
  return words
}

/** A short name for a custom command: its program's name ("my-agent" for /opt/my-agent --acp). */
export const customName = (command: string[]) => path.basename(command[0] ?? "agent") || "agent"

/** The folder an agent is started in: the person's home. Its conversations each say their own. */
export const agentHome = () => os.homedir()
