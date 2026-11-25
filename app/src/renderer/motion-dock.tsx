// Motion mode's dock, drawn by the window (dock.tsx): the list of what moves on the page, and the
// open animation: its header (Keyframes | CSS, timing, how it plays while looking, undo), its
// timeline (the ruler and playhead, a lane of keyframes per property), the selected keyframe, the
// note and Send. It is motion mode's only dock (the overlay draws none of its own), drawn here so
// it can sit beside a phone-width page; the overlay keeps everything that touches the page.
//
// What it shows is the overlay's view (MotionView in overlay/protocol-motion.ts: whole the first
// time, then the fields of it that changed, which the store puts into the one it keeps); what
// the reviewer does goes back as acts (MotionAct). It keeps nothing of the page's.
// What it does keep, it keeps only while the reviewer's hand is on it, so the window never waits
// on the page:
//  - a field being typed in shows what is typed, not what the view says, until it is left and the
//    view has caught up (Field);
//  - a keyframe being dragged, a delay being dragged and the playhead being scrubbed are drawn
//    where the pointer is, and the view takes over again once it agrees or soon after they are let
//    go (`drag`, `late`, `scrub`).
// Popovers (the "more" sheet, the easings, a field's list) stay inside the dock's own box: the
// page is a native view that paints over the window wherever it sits, so anything over it would
// be hidden.
import "./motion-dock.css"
import { For, Show, createContext, createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup, onMount, untrack, useContext, type JSX, type Owner } from "solid-js"
import type { MotionAct, MotionKind, MotionLane, MotionOpen, MotionRow, MotionView } from "../../../overlay/protocol-motion"
import { Icon } from "./icons"
import { NOTE_OPTIONAL, dockAct, dockPing, dockViews, keys, mac, nextNoteNumber } from "./store"

const send = (act: MotionAct) => dockAct({ panel: "motion", act })
const view = () => dockViews.motion as MotionView | undefined
const isMod = (e: KeyboardEvent | PointerEvent | MouseEvent) => (mac() ? e.metaKey : e.ctrlKey)
const secs = (n: number) => `${+(n / 1000).toFixed(2)}s`
/** How long a local value (a field left, a key let go) is shown before the view's, at most. */
const HOLD_MS = 600
/** The ruler's marks: the largest step that gives at most seven, a fifth of it between. */
const MAJOR = [50, 100, 200, 250, 500, 1000, 2000, 5000]

// ── drawings ────────────────────────────────────────────────────────────────────────────────────

/** The few icons the dock needs that the window's own set (icons.tsx) has no use for elsewhere.
 *  The same 24 grid and stroke. */
const MPATHS = {
  play: "M7.5 4.8v14.4L18.75 12z",
  pause: "M8.25 5.25v13.5M15.75 5.25v13.5",
  loop: "M4.5 11.25V10.5a4.5 4.5 0 0 1 4.5-4.5h10.5M16.5 3l3 3-3 3M19.5 12.75v.75a4.5 4.5 0 0 1-4.5 4.5H4.5M7.5 21l-3-3 3-3",
  undo: "M9 5.25 4.5 9.75l4.5 4.5M4.5 9.75h9.375a4.875 4.875 0 0 1 0 9.75H10.5",
  more: "M5.25 12h.01M12 12h.01M18.75 12h.01",
  solo: "M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M9.5 9.5h5v5h-5z",
  link: "M10.5 13.5a3.75 3.75 0 0 0 5.25 0l3-3A3.75 3.75 0 0 0 13.5 5.25l-.75.75M13.5 10.5a3.75 3.75 0 0 0-5.25 0l-3 3a3.75 3.75 0 0 0 5.25 5.25l.75-.75",
} as const

function MIcon(props: { name: keyof typeof MPATHS }) {
  return (
    <svg
      class="icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={props.name === "play" ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={props.name === "more" ? 3 : 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={MPATHS[props.name]} />
    </svg>
  )
}

const KIND_TITLE: Record<MotionKind, string> = {
  css: "Keyframes",
  unused: "Keyframes nothing plays",
  transition: "Transition",
  script: "Script (animate())",
  frames: "Moved by a script, frame by frame",
}

/** What kind of motion a row is, as the overlay draws it: a keyframe animation is a ball leaving
 *  echoes; a transition goes from one state to another; a script's ball is in braces; frame by
 *  frame is three discrete steps; keyframes nothing plays are the ball as an outline. */
function KindIcon(props: { kind: MotionKind }) {
  const trail = () => (
    <>
      <rect x="6" y="9" width="12" height="1" rx="0.5" fill="currentColor" />
      <rect x="3.5" y="11.5" width="12" height="1" rx="0.5" fill="currentColor" />
      <rect x="6" y="14" width="12" height="1" rx="0.5" fill="currentColor" />
      <path d="M10 17.3A6.2 6.2 0 0 1 7.12 18C3.74 18 1 15.31 1 12s2.74-6 6.12-6c1.04 0 2.02.25 2.88.7" stroke="currentColor" />
      <path d="M15 17.3c-.86.45-1.84.7-2.88.7-1.81 0-3.44-.77-4.56-2M15 6.7A6.2 6.2 0 0 0 12.13 6c-1.81 0-3.44.77-4.56 2" stroke="currentColor" />
    </>
  )
  return (
    <svg class="mdock-kind" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {props.kind === "css" || props.kind === "unused" ? (
        <>
          {trail()}
          <circle cx="18" cy="12" r="5.5" class={props.kind === "unused" ? "hollow" : "solid"} stroke="currentColor" />
        </>
      ) : props.kind === "transition" ? (
        <>
          <circle cx="7.5" cy="12" r="5.5" stroke="currentColor" />
          <circle cx="16.5" cy="12" r="5.5" class="solid" stroke="currentColor" />
        </>
      ) : props.kind === "script" ? (
        <>
          <path
            d="M6 5.5c-1.7 0-2.5.8-2.5 2.5v1.5c0 1.3-.7 2.5-2 2.5 1.3 0 2 1.2 2 2.5V16c0 1.7.8 2.5 2.5 2.5M18 5.5c1.7 0 2.5.8 2.5 2.5v1.5c0 1.3.7 2.5 2 2.5-1.3 0-2 1.2-2 2.5V16c0 1.7-.8 2.5-2.5 2.5"
            stroke="currentColor"
            stroke-linecap="round"
          />
          <circle cx="12" cy="12" r="4" class="solid" />
        </>
      ) : (
        <>
          <circle cx="4.5" cy="12" r="3" stroke="currentColor" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" />
          <circle cx="19.5" cy="12" r="3" class="solid" stroke="currentColor" />
        </>
      )}
    </svg>
  )
}

/** An easing as a curve, sampled from the window's own browser (the page's is the same Chromium),
 *  so steps() and linear() draw as they are. Points in a 100 by 100 box. */
const CURVES = new Map<string, string>()
function curvePoints(easing: string): string {
  let pts = CURVES.get(easing)
  if (pts !== undefined) return pts
  try {
    const fx = new KeyframeEffect(null, null, { duration: 100, easing, fill: "both" })
    const a = new Animation(fx, document.timeline)
    a.pause()
    const out: string[] = []
    for (let i = 0; i <= 30; i++) {
      a.currentTime = (i / 30) * 99.999
      out.push(`${(18 + (i / 30) * 64).toFixed(1)},${(82 - (fx.getComputedTiming().progress ?? 0) * 64).toFixed(1)}`)
    }
    a.cancel()
    pts = out.join(" ")
  } catch {
    pts = ""
  }
  if (CURVES.size > 200) CURVES.clear()
  CURVES.set(easing, pts)
  return pts
}
function Curve(props: { easing: string }) {
  return (
    <svg class="mdock-cv" viewBox="0 0 100 100" aria-hidden="true">
      <polyline points={curvePoints(props.easing)} />
    </svg>
  )
}

// ── popovers, inside the dock's box ─────────────────────────────────────────────────────────────

