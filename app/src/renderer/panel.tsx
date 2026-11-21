// The right panel: what is wrong with the connection, the notes list, a divider, the
// conversation. Before the site has a code folder, the folder picker takes the whole panel; before
// there is a site, the panel shows how far setup has come.
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSelector, createSignal, on, onCleanup } from "solid-js"
import { AWAY_HOURS, type NoteRow } from "../shared/types"
import { Chat } from "./chat"
import { AgentSwitch, MiddlePath, harnessNow, homePath, ownHome, whereOf } from "./agents"
import { SetupSteps, serverLabel, setSettingsAt } from "./connect"
import { AgentMark, Icon } from "./icons"
import { NoteView } from "./note-detail"
import {
  act,
  chat,
  focusedNote,
  host,
  message,
  expandNotes,
  notesForced,
  notesOpen,
  openedNote,
  setOpenedNote,
  offline,
  awayHost,
  b42,
  recall,
  remember,
  setNotesForced,
  setNotesOpen,
  setSwitcherOpen,
  state,
  tallyNotes,
  type NoteShown,
  noteShown,
} from "./store"

// ── note states as the reviewer reads them ──────────────────────────────────────────────────────

export type Shown = NoteShown
export const shownStatus = noteShown

const WORD: Record<Shown, string> = {
  capturing: "capturing",
  sending: "sending",
  queued: "waiting",
  working: "working",
  paused: "paused",
  stopped: "stopped",
  done: "done",
  failed: "failed",
}

/** The word for a note's state, as its row and its own view say it. */
export const noteWord = (note: NoteRow): string => (note.takenBack ? "taken back" : WORD[noteShown(note)])

/** Every count comes from the one tally in store.ts. */
export type Counts = ReturnType<typeof tallyNotes>
export const countNotes = tallyNotes

/** "1 failed", "2 working", … for every state that has notes, most urgent first. */
export function countWords(c: Counts): string[] {
  return (["failed", "working", "paused", "waiting", "stopped", "done"] as const).filter((k) => c[k]).map((k) => `${c[k]} ${k}`)
}

/** The same in one short phrase, for tight spots: "1 failed · 8 left", or "all done". Nothing is
 *  dropped: every unfinished note is in "left". */
export function shortWords(c: Counts): string {
  const parts = [c.failed ? `${c.failed} failed` : "", c.left ? `${c.left} left` : ""].filter(Boolean)
  return parts.length ? parts.join(" · ") : c.done ? "all done" : ""
}

// ── notes ───────────────────────────────────────────────────────────────────────────────────────

const editCount = (n: number) => (n === 1 ? "1 edit" : `${n} edits`)

/** A row's tooltip: the note's words, and for a canvas note what was changed, one edit per line. */
function noteTitle(note: NoteRow): string {
  if (!note.edits?.length) return note.text
  return [note.text, "", ...note.edits.map((e, i) => `${i + 1}. ${e}`)].join("\n")
}

/** The list is sorted by what a note needs, most urgent first. Finished ones (done, or taken
 *  back) fold into one line. */
type Group = "needs" | "working" | "waiting" | "done"
const GROUPS: Array<{ key: Group; name: string }> = [
  { key: "needs", name: "Needs you" },
  { key: "working", name: "Working" },
  { key: "waiting", name: "Waiting" },
  { key: "done", name: "Done" },
]
export const groupOf = (note: NoteRow): Group =>
  note.takenBack || note.status === "done" ? "done" : note.status === "failed" ? "needs" : note.status === "queued" ? "waiting" : "working"

/** Rows the list shows before it scrolls, unless the reviewer drags the divider. */
const ROW = 32
const LIST_DEFAULT = ROW * 8 + 6 // (five notes and the names of their groups)
const LIST_MIN = ROW + 6

