// Connecting to the agent that does the work: one the app runs on this computer, or on another
// one over ssh. One form, used twice: full-window before the first connection, and inside the
// settings dialog afterwards.
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import type { ConnectionState, LocalAgent, ModelInfo, ModelRef, RemoteInfo } from "../shared/types"
import { harnessNow, kindOfAgent } from "./agents"
import { CopyButton } from "./copy"
import { AgentMark, Icon } from "./icons"
import { soundOn, toggleSound } from "./sound"
import { act, host, message, b42, setNotice, state } from "./store"

/** True from pressing Connect on the first-run screen until main answers: the window keeps
 *  showing that screen meanwhile, whatever the connection state says. Only that screen's form
 *  sets it; the settings dialog's form has nothing to do with which screen is up. */
export const [firstRunConnecting, setFirstRunConnecting] = createSignal(false)

/** The settings dialog opens at the connect form ("connect"), once: the agent switcher's
 *  "Connect another agent" sets it before it opens the dialog. */
export const [settingsAt, setSettingsAt] = createSignal<"connect" | undefined>()

/** The connection in one sentence, for the settings dialog and the top bar's tooltip. */
export function connectionText(c: ConnectionState): string {
  const h = harnessNow()
  switch (c.status) {
    case "online":
      return `Connected to ${serverLabel(c.url)}${h?.here ? " on this computer" : h?.host && isAgent(c.url) ? ` on ${h.host}` : ""} · version ${c.version}`
    case "offline":
      return `Cannot reach ${serverLabel(c.url)}. ${c.error}`
    case "connecting":
      return `Connecting to ${serverLabel(c.url)}`
    case "unconfigured":
      return "Not connected"
  }
}

/** What the agent is called: the reviewer's name for it, else the agent's own. Never an acp:// id. */
export const serverLabel = (url: string) => state.harness?.name || state.serverName || host(url)

/** An agent the app runs over ACP (connectAgent): its "address" is acp://<id>, or
 *  acp://<id>@<host> on another computer over ssh. */
export const isAgent = (url: string) => url.startsWith("acp://")

/** The agent's name, and the field that changes it. Empty goes back to its own. */
function ServerName(props: { url: string; version: string }) {
  const [editing, setEditing] = createSignal(false)
  let field!: HTMLInputElement
  const save = () => {
    act("setServerName", field.value)
    setEditing(false)
  }
  return (
    <span class="server-name">
      <Show
        when={editing()}
        fallback={
          <>
            <span class="server-title">
              <AgentMark kind={state.harness?.kind} />
              {serverLabel(props.url)}
            </span>
            <span class="dialog-sub">
              {`${state.harness?.host ? `On ${state.harness.host}, over ssh and ACP` : "On this computer, over ACP"} · ${props.version}`}
            </span>
            <button class="text-btn" data-action="rename-server" onClick={() => setEditing(true)}>
              {state.serverName ? "Rename" : "Name it"}
            </button>
          </>
        }
      >
        <form
          class="server-name-form"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <input
            ref={(el) => {
              field = el
              requestAnimationFrame(() => el.select())
            }}
            class="input"
            aria-label="Its name"
            placeholder={harnessNow()?.name ?? ""}
            maxLength={60}
            value={state.serverName ?? ""}
            onKeyDown={(e) => {
              // Esc leaves the name as it was; the dialog stays open.
              if (e.key !== "Escape") return
              e.preventDefault()
              e.stopPropagation()
              setEditing(false)
            }}
          />
          <button class="btn primary" type="submit">
            Save
          </button>
        </form>
      </Show>
    </span>
  )
}

/** The way in, the same line on every first-run screen: connect, open the repo, open its site.
 *  `at` is the step the reviewer is on. Choosing a model belongs to connecting: its screen
 *  shows step 1 as still current. */
