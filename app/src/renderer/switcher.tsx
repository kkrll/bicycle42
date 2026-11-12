// The list behind "+": start a new conversation in this project, or open another project.
// Type to narrow, ↑/↓ to move, Enter to choose; the first nine projects also answer to mod+1…9.
// A project is a folder on the server (the repo). Opening one brings its site back as it was
// last open, or, when it has none yet, the step where a site is opened or started.
import { For, Match, Show, Switch, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { Icon, Kbd } from "./icons"
import { FolderPicker } from "./panel"
import { b42, keys, mac, message, state } from "./store"
import type { ProjectInfo } from "../shared/types"

/** "acme/storefront" from "/home/dev/code/acme/storefront": the part a person recognises. */
const tail = (path: string) => path.replace(/\/+$/, "").split("/").slice(-2).join("/") || "/"

type Row = { kind: "new" } | { kind: "project"; project: ProjectInfo; n?: number } | { kind: "path"; directory: string } | { kind: "browse" }

export function Switcher(props: { onClose: () => void }) {
  const [projects] = createResource(() => b42.invoke("allProjects"))
  const [query, setQuery] = createSignal("")
  const [at, setAt] = createSignal(0)
  const [browsing, setBrowsing] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  let dialog!: HTMLDialogElement
  let input!: HTMLInputElement
  let list: HTMLUListElement | undefined
  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())

  const current = () => state.site?.directory
  const rows = createMemo((): Row[] => {
    const q = query().trim().toLowerCase()
    // The open project first, the server's others in its own order (most recently used first),
    // then those of the servers connected to before. A server's name narrows the list too.
    const known = projects.error ? [] : (projects() ?? [])
    const found = known.filter((p) => !q || p.directory.toLowerCase().includes(q) || p.on.toLowerCase().includes(q))
    const typed = query().trim().replace(/(.)\/+$/, "$1")
    return [
      ...(state.session && (!q || "new conversation".includes(q)) ? [{ kind: "new" as const }] : []),
      ...found.map((project, i) => ({ kind: "project" as const, project, ...(i < 9 ? { n: i + 1 } : {}) })),
      // A folder the server has not worked in yet can be opened by its path.
      ...(typed.startsWith("/") && typed.length > 1 && !known.some((p) => !p.server && p.directory === typed) ? [{ kind: "path" as const, directory: typed }] : []),
      ...(!q || "browse folders".includes(q) ? [{ kind: "browse" as const }] : []),
    ]
  })
  const open = (directory: string) => b42.invoke("openProject", directory)
  const choose = (row: Row | undefined) => {
    if (!row || busy()) return
    if (row.kind === "browse") return void setBrowsing(true)
    setBusy(true)
    setError("")
    ;(row.kind === "new" ? b42.invoke("newSession") : row.kind === "project" ? b42.invoke("openProject", row.project.directory, row.project.server) : open(row.directory))
      .then(() => dialog.close())
      .catch((err) => {
        setError(message(err))
        setBusy(false)
        input.focus()
      })
  }
  const move = (by: number) => {
    const n = rows().length
    if (!n) return
    setAt((((at() + by) % n) + n) % n)
    list?.children[at()]?.scrollIntoView({ block: "nearest" })
  }
  const onKey = (e: KeyboardEvent) => {
    if (browsing()) return
    if (e.key === "ArrowDown") move(1)
    else if (e.key === "ArrowUp") move(-1)
    else if (e.key === "Enter") choose(rows()[at()])
    else if ((mac() ? e.metaKey : e.ctrlKey) && /^[1-9]$/.test(e.key)) choose(rows().find((r) => r.kind === "project" && r.n === Number(e.key)))
    else return
    e.preventDefault()
  }

  return (
    <dialog class="dialog switcher" ref={dialog} aria-label="New conversation, or another project" onClose={props.onClose} onClick={(e) => e.target === dialog && dialog.close()} onKeyDown={onKey}>
      <Show
        when={!browsing()}
        fallback={<FolderPicker browse open={open} onCancel={() => setBrowsing(false)} onDone={() => dialog.close()} />}
      >
        <div class="switcher-search">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="switcher-list"
            aria-label="Search projects, or type a folder's path"
            placeholder="Search projects, or type a path"
            spellcheck={false}
            autocomplete="off"
            autofocus
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setAt(0)
            }}
          />
        </div>
        <Show when={error()}>
          <p class="form-error">{error()}</p>
        </Show>
        <Switch>
          <Match when={projects.loading}>
            <p class="quiet">
              <Icon name="spinner" /> Looking for projects
            </p>
          </Match>
          <Match when={true}>
            <Show when={projects.error}>
              <p class="form-error">{message(projects.error)}</p>
            </Show>
            <ul class="rows switcher-rows" id="switcher-list" role="listbox" ref={list}>
              <For each={rows()}>
                {(row, i) => (
                  <li role="option" aria-selected={i() === at()}>
                    <button class="row" classList={{ on: i() === at() }} tabindex="-1" disabled={busy()} onPointerMove={() => setAt(i())} onClick={() => choose(row)}>
                      <Switch>
                        <Match when={row.kind === "new"}>
                          <Icon name="plus" />
                          <span class="row-main">New conversation</span>
                          <span class="row-sub plain">In {tail(current() ?? "")}</span>
                        </Match>
                        <Match when={row.kind === "project" && row}>
                          {(p) => (
                            <>
                              <Icon name="folder" />
                              <span class="row-main">
                                {tail(p().project.directory)}
                                <Show when={p().project.open}>
                                  <span class="row-tag">open</span>
                                </Show>
                              </span>
                              {/* Which computer, then where on it. A long path loses its start, not the folder's own name. */}
                              <span class="row-where" title={`${p().project.on} · ${p().project.directory}`}>
                                <Show when={p().project.on}>
                                  <span class="row-on">{p().project.on}</span>
                                </Show>
                                <span class="row-sub">
                                  <bdi>{p().project.directory}</bdi>
                                </span>
                              </span>
                              <Show when={p().n}>
                                <span class="row-key">
                                  <Kbd keys={keys("mod", String(p().n))} />
                                </span>
                              </Show>
                            </>
                          )}
                        </Match>
                        <Match when={row.kind === "path" && row}>
                          {(p) => (
                            <>
                              <Icon name="folder" />
                              <span class="row-main">Open this folder</span>
                              <span class="row-sub" title={p().directory}>
                                <bdi>{p().directory}</bdi>
                              </span>
                            </>
                          )}
                        </Match>
                        <Match when={row.kind === "browse"}>
                          <Icon name="folder" />
                          <span class="row-main">Browse folders</span>
                          <span class="row-sub plain">A project the server has not opened yet</span>
                        </Match>
                      </Switch>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={!rows().length}>
              <p class="quiet">Nothing matches. A path starting with / opens that folder.</p>
            </Show>
          </Match>
        </Switch>
        <footer class="switcher-keys">
          <span>
            <kbd>
              <Icon name="up" />
            </kbd>
            <kbd>
              <Icon name="down" />
            </kbd>{" "}
            Navigate
          </span>
          <span>
            <Kbd keys={keys("enter")} /> Select
          </span>
          <span>
            <Kbd keys="Esc" /> Close
          </span>
        </footer>
      </Show>
    </dialog>
  )
}
