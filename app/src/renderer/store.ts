// The window's two pieces of data and the only code that writes them.
//
//   state   main's AppState snapshot. Main pushes the whole thing on every change; reconcile()
//           diffs it into the store so only what changed re-renders (a note's status flips one
//           badge, not 200 rows).
//   chat    the open conversation, built here from ChatEvents. A delta touches one string.
//
// Everything else in the renderer reads these and calls act().
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import type { PromptFile } from "../shared/types"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { PHONE } from "../shared/types"
import type { AppState, Bridge, ChatEvent, ChatItem, CommandName, Commands, Pane, PanelAct, PanelMessage } from "../shared/types"
import type { FactsView } from "../../../overlay/protocol-facts"
import type { TokensView } from "../../../overlay/protocol-tokens"

const EMPTY: AppState = {
  connection: { status: "unconfigured" },
  page: { url: "", loading: false, canGoBack: false, canGoForward: false, hmr: false, device: "desktop", phone: PHONE.id },
  review: { enabled: false, mode: "preview", brush: false, autoReload: false, notes: [], unplaced: 0, docks: [] },
  site: null,
  session: null,
  sessions: [],
  models: [],
  agents: [],
  permissions: [],
  questions: [],
}

export let b42: Bridge
export const [state, setState] = createStore<AppState>(EMPTY)
export const [chat, setChat] = createStore<{ items: ChatItem[] }>({ items: [] })

/** False until main's first snapshot lands, so the window never flashes the connect form. */
export const [ready, setReady] = createSignal(false)

/** A command failed and no form owns the error: shown in a strip under the top bar. */
export const [notice, setNotice] = createSignal("")

export const mac = () => b42.platform === "darwin"

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Fire a command whose failure has no better home than the notice strip. */
export function act<K extends CommandName>(name: K, ...args: Parameters<Commands[K]>): void {
  b42.invoke(name, ...args).catch((err) => setNotice(message(err)))
}

/** Main's "no conversation" resets carry an empty session id. */
const openId = () => state.session?.id ?? ""

// A reset for the conversation main is about to announce can arrive before the snapshot that
// names it. Hold the latest such reset instead of dropping it; nothing else is kept.
let parked: Extract<ChatEvent, { type: "reset" }> | undefined

// ── the page's docks, drawn here ────────────────────────────────────────────────────────────────
// What the overlay last said each hosted pane shows (shared/types.ts): the whole view, or the
// fields of it that changed, diffed into the store so a dock redraws only what changed. A dock component reads its view
// from here and asks through dockAct; it keeps nothing of the page's itself. The facts pane's
// view is null when the overlay works nothing out for it (a new page, or after "stop"). A pane
// has no view before its overlay first speaks, and none while the page's renderer is gone
// (start, below).
export const [dockViews, setDockViews] = createStore<{ motion?: object; canvas?: object; facts?: FactsView | null; tokens?: TokensView | null }>({})

/** From a hosted dock to the overlay: what the reviewer did there. */
export const dockAct = (act: PanelAct): void => void b42.invoke("panel", act).catch(() => {})

/** Pings waiting for the overlay's answer, by id. */
const pings = new Map<number, (ms: number) => void>()
let pingId = 0
/** The way to the overlay and back for one message, in ms: what a drag in a dock waits for
 *  before the page shows it. Undefined when nothing answers in a second (no page, no overlay,
 *  a dock that is not hosted). */
export function dockPing(panel: Pane): Promise<number | undefined> {
  const id = ++pingId, from = performance.now()
  return new Promise((done) => {
    pings.set(id, () => done(performance.now() - from))
    setTimeout(() => pings.delete(id) && done(undefined), 1000)
    dockAct({ panel, act: { type: "ping", id } })
  })
}