// The dock has one popover at a time, drawn in one place (MotionDock), and a component opens its
// own through usePop. Its body is made as a child of the component that opened it (`owner`), not
// of the place it is drawn in: it reads what that component reads (a <Show>'s value, which may be
// read only by what the <Show> owns), so it has to go when that component goes, and before
// anything of it is worked out again. The component going closes it.
type Pop = { anchor: HTMLElement; kind: "more" | "ease" | "list"; body: () => JSX.Element; wide?: boolean }
type Opened = Pop & { by: object; owner: Owner | null }
const PopContext = createContext<{ open(p: Opened | null): void; current(): Opened | null }>()
/** A component's own popover: opened, closed (when it is the one that is up), pressed again. */
function usePop() {
  const ctx = useContext(PopContext)!
  // (Components drawn by one computation have one owner between them: `by` says which opened it.)
  const by = {}, owner = getOwner()
  const mine = () => untrack(ctx.current)?.by === by
  const open = (p: Pop) => ctx.open({ ...p, by, owner })
  const close = () => void (mine() && ctx.open(null))
  onCleanup(close)
  return { open, close, toggle: (p: Pop) => (mine() ? ctx.open(null) : open(p)) }
}

// ── a field ─────────────────────────────────────────────────────────────────────────────────────

/** A text field of the dock. While it has the caret it shows what is typed, never the view; typed
 *  values that `ok` takes go to the page as they are typed (`onInput`), and once it is left
 *  (Enter, Esc, elsewhere) the last goes as done (`onDone`). What was typed stays shown until the
 *  view says the same, or for a moment; a value `ok` does not take is dropped for the view's.
 *  With `list`, it offers values in the dock's own list (↑/↓, Enter, a click). */
function Field(props: {
  value: string
  class?: string
  placeholder?: string
  disabled?: boolean
  label?: string
  title?: string
  ok?: (v: string) => boolean
  onInput?: (v: string) => void
  onDone?: (v: string) => void
  onEsc?: () => void
  list?: () => string[]
  curves?: boolean
  inputmode?: "numeric" | "decimal"
  attr?: string
  /** A field that empties itself once done (a new lane's name): no value is held after it. */
  clears?: boolean
}) {
  const pop = usePop()
  const [local, setLocal] = createSignal<string | null>(null)
  const [focused, setFocused] = createSignal(false)
  const [bad, setBad] = createSignal(false)
  const [mark, setMark] = createSignal(-1)
  const [typed, setTyped] = createSignal(false)
  let el!: HTMLInputElement
  let till = 0
  /** The value when the caret came in. The view follows what is typed (onInput), so whether
   *  anything changed is asked of this, not of the view. */
  let atFocus = ""
  const ok = (v: string) => (props.ok ? props.ok(v) : true)
  // A field the view took away while it had the caret hears a blur as it is removed. By then it
  // is the field of nothing: what it would ask about (`ok`, `onDone`) may be gone with it.
  let gone = false
  onCleanup(() => (gone = true))
  // Held after it is left: until the view agrees, or the moment is over.
  createEffect(() => {
    const v = local()
    if (v !== null && !focused() && (v === props.value || props.clears)) setLocal(null)
  })
  const items = createMemo(() => {
    if (!props.list || !focused()) return []
    const all = props.list()
    const q = typed() ? (local() ?? "").trim().toLowerCase() : ""
    const out = q ? [...all.filter((x) => x.toLowerCase().startsWith(q)), ...all.filter((x) => !x.toLowerCase().startsWith(q) && x.toLowerCase().includes(q))] : all
    return out.length === 1 && out[0] === (local() ?? props.value).trim() ? [] : out
  })
  createEffect(() => {
    const list = items()
    if (!list.length || props.disabled) return pop.close()
    pop.open({
      anchor: el,
      kind: "list",
      wide: props.curves,
      body: () => (
        <div class="mdock-sug" role="listbox">
          <For each={items()}>
            {(x, i) => (
              <div
                class="mdock-sg"
                classList={{ on: i() === mark() }}
                role="option"
                aria-selected={i() === mark()}
                ref={(o) => createEffect(() => i() === mark() && o.scrollIntoView({ block: "nearest" }))}
                // A press in the list keeps the caret in the field; a click picks.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(x)}
              >
                <Show when={props.curves}>
                  <Curve easing={x} />
                </Show>
                <span>{x}</span>
              </div>
            )}
          </For>
        </div>
      ),
    })
  })
  const done = (v: string) => {
    if (ok(v)) {
      if (v !== atFocus || props.clears) props.onDone?.(v)
      till = performance.now() + HOLD_MS
      setTimeout(() => performance.now() >= till && !focused() && setLocal(null), HOLD_MS)
    } else setLocal(null)
    setBad(false)
  }
  const pick = (x: string) => {
    setLocal(x)
    el.value = x
    setBad(false)
    if (props.clears) {
      done(x)
      setLocal("")
      el.value = ""
      setTyped(false)
      return
    }
    el.blur()
  }
  return (
    <input
      ref={el}
      class={`mdock-fld ${props.class ?? ""}`}
      classList={{ bad: bad() }}
      value={local() ?? props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.title}
      inputmode={props.inputmode}
      spellcheck={false}
      autocomplete="off"
      {...(props.attr ? { [`data-${props.attr}`]: "" } : {})}
      onFocus={() => {
        setFocused(true)
        setTyped(false)
        atFocus = el.value
        setLocal(el.value)
        setMark(props.list ? (props.list().indexOf(el.value.trim())) : -1)
      }}
      onInput={() => {
        const v = el.value
        setLocal(v)
        setTyped(true)
        setMark(v.trim() ? 0 : -1)
        const good = ok(v)
        setBad(!good && v.trim() !== "")
        if (good) props.onInput?.(v)
      }}
      onBlur={() => {
        if (gone) return
        setFocused(false)
        const v = local()
        if (v !== null && !props.clears) done(v)
        if (props.clears) setLocal(null)
      }}
      onKeyDown={(e) => {
        const list = items()
        if (list.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault()
          const n = list.length, i = mark()
          setMark(i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n)
        } else if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault()
          if (list.length && mark() >= 0 && !isMod(e)) return void pick(list[mark()]!)
          if (props.clears) {
            const v = el.value
            if (v.trim()) pick(v.trim())
            return void setLocal("")
          }
          el.blur()
        } else if (e.key === "Escape") {
          if (list.length) {
            pop.close()
            setTyped(false)
            setLocal(local() ?? props.value)
            // the list is closed; the next Esc leaves the field
            return void e.stopPropagation()
          }
          el.blur()
          props.onEsc?.()
        } else if (e.key === "Tab") pop.close()
        // Typing: none of it is the dock's keys (space, arrows, Delete).
        e.stopPropagation()
      }}
    />
  )
}

