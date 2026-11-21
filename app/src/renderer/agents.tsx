// The agent in use, as the window shows it: its mark and name, where it runs, the repo's path
// as a person reads it, and the list that switches to another agent from the panel's top row.
import { For, Show, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import type { AgentKind, Harness, LocalAgent, ServerInfo } from "../shared/types"
import { AgentMark, Icon } from "./icons"
import { atHome, middleCut } from "./paths"
import { b42, host, message, state } from "./store"

/** "this computer", or the server's address: where the agent works. */
export const whereOf = (h: { here: boolean; host?: string }) => (h.here ? "this computer" : (h.host ?? "another computer"))

/** The agent in use, or what the window can say of it before main has: its address. */
export function harnessNow(): Harness | undefined {
  if (state.harness) return state.harness
  return "url" in state.connection ? { kind: state.connection.url.startsWith("acp://") ? "custom" : "opencode-server", name: state.serverName || host(state.connection.url), here: /^acp:\/\/[^@]*$/.test(state.connection.url) } : undefined
}

/** Whether `state.home` is the home folder of the computer the agent works on: this computer, or
 *  another one whose agent the app runs over ssh (an OpenCode server elsewhere says none). */
export const ownHome = (h: Harness | undefined) => !!h && (h.here || (!!h.host && h.kind !== "opencode-server"))

/** A path with its computer's home folder as "~", where that home is known (`ownHome`); another
 *  computer's as it is. */
export const homePath = (path: string, here: boolean | undefined) => (here ? atHome(path, state.home) : path)

/** A known agent's name and mark, for an agent that is not one of the saved servers yet. */
const KNOWN: AgentKind[] = ["claude", "codex", "gemini", "opencode"]
export const kindOfAgent = (id: string): AgentKind => (KNOWN.includes(id as AgentKind) ? (id as AgentKind) : "custom")

let measure: CanvasRenderingContext2D | null | undefined

/** A path cut in the middle when its room is too short (middleCut). The room is the element's
 *  own as a flex item that may shrink; it is measured again whenever the row named by
 *  `[data-fit]` around it (or its parent) changes size. */
export function MiddlePath(props: { path: string; class?: string }) {
  let el!: HTMLSpanElement
  const fit = () => {
    const full = props.path
    el.textContent = full
    if (el.scrollWidth <= el.clientWidth + 0.5 || !el.clientWidth) return
    measure ??= document.createElement("canvas").getContext("2d")
    if (!measure) return
    measure.font = getComputedStyle(el).font
    el.textContent = middleCut(full, el.clientWidth, (t) => measure!.measureText(t).width)
  }
  onMount(() => {
    const ro = new ResizeObserver(() => fit())
    ro.observe(el.closest("[data-fit]") ?? el.parentElement ?? el)
    onCleanup(() => ro.disconnect())
  })
  // A new path is fitted at once, not at the next resize.
  createEffect(on(() => props.path, () => fit()))
  return <span class={props.class} ref={el} />
}

/** One row of the switcher: a saved server or agent, or a known agent not used yet (`fresh`). */
type Choice = { key: string; kind: AgentKind; name: string; where: string; current: boolean; fresh?: true; go: () => Promise<unknown> }

/** The agents and servers to switch to, the one in use first, then those connected to before,
 *  then the agents installed here that were never started. Behind the agent's name in the
 *  panel's top row; "Connect another" opens the settings at the connect form. */
export function AgentSwitch(props: { anchor: () => HTMLElement | undefined; onClose: () => void; onConnect: () => void }) {
  const [servers] = createResource(() => b42.invoke("servers").catch(() => [] as ServerInfo[]))
  const [agents] = createResource(() => b42.invoke("localAgents").catch(() => [] as LocalAgent[]))
  const [busy, setBusy] = createSignal("")
  const [error, setError] = createSignal("")
  let pop!: HTMLDivElement

  const choices = (): Choice[] => {
    const saved = servers() ?? []
    const out: Choice[] = saved.map((s) => ({
      key: s.id,
      kind: s.kind,
      name: s.name ?? (s.local ? "OpenCode server" : s.agent ? s.agent : host(s.url)),
      where: s.here ? "this computer" : (s.host ?? host(s.url)),
      current: s.current && state.connection.status !== "unconfigured",
      go: () => b42.invoke("useServer", s.id),
    }))
    for (const a of agents() ?? [])
      if (a.installed && !saved.some((s) => s.agent === a.id && !s.host))
        out.push({ key: `agent:${a.id}`, kind: kindOfAgent(a.id), name: a.name, where: a.signIn ? "sign in first" : "this computer", current: false, fresh: true, go: () => b42.invoke("connectAgent", { id: a.id }) })
    return out
  }
  const pick = (c: Choice) => {
    if (c.current) return props.onClose()
    if (busy()) return
    setBusy(c.key)
    setError("")
    c.go()
      .then(() => props.onClose())
      .catch((err) => setError(message(err)))
      .finally(() => setBusy(""))
  }
  const items = () => [...pop.querySelectorAll<HTMLElement>("[role=menuitemradio], [role=menuitem]")]
  const step = (by: number) => {
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLElement)
    all[(at + by + all.length) % all.length]?.focus()
  }
  const outside = (e: PointerEvent) => {
    const t = e.target as Node
    if (!pop.contains(t) && !props.anchor()?.contains(t)) props.onClose()
  }
  onMount(() => {
    document.addEventListener("pointerdown", outside)
    queueMicrotask(() => (pop.querySelector<HTMLElement>("[aria-checked=true]") ?? items()[0])?.focus())
  })
  onCleanup(() => document.removeEventListener("pointerdown", outside))

  return (
    <div
      class="agent-pop"
      role="menu"
      aria-label="Switch agent"
      ref={pop}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") step(1)
        else if (e.key === "ArrowUp") step(-1)
        else if (e.key === "Escape") {
          props.onClose()
          props.anchor()?.focus()
        } else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <Show
        when={!servers.loading || servers()}
        fallback={
          <p class="quiet agent-pop-wait">
            <Icon name="spinner" /> Looking for agents
          </p>
        }
      >
        <For each={choices()}>
          {(c, i) => (
            <>
              {/* The agents never started here come after a rule: starting one is new. */}
              <Show when={c.fresh && i() > 0 && !choices()[i() - 1]?.fresh}>
                <div class="agent-pop-rule" />
              </Show>
              <button
                class="agent-pop-row"
                role="menuitemradio"
                aria-checked={c.current}
                data-choice={c.key}
                disabled={!!busy() && busy() !== c.key}
                title={c.fresh ? `Start ${c.name} on this computer` : `${c.name} on ${c.where}`}
                onClick={() => pick(c)}
              >
                <AgentMark kind={c.kind} />
                <span class="agent-pop-name">{c.name}</span>
                <span class="agent-pop-where">{c.where}</span>
                <Show
                  when={busy() === c.key}
                  fallback={
                    <Show when={c.current}>
                      <Icon name="check" class="agent-pop-on" />
                    </Show>
                  }
                >
                  <Icon name="spinner" />
                </Show>
              </button>
            </>
          )}
        </For>
      </Show>
      <Show when={error()}>
        <p class="form-error agent-pop-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="agent-pop-rule" />
      <button class="agent-pop-row" role="menuitem" data-action="connect-another" onClick={props.onConnect}>
        <Icon name="plus" />
        <span class="agent-pop-name">Connect another agent</span>
      </button>
    </div>
  )
}