function onPanel(msg: PanelMessage): void {
  if ("pong" in msg) {
    pings.get(msg.pong)?.(0)
    pings.delete(msg.pong)
  } else if ("part" in msg) {
    // The fields that changed, each in place of the one here. With no view to put them in (this
    // window missed it), the whole one is asked for, and this part is in it.
    if (!dockViews[msg.panel]) return dockAct({ panel: msg.panel, act: { type: "whole" } })
    const put = setDockViews as unknown as (panel: Pane, key: string, to: unknown) => void
    batch(() => {
      for (const [key, to] of Object.entries(msg.part)) put(msg.panel, key, reconcile(to as object))
    })
  } else if (msg.view === null) setDockViews(msg.panel, null)
  else setDockViews(msg.panel, reconcile(msg.view as object))
}

export function start(bridge: Bridge): void {
  b42 = bridge
  bridge.onPanel(onPanel)
  bridge.onState((next) => {
    const before = openId()
    // A page whose renderer died has no overlay: what it last said of its panes is of a page
    // that is not there, and nothing will say otherwise. No view at all, not null: the overlay
    // of the page loaded again says null itself, which is what the facts pane asks again on.
    if (next.page.crashed) setDockViews({ motion: undefined, canvas: undefined, facts: undefined, tokens: undefined })
    setState(reconcile(next))
    setReady(true)
    if (openId() === before) return
    setChat("items", parked?.session === openId() ? parked.items : [])
    parked = undefined
  })
  bridge.onChat(applyChat)
}

// Paths into an assistant item's parts go through a union the store's path types cannot follow;
// the callers below have already checked the item's kind.
const setPath = setChat as unknown as (...path: unknown[]) => void

function indexOf(id: string): number {
  // Newest last, and nearly every event is about the newest item: search from the end.
  const items = unwrap(chat.items)
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.id === id) return i
  return -1
}

/** Replace the transcript with `next`, touching only what differs. Main sends a reset on every
 *  reconnect, usually with the conversation already on screen: items that are still there are
 *  updated in place (matched by id, their parts by key), so rows keep their DOM, open diffs stay
 *  open and a text selection survives. Another conversation shares no ids and replaces cleanly. */
function reset(next: ChatItem[]): void {
  const at = new Map<string, number>()
  unwrap(chat.items).forEach((item, i) => at.set(item.id, i))
  batch(() => {
    for (const item of next) {
      const i = at.get(item.id)
      if (i !== undefined) setChat("items", i, reconcile(item, { key: "key" }))
    }
    const old = unwrap(chat.items)
    const items = next.map((item) => old[at.get(item.id) ?? -1] ?? item)
    if (items.length !== old.length || items.some((item, i) => item !== old[i])) setChat("items", items)
  })
}

export function applyChat(e: ChatEvent): void {
  if (e.session !== openId()) {
    if (e.type === "reset") parked = e
    return
  }
  switch (e.type) {
    case "reset":
      reset(e.items)
      return
    case "item": {
      const i = indexOf(e.item.id)
      if (i < 0) setChat("items", chat.items.length, e.item)
      // Parts are matched by `key`, so a re-sent item keeps its rendered parts.
      else setChat("items", i, reconcile(e.item, { key: "key" }))
      return
    }
    case "part": {
      const i = indexOf(e.item)
      const item = i < 0 ? undefined : unwrap(chat.items)[i]
      if (item?.kind !== "assistant") return
      const j = item.parts.findIndex((p) => p.key === e.part.key)
      if (j < 0) setPath("items", i, "parts", item.parts.length, e.part)
      else setPath("items", i, "parts", j, reconcile(e.part, { key: "key" }))
      return
    }
    case "delta": {
      const i = indexOf(e.item)
      const item = i < 0 ? undefined : unwrap(chat.items)[i]
      if (item?.kind !== "assistant") return
      // Streaming appends to the last part; look there first.
      let j = item.parts.length - 1
      while (j >= 0 && item.parts[j]!.key !== e.key) j--
      const part = item.parts[j]
      if (!part || part.kind === "tool") return
      setPath("items", i, "parts", j, "text", (t: string) => t + e.text)
      return
    }
    case "delivered": {
      // The agent picked the message up: it stops waiting and becomes the newest thing that
      // happened. The same object moves, so its row (and its loaded thumbnails) moves with it.
      const i = indexOf(e.item)
      if (i < 0) return
      batch(() => {
        setPath("items", i, "pending", undefined)
        setPath("items", i, "time", e.time)
        const items = unwrap(chat.items)
        if (i < items.length - 1) setChat("items", [...items.slice(0, i), ...items.slice(i + 1), items[i]!])
      })
      return
    }
    case "remove":
      if (indexOf(e.item) >= 0) setChat("items", (items) => items.filter((x) => x.id !== e.item))
      return
  }
}

