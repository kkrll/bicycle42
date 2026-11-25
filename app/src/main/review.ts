// The notes of one site: their numbers, their status, the draft, and what the page draws as pins.
//
// Pure state: no electron, no timers, no I/O. The controller feeds it what happened (a note was
// submitted, the backend accepted it, the queue moved, the agent stopped) and reads rows for the
// panel, pins for the page and JSON for the disk.
//
// A note's life:  capturing → sending → queued → working → done
//                                 └────────┴────────┴──→ failed  (retry puts it back to sending)
//
// A note is sent only when its lane has no other note with the agent: prompts that reach a busy
// conversation join the turn that is running, and a turn is what the server can show the changes
// of and take back. Until then the note is held here: "queued" to the reviewer, with no
// conversation yet (hold → release → sending → sent).
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
  /** Waiting in the app for its lane to be free: "queued", and not sent to any conversation. */
  held?: true
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
  /** The page's word on which pins it can't place now (a new document has said nothing yet: []). */
  setUnplaced(ids: string[]): void
  /** Of the notes on the list and not done, those whose pin the page said it can't place: 0 with
   *  review off, where no pin is drawn, so nothing is known of them. */
  readonly unplaced: number
  /** A submitted note: numbers it, status "capturing", clears the draft. Undefined for an id
   *  already in the list (the page sent it twice): nothing is added. */
  add(note: PageNote): Note | undefined
  /** The screenshot is taken and the note is on its way to the agent. */
  sending(id: string): void
  /** A note on its way out waits its turn in the app instead: "queued", with no conversation. */
  hold(id: string): void
  /** The held note that may go now: the first of its lane, when no other note of the lane is on
   *  its way to the agent or with it. */
  next(lane: NoteRow["lane"]): Note | undefined
  /** Puts a held note on its way ("sending") and returns it. */
  release(id: string): Note | undefined
  /** A held note is taken out of the queue: it stays on the list, stopped. True when it was held. */
  cancel(id: string): boolean
  /** Every held note of a lane is taken out of the queue (Stop): stopped, with Retry. True when
   *  one was. */
  cancelHeld(lane: NoteRow["lane"]): boolean
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
  /** The note a conversation's message is, if any. */
  byMessage(session: string, message: string): Note | undefined
  rows(): NoteRow[]
  /** What the reviewer, or the app, says of a note beside its status: which pictures it has,
   *  that it was taken back. `undefined` clears. True when it changed. */
  mark(id: string, change: { pictures?: Note["pictures"]; takenBack?: Note["takenBack"] }): boolean
  /** The words of every note a conversation accepted, by conversation: what the list of
   *  conversations counts and searches. */
  said(): Array<{ session: string; text: string }>
  /** `held`: a conversation that waits on the reviewer's answer (a permission, a question); a
   *  note being worked on in it is "asking", as the window's list shows it. */
  pins(held?: (session: string) => boolean): Pin[]
  /** A note is on its way to the agent or with it (sending, queued, working). Unlike sessions(),
   *  this counts notes still being sent, which have no session yet. */
  inFlight(): boolean
  /** Strict JSON, versioned ({ version: 1, … }), detached from the review. */
  toJSON(): unknown
  /** The same, still sharing the review's own objects: to be turned into text at once and not
   *  kept. What store.ts writes, which it serialises only when the write is due. */
  stored(): unknown
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
const EDIT_KINDS: readonly Edit["kind"][] = ["move", "resize", "gap", "padding", "margin", "text", "hide", "style", "class", "duplicate"]
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
  if (index(raw.copyOf)) out.copyOf = raw.copyOf // (checked against the note's edits in pageEdits)
  else if (typeof raw.inCopy === "string") out.inCopy = line(raw.inCopy, MAX_NAME) ?? ""
  if (kind === "style") {
    const css = typedCss(raw.css, MAX_EDIT_CSS)
    // Text that is there but can't be used (too long) makes the edit unusable: its changes
    // alone would tell the agent half of it.
    if (css === undefined && typeof raw.css === "string" && raw.css.trim() !== "") return
    const changes: NonNullable<Edit["changes"]> = []
    for (const c of Array.isArray(raw.changes) ? raw.changes.slice(0, MAX_CHANGES) : []) {
      if (!isObj(c) || typeof c.prop !== "string" || !(CSS_PROP.test(c.prop) || CUSTOM_PROP.test(c.prop))) continue
      const [was, now] = [line(c.from, MAX_COMPUTED), line(c.to, MAX_COMPUTED)]
      // The page's variables the value was set with: names only, four at most.
      const tokens = Array.isArray(c.tokens) ? [...new Set(c.tokens.slice(0, 4).filter((t): t is string => typeof t === "string" && CUSTOM_PROP.test(t)))] : []
      if (was !== undefined && now !== undefined) changes.push({ prop: c.prop, from: was, to: now, ...(tokens.length ? { tokens } : {}) })
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
  if (text) {
    // Which of its words, on an element with elements inside: after one of them, or before the first.
    const after = line(raw.textAfter, MAX_NAME)
    const before = after ? undefined : line(raw.textBefore, MAX_NAME)
    if (after) out.textAfter = after
    else if (before) out.textBefore = before
  }
  const bare = kind === "move" || kind === "hide" || kind === "duplicate"
  if (prop && !bare && !text) out.prop = prop
  if (from !== undefined && !bare) out.from = from
  if (to !== undefined && !bare) out.to = to
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
  const at = new Map<number, number>() // an edit's place in `raw` → in `edits`
  ;(Array.isArray(raw) ? raw.slice(0, MAX_EDITS) : []).forEach((e, i) => {
    const ok = edit(e)
    if (!ok) return
    at.set(i, edits.length)
    edits.push(ok)
  })
  // "In the copy made by edit N": N must be a duplicate edit that is still there.
  edits.forEach((e, i) => {
    if (e.copyOf === undefined) return
    const j = at.get(e.copyOf)
    if (j === undefined || j === i || edits[j]?.kind !== "duplicate") delete e.copyOf
    else e.copyOf = j
  })
  return edits
}

// Motion. Names are CSS identifiers; values are one line; keyframes are text the prompt fences.
const MOTION_KINDS: readonly Motion["kind"][] = ["keyframes", "transition", "script", "frames"]
const MOTION_PROPS: readonly NonNullable<Motion["changes"]>[number]["prop"][] = ["duration", "delay", "easing", "count", "direction", "fill"]
const MOTION_STARTS: readonly NonNullable<Motion["starts"]>[] = ["load", "view", "hover", "click", "appear", "scroll"]
const IDENT = /^-?[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/
const SEEN_PROP = /^-{0,2}[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/
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
  const pair = (x: unknown, check: (v: unknown) => string | undefined) => {
    if (x === undefined) return null
    if (!isObj(x)) return undefined
    const to = check(x.to)
    if (to === undefined) return undefined
    if (x.from === undefined) return { to }
    const from = check(x.from)
    return from === undefined ? undefined : { to, from }
  }
  if (kind === "frames") {
    const seen = (Array.isArray(raw.seen) ? raw.seen.slice(0, 12) : []).flatMap((s) => {
      const prop = isObj(s) && typeof s.prop === "string" && SEEN_PROP.test(s.prop) ? s.prop : undefined, range = isObj(s) ? line(s.range, MAX_ANIMATION) : undefined
      return prop && range ? [{ prop, range }] : []
    })
    if (seen.length) out.seen = seen
    for (const k of ["over", "cycle"] as const) if (index(raw[k]) && raw[k] > 0) out[k] = raw[k]
    return out
  }
  if (kind !== "keyframes") {
    const current = line(raw.current, MAX_ANIMATION)
    if (current) out.current = current
    const next = line(raw.next, MAX_ANIMATION), state = kind === "transition" ? line(raw.state, MAX_ANIMATION) : undefined
    if (next) out.next = next
    if (state) out.state = state
    if (state && (raw.stateBy === "named" || raw.stateBy === "recorded")) out.stateBy = raw.stateBy
    if (kind === "transition") {
      const values: NonNullable<Motion["values"]> = []
      for (const c of Array.isArray(raw.values) ? raw.values.slice(0, 20) : []) {
        if (!isObj(c)) continue
        const [when, prop, was, now] = [line(c.state, MAX_NAME), line(c.prop, 41), line(c.from, MAX_VALUE * 2), line(c.to, MAX_VALUE * 2)]
        if (when && prop && /^-{0,2}[a-z][a-z-]*$/.test(prop) && was !== undefined && now) values.push({ state: when, prop, from: was, to: now })
      }
      if (values.length) out.values = values
    }
    const keys = kind === "script" ? pair(raw.keyframes, (v) => typedCss(v, MAX_KEYFRAMES)) : null
    if (keys === undefined) return
    if (keys) out.keyframes = keys
    return out
  }
  if (index(raw.shared) && raw.shared >= 1) out.shared = raw.shared
  if (raw.isNew === true) out.isNew = true
  if (typeof raw.from === "string") {
    if (!IDENT.test(raw.from)) return
    out.from = raw.from
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
  if (raw.held === true && raw.status === "queued") note.held = true
  // ("undone", by an OpenCode server's own undo, is no longer a way: such a note is shown as done.)
  if (raw.takenBack === "restored" || raw.takenBack === "asked") note.takenBack = raw.takenBack
  const shot = isObj(raw.shot) ? raw.shot : undefined
  const v = shot && isObj(shot.viewport) ? shot.viewport : undefined
  const b = shot && isObj(shot.bounds) ? shot.bounds : undefined
  const nums = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof o[k] === "number" && Number.isFinite(o[k]))
  if (shot && str(shot.url) && v && nums(v, ["w", "h", "dpr", "scrollX", "scrollY"]) && (!b || nums(b, ["x", "y", "w", "h"])))
    note.shot = { url: shot.url as string, bounds: b ? (b as unknown as Box) : null, viewport: v as unknown as PageNote["viewport"] }
  // The screenshot and prompt of a note still on its way out died with the app. So did our
  // knowledge of where a note went, if it was saved before notes recorded their session.
  const unsent = note.status === "capturing" || note.status === "sending"
  // (A held note has no conversation yet, and what it sends is on disk: it waits on.)
  const untraceable = (note.status === "queued" || note.status === "working") && !(note.message && note.session) && !note.held
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
  // Counted from the list, not from what the page said: the page says nothing in Preview (it
  // draws no pins), so a note taken off there stays in its last word. A done note is not
  // counted: the agent's change is often what moved its element.
  const lost = (n: Note) => review.enabled && n.status !== "done" && unplaced.includes(n.id)

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
      return notes.filter(lost).length
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

    hold(id) {
      const note = find(id)
      if (note?.status !== "sending") return
      note.status = "queued"
      note.held = true
    },

    next(lane) {
      let first: Note | undefined
      for (const n of notes) {
        if (n.lane !== lane) continue
        if (n.status === "sending" || (open(n) && !n.held)) return undefined
        if (n.held && n.status === "queued") first ??= n
      }
      return first
    },

    release(id) {
      const note = find(id)
      if (!note?.held || note.status !== "queued") return
      delete note.held
      note.status = "sending"
      return note
    },

    cancel(id) {
      const note = find(id)
      if (!note?.held || note.status !== "queued") return false
      delete note.held
      return move(note, "failed", ERR.cancelled)
    },

    cancelHeld(lane) {
      let touched = false
      for (const n of notes) {
        if (n.lane !== lane || !n.held || n.status !== "queued") continue
        delete n.held
        touched = move(n, "failed", ERR.cancelled) || touched
      }
      return touched
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
      if (!note) return
      delete note.held
      move(note, "failed", error)
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

    sessions: () => [...new Set(notes.flatMap((n) => (open(n) && n.session ? [n.session] : [])))],

    remove(id) {
      notes = notes.filter((n) => n.id !== id)
    },

    clearDone() {
      notes = notes.filter((n) => n.status !== "done")
    },

    note: find,
    byMessage: (session, message) => notes.find((n) => n.message === message && n.session === session),

    mark(id, change) {
      const note = find(id)
      if (!note) return false
      let touched = false
      for (const key of ["pictures", "takenBack"] as const) {
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
        ...(n.takenBack ? { takenBack: n.takenBack } : {}),
        ...(n.status === "failed" && (n.error === ERR.interrupted || n.error === ERR.cancelled) ? { stopped: true as const } : {}),
        ...(lost(n) ? { lost: true as const } : {}),
      })),

    pins: (held) =>
      notes.map((n) => ({
        id: n.id,
        n: n.n,
        // As the window's list shows it (its badge is the reference): not with the agent yet, and
        // stopped or taken back, are a broken outline there and here.
        status:
          n.status === "capturing" || n.status === "sending"
            ? "sending"
            : n.takenBack || (n.status === "failed" && (n.error === ERR.interrupted || n.error === ERR.cancelled))
              ? "stopped"
              : n.status === "working" && n.session && held?.(n.session)
                ? "asking"
                : n.status,
        ...(n.lane === "bg" ? { lane: "bg" as const } : {}),
        ...n.anchor,
        ...(n.text ? { note: n.text.slice(0, 200) } : {}),
      })),

    inFlight: () => notes.some((n) => n.status === "sending" || open(n)),

    // Through JSON, so what goes to disk is exactly what would come back: no undefined, no NaN.
    toJSON: () => JSON.parse(JSON.stringify(review.stored())),
    stored: () => ({ version: REVIEW_VERSION, enabled: review.enabled, autoReload: review.autoReload, draft: review.draft ?? null, notes }),
  }
  return review
}
