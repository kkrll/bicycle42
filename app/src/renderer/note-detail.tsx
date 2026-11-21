// A note, open as a view of its own in the panel, over the list and the conversation: what it
// says, its area before and after the agent's work, what the agent changed in the code for it,
// and what the reviewer does about a result that is not right (say more about it, take it back);
// one that is right needs nothing done. The
// requests and the message box stay under it.
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import type { FileChange, NoteRow, TakeBackWay } from "../shared/types"
import { Changes, Counts } from "./chat"
import { Icon } from "./icons"
import { openLightbox } from "./lightbox"
import { noteWord } from "./panel"
import { act, b42, message, noteShown, setFollowUp, setOpenedNote, state } from "./store"

const clip = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function NoteView(props: { note: NoteRow }) {
  const n = () => props.note
  const at = () => state.review.notes.findIndex((x) => x.id === n().id)
  const go = (by: number) => {
    const next = state.review.notes[at() + by]
    if (!next) return
    setOpenedNote(next.id)
    act("showNote", next.id)
  }
  let back!: HTMLButtonElement
  let view!: HTMLDivElement
  // Esc goes back from anywhere in the window, not only with the focus in the view. What is
  // open over the panel takes the key first (a picture, a menu, the commit form), a request
  // from the agent keeps its own keys, and a take-back question is put away before the view is.
  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest(".asks") || document.querySelector("dialog[open], .repo-pop, .meter-pop, .convo > .menu, .suggest")) return
    e.preventDefault()
    const keep = view.querySelector<HTMLButtonElement>("[data-keep]")
    if (keep) keep.click()
    else setOpenedNote("")
  }
  onMount(() => {
    back.focus()
    window.addEventListener("keydown", onEsc)
  })
  onCleanup(() => window.removeEventListener("keydown", onEsc))

  return (
    <div class="note-view" ref={view}>
      <header class="note-view-head">
        <button class="note-back" ref={back} title="Back to the notes and the conversation (Esc)" onClick={() => setOpenedNote("")}>
          <Icon name="back" />
          Notes
        </button>
        <span class="note-at">
          {at() + 1} of {state.review.notes.length}
        </span>
        <button class="icon-btn small" title="The note before" aria-label="The note before" disabled={at() <= 0} onClick={() => go(-1)}>
          <Icon name="up" />
        </button>
        <button
          class="icon-btn small"
          title="The next note"
          aria-label="The next note"
          disabled={at() >= state.review.notes.length - 1}
          onClick={() => go(1)}
        >
          <Icon name="down" />
        </button>
      </header>
      {/* A note's own state (an open diff, a question half answered) does not pass to the next. */}
      <Show when={n()} keyed>
        {(note) => <NoteDetail note={note} />}
      </Show>
    </div>
  )
}

