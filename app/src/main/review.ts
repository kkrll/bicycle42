// The notes of one site: their numbers, their status, the draft, and what the page draws as pins.
//
// Pure state: no electron, no timers, no I/O. The controller feeds it what happened (a note was
// submitted, the backend accepted it, the queue moved, the agent stopped) and reads rows for the
// panel, pins for the page and JSON for the disk.
//
// A note's life:  capturing → sending → queued → working → done
//                                 └────────┴────────┴──→ failed  (retry puts it back to sending)
//
// Done and failed are final: no event moves a note out of them, only retry() (or remove()).
// A note belongs to the conversation (session) it was sent to, not to a lane: after "New
// conversation" the lane points somewhere else, and that conversation's events are not about
// the notes sent before. `lane` only says how the note is shown.
import { cssWords, editWords, motionLines } from "../../../overlay/prompt.js"
import type { Box, Edit, Motion, PageNote, Pin } from "../../../overlay/protocol"
import type { InboxStatus, NoteRow, NoteStatus } from "../shared/types"

/** Bump when the saved shape changes; store.ts moves files of any other version aside. */
export const REVIEW_VERSION = 1

// What the overlay sends and is sent: a rectangle (viewport CSS px; the shared `Rect` is the
// window's, with width/height), a canvas edit, a motion note's animation, the note, a pin. They
// are the protocol's, shared with the overlay, and go by the same names here as before.
export type { Box, Edit, Motion, PageNote, Pin }

export type Note = Omit<NoteRow, "edits" | "motion"> & {
  /** Canvas edits, as the page sent them (checked). The row shows them as sentences. */
  edits?: Edit[]
  /** The canvas note's stylesheet of new rules, as typed. */
  css?: string
  /** A motion note's animation (checked). */
  motion?: Motion
  /** The message id the backend gave it; inbox events carry it. Set together with `session`. */
  message?: string
  /** Where its picture was taken: the page, the marked area and the viewport then, so the same
   *  picture can be taken once the agent is done. */
  shot?: { url: string; bounds: Box | null; viewport: PageNote["viewport"] }
  /** For re-finding the pin after the page changes. */
  anchor: { selector?: string; tag?: string; text?: string; component?: string; at?: [number, number] }
}

export type Review = {
  enabled: boolean
  autoReload: boolean
  draft: unknown
  setUnplaced(ids: string[]): void
  readonly unplaced: number
  /** A submitted note: numbers it, status "capturing", clears the draft. Undefined for an id
   *  already in the list (the page sent it twice): nothing is added. */
  add(note: PageNote): Note | undefined
  /** The screenshot is taken and the note is on its way to the agent. */
  sending(id: string): void
  /** `session` accepted it; `message` is the id later inbox events carry. */
  sent(id: string, message: string, session: string): void
  failed(id: string, error: string): void
  /** Puts a failed note back to "sending" for a retry and forgets its message and session;
   *  returns it, or undefined if it isn't failed. */
  retry(id: string): Note | undefined
  /** Queue movement for a message id in a conversation. Returns true when a note changed. */
  inbox(session: string, message: string, status: InboxStatus): boolean
  /** The conversation's agent started or stopped. Returns true when a note changed. */
  run(session: string, status: "started" | "succeeded" | "failed" | "interrupted", error?: string): boolean
  /** The conversation is idle (asked after a restart or reconnect). `waiting` = message ids still
   *  in its queue. Accepted notes on this session that are not waiting are finished → done; the
   *  waiting ones stay queued. */
  settled(session: string, waiting: string[]): boolean
  /** The conversation was deleted: every unfinished note sent to it fails, with a message that
   *  says what to do. */
  gone(session: string): boolean
  /** Conversations that still have unfinished notes. */
  sessions(): string[]
  /** Takes a note off the list, whatever its state. */
  remove(id: string): void
  /** Takes the notes that are done off the list. Failed and stopped ones stay: they can still be
   *  retried. */
  clearDone(): void
  note(id: string): Note | undefined
  rows(): NoteRow[]
  /** What the reviewer, or the app, says of a note beside its status: which pictures it has,
   *  that it was accepted, that it was taken back. `undefined` clears. True when it changed. */
  mark(id: string, change: { pictures?: Note["pictures"]; accepted?: true | undefined; takenBack?: Note["takenBack"] }): boolean
  /** The words of every note a conversation accepted, by conversation: what the list of
   *  conversations counts and searches. */
  said(): Array<{ session: string; text: string }>
  pins(): Pin[]
  /** A note is on its way to the agent or with it (sending, queued, working). Unlike sessions(),
   *  this counts notes still being sent, which have no session yet. */
  inFlight(): boolean
  /** Strict JSON, versioned ({ version: 1, … }), for store.ts. */
  toJSON(): unknown
}

