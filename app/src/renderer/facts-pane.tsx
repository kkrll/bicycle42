// "This page on this phone": the column beside a phone's page in a mode with no dock (Preview,
// Annotate). What the page is at this phone's size, each row tied to the element it is about, and
// beside or under that the files the agent changed. In Edit and Motion the column is the mode's
// dock and nothing else.
//
// The pane's header is the phone line (PhoneLine): how many of each fact, each count a button
// (the pointer on it marks that kind on the page, a click goes to the next one), and the Marks
// switch at its right. The body says each fact once: no phone size (the picker above the phone
// says it), no counts in the headings (the line's counts say them, its dots are the legend), and
// "Fits this phone" only in the line.
//
// The facts are the overlay's (overlay/src/facts/host.js; FactsView in overlay/protocol-facts.ts),
// worked out only while the pane shows them: it says it wants them (wantFacts), and the window
// says "view" when it appears and "stop" when it goes, once the mounts and unmounts of a mode
// change have settled (Preview to Annotate is no stop and view). "view" again when a new page says
// it works nothing out (a view of null). Every listed element is marked on the page only while the
// reviewer has the marks on (factsMarks, off until turned on): the page in Preview is the page.
// Like a dock it keeps nothing of the page's: it draws what it is told, as text.
import { For, Match, Show, Switch, createEffect, createMemo, createRoot, createSignal, on, onCleanup, onMount } from "solid-js"
import type { FactItem, FactKind, FactList, FactsAct, FactsView } from "../../../overlay/protocol-facts"
import { Counts } from "./chat"
import { Toggle } from "./connect"
import { Icon, Kbd } from "./icons"
import { dockAct, dockViews, factsMarks, keys, setFactsMarks, state } from "./store"
import "./facts-pane.css"

const send = (act: FactsAct) => dockAct({ panel: "facts", act })

