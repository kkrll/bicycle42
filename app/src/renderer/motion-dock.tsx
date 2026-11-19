// Motion mode's dock, drawn by the window (dock.tsx): the list of what moves on the page, and the
// open animation: its header (Keyframes | CSS, timing, how it plays while looking, undo), its
// timeline (the ruler and playhead, a lane of keyframes per property), the selected keyframe, the
// note and Send. It is motion mode's only dock (the overlay draws none of its own), drawn here so
// it can sit beside a phone-width page; the overlay keeps everything that touches the page.
//
// What it shows is the overlay's view (MotionView in overlay/protocol-motion.ts), whole each
// time; what the reviewer does goes back as acts (MotionAct). It keeps nothing of the page's.
// What it does keep, it keeps only while the reviewer's hand is on it, so the window never waits
// on the page:
//  - a field being typed in shows what is typed, not what the view says, until it is left and the
//    view has caught up (Field);
//  - a keyframe being dragged and the playhead being scrubbed are drawn where the pointer is, and
//    the view takes over again once it agrees or soon after they are let go (`drag`, `scrub`).
// Popovers (the "more" sheet, the easings, a field's list) stay inside the dock's own box: the
// page is a native view that paints over the window wherever it sits, so anything over it would
// be hidden.
import "./motion-dock.css"
import { For, Show, createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js"
import type { MotionAct, MotionKind, MotionLane, MotionOpen, MotionView } from "../../../overlay/protocol-motion"
import { Icon } from "./icons"
import { dockAct, dockPing, dockViews, keys, mac } from "./store"

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
  iso: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 2.25V6M12 18v3.75M2.25 12H6M18 12h3.75",
  undo: "M9 5.25 4.5 9.75l4.5 4.5M4.5 9.75h9.375a4.875 4.875 0 0 1 0 9.75H10.5",
  reset: "M3.75 12a8.25 8.25 0 1 0 2.4-5.85M3.75 3.75v4.5h4.5",
  more: "M5.25 12h.01M12 12h.01M18.75 12h.01",
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

type Pop = { anchor: HTMLElement; kind: "more" | "ease" | "list"; body: () => JSX.Element; wide?: boolean }
const PopContext = createContext<{ open(p: Pop | null): void; current(): Pop | null }>()

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
  const pop = useContext(PopContext)!
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
    if (!list.length || props.disabled) {
      if (pop.current()?.anchor === el) pop.open(null)
      return
    }
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
  onCleanup(() => pop.current()?.anchor === el && pop.open(null))
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
            pop.open(null)
            setTyped(false)
            setLocal(local() ?? props.value)
            // the list is closed; the next Esc leaves the field
            return void e.stopPropagation()
          }
          el.blur()
          props.onEsc?.()
        } else if (e.key === "Tab") pop.open(null)
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