// ── reading what the page and the disk hand us ──────────────────────────────────────────────────
// Both are outside our control: the page under review can call the binding with anything, and a
// saved file may be from another version or hand-edited.

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined)
const box = (x: unknown): Box | null =>
  isObj(x) && num(x.x) && num(x.y) && num(x.w) && num(x.h) ? { x: x.x, y: x.y, w: x.w, h: x.h } : null
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const point = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && num(x[0]) && num(x[1])

const MAX_NOTE_IMAGES = 4
const MAX_IMAGE_CHARS = 8_000_000

/** A base64 image data URI of a sane size, or undefined. Pasted pictures come from the page or
 *  the window, so they are checked before they go to the server. */
export function imageUri(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX_IMAGE_CHARS) return
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw) ? raw : undefined
}

// Canvas edits. Every string here ends up in the prompt or in the panel, so each has a length
// and none may hold a line break or another control character, except the texts of a text edit,
// which the prompt quotes.
const MAX_EDITS = 40
const MAX_NAME = 300
const MAX_VALUE = 64
const MAX_TEXT = 2000
const MAX_EDIT_CSS = 4000
const MAX_NOTE_CSS = 8000
const MAX_CHANGES = 40
/** A computed value: a font stack or a gradient is long. */
const MAX_COMPUTED = 400
const MAX_CLASSES = 1000
const EDIT_KINDS: readonly Edit["kind"][] = ["move", "resize", "gap", "padding", "margin", "text", "hide", "style", "class"]
/** A custom property (`--stripe-period`), as a style edit's changes may name. */
const CUSTOM_PROP = /^--[a-zA-Z0-9_-]{1,60}$/
/** CSS as typed: any text up to `max`, line breaks and all (the prompt fences it), but not blank
 *  and without the control characters no one types. */
const typedCss = (x: unknown, max: number): string | undefined =>
  typeof x === "string" && x.length <= max && x.trim() !== "" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x) ? x : undefined

/** The batch stylesheet of a canvas note, or undefined. Too long is refused, not cut: half a
 *  rule is worse than none. */
export const pageCss = (raw: unknown): string | undefined => typedCss(raw, MAX_NOTE_CSS)
const LAYOUTS: readonly NonNullable<Edit["parent"]>["layout"][] = ["flex-row", "flex-column", "grid", "block"]
const CSS_PROP = /^[a-z][a-z-]{0,39}$/
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/
/** A one-line string of at most `max` characters, or undefined. */
const line = (x: unknown, max: number): string | undefined =>
  typeof x === "string" && x.length <= max && !CONTROL.test(x) ? x : undefined
const index = (x: unknown): x is number => num(x) && Number.isInteger(x) && x >= 0 && x < 100_000
/** `{ selector, label }` of an element named in a move. */
function named(x: unknown): { selector: string; label: string } | undefined {
  if (!isObj(x)) return
  const selector = line(x.selector, MAX_NAME)
  return selector ? { selector, label: line(x.label, MAX_NAME) ?? "" } : undefined
}

