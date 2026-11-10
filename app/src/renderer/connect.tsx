// Connecting to the server that does the work. One form, used twice: full-window before the
// first connection, and inside the settings dialog afterwards.
import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js"
import type { ConnectionState } from "../shared/types"
import { Icon } from "./icons"
import { act, host, message, b42, setNotice, state } from "./store"

/** True from pressing Connect on the first-run screen until main answers: the window keeps
 *  showing that screen meanwhile, whatever the connection state says. Only that screen's form
 *  sets it; the settings dialog's form has nothing to do with which screen is up. */
export const [firstRunConnecting, setFirstRunConnecting] = createSignal(false)

/** The connection in one sentence, for the settings dialog and the top bar's tooltip. */
export function connectionText(c: ConnectionState): string {
  switch (c.status) {
    case "online":
      return `Connected to ${host(c.url)} · version ${c.version}`
    case "offline":
      return `Cannot reach ${host(c.url)}. ${c.error}`
    case "connecting":
      return `Connecting to ${host(c.url)}`
    case "unconfigured":
      return "Not connected"
  }
}

/** The way in, the same line on all three first-run steps: connect, open the site, pick its code
 *  folder. `at` is the step the reviewer is on. */
export function SetupSteps(props: { at: 1 | 2 | 3 }) {
  const names = ["Connect", "Open your site", "Code folder"]
  return (
    <ol class="setup-steps" aria-label={`Setup, step ${props.at} of 3`}>
      <For each={names}>
        {(name, i) => {
          const n = i() + 1
          const state = () => (n < props.at ? "done" : n === props.at ? "current" : "todo")
          return (
            <li data-state={state()} aria-current={state() === "current" ? "step" : undefined}>
              <span class="step-mark">
                <Show when={state() === "done"} fallback={n}>
                  <Icon name="check" />
                </Show>
              </span>
              {name}
            </li>
          )
        }}
      </For>
    </ol>
  )
}

