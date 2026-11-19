// "This page on this phone": the column beside a phone's page in a mode with no dock (Preview,
// Annotate), and a line of it above the dock in a mode with one (Edit, Motion). What the page is
// at this phone's size, each row tied to the element it is about, and beside or under that the
// files the agent changed.
//
// The facts are the overlay's (overlay/src/facts/host.js; FactsView in overlay/protocol-facts.ts),
// worked out only while something here shows them: the pane and the strip each say they want
// them (wantFacts), and the window says "view" when the first one appears and "stop" when the
// last one goes, once the mounts and unmounts of a mode change have settled (so a switch from
// Preview to Edit is no stop and view). "view" again when a new page says it works nothing out (a
// view of null). With the pane, every listed element is marked on the page unless the reviewer
// turned the marks off (factsMarks); with the strip only, nothing is drawn on the page (the
// inspector draws its own outlines there). Like a dock it keeps nothing of the page's: it draws
// what it is told, as text.
import { For, Show, createEffect, createRoot, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import type { FactItem, FactList, FactsAct, FactsView } from "../../../overlay/protocol-facts"
import { Counts } from "./chat"
import { Icon, Kbd } from "./icons"
import { dockAct, dockViews, factsMarks, keys, setFactsMarks, state } from "./store"
import "./facts-pane.css"

const send = (act: FactsAct) => dockAct({ panel: "facts", act })

// ── who wants the facts ──────────────────────────────────────────────────────────────────────────
/** Each mounted pane or strip: whether it wants the marks on the page. */
const [wants, setWants] = createSignal<readonly (() => boolean)[]>([])
/** What the overlay was last told. */
const told = { want: false, marks: false }
let queued = false
/** Tell the overlay what is wanted now, after the current update (a mode change unmounts one
 *  wanter and mounts another: only the result counts). */
function sync(): void {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    const all = wants()
    const want = all.length > 0
    const marks = want && all.some((m) => m())
    if (want && !told.want) send({ type: "view", marks })
    else if (!want && told.want) {
      send({ type: "hover", id: null })
      send({ type: "stop" })
    } else if (want && marks !== told.marks) send({ type: "marks", on: marks })
    told.want = want
    told.marks = marks
  })
}
createRoot(() => {
  createEffect(() => {
    for (const m of wants()) m()
    sync()
  })
  // A new page's overlay works nothing out until asked again.
  createEffect(on(() => dockViews.facts === null, (fresh) => fresh && told.want && send({ type: "view", marks: told.marks }), { defer: true }))
})

/** While the calling component is mounted, the overlay works the facts out; `marks`: and marks
 *  each listed element on the page. */
