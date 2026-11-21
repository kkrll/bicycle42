// How a model is named to the reviewer, the same in main and in the window: never in a way that
// makes two models look like one, and with what the agent's own words say of it (free, a
// pre-release) where the reviewer would otherwise not know. Pure: tested in Node.
import type { ModelInfo, ModelTag } from "./types"

/** The words in a model's name or id that say it is free or not yet released, in the order the
 *  label says them: what it costs first, then how finished it is. */
const TAGS: readonly [ModelTag, RegExp][] = [
  ["free", /(^|[\s(\-_:/])free($|[\s)\-_:])/i],
  ["alpha", /(^|[\s(\-_.:/])alpha($|[\s)\-_.:\d])/i],
  ["beta", /(^|[\s(\-_.:/])beta($|[\s)\-_.:\d])/i],
  ["preview", /(^|[\s(\-_.:/])preview($|[\s)\-_.:\d])/i],
]

/** What a model's own name and id say of it: "Tidepool Alpha Free" is free and an alpha.
 *  `known` adds what the agent's metadata says (OpenCode's cost and status). */
export function modelTags(name: string, id: string, known: readonly ModelTag[] = []): ModelTag[] {
  return TAGS.flatMap(([tag, re]) => (known.includes(tag) || re.test(name) || re.test(id) ? [tag] : []))
}

/** The name without the word its "free" label now says: "Tidepool Alpha Free" → "Tidepool Alpha".
 *  The pre-release words stay: they are part of what the model is called. */
export function plainName(name: string, tags: readonly ModelTag[]): string {
  if (!tags.includes("free")) return name
  const cut = name.replace(/\s*[(\-:]?\s*free\s*\)?\s*$/i, "").trim()
  return cut || name
}

/** "free, alpha": the quiet label after a model's name, or "" for none. */
export const tagLine = (tags: readonly ModelTag[] | undefined) => (tags ?? []).join(", ")

/** Names (lower case) that more than one provider's model has: those need their provider beside
 *  them, or two models read as one ("Kimi K3.1 Pro" from moonshotai and from a coding plan). */
export function sharedNames(models: readonly Pick<ModelInfo, "providerID" | "name">[]): Set<string> {
  const by = new Map<string, Set<string>>()
  for (const m of models) {
    const k = m.name.trim().toLowerCase()
    by.set(k, (by.get(k) ?? new Set()).add(m.providerID))
  }
  return new Set([...by].flatMap(([k, providers]) => (providers.size > 1 ? [k] : [])))
}

/** A model as one line: its name, then its provider when another provider has a model of that
 *  name (or always, with `provider: "always"`), then its labels. The parts are apart, so the
 *  window can set the provider and the labels quieter than the name. */
export function modelLabel(
  m: Pick<ModelInfo, "providerID" | "name" | "tags" | "images">,
  all: readonly Pick<ModelInfo, "providerID" | "name">[],
  o: { provider?: "shared" | "always" } = {},
): { name: string; provider?: string; tags: string; images: boolean } {
  const shared = o.provider === "always" || sharedNames(all).has(m.name.trim().toLowerCase())
  return { name: m.name, ...(shared ? { provider: m.providerID } : {}), tags: tagLine(m.tags), images: m.images }
}

/** The label as plain text, for a native list's option or a tooltip:
 *  "Kimi K3.1 Pro · moonshotai", "Tidepool Alpha · free, alpha · no images". */
export function labelText(l: ReturnType<typeof modelLabel>, o: { images?: boolean } = {}): string {
  return [l.name, l.provider, l.tags, o.images !== false && !l.images ? "no images" : ""].filter(Boolean).join(" · ")
}

/** A model's id or name reduced to its words, to find the same model said two ways: the id
 *  Claude's API answers with ("claude-opus-5-5", "claude-haiku-4-5-20251001") and the name the
 *  agent's list gives it ("Opus 5.5", "Haiku 4.5"). */
export function modelWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/^claude[-\s]/, "")
    .replace(/[-_\s.]\d{8}$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}
