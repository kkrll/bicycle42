// What the server is still running: dev servers the agent started and nobody stopped. A button
// inside the address field, at its right end, says how many, and opens the list: those of the open repo
// first, then the ones left in the server's other projects, each with its own Stop.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Icon } from "./icons"
import { serverLabel } from "./connect"
import { b42, message, runningOpen, setRunningOpen, state } from "./store"
import type { RunningCommand } from "../shared/types"

/** "storefront" from "/home/dev/code/acme/storefront". */
const name = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || "/"

/** "42 min", "3 h", "2 days": how long it has been running. */
function since(started: number): string {
  const min = Math.max(1, Math.round((Date.now() - started) / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} days`
}

const here = () => state.site?.directory
const mine = () => state.running.filter((r) => r.directory === here())

/** The button. Not there while nothing is running. */
export function RunningButton() {
  const label = () => {
    const n = state.running.length
    const m = mine().length
    const what = m === 1 ? mine()[0]!.command : `${n} commands`
    return m ? `Still running here: ${what}. Stop, or see all` : `Still running in other projects: ${n}. Stop, or see all`
  }
  return (
    <Show when={state.running.length && state.connection.status === "online"}>
      <button class="icon-btn running-btn" data-action="running" aria-haspopup="dialog" aria-label={label()} title={label()} onClick={() => setRunningOpen(true)}>
        <Icon name="stop" />
        <span class="running-count">{state.running.length}</span>
      </button>
    </Show>
  )
}

export function RunningList(props: { onClose: () => void }) {
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal("")
  let dialog!: HTMLDialogElement
  onMount(() => {
    // Under its button, at the end of the address line.
    const at = document.querySelector(".running-btn")?.getBoundingClientRect()
    if (at) {
      dialog.style.top = `${Math.round(at.bottom + 6)}px`
      dialog.style.right = `${Math.max(8, Math.round(window.innerWidth - at.right))}px`
    }
    dialog.showModal()
    // The whole server, not only the open repo.
    void b42.invoke("refreshRunning").catch(() => undefined)
  })
  onCleanup(() => dialog.close())
  const stop = (r?: RunningCommand) => {
    setBusy(r?.id ?? "all")
    setError("")
    b42
      .invoke("stopRunning", r?.directory, r?.id)
      .catch((err) => setError(message(err)))
      .finally(() => setBusy(null))
  }
  const url = () => ("url" in state.connection ? state.connection.url : "")
  return (
    <dialog class="dialog running" ref={dialog} aria-labelledby="running-title" onClose={props.onClose} onClick={(e) => e.target === dialog && dialog.close()}>
      <header class="running-head">
        <h2 id="running-title">Still running on {serverLabel(url())}</h2>
        <Show when={state.running.length > 1}>
          <button class="btn" disabled={busy() !== null} onClick={() => stop()}>
            Stop all
          </button>
        </Show>
      </header>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
      <Show when={state.running.length} fallback={<p class="quiet running-none">Nothing is running.</p>}>
        <ul class="running-rows">
          <For each={state.running}>
            {(r) => (
              <li>
                <span class="running-what">
                  <code title={r.command}>{r.command}</code>
                  <span class="running-where" title={r.directory}>
                    {name(r.directory)}
                    <Show when={r.directory === here()}> (open)</Show> · {since(r.started)}
                  </span>
                </span>
                <button class="btn" disabled={busy() !== null} aria-label={`Stop ${r.command}`} onClick={() => stop(r)}>
                  <Show when={busy() === r.id || busy() === "all"}>
                    <Icon name="spinner" />
                  </Show>
                  Stop
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="running-foot">Commands the server keeps running in your projects, such as a dev server the agent started.</p>
    </dialog>
  )
}