// ── small helpers shared by the components ──────────────────────────────────────────────────────

/** localStorage can throw (disabled storage); the UI must still come up with defaults. */
export function recall(key: string): string | null {
  try {
    return localStorage.getItem(`b42.${key}`)
  } catch {
    return null
  }
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(`b42.${key}`, value)
  } catch {
    // Not remembered; nothing to tell the user.
  }
}

/** "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere. */
export function keys(...parts: ("mod" | "shift" | "alt" | "enter" | "up" | "down" | (string & {}))[]): string {
  const m = mac()
  const names: Record<string, string> = m
    ? { mod: "⌘", shift: "⇧", alt: "⌥", enter: "↵", up: "↑", down: "↓" }
    : { mod: "Ctrl", shift: "Shift", alt: "Alt", enter: "Enter", up: "↑", down: "↓" }
  return parts.map((p) => names[p] ?? p).join(m ? "" : "+")
}

/** "localhost:3000" from an origin or URL; the input itself when it does not parse. */
export function host(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The note whose pin was last clicked on the page. `at` changes on every click, so clicking the
 *  same pin twice still counts. The notes list highlights it; the chat scrolls to its message. */
export const [focusedNote, setFocusedNote] = createSignal<{ id: string; at: number } | null>(null)

/** The note that is open as a view of its own, over the list and the conversation; "" for none. */
export const [openedNote, setOpenedNote] = createSignal("")

/** Words put into the message box from elsewhere (a note's "Follow up"). `at` changes on every
 *  press, so the same words twice still count. */
export const [followUp, setFollowUp] = createSignal<{ text: string; at: number } | null>(null)

/** The notes list is open (not folded to its header). Shared: the top bar's count and a clicked
 *  pin both open it. */
export const [notesOpen, setNotesOpenSignal] = createSignal(recall("notes.open") !== "0")
export function setNotesOpen(open: boolean): void {
  setNotesOpenSignal(open)
  remember("notes.open", open ? "1" : "0")
}

/** The facts pane marks every element it lists on the phone's page: off unless turned on (the
 *  page in Preview is the page; an element is outlined while its row or its kind's count is
 *  pointed at). */
export const [factsMarks, setFactsMarksSignal] = createSignal(recall("facts.marks") === "1")
export function setFactsMarks(on: boolean): void {
  setFactsMarksSignal(on)
  remember("facts.marks", on ? "1" : "0")
}

/** The agent is unreachable: nothing moves until it is back. */
export const offline = () => state.connection.status === "offline"
/** The computer an agent runs on over ssh can't be reached, and the agent works on there: its
 *  host, while that lasts. */
export const awayHost = (): string | undefined => (state.connection.status === "offline" && state.connection.away ? (state.harness?.host ?? "its computer") : undefined)
/** A conversation (the open one by default) is held up on the reviewer: a permission or a
 *  question of its own waits for an answer, so nothing goes on in it meanwhile. */
export const asking = (session: string | undefined = state.session?.id): boolean =>
  !!session && (state.permissions.some((p) => p.session === session) || state.questions.some((q) => q.session === session))

/** The reviewer asked for the notes list while the panel is too cramped to open it by default
 *  (a pin was clicked, the top bar's counts, the list's own header). Lasts until the app restarts. */
export const [notesForced, setNotesForced] = createSignal(false)
/** Opens the notes list, even in a cramped panel. */
export function expandNotes(): void {
  setNotesForced(true)
  setNotesOpen(true)
}

/** Something of the window's needs the whole window (a picture opened large): the page view,
 *  which paints over the window, is taken away meanwhile. */
export const [pageCovered, setPageCovered] = createSignal(false)
/** The list of projects, and what it was opened for: "all" from the conversation's "+" (a new
 *  conversation, or another project), "projects" from the project's name (another project). */
export const [switcherOpen, setSwitcherOpen] = createSignal<false | "all" | "projects">(false)

/** A note's state as the reviewer reads it: a "working" note is only working while the agent
 *  is reachable. */
export type NoteShown = AppState["review"]["notes"][number]["status"] | "paused" | "stopped"
/** "stopped": it ended because the reviewer stopped the agent or set it aside, not a failure. */
export const noteShown = (note: AppState["review"]["notes"][number]): NoteShown =>
  note.status === "failed" && note.stopped
    ? "stopped"
    : note.status === "working" && offline() && !awayHost()
      ? "paused"
      : note.status

/** The number the next note will have (main numbers on from the last one: review.ts). */
export const nextNoteNumber = () => (state.review.notes.at(-1)?.n ?? 0) + 1
/** What a dock's note field says while empty: the same words in Edit and Motion. */
export const NOTE_OPTIONAL = "Note for the agent (optional)"

/** The one count of the notes every place shows (top bar, list header): all from
 *  `state.review.notes`, so they cannot disagree. `left` is everything not finished, failed
 *  or stopped; failed + left + stopped + done = total. */
export function tallyNotes() {
  const t = { total: 0, failed: 0, working: 0, paused: 0, waiting: 0, stopped: 0, done: 0, left: 0 }
  for (const note of state.review.notes) {
    const s = noteShown(note)
    t.total++
    if (s === "failed") t.failed++
    else if (s === "stopped") t.stopped++
    else if (s === "done") t.done++
    else {
      t.left++
      if (s === "working") t.working++
      else if (s === "paused") t.paused++
      else t.waiting++
    }
  }
  return t
}

// ── unsent work, sent from the message box ──────────────────────────────────────────────────────
// What a view has changed and not sent (the design system's values and suggestions, Edit's
// batch, Motion's animation) is sent from the one box messages are typed in (composer.tsx): it
// shows there as chips, the words typed go with it, and Send sends it. A view offers what it has
// while it is up (offerPending). While the box is not on screen (the panel shut, or no agent to
// tell) a dock keeps a note line and a Send of its own: composerUp says which.
export type PendingItem = {
  id: string
  label: string
  title?: string
  /** A colour drawn before the label. */
  swatch?: string
  /** Its ×: taken out of what is sent (a changed value: put back). */
  remove?: () => void
}
export type PendingSource = {
  items: () => PendingItem[]
  /** Send what is unsent with these words (and pictures, when it can carry them). */
  send: (words: string, background: boolean, pictures: PromptFile[]) => Promise<unknown> | void
}
const [sources, setSources] = createSignal<readonly PendingSource[]>([])
/** The sources with something to send now. */
export const pendingSources = () => sources().filter((s) => s.items().length > 0)
/** While the calling component is mounted, what it has unsent is the message box's to send. */
export function offerPending(source: PendingSource): void {
  onMount(() => setSources((all) => [...all, source]))
  onCleanup(() => setSources((all) => all.filter((x) => x !== source)))
}
const [panelUp, setPanelUp] = createSignal(false)
const [composerReady, setComposerReady] = createSignal(false)
export { setPanelUp, setComposerReady }
/** The message box is on screen and can send. */
export const composerUp = () => panelUp() && composerReady()
