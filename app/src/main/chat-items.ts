// What a conversation looks like to the window, built the same way whatever the wire: the
// generic builders opencode.ts and acp.ts share, so a note, a typed message, the app's own asks
// and the end of a run look the same in the chat with either backend.
//
// Payloads are untrusted: every field is read through rec/str/num/list.
import { parseAsk } from "./asks"
import type { ChatImage, ChatMarker, ChatUser, Refused } from "../shared/types"

export type Warn = (msg: string, data?: unknown) => void

// ── reading untrusted JSON ──────────────────────────────────────────────────────────────────────

export type Raw = Record<string, unknown>

export const rec = (v: unknown): Raw => (v !== null && typeof v === "object" ? (v as Raw) : {})
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Drops undefined fields, so an item built from events deep-equals the one built from a re-read. */
export function defined<T extends object>(o: T): T {
  for (const k in o) if (o[k] === undefined) delete o[k]
  return o
}

export const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s)

// ── messages ─────────────────────────────────────────────────────────────────────────────────────

const NOTE_HEAD = /^UI review note (\d+) on /
/** The lines notePrompt (overlay/prompt.js) can put after the note's text. */
const NOTE_END =
  /^(Elements \(page-provided |Marked area: |The reviewer drew \d|Canvas edits, made on the live page |Image 1 is the |The attached screenshot shows |Purple outlines mark |An outline marks |Make the smallest change |Template \/[a-z-]+: )/

/** Finds the reviewer's own words in a review-note prompt, so the chat can show those instead of
 *  the whole prompt. The note may span lines: it runs until the next line the prompt adds. */
export function parseNote(text: string): { n: number; text: string } | undefined {
  const lines = text.split("\n")
  const head = NOTE_HEAD.exec(lines[0] ?? "")
  if (!head || !lines[1]?.startsWith("Note: ")) return undefined
  let end = 2
  while (end < lines.length && !NOTE_END.test(lines[end]!)) end++
  return { n: Number(head[1]), text: lines.slice(1, end).join("\n").slice("Note: ".length) }
}

/** A file whose data this client dropped after naming it (see `transcript`): still a picture. */
export const DROPPED = "\u0000dropped"

/** `payload` is a user message or an inbox item's payload: both are `{ text, files? }`. With
 *  `named`, a picture is shown by the address it gives (`file` is its place in the files). */
export function userItem(id: string, time: number, payload: Raw, pending: boolean, named?: (file: number, mime: string, data?: string) => string): ChatUser {
  const text = str(payload.text) ?? ""
  const images: ChatImage[] = []
  for (const [i, raw] of list(payload.files).entries()) {
    const file = rec(raw)
    const mime = str(file.mime)
    const data = str(file.data)
    if (!mime?.startsWith("image/") || !data) continue
    const src = named ? named(i, mime, data === DROPPED ? undefined : data) : `data:${mime};base64,${data}`
    images.push({ name: str(file.name) ?? "image", src })
  }
  return defined({ kind: "user", id, time, text, images, note: parseNote(text), ask: parseAsk(text), pending: pending || undefined })
}

/** The end of a run. A run that succeeded leaves no line. `refused`: it failed because the
 *  model's provider refused the agent's key; the line then offers another model and the fix. */
export function endMarker(id: string, time: number, outcome: unknown, error: unknown, refused?: Refused): ChatMarker | undefined {
  if (outcome === "interrupted") return { kind: "marker", id, time, text: "Stopped", tone: "error" }
  if (outcome === "failed")
    return defined({ kind: "marker", id, time, text: `Failed: ${str(rec(error).message) ?? "unknown error"}`, tone: "error", failed: true, refused: refused && { ...refused } }) as ChatMarker
  return undefined
}
