// Connecting to the server that does the work. One form, used twice: full-window before the
// first connection, and inside the settings dialog afterwards.
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import type { ConnectionState, ModelInfo, ModelRef } from "../shared/types"
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

/** The way in, the same line on all four first-run steps: connect, choose a model, open the
 *  site, pick its code folder. `at` is the step the reviewer is on. (The model step is skipped
 *  when the server leaves nothing to choose.) */
export function SetupSteps(props: { at: 1 | 2 | 3 | 4 }) {
  const names = ["Connect", "Model", "Site", "Folder"]
  return (
    <ol class="setup-steps" aria-label={`Setup, step ${props.at} of 4`}>
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

// ── the model new conversations start with ──────────────────────────────────────────────────────

/** More models than this and the list gets a field to narrow it. */
const FILTER_FROM = 12
const sameModel = (a: { providerID: string; id: string } | undefined, b: { providerID: string; id: string }) =>
  !!a && a.providerID === b.providerID && a.id === b.id

/** The list of the server's models with one of them chosen, an effort level if it has any, and
 *  one button that saves the choice. Used on the first-run step and in the settings dialog.
 *  The keyboard never has to leave the form: type to narrow, ↑/↓ to move, Enter to choose. */
export function ModelChooser(props: { suggested?: ModelRef; onDone?: () => void; autofocus?: boolean }) {
  const [query, setQuery] = createSignal("")
  const [picked, setPicked] = createSignal<ModelInfo | undefined>(state.models.find((m) => sameModel(props.suggested, m)) ?? state.models[0])
  const [variant, setVariant] = createSignal(props.suggested?.variant ?? "")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  let form!: HTMLFormElement
  let list!: HTMLDivElement

  const shown = createMemo(() => {
    const q = query().trim().toLowerCase()
    return q ? state.models.filter((m) => `${m.name} ${m.id} ${m.providerID}`.toLowerCase().includes(q)) : state.models
  })
  const groups = createMemo(() => {
    const by = new Map<string, ModelInfo[]>()
    for (const m of shown()) by.set(m.providerID, [...(by.get(m.providerID) ?? []), m])
    return [...by]
  })
  /** The rows in the order they are drawn, which is by provider, not the server's order. */
  const ordered = createMemo(() => groups().flatMap(([, models]) => models))
  // Narrowing the list keeps the choice when it is still there, else takes the first left.
  createEffect(on(shown, (models) => models.includes(picked()!) || setPicked(models[0])))
  // An effort level belongs to its model.
  createEffect(on(picked, (m) => m?.variants.includes(variant()) || setVariant(""), { defer: true }))
  createEffect(() => {
    const m = picked()
    if (m) list.querySelector<HTMLElement>(`[data-model="${CSS.escape(`${m.providerID}/${m.id}`)}"]`)?.scrollIntoView({ block: "nearest" })
  })
  onMount(() => props.autofocus && (form.querySelector<HTMLElement>("input[type=search]") ?? list).focus())

  const move = (by: number) => {
    const rows = ordered()
    if (!rows.length) return
    const at = rows.indexOf(picked()!)
    setPicked(rows[Math.max(0, Math.min(rows.length - 1, at + by))])
  }
  const keys = (e: KeyboardEvent) => {
    const on = (e.target as HTMLElement).localName
    if (on === "select") return
    if (e.key === "ArrowDown") move(1)
    else if (e.key === "ArrowUp") move(-1)
    // Enter chooses from anywhere in the form but a button, which has its own.
    else if (e.key === "Enter" && on !== "button") form.requestSubmit()
    else return
    e.preventDefault()
  }
  const submit = (e: SubmitEvent) => {
    e.preventDefault()
    const m = picked()
    if (!m || saving()) return
    setSaving(true)
    setError("")
    b42
      .invoke("setDefaultModel", { providerID: m.providerID, id: m.id, ...(variant() ? { variant: variant() } : {}) })
      .then(() => props.onDone?.())
      .catch((err) => setError(message(err)))
      .finally(() => setSaving(false))
  }
  return (
    <form class="connect-form model-form" ref={form} onSubmit={submit} onKeyDown={keys}>
      <Show when={state.models.length > FILTER_FROM}>
        <input
          class="input"
          type="search"
          aria-label="Find a model"
          placeholder="Find a model"
          spellcheck={false}
          autocomplete="off"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </Show>
      <div class="model-list" ref={list} role="listbox" aria-label="Models" tabindex="0">
        <For each={groups()} fallback={<p class="quiet">No model by that name.</p>}>
          {([provider, models]) => (
            <>
              <h3 class="label">{provider}</h3>
              <For each={models}>
                {(m) => (
                  <button
                    class="row"
                    type="button"
                    role="option"
                    tabindex="-1"
                    data-model={`${m.providerID}/${m.id}`}
                    aria-selected={m === picked()}
                    onClick={() => setPicked(m)}
                    onDblClick={() => form.requestSubmit()}
                  >
                    <Show when={m === picked()} fallback={<span />}>
                      <Icon name="check" />
                    </Show>
                    <span class="row-main">{m.name}</span>
                    <Show when={!m.images}>
                      <span class="model-note">no screenshots</span>
                    </Show>
                  </button>
                )}
              </For>
            </>
          )}
        </For>
      </div>
      <Show when={state.models.some((m) => !m.images)}>
        <p class="form-help">A model marked “no screenshots” cannot see pictures: your notes reach it as text only.</p>
      </Show>
      <Show when={picked()?.variants.length}>
        <label class="form-row">
          <span class="label">Effort (optional)</span>
          <select class="input" aria-label="Effort" value={variant()} onChange={(e) => setVariant(e.currentTarget.value)}>
            <option value="">default</option>
            <For each={picked()!.variants}>{(v) => <option value={v}>{v}</option>}</For>
          </select>
        </label>
      </Show>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="form-actions">
        <button class="btn primary" type="submit" disabled={saving() || !picked()}>
          <Show when={saving()}>
            <Icon name="spinner" />
          </Show>
          {picked() ? `Use ${picked()!.name}` : "Choose a model"}
        </button>
      </div>
    </form>
  )
}

/** The second first-run step. Also comes back when the saved model has left the server's list. */
export function ModelScreen() {
  const choice = () => state.modelChoice
  return (
    <div class="connect-screen">
      <div class="connect-card">
        <SetupSteps at={2} />
        <h1>Choose a model</h1>
        <p class="connect-lead">
          New conversations start with it. You can change it any time under the chat box.
          <Show when={choice()?.previous}>
            {(was) => <> The one used before ({was().id}) is no longer offered by this server.</>}
          </Show>
        </p>
        <ModelChooser suggested={choice()?.suggested} autofocus />
      </div>
    </div>
  )
}

export function SettingsDialog(props: { onClose: () => void }) {
  const [choosing, setChoosing] = createSignal(false)
  const defaultName = () => {
    const d = state.defaultModel
    const m = d && state.models.find((x) => sameModel(d, x))
    return m ? `${m.name}${d!.variant ? ` · ${d!.variant}` : ""}` : "none chosen"
  }
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
        <Show when={state.models.length}>
          <div class="dialog-connected">
            <p class="dialog-status">
              <span>
                Default model: {defaultName()}
                <span class="dialog-sub">New conversations start with it</span>
              </span>
            </p>
            <button class="btn" data-action="default-model" aria-expanded={choosing()} onClick={() => setChoosing(!choosing())}>
              {choosing() ? "Cancel" : "Change"}
            </button>
          </div>
          <Show when={choosing()}>
            <ModelChooser suggested={state.defaultModel} autofocus onDone={() => setChoosing(false)} />
          </Show>
        </Show>
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
