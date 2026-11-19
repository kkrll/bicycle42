// "This page on this phone": the column beside a phone's page in a mode with no dock (Preview,
// Annotate). What the page is at this phone's size, each row tied to the element it is about,
// and under that the files the agent changed.
//
// The facts are the overlay's (overlay/src/facts/host.js; FactsView in overlay/protocol-facts.ts),
// worked out only while this pane is up: it says "view" when it appears and "stop" when it goes,
// and "view" again when a new page says it works nothing out (a view of null). Like a dock it
// keeps nothing of the page's: it draws what it is told, as text.
import { For, Show, createEffect, on, onCleanup, onMount } from "solid-js"
import type { FactItem, FactList, FactsAct } from "../../../overlay/protocol-facts"
import type { ReviewMode } from "../shared/types"
import { Counts } from "./chat"
import { Icon, Kbd, type IconName } from "./icons"
import { dockAct, dockViews, keys, state } from "./store"
import "./facts-pane.css"

const send = (act: FactsAct) => dockAct({ panel: "facts", act })

const MODE: Record<ReviewMode, { label: string; icon: IconName }> = {
  preview: { label: "Preview", icon: "eye" },
  notes: { label: "Annotate", icon: "note" },
  edit: { label: "Edit", icon: "frame" },
  motion: { label: "Motion", icon: "motion" },
}

const n = (x: number) => Math.round(x).toLocaleString("en-US")
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path

export function FactsPane() {
  const view = () => dockViews.facts ?? null
  const mode = () => (state.review.enabled ? state.review.mode : "preview")
  const annotate = () => mode() === "notes"
  const changes = () => state.repo?.changes ?? []
  const clear = () => {
    const v = view()
    return !!v && v.wide.total + v.taps.total + v.small.total === 0
  }

  // Wanted while shown; and again when the page is new (its overlay works nothing out yet).
  onMount(() => send({ type: "view" }))
  createEffect(on(() => dockViews.facts === null, (fresh) => fresh && send({ type: "view" }), { defer: true }))
  onCleanup(() => {
    send({ type: "hover", id: null })
    send({ type: "stop" })
  })

  return (
    <section class="dock fp" data-dock="facts" aria-label="This page on this phone">
      <header class="fp-head">
        <Icon name={MODE[mode()].icon} />
        <span class="fp-title">{MODE[mode()].label}</span>
        <span class="fp-lead">This page on this phone</span>
      </header>
      <div class="fp-body">
        <div class="fp-col">
          <Show when={view()} fallback={<p class="fp-line fp-quiet">Looking at the page…</p>}>
            {(v) => (
              <>
                <p class="fp-line fp-sum">
                  <span>
                    {n(v().viewport.w)} × {n(v().viewport.h)} · page is {n(v().doc.h)} tall
                  </span>
                  <Show when={v().doc.w > v().viewport.w + 1}>
                    <span class="fp-warn">scrolls sideways: {n(v().doc.w)} wide</span>
                  </Show>
                </p>
                <Show when={!v().meta}>
                  <p class="fp-line fp-warn">No viewport tag: a phone lays this page out about 980 wide and zooms out.</p>
                </Show>
                <Show
                  when={!clear()}
                  fallback={
                    <p class="fp-line fp-ok">
                      <Icon name="check" />
                      Fits this phone: nothing sticks out, taps are 44 px or more, no field zooms.
                    </p>
                  }
                >
                  <Facts title="Sticks out past the screen" list={v().wide} annotate={annotate()} />
                  <Facts title="Tap targets under 44 px" list={v().taps} annotate={annotate()} />
                  <Facts title="Inputs that zoom on iOS (text under 16 px)" list={v().small} annotate={annotate()} />
                </Show>
                <Show when={v().partial}>
                  <p class="fp-line fp-quiet">A large page: these are from its first few thousand elements.</p>
                </Show>
              </>
            )}
          </Show>
          <Show when={changes().length > 0}>
            <section class="fp-sec" aria-label="Changed files">
              <h3 class="fp-h">Changed files</h3>
              <ul class="fp-rows">
                <For each={changes()}>
                  {(f) => (
                    <li class="fp-row fp-file" title={f.file}>
                      <bdi class="fp-label">{fileName(f.file)}</bdi>
                      <Counts additions={f.additions} deletions={f.deletions} />
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </div>
      </div>
      <footer class="fp-foot">
        Hold <Kbd keys={keys("alt", "A")} /> to look under the layer · <Kbd keys={keys("mod", "shift", "P")} /> to draw
      </footer>
    </section>
  )
}

/** One kind of fact, only when there is some: a heading and a row for each element. */
function Facts(props: { title: string; list: FactList; annotate: boolean }) {
  return (
    <Show when={props.list.total > 0}>
      <section class="fp-sec" aria-label={props.title}>
        <h3 class="fp-h">
          {props.title}
          <span class="fp-count">{props.list.total}</span>
        </h3>
        <ul class="fp-rows">
          <For each={props.list.items}>{(it) => <Row item={it} annotate={props.annotate} />}</For>
        </ul>
        <Show when={props.list.total > props.list.items.length}>
          <p class="fp-more">and {props.list.total - props.list.items.length} more</p>
        </Show>
      </section>
    </Show>
  )
}

/** A row: the pointer on it outlines its element on the page, a click brings it into view, and in
 *  Annotate "Note" makes it the note's selection. */
function Row(props: { item: FactItem; annotate: boolean }) {
  return (
    <li
      class="fp-row fp-fact"
      onPointerEnter={() => send({ type: "hover", id: props.item.id })}
      onPointerLeave={() => send({ type: "hover", id: null })}
    >
      <button type="button" class="fp-hit" title={`${props.item.label}: show it on the page`} onClick={() => send({ type: "show", id: props.item.id })}>
        <span class="fp-label">{props.item.label}</span>
        <span class="fp-detail">{props.item.detail}</span>
      </button>
      <Show when={props.annotate}>
        <button type="button" class="fp-note" title="Write a note about it" onClick={() => send({ type: "note", id: props.item.id })}>
          Note
        </button>
      </Show>
    </li>
  )
}