/** One edit, checked field by field. Undefined when it is not one the prompt can describe. */
function edit(raw: unknown): Edit | undefined {
  if (!isObj(raw) || !EDIT_KINDS.includes(raw.kind as Edit["kind"])) return
  const kind = raw.kind as Edit["kind"]
  const selector = line(raw.selector, MAX_NAME)
  if (!selector) return
  const text = kind === "text"
  // The texts of a text edit may have line breaks; a CSS value may not.
  const value = (x: unknown) => (text ? (typeof x === "string" && x.length <= MAX_TEXT ? x : undefined) : line(x, MAX_VALUE))
  const from = value(raw.from)
  const to = value(raw.to)
  const prop = typeof raw.prop === "string" && CSS_PROP.test(raw.prop) ? raw.prop : undefined
  // What the edit is about has to be there: a new text, a property and its new value, somewhere to go.
  if (text && to === undefined) return
  if ((kind === "resize" || kind === "gap" || kind === "padding" || kind === "margin") && (!prop || to === undefined)) return
  const out: Edit = { kind, selector, tag: line(raw.tag, 40) ?? "", label: line(raw.label, MAX_NAME) ?? "" }
  const component = line(raw.component, 100)
  if (component) out.component = component
  if (index(raw.repeated) && raw.repeated > 1) out.repeated = raw.repeated
  if (kind === "style") {
    const css = typedCss(raw.css, MAX_EDIT_CSS)
    // Text that is there but can't be used (too long) makes the edit unusable: its changes
    // alone would tell the agent half of it.
    if (css === undefined && typeof raw.css === "string" && raw.css.trim() !== "") return
    const changes: NonNullable<Edit["changes"]> = []
    for (const c of Array.isArray(raw.changes) ? raw.changes.slice(0, MAX_CHANGES) : []) {
      if (!isObj(c) || typeof c.prop !== "string" || !(CSS_PROP.test(c.prop) || CUSTOM_PROP.test(c.prop))) continue
      const [was, now] = [line(c.from, MAX_COMPUTED), line(c.to, MAX_COMPUTED)]
      if (was !== undefined && now !== undefined) changes.push({ prop: c.prop, from: was, to: now })
    }
    if (css === undefined && !changes.length) return
    if (css !== undefined) out.css = css
    out.changes = changes
    return out
  }
  if (kind === "class") {
    const now = line(raw.to, MAX_CLASSES)
    if (now === undefined) return
    out.from = line(raw.from, MAX_CLASSES) ?? ""
    out.to = now
    return out
  }
  if (prop && kind !== "move" && kind !== "hide" && !text) out.prop = prop
  if (from !== undefined && kind !== "move" && kind !== "hide") out.from = from
  if (to !== undefined && kind !== "move" && kind !== "hide") out.to = to
  if (kind === "move") {
    const parent = isObj(raw.parent) ? named(raw.parent) : undefined
    const layout = isObj(raw.parent) && LAYOUTS.includes(raw.parent.layout as (typeof LAYOUTS)[number]) ? (raw.parent.layout as (typeof LAYOUTS)[number]) : "block"
    if (parent) out.parent = { ...parent, layout }
    if (index(raw.fromIndex)) out.fromIndex = raw.fromIndex
    if (index(raw.toIndex)) out.toIndex = raw.toIndex
    const before = raw.before === null ? null : named(raw.before)
    if (before !== undefined) out.before = before
    // A move has to say where to: the sibling it sits before, "last", or a position.
    if (out.before === undefined && out.toIndex === undefined) return
  }
  return out
}

/** The edits of a note, from the page or from disk: the first 40, the malformed ones dropped. */
export function pageEdits(raw: unknown): Edit[] {
  const edits: Edit[] = []
  for (const e of Array.isArray(raw) ? raw.slice(0, MAX_EDITS) : []) {
    const ok = edit(e)
    if (ok) edits.push(ok)
  }
  return edits
}

