// The ACP agents a computer can run for the app (this one, or another over ssh: `Machine`), and
// how each is started.
//
// An agent here is a program that speaks ACP (the Agent Client Protocol) on its stdin and
// stdout; acp.ts starts it and talks to it. Some speak it themselves (`opencode acp`, `gemini
// --experimental-acp`); Claude Code and Codex need an adapter from npm, which npx fetches the
// first time (it then uses the person's own login of that tool).
//
// What is on the PATH of an app started from the desktop is often not what a terminal has
// (mise, nvm, npm's global folder are set up by the shell's profile), so a command is looked
// for on both: this process's PATH, then the one the person's login shell has.
import path from "node:path"
import type { LocalAgent } from "../shared/types"
import { thisMachine, type Machine } from "./machine"

/** What a check of a sign-in looks at, on the computer the agent is on. */
type Probe = {
  env: Record<string, string | undefined>
  home(...parts: string[]): string
  exists(file: string): Promise<boolean>
  read(file: string): Promise<string>
  platform: NodeJS.Platform
  join(...parts: string[]): string
}

type Known = {
  id: string
  name: string
  /** How to start it: an adapter installed on its own wins over fetching it with npx. */
  commands: string[][]
  /** The program it needs to be of any use (the CLI whose login the adapter uses). */
  needs: string
  /** What to tell the person who does not have it. */
  install: string
  /** The one command that installs it, for the connect screen to copy. */
  installCommand: string
  /** How to sign in to it, in a terminal; absent when it needs no sign-in of its own. */
  login?: string
  /** Whether a sign-in of it is on that computer: true when one is found, false when none is,
   *  undefined when it can't be told from here (a macOS keychain, a keyring). */
  signedIn?: (p: Probe) => Promise<boolean | undefined>
}

function probe(m: Machine, env: Record<string, string | undefined>): Probe {
  return {
    env,
    home: (...parts) => m.path.join(m.home, ...parts),
    exists: (file) => m.stat(file).then((s) => s.kind === "file", () => false),
    read: (file) => m.readFile(file).catch(() => ""),
    platform: m.platform,
    join: (...parts) => m.path.join(...parts),
  }
}
const anyEnv = (p: Probe, ...names: string[]) => names.some((n) => !!p.env[n])

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
    installCommand: "npm install -g @anthropic-ai/claude-code",
    login: "claude",
    // Linux keeps the login in a file; macOS in the keychain, which is not looked into.
    signedIn: async (p) => {
      const dir = p.env.CLAUDE_CONFIG_DIR || p.home(".claude")
      if (anyEnv(p, "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN") || (await p.exists(p.join(dir, ".credentials.json"))) || (await p.read(p.home(".claude.json"))).includes('"oauthAccount"')) return true
      return p.platform === "darwin" ? undefined : false
    },
  },
  {
    id: "codex",
    name: "Codex",
    commands: [["codex-acp"], ["npx", "-y", "@agentclientprotocol/codex-acp"]],
    needs: "codex",
    install: "Install Codex and sign in: npm install -g @openai/codex, then codex login",
    installCommand: "npm install -g @openai/codex",
    login: "codex login",
    signedIn: async (p) => {
      const dir = p.env.CODEX_HOME || p.home(".codex")
      if (anyEnv(p, "OPENAI_API_KEY", "CODEX_API_KEY") || (await p.exists(p.join(dir, "auth.json")))) return true
      // A login kept in the system's keyring leaves no file.
      return /credentials_store\s*=\s*"(keyring|auto)"/.test(await p.read(p.join(dir, "config.toml"))) ? undefined : false
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    commands: [["gemini", "--experimental-acp"]],
    needs: "gemini",
    install: "Install Gemini CLI and sign in: npm install -g @google/gemini-cli, then gemini",
    installCommand: "npm install -g @google/gemini-cli",
    login: "gemini",
    signedIn: async (p) => {
      if (anyEnv(p, "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI") || (await p.exists(p.home(".gemini", "oauth_creds.json")))) return true
      // A key in its own .env, or a choice of Vertex in its settings: can't be told from here.
      return (await p.exists(p.home(".gemini", ".env"))) || /"selected(Auth)?Type"/.test(await p.read(p.home(".gemini", "settings.json"))) ? undefined : false
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    commands: [["opencode", "acp"]],
    needs: "opencode",
    install: "Install OpenCode: npm install -g opencode-ai",
    installCommand: "npm install -g opencode-ai",
  },
]

/** A command typed by hand, as the connect screen's "Other" field takes it. */
export const CUSTOM = "custom"

/** This computer's environment with its login shell's PATH: what a started agent is given. */
export const agentEnv = () => thisMachine().agentEnv()

/** Where `program` is on that PATH, or undefined. */
export const which = (program: string, env?: Record<string, string | undefined>) => thisMachine().which(program, env)

/** How to start a known agent on a computer (this one unless said): its own adapter if one is
 *  installed, else the first way whose program is there. Undefined when what it needs is not
 *  installed. */
export async function commandOf(id: string, m: Machine = thisMachine()): Promise<string[] | undefined> {
  const known = KNOWN_AGENTS.find((a) => a.id === id)
  if (!known) return undefined
  const env = await m.agentEnv()
  if (!(await m.which(known.needs, env))) return undefined
  for (const command of known.commands) if (await m.which(command[0]!, env)) return command
  return undefined
}

/** The known agents, each with whether it can run on that computer, for the connect screen. */
export async function localAgents(m: Machine = thisMachine()): Promise<LocalAgent[]> {
  const env = await m.agentEnv()
  const p = probe(m, env)
  return Promise.all(
    KNOWN_AGENTS.map(async (a) => {
      const command = await commandOf(a.id, m)
      const signIn = command && a.login && (await a.signedIn?.(p)) === false ? { signIn: a.login } : {}
      return { id: a.id, name: a.name, command: (command ?? a.commands.at(-1)!).join(" "), installed: !!command, ...(command ? signIn : { needs: a.install, install: a.installCommand }) }
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

/** The folder an agent is started in: the person's home (on this computer unless said). Its
 *  conversations each say their own. */
export const agentHome = (m: Machine = thisMachine()) => m.home
