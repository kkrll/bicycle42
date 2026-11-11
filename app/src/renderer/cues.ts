// When the app makes a sound. Pure: it compares two snapshots of main's state, or reads one
// chat event, and names a cue. sound.ts plays what comes out.
//
//   question   something waits for the reviewer: the agent asked, or wants permission
//   negative   the server was lost, a note failed, or the agent's run failed
//   routine    the agent finished and nothing sent is still on its way
//
// "hush" is not a sound: the reviewer stopped the agent, so its coming to rest is no news.
import type { AppState, ChatEvent } from "../shared/types"

export type Cue = "question" | "negative" | "routine"

/** What of a snapshot the sounds depend on. */
export type Heard = {
  /** The site and conversation it is about. Another one is not a change to announce. */
  scope: string
  /** The last of online | offline the server was; "" before either. */
  link: "online" | "offline" | ""
  asks: ReadonlySet<string>
  failed: ReadonlySet<string>
  stopped: ReadonlySet<string>
  /** Notes on their way: being captured, sent, waiting or worked on. */
  flying: ReadonlySet<string>
  done: ReadonlySet<string>
  busy: boolean
}

export function hear(state: AppState, before?: Heard): Heard {
  const status = state.connection.status
  const notes = state.review.notes
  const ids = (keep: (note: (typeof notes)[number]) => boolean) => new Set(notes.filter(keep).map((n) => n.id))
  return {
    scope: `${state.site?.origin ?? ""}|${state.session?.id ?? ""}`,
    // "connecting" between two tries is neither: the server is still what it was.
    link: status === "online" || status === "offline" ? status : (before?.link ?? ""),
    asks: new Set([...state.permissions.map((p) => `p:${p.id}`), ...state.questions.map((q) => `q:${q.id}`)]),
    failed: ids((n) => n.status === "failed" && !n.stopped),
    stopped: ids((n) => n.status === "failed" && !!n.stopped),
    flying: ids((n) => n.status !== "done" && n.status !== "failed"),
    done: ids((n) => n.status === "done"),
    busy: !!state.session?.busy,
  }
}

const gained = (before: ReadonlySet<string>, now: ReadonlySet<string>) => [...now].some((id) => !before.has(id))

/** The cue for going from one snapshot to the next: at most one, the most pressing. */
export function cueFor(before: Heard | undefined, now: Heard): Cue | "hush" | null {
  // The first snapshot is how things already were.
  if (!before) return null
  if (before.link === "online" && now.link === "offline") return "negative"
  if (before.scope !== now.scope) return null
  if (gained(before.asks, now.asks)) return "question"
  if (gained(before.failed, now.failed)) return "negative"
  if (gained(before.stopped, now.stopped)) return "hush"
  // At rest, and something did finish: the run ended, or a note that was on its way is done.
  // (A note taken off the list, or the list cleared, also leaves nothing flying; that is not it.)
  const working = (h: Heard) => h.busy || h.flying.size > 0
  const finished = (before.busy && !now.busy) || [...before.flying].some((id) => now.done.has(id))
  if (working(before) && !working(now) && finished) return "routine"
  return null
}

/** The cue in a chat event: the line a run leaves when it ends badly. */
export function chatCue(e: ChatEvent): Cue | "hush" | null {
  if (e.type !== "item" || e.item.kind !== "marker" || e.item.tone !== "error") return null
  return e.item.failed ? "negative" : "hush"
}