export function MotionDock() {
  let root!: HTMLDivElement
  let tl: HTMLDivElement | undefined
  const [pop, setPop] = createSignal<Pop | null>(null)
  const [drag, setDrag] = createSignal<Drag | null>(null)
  const [scrub, setScrub] = createSignal<{ p: number; on: boolean } | null>(null)
  const [noteFocused, setNoteFocused] = createSignal(false)
  const [noteLocal, setNoteLocal] = createSignal<string | null>(null)
  /** A field to give the caret to once the view has it (after a keyframe, a lane or keyframes
   *  are added): its selector, and until when. */
  const [focusWant, setFocusWant] = createSignal<{ sel: string; until: number } | null>(null)
  const [rtt, setRtt] = createSignal<number[]>([])

  // A window that was reloaded has no view: the overlay is asked for one. And the way there and
  // back is measured, a few times (what a drag of a keyframe would wait for without `drag`).
  onMount(async () => {
    send({ type: "resend" })
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
  // The view caught up with the hand: it is drawn again.
  createEffect(() => {
    const d = drag(), o = open()
    if (!d || !d.done || !o) return
    const lane = d.prop === null ? null : o.lanes.find((l) => l.prop === d.prop)
    if (d.prop === null ? o.frames.includes(d.to) : lane?.keys.some((k) => k.at === d.to)) setDrag(null)
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
  const [popAt, setPopAt] = createSignal<{ left: number; top: number; max: number } | null>(null)
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
      const top = above >= hh + 8 || above > below ? a.top - box.top - 6 - hh : a.bottom - box.top + 6
      const leftWant = p.kind === "list" ? a.left - box.left : a.right - box.left - w
      setPopAt({ left: Math.min(Math.max(8, leftWant), box.width - w - 8), top: Math.max(8, top), max })
    })
  })
  const popCtx = { open: (p: Pop | null) => setPop(p), current: pop }
  const toggle = (p: Pop) => setPop((cur) => (cur && cur.anchor === p.anchor && cur.kind === p.kind ? null : p))
  // A press anywhere else closes the "more" sheet and the easings (a field's list closes itself).
  const outside = (e: PointerEvent) => {
    const p = pop(), t = e.target as Node
    if (p && p.kind !== "list" && !popEl?.contains(t) && !p.anchor.contains(t)) setPop(null)
  }
  onMount(() => document.addEventListener("pointerdown", outside, true))
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  // What it hangs from is gone (the header drawn without it): so is the popover.
  createEffect(() => {
    v()
    const p = pop()
    if (p && !p.anchor.isConnected) setPop(null)
  })

  // ── the timeline's pointer ──
  // Press a keyframe (the page shows that frame), drag it, press twice on a lane to add one, drag
  // the ruler or an empty lane to scrub: as in the overlay's own dock (tlDown in input.js).
  let last: { t: number; x: number; y: number } | null = null
  let gesture: "drag" | "scrub" | null = null
  const span = () => tl?.querySelector<HTMLElement>(".mdock-kspan") ?? tl?.querySelector<HTMLElement>("[data-ruler]") ?? null
  const atOf = (e: PointerEvent, free: boolean, s: HTMLElement) => {
    const r = s.getBoundingClientRect(), pad = s.classList.contains("mdock-kspan") ? 0 : 16
    const at = Math.min(100, Math.max(0, ((e.clientX - r.left - pad) / Math.max(1, r.width - 2 * pad)) * 100))
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
    if (!lane || lane.keys.some((k) => k.at === to && k.at !== d.from)) return null
    const lanes = d.lanes.map((l) => (l !== lane ? l : { ...l, keys: l.keys.map((k) => (k.at === d.from ? { ...k, at: to } : k)).sort((a, b) => a.at - b.at) }))
    return { lanes, frames: [...new Set(lanes.flatMap((l) => l.keys.map((k) => k.at)))].sort((a, b) => a - b) }
  }
  let base: Drag | null = null
  const tlDown = (e: PointerEvent) => {
    const o = open()
    if (e.button || !o || (e.target as HTMLElement).closest("input, button, textarea")) return
    const t = e.target as HTMLElement
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
  // space plays, ←/→ step (shift: ten times as far), Delete removes the keyframe, mod+Z and
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
                      classList={{ on: r.on, sub: r.sub, last: r.last, off: r.off, run: r.running }}
                      data-kind={r.kind}
                      data-row={r.id}
                      role="listitem"
                      aria-disabled={r.off}
                      title={r.sub ? "" : `${KIND_TITLE[r.kind]}${r.running ? ", playing" : ""}`}
                      onPointerEnter={() => rowsHover(r.id)}
                      onClick={() => !r.off && send({ type: "row", id: r.id })}
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
                    </button>
                  )
                }
              </For>
            </div>

            <div class="mdock-main">
              {/* the header: what is open, its timing, how it plays while looking, undo */}
              <Show when={open() || v()!.sel}>
                <div class="mdock-hd" classList={{ bare: !open() }}>
                  <button type="button" class="icon-btn mdock-back" title="Everything that moves" aria-label="Everything that moves" onClick={() => send({ type: "back" })}>
                    <Icon name="back" />
                  </button>
                  <Show when={open()}>
                    {(o) => <Header open={o()} view={v()!} onPop={toggle} />}
                  </Show>
                </div>
              </Show>

              <Show
                when={open() && v()!.view === "css"}
                fallback={
                  <div
                    class="mdock-tl thin-scroll"
                    classList={{ ro: ro() }}
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
                          pos={pos()}
                          playing={v()!.clock.playing}
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
                {(k) => <KeyEditor k={k()} at={selKey()?.at ?? k().at} readOnly={ro()} easings={v()!.choices.easings} onPop={toggle} />}
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
                    placeholder={open() ? (open()!.kind === "css" ? "Note… (optional)" : "Say what it should do…") : "Note…"}
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
                  title={canSend() ? `Send this animation to the agent (${keys("enter")}; ${keys("alt", "enter")}: in the background)` : open() ? "Change it, or say what it should do, first" : "Open an animation first"}
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
                visibility: popAt() ? "visible" : "hidden",
              }}
            >
              {p().body()}
            </div>
          )}
        </Show>
      </div>
    </PopContext.Provider>
  )
}

// ── the header ──────────────────────────────────────────────────────────────────────────────────