const numberOk = (min: number) => (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 600000 && Number(v) >= min
const easingOk = (v: string) => CSS.supports("animation-timing-function", v.trim())

// ── the dock ────────────────────────────────────────────────────────────────────────────────────

/** A keyframe being dragged: where it was grabbed, where it is now, and the lanes as they were
 *  then. Drawn from these until the view agrees (or the moment after it is let go is over). */
type Drag = { prop: string | null; from: number; to: number; lanes: MotionLane[]; frames: number[]; done: boolean }

/** A delay (ms) being dragged: drawn until the view agrees, or the moment after it is let go is
 *  over. */
type Late = { to: number; done: boolean }
/** The delay a drag has come to, from where its edge would be: to 10 ms, or to 1 (`free`). */
const lateAt = (ms: number, free: boolean) => {
  const n = free ? 1 : 10
  return Math.min(600000, Math.round(ms / n) * n)
}

export function MotionDock() {
  let root!: HTMLDivElement
  let tl: HTMLDivElement | undefined
  const [pop, setShown] = createSignal<(Opened & { drawn: JSX.Element }) | null>(null)
  const [drag, setDrag] = createSignal<Drag | null>(null)
  const [late, setLate] = createSignal<Late | null>(null)
  const [scrub, setScrub] = createSignal<{ p: number; on: boolean } | null>(null)
  const [noteFocused, setNoteFocused] = createSignal(false)
  const [noteLocal, setNoteLocal] = createSignal<string | null>(null)
  /** A field to give the caret to once the view has it (after a keyframe, a lane or keyframes
   *  are added): its selector, and until when. */
  const [focusWant, setFocusWant] = createSignal<{ sel: string; until: number } | null>(null)
  const [rtt, setRtt] = createSignal<number[]>([])

  // A window that was reloaded has no view: the overlay is asked for one, whole (what it would
  // send by itself is only what changed since the last, and that went to the window before).
  // And the way there and back is measured, a few times (what a drag of a keyframe would wait
  // for without `drag`).
  onMount(async () => {
    send({ type: "resend" })
    if (!view()) dockAct({ panel: "motion", act: { type: "whole" } })
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const t = await dockPing("motion")
      if (t !== undefined) times.push(Math.round(t * 10) / 10)
    }
    setRtt(times)
  })

  const v = view
  const open = (): MotionOpen | null => v()?.open ?? null
  const ro = () => !!open()?.readOnly

  // ── what is drawn: the view, with the hand's own values over it ──
  const lanes = () => drag()?.lanes ?? open()?.lanes ?? []
  const wholeFrames = () => drag()?.frames ?? open()?.frames ?? []
  const selKey = () => {
    const d = drag()
    if (d) return { at: d.to, prop: d.prop }
    const k = open()?.key
    return k ? { at: k.at, prop: k.prop } : null
  }
  const pos = () => {
    const s = scrub(), p = v()?.clock.pos ?? null
    return s && (s.on || p === null || Math.abs(p - s.p) > 0.002) ? s.p : p
  }
  // The line of time: the delay (`lead`), then what plays. `off` is where the keyframes' span
  // starts on it and `T` how long that is: a transition's span has its delay in it already (its
  // lanes start that late), so it only moves as far as a drag has moved the delay.
  const delay = () => late()?.to ?? open()?.timing.delay ?? 0
  const axis = createMemo(() => {
    const o = open(), T = o?.T ?? 1, lead = Math.max(0, delay())
    const off = o?.kind === "transition" ? lead - Math.max(0, o.timing.delay) : lead
    return { lead, off, T, total: Math.max(1, off + T) }
  })
  /** Where the playhead is on it, in ms; null when there is no frame to show. */
  const playhead = () => {
    const a = axis(), w = v()?.clock.wait ?? null, p = pos()
    if (w !== null && !scrub()) return w * a.lead
    return p === null ? null : Math.max(0, a.off + p * a.T)
  }
  // The view caught up with the hand: it is drawn again.
  createEffect(() => {
    const l = late()
    if (l?.done && open()?.timing.delay === l.to) setLate(null)
  })
  createEffect(() => {
    const d = drag(), o = open()
    if (!d || !d.done || !o) return
    const lane = d.prop === null ? null : o.lanes.find((l) => l.prop === d.prop)
    if (d.prop === null ? o.frames.includes(d.to) : lane?.keys.some((k) => !k.implied && k.at === d.to)) setDrag(null)
  })
  createEffect(() => {
    const s = scrub(), p = v()?.clock.pos ?? null
    if (s && !s.on && p !== null && Math.abs(p - s.p) <= 0.002) setScrub(null)
  })
  createEffect(() => {
    const w = focusWant(), o = open()
    // The view is reconciled into the one object (store.ts): what the wanted fields are drawn
    // from is read here, so that a view that draws one runs this again.
    void [v()?.sel, o?.name, o?.renamable, o?.key?.at, o?.key?.prop, o?.lanes.length]
    if (!w || !v()) return
    const f = root.querySelector<HTMLInputElement>(w.sel)
    if (f && !f.disabled) {
      f.focus()
      f.select()
      setFocusWant(null)
    } else if (performance.now() > w.until) setFocusWant(null)
  })
  const wantFocus = (sel: string) => setFocusWant({ sel, until: performance.now() + 1500 })

  // ── the popover ──
  let popEl: HTMLDivElement | undefined
  const [popAt, setPopAt] = createSignal<{ left: number; top: number; max: number; origin: string } | null>(null)
  createEffect(() => {
    const p = pop()
    if (!p || !popEl) return setPopAt(null)
    // Placed once it is drawn, from its size: above what opened it when there is room in the
    // dock, else below, and never past the dock's edges (beyond them is the page, which hides it).
    queueMicrotask(() => {
      if (!popEl || pop() !== p) return
      const box = root.getBoundingClientRect(), a = p.anchor.getBoundingClientRect()
      const w = popEl.offsetWidth, h = popEl.offsetHeight
      const above = a.top - box.top - 6, below = box.bottom - a.bottom - 6
      const max = Math.max(above, below) - 8
      const hh = Math.min(h, max)
      const up = above >= hh + 8 || above > below
      const top = up ? a.top - box.top - 6 - hh : a.bottom - box.top + 6
      const leftWant = p.kind === "list" ? a.left - box.left : a.right - box.left - w
      // (It grows out of the side of what opened it: its edge nearest it, at the end it is aligned to.)
      const origin = `${p.kind === "list" ? "left" : "right"} ${up ? "bottom" : "top"}`
      setPopAt({ left: Math.min(Math.max(8, leftWant), box.width - w - 8), top: Math.max(8, top), max, origin })
    })
  })
  /** The popover that is up goes, and `p` is up in its place. Its body is made here, under the
   *  component that opened it (see Pop), in a root of its own so that closing it is all it takes
   *  to undo. */
  let undraw: (() => void) | undefined
  const setPop = (p: Opened | null) => {
    undraw?.()
    undraw = undefined
    setShown(p && { ...p, drawn: createRoot((dispose) => ((undraw = dispose), p.body()), p.owner) })
  }
  onCleanup(() => undraw?.())
  const popCtx = { open: setPop, current: pop }
  // A press anywhere else closes the "more" sheet and the easings (a field's list closes itself).
  const outside = (e: PointerEvent) => {
    const p = pop(), t = e.target as Node
    if (p && p.kind !== "list" && !popEl?.contains(t) && !p.anchor.contains(t)) setPop(null)
  }
  onMount(() => document.addEventListener("pointerdown", outside, true))
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  // ── the timeline's pointer ──
  // Press a keyframe (the page shows that frame), drag it, press twice on a lane to add one, drag
  // the ruler or an empty lane to scrub: as in the overlay's own dock (tlDown in input.js).
  let last: { t: number; x: number; y: number } | null = null
  // The delay's band (or its edge, or the keyframes' heading: the whole block) dragged is the delay.
  let gesture: "drag" | "scrub" | "late" | null = null
  const span = () => tl?.querySelector<HTMLElement>(".mdock-kspan") ?? tl?.querySelector<HTMLElement>("[data-ruler]") ?? null
  const atOf = (e: PointerEvent, free: boolean, s: HTMLElement) => {
    const r = s.getBoundingClientRect(), pad = s.classList.contains("mdock-kspan") ? 0 : 16
    // (A span with no lane in it is the ruler, which the delay is on too.)
    const a = axis(), x = (e.clientX - r.left - pad) / Math.max(1, r.width - 2 * pad)
    const at = Math.min(100, Math.max(0, (pad ? (x * a.total - a.off) / a.T : x) * 100))
    return free ? Math.round(at * 10) / 10 : Math.round(at / 5) * 5
  }
  /** The lanes with the dragged keyframe at `to`; null when one is there already (as the overlay
   *  refuses it: moveKey in edit.js). */
  const moved = (d: Drag, to: number): Pick<Drag, "lanes" | "frames"> | null => {
    if (d.prop === null) {
      if (d.frames.some((f) => f === to && f !== d.from)) return null
      const lanes = d.lanes.map((l) => ({ ...l, keys: l.keys.map((k) => (k.at === d.from ? { ...k, at: to } : k)).sort((a, b) => a.at - b.at) }))
      return { lanes, frames: d.frames.map((f) => (f === d.from ? to : f)).sort((a, b) => a - b) }
    }
    const lane = d.lanes.find((l) => l.prop === d.prop)
    if (!lane || lane.keys.some((k) => !k.implied && k.at === to && k.at !== d.from)) return null
    const lanes = d.lanes.map((l) => (l !== lane ? l : { ...l, keys: l.keys.filter((k) => !(k.implied && k.at === to)).map((k) => (k.at === d.from && !k.implied ? { ...k, at: to } : k)).sort((a, b) => a.at - b.at) }))
    return { lanes, frames: [...new Set(lanes.flatMap((l) => l.keys.map((k) => k.at)))].sort((a, b) => a - b) }
  }
  let base: Drag | null = null
  /** A delay taken hold of: where the pointer was, the delay then, where the block began on the
   *  line of time (0…1), what comes after the delay (ms) and the line's width (px). */
  let held: { x: number; from: number; f: number; rest: number; w: number } | null = null
  /** The delay for the pointer: the block's edge follows it. The line of time is as long as the
   *  delay and what plays, so it grows as the block is dragged along it: the edge is at f of it
   *  when the delay is rest · f / (1 − f). Never under 0, or under what it was when that is less. */
  const lateTo = (e: PointerEvent, h: NonNullable<typeof held>) => {
    const f = Math.min(0.9, Math.max(0, h.f + (e.clientX - h.x) / h.w))
    return lateAt(Math.min(0, h.from) + (h.rest * f) / (1 - f), isMod(e))
  }
  const tlDown = (e: PointerEvent) => {
    const o = open()
    if (e.button || !o || (e.target as HTMLElement).closest("input, button, textarea")) return
    const t = e.target as HTMLElement
    if (o.timed && t.closest(".mdock-lead, .mdock-gnote")) {
      const r = tl!.querySelector("[data-ruler]")!.getBoundingClientRect(), a = axis()
      last = null
      held = { x: e.clientX, from: delay(), f: a.lead / a.total, rest: a.total - a.lead, w: Math.max(1, r.width - 32) }
      gesture = "late"
      tl!.setPointerCapture(e.pointerId)
      e.preventDefault()
      return tl!.focus({ preventScroll: true })
    }
    const grip = t.closest<HTMLElement>(".mdock-key"), seg = t.closest<HTMLElement>("[data-seg]"), trk = t.closest<HTMLElement>(".mdock-kspan, [data-ruler]")
    const now = performance.now(), l = last
    const twice = !!l && now - l.t < 350 && Math.abs(e.clientX - l.x) < 5 && Math.abs(e.clientY - l.y) < 5
    last = twice ? null : { t: now, x: e.clientX, y: e.clientY }
    const s = span()
    if (!s) return
    if (twice && !grip && trk?.dataset.lane !== undefined && !ro()) {
      e.preventDefault()
      send({ type: "addKey", prop: trk.dataset.lane || null, at: atOf(e, isMod(e), s) })
      return wantFocus("[data-kval]")
    }
    if (grip || seg) {
      const at = Number((grip ?? seg)!.dataset.at ?? seg!.dataset.seg), prop = (grip ?? seg)!.dataset.prop || null
      const grab = !!grip && !ro()
      send({ type: "select", key: { at, prop }, grab })
      if (grab) {
        base = { prop, from: at, to: at, lanes: o.lanes, frames: o.frames, done: false }
        setDrag(base)
        gesture = "drag"
      }
    } else if (trk) {
      const p = atOf(e, true, s) / 100
      setScrub({ p, on: true })
      send({ type: "seek", p })
      if (o.key) send({ type: "select", key: null }) // a press beside the keyframes lets go of the selected one
      gesture = "scrub"
    } else return
    if (gesture) tl!.setPointerCapture(e.pointerId)
    e.preventDefault()
    tl!.focus({ preventScroll: true })
  }
  const tlMove = (e: PointerEvent) => {
    const s = span()
    if (gesture === "late" && held) {
      // (Pressed and not moved, it stays what it is, rounded or not.)
      if (!late() && Math.abs(e.clientX - held.x) < 3) return
      const to = lateTo(e, held)
      if (to === delay()) return
      setLate({ to, done: false })
      return send({ type: "timing", what: "delay", value: String(to), done: false })
    }
    if (!gesture || !s) return
    if (gesture === "scrub") {
      const p = atOf(e, true, s) / 100
      if (p === scrub()?.p) return
      setScrub({ p, on: true })
      return send({ type: "seek", p })
    }
    const d = drag()
    if (!d || !base) return
    const to = atOf(e, isMod(e), s)
    if (to === d.to) return
    const next = moved(base, to)
    if (!next) return
    setDrag({ ...d, ...next, to })
    send({ type: "drag", to })
  }
  const tlUp = () => {
    const g = gesture
    gesture = null
    if (g === "scrub") {
      setScrub((s) => (s ? { ...s, on: false } : s))
      setTimeout(() => !gesture && setScrub((s) => (s && !s.on ? null : s)), HOLD_MS)
    } else if (g === "late") {
      const l = late()
      held = null
      if (!l) return
      send({ type: "timing", what: "delay", value: String(l.to), done: true })
      setLate({ ...l, done: true })
      setTimeout(() => setLate((x) => (x && x.done ? null : x)), HOLD_MS)
    } else if (g === "drag") {
      send({ type: "drop" })
      const d = drag()
      if (d && d.to === d.from) setDrag(null)
      else if (d) {
        setDrag({ ...d, done: true })
        setTimeout(() => setDrag((x) => (x && x.done ? null : x)), HOLD_MS)
      }
      base = null
    }
  }

  // ── keys while the dock has the keyboard ──
  // space plays, ←/→ step (shift: ten times as far), ↑/↓ open the one before and the next,
  // Delete removes the keyframe, mod+Z and
  // mod+shift+Z undo and redo, Enter sends (alt: to the background), Esc steps back. A field
  // keeps its own keys (Field). The window's own keys (mod+I, mod+L, …) go on to it.
  const onKey = (e: KeyboardEvent) => {
    const x = v()
    if (!x?.on || (e.target as HTMLElement).closest("input, textarea")) return
    const done = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (isMod(e) && !e.altKey && e.key.toLowerCase() === "z") {
      done()
      return send({ type: e.shiftKey ? "redo" : "undo" })
    }
    if (isMod(e) || (e.altKey && e.key !== "Enter")) return
    if (e.key === " ") {
      if ((e.target as HTMLElement).closest("button")) return // a focused button is pressed
      done()
      return x.open && send({ type: "play" })
    }
    if (e.key === "Enter" && !e.isComposing) {
      if ((e.target as HTMLElement).closest("button")) return
      done()
      return sendNote(e.altKey)
    }
    if ((e.key === "Delete" || e.key === "Backspace") && x.open?.key && !x.open.readOnly) {
      done()
      return send({ type: "removeKey" })
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && x.open) {
      done()
      return send({ type: "step", by: (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01) })
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && x.open && !pop()) {
      done()
      return send({ type: "go", by: e.key === "ArrowUp" ? -1 : 1 })
    }
    if (e.key === "Escape") {
      done()
      if (pop()) setPop(null)
      else send({ type: "escape" })
    }
  }
  // The dock takes the keyboard when it is pressed anywhere that does not take it itself; a
  // button keeps the caret where it was (the note, a value being typed), as in the overlay's dock.
  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement
    if (!t.closest("input, textarea, button") && !root.contains(document.activeElement)) root.focus({ preventScroll: true })
  }

  // ── the note ──
  const note = () => noteLocal() ?? v()?.note ?? ""
  createEffect(() => {
    const l = noteLocal()
    if (l !== null && !noteFocused() && l === (v()?.note ?? "")) setNoteLocal(null)
  })
  const canSend = () => !!open() && (!!open()!.dirty || !!note().trim())
  let noteEl: HTMLInputElement | undefined
  const sendNote = (background: boolean) => {
    const text = noteEl?.value ?? note()
    if (text !== (v()?.note ?? "")) send({ type: "note", text })
    send({ type: "send", background })
    // Sent, the words are gone; refused, the view brings them back.
    if (open() && (open()!.dirty || text.trim())) {
      setNoteLocal("")
      setTimeout(() => !noteFocused() && setNoteLocal(null), HOLD_MS)
    }
    noteEl?.blur()
  }
  const line = () => {
    const x = v()
    if (!x) return { text: "", warn: false }
    if (x.msg && !noteFocused()) return { text: x.msg, warn: true }
    return { text: noteFocused() || note() ? "" : x.status, warn: false }
  }

  const rowsHover = (id: string | null) => send({ type: "hover", id })
  // ── the list's long groups ──
  // A row with many elements under it (a rule every link of the page has) is drawn shut: one
  // line, until it is pressed or one of its elements is what is open.
  const FOLD = 5
  const [unfolded, setUnfolded] = createSignal<ReadonlySet<string>>(new Set())
  const folds = createMemo(() => {
    const heads = new Map<string, { n: number; on: boolean }>(), under = new Map<string, string>()
    let head: string | null = null
    for (const r of v()?.rows ?? []) {
      if ("group" in r) head = null
      else if (!r.sub) heads.set((head = r.id), { n: 0, on: false })
      else if (head) {
        const h = heads.get(head)!
        h.n++
        h.on ||= r.on
        under.set(r.id, head)
      }
    }
    return { heads, under }
  })
  /** A head's row: "shut", "open", or null when it has too few elements to fold. */
  const fold = (id: string): "shut" | "open" | null => {
    const h = folds().heads.get(id)
    return !h || h.n <= FOLD ? null : h.on || unfolded().has(id) ? "open" : "shut"
  }
  const hiddenRow = (id: string) => {
    const head = folds().under.get(id)
    return !!head && fold(head) === "shut"
  }
  const pressRow = (r: Extract<MotionRow, { id: string }>) => {
    if (r.off) return
    const f = fold(r.id)
    if (f) setUnfolded((s) => new Set(f === "open" ? [...s].filter((x) => x !== r.id) : [...s, r.id]))
    // (Shutting a group whose element is open only folds it away: what is open stays.)
    if (f !== "open") send({ type: "row", id: r.id })
  }
  /** How many things there are to step through (as the overlay's "go" counts them: each element
   *  that moves, not the row of a name several play, not what cannot be opened). */
  const steps = () => {
    const rows = v()?.rows ?? []
    return rows.filter((r, i) => {
      if ("group" in r || r.off || r.kind === "unused" || r.kind === "frames") return false
      const next = rows[i + 1]
      return r.sub || !(next && !("group" in next) && next.sub)
    }).length
  }

  return (
    <PopContext.Provider value={popCtx}>
      <div
        class="mdock"
        ref={root}
        tabIndex={-1}
        data-rtt={rtt().join(",")}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onMouseDown={(e) => (e.target as HTMLElement).closest("button") && e.preventDefault()}
      >
        <Show when={v()?.on} fallback={<p class="dock-empty">Animations</p>}>
          <div class="mdock-grid" classList={{ detail: !!(open() || v()?.sel) }}>
            {/* the list of what moves */}
            <div class="mdock-list thin-scroll" role="list" aria-label="What moves on the page" onPointerLeave={() => rowsHover(null)}>
              <For each={v()!.rows} fallback={<p class="mdock-none">Nothing moves on this page</p>}>
                {(r) =>
                  "group" in r ? (
                    <div class="mdock-grp">{r.group}</div>
                  ) : (
                    <button
                      type="button"
                      class="mdock-row"
                      classList={{ on: r.on, sub: r.sub, last: r.last, off: r.off, run: r.running, shut: fold(r.id) === "shut" }}
                      hidden={r.sub && hiddenRow(r.id)}
                      aria-expanded={fold(r.id) ? fold(r.id) === "open" : undefined}
                      data-kind={r.kind}
                      data-row={r.id}
                      role="listitem"
                      aria-disabled={r.off}
                      title={r.sub ? "" : `${r.kind === "unused" && r.aside ? `Keyframes that play on ${r.aside}, which nothing is now` : r.kind === "unused" && v()!.partial ? "Keyframes nothing was seen to play" : KIND_TITLE[r.kind]}${r.running ? ", playing" : ""}`}
                      onPointerEnter={() => rowsHover(r.id)}
                      onClick={() => pressRow(r)}
                    >
                      <Show when={!r.sub}>
                        <KindIcon kind={r.kind} />
                      </Show>
                      <span class="mdock-nm">{r.text}</span>
                      <span class="mdock-ex">{r.aside}</span>
                      <Show when={r.dirty}>
                        <i class="mdock-dot" title="Changed, not sent" />
                      </Show>
                      <Show when={r.duration !== null}>
                        <span class="mdock-du">{r.duration}</span>
                      </Show>
                      <Show when={fold(r.id)}>
                        <Icon name={fold(r.id) === "open" ? "up" : "down"} />
                      </Show>
                    </button>
                  )
                }
              </For>
              <Show when={v()!.partial}>
                <p class="mdock-part">A large page: this is what its first few thousand elements play, and what plays now.</p>
              </Show>
            </div>

            <div class="mdock-main">
              {/* the header: what is open, its timing, how it plays while looking, undo */}
              <Show when={open() || v()!.sel}>
                <div class="mdock-hd" classList={{ bare: !open() }}>
                  <button type="button" class="icon-btn mdock-back" title="Everything that moves" aria-label="Everything that moves" onClick={() => send({ type: "back" })}>
                    <Icon name="back" />
                  </button>
                  <Show when={open()}>
                    {(o) => <Header open={o()} view={v()!} steps={steps()} />}
                  </Show>
                </div>
              </Show>

              <Show
                when={open() && v()!.view === "css"}
                fallback={
                  <div
                    class="mdock-tl thin-scroll"
                    classList={{ ro: ro(), timed: !!open()?.timed, late: late()?.done === false }}
                    style={{ "--lead": axis().lead / axis().total, "--k0": axis().off / axis().total, "--kw": axis().T / axis().total }}
                    ref={tl}
                    tabIndex={0}
                    aria-label="Timeline"
                    onPointerDown={tlDown}
                    onPointerMove={tlMove}
                    onPointerUp={tlUp}
                    onPointerCancel={tlUp}
                    onLostPointerCapture={() => gesture && tlUp()}
                  >
                    <Show when={open()} fallback={<Empty view={v()!} onNew={() => wantFocus("[data-mname]")} />}>
                      {(o) => (
                        <Timeline
                          open={o()}
                          lanes={lanes()}
                          frames={wholeFrames()}
                          sel={selKey()}
                          total={axis().total}
                          delay={delay()}
                          head={playhead()}
                          playing={v()!.clock.playing}
                          wait={v()!.clock.wait}
                          flipped={v()!.clock.on}
                          props={v()!.choices.props}
                          onLane={() => wantFocus("[data-kval]")}
                        />
                      )}
                    </Show>
                  </div>
                }
              >
                <CssText open={open()!} />
              </Show>

              <Show when={v()!.view !== "css" && open()?.key}>
                {(k) => <KeyEditor k={k()} at={selKey()?.at ?? k().at} readOnly={ro()} easings={v()!.choices.easings} />}
              </Show>

              {/* the note and Send, or what the line has to say */}
              <div class="mdock-ft">
                <Show
                  when={!line().text}
                  fallback={
                    <div class="mdock-msg" classList={{ warn: line().warn }} role="status">
                      {line().text}
                    </div>
                  }
                >
                  <input
                    ref={noteEl}
                    class="input mdock-note"
                    type="text"
                    spellcheck={false}
                    autocomplete="off"
                    aria-label="Note"
                    placeholder={open() && open()!.kind !== "css" ? "Note for the agent: what it should do" : NOTE_OPTIONAL}
                    value={note()}
                    onFocus={() => {
                      setNoteFocused(true)
                      setNoteLocal(noteEl!.value)
                    }}
                    onBlur={() => {
                      setNoteFocused(false)
                      setTimeout(() => !noteFocused() && setNoteLocal(null), HOLD_MS)
                    }}
                    onInput={(e) => {
                      setNoteLocal(e.currentTarget.value)
                      send({ type: "note", text: e.currentTarget.value })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.isComposing) {
                        e.preventDefault()
                        sendNote(e.altKey)
                      } else if (e.key === "Escape") noteEl!.blur()
                      e.stopPropagation()
                    }}
                  />
                </Show>
                <button
                  type="button"
                  class="btn primary mdock-go"
                  disabled={!canSend()}
                  title={
                    canSend()
                      ? `Send this animation to the agent as note ${nextNoteNumber()} (${keys("enter")}; ${keys("alt", "enter")}: in the background)`
                      : open()
                        ? "Change it, or say what it should do, first"
                        : "Open an animation first"
                  }
                  onClick={(e) => sendNote(e.altKey)}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </Show>

        <Show when={pop()}>
          {(p) => (
            <div
              class="mdock-pop"
              classList={{ list: p().kind === "list", wide: !!p().wide }}
              ref={popEl}
              style={{
                left: `${popAt()?.left ?? 0}px`,
                top: `${popAt()?.top ?? 0}px`,
                "max-height": popAt() ? `${popAt()!.max}px` : undefined,
                "transform-origin": popAt()?.origin,
                visibility: popAt() ? "visible" : "hidden",
              }}
            >
              {p().drawn}
            </div>
          )}
        </Show>
      </div>
    </PopContext.Provider>
  )
}

