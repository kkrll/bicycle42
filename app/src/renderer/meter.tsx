// The context meter, in the message box's bottom row: how full the conversation's context is,
// and a way to have it summarised without knowing the command. It is not there while less than
// half is used. From there it also says "Compact" whenever the agent has nothing left to do: a
// pause between rounds of notes is when a summary costs least. Pressing it asks first, because a
// summary cannot be taken back.
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { meter } from "./context"
import { Icon } from "./icons"
import { b42, chat, message, setNotice, state, tallyNotes } from "./store"

export function ContextMeter() {
  const [open, setOpen] = createSignal(false)
  const [asking, setAsking] = createSignal(false)
  const shown = createMemo(() => meter(state.context))
  /** A summary is already being written: a second one would have nothing to do. */
  const summarising = () => chat.items.some((i) => i.kind === "assistant" && i.summary && !i.done)
  /** Nothing is being worked on and nothing waits: the moment to suggest a summary. */
  const resting = () => !!state.session && !state.session.busy && !summarising() && tallyNotes().left === 0
  let button!: HTMLButtonElement
  let pop: HTMLDivElement | undefined

  // The meter went away (summarised, or another conversation): so does its question.
  createEffect(() => !shown() && setOpen(false))
  const outside = (e: PointerEvent) => {
    const target = e.target as Node
    if (open() && !button?.contains(target) && !pop?.contains(target)) setOpen(false)
  }
  onMount(() => document.addEventListener("pointerdown", outside))
  onCleanup(() => document.removeEventListener("pointerdown", outside))

  // The same path as typing /compact. The summary, or why there is none, shows in the conversation.
  const compact = () => {
    setAsking(true)
    b42
      .invoke("runCommand", "compact", "")
      .then(
        () => setOpen(false),
        (err) => setNotice(message(err)),
      )
      .finally(() => setAsking(false))
  }
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open()) return
    e.stopPropagation()
    setOpen(false)
    button.focus()
  }

  return (
    <Show when={shown()}>
      {(m) => (
        <>
          <button
            class="meter"
            classList={{ warn: m().warn }}
            ref={button}
            data-action="context"
            aria-haspopup="dialog"
            aria-expanded={open()}
            aria-label={`Context ${m().percent}% full: ${m().numbers}. Compact the conversation`}
            title={`Context: ${m().numbers}`}
            onClick={() => setOpen(!open())}
            onKeyDown={escape}
          >
            <Icon name="gauge" />
            {m().percent}%
            <Show when={resting()}>
              <span class="meter-word">Compact</span>
            </Show>
          </button>
          <Show when={open()}>
            <div class="meter-pop" role="dialog" aria-label="Compact the conversation" ref={pop} onKeyDown={escape}>
              <p class="meter-head">
                <span class="meter-full">Context {m().percent}% full</span>
                <span class="meter-numbers">{m().numbers}</span>
              </p>
              <div class="meter-acts">
                <span class="meter-hint">
                  {summarising()
                    ? "The agent is writing a summary of the conversation now."
                    : state.session?.busy
                      ? "The agent summarises the conversation so far when its current step ends, and continues from the summary. This cannot be undone."
                      : "The agent summarises the conversation so far and continues from the summary. This cannot be undone."}
                </span>
                <button class="btn primary" disabled={asking() || summarising() || !state.session} onClick={compact}>
                  Compact
                </button>
              </div>
            </div>
          </Show>
        </>
      )}
    </Show>
  )
}