function Notes(props: { listHeight: number; open: boolean; onToggle: () => void; width: number; hidden: boolean }) {
  const counts = createMemo(countNotes)
  // Every count in words when they fit beside "Notes" and "Clear done" (about 6.4px a character
  // at 12px); otherwise the short form, which drops nothing.
  const tight = () => {
    const text = countWords(counts()).join(" · ")
    const room = (props.width || 400) - 24 - 96 - (counts().done ? 84 : 0)
    return text.length * 6.4 > room
  }
  // The list's height, cut back to the last whole row that fits, so no row shows half.
  const [snap, setSnap] = createSignal<number | null>(null)
  let list: HTMLUListElement | undefined
  const measure = () => {
    if (!list) return
    let fit = 0
    let all = true
    for (const li of list.children) {
      const h = (li as HTMLElement).offsetHeight
      if (fit + h > props.listHeight - 6 && fit > 0) {
        all = false
        break
      }
      fit += h
    }
    setSnap(all ? null : fit + 6)
  }
  const LEGEND = "Round pins wait their turn in one queue; square pins (Alt+Enter) run in parallel with it."
  // Measured a frame later, once the rows have their heights.
  const observer = new ResizeObserver(() => requestAnimationFrame(measure))
  onCleanup(() => observer.disconnect())
  createEffect(
    on(
      () => [state.review.notes.length, props.listHeight, props.open, state.review.notes.filter((n) => n.status === "failed").length, doneOpen(), GROUPS.map((g) => grouped()[g.key].length).join()],
      () => requestAnimationFrame(measure),
    ),
  )
  const [why, setWhy] = createSignal(false)
  const grouped = createMemo(() => {
    const g: Record<Group, NoteRow[]> = { needs: [], working: [], waiting: [], done: [] }
    for (const note of state.review.notes) g[groupOf(note)].push(note)
    return g
  })
  const [doneOpen, setDoneOpenSignal] = createSignal(recall("notes.done") === "1")
  const setDoneOpen = (on: boolean) => {
    setDoneOpenSignal(on)
    remember("notes.done", on ? "1" : "0")
  }
  /** A row that is about to be pointed at has to be there: its group is unfolded first. */
  const unfoldFor = (id: string) => {
    const note = state.review.notes.find((n) => n.id === id)
    if (note && groupOf(note) === "done" && !doneOpen()) setDoneOpenSignal(true)
  }
  /** "Note 5" or "Notes 5 and 7", when main says which ones. */
  const lostNumbers = () => {
    const ns = state.review.notes.filter((n) => n.lost).map((n) => n.n)
    if (!ns.length) return ""
    return ns.length === 1 ? `Note ${ns[0]}` : `Notes ${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`
  }
  const rows = new Map<string, HTMLLIElement>()
  /** The row of the pin clicked last: a click touches the row it leaves and the row it lands on,
   *  not every row. */
  const focused = createSelector(() => focusedNote()?.id)

  // A pin was clicked on the page: bring its row into view and flash it.
  createEffect(
    on(focusedNote, (focus) => {
      if (!focus) return
      // With a note open as a view, the clicked pin's note takes its place; otherwise the list
      // only points at the row.
      if (openedNote()) return void setOpenedNote(focus.id)
      unfoldFor(focus.id)
      // The panel or the list may have just been opened: wait for layout.
      requestAnimationFrame(() => {
        const row = rows.get(focus.id)
        if (!row) return
        row.scrollIntoView({ block: "nearest" })
        row.classList.remove("flash")
        void row.offsetWidth
        row.classList.add("flash")
      })
    }),
  )

  // Back from a note's view: the row it was opened from is in view and has the focus again.
  createEffect(
    on(openedNote, (id, before) => {
      if (id || !before) return
      requestAnimationFrame(() => {
        const row = rows.get(before)
        row?.scrollIntoView({ block: "nearest" })
        row?.querySelector<HTMLElement>(".note-main")?.focus()
      })
    }),
  )
  // A note that has just failed may be below the list's edge: it is brought into view and
  // pointed at, as a clicked pin's row is.
  let failedBefore: Set<string> | undefined
  createEffect(() => {
    const failed = new Set(state.review.notes.filter((n) => shownStatus(n) === "failed").map((n) => n.id))
    const before = failedBefore
    failedBefore = failed
    // Not for a list that arrives with its failures already in it.
    const fresh = before && [...failed].find((id) => !before.has(id))
    if (!fresh || openedNote()) return
    requestAnimationFrame(() => {
      const row = rows.get(fresh)
      if (!row) return
      // The row just grew by the line that says why: fit the list to whole rows first.
      measure()
      row.scrollIntoView({ block: "nearest" })
      row.classList.remove("flash")
      void row.offsetWidth
      row.classList.add("flash")
    })
  })
  const lostLabel = () =>
    state.review.unplaced === 1 ? "1 pin can't find its element" : `${state.review.unplaced} pins can't find their element`

  return (
    <section class="notes" aria-label="Notes" hidden={props.hidden}>
      <header class="section-head">
        <button class="section-toggle" aria-expanded={props.open} onClick={props.onToggle}>
          <Icon name="right" class="caret" />
          {/* The total is the name: "12 notes", then what needs attention. */}
          <span class="section-name">
            {counts().total === 0 ? "Notes" : counts().total === 1 ? "1 note" : `${counts().total} notes`}
          </span>
          {/* Every count in words; where they do not fit, the short form ("1 failed · 8 left"). */}
          <span
            class="section-meta meta-full"
            classList={{ hide: tight() }}
            title={`${counts().total} notes: ${countWords(counts()).join(", ")}. ${LEGEND}`}
          >
            <For each={countWords(counts())} fallback={<span>none yet</span>}>
              {(part) => <span classList={{ bad: part.endsWith(" failed") }}>{part}</span>}
            </For>
          </span>
          <span
            class="section-meta meta-short"
            classList={{ hide: !tight() }}
            title={`${counts().total} notes: ${countWords(counts()).join(", ")}. ${LEGEND}`}
          >
            <For each={(shortWords(counts()) || "none yet").split(" · ")}>
              {(part) => <span classList={{ bad: part.endsWith(" failed") }}>{part}</span>}
            </For>
          </span>
        </button>
        <Show when={state.review.unplaced > 0}>
          <button class="lost-btn" aria-expanded={why()} title={lostLabel()} aria-label={lostLabel()} onClick={() => setWhy(!why())}>
            <Icon name="alert" />
            {state.review.unplaced}
          </button>
        </Show>
        <Show when={counts().done}>
          <button class="text-btn" title="Take the notes that are done off the list" onClick={() => act("clearNotes")}>
            Clear done
          </button>
        </Show>
      </header>
      <Show when={state.review.unplaced > 0 && why()}>
        <div class="notes-lost-more">
          <p>
            <strong>{lostLabel()}. </strong>
            <Show when={lostNumbers()}>{(which) => <>{which()}. </>}</Show>
            The page changed under {state.review.unplaced === 1 ? "that pin" : "those pins"}: the element moved or is
            gone. The notes still go to the agent. Reloading places the pins again once the element is back.
          </p>
          <button class="btn" onClick={() => act("reload")}>
            Reload page
          </button>
        </div>
      </Show>
      <Show when={props.open}>
        <Show when={state.review.notes.length}>
          <ul
            class="notes-list"
            ref={(el) => {
              list = el
              observer.observe(el)
            }}
            style={{ "--list-h": `${snap() ?? props.listHeight}px` }}
            onScroll={measure}
          >
            <For each={GROUPS}>
              {(g) => (
                <Show when={grouped()[g.key].length}>
                  <li class="note-group" data-group={g.key}>
                    <Show
                      when={g.key === "done"}
                      fallback={
                        <span class="note-group-name">
                          {g.name} · {grouped()[g.key].length}
                        </span>
                      }
                    >
                      <button class="note-group-name" aria-expanded={doneOpen()} onClick={() => setDoneOpen(!doneOpen())}>
                        <Icon name="right" class="caret" />
                        {g.name} · {grouped()[g.key].length}
                      </button>
                    </Show>
                  </li>
                  <Show when={g.key !== "done" || doneOpen()}>
                    <For each={grouped()[g.key]}>
                      {(note) => {
                const shown = () => shownStatus(note)
                onCleanup(() => rows.delete(note.id))
                return (
                  <li
                    class="note"
                    data-group={g.key}
                    ref={(el) => rows.set(note.id, el)}
                    aria-current={focused(note.id) ? "true" : undefined}
                  >
                    <div class="note-line">
                      <button
                        class="note-main"
                        title={noteTitle(note)}
                        onClick={() => {
                          act("showNote", note.id)
                          setOpenedNote(note.id)
                        }}
                      >
                        <span
                          class="badge"
                          data-status={note.takenBack ? "stopped" : shown()}
                          data-lane={note.lane}
                          title={note.lane === "bg" ? "Runs in parallel with the main queue" : undefined}
                        >
                          {note.n}
                        </span>
                        <span class="note-text">{note.text}</span>
                        <Show when={note.motion}>
                          <span class="note-lost" title="Motion note: one animation, changed on the page">
                            <Icon name="motion" />
                          </span>
                        </Show>
                        <Show when={!note.motion && note.edits}>
                          {(edits) => (
                            <span class="note-lost" title={`Canvas note: ${editCount(edits().length)} made on the page`}>
                              <Icon name="mode" />
                            </span>
                          )}
                        </Show>
                        <Show when={note.lost}>
                          <span class="note-lost" title="Its pin can't find its element on the page">
                            <Icon name="alert" />
                          </span>
                        </Show>
                        {/* The group says waiting, working and done; a word is kept for what says more. */}
                        <Show when={note.takenBack || !["queued", "working", "done"].includes(shown())}>
                          <span class="note-status" data-status={shown()}>
                            {noteWord(note)}
                          </span>
                        </Show>
                        {/* The agent's computer out of reach: what the note waits on. */}
                        <Show when={!note.takenBack && (shown() === "queued" || shown() === "working") && awayHost()}>
                          {(where) => (
                            <span
                              class="note-status"
                              data-status={shown()}
                              title={shown() === "queued" ? `Goes to the agent once ${where()} can be reached again` : `The agent works on it on ${where()}; what it says shows once ${where()} can be reached again`}
                            >
                              {shown() === "queued" ? `waits for ${where()}` : `on ${where()}`}
                            </span>
                          )}
                        </Show>
                      </button>
                      {/* A failed note's two ways out sit in its own row, not behind a hover. */}
                      <Show when={note.status === "failed"}>
                        <button class="text-btn" onClick={() => act("retryNote", note.id)}>
                          Retry
                        </button>
                        <button
                          class="icon-btn small"
                          aria-label={`Remove note ${note.n}`}
                          title="Remove note"
                          onClick={() => act("removeNote", note.id)}
                        >
                          <Icon name="close" />
                        </button>
                      </Show>
                    </div>
                    <Show when={note.status === "failed"}>
                      <p class="note-error" classList={{ quiet: shown() === "stopped" }} title={note.error}>
                        {note.error || (shown() === "stopped" ? "Stopped before it finished." : "Could not be sent.")}
                      </p>
                    </Show>
                  </li>
                )
              }}
            </For>
                  </Show>
                </Show>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  )
}

/** The line between notes and conversation. Drag it, or focus it and use the arrow keys. */
function Divider(props: { height: number; max: () => number; set: (h: number, save: boolean) => void }) {
  let from: { y: number; h: number } | undefined
  const [active, setActive] = createSignal(false)
  return (
    <div
      class="divider"
      classList={{ active: active() }}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the notes list"
      aria-valuemin={LIST_MIN}
      aria-valuemax={props.max()}
      aria-valuenow={props.height}
      tabindex="0"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        from = { y: e.clientY, h: props.height }
        setActive(true)
      }}
      onPointerMove={(e) => from && props.set(from.h + e.clientY - from.y, false)}
      onPointerUp={() => {
        if (!from) return
        from = undefined
        setActive(false)
        props.set(props.height, true)
      }}
      onLostPointerCapture={() => {
        from = undefined
        setActive(false)
      }}
      onDblClick={() => props.set(LIST_DEFAULT, true)}
      onKeyDown={(e) => {
        const by = { ArrowUp: -ROW, ArrowDown: ROW } as Record<string, number>
        if (e.key in by) props.set(props.height + by[e.key]!, true)
        else if (e.key === "Home") props.set(LIST_MIN, true)
        else if (e.key === "End") props.set(props.max(), true)
        else return
        e.preventDefault()
      }}
    />
  )
}