// ── the header ──────────────────────────────────────────────────────────────────────────────────

/** A timing field's name: whole where there is room, short (when it has a short form) where
 *  there is not. Seen only: the field carries its whole name for a screen reader. */
function TName(props: { long: string; short?: string }) {
  return (
    <span class="mdock-tn" aria-hidden="true">
      <span>{props.long}</span>
      <Show when={props.short}>
        <span>{props.short}</span>
      </Show>
    </span>
  )
}

function Header(props: { open: MotionOpen; view: MotionView; steps: number }) {
  const pop = usePop()
  const t = () => props.open.timing
  const ro = () => props.open.readOnly
  let more!: HTMLButtonElement
  const nextRate = () => {
    const rates = props.view.choices.rates.map(([r]) => r)
    return rates[(rates.indexOf(props.view.rate) + 1) % rates.length] ?? 1
  }
  const rateText = () => props.view.choices.rates.find(([r]) => r === props.view.rate)?.[1] ?? `${props.view.rate}×`
  return (
    <>
      <div class="devices mdock-seg" role="radiogroup" aria-label="Show">
        <button type="button" role="radio" class="device" aria-checked={props.view.view === "keys"} onClick={() => send({ type: "view", view: "keys" })}>
          Keyframes
        </button>
        <button type="button" role="radio" class="device" aria-checked={props.view.view === "css"} onClick={() => send({ type: "view", view: "css" })}>
          Code
        </button>
      </div>
      {/* (After the two tabs, where it is drawn: Tab goes through the header in the order it is seen.) */}
      <Show when={props.steps > 1}>
        <div class="mdock-tools mdock-step">
          <button type="button" class="icon-btn" title="The one before (↑)" aria-label="The one before" onClick={() => send({ type: "go", by: -1 })}>
            <Icon name="up" />
          </button>
          <button type="button" class="icon-btn" title="The next one (↓)" aria-label="The next one" onClick={() => send({ type: "go", by: 1 })}>
            <Icon name="down" />
          </button>
        </div>
      </Show>
      <button
        type="button"
        hidden={props.open.kind === "transition"}
        class="icon-btn mdock-more-btn"
        ref={more}
        title="More: repeat, direction, fill, what starts it"
        aria-label="More"
        onClick={() => pop.toggle({ anchor: more, kind: "more", body: () => <MoreSheet open={props.open} view={props.view} /> })}
      >
        <MIcon name="more" />
      </button>
      <span class="mdock-sp" />
      <div class="mdock-tools">
        <button type="button" class="text-btn mdock-rate" title="Speed while looking" onClick={() => send({ type: "rate", rate: nextRate() })}>
          {rateText()}
        </button>
        <button type="button" class="icon-btn" aria-pressed={props.view.loop} title="Repeat while looking" aria-label="Repeat while looking" onClick={() => send({ type: "loop", on: !props.view.loop })}>
          <MIcon name="loop" />
        </button>
        <button
          type="button"
          class="btn mdock-solo"
          aria-pressed={props.view.isolate}
          disabled={!props.view.sel}
          title="Show only this element, in the middle of the page and large enough to look at"
          onClick={() => send({ type: "isolate", on: !props.view.isolate })}
        >
          <MIcon name="solo" />
          Only this
        </button>
        <Show when={props.view.isolate && props.view.sel}>
          <div class="devices mdock-seg mdock-bg" role="radiogroup" aria-label="Behind it">
            <button type="button" role="radio" class="device" aria-checked={props.view.backdrop !== "dark"} title="A light colour behind it" onClick={() => send({ type: "backdrop", value: "light" })}>
              Light
            </button>
            <button type="button" role="radio" class="device" aria-checked={props.view.backdrop === "dark"} title="A dark colour behind it" onClick={() => send({ type: "backdrop", value: "dark" })}>
              Dark
            </button>
          </div>
        </Show>
      </div>
      <div class="mdock-tools">
        <button type="button" class="icon-btn" disabled={!props.view.undo} title={`Undo (${keys("mod", "Z")})`} aria-label="Undo" onClick={() => send({ type: "undo" })}>
          <MIcon name="undo" />
        </button>
        <button
          type="button"
          class="btn mdock-reset"
          disabled={!props.open.dirty}
          title={props.open.removable ? "Remove this new animation" : "Put back as the page has it"}
          onClick={() => send({ type: "discard" })}
        >
          Reset
        </button>
      </div>
      {/* (Last: on two rows they are the second, and Tab goes there last; see .mdock-hd.) */}
      <div class="mdock-timing">
        <label class="mdock-tf">
          <TName long="Duration" short="Dur." />
          <Field
            class="num"
            attr="tduration"
            label="Duration"
            value={String(t().duration)}
            disabled={!props.open.timed}
            inputmode="numeric"
            ok={numberOk(0)}
            onInput={(x) => send({ type: "timing", what: "duration", value: x, done: false })}
            onDone={(x) => send({ type: "timing", what: "duration", value: x, done: true })}
          />
          <span class="mdock-unit">ms</span>
        </label>
        <label class="mdock-tf">
          <TName long="Delay" />
          <Field
            class="num"
            attr="tdelay"
            label="Delay"
            value={String(t().delay)}
            disabled={!props.open.timed}
            inputmode="numeric"
            ok={numberOk(-600000)}
            onInput={(x) => send({ type: "timing", what: "delay", value: x, done: false })}
            onDone={(x) => send({ type: "timing", what: "delay", value: x, done: true })}
          />
          <span class="mdock-unit">ms</span>
        </label>
        <label class="mdock-tf">
          <TName long="Easing" short="Ease" />
          <Field
            class="ease"
            attr="teasing"
            label="Easing"
            value={t().easing}
            disabled={!props.open.timed}
            ok={easingOk}
            list={() => props.view.choices.easings}
            curves
            onInput={(x) => send({ type: "timing", what: "easing", value: x, done: false })}
            onDone={(x) => send({ type: "timing", what: "easing", value: x, done: true })}
          />
          <Curve easing={t().easing} />
        </label>
      </div>
    </>
  )
}

