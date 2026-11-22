// The ACP agents a computer can run for the app (this one, or another over ssh: `Machine`), and
// how each is started.
//
// An agent here is a program that speaks ACP (the Agent Client Protocol) on its stdin and
// stdout; acp.ts starts it and talks to it. Some speak it themselves (`opencode acp`, `gemini
// --experimental-acp`); Claude Code and Codex need an adapter from npm, which the app installs
// at its first start on that computer from a lockfile of its own (adapters.ts), and which then
// uses the person's own login of that tool.
//
// What is on the PATH of an app started from the desktop is often not what a terminal has
// (mise, nvm, npm's global folder are set up by the shell's profile), so a command is looked
// for on both: this process's PATH, then the one the person's login shell has.
//
// An adapter is pinned (agent-pins.json): the version that was tested, the same on every
// computer, never whatever npm has newest at that start; and so is every package under it, by the
// lockfile it is installed from (adapter-locks/), with no package's install script run. The
// reviewer can ask for the newest per agent instead ("Always the newest" on the connect screen:
// `latest` below), which has no lockfile and goes through npx, as a version forced with
// B42_PIN_<ID> does. `npm run agents:check` (scripts/agents-check.mjs) says when there is a newer
// one, tests it, and pins it with its lockfile.
import path from "node:path"
import type { LocalAgent } from "../shared/types"
import pins from "./agent-pins.json"
import { ADAPTER_LOCKS, adapterInstalled, installAdapter, lineOf, lockOf, tidyAdapters, type AdapterLock } from "./adapters"
import { thisMachine, type Machine } from "./machine"

/** An adapter from npm, as agent-pins.json keeps it: its package, the program it installs, the
 *  version the app starts, and when that version passed test/acp.real.ts in full (absent: it was
 *  not, `checks` says how far it was). */
export type Pin = { package: string; bin: string; version: string; tested?: string; checks?: string }
export const PINS: Readonly<Record<string, Pin>> = pins

/** The variable that runs another version of an agent's adapter than its pin (B42_PIN_CLAUDE=0.110.0):
 *  how `npm run agents:check --test` tries the newest before it is pinned. */
export const pinEnv = (id: string) => `B42_PIN_${id.toUpperCase()}`

/** What decides how an agent is started beyond what is installed: the agents whose adapter is
 *  the newest on npm (the reviewer's choice, kept in the settings), and the environment the pin
 *  override is read from (this process's). */
export type StartPrefs = { latest?: (id: string) => boolean; env?: Record<string, string | undefined> }

/** The lockfile the pin of `id` is installed from, undefined when the app has none of that
 *  version (a pin moved by hand without `agents:check`): that pin then goes through npx. */
export function adapterLock(id: string): AdapterLock | undefined {
  const pin = PINS[id]
  const files = ADAPTER_LOCKS[id]
  return pin && files ? lockOf(id, pin, files.manifest, files.lock) : undefined
}

/** Which version of a known agent's adapter is to start, and why: `lock` when it is the pin,
 *  installed from the app's lockfile; else (the newest, a version forced, a pin with no lockfile)
 *  it is npx's. Undefined for an agent with no adapter (Gemini CLI, OpenCode: the person's own CLI). */
export function adapterOf(
  id: string,
  prefs: StartPrefs = {},
): { pin: Pin; version: string; tested: boolean; latest: boolean; env?: string; lock?: AdapterLock } | undefined {
  const pin = PINS[id]
  if (!pin) return undefined
  const name = pinEnv(id)
  const forced = (prefs.env ?? process.env)[name]?.trim()
  if (forced) return { pin, version: forced, tested: false, latest: false, env: name }
  if (prefs.latest?.(id)) return { pin, version: "latest", tested: false, latest: true }
  const lock = adapterLock(id)
  return { pin, version: pin.version, tested: !!pin.tested, latest: false, ...(lock ? { lock } : {}) }
}

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
  /** How to start it when it speaks ACP itself. One with an adapter (PINS) has none here: its
   *  adapter installed on its own, else the pin from its lockfile, else npx (`waysOf`). */
  commands?: string[][]
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

/** A way to start a known agent: its line, and for the pin from its lockfile, that lockfile
 *  (installed on that computer at its first start: `prepareStart`). */
type Way = { line: string[]; lock?: AdapterLock }

/** The ways to start a known agent, the one to use first first: its adapter installed on its
 *  own (the person's: no pin applies to it), then the pin from the app's lockfile (node and the
 *  adapter's program in its folder), or npx for the newest and a pin with no lockfile. A version
 *  forced with B42_PIN_<ID> is npx's only: it is what is asked for, whatever is installed. */