// ── folder picker ───────────────────────────────────────────────────────────────────────────────

const parent = (path: string) => path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/"

/** "acme/storefront" from "/home/dev/code/acme/storefront": the part a person recognises. */
const tail = (path: string) => path.replace(/\/+$/, "").split("/").slice(-2).join("/") || "/"

/** The second first-run step: the repo, before any site. Also when a page is open and the app
 *  knows no folder for it. */
export function RepoScreen() {
  return (
    <div class="connect-screen">
      <div class="connect-card repo-card">
        <FolderPicker />
      </div>
    </div>
  )
}

/** `open` is what choosing a folder does; without it, the folder becomes the one the site on
 *  screen works in (`setDirectory`). With `onCancel` it is not a first-run step: no step line. */
export function FolderPicker(props: { onCancel?: () => void; onDone?: () => void; open?: (directory: string) => Promise<unknown>; browse?: boolean }) {
  const h = () => harnessNow()
  const here = () => !!h()?.here
  /** Where the agent works, in words: "this computer", the other computer it runs on, or the server. */
  const on = () => (here() ? "on this computer" : h()?.host && h()?.kind !== "opencode-server" ? `on ${h()!.host}` : `on ${h()?.name ?? "your server"}`)
  /** The agent's own folders first; on this computer, then those another agent or server here
   *  worked in, which are this computer's folders too. */
  const [recent, { refetch: reloadRecent }] = createResource(async () => {
    const own = await b42.invoke("projects")
    if (!here()) return own
    const more = await b42.invoke("allProjects").catch(() => [])
    return [...new Set([...own, ...more.filter((p) => p.here && p.server).map((p) => p.directory)])]
  })
  // Reading a failed resource throws; the error has its own branch below.
  const recentList = () => (recent.error ? undefined : recent())
  /** Where browsing starts with no project to start beside: the home folder, on this computer. */
  const start = () => (ownHome(h()) && state.home ? state.home : "/")
  // Browsing starts beside the most recent project: that is where the next one usually is.
  const [path, setPath] = createSignal<string | null>(props.browse ? parent(state.site?.directory ?? start()) : null)
  const [folders, { refetch: reloadFolders }] = createResource(path, (p) => b42.invoke("listFolders", p))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const use = (directory: string) => {
    setBusy(true)
    setError("")
    // On success main sets site.directory and the panel moves on to notes and chat.
    ;(props.open ? props.open(directory) : b42.invoke("setDirectory", directory))
      .then(() => props.onDone?.())
      .catch((err) => {
        setError(message(err))
        setBusy(false)
      })
  }
  const crumbs = () => {
    const parts = (path() ?? "").split("/").filter(Boolean)
    return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: "/" + parts.slice(0, i + 1).join("/") }))]
  }

  return (
    <section class="folder" aria-label="Open the repo">
      <div class="folder-head">
        <Show when={!props.onCancel}>
          <SetupSteps at={2} />
        </Show>
        <h2 class="folder-title">
          <Show when={h()} fallback={props.open ? "Open a project" : "Open the repo"}>
            {(a) => (
              <>
                <AgentMark kind={a().kind} size={20} />
                <span>
                  Where should {a().name} work{a().host && a().kind !== "opencode-server" ? ` on ${a().host}` : ""}?
                </span>
              </>
            )}
          </Show>
        </h2>
        <p class="folder-lead">
          <Show when={!props.open && state.missingFolder}>
            <span class="folder-missing">
              <code>{state.missingFolder}</code> is not a folder {here() ? "on this computer" : h()?.host && h()?.kind !== "opencode-server" ? on() : "on this server"}: it was moved, or it is another computer's.{" "}
            </span>
          </Show>
          <Show
            when={!props.open && state.site?.origin}
            fallback={<>Pick the folder {on()} that holds the site's code.</>}
          >
            Pick the folder {on()} that holds the code of <strong>{host(state.site?.origin ?? "")}</strong>.
          </Show>
        </p>
      </div>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
      <Show
        when={path() !== null}
        fallback={
          <>
            <h3 class="label">Recent</h3>
            <Switch>
              <Match when={recent.loading}>
                <p class="quiet">
                  <Icon name="spinner" /> Looking for folders
                </p>
              </Match>
              <Match when={recent.error}>
                <p class="form-error">{message(recent.error)}</p>
                <button class="btn" onClick={() => reloadRecent()}>
                  Try again
                </button>
              </Match>
              <Match when={!recentList()?.length}>
                <p class="quiet">{h()?.name ?? "The server"} has not worked in any folder yet.</p>
              </Match>
              <Match when={true}>
                <ul class="rows">
                  <For each={recentList()}>
                    {(dir) => (
                      <li>
                        <button class="row" disabled={busy()} title={dir} onClick={() => use(dir)}>
                          <Icon name="folder" />
                          <span class="row-main">{tail(dir)}</span>
                          {/* Long paths lose their start, not the folder's own name. */}
                          <span class="row-sub" title={dir}>
                            <bdi>{homePath(dir, ownHome(h()))}</bdi>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Match>
            </Switch>
            <div class="folder-actions">
              <button class="btn" onClick={() => setPath(recentList()?.[0] ? parent(recentList()![0]!) : start())}>
                Browse folders
              </button>
              <Show when={props.onCancel}>
                <button class="btn" onClick={() => props.onCancel?.()}>
                  Cancel
                </button>
              </Show>
            </div>
          </>
        }
      >
        <nav class="crumbs" aria-label="Folder path">
          <For each={crumbs()}>
            {(c, i) => (
              <button class="crumb" aria-current={i() === crumbs().length - 1 ? "location" : undefined} onClick={() => setPath(c.path)}>
                {c.name}
              </button>
            )}
          </For>
        </nav>
        <Switch>
          <Match when={folders.loading}>
            <p class="quiet">
              <Icon name="spinner" /> Reading folder
            </p>
          </Match>
          <Match when={folders.error}>
            <p class="form-error">{message(folders.error)}</p>
            <button class="btn" onClick={() => reloadFolders()}>
              Try again
            </button>
          </Match>
          <Match when={!folders()?.length}>
            <p class="quiet">No folders inside this one.</p>
          </Match>
          <Match when={true}>
            <ul class="rows browse">
              <For each={folders()}>
                {(entry) => (
                  <li>
                    <button class="row" onClick={() => setPath(entry.path)}>
                      <Icon name="folder" />
                      <span class="row-main">{entry.name}</span>
                      <Icon name="right" class="row-go" />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Match>
        </Switch>
        <div class="folder-actions">
          <button class="btn primary" disabled={busy()} onClick={() => use(path()!)}>
            Use this folder
          </button>
          <button class="btn" onClick={() => (props.browse ? props.onCancel?.() : setPath(null))}>
            {props.browse ? "Back" : "Back to recent"}
          </button>
        </div>
      </Show>
    </section>
  )
}

// ── setup progress ──────────────────────────────────────────────────────────────────────────────

/** Before there is a site the page area leads (with the setup steps); the panel only says what
 *  will be here. */
function Setup() {
  return (
    <div class="panel-empty panel-waiting">
      <p>Your notes and the conversation with the agent will sit here, next to the page.</p>
    </div>
  )
}

// ── banners: the connection, a conversation that will not open ──────────────────────────────────

function ConnectionBanner(props: { openSettings: () => void }) {
  return (
    <Switch>
      <Match when={state.connection.status === "offline" && state.connection}>
        {(c) => (
          <div class="banner bad" role="alert">
            <Icon name="alert" />
            <div class="banner-body">
              <p>
                <Show when={c().away && harnessNow()} fallback={<>Can't reach {serverLabel(c().url)}. {c().error} Notes wait until it is back.</>}>
                  {(a) => (
                    <>
                      {c().error} {a().name} keeps working on {a().host ?? "it"} for up to {AWAY_HOURS} hours, and the app connects again by itself. Notes wait until it is back.
                    </>
                  )}
                </Show>
              </p>
              <div class="banner-actions">
                {/* The window never holds the password: main tries again with the one it saved. */}
                <button class="btn" onClick={() => act("reconnect")}>
                  Retry
                </button>
                <button class="text-btn" onClick={props.openSettings}>
                  Change agent
                </button>
              </div>
            </div>
          </div>
        )}
      </Match>
      <Match when={state.connection.status === "connecting" && state.connection}>
        {(c) => (
          <div class="banner" role="status">
            <Icon name="spinner" />
            <div class="banner-body">
              <p>Connecting to {serverLabel(c().url)}</p>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  )
}

/** Main could not open a conversation and said why. The reason and the way out sit together:
 *  the error, then the two buttons that fix it. (The chat repeats main's marker in its transcript
 *  until it learns to leave it to this banner.) */
function NoConversation(props: { chooseFolder: () => void }) {
  const reason = () => {
    const errors = chat.items.filter((i) => i.kind === "marker" && i.tone === "error")
    const last = errors[errors.length - 1]
    return last?.kind === "marker" ? last.text : "No conversation could be opened."
  }
  const folderGone = () => /folder|directory/i.test(reason())
  return (
    <div class="banner bad" role="alert">
      <Icon name="alert" />
      <div class="banner-body">
        <p>{reason()}</p>
        <div class="banner-actions">
          <button class="btn" classList={{ primary: folderGone() }} onClick={props.chooseFolder}>
            {folderGone() ? "Find the code folder" : "Choose another folder"}
          </button>
          <button class="btn" classList={{ primary: !folderGone() }} onClick={() => act("newSession")}>
            New conversation
          </button>
        </div>
      </div>
    </div>
  )
}

/** Where the notes and the conversations are: the agent (its mark, its name, the connection's
 *  dot) and the repo's path. The agent opens the list that switches to another; the path, the
 *  list of projects; the sliders, the settings. The notes list under it is this agent's, for
 *  the site on screen; a conversation is one of many there. */
function Place(props: { openSettings: () => void }) {
  const [switching, setSwitching] = createSignal(false)
  let agentButton: HTMLButtonElement | undefined
  const h = () => harnessNow()
  const status = () => state.connection.status
  const word = () => (status() === "offline" ? "Offline" : status() === "connecting" ? "Connecting" : "")
  const tip = () => {
    const c = state.connection
    const what = h() ? `${h()!.name} on ${whereOf(h()!)}` : ""
    const how = c.status === "online" ? (c.url.startsWith("acp://") ? `over ACP · ${c.version}` : `OpenCode ${c.version}`) : c.status === "offline" ? `can't be reached. ${c.error}` : c.status === "connecting" ? "connecting" : ""
    return `${what}${how ? `, ${how}` : ""}. Click to switch agent`
  }
  return (
    <div class="place" data-fit>
      <button
        class="place-agent"
        ref={agentButton}
        data-action="agents"
        data-kind={h()?.kind}
        aria-haspopup="menu"
        aria-expanded={switching()}
        aria-label={`Agent: ${h()?.name ?? "none"}${word() ? `, ${word().toLowerCase()}` : ""}. Switch agent`}
        title={tip()}
        onClick={() => setSwitching(!switching())}
      >
        <span class="place-mark">
          <AgentMark kind={h()?.kind} />
          <span class="dot" data-status={status()} />
        </span>
        <span class="place-agent-name">{h()?.name}</span>
        {/* An agent the app runs on another computer: which one. */}
        <Show when={h()?.host && h()?.kind !== "opencode-server" && h()?.host}>{(where) => <span class="place-host">{where()}</span>}</Show>
        <Show when={word()}>
          <span class="place-word" data-status={status()}>
            {word()}
          </span>
        </Show>
        <Icon name="down" />
      </button>
      {/* The project is changed where it is named: the list behind the conversation's "+". */}
      <Show when={state.site?.directory}>
        {(dir) => (
          <button
            class="place-folder"
            title={`${dir()}. Click for another project`}
            aria-haspopup="dialog"
            aria-label={`Project: ${dir()}. Another project`}
            data-action="projects"
            disabled={state.connection.status !== "online"}
            onClick={() => setSwitcherOpen("projects")}
          >
            <MiddlePath class="place-folder-name" path={homePath(dir(), ownHome(h()))} />
            <Icon name="down" />
          </button>
        )}
      </Show>
      <button class="icon-btn small place-settings" data-action="settings" data-status={status()} aria-label="Settings" title="Settings" onClick={props.openSettings}>
        <Icon name="mode" />
      </button>
      <Show when={switching()}>
        <AgentSwitch
          anchor={() => agentButton}
          onClose={() => setSwitching(false)}
          onConnect={() => {
            setSwitching(false)
            setSettingsAt("connect")
            props.openSettings()
          }}
        />
      </Show>
    </div>
  )
}

// ── panel ───────────────────────────────────────────────────────────────────────────────────────

export function Panel(props: {
  composerRef: (el: HTMLTextAreaElement) => void
  openSettings: () => void
  /** The panel's own size, for deciding whether the notes list fits beside the conversation. */
  size: { width: number; height: number }
}) {
  const [listHeight, setListHeight] = createSignal(Number(recall("notes.height")) || LIST_DEFAULT)
  // The conversation keeps at least 160px of messages, under its header and above the message box;
  // the notes header takes its line too. What is left can go to the list.
  // (server row, notes header, conversation header, message box at its one empty line, the 160)
  const room = () => props.size.height - 32 - 36 - 36 - 100 - 160
  const maxList = () => Math.max(LIST_MIN, room())
  // A narrow or short panel folds the list to its one-line summary, unless the reviewer opens it.
  const cramped = () => props.size.width > 0 && (props.size.width < 360 || room() < ROW * 3 + 6)
  const listOpen = () => notesOpen() && (!cramped() || notesForced())
  const toggleList = () => {
    if (listOpen()) {
      setNotesOpen(false)
      setNotesForced(false)
    } else expandNotes()
  }
  const setList = (h: number, save: boolean) => {
    setListHeight(Math.min(maxList(), Math.max(LIST_MIN, Math.round(h))))
    if (save) remember("notes.height", String(listHeight()))
  }
  const [picking, setPicking] = createSignal(false)
  // The note open as a view of its own. It closes when its note is gone: removed, cleared, or
  // the site changed.
  const opened = createMemo(() => state.review.notes.find((n) => n.id === openedNote()))
  createEffect(() => {
    if (openedNote() && !opened()) setOpenedNote("")
  })
  const noConversation = () => !state.session && chat.items.length > 0 && state.connection.status === "online"

  return (
    <>
      <ConnectionBanner openSettings={props.openSettings} />
      <Switch>
        <Match when={!state.site}>
          <Setup />
        </Match>
        <Match when={!state.site!.directory}>
          <Show
            when={state.connection.status === "online"}
            fallback={
              <div class="panel-empty">
                <SetupSteps at={2} />
                <p class="chat-empty-lead">Open the repo.</p>
                <p>You can pick the folder as soon as the server is reachable again.</p>
              </div>
            }
          >
            <FolderPicker />
          </Show>
        </Match>
        <Match when={picking()}>
          <FolderPicker onCancel={() => setPicking(false)} onDone={() => setPicking(false)} />
        </Match>
        <Match when={true}>
          <Place openSettings={props.openSettings} />
          <Notes
            listHeight={Math.min(listHeight(), maxList())}
            open={listOpen()}
            onToggle={toggleList}
            width={props.size.width}
            hidden={!!opened()}
          />
          <Show when={listOpen() && state.review.notes.length && !opened()}>
            <Divider height={listHeight()} max={maxList} set={setList} />
          </Show>
          <Show when={noConversation()}>
            <NoConversation chooseFolder={() => setPicking(true)} />
          </Show>
          <Chat composerRef={props.composerRef} openSettings={props.openSettings} covered={!!opened()}>
            <Show when={opened()}>{(note) => <NoteView note={note()} />}</Show>
          </Chat>
        </Match>
      </Switch>
    </>
  )
}
