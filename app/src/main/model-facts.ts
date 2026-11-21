// What an agent says of its models beyond their names, and how its errors about them read.
//
// ACP's config options give a model's id and name and nothing more. Where an agent says more
// another way, it is read here:
//
//   OpenCode   `opencode api GET /api/model` (2.x; through its background service) gives each
//              model's input modalities, cost and status; `opencode models --verbose` (1.x)
//              gave the same per model. Run on the agent's computer (Machine), once per list.
//   any agent  `promptCapabilities.image` from initialize: whether it takes pictures at all.
//
// And when a model could not see a picture after all, OpenCode says so in what it hands the
// model in its place: `ERROR: Cannot read "<file>" (this model does not support image input).
// Inform the user.` (checked in its 2.3.2 build), which the model then repeats in its answer.
//
// Payloads are untrusted: read through rec/str/num/list.
import { list, num, rec, str, type Raw } from "./chat-items"
import type { Machine } from "./machine"
import type { ModelTag } from "../shared/types"

/** What is known of one model beyond its name, by the agent's option value ("provider/model"). */
export type ModelFact = { images?: boolean; tags?: ModelTag[] }
export type ModelFacts = Map<string, ModelFact>

/** OpenCode's own free models are its "opencode" provider's at no cost. A provider of a plan
 *  paid by the month (a coding plan) also lists a cost of 0, and is not free. */
const FREE_PROVIDER = "opencode"

/** A modalities field, in any of the shapes OpenCode has given it: ["text", "image"],
 *  { text: true, image: false }, or under `modalities.input`. Undefined when it says nothing. */
function takesImages(m: Raw): boolean | undefined {
  const input = rec(m.capabilities).input ?? rec(m.modalities).input ?? m.input_modalities
  if (Array.isArray(input)) return input.length ? input.some((x) => typeof x === "string" && x.startsWith("image")) : undefined
  const flags = rec(input)
  if (typeof flags.image === "boolean") return flags.image
  if (typeof rec(m.capabilities).attachment === "boolean") return rec(m.capabilities).attachment as boolean
  return undefined
}

/** Every listed cost of it is 0, input and output. A missing cost says nothing. */
function costsNothing(m: Raw): boolean {
  const costs = Array.isArray(m.cost) ? list(m.cost).map(rec) : m.cost && typeof m.cost === "object" ? [rec(m.cost)] : []
  return costs.length > 0 && costs.every((c) => num(c.input) === 0 && (num(c.output) ?? 0) === 0)
}

function factOf(provider: string, m: Raw): ModelFact {
  const tags: ModelTag[] = []
  if (provider === FREE_PROVIDER && costsNothing(m)) tags.push("free")
  const status = str(m.status)
  if (status === "alpha" || status === "beta") tags.push(status)
  const images = takesImages(m)
  return { ...(images !== undefined ? { images } : {}), ...(tags.length ? { tags } : {}) }
}

/** OpenCode 2.x's `/api/model`: `{ data: [{ providerID, id, capabilities, cost, status }] }`. */
export function parseModelApi(text: string): ModelFacts | undefined {
  let body: Raw
  try {
    body = rec(JSON.parse(text))
  } catch {
    return undefined
  }
  if (!Array.isArray(body.data)) return undefined
  const facts: ModelFacts = new Map()
  for (const raw of list(body.data)) {
    const m = rec(raw)
    const provider = str(m.providerID)
    const id = str(m.id) ?? str(m.modelID)
    if (provider && id) facts.set(`${provider}/${id}`, factOf(provider, m))
  }
  return facts
}

/** OpenCode 1.x's `opencode models --verbose`: each model's "provider/model" on a line of its
 *  own, then its JSON. */
export function parseModelsVerbose(text: string): ModelFacts | undefined {
  const facts: ModelFacts = new Map()
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const head = /^([\w.@-]+)\/(\S+)\s*$/.exec(lines[i]!.trim())
    if (!head || !lines[i + 1]?.trim().startsWith("{")) continue
    let depth = 0
    let j = i + 1
    const body: string[] = []
    for (; j < lines.length; j++) {
      body.push(lines[j]!)
      for (const ch of lines[j]!) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0
      if (depth <= 0) break
    }
    try {
      facts.set(`${head[1]}/${head[2]}`, factOf(head[1]!, rec(JSON.parse(body.join("\n")))))
    } catch {
      // Not a model's JSON after all.
    }
    i = j
  }
  return facts.size ? facts : undefined
}

/** OpenCode's models as it describes them, from its own CLI on the agent's computer: 2.x's
 *  model API first, else 1.x's verbose list. Undefined when neither answers. */
export async function openCodeFacts(machine: Machine, program: string, timeout = 15_000): Promise<ModelFacts | undefined> {
  const env = await machine.agentEnv()
  const exe = (await machine.which(program, env)) ?? program
  const run = (args: string[]) => machine.run(exe, args, { cwd: machine.home, env, timeout, maxBuffer: 32 * 1024 * 1024 }).catch(() => undefined)
  const api = await run(["api", "GET", "/api/model"])
  const fromApi = api?.code === 0 ? parseModelApi(api.out) : undefined
  if (fromApi?.size) return fromApi
  const verbose = await run(["models", "--verbose"])
  return verbose?.code === 0 ? parseModelsVerbose(verbose.out) : undefined
}

/** Whether the agent is OpenCode: by what it calls itself, else by its program. */
export function isOpenCode(init: Raw, command: readonly string[]): boolean {
  const name = str(rec(init.agentInfo).name) ?? ""
  return /^opencode$/i.test(name) || /(^|[/\\])opencode(\.exe|\.cmd)?$/i.test(command[0] ?? "")
}

/** The agent's own command to sign in to a provider, from its `authMethods` ("Run `opencode auth
 *  login` in the terminal"), else OpenCode's known one. */
export function addKeyCommand(init: Raw, command: readonly string[]): string | undefined {
  for (const raw of list(init.authMethods)) {
    const said = str(rec(raw).description) ?? ""
    const quoted = /`([^`]{3,80})`/.exec(said)?.[1]?.trim()
    if (quoted && /\b(auth|login|key)\b/i.test(quoted)) return quoted
  }
  return isOpenCode(init, command) ? "opencode auth login" : undefined
}

/** What OpenCode puts in place of a picture its model can't read, and the model's own retelling
 *  of it ("the images … could not be read by the model (it does not support image input)"). */
export const PICTURE_UNREAD = /does(n't| not) support image input|this model does not support image/i

/** An error said of a model that takes no pictures (Codex: "The current model does not support
 *  image input"). */
export const NO_PICTURES = /(model|it) does not support (image|picture)s?( input)?/i