function waysOf(known: Known, m: Machine, prefs: StartPrefs): Way[] {
  const adapter = adapterOf(known.id, prefs)
  if (!adapter) return (known.commands ?? []).map((line) => ({ line }))
  if (adapter.lock) return [{ line: [adapter.pin.bin] }, { line: lineOf(m, adapter.lock), lock: adapter.lock }]
  const npx = { line: ["npx", "-y", `${adapter.pin.package}@${adapter.version}`] }
  return adapter.env ? [npx] : [{ line: [adapter.pin.bin] }, npx]
}

/** Whether a way can start there: its program is on the PATH; for the pin from its lockfile, node
 *  is (npm, to install it, is asked for at its start, which says so when it is not there). */
async function usable(way: Way, m: Machine, env: Record<string, string | undefined>): Promise<boolean> {
  return !!(await m.which(way.lock ? "node" : way.line[0]!, env))
}

/** How to start a known agent on that computer (this one unless said), as `commandOf` says, with
 *  the lockfile to install it from first when that is the way. Undefined when it can't start. */
export async function startOf(id: string, m: Machine = thisMachine(), prefs: StartPrefs = {}): Promise<Way | undefined> {
  const known = KNOWN_AGENTS.find((a) => a.id === id)
  if (!known) return undefined
  const env = await m.agentEnv()
  if (!(await m.which(known.needs, env))) return undefined
  for (const way of waysOf(known, m, prefs)) if (await usable(way, m, env)) return way
  return undefined
}

/** How to start a known agent on a computer (this one unless said): its own adapter if one is
 *  installed, else the first way whose program is there. Undefined when what it needs is not
 *  installed. Its adapter's version is decided here, the same for another computer as for this. */
export async function commandOf(id: string, m: Machine = thisMachine(), prefs: StartPrefs = {}): Promise<string[] | undefined> {
  return (await startOf(id, m, prefs))?.line
}

/** The line to start a known agent with, once what it needs is there: the pin's adapter is
 *  installed from its lockfile on that computer first when it is not yet (`onStep` says so), and
 *  older installs of it are tidied after. Undefined when it can't start; rejects with a sentence
 *  when the install fails. */
export async function prepareStart(
  id: string,
  m: Machine = thisMachine(),
  prefs: StartPrefs = {},
  o: { onStep?(text: string): void; log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void } = {},
): Promise<string[] | undefined> {
  const way = await startOf(id, m, prefs)
  if (!way?.lock) return way?.line
  const known = KNOWN_AGENTS.find((a) => a.id === id)!
  await installAdapter(m, way.lock, { name: known.name, env: await m.agentEnv(), ...(o.onStep ? { onStep: o.onStep } : {}), ...(o.log ? { log: o.log } : {}) })
  // Older installs of it there go: after a new install, and at a later start those left while
  // they ran.
  void tidyAdapters(m, way.lock, o.log)
  return way.line
}

/** The known agents, each with whether it can run on that computer, for the connect screen. */
export async function localAgents(m: Machine = thisMachine(), prefs: StartPrefs = {}): Promise<LocalAgent[]> {
  const p = probe(m, await m.agentEnv())
  return Promise.all(KNOWN_AGENTS.map((a) => describeAgent(a, m, p, prefs)))
}

/** One known agent as `localAgents` says it (the connect screen's row after its toggle). */
export async function localAgent(id: string, m: Machine = thisMachine(), prefs: StartPrefs = {}): Promise<LocalAgent | undefined> {
  const known = KNOWN_AGENTS.find((a) => a.id === id)
  return known && describeAgent(known, m, probe(m, await m.agentEnv()), prefs)
}

async function describeAgent(a: Known, m: Machine, p: Probe, prefs: StartPrefs): Promise<LocalAgent> {
  const way = await startOf(a.id, m, prefs)
  const command = way?.line
  const signIn = command && a.login && (await a.signedIn?.(p)) === false ? { signIn: a.login } : {}
  const adapter = adapterOf(a.id, prefs)
  const own = !!command && command[0] === adapter?.pin.bin
  const version = adapter && {
    adapter: {
      version: adapter.version,
      tested: adapter.tested,
      latest: adapter.latest,
      own,
      ...(adapter.env ? { env: adapter.env } : {}),
      // From the app's lockfile, unless the person's own install is what starts: and whether its
      // first start installs it there.
      ...(adapter.lock && !own ? { locked: true as const, ...(way?.lock && !(await adapterInstalled(m, way.lock)) ? { firstStart: true as const } : {}) } : {}),
    },
  }
  return {
    id: a.id,
    name: a.name,
    command: (command ?? waysOf(a, m, prefs).at(-1)!.line).join(" "),
    installed: !!command,
    ...version,
    ...(command ? signIn : { needs: a.install, install: a.installCommand }),
  }
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