function ConnectForm(props: { onDone?: () => void; onBusy?: (busy: boolean) => void; autofocus?: boolean }) {
  const [connecting, setBusy] = createSignal(false)
  const setConnecting = (busy: boolean) => {
    setBusy(busy)
    props.onBusy?.(busy)
  }
  // The dialog can be closed while main is still trying. The attempt goes on; its outcome then
  // has no form to land in, so a failure goes to the notice strip.
  let gone = false
  onCleanup(() => (gone = true))
  const known = () => ("url" in state.connection ? state.connection.url : "")
  const [url, setUrl] = createSignal(known())
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal("")
  let first!: HTMLInputElement
  // Asked once per form: is OpenCode already running on this computer?
  const [local] = createResource(() => b42.invoke("localServer").catch(() => null))
  onMount(() => props.autofocus && !local() && first.focus())
  const here = () => state.connection.status === "online" && local()?.url === state.connection.url

  const useLocal = () => {
    if (connecting()) return
    setConnecting(true)
    setError("")
    b42
      .invoke("connectLocal")
      .then(() => gone || props.onDone?.())
      .catch((err) => (gone ? setNotice(`Could not connect to this computer's server. ${message(err)}`) : setError(message(err))))
      .finally(() => setConnecting(false))
  }

  const submit = (e: SubmitEvent) => {
    e.preventDefault()
    if (connecting() || !url().trim()) return
    setConnecting(true)
    setError("")
    b42
      .invoke("connect", { url: url().trim(), password: password() })
      .then(() => gone || props.onDone?.())
      .catch((err) => (gone ? setNotice(`Could not connect to ${host(url().trim())}. ${message(err)}`) : setError(message(err))))
      .finally(() => setConnecting(false))
  }
  return (
    <form class="connect-form" onSubmit={submit}>
      <section class="connect-local">
        <h3 class="label">This computer</h3>
        <Show
          when={local()}
          fallback={
            <p class="form-help">
              No OpenCode server is running here. <code>opencode service start</code> starts one.
            </p>
          }
        >
          {(found) => (
            <div class="connect-local-row">
              <p class="form-help">
                OpenCode is running here, at <code>{host(found().url)}</code>.
              </p>
              {/* Each section keeps its own primary action, whatever is typed in the other. */}
              <button class="btn primary" type="button" disabled={connecting() || here()} onClick={useLocal}>
                {here() ? "Connected" : "Use this computer"}
              </button>
            </div>
          )}
        </Show>
      </section>
      <h3 class="label connect-remote">Another computer</h3>
      <label class="form-row">
        <span class="label">Server address</span>
        <input
          ref={first}
          class="input mono"
          type="text"
          name="url"
          required
          spellcheck={false}
          autocomplete="off"
          placeholder="http://my-box.example:4096"
          disabled={connecting()}
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
      </label>
      <label class="form-row">
        <span class="label">Password</span>
        <input
          class="input mono"
          type="password"
          name="password"
          autocomplete="off"
          disabled={connecting()}
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
      </label>
      <div class="form-help">
        <p>
          On the computer with your code, run <code>opencode service status</code>; it prints the address (the{" "}
          <code>https://…</code> one works from anywhere). The password is the <code>password</code> value in the file
          it names.
        </p>
        <p class="form-help-more">
          To see it: <code>cat ~/.config/opencode/service.json</code>
        </p>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="form-actions">
        <button class="btn primary" type="submit" disabled={connecting() || !url().trim()}>
          <Show when={connecting()}>
            <Icon name="spinner" />
          </Show>
          {connecting() ? "Connecting" : "Connect"}
        </button>
      </div>
    </form>
  )
}

export function ConnectScreen() {
  return (
    <div class="connect-screen">
      <div class="connect-card">
        <SetupSteps at={1} />
        <h1>Connect to OpenCode</h1>
        <p class="connect-lead">
          Your notes go to an OpenCode server next to the site's code: on this computer, or on another one. It makes
          the changes; you keep reviewing.
        </p>
        <ConnectForm autofocus onBusy={setFirstRunConnecting} />
      </div>
    </div>
  )
}

export function SettingsDialog(props: { onClose: () => void }) {
  let dialog!: HTMLDialogElement
  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())
  const c = () => state.connection
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="settings-title"
      onClose={props.onClose}
      onClick={(e) => e.target === dialog && dialog.close()}
    >
      <header class="dialog-head">
        <h2 id="settings-title">Server</h2>
        <button class="icon-btn" aria-label="Close" title="Close" onClick={() => dialog.close()}>
          <Icon name="close" />
        </button>
      </header>
      <Show
        when={c().status === "online"}
        fallback={
          <>
            <p class="dialog-status" data-status={c().status}>
              <span class="dot" />
              {connectionText(c())}
            </p>
            <ConnectForm onDone={() => dialog.close()} />
          </>
        }
      >
        {/* Connected: that is the answer. Changing server is one quiet step away. */}
        <div class="dialog-connected">
          <p class="dialog-status" data-status="online">
            <span class="dot" />
            <span>
              Connected to {"url" in c() ? host((c() as { url: string }).url) : ""}
              <span class="dialog-sub">OpenCode {c().status === "online" ? (c() as { version: string }).version : ""}</span>
            </span>
          </p>
          <button
            class="btn"
            title="Forgets this server and its password on this computer"
            onClick={() => {
              act("disconnect")
              dialog.close()
            }}
          >
            Disconnect
          </button>
        </div>
        <details class="disclosure">
          <summary>
            <Icon name="right" class="caret" />
            Use another server
          </summary>
          <ConnectForm onDone={() => dialog.close()} />
        </details>
      </Show>
      <Show when={c().status === "offline" || c().status === "connecting"}>
        <footer class="dialog-foot">
          <p>Disconnecting forgets this server and its password on this computer.</p>
          <button
            class="btn"
            onClick={() => {
              act("disconnect")
              dialog.close()
            }}
          >
            Disconnect
          </button>
        </footer>
      </Show>
    </dialog>
  )
}