// ── who wants the facts ──────────────────────────────────────────────────────────────────────────
/** Each mounted pane: whether it wants the marks on the page. */
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
    if (want && !told.want) {
      send({ type: "view", marks })
      // A window that has no view (it is new, and what the overlay sent went to the one before
      // it) asks for it: a page that is as it was is not said again by itself.
      if (dockViews.facts === undefined) dockAct({ panel: "facts", act: { type: "whole" } })
    }
    else if (!want && told.want) {
      send({ type: "hover", id: null })
      send({ type: "kind", kind: null })
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

type Kind = FactKind
const KINDS = ["wide", "taps", "small"] as const
/** A kind's tone, as the overlay marks its elements on the page (.box.fx.k-* in overlay/src/styles.css). */
const Dot = (props: { kind: Kind }) => <span class={`fp-dot fp-dot-${props.kind}`} aria-hidden="true" />

// ── the pane ─────────────────────────────────────────────────────────────────────────────────────
const LIT_MS = 1400

export function FactsPane() {
  const view = () => dockViews.facts ?? null
  const annotate = () => state.review.enabled && state.review.mode === "notes"
  const changes = () => state.repo?.changes ?? []
  onCleanup(() => send({ type: "hover", id: null }))
  // The row of the element a count's click went to: brought into the pane's view, lit a moment.
  let body!: HTMLDivElement
  const [lit, setLit] = createSignal(0)
  let litTimer = 0
  const go = (id: number) => {
    setLit(id)
    clearTimeout(litTimer)
    litTimer = window.setTimeout(() => setLit(0), LIT_MS)
    body.querySelector(`[data-fact="${id}"]`)?.scrollIntoView({ block: "nearest" })
  }
  onCleanup(() => clearTimeout(litTimer))

  return (
    <section class="dock fp" data-dock="facts" aria-label="This page on this phone">
      <PhoneLine onGo={go} />
      <div class="fp-body" ref={body}>
        {/* What the page is, across the pane; then the lists, and beside or under them the files. */}
        <Show when={view()} fallback={<p class="fp-line fp-quiet">Looking at the page…</p>}>
          {(v) => (
            <>
              <p class="fp-line fp-sum">
                <span>
                  {n(v().doc.h)} px tall
                  <Show when={v().doc.w > v().viewport.w + 1}>
                    {" · "}
                    <span class="fp-warn">{n(v().doc.w)} px wide, scrolls sideways</span>
                  </Show>
                </span>
              </p>
              <Show when={!v().meta}>
                <p class="fp-line fp-warn">No viewport tag: a phone lays this page out about 980 wide and zooms out.</p>
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
                  <Facts kind="wide" title="Sticks out past the screen" list={v().wide} annotate={annotate()} lit={lit()} />
                  <Facts kind="taps" title="Tap targets under 44 px" list={v().taps} annotate={annotate()} lit={lit()} />
                  <Facts kind="small" title="Inputs that zoom on iOS (text under 16 px)" list={v().small} annotate={annotate()} lit={lit()} />
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
                        <Show when={!f.uncounted} fallback={<span class="counts repo-uncounted">{f.uncounted}</span>}>
                          <Counts additions={f.additions} deletions={f.deletions} />
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
                <Show when={(state.repo?.total ?? 0) > changes().length}>
                  <li class="fp-row repo-more">and {state.repo!.total - changes().length} more</li>
                </Show>
              </ul>
            </section>
          </Show>
        </div>
      </div>
      {/* The two keys worth knowing while annotating. In Preview there is no layer to look
          under and nothing to draw on: no line. */}
      <Show when={state.review.enabled}>
        <footer class="fp-foot">
          Hold <Kbd keys={keys("alt", "A")} /> to look under the layer · <Kbd keys={keys("mod", "shift", "P")} /> to draw
        </footer>
      </Show>
    </section>
  )
}

/** One kind of fact, only when there is some: a heading (its dot the tone of its marks on the
 *  page; how many is the line's to say) and a row for each element. */
function Facts(props: { kind: Kind; title: string; list: FactList; annotate: boolean; lit: number }) {
  return (
    <Show when={props.list.total > 0}>
      <section class="fp-sec" aria-label={props.title}>
        <h3 class="fp-h">
          <Dot kind={props.kind} />
          {props.title}
        </h3>
        <ul class="fp-rows">
          <For each={props.list.items}>{(it) => <Row item={it} annotate={props.annotate} lit={props.lit === it.id} />}</For>
        </ul>
        <Show when={props.list.total > props.list.items.length}>
          <p class="fp-more">and {props.list.total - props.list.items.length} more</p>
        </Show>
      </section>
    </Show>
  )
}

/** A row: the pointer on it outlines its element on the page, a click brings it into view, and in
 *  Annotate "Note" makes it the note's selection (shown on the row's hover and focus only). Its
 *  last cell is there on every row, Note or not, so every number ends at the same x. */
function Row(props: { item: FactItem; annotate: boolean; lit: boolean }) {
  return (
    <li
      class="fp-row fp-fact"
      classList={{ "fp-lit": props.lit }}
      data-fact={props.item.id}
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

// ── the phone line: the pane's header ────────────────────────────────────────────────────────────
/** A count's words, and the short ones for a narrow line ("5 taps"); narrower still, only the
 *  number beside its dot (a container query in facts-pane.css shows one of the three). */
const COUNT: Record<Kind, (k: number) => [long: string, short: string]> = {
  wide: (k) => [`${k} ${k === 1 ? "sticks" : "stick"} out`, `${k} out`],
  taps: (k) => [`${k} small ${k === 1 ? "tap" : "taps"}`, `${k} ${k === 1 ? "tap" : "taps"}`],
  small: (k) => [`${k} ${k === 1 ? "field zooms" : "fields zoom"}`, `${k} zoom`],
}

/** The element a count's click went to last, by kind: the next click goes to the one after it. */
const at: Partial<Record<Kind, number>> = {}
/** The listed element of a kind after the one gone to last (the first again after the last, or
 *  when that one is no longer listed). */
export function nextOf(items: readonly FactItem[], last: number | undefined): FactItem | undefined {
  const i = items.findIndex((it) => it.id === last)
  return items[(i + 1) % items.length]
}

/** The facts pane's header: how many of each fact, and the Marks switch. `onGo`: a count's click
 *  went to that element (the pane brings its row into view). */
export function PhoneLine(props: { onGo?: (id: number) => void }) {
  wantFacts(factsMarks)
  // The kind under the pointer or the focus: its elements are marked on the page while it is.
  let hot: Kind | null = null
  const point = (k: Kind | null) => {
    if (k === hot) return
    hot = k
    send({ type: "kind", kind: k })
  }
  onCleanup(() => hot && send({ type: "kind", kind: null }))
  const view = () => dockViews.facts ?? null
  const go = (k: Kind) => {
    const v = view()
    const it = v && nextOf(v[k].items, at[k])
    if (!it) return
    at[k] = it.id
    send({ type: "show", id: it.id })
    props.onGo?.(it.id)
  }
  // What the line says, and the kinds it counts: the same buttons while the same kinds are there
  // (a view comes with every scroll; a button under the pointer or with the focus stays).
  const says = () => {
    const v = view()
    return !v ? "looking" : !v.meta ? "no-meta" : total(v) === 0 ? "fits" : "counts"
  }
  const kinds = createMemo(() => KINDS.filter((k) => (view()?.[k].total ?? 0) > 0), undefined, { equals: (a, b) => a.join() === b.join() })

  return (
    <div class="pl" role="group" aria-label="This page on this phone">
      <div class="pl-facts">
        <Switch>
          <Match when={says() === "looking"}>
            <span class="pl-quiet">Looking at the page…</span>
          </Match>
          <Match when={says() === "no-meta"}>
            <span class="pl-warn" title="Without a viewport tag a phone lays this page out about 980 wide and zooms out.">
              <Icon name="alert" />
              <span class="pl-cut">No viewport tag: a phone lays this page out about 980 wide</span>
            </span>
          </Match>
          <Match when={says() === "fits"}>
            <span class="pl-ok" title="Nothing sticks out, taps are 44 px or more, no field zooms">
              <Icon name="check" />
              Fits this phone
            </span>
          </Match>
          <Match when={says() === "counts"}>
            <For each={kinds()}>
              {(k) => {
                const words = () => COUNT[k](view()?.[k].total ?? 0)
                return (
                  <button
                    type="button"
                    class="pl-count"
                    data-kind={k}
                    aria-label={`${words()[0]}: go to the next one`}
                    title={`${words()[0]}: point to mark them on the page, click to go to the next one`}
                    onPointerEnter={() => point(k)}
                    onPointerLeave={() => hot === k && point(null)}
                    onFocus={() => point(k)}
                    onBlur={() => hot === k && point(null)}
                    onClick={() => go(k)}
                  >
                    <Dot kind={k} />
                    <span class="pl-long">{words()[0]}</span>
                    <span class="pl-short" aria-hidden="true">
                      {words()[1]}
                    </span>
                    <span class="pl-num" aria-hidden="true">
                      {view()?.[k].total ?? 0}
                    </span>
                  </button>
                )
              }}
            </For>
          </Match>
        </Switch>
      </div>
      <Toggle class="pl-marks" on={factsMarks()} label="Marks" title="Outline everything listed here on the page" onClick={() => setFactsMarks(!factsMarks())} />
    </div>
  )
}