export function SetupSteps(props: { at: 1 | 2 | 3 }) {
  const names = ["Connect", "Repo", "Site"]
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

/** How a known agent stands on this computer, in the order the connect form checks. */
type AgentState = "using" | "missing" | "signin" | "ready"

/** One agent the app knows, as a row: its mark, its name, how it stands in plain words, and the
 *  one thing to do about it (Start, or copy what installs it). The command that starts it is
 *  there on request. */
function AgentRow(props: { agent: LocalAgent; using: boolean; busy: boolean; error?: string; onStart: () => void; where?: string }) {
  const [how, setHow] = createSignal(false)
  const a = () => props.agent
  const st = (): AgentState => (props.using ? "using" : !a().installed ? "missing" : a().signIn || /sign in/i.test(props.error ?? "") ? "signin" : "ready")
  const login = () => a().signIn ?? (a().id === "codex" ? "codex login" : a().id === "opencode" ? "opencode auth login" : a().id)
  return (
    <li class="agent-row" data-agent={a().id} data-host={props.where} data-state={st()}>
      <AgentMark kind={kindOfAgent(a().id)} size={20} />
      <div class="agent-text">
        <span class="agent-name">{a().name}</span>
        <span class="agent-status">
          <Switch>
            <Match when={st() === "using"}>
              <span class="dot" data-status="online" /> In use
            </Match>
            <Match when={st() === "missing"}>
              Not installed: <code>{a().install ?? a().needs}</code>
            </Match>
            <Match when={st() === "signin"}>
              Needs you to sign in: run <code>{login()}</code> in a terminal
            </Match>
            <Match when={true}>{props.where ? `Ready on ${props.where}` : "Ready"}</Match>
          </Switch>
        </span>
        <Show when={props.error && st() !== "signin"}>
          <span class="agent-error" role="alert">
            {props.error}
          </span>
        </Show>
        <Show when={how()}>
          <code class="agent-command">{a().command}</code>
        </Show>
      </div>
      <div class="agent-acts">
        <Show when={a().installed}>
          <button class="text-btn agent-how" type="button" aria-expanded={how()} title="The command the app runs to start it" onClick={() => setHow(!how())}>
            {how() ? "Hide command" : "Command"}
          </button>
        </Show>
        <Switch>
          <Match when={st() === "missing"}>
            <CopyButton class="btn" text={() => a().install ?? ""} label="Copy the install command" />
          </Match>
          <Match when={st() !== "using"}>
            <button class="btn" type="button" data-start={a().id} disabled={props.busy} onClick={() => props.onStart()}>
              Start
            </button>
          </Match>
        </Switch>
      </div>
    </li>
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
  /** Another computer was connected to here (to list its agents): let go with this screen,
   *  unless an agent there is the one in use (main keeps that one). */
  let reached = false
  // Said once: the line about servers put aside goes with this screen too.
  const leave = () => (reached || state.serversRetired) && void b42.invoke("leaveSsh").catch(() => undefined)
  onCleanup(() => {
    gone = true
    leave()
  })
  const [error, setError] = createSignal("")
  /** Which row an error belongs to: an agent's id, "custom", or "" for the form. */
  const [errorAt, setErrorAt] = createSignal("")
  // The ACP agents this computer can run, each said installed or not.
  const [agents] = createResource(() => b42.invoke("localAgents").catch(() => [] as LocalAgent[]))
  const using = (id: string) => state.connection.status === "online" && state.connection.url === `acp://${id}`
  const [custom, setCustom] = createSignal("")
  // The agents used before on other computers, and those run by a command typed by hand: one
  // click. (A known agent of this computer has its own row above.)
  const [saved, { refetch: reloadSaved }] = createResource(() => b42.invoke("servers").catch(() => []))
  const others = () => (saved() ?? []).filter((s) => s.agent && !(!s.host && (agents() ?? []).some((a) => a.id === s.agent)) && !(s.current && state.connection.status === "online"))
  const fail = (at: string, err: unknown) => (setError(message(err)), setErrorAt(at))
  // Another computer over ssh: its host, and once connected, the agents installed there.
  const [sshHost, setSshHost] = createSignal(state.harness?.host && isAgent("url" in state.connection ? state.connection.url : "") ? state.harness.host : "")
  const [there, setThere] = createSignal<RemoteInfo>()
  const [reaching, setReaching] = createSignal(false)
  const usingThere = (id: string, where: string) => state.connection.status === "online" && state.connection.url === `acp://${id}@${encodeURIComponent(where)}`
  const reach = () => {
    const where = sshHost().trim()
    if (!where || connecting()) return
    setConnecting(true)
    setReaching(true)
    setError("")
    setThere(undefined)
    reached = true
    b42
      .invoke("connectSsh", where)
      .then((info) => (gone ? leave() : setThere(info)))
      .catch((err) => (gone ? setNotice(`Could not connect to ${where}. ${message(err)}`) : fail("ssh", err)))
      .finally(() => (setConnecting(false), setReaching(false)))
  }
  const useSaved = (id: string, label: string) => {
    if (connecting()) return
    setConnecting(true)
    setError("")
    b42
      .invoke("useServer", id)
      .then(() => gone || props.onDone?.())
      .catch((err) => (gone ? setNotice(`Could not connect to ${label}. ${message(err)}`) : fail(id, err)))
      .finally(() => setConnecting(false))
  }
  const forget = (id: string) =>
    b42
      .invoke("forgetServer", id)
      .then(() => reloadSaved())
      .catch((err) => fail(id, err))

  const useAgent = (agent: { id: string; command?: string; host?: string }, label: string) => {
    if (connecting()) return
    setConnecting(true)
    setError("")
    b42
      .invoke("connectAgent", agent)
      .then(() => gone || props.onDone?.())
      .catch((err) => (gone ? setNotice(`Could not start ${label}. ${message(err)}`) : fail(agent.host ? `ssh:${agent.id}` : agent.command ? "custom" : agent.id, err)))
      .finally(() => setConnecting(false))
  }
  const startCustom = () => custom().trim() && useAgent({ id: "custom", command: custom().trim() }, custom().trim())

  /** The error, under the row it belongs to. */
  const errorOf = (at: string) => (error() && errorAt() === at ? error() : undefined)
  const RowError = (p: { at: string }) => (
    <Show when={errorOf(p.at)}>
      <p class="form-error agent-row-error" role="alert">
        {errorOf(p.at)}
      </p>
    </Show>
  )
  return (
    <form class="connect-form" onSubmit={(e) => e.preventDefault()}>
      <Show when={state.serversRetired}>
        <p class="form-help connect-retired" role="status">
          OpenCode servers are no longer supported. Choose OpenCode as an agent here, or connect to that computer over ssh.
        </p>
      </Show>
      <section class="connect-section">
        <h3 class="label">Agents on this computer</h3>
        <p class="form-help">The app starts it with your own login, in this computer's folders.</p>
        <ul class="agent-list">
          <Show when={agents.loading}>
            <li class="agent-row agent-wait">
              <Icon name="spinner" />
              <span class="agent-status">Looking for agents</span>
            </li>
          </Show>
          <For each={agents() ?? []}>
            {(a) => <AgentRow agent={a} using={using(a.id)} busy={connecting()} error={errorOf(a.id)} onStart={() => useAgent({ id: a.id }, a.name)} />}
          </For>
          <li class="agent-row agent-custom" data-state={custom().trim() ? "ready" : "empty"}>
            <AgentMark kind="custom" size={20} />
            <input
              class="input mono"
              type="text"
              aria-label="Another ACP agent's command"
              placeholder="Another ACP agent: the command that starts it"
              spellcheck={false}
              autocomplete="off"
              disabled={connecting()}
              value={custom()}
              onInput={(e) => setCustom(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter here starts this command.
                if (e.key !== "Enter") return
                e.preventDefault()
                startCustom()
              }}
            />
            <div class="agent-acts">
              <button class="btn" type="button" data-start="custom" disabled={connecting() || !custom().trim()} onClick={startCustom}>
                Start
              </button>
            </div>
            <RowError at="custom" />
          </li>
        </ul>
      </section>
      <section class="connect-section connect-ssh">
        <h3 class="label">Another computer (ssh)</h3>
        <p class="form-help">
          The app connects with your own ssh (its keys, <code>~/.ssh/config</code>, Tailscale) and runs the agent there, in that computer's folders. It needs
          Node 18 or newer there, and puts a small helper in <code>~/.bicycle42</code>.
        </p>
        <ul class="agent-list">
          <li class="agent-row agent-custom" data-state={sshHost().trim() ? "ready" : "empty"}>
            <AgentMark kind="custom" size={20} />
            <input
              class="input mono"
              type="text"
              aria-label="The other computer: user@host, or a name from your ssh config"
              placeholder="user@host, or a name from ~/.ssh/config"
              spellcheck={false}
              autocomplete="off"
              disabled={connecting()}
              value={sshHost()}
              onInput={(e) => setSshHost(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter here connects to that computer.
                if (e.key !== "Enter") return
                e.preventDefault()
                reach()
              }}
            />
            <div class="agent-acts">
              <button class="btn" type="button" data-action="ssh" disabled={connecting() || !sshHost().trim()} onClick={reach}>
                <Show when={reaching()}>
                  <Icon name="spinner" />
                </Show>
                {reaching() ? "Connecting" : "Connect"}
              </button>
            </div>
            <RowError at="ssh" />
          </li>
          <Show when={there()}>
            {(r) => (
              <For each={r().agents}>
                {(a) => (
                  <AgentRow
                    agent={a}
                    where={r().host}
                    using={usingThere(a.id, r().host)}
                    busy={connecting()}
                    error={errorOf(`ssh:${a.id}`)}
                    onStart={() => useAgent({ id: a.id, host: r().host }, `${a.name} on ${r().host}`)}
                  />
                )}
              </For>
            )}
          </Show>
        </ul>
      </section>
      <Show when={others().length}>
        <section class="connect-section connect-saved">
          <h3 class="label">Connected before</h3>
          <ul class="agent-list">
            <For each={others()}>
              {(s) => (
                <li class="agent-row saved-row" data-kind={s.kind}>
                  <AgentMark kind={s.kind} size={20} />
                  <div class="agent-text" title={s.command}>
                    <span class="agent-name">{s.name ?? s.agent}</span>
                    <span class="agent-status">{s.here ? "this computer" : s.host}</span>
                  </div>
                  <div class="agent-acts">
                    <button class="text-btn saved-forget" type="button" disabled={connecting()} title="Forgets it on this computer" onClick={() => forget(s.id)}>
                      Forget
                    </button>
                    <button class="btn" type="button" data-server={s.id} disabled={connecting()} onClick={() => useSaved(s.id, s.name ?? s.agent ?? "it")}>
                      Connect
                    </button>
                  </div>
                  <RowError at={s.id} />
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={error() && !errorAt()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </form>
  )
}

export function ConnectScreen() {
  return (
    <div class="connect-screen">
      <div class="connect-card">
        <SetupSteps at={1} />
        <h1>Connect an agent</h1>
        <p class="connect-lead">Your notes go to a coding agent that works in the site's code. It makes the changes; you keep reviewing.</p>
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

/** The list of the agent's models with one of them chosen, an effort level if it has any, and
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
  /** The rows in the order they are drawn, which is by provider, not the agent's order. */
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

/** The second first-run step. Also comes back when the saved model has left the agent's list. */
export function ModelScreen() {
  const choice = () => state.modelChoice
  return (
    <div class="connect-screen">
      <div class="connect-card">
        <SetupSteps at={1} />
        <h1>Choose a model</h1>
        <p class="connect-lead">
          New conversations start with it. You can change it any time under the chat box.
          <Show when={choice()?.previous}>
            {(was) => <> The one used before ({was().id}) is no longer offered by this agent.</>}
          </Show>
        </p>
        <ModelChooser suggested={choice()?.suggested} autofocus />
      </div>
    </div>
  )
}

/** The agent, as its mark with its state as a dot; in a word when it is not simply connected.
 *  Opens the settings. In the panel's conversation row, or the top bar while that is not shown. */
export function ServerButton(props: { onClick: () => void }) {
  const word = () => (state.connection.status === "offline" ? "Offline" : state.connection.status === "connecting" ? "Connecting" : "")
  return (
    <button
      class="icon-btn"
      classList={{ labelled: word() !== "" }}
      data-action="settings"
      data-status={state.connection.status}
      aria-label={word() ? `Settings. ${harnessNow()?.name ?? "Agent"}: ${word()}` : "Settings"}
      title={`${connectionText(state.connection)}. Click for settings`}
      onClick={props.onClick}
    >
      <AgentMark kind={harnessNow()?.kind} />
      <Show when={word()} fallback={<span class="dot" data-status={state.connection.status} />}>
        <span>{word()}</span>
      </Show>
    </button>
  )
}

function Toggle(props: { on: boolean; label: string; title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button class="toggle" role="switch" aria-checked={props.on} disabled={props.disabled} title={props.title} onClick={props.onClick}>
      <span class="toggle-track" />
      {props.label}
    </button>
  )
}

/** What used to sit in the top bar and is set once: reloading after a note, and the sounds. */
function Preferences() {
  return (
    <div class="dialog-prefs">
      <div class="dialog-pref">
        <Toggle
          on={state.review.autoReload && !state.page.hmr}
          label="Reload the page when a note is done"
          title="Reload the page when the agent finishes a note"
          disabled={!state.page.url || state.page.hmr}
          onClick={() => act("toggleAutoReload")}
        />
        <Show when={state.page.hmr}>
          <span class="dialog-sub">This page updates by itself when files change, so the app doesn't reload it.</span>
        </Show>
      </div>
      <div class="dialog-pref">
        <Toggle on={soundOn()} label="Sounds" title="A question, a failure, finished" onClick={toggleSound} />
        <span class="dialog-sub">When the agent asks something, when a note fails or the agent is lost, and when it has finished.</span>
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
  // Opened from the agent switcher's "Connect another agent": at the connect form, once.
  const opening = settingsAt()
  setSettingsAt(undefined)
  onMount(() => {
    dialog.showModal()
    if (opening === "connect") dialog.querySelector(".disclosure")?.scrollIntoView({ block: "start" })
  })
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
        <h2 id="settings-title">Settings</h2>
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
        {/* Connected: that is the answer. Another agent is one quiet step away. */}
        <div class="dialog-connected">
          <p class="dialog-status" data-status="online">
            <span class="dot" />
            <ServerName url={"url" in c() ? (c() as { url: string }).url : ""} version={c().status === "online" ? (c() as { version: string }).version : ""} />
          </p>
          <button
            class="btn"
            title="Stops using it. It stays under “Connected before”, to go back to"
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
        <details class="disclosure" open={opening === "connect"}>
          <summary>
            <Icon name="right" class="caret" />
            Connect another agent
          </summary>
          <ConnectForm onDone={() => dialog.close()} />
        </details>
      </Show>
      <Preferences />
      <Show when={c().status === "offline" || c().status === "connecting"}>
        <footer class="dialog-foot">
          <p>Disconnecting stops using {serverLabel("url" in c() ? (c() as { url: string }).url : "")}. It stays under “Connected before”.</p>
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