function Header(props: { open: MotionOpen; view: MotionView; onPop: (p: Pop) => void }) {
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
          CSS
        </button>
      </div>
      <div class="mdock-timing">
        <label class="mdock-tf">
          <span>Duration</span>
          <Field
            class="num"
            attr="tduration"
            value={String(t().duration)}
            disabled={ro()}
            inputmode="numeric"
            ok={numberOk(0)}
            onInput={(x) => send({ type: "timing", what: "duration", value: x, done: false })}
            onDone={(x) => send({ type: "timing", what: "duration", value: x, done: true })}
          />
          <span class="mdock-unit">ms</span>
        </label>
        <label class="mdock-tf">
          <span>Delay</span>
          <Field
            class="num"
            attr="tdelay"
            value={String(t().delay)}
            disabled={ro()}
            inputmode="numeric"
            ok={numberOk(-600000)}
            onInput={(x) => send({ type: "timing", what: "delay", value: x, done: false })}
            onDone={(x) => send({ type: "timing", what: "delay", value: x, done: true })}
          />
          <span class="mdock-unit">ms</span>
        </label>
        <label class="mdock-tf">
          <span>Easing</span>
          <Field
            class="ease"
            attr="teasing"
            value={t().easing}
            disabled={ro()}
            ok={easingOk}
            list={() => props.view.choices.easings}
            curves
            onInput={(x) => send({ type: "timing", what: "easing", value: x, done: false })}
            onDone={(x) => send({ type: "timing", what: "easing", value: x, done: true })}
          />
          <Curve easing={t().easing} />
        </label>
      </div>
      <button
        type="button"
        class="icon-btn"
        ref={more}
        title="More: repeat, direction, fill, what starts it"
        aria-label="More"
        onClick={() => props.onPop({ anchor: more, kind: "more", body: () => <MoreSheet open={props.open} view={props.view} /> })}
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
          class="icon-btn"
          aria-pressed={props.view.isolate}
          disabled={!props.view.sel}
          title="Show only this element"
          aria-label="Show only this element"
          onClick={() => send({ type: "isolate", on: !props.view.isolate })}
        >
          <MIcon name="iso" />
        </button>
      </div>
      <div class="mdock-tools">
        <button type="button" class="icon-btn" disabled={!props.view.undo} title={`Undo (${keys("mod", "Z")})`} aria-label="Undo" onClick={() => send({ type: "undo" })}>
          <MIcon name="undo" />
        </button>
        <button
          type="button"
          class="icon-btn"
          disabled={!props.open.dirty}
          title={props.open.removable ? "Remove this new animation" : "Put back as the page has it"}
          aria-label={props.open.removable ? "Remove this new animation" : "Put back as the page has it"}
          onClick={() => send({ type: "discard" })}
        >
          <MIcon name="reset" />
        </button>
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
              disabled={props.open.readOnly}
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
  pos: number | null
  playing: boolean
  flipped: boolean
  props: string[]
  onLane: () => void
}) {
  const T = () => props.open.T
  const ticks = createMemo(() => {
    const t = T(), major = MAJOR.find((m) => t / m <= 7) ?? 5000, minor = major / 5, out: Array<{ at: number; big: boolean; n: number }> = []
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
          <span class="mdock-time">{props.pos === null ? "" : Math.round(props.pos * T())}</span>
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
          <div class="mdock-trk mdock-gnote">
            <Show when={props.open.shared > 1}>
              <span
                class="mdock-shared"
                title={`These keyframes are played by ${props.open.shared} elements: a change to them changes all of them. Duration, delay and easing are this element's own.`}
              >
                <MIcon name="link" />
                {props.open.shared} elements
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
                          classList={{ on: on(k.at, lane.prop), flat: k.value === next().value }}
                          data-seg={k.at}
                          data-at={k.at}
                          data-prop={lane.prop}
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
                    {(k) => <i class="mdock-key gr" classList={{ on: on(k.at, lane.prop) }} style={{ "--at": k.at / 100 }} data-at={k.at} data-prop={lane.prop} title={k.value} />}
                  </For>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
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
        <Show when={props.pos !== null}>
          <div class="mdock-flag" style={{ "--x": props.pos! }}>
            <b>{secs(Math.round(props.pos! * T()))}</b>
          </div>
        </Show>
      </div>
    </>
  )
}

/** The selected keyframe: where it is, its value, its easing (to the next one). */
function KeyEditor(props: { k: NonNullable<MotionOpen["key"]>; at: number; readOnly: boolean; easings: string[]; onPop: (p: Pop) => void }) {
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
            props.onPop({
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
        aria-label="The keyframes as CSS"
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