// Motion. Names are CSS identifiers; values are one line; keyframes are text the prompt fences.
const MOTION_KINDS: readonly Motion["kind"][] = ["keyframes", "transition", "script"]
const MOTION_PROPS: readonly NonNullable<Motion["changes"]>[number]["prop"][] = ["duration", "delay", "easing", "count", "direction", "fill"]
const MOTION_STARTS: readonly NonNullable<Motion["starts"]>[] = ["load", "view", "hover", "click", "appear", "scroll"]
const IDENT = /^-?[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/
const MAX_KEYFRAMES = 4000
const MAX_ANIMATION = 400
/** A motion note's animation, checked field by field. Undefined when it is not one the prompt can
 *  describe: no name, no element, or text that can't be used (too long is refused, not cut). */
export function pageMotion(raw: unknown): Motion | undefined {
  if (!isObj(raw) || !MOTION_KINDS.includes(raw.kind as Motion["kind"])) return
  const kind = raw.kind as Motion["kind"]
  const name = typeof raw.name === "string" && (IDENT.test(raw.name) || (kind === "script" && line(raw.name, 64))) ? raw.name : undefined
  const selector = line(raw.selector, MAX_NAME)
  if (!name || !selector) return
  const out: Motion = { kind, name, selector, label: line(raw.label, MAX_NAME) ?? "" }
  if (kind !== "keyframes") {
    const current = line(raw.current, MAX_ANIMATION)
    if (current) out.current = current
    return out
  }
  if (index(raw.shared) && raw.shared >= 1) out.shared = raw.shared
  if (raw.isNew === true) out.isNew = true
  if (typeof raw.from === "string") {
    if (!IDENT.test(raw.from)) return
    out.from = raw.from
  }
  const pair = (x: unknown, check: (v: unknown) => string | undefined) => {
    if (x === undefined) return null
    if (!isObj(x)) return undefined
    const to = check(x.to)
    if (to === undefined) return undefined
    if (x.from === undefined) return { to }
    const from = check(x.from)
    return from === undefined ? undefined : { to, from }
  }
  const animation = pair(raw.animation, (v) => line(v, MAX_ANIMATION))
  const keyframes = pair(raw.keyframes, (v) => typedCss(v, MAX_KEYFRAMES))
  // Text that is there but can't be used makes the note unusable: half of it would mislead.
  if (animation === undefined || keyframes === undefined) return
  if (animation) out.animation = animation
  if (keyframes) out.keyframes = keyframes
  const changes: NonNullable<Motion["changes"]> = []
  for (const c of Array.isArray(raw.changes) ? raw.changes.slice(0, MOTION_PROPS.length) : []) {
    if (!isObj(c) || !MOTION_PROPS.includes(c.prop as (typeof MOTION_PROPS)[number])) continue
    const [was, now] = [line(c.from, MAX_VALUE * 2), line(c.to, MAX_VALUE * 2)]
    if (was !== undefined && now !== undefined) changes.push({ prop: c.prop as (typeof MOTION_PROPS)[number], from: was, to: now })
  }
  if (changes.length) out.changes = changes
  if (MOTION_STARTS.includes(raw.starts as (typeof MOTION_STARTS)[number])) out.starts = raw.starts as (typeof MOTION_STARTS)[number]
  return out
}

/** Checks a "note" message's payload. Undefined when it isn't a note the rest of the app can use. */
export function pageNote(raw: unknown): PageNote | undefined {
  if (!isObj(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.text !== "string") return
  const v = raw.viewport
  if (!isObj(v) || !num(v.w) || !num(v.h) || v.w <= 0 || v.h <= 0) return
  const targets: PageNote["targets"] = []
  for (const t of Array.isArray(raw.targets) ? raw.targets : []) {
    const rect = isObj(t) ? box(t.rect) : null
    if (!isObj(t) || typeof t.selector !== "string" || !rect) continue
    const c = t.component
    const stack = isObj(c) && Array.isArray(c.stack) ? c.stack.filter((s): s is string => typeof s === "string") : []
    const text = str(t.text)
    const source = isObj(c) ? str(c.source) : undefined
    targets.push({
      selector: t.selector,
      tag: str(t.tag) ?? "",
      ...(text ? { text } : {}),
      rect,
      ...(stack[0] ? { component: { name: stack[0], stack, ...(source ? { source } : {}) } } : {}),
    })
  }
  const strokes = (Array.isArray(raw.strokes) ? raw.strokes : []).filter(
    (s): s is number[][] => Array.isArray(s) && s.every(point),
  )
  const images: NonNullable<PageNote["images"]> = []
  for (const im of Array.isArray(raw.images) ? raw.images.slice(0, MAX_NOTE_IMAGES) : []) {
    const uri = isObj(im) ? imageUri(im.uri) : undefined
    if (uri) images.push({ name: `reference-${images.length + 1}.${uri.slice(11, uri.indexOf(";"))}`, uri })
  }
  const edits = pageEdits(raw.edits)
  const css = pageCss(raw.css)
  const motion = raw.motion === undefined ? undefined : pageMotion(raw.motion)
  // A motion note that can't be read is not a note: sent without it, its words would lose what they are about.
  if (raw.motion !== undefined && !motion) return
  return {
    id: raw.id,
    text: raw.text,
    ...(images.length ? { images } : {}),
    ...(edits.length ? { edits } : {}),
    ...(css ? { css } : {}),
    ...(motion ? { motion } : {}),
    ...(typeof raw.template === "string" && /^[a-z][a-z-]{0,23}$/.test(raw.template) ? { template: raw.template } : {}),
    url: str(raw.url) ?? "",
    viewport: { w: v.w, h: v.h, dpr: num(v.dpr) ? v.dpr : 1, scrollX: num(v.scrollX) ? v.scrollX : 0, scrollY: num(v.scrollY) ? v.scrollY : 0 },
    targets,
    area: box(raw.area),
    strokes,
    bounds: box(raw.bounds),
    ...(raw.lane === "bg" ? { lane: "bg" as const } : {}),
  }
}

const STATUSES: readonly NoteStatus[] = ["capturing", "sending", "queued", "working", "done", "failed"]

function savedNote(raw: unknown): Note | undefined {
  if (!isObj(raw) || typeof raw.id !== "string" || !num(raw.n) || !STATUSES.includes(raw.status as NoteStatus)) return
  const a = isObj(raw.anchor) ? raw.anchor : {}
  const note: Note = {
    id: raw.id,
    n: raw.n,
    text: str(raw.text) ?? "",
    status: raw.status as NoteStatus,
    lane: raw.lane === "bg" ? "bg" : "main",
    anchor: {
      ...(str(a.selector) ? { selector: a.selector as string } : {}),
      ...(str(a.tag) ? { tag: a.tag as string } : {}),
      ...(str(a.text) ? { text: a.text as string } : {}),
      ...(str(a.component) ? { component: a.component as string } : {}),
      ...(point(a.at) ? { at: [a.at[0], a.at[1]] as [number, number] } : {}),
    },
  }
  if (str(raw.error)) note.error = raw.error as string
  if (str(raw.message)) note.message = raw.message as string
  if (str(raw.session)) note.session = raw.session as string
  const edits = pageEdits(raw.edits)
  if (edits.length) note.edits = edits
  const css = pageCss(raw.css)
  if (css) note.css = css
  const motion = pageMotion(raw.motion)
  if (motion) note.motion = motion
  if (raw.pictures === "before" || raw.pictures === "both") note.pictures = raw.pictures
  if (raw.accepted === true) note.accepted = true
  if (raw.takenBack === "undone" || raw.takenBack === "asked") note.takenBack = raw.takenBack
  const shot = isObj(raw.shot) ? raw.shot : undefined
  const v = shot && isObj(shot.viewport) ? shot.viewport : undefined
  const b = shot && isObj(shot.bounds) ? shot.bounds : undefined
  const nums = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof o[k] === "number" && Number.isFinite(o[k]))
  if (shot && str(shot.url) && v && nums(v, ["w", "h", "dpr", "scrollX", "scrollY"]) && (!b || nums(b, ["x", "y", "w", "h"])))
    note.shot = { url: shot.url as string, bounds: b ? (b as unknown as Box) : null, viewport: v as unknown as PageNote["viewport"] }
  // The screenshot and prompt of a note still on its way out died with the app. So did our
  // knowledge of where a note went, if it was saved before notes recorded their session.
  const unsent = note.status === "capturing" || note.status === "sending"
  const untraceable = (note.status === "queued" || note.status === "working") && !(note.message && note.session)
  if (unsent || untraceable) {
    note.status = "failed"
    note.error = ERR.restarted
    delete note.message
    delete note.session
  }
  return note
}

// ── status rules ────────────────────────────────────────────────────────────────────────────────
// Each conversation has its own queue, so an event only moves the notes sent to that conversation.

/** What the reviewer reads under a failed note: what happened, and what to do next. */
const ERR = {
  restarted: "The app was restarted before this note was sent. Retry to send it again.",
  interrupted: "Stopped before it finished. Retry to send it again.",
  cancelled: "Cancelled.",
  gone: "The conversation was deleted. Retry to send it to the current one.",
  agent: (error?: string) => `The agent hit an error${error ? `: ${error.replace(/[.\s]+$/, "")}` : ""}. Retry to send it again.`,
}

/** What the rules move: a note, or a message id that no note owns yet (see `early` below). */
type Track = { session?: string; message?: string; status: NoteStatus; error?: string }

/** How many unowned message ids to remember. Messages typed in the chat land here too and are
 *  never claimed, so the oldest fall off. */
const EARLY_MAX = 64

const finished = (t: Track) => t.status === "done" || t.status === "failed"
/** Accepted by a conversation and not finished there. */
const open = (t: Track) => t.status === "queued" || t.status === "working"

/** An event's move. Done and failed are final, so a late or replayed event can't revive a note. */
function move(t: Track, status: NoteStatus, error?: string): boolean {
  if (finished(t) || t.status === status) return false
  t.status = status
  if (error) t.error = error
  else delete t.error
  return true
}

function finishWorking(tracks: Track[], session: string, to: "done" | "failed", error?: string, except?: Track): boolean {
  let touched = false
  for (const t of tracks)
    if (t.session === session && t.status === "working" && t !== except) touched = move(t, to, error) || touched
  return touched
}

export function createReview(saved?: unknown): Review {
  const from = isObj(saved) ? saved : {}
  let notes: Note[] = []
  for (const raw of Array.isArray(from.notes) ? from.notes : []) {
    const n = savedNote(raw)
    if (n && !notes.some((x) => x.id === n.id)) notes.push(n)
  }
  let unplaced: string[] = []

  // The backend's reply to a prompt (which carries the message id) races the event stream (which
  // says what happened to that id). When the events win, they are about an id no note owns yet:
  // run them on a stand-in here, and let `sent` hand the note whatever the stand-in has become.
  let early: Array<Track & { session: string; message: string }> = []

  const find = (id: string) => notes.find((n) => n.id === id)

  const review: Review = {
    enabled: typeof from.enabled === "boolean" ? from.enabled : true,
    autoReload: typeof from.autoReload === "boolean" ? from.autoReload : true,
    draft: from.draft ?? null,

    setUnplaced(ids) {
      unplaced = ids
    },
    get unplaced() {
      return unplaced.length
    },

    add(pn) {
      if (find(pn.id)) return
      const t = pn.targets[0]
      const at: [number, number] | undefined = pn.bounds
        ? [pn.bounds.x + pn.viewport.scrollX, pn.bounds.y + pn.viewport.scrollY]
        : undefined
      const note: Note = {
        id: pn.id,
        n: (notes.at(-1)?.n ?? 0) + 1,
        text: pn.text,
        status: "capturing",
        lane: pn.lane === "bg" ? "bg" : "main",
        anchor: {
          ...(t?.selector ? { selector: t.selector } : {}),
          ...(t?.tag ? { tag: t.tag } : {}),
          ...(t?.text ? { text: t.text } : {}),
          ...(t?.component?.name ? { component: t.component.name } : {}),
          ...(at ? { at } : {}),
        },
        ...(pn.edits?.length ? { edits: pn.edits } : {}),
        ...(pn.css ? { css: pn.css } : {}),
        ...(pn.motion ? { motion: pn.motion } : {}),
        shot: { url: pn.url, bounds: pn.bounds, viewport: pn.viewport },
      }
      notes.push(note)
      review.draft = null
      return note
    },

    sending(id) {
      const note = find(id)
      if (note?.status === "capturing") note.status = "sending"
    },

    sent(id, message, session) {
      const note = find(id)
      // Only a note that is waiting for this answer: one that failed meanwhile (a timeout) stays
      // failed, and retry sends it afresh.
      if (note?.status !== "sending") return
      note.message = message
      note.session = session
      const i = early.findIndex((e) => e.session === session && e.message === message)
      const [was] = i < 0 ? [] : early.splice(i, 1)
      note.status = "queued"
      if (was) move(note, was.status, was.error)
    },

    failed(id, error) {
      const note = find(id)
      if (note) move(note, "failed", error)
    },

    retry(id) {
      const note = find(id)
      if (note?.status !== "failed") return
      note.status = "sending"
      delete note.error
      // A new send gets a new message id, maybe in another conversation; events for the old one
      // are no longer about this note.
      delete note.message
      delete note.session
      return note
    },

    inbox(session, message, status) {
      const note = notes.find((n) => n.session === session && n.message === message)
      let owner: Track | undefined = note ?? early.find((e) => e.session === session && e.message === message)
      if (!owner) {
        const e = { session, message, status: "queued" as NoteStatus }
        early.push(e)
        if (early.length > EARLY_MAX) early.shift()
        owner = e
      }
      // Only notes count for the result: the caller redraws and saves on true.
      const ours = owner === note
      switch (status) {
        case "queued":
          // Accepted means queued already, and nothing moves backwards.
          return false
        case "working": {
          // Any delivery (ours or a turn typed in the chat) means the previous turn finished.
          const others = finishWorking(notes, session, "done", undefined, owner)
          finishWorking(early, session, "done", undefined, owner)
          return (move(owner, "working") && ours) || others
        }
        case "cancelled":
          return move(owner, "failed", ERR.cancelled) && ours
      }
    },

    run(session, status, error) {
      let touched = false
      switch (status) {
        case "started":
          break
        case "succeeded":
          // The queue ran dry: everything this conversation accepted was delivered in this run,
          // even if a "working" event was missed (a reconnect).
          for (const n of notes) if (n.session === session && open(n)) touched = move(n, "done") || touched
          for (const e of early) if (e.session === session) move(e, "done")
          break
        case "failed":
        case "interrupted": {
          // Only the turn that was running: queued notes are still in the server's queue.
          const why = status === "failed" ? ERR.agent(error) : ERR.interrupted
          touched = finishWorking(notes, session, "failed", why)
          finishWorking(early, session, "failed", why)
          break
        }
      }
      return touched
    },

    settled(session, waiting) {
      let touched = false
      const settle = (t: Track) => t.session === session && open(t) && move(t, waiting.includes(t.message ?? "") ? "queued" : "done")
      for (const n of notes) touched = settle(n) || touched
      early.forEach(settle)
      return touched
    },

    gone(session) {
      let touched = false
      for (const n of notes) if (n.session === session && open(n)) touched = move(n, "failed", ERR.gone) || touched
      early = early.filter((e) => e.session !== session)
      return touched
    },

    sessions: () => [...new Set(notes.filter(open).map((n) => n.session!))],

    remove(id) {
      notes = notes.filter((n) => n.id !== id)
    },

    clearDone() {
      notes = notes.filter((n) => n.status !== "done")
    },

    note: find,

    mark(id, change) {
      const note = find(id)
      if (!note) return false
      let touched = false
      for (const key of ["pictures", "accepted", "takenBack"] as const) {
        if (!(key in change) || note[key] === change[key]) continue
        if (change[key] === undefined) delete note[key]
        else (note as Record<string, unknown>)[key] = change[key]
        touched = true
      }
      return touched
    },

    said: () => notes.flatMap((n) => (n.session ? [{ session: n.session, text: n.text }] : [])),
    rows: () =>
      notes.map((n) => ({
        id: n.id,
        n: n.n,
        text: n.text,
        status: n.status,
        lane: n.lane,
        ...(n.edits || n.css ? { edits: [...(n.edits ?? []).map((e) => editWords(e)), ...(n.css ? [`${capital(cssWords(n.css))}.`] : [])] } : {}),
        ...(n.motion ? { edits: motionLines(n.motion), motion: true as const } : {}),
        ...(n.error ? { error: n.error } : {}),
        ...(n.session && n.message ? { sent: true as const, session: n.session } : {}),
        ...(n.pictures ? { pictures: n.pictures } : {}),
        ...(n.accepted ? { accepted: true as const } : {}),
        ...(n.takenBack ? { takenBack: n.takenBack } : {}),
        ...(n.status === "failed" && (n.error === ERR.interrupted || n.error === ERR.cancelled) ? { stopped: true as const } : {}),
        ...(unplaced.includes(n.id) ? { lost: true as const } : {}),
      })),

    pins: () =>
      notes.map((n) => ({
        id: n.id,
        n: n.n,
        // The page has no look for "not sent yet"; to the reviewer it is waiting either way.
        status:
          n.status === "capturing" || n.status === "sending"
            ? "queued"
            : n.status === "failed" && (n.error === ERR.interrupted || n.error === ERR.cancelled)
              ? "stopped"
              : n.status,
        ...(n.lane === "bg" ? { lane: "bg" as const } : {}),
        ...n.anchor,
        ...(n.text ? { note: n.text.slice(0, 200) } : {}),
      })),

    inFlight: () => notes.some((n) => n.status === "sending" || open(n)),

    // Through JSON, so what goes to disk is exactly what would come back: no undefined, no NaN.
    toJSON: () =>
      JSON.parse(
        JSON.stringify({ version: REVIEW_VERSION, enabled: review.enabled, autoReload: review.autoReload, draft: review.draft ?? null, notes }),
      ),
  }
  return review
}