function wantFacts(marks: () => boolean): void {
  onMount(() => setWants((w) => [...w, marks]))
  onCleanup(() => setWants((w) => w.filter((x) => x !== marks)))
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────
const n = (x: number) => Math.round(x).toLocaleString("en-US")
/** A path's last two segments: enough to tell two files of one name apart. */
const shortPath = (path: string) => path.split("/").filter(Boolean).slice(-2).join("/") || path
const total = (v: FactsView) => v.wide.total + v.taps.total + v.small.total

type Kind = "wide" | "taps" | "small"
/** A kind's tone, as the overlay marks its elements on the page (.box.fx.k-* in overlay/src/styles.css). */
const Dot = (props: { kind: Kind }) => <span class={`fp-dot fp-dot-${props.kind}`} aria-hidden="true" />

// ── the pane ─────────────────────────────────────────────────────────────────────────────────────
export function FactsPane() {
  wantFacts(factsMarks)
  const view = () => dockViews.facts ?? null
  const annotate = () => state.review.enabled && state.review.mode === "notes"
  const changes = () => state.repo?.changes ?? []
  const clear = () => {
    const v = view()
    return !!v && total(v) === 0
  }
  onCleanup(() => send({ type: "hover", id: null }))

  return (
    <section class="dock fp" data-dock="facts" aria-label="This page on this phone">
      <header class="fp-head">
        <h2 class="fp-title">This page on this phone</h2>
        <button
          type="button"
          class="icon-btn small fp-marks"
          aria-pressed={factsMarks()}
          aria-label="Mark them on the page"
          title={factsMarks() ? "Marks off" : "Mark them on the page"}
          onClick={() => setFactsMarks(!factsMarks())}
        >
          <Icon name="marks" />
        </button>
      </header>
      <div class="fp-body">
        {/* What the page is, across the pane; then the lists, and beside or under them the files. */}
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
              <Show when={clear()}>
                <p class="fp-line fp-ok">
                  <Icon name="check" />
                  Fits this phone: nothing sticks out, taps are 44 px or more, no field zooms.
                </p>
              </Show>
              <Show when={v().partial}>
                <p class="fp-line fp-quiet">A large page: these are from its first few thousand elements.</p>
              </Show>
            </>
          )}
        </Show>
        <div class="fp-cols">
          <div class="fp-col">
            <Show when={view()}>
              {(v) => (
                <>
                  <Facts kind="wide" title="Sticks out past the screen" list={v().wide} annotate={annotate()} />
                  <Facts kind="taps" title="Tap targets under 44 px" list={v().taps} annotate={annotate()} />
                  <Facts kind="small" title="Inputs that zoom on iOS (text under 16 px)" list={v().small} annotate={annotate()} />
                </>
              )}
            </Show>
          </div>
          <Show when={changes().length > 0}>
            <section class="fp-col fp-sec fp-files" aria-label="Changed files">
              <h3 class="fp-h">Changed files</h3>
              <ul class="fp-rows">
                <For each={changes()}>
                  {(f) => (
                    <li class="fp-row fp-file" title={f.file}>
                      <span class="fp-cells">
                        <bdi class="fp-label">{shortPath(f.file)}</bdi>
                        <Counts additions={f.additions} deletions={f.deletions} />
                      </span>
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

/** One kind of fact, only when there is some: a heading (its dot the tone of its marks on the
 *  page) and a row for each element. */
function Facts(props: { kind: Kind; title: string; list: FactList; annotate: boolean }) {
  return (
    <Show when={props.list.total > 0}>
      <section class="fp-sec" aria-label={props.title}>
        <h3 class="fp-h">
          <Dot kind={props.kind} />
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
 *  Annotate "Note" makes it the note's selection. Its last cell is there on every row, Note or
 *  not, so every number ends at the same x. */
function Row(props: { item: FactItem; annotate: boolean }) {
  return (
    <li
      class="fp-row fp-fact"
      onPointerEnter={() => send({ type: "hover", id: props.item.id })}
      onPointerLeave={() => send({ type: "hover", id: null })}
    >
      <button type="button" class="fp-cells fp-hit" title={`${props.item.label}: show it on the page`} onClick={() => send({ type: "show", id: props.item.id })}>
        <span class="fp-label">{props.item.label}</span>
        <span class="fp-detail">{props.item.detail}</span>
      </button>
      <span class="fp-slot">
        <Show when={props.annotate}>
          <button type="button" class="btn fp-note" title="Write a note about it" onClick={() => send({ type: "note", id: props.item.id })}>
            Note
          </button>
        </Show>
      </span>
    </li>
  )
}

// ── the strip above a dock ───────────────────────────────────────────────────────────────────────
const COUNT: Record<Kind, (k: number) => string> = {
  wide: (k) => `${k} ${k === 1 ? "sticks" : "stick"} out`,
  taps: (k) => `${k} small ${k === 1 ? "tap" : "taps"}`,
  small: (k) => `${k} ${k === 1 ? "field zooms" : "fields zoom"}`,
}

/** One line above Edit's or Motion's dock beside a phone's page: how many of each fact, live (an
 *  edit that fixes a tap target changes it). No marks on the page. */
export function FactsStrip() {
  wantFacts(() => false)
  const line = (v: FactsView): JSX.Element => {
    if (!v.meta)
      return (
        <span class="fs-warn" title="Without a viewport tag a phone lays this page out about 980 wide and zooms out.">
          <Icon name="alert" />
          <span>No viewport tag: a phone lays this page out about 980 wide</span>
        </span>
      )
    if (total(v) === 0)
      return (
        <span class="fs-ok">
          <Icon name="check" />
          Fits this phone
        </span>
      )
    const kinds = (["wide", "taps", "small"] as const).filter((k) => v[k].total > 0)
    return (
      <>
        <span class="fs-lead">On this phone:</span>
        <For each={kinds}>
          {(k, i) => (
            <>
              {" "}
              <Show when={i() > 0}>
                <span class="fs-sep" aria-hidden="true">
                  ·
                </span>{" "}
              </Show>
              <span class="fs-count" data-kind={k}>
                <Dot kind={k} />
                {COUNT[k](v[k].total)}
              </span>
            </>
          )}
        </For>
      </>
    )
  }
  return (
    <div class="fs" title="This page on this phone">
      {dockViews.facts ? line(dockViews.facts) : <span class="fs-quiet">On this phone: looking at the page…</span>}
    </div>
  )
}
