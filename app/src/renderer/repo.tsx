// The repo, in the conversation's header: how much is changed and not committed, and under it
// the branch, the files and a way to commit them. The agent makes the commit; the message is the
// reviewer's, started from the notes that are done.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Icon } from "./icons"
import { act, b42, message, state } from "./store"

const capital = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text)
const oneLine = (text: string, max = 68) => {
  const line = text.split("\n")[0]!.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A commit message from the notes: the accepted ones when any are, else all that are done. */
export function commitMessage(notes: typeof state.review.notes): string {
  const done = notes.filter((n) => n.status === "done" && !n.takenBack)
  const picked = done.some((n) => n.accepted) ? done.filter((n) => n.accepted) : done
  if (!picked.length) return ""
  if (picked.length === 1) return capital(oneLine(picked[0]!.text))
  return [`UI review: ${picked.length} notes`, "", ...picked.map((n) => `- ${oneLine(n.text, 100)}`)].join("\n")
}

/** `onOpen`: the header's other menu makes way. */
export function RepoBar(props: { onOpen?: () => void }) {
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal("")
  /** The reviewer wrote the message: it is not replaced by the notes' when the form opens again. */
  const [edited, setEdited] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const changes = () => state.repo?.changes ?? []
  const totals = () => changes().reduce((t, f) => ({ plus: t.plus + f.additions, minus: t.minus + f.deletions }), { plus: 0, minus: 0 })
  const count = () => (changes().length === 1 ? "1 file changed" : `${changes().length} files changed`)
  /** The agent is on something: its changes would go into the commit half done. */
  const working = () => !!state.session?.busy || state.review.notes.some((n) => n.status === "working")
  let chip!: HTMLButtonElement
  let pop: HTMLDivElement | undefined

  const toggle = () => {
    if (!open()) {
      props.onOpen?.()
      act("refreshRepo")
      if (!edited() || !text().trim()) setText(commitMessage(state.review.notes))
      setError("")
    }
    setOpen(!open())
  }
  const outside = (e: PointerEvent) => {
    const target = e.target as Node
    if (open() && !chip.contains(target) && !pop?.contains(target)) setOpen(false)
  }
  onMount(() => document.addEventListener("pointerdown", outside))
  onCleanup(() => document.removeEventListener("pointerdown", outside))
  const commit = () => {
    setBusy(true)
    setError("")
    b42
      .invoke("commitChanges", text())
      .then(
        () => (setOpen(false), setText(""), setEdited(false)),
        (err) => setError(message(err)),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Show when={state.repo && changes().length > 0}>
      <button
        class="repo-chip"
        ref={chip}
        aria-haspopup="dialog"
        aria-expanded={open()}
        title={`${state.repo?.branch ? `${state.repo.branch}: ` : ""}${count()}, not committed`}
        onClick={toggle}
      >
        <Icon name="branch" />
        <span class="counts">
          <span class="plus">+{totals().plus}</span>
          <span class="minus">−{totals().minus}</span>
        </span>
      </button>
      <Show when={open()}>
        <div
          class="repo-pop"
          role="dialog"
          aria-label="Changes that are not committed"
          ref={pop}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return
            e.stopPropagation()
            setOpen(false)
            chip.focus()
          }}
        >
          <p class="repo-head">
            <Show when={state.repo?.branch}>
              <span class="repo-branch">{state.repo!.branch}</span>
            </Show>
            <span class="repo-count">{count()}</span>
          </p>
          <ul class="repo-files">
            <For each={changes()}>
              {(f) => (
                <li title={f.file}>
                  <span class="repo-status" data-status={f.status}>
                    {f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"}
                  </span>
                  <bdi class="repo-file">{f.file}</bdi>
                  <span class="counts">
                    <span class="plus">+{f.additions}</span>
                    <span class="minus">−{f.deletions}</span>
                  </span>
                </li>
              )}
            </For>
          </ul>
          <textarea
            class="repo-message"
            rows={Math.min(6, Math.max(2, text().split("\n").length))}
            aria-label="Commit message"
            placeholder="What this commit is"
            spellcheck={false}
            value={text()}
            onInput={(e) => (setText(e.currentTarget.value), setEdited(true))}
          />
          <Show when={error()}>
            <p class="form-error">{error()}</p>
          </Show>
          <div class="repo-acts">
            <span class="repo-hint">
              {working()
                ? "The agent is still working: the commit waits its turn and takes what is changed by then."
                : "The agent commits everything changed, and does not push."}
            </span>
            <button class="btn primary" disabled={busy() || !text().trim() || !state.session} onClick={commit}>
              Commit
            </button>
          </div>
        </div>
      </Show>
    </Show>
  )
}