/** How it plays: repeat, direction, fill, and what starts it. A chip sets it, one undo step each. */
function MoreSheet(props: { open: MotionOpen; view: MotionView }) {
  const t = () => props.open.timing
  const chips = (what: "count" | "direction" | "fill" | "how", label: string, list: Array<[string, string, string?]>, cur: string) => (
    <div class="mdock-tchips">
      <span>{label}</span>
      <div class="mdock-chips">
        <For each={list}>
          {([value, text, what2]) => (
            <button
              type="button"
              class="mdock-chip"
              aria-pressed={cur === value}
              disabled={!props.open.timed}
              title={what2 && what2 !== value ? `${what2} (${value})` : value}
              onClick={() => send({ type: "timing", what, value, done: true })}
            >
              {text}
            </button>
          )}
        </For>
      </div>
    </div>
  )
  const count = () => {
    const c = props.view.choices.count
    return c.some(([x]) => x === t().count) ? c : [...c, [t().count, `${t().count}×`, t().count] as [string, string, string]]
  }
  return (
    <div class="mdock-more">
      {chips("count", "Repeat", count(), t().count)}
      {chips("direction", "Direction", props.view.choices.direction, t().direction)}
      {chips("fill", "Fill", props.view.choices.fill, t().fill)}
      <Show when={props.open.starts !== null}>
        {chips(
          "how",
          "Starts",
          props.view.choices.starts.filter(([k]) => !(props.open.removable && k === "asnow")),
          props.open.starts ?? "",
        )}
      </Show>
    </div>
  )
}