function NoteDetail(props: { note: NoteRow }) {
  const n = () => props.note
  const shown = () => noteShown(n())
  // Asked again when the second picture arrives.
  const [shots] = createResource(
    () => (n().pictures ? `${n().id}:${n().pictures}` : undefined),
    () => b42.invoke("notePictures", n().id),
  )
  /** null: main kept no record of what the note changed, which is not "no file changed". */
  const [diff, setDiff] = createSignal<FileChange[] | null | undefined>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  /** "Take back" was pressed once, and main said which way it would go: the second press does
   *  that. */
  const [sure, setSure] = createSignal<TakeBackWay | false>(false)
  /** The files the app would put back ("restored"), as main's dry run said. */
  const [files, setFiles] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)

  // One array for as long as the pictures are the same: <For> keeps each <img> (and the picture
  // it has decoded) instead of making both anew whenever the list is read.
  const pictures = createMemo(() => {
    const s = shots()
    return [
      ...(s?.before ? [{ name: `Note ${n().n}: before`, src: s.before }] : []),
      ...(s?.after ? [{ name: `Note ${n().n}: after`, src: s.after }] : []),
    ]
  })
  const loadDiff = () => {
    setLoading(true)
    setError("")
    b42
      .invoke("noteDiff", n().id)
      .then(setDiff, (err) => setError(message(err)))
      .finally(() => setLoading(false))
  }
  const toggleDiff = () => (diff() !== undefined ? setDiff(undefined) : loadDiff())
  // An open diff read while the agent was working is read again when it finishes.
  createEffect(
    on(
      () => n().status,
      () => {
        setSure(false)
        if (diff() !== undefined) loadDiff()
      },
      { defer: true },
    ),
  )
  const totals = () => (diff() ?? []).reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { additions: 0, deletions: 0 })
  const askTakeBack = () => {
    setBusy(true)
    setError("")
    b42
      .invoke("takeBackPlan", n().id)
      .then(
        (plan) => (setFiles(plan.files ?? []), setSure(plan.how)),
        (err) => setError(message(err)),
      )
      .finally(() => setBusy(false))
  }
  const takeBack = () => {
    const way = sure()
    if (!way) return
    setBusy(true)
    setError("")
    b42
      .invoke("takeBackNote", n().id, way)
      .catch((err) => setError(message(err)))
      .finally(() => (setBusy(false), setSure(false)))
  }
  /** The files a take-back from the app's history puts back, a few by name, and what else goes
   *  with them: the turn's diff is the folder's, whoever made it. */
  const filesSaid = () => {
    const all = files()
    if (!all.length) return ""
    const named = all.length > 3 ? `${all.slice(0, 3).join(", ")} and ${all.length - 3} more` : all.join(", ")
    return ` It changes ${named}; what anyone changed in ${all.length === 1 ? "it" : "them"} during that turn goes back too.`
  }
  // A note stays with the conversation it was sent in. When that is not the open one, the view
  // names it, since Follow up and Take back act there.
  const elsewhere = () => (n().session && n().session !== state.session?.id ? n().session : undefined)
  const where = () => {
    if (!elsewhere()) return ""
    const title = state.sessions.find((s) => s.id === elsewhere())?.title
    return title ? `In ${title}` : n().lane === "bg" ? "In the background conversation" : "In another conversation"
  }
  // The background conversation is not one to talk in: a follow-up on its note is said here.
  const elsewhereToOpen = () => (n().lane === "bg" ? undefined : elsewhere())
  const follow = () => {
    const draft = () => {
      setFollowUp({ text: `About note ${n().n} (“${clip(n().text)}”): `, at: Date.now() })
      setOpenedNote("")
    }
    const target = elsewhereToOpen()
    if (!target) return draft()
    setBusy(true)
    setError("")
    b42
      .invoke("openSession", target)
      .then(draft, (err) => setError(message(err)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <div class="note-body">
        <p class="note-said">
          <span class="badge" data-status={n().takenBack ? "stopped" : shown()} data-lane={n().lane}>
            {n().n}
          </span>
          <span class="note-status" data-status={shown()}>
            {noteWord(n())}
          </span>
          <Show when={where()}>
            <span class="note-where" title={n().lane === "bg" ? `${where()}: Take back acts there; Follow up is said in the open conversation.` : `${where()}: Follow up and Take back act there.`}>
              {where()}
            </span>
          </Show>
        </p>
        <p class="note-words">{n().text}</p>
        <Show when={n().edits}>
          {(edits) => (
            <ol class="note-edits">
              <For each={edits()}>{(edit) => <li>{edit}</li>}</For>
            </ol>
          )}
        </Show>
        <Show when={n().status === "failed"}>
          <p class="note-error" classList={{ quiet: shown() === "stopped" }}>
            {n().error || (shown() === "stopped" ? "Stopped before it finished." : "Could not be sent.")}
          </p>
        </Show>
        <Show when={n().takenBack}>
          <p class="note-aside">
            {n().takenBack === "undone"
              ? "Taken back, files and all. /redo in its conversation brings it back."
              : n().takenBack === "restored"
                ? "Taken back: its files are as they were before it, later changes kept. /redo in its conversation brings it back until the next message there."
                : "The agent was asked to reverse it."}
          </p>
        </Show>
        <Show when={pictures().length}>
          <div class="note-shots">
            <For each={pictures()}>
              {(picture, i) => (
                <button class="note-shot" title={`${picture.name}. Click to enlarge; the arrow keys go between the two.`} onClick={() => openLightbox(pictures(), i())}>
                  <img src={picture.src} alt={picture.name} loading="lazy" decoding="async" />
                  <span>{i() === 0 ? "Before" : "After"}</span>
                </button>
              )}
            </For>
          </div>
          <Show when={n().status === "done" && pictures().length === 1}>
            <p class="note-aside">No picture after: the page was elsewhere, or at another width, when the agent finished.</p>
          </Show>
        </Show>
        <Show when={n().sent && (n().status === "done" || n().status === "working")}>
          <button class="more-btn note-diff-btn" aria-expanded={diff() !== undefined} disabled={loading()} onClick={toggleDiff}>
            <Show when={loading()} fallback={<Icon name="right" class="caret" />}>
              <Icon name="spinner" />
            </Show>
            <Show when={diff()} fallback={diff() === null ? "No record of what changed" : "What changed in the code"}>
              {(files) => (
                <>
                  {files().length === 0 ? "No file changed" : files().length === 1 ? "1 file changed" : `${files().length} files changed`}
                  <Show when={files().length}>
                    <Counts additions={totals().additions} deletions={totals().deletions} />
                  </Show>
                </>
              )}
            </Show>
          </button>
          <Show when={diff()?.length}>
            <div class="note-diff">
              <Changes changes={diff()!} />
            </div>
          </Show>
        </Show>
        <Show when={error()}>
          <p class="note-error">{error()}</p>
        </Show>
      </div>
      {/* A waiting note is not in the conversation: this is where it is taken out of the queue. */}
      <Show when={n().status === "queued"}>
        <div class="note-acts">
          <button
            class="btn note-cancel"
            title="The agent will not get this note; it stays on the list, stopped, with Retry"
            disabled={busy()}
            onClick={() => {
              setBusy(true)
              setError("")
              b42
                .invoke("cancelNote", n().id)
                .catch((err) => setError(message(err)))
                .finally(() => setBusy(false))
            }}
          >
            Remove from queue
          </button>
        </div>
      </Show>
      {/* What can be done with it, always in reach under a long diff. */}
      <Show when={n().status === "done" || n().status === "failed"}>
        <div class="note-acts">
          <Show when={n().status === "failed"}>
            <button class="btn" onClick={() => act("retryNote", n().id)}>
              Retry
            </button>
            <button class="btn" onClick={() => act("removeNote", n().id)}>
              Remove
            </button>
          </Show>
          <Show when={n().status === "done"}>
            <Show
              when={!sure()}
              fallback={
                <>
                  <span class="note-ask">
                    {sure() === "undone"
                      ? `Note ${n().n} is the newest message in its conversation, so it can be undone exactly, files included (/redo there brings it back). Undo it?`
                      : sure() === "restored"
                        ? `The app can put note ${n().n}'s files back exactly as they were before it, keeping what changed since. The conversation keeps it, and the agent is told with the next message there (/redo brings it back until then).${filesSaid()} Take it back?`
                        : `Note ${n().n} can't be taken back exactly: the app has no exact record of what it changed, another conversation changed this folder at the same time, or later changes touched the same lines. Ask the agent to reverse it?`}
                  </span>
                  <button class="btn danger" disabled={busy()} onClick={takeBack}>
                    {sure() === "undone" ? `Undo note ${n().n}` : sure() === "restored" ? `Take back note ${n().n}` : "Ask to reverse"}
                  </button>
                  <button class="btn" data-keep disabled={busy()} onClick={() => setSure(false)}>
                    Keep it
                  </button>
                </>
              }
            >
              <button
                class="btn"
                title={elsewhereToOpen() ? "Opens its conversation and starts a message about it there" : "Say more about it in the conversation"}
                disabled={busy()}
                onClick={follow}
              >
                Follow up
              </button>
              <Show when={!n().takenBack}>
                <button class="btn note-undo" title="Undo what the agent did for this note: says how before it does" disabled={busy()} onClick={askTakeBack}>
                  Take back
                </button>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </>
  )
}
