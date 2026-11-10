// The right panel: what is wrong with the connection, the notes list, a divider, the
// conversation. Before the site has a code folder, the folder picker takes the whole panel; before
// there is a site, the panel shows how far setup has come.
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js"
import type { NoteRow } from "../shared/types"
import { Chat } from "./chat"
import { SetupSteps } from "./connect"
import { Icon } from "./icons"
import {
  act,
  chat,
  focusedNote,
  host,
  message,
  expandNotes,
  notesForced,
  notesOpen,
  offline,
  b42,
  recall,
  remember,
  setNotesForced,
  setNotesOpen,
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

/** Rows the list shows before it scrolls, unless the reviewer drags the divider. */
const ROW = 32
const LIST_DEFAULT = ROW * 5 + 6
const LIST_MIN = ROW + 6

function Notes(props: { listHeight: number; open: boolean; onToggle: () => void; width: number }) {
  const counts = createMemo(countNotes)
  // Every count in words when they fit beside "Notes" and "Clear done" (about 6.4px a character
  // at 12px); otherwise the short form, which drops nothing.
  const tight = () => {
    const text = countWords(counts()).join(" · ")
    const room = (props.width || 400) - 24 - 96 - (counts().done ? 84 : 0)
    return text.length * 6.4 > room
  }
  // How many rows sit below the list's visible edge, so it is plain that the list goes on.
  const [below, setBelow] = createSignal(0)
  // The list's height, cut back to the last whole row that fits, so no row shows half.
  const [snap, setSnap] = createSignal<number | null>(null)
  let list: HTMLUListElement | undefined
  const measure = () => {
    if (!list) return setBelow(0)
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
    const edge = list.scrollTop + list.clientHeight - 6
    let n = 0
    for (const li of list.children) if ((li as HTMLElement).offsetTop + (li as HTMLElement).offsetHeight > edge + 1) n++
    setBelow(n)
  }
  const parallel = () => state.review.notes.some((n) => n.lane === "bg")
  const LEGEND = "Round pins wait their turn in one queue; square pins (Alt+Enter) run in parallel with it."
  // Measured a frame later: the "more below" line it may add changes the size it observes.
  const observer = new ResizeObserver(() => requestAnimationFrame(measure))
  onCleanup(() => observer.disconnect())
  createEffect(
    on(
      () => [state.review.notes.length, props.listHeight, props.open, state.review.notes.filter((n) => n.status === "failed").length],
      () => requestAnimationFrame(measure),
    ),
  )
  const [why, setWhy] = createSignal(false)
  /** "Note 5" or "Notes 5 and 7", when main says which ones. */
  const lostNumbers = () => {
    const ns = state.review.notes.filter((n) => n.lost).map((n) => n.n)
    if (!ns.length) return ""
    return ns.length === 1 ? `Note ${ns[0]}` : `Notes ${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`
  }
  const rows = new Map<string, HTMLLIElement>()

  // A pin was clicked on the page: bring its row into view and flash it.
  createEffect(
    on(focusedNote, (focus) => {
      if (!focus) return
      // The panel or the list may have just been opened: wait for layout.
      requestAnimationFrame(() => {
        const row = rows.get(focus.id)
        if (!row) return
        // A canvas note's row just grew by its list of edits: fit the list to whole rows first.
        measure()
        row.scrollIntoView({ block: "nearest" })
        row.classList.remove("flash")
        void row.offsetWidth
        row.classList.add("flash")
      })
    }),
  )

  return (
    <section class="notes" aria-label="Notes">
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
              {(part) => <span>{part}</span>}
            </For>
          </span>
          <span
            class="section-meta meta-short"
            classList={{ hide: !tight() }}
            title={`${counts().total} notes: ${countWords(counts()).join(", ")}. ${LEGEND}`}
          >
            {shortWords(counts()) || "none yet"}
          </span>
        </button>
        <Show when={counts().done}>
          <button class="text-btn" title="Take finished notes off the list" onClick={() => act("clearNotes")}>
            Clear done
          </button>
        </Show>
      </header>
      <Show when={props.open}>
        <Show when={state.review.unplaced > 0}>
          <div class="notes-lost">
            <Icon name="alert" />
            <span class="notes-lost-text">
              {state.review.unplaced === 1
                ? "1 pin can't find its element"
                : `${state.review.unplaced} pins can't find their element`}
            </span>
            <button class="text-btn" aria-expanded={why()} onClick={() => setWhy(!why())}>
              {why() ? "Hide" : "Show"}
            </button>
          </div>
          <Show when={why()}>
            <div class="notes-lost-more">
              <p>
                <Show when={lostNumbers()}>{(which) => <strong>{which()}. </strong>}</Show>
                The page changed under {state.review.unplaced === 1 ? "that pin" : "those pins"}: the element moved or
                is gone. The notes still go to the agent. Reloading places the pins again once the element is back.
              </p>
              <button class="btn" onClick={() => act("reload")}>
                Reload page
              </button>
            </div>
          </Show>
        </Show>
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
            <For each={state.review.notes}>
              {(note) => {
                const shown = () => shownStatus(note)
                onCleanup(() => rows.delete(note.id))
                return (
                  <li
                    class="note"
                    ref={(el) => rows.set(note.id, el)}
                    aria-current={focusedNote()?.id === note.id ? "true" : undefined}
                  >
                    <div class="note-line">
                      <button class="note-main" title={noteTitle(note)} onClick={() => act("showNote", note.id)}>
                        <span
                          class="badge"
                          data-status={shown()}
                          data-lane={note.lane}
                          title={note.lane === "bg" ? "Runs in parallel with the main queue" : undefined}
                        >
                          {note.n}
                        </span>
                        <span class="note-text">{note.text}</span>
                        <Show when={note.edits}>
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
                        <span class="note-status" data-status={shown()}>
                          {WORD[shown()]}
                        </span>
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
                    {/* A canvas note's edits, in words, under the row that is being looked at. */}
                    <Show when={focusedNote()?.id === note.id && note.edits}>
                      {(edits) => (
                        <ol class="note-edits">
                          <For each={edits()}>{(edit) => <li title={edit}>{edit}</li>}</For>
                        </ol>
                      )}
                    </Show>
                    <Show when={note.status === "failed"}>
                      <p class="note-error" classList={{ quiet: shown() === "stopped" }} title={note.error}>
                        {note.error || (shown() === "stopped" ? "Stopped before it finished." : "Could not be sent.")}
                      </p>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
          {/* Outside the scrolling list: how much more there is, and what a square pin means. */}
          <Show when={below() > 0 || parallel()}>
            <div class="notes-foot">
              <Show when={below() > 0}>
                <button
                  class="notes-more"
                  onClick={() => list?.scrollBy({ top: list.clientHeight - ROW, behavior: "smooth" })}
                >
                  <Icon name="down" />
                  {below()} more below
                </button>
              </Show>
              <Show when={parallel()}>
                <span class="notes-legend" title={LEGEND}>
                  {/* A sample of the badge itself, so it reads as a key, not a checkbox. */}
                  <span class="badge legend-badge" data-lane="bg" data-status="queued" aria-hidden="true">
                    1
                  </span>
                  square: runs in parallel
                </span>
              </Show>
            </div>
          </Show>
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

function FolderPicker(props: { onCancel?: () => void; onDone?: () => void }) {
  const [recent, { refetch: reloadRecent }] = createResource(() => b42.invoke("projects"))
  // Reading a failed resource throws; the error has its own branch below.
  const recentList = () => (recent.error ? undefined : recent())
  // Browsing starts beside the most recent project: that is where the next one usually is.
  const [path, setPath] = createSignal<string | null>(null)
  const [folders, { refetch: reloadFolders }] = createResource(path, (p) => b42.invoke("listFolders", p))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const use = (directory: string) => {
    setBusy(true)
    setError("")
    // On success main sets site.directory and the panel moves on to notes and chat.
    b42
      .invoke("setDirectory", directory)
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
    <section class="folder" aria-label="Choose the site's code folder">
      <div class="folder-head">
        <Show when={!props.onCancel}>
          <SetupSteps at={4} />
        </Show>
        <h2>Where is this site's code?</h2>
        <p class="folder-lead">
          Pick the folder on your server that holds <strong>{host(state.site?.origin ?? "")}</strong>. You only do this
          once per site.
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
                <p class="quiet">The server has not worked in any folder yet.</p>
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
                            <bdi>{dir}</bdi>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Match>
            </Switch>
            <div class="folder-actions">
              <button class="btn" onClick={() => setPath(parent(recentList()?.[0] ?? "/"))}>
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
          <button class="btn" onClick={() => setPath(null)}>
            Back to recent
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
                Can't reach {host(c().url)}. {c().error} Notes wait until it is back.
              </p>
              <div class="banner-actions">
                {/* The window never holds the password: main tries again with the one it saved. */}
                <button class="btn" onClick={() => act("reconnect")}>
                  Retry
                </button>
                <button class="text-btn" onClick={props.openSettings}>
                  Change server
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
              <p>Connecting to {host(c().url)}</p>
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
  // (notes header, conversation header, message box, the 160, the "more below" line, the lost-pins line)
  const room = () => props.size.height - 36 - 36 - 140 - 160 - 28 - (state.review.unplaced ? 28 : 0)
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
                <SetupSteps at={4} />
                <p class="chat-empty-lead">Choose where this site's code lives.</p>
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
          <Notes
            listHeight={Math.min(listHeight(), maxList())}
            open={listOpen()}
            onToggle={toggleList}
            width={props.size.width}
          />
          <Show when={listOpen() && state.review.notes.length}>
            <Divider height={listHeight()} max={maxList} set={setList} />
          </Show>
          <Show when={noConversation()}>
            <NoConversation chooseFolder={() => setPicking(true)} />
          </Show>
          <Chat composerRef={props.composerRef} />
        </Match>
      </Switch>
    </>
  )
}