// ── the timeline ────────────────────────────────────────────────────────────────────────────────

function Empty(props: { view: MotionView; onNew: () => void }) {
  return (
    <div class="mdock-empty">
      <Show when={props.view.sel} fallback={<p>Click something on the page, or a row of the list</p>}>
        <p>Nothing moves this</p>
        <button
          type="button"
          class="btn"
          onClick={() => {
            send({ type: "new" })
            props.onNew()
          }}
        >
          <Icon name="plus" />
          New animation
        </button>
        <Show when={props.view.names.length}>
          <p class="mdock-or">or play keyframes the page has</p>
          <div class="mdock-chips">
            <For each={props.view.names}>
              {(n) => (
                <button type="button" class="mdock-chip mono" title={`Play ${n} on this element`} onClick={() => send({ type: "use", name: n })}>
                  {n}
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function Timeline(props: {
  open: MotionOpen
  lanes: MotionLane[]
  frames: number[]
  sel: { at: number; prop: string | null } | null
  /** The line of time's length, the delay it begins with (as dragged) and where the playhead is
   *  on it, in ms. */
  total: number
  delay: number
  head: number | null
  playing: boolean
  wait: number | null
  flipped: boolean
  props: string[]
  onLane: () => void
}) {
  const ticks = createMemo(() => {
    const t = props.total, major = MAJOR.find((m) => t / m <= 7) ?? 5000, minor = major / 5, out: Array<{ at: number; big: boolean; n: number }> = []
    for (let n = 0; n <= t + 0.5; n += minor) out.push({ at: n / t, big: Math.round(n / minor) % 5 === 0, n })
    return out
  })
  const on = (at: number, prop: string) => !!props.sel && props.sel.at === at && (props.sel.prop === prop || props.sel.prop === null)
  const tr = () => props.open.kind === "transition"
  const ro = () => props.open.readOnly
  return (
    <>
      <div class="mdock-lrow mdock-ruler">
        <div class="mdock-lab">
          <button
            type="button"
            class="icon-btn mdock-play"
            aria-pressed={props.flipped}
            title={tr() ? "Switch the state" : "Play (space)"}
            aria-label={props.playing ? "Pause" : "Play"}
            onClick={() => send({ type: "play" })}
          >
            <MIcon name={props.playing ? "pause" : "play"} />
          </button>
          <Show when={!tr() && props.delay > 0}>
            <span
              class="mdock-wait"
              classList={{ on: props.wait !== null }}
              style={{ "--w": props.wait ?? 0 }}
              title={`It waits ${props.delay}ms before it starts (its delay): the hatched start of the timeline`}
            >
              {secs(props.delay)} wait
            </span>
          </Show>
        </div>
        <div class="mdock-trk" data-ruler>
          <For each={ticks()}>
            {(k) => (
              <i class="mdock-tick" classList={{ big: k.big }} style={{ "--at": k.at }}>
                <Show when={k.big}>
                  <b>{secs(k.n)}</b>
                </Show>
              </i>
            )}
          </For>
          <For each={props.frames}>
            {(at) => <i class="mdock-key wk" classList={{ on: !!props.sel && props.sel.at === at && props.sel.prop === null }} style={{ "--at": at / 100 }} data-at={at} data-prop="" />}
          </For>
        </div>
      </div>
      <div class="mdock-lanes">
        <i class="mdock-band" />
        <Show when={props.lanes.length}>
          <i
            class="mdock-lead"
            classList={{ none: props.delay <= 0 }}
            title={props.open.timed ? `Delay ${props.delay}ms: drag to start it earlier or later (${keys("mod")}: to the ms)` : `Delay ${props.delay}ms`}
          />
        </Show>
        <div class="mdock-lrow mdock-ghead">
          <div class="mdock-lab">
            <KindIcon kind={tr() ? "transition" : props.open.kind === "script" ? "script" : "css"} />
            <Show when={props.open.renamable} fallback={<b class="mdock-gname">{props.open.name}</b>}>
              <Field
                class="mdock-name"
                attr="mname"
                value={props.open.name}
                label="Name"
                title="Rename these keyframes"
                ok={(x) => /^-?[a-zA-Z_][\w-]{0,60}$/.test(x.trim())}
                onDone={(x) => send({ type: "name", value: x.trim(), done: true })}
              />
            </Show>
          </div>
          <div class="mdock-trk mdock-gnote" title={props.open.timed ? `Drag to start it earlier or later: its delay, ${props.delay}ms` : undefined}>
            <Show when={tr()}>
              <Show when={props.open.states.length} fallback={<span class="mdock-shared" title="No rule of the page’s CSS says what changes this element: a script does it. Do it on the page to see it, and say in the note what it should do.">No state found in the CSS</span>}>
                <span class="mdock-shared">On</span>
                <div class="mdock-chips mdock-states" role="radiogroup" aria-label="The state it is looked at in">
                  <For each={props.open.states}>
                    {(s) => (
                      <button
                        type="button"
                        role="radio"
                        class="mdock-chip mono"
                        aria-checked={s === props.open.state}
                        aria-pressed={s === props.open.state}
                        title={`What ${s} changes: press Play to switch it on and off`}
                        onClick={() => send({ type: "state", value: s })}
                      >
                        {s}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={props.open.shared > 1}>
              <span
                class="mdock-shared"
                title={`These keyframes are played by ${props.open.shared} elements: a change to them changes all of them. Duration, delay and easing are this element's own.`}
              >
                <MIcon name="link" />
                {props.open.shared}
                <span class="mdock-shared-w"> elements</span>
              </span>
              <button
                type="button"
                class="text-btn"
                title={`Give this element its own copy of the keyframes to change; the other ${props.open.shared - 1 === 1 ? "element keeps" : `${props.open.shared - 1} elements keep`} them as they are`}
                onClick={() => send({ type: "detach" })}
              >
                Duplicate
              </button>
            </Show>
            <Show when={props.open.shared <= 1 && props.open.from}>
              <span class="mdock-shared">
                Copy of <b>{props.open.from}</b>, for this element only
              </span>
            </Show>
            <Show when={props.open.removable}>
              <span class="mdock-sp" />
              <button type="button" class="text-btn" title="Take this animation off the element" onClick={() => send({ type: "discard" })}>
                Remove
              </button>
            </Show>
          </div>
        </div>
        <For each={props.lanes}>
          {(lane) => (
            <div class="mdock-lrow mdock-lane" classList={{ kon: props.sel?.prop === lane.prop }}>
              <div class="mdock-lab">
                <span title={lane.prop}>{lane.prop}</span>
                <Show when={!ro()}>
                  <button type="button" class="icon-btn small mdock-x" title="Remove" aria-label={`Remove ${lane.prop}`} onClick={() => send({ type: "removeLane", prop: lane.prop })}>
                    <Icon name="close" />
                  </button>
                </Show>
              </div>
              <div class="mdock-trk">
                <div class="mdock-kspan" data-lane={lane.prop}>
                  <Show when={lane.keys.length > 0}>
                    <span class="mdock-vals" aria-hidden="true">
                      <b>{lane.keys[0]!.value}</b>
                      <Show when={lane.keys.length > 1}>
                        <b>{lane.keys[lane.keys.length - 1]!.value}</b>
                      </Show>
                    </span>
                  </Show>
                  <Show when={lane.keys.length === 1}>
                    <i class="mdock-sb solo" classList={{ on: on(lane.keys[0]!.at, lane.prop) }} style={{ "--fa": lane.keys[0]!.at / 100, "--fb": lane.keys[0]!.at / 100, "--l": "-10px", "--r": "10px" }} />
                  </Show>
                  {/* The outer ends of a lane's bars reach past its first and last keyframes, so
                      those grips sit inside them; where two bars meet, a gap holds the grip they share. */}
                  <For each={lane.keys.slice(0, -1)}>
                    {(k, i) => {
                      const next = () => lane.keys[i() + 1]!
                      return (
                        <i
                          class="mdock-sb"
                          classList={{ on: !k.implied && on(k.at, lane.prop), flat: k.value === next().value, said: !k.implied }}
                          data-seg={k.implied ? undefined : k.at}
                          data-at={k.implied ? undefined : k.at}
                          data-prop={k.implied ? undefined : lane.prop}
                          title={lane.eases[i()] ?? ""}
                          style={{
                            "--fa": k.at / 100,
                            "--fb": next().at / 100,
                            "--l": i() === 0 ? "-10px" : "3px",
                            "--r": i() === lane.keys.length - 2 ? "10px" : "-3px",
                          }}
                        />
                      )
                    }}
                  </For>
                  <For each={lane.keys}>
                    {(k) => (
                      // (A view is put into the one object the last was: a key may become implied
                      // where it is, so which of the two is drawn is asked each time.)
                      <Show
                        when={k.implied}
                        fallback={<i class="mdock-key gr" classList={{ on: on(k.at, lane.prop) }} style={{ "--at": k.at / 100 }} data-at={k.at} data-prop={lane.prop} title={k.value} />}
                      >
                        <i
                          class="mdock-ghost"
                          style={{ "--at": k.at / 100 }}
                          title={`${k.value}: the element’s own value. The keyframes do not say where ${lane.prop} ${k.at ? "ends" : "starts"}; press twice here to make it a keyframe`}
                        />
                      </Show>
                    )}
                  </For>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={props.open.score.length}>
        <Score open={props.open} />
      </Show>
      <Show when={!ro()}>
        <div class="mdock-addp">
          <Field
            class="mdock-addf"
            attr="addp"
            value=""
            placeholder="+ Property"
            label="Add a property"
            clears
            list={() => props.props}
            ok={(x) => !x.trim() || CSS.supports(x.trim().toLowerCase(), "initial")}
            onDone={(x) => {
              if (!x.trim()) return
              send({ type: "addLane", prop: x.trim() })
              props.onLane()
            }}
          />
        </div>
      </Show>
      <div class="mdock-phl">
        <Show when={props.head !== null}>
          <div class="mdock-flag" style={{ "--x": props.head! / props.total }} data-ms={Math.round(props.head!)}>
            <b>{secs(Math.round(props.head!))}</b>
          </div>
        </Show>
      </div>
    </>
  )
}

/** What moves with the open animation: one bar an element, on one line of time from when they
 *  start, each as late as its delay and as long as it lasts. A bar opens its element, and dragged
 *  it is that element's delay; Play starts them all again. */
function Score(props: { open: MotionOpen }) {
  // A bar dragged along its line: its delay, drawn from the hand until the view agrees (`late`).
  // The line keeps its length meanwhile, so the bar stays under the pointer; it grows only when
  // the bar is taken past its end.
  type Bar = Late & { id: string; line: number }
  const [late, setLate] = createSignal<Bar | null>(null)
  let held: { id: string; x: number; from: number; line: number; w: number } | null = null
  /** Let go after a drag: the click that comes with it opens nothing. */
  let dragged = false
  createEffect(() => {
    const l = late()
    if (l?.done && (props.open.score.find((s) => s.id === l.id)?.delay ?? l.to) === l.to) setLate(null)
  })
  const lateOf = (s: MotionOpen["score"][number]) => (late()?.id === s.id ? late()!.to : s.delay)
  const total = () => Math.max(1, late()?.line ?? 0, ...props.open.score.map((s) => Math.max(0, lateOf(s)) + s.duration))
  const down = (e: PointerEvent & { currentTarget: HTMLElement }, s: MotionOpen["score"][number]) => {
    dragged = false
    if (e.button) return
    const w = e.currentTarget.parentElement!.getBoundingClientRect().width
    held = { id: s.id, x: e.clientX, from: lateOf(s), line: total(), w: Math.max(1, w) }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    const h = held
    if (!h || (!dragged && Math.abs(e.clientX - h.x) < 3)) return
    dragged = true
    const to = lateAt(Math.max(Math.min(0, h.from), h.from + ((e.clientX - h.x) / h.w) * h.line), isMod(e))
    if (late()?.id === h.id ? late()!.to === to : to === h.from) return
    setLate({ id: h.id, to, line: h.line, done: false })
    send({ type: "stagger", id: h.id, value: to, done: false })
  }
  const up = () => {
    const l = late()
    if (!held) return
    held = null
    if (!l || l.done) return
    send({ type: "stagger", id: l.id, value: l.to, done: true })
    setLate({ ...l, done: true })
    setTimeout(() => setLate((x) => (x && x.done ? null : x)), HOLD_MS)
  }
  return (
    <div class="mdock-score">
      <div class="mdock-lrow mdock-score-hd">
        <div class="mdock-lab">
          <button type="button" class="icon-btn" title="Play them all again, each after its delay" aria-label="Play them together" onClick={() => send({ type: "together" })}>
            <MIcon name="play" />
          </button>
          <b>Together</b>
        </div>
        <div class="mdock-trk mdock-score-ax">
          <span>0s</span>
          <span>{secs(total())}</span>
        </div>
      </div>
      <For each={props.open.score}>
        {(s) => (
          <button
            type="button"
            class="mdock-lrow mdock-score-row"
            classList={{ on: s.on, late: late()?.id === s.id && !late()!.done }}
            title={`${s.name} on ${s.text}: starts after ${lateOf(s)}ms, lasts ${s.duration}ms; drag its bar to start it earlier or later`}
            onClick={() => !s.on && !dragged && send({ type: "row", id: s.id })}
          >
            <span class="mdock-lab">
              <span>{s.text}</span>
            </span>
            <span class="mdock-trk">
              <i
                style={{ "--a": Math.max(0, lateOf(s)) / total(), "--b": (Math.max(0, lateOf(s)) + s.duration) / total() }}
                onPointerDown={(e) => down(e, s)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onLostPointerCapture={up}
              >
                <b>{late()?.id === s.id ? `${lateOf(s)}ms` : s.name}</b>
              </i>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

/** The selected keyframe: where it is, its value, its easing (to the next one). */
function KeyEditor(props: { k: NonNullable<MotionOpen["key"]>; at: number; readOnly: boolean; easings: string[] }) {
  const pop = usePop()
  let curve!: HTMLButtonElement
  const prop = () => props.k.prop
  const ease = () => props.k.ease || props.k.dflt
  return (
    <div class="mdock-kb">
      <Field
        class="num"
        attr="kat"
        value={String(props.at)}
        label="Where, in % of the keyframes"
        disabled={props.readOnly}
        inputmode="decimal"
        ok={(x) => x.trim() !== "" && Number(x) >= 0 && Number(x) <= 100}
        onDone={(x) => send({ type: "key", what: "at", value: x, done: true })}
        onEsc={() => send({ type: "select", key: null })}
      />
      <span class="mdock-unit">%</span>
      <Show
        when={prop() !== null}
        fallback={
          <>
            <span class="mdock-p">{props.k.props} properties</span>
            <span class="mdock-sp" />
          </>
        }
      >
        <span class="mdock-p">{prop()}</span>
        <Field
          class="val"
          attr="kval"
          value={props.k.value ?? ""}
          label={`${prop()} at ${props.at}%`}
          disabled={props.readOnly}
          ok={(x) => x.trim() !== "" && x.length <= 400 && CSS.supports(prop()!, x.trim())}
          onInput={(x) => send({ type: "key", what: "val", value: x, done: false })}
          onDone={(x) => send({ type: "key", what: "val", value: x, done: true })}
          onEsc={() => send({ type: "select", key: null })}
        />
      </Show>
      <Show when={!props.k.last}>
        <Field
          class="ease"
          attr="kease"
          value={props.k.ease}
          placeholder={props.k.dflt}
          label="Easing to the next keyframe"
          disabled={props.readOnly}
          ok={(x) => x.trim() === "" || easingOk(x)}
          list={() => props.easings}
          curves
          onInput={(x) => send({ type: "key", what: "ease", value: x, done: false })}
          onDone={(x) => send({ type: "key", what: "ease", value: x, done: true })}
          onEsc={() => send({ type: "select", key: null })}
        />
        <button
          type="button"
          class="icon-btn mdock-cvb"
          ref={curve}
          disabled={props.readOnly}
          title="Easing"
          aria-label="Easing"
          onClick={() =>
            pop.toggle({
              anchor: curve,
              kind: "ease",
              body: () => (
                <div class="mdock-ez" role="listbox">
                  <For each={[...new Set([ease(), ...props.easings])]}>
                    {(x) => (
                      <button type="button" role="option" aria-selected={x === ease()} classList={{ on: x === ease() }} onClick={() => send({ type: "key", what: "ease", value: x, done: true })}>
                        <Curve easing={x} />
                        {x}
                      </button>
                    )}
                  </For>
                </div>
              ),
            })
          }
        >
          <Curve easing={ease()} />
        </button>
      </Show>
      <Show when={!props.readOnly}>
        <button type="button" class="icon-btn" title={`Delete (${mac() ? "⌫" : "Delete"})`} aria-label="Delete this keyframe" onClick={() => send({ type: "removeKey" })}>
          <Icon name="trash" />
        </button>
      </Show>
    </div>
  )
}

/** The keyframes as text. What is typed goes to the page as it is typed when it is keyframes;
 *  why not, when it is not. Leaving the field is one undo step. */
function CssText(props: { open: MotionOpen }) {
  const [local, setLocal] = createSignal<string | null>(null)
  const [focused, setFocused] = createSignal(false)
  // (As a Field: removed with the caret in it, it hears a blur, and has nothing left to say.)
  let gone = false
  onCleanup(() => (gone = true))
  createEffect(() => {
    const l = local()
    if (l !== null && !focused() && l === props.open.css) setLocal(null)
  })
  return (
    <div class="mdock-css">
      <textarea
        class="mono thin-scroll"
        spellcheck={false}
        autocomplete="off"
        readOnly={!!props.open.readOnly}
        aria-label="The keyframes as code"
        value={local() ?? props.open.css}
        onFocus={(e) => {
          setFocused(true)
          setLocal(e.currentTarget.value)
        }}
        onInput={(e) => {
          setLocal(e.currentTarget.value)
          send({ type: "css", text: e.currentTarget.value, done: false })
        }}
        onBlur={(e) => {
          if (gone) return
          setFocused(false)
          if (!props.open.readOnly) send({ type: "css", text: e.currentTarget.value, done: true })
          setTimeout(() => !focused() && setLocal(null), HOLD_MS)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur()
          else if (e.key === "Enter" && isMod(e)) {
            e.preventDefault()
            e.currentTarget.blur()
            send({ type: "send", background: e.altKey })
          }
          e.stopPropagation()
        }}
      />
      <Show when={focused() && props.open.cssError}>
        <p class="mdock-err" role="alert">
          {props.open.cssError}
        </p>
      </Show>
    </div>
  )
}
