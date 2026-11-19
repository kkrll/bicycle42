// Edit mode's inspector, drawn by the window: the page's tree, the selection's classes, its
// Element styles, the batch's Global stylesheet and the selection's computed values, beside a
// phone's page or under a desktop's (dock.tsx). What it shows is the overlay's view
// (dockViews.canvas: CanvasView in overlay/protocol-canvas.ts); what is done in it goes to the
// overlay as an act (CanvasAct), which does it to the page with the same functions as the
// overlay's own inspector. Nothing of the page's is kept here.
//
// Typing never waits for the page: a field being typed in holds its own text and sends it whole
// with every key; the view answers with the marks, the error line and the computed values, and
// the field takes the view's text once it is left (or at once after an undo: `force`). The
// suggestions are worked out here, from the overlay's pure suggestion code and this window's own
// CSS.supports (the same Chromium as the page's), with the page's variables from the view; only
// showing a value on the page while the arrows go through the list is an act. A scrub, and ↑/↓ on
// a number, show the new value here at once and send it; the page follows within its next frame.
//
// The page view paints over everything in its box, so nothing here may reach over it: the
// suggestion list opens inside the inspector's own box, under or above the caret, and so does the
// keys list.
//
// The footer is the bar the overlay draws over the page when the inspector is its own (the
// overlay draws none while this one is up): how many edits, undo, redo, Reset, the note's words,
// Send and what happened to the note sent last (the view's `batch`). The note's words are the
// overlay's too, sent with every key, as Motion's are: they go with the batch and come back with
// a refused one. Send is a "send" act, which main lets through to the page (admitNote).
//
// The header names what is selected (its component, or tag#id.class), never what it says. The
// tree and the styles share the body by a handle between them, kept (canvas.tree.h above the
// styles, canvas.tree.w beside them).
import { For, Index, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { CanvasAct, CanvasComputed, CanvasText, CanvasView } from "../../../overlay/protocol-canvas"
import { editKeys } from "../../../overlay/src/canvas/help.js"
import { CSS_PROPS } from "../../../overlay/src/canvas/css-data.js"
import { numberAt, step as stepNumber, stepSize } from "../../../overlay/src/canvas/number.js"
import {
  caretContext,
  isNumber,
  matches,
  propNames,
  scaleOf,
  step as stepKeyword,
  valueContext,
  valuesAt,
  valuesOf,
  varToken,
  wants,
  WIDE,
  withVars,
} from "../../../overlay/src/canvas/suggest-model.js"
import { Icon, Kbd } from "./icons"
import { dockAct, dockViews, keys, mac, recall, remember, state } from "./store"
import "./canvas-dock.css"

/** A tree row's height, px. The overlay is told how many rows show; it sends those and a screenful around. */
const ROW = 22
/** Rows of the suggestion list in view (PageUp/PageDown move this far). */
const LIST_ROWS = 8

/** How long a note just sent stays empty here before the view's words are shown again (ms): a
 *  refused one brings its words back. */
const HOLD_MS = 600
/** The tree's least share of the body, and the styles' (px): a few rows, a field and its label. */
const TREE_MIN = { h: 66, w: 160 }
const SIDE_MIN = { h: 120, w: 220 }
/** A step of the handle's arrows, px. */
const GRIP_STEP = 16

/** The few icons only the inspector's footer uses, on the 24 grid of icons.tsx. */
const FPATHS = {
  undo: "M9 5.25 4.5 9.75l4.5 4.5M4.5 9.75h9.375a4.875 4.875 0 0 1 0 9.75H10.5",
  redo: "M15 5.25l4.5 4.5-4.5 4.5M19.5 9.75h-9.375a4.875 4.875 0 0 0 0 9.75H13.5",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.4 9.2a2.7 2.7 0 0 1 5.25.9c0 1.8-2.65 2.25-2.65 4.05M12 17.25v.01",
} as const
function FIcon(props: { name: keyof typeof FPATHS }) {
  return (
    <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={FPATHS[props.name]} />
    </svg>
  )
}

const send = (act: CanvasAct) => dockAct({ panel: "canvas", act })
const supports = (prop: string, value: string) => {
  try {
    return CSS.supports(prop, value.replace(/!\s*important\s*$/i, "").trim())
  } catch {
    return false
  }
}
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "") // tabs and line breaks stay
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
const modKey = (e: KeyboardEvent | MouseEvent) => (mac() ? e.metaKey : e.ctrlKey)

// What the browser takes is asked once: the property names, a property's keywords, which
// keywords are colours (for their swatch).
const ASKED = { names: [] as string[], values: new Map<string, string[]>(), colours: new Map<string, boolean>() }
const propertyNames = () => (ASKED.names.length ? ASKED.names : (ASKED.names = propNames(CSS_PROPS).filter((n: string) => supports(n, "initial"))))
function valuesFor(prop: string): string[] {
  let v = ASKED.values.get(prop)
  if (!v) ASKED.values.set(prop, (v = valuesOf(prop, CSS_PROPS, supports) as string[]))
  return v
}
function isColour(kw: string): boolean {
  let c = ASKED.colours.get(kw)
  if (c === undefined) ASKED.colours.set(kw, (c = kw !== "currentcolor" && !WIDE.includes(kw) && supports("color", kw)))
  return c
}

type TextKind = "classes" | "css" | "sheet"
type Ctx = ReturnType<typeof caretContext>
/** The open suggestion list: which field, what it offers, and what an item replaces. */
type List = {
  field: HTMLInputElement | HTMLTextAreaElement
  /** A computed row's property, when the field is one. */
  row: string
  kind: "name" | "value"
  prop: string
  items: string[]
  on: number
  s: number
  e: number
  colon: boolean
  vars: Map<string, string>
  /** An item is being shown on the page; what was typed there, the caret, and (a computed row)
   *  the element's styles and the row's value before it. */
  live: boolean
  typed: string
  caret: number
  css: string
  was: string
  at: { x: number; y: number; up: boolean; max: number }
}

export function CanvasDock() {
  const view = () => dockViews.canvas as CanvasView | undefined
  const sel = () => view()?.sel ?? null
  const global = () => view()?.global ?? true

  // ── fields: the text being typed is ours until the view has it ──────────────────────────────
  // `local` is a field's text while it is typed in, and after it is left until the view says the
  // same (or a second passed: the page may have made something else of it). `editing`: focused.
  const [local, setLocal] = createStore<Record<TextKind, string | null>>({ classes: null, css: null, sheet: null })
  const [editing, setEditing] = createStore<Record<TextKind, boolean>>({ classes: false, css: false, sheet: false })
  const viewText = (k: TextKind) => (k === "classes" ? view()?.classes.text : view()?.[k].text) ?? ""
  const shown = (k: TextKind) => local[k] ?? viewText(k)
  const settle: Record<TextKind, number> = { classes: 0, css: 0, sheet: 0 }
  createEffect(() => {
    for (const k of ["classes", "css", "sheet"] as const) if (!editing[k] && local[k] !== null && local[k] === viewText(k)) setLocal(k, null)
  })
  // Undo, redo, a value set, a drag on the page: the batch's text wins, typed or not.
  // (A value just written from the computed list is shown as written until the view has it.)
  createEffect(on(() => view()?.force, () => batch(() => {
    setLocal({ classes: null, css: null, sheet: null })
    setVal((v) => (v?.until ? v : null))
  }), { defer: true }))

  const els: { classes?: HTMLInputElement; css?: HTMLTextAreaElement; sheet?: HTMLTextAreaElement } = {}
  /** The field's text as the page should have it now (from typing, or text put in by a key). */
  function typed(k: TextKind, hold = false) {
    const f = els[k]
    if (!f) return
    const v = clean(f.value)
    if (v !== f.value) {
      const at = (f.selectionStart ?? v.length) - (f.value.length - v.length)
      f.value = v
      f.setSelectionRange(at, at)
    }
    setLocal(k, v)
    if (k !== "sheet" && !sel()) return
    send({ type: "text", field: k, text: v, ...(k === "sheet" ? {} : { id: sel()!.id }), ...(hold ? { hold: true } : {}) })
  }
  const focusField = (k: TextKind) => setEditing(k, true)
  function leaveField(k: TextKind) {
    setEditing(k, false)
    closeList()
    if (local[k] === null) return
    send({ type: "commit" }) // the typing's step closes now, as when the overlay's own field is left
    clearTimeout(settle[k])
    settle[k] = window.setTimeout(() => !editing[k] && setLocal(k, null), 1000)
  }

  // ── computed values ──────────────────────────────────────────────────────────────────────────
  // The one being typed in (or stepped, or scrubbed), with its text; and those the browser refused,
  // marked until the selection changes or they are edited.
  const [val, setVal] = createSignal<{ prop: string; text: string; until?: number } | null>(null)
  const [bad, setBad] = createStore<Record<string, string>>({})
  createEffect(on(() => sel()?.id, () => batch(() => {
    setVal(null)
    setBad(Object.fromEntries(Object.keys(bad).map((k) => [k, undefined as unknown as string])))
  }), { defer: true }))
  /** Shown as written for a moment, until the view has the page's value for it. */
  const written = (prop: string, text: string) => {
    const until = Date.now() + 600
    setVal({ prop, text, until })
    setTimeout(() => setVal((v) => (v?.until === until ? null : v)), 650)
  }
  const valueShown = (row: CanvasComputed) => {
    const v = val()
    if (v && v.prop === row.prop && (!v.until || Date.now() < v.until)) return v.text
    return bad[row.prop] ?? row.value
  }
  /** `prop: value` into Element styles, an undo step; refused values are marked, not sent. */
  function setValue(row: CanvasComputed, text: string): boolean {
    const v = oneLine(clean(text))
    if (!v || v === row.value || !sel()) {
      setBad(row.prop, undefined as unknown as string)
      setVal(null)
      return false
    }
    if (!supports(row.prop, v)) {
      setBad(row.prop, v)
      setVal(null)
      return false
    }
    setBad(row.prop, undefined as unknown as string)
    send({ type: "value", id: sel()!.id, prop: row.prop, value: v })
    written(row.prop, v)
    return true
  }
  /** A step of ↑/↓ or of a scrub: live, as typing is. */
  function liveValue(row: CanvasComputed, text: string, hold = false) {
    setVal({ prop: row.prop, text })
    const v = oneLine(clean(text))
    if (!sel() || !v || !supports(row.prop, v)) return
    send({ type: "value", id: sel()!.id, prop: row.prop, value: v, live: true, ...(hold ? { hold: true } : {}) })
  }
  const rowOf = (prop: string) => view()?.computed.find((r) => r.prop === prop)

  // ── scrubbing: a drag on a computed row's name ──────────────────────────────────────────────
  // One unit a pixel (shift ten, alt a tenth); under three pixels it is a click, which copies the
  // value into Element styles. The whole drag is one undo step; Esc puts the value back.
  let scrub: { prop: string; id: number; x: number; last: number; acc: number; on: boolean; text: string; token: ReturnType<typeof numberAt> } | null = null
  let scrubbed = false
  function scrubDown(e: PointerEvent, row: CanvasComputed) {
    scrubbed = false
    if (e.button !== 0 || !sel()) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    scrub = { prop: row.prop, id: e.pointerId, x: e.clientX, last: e.clientX, acc: 0, on: false, text: "", token: null }
  }
  function scrubMove(e: PointerEvent) {
    const d = scrub
    if (!d || e.pointerId !== d.id) return
    const row = rowOf(d.prop)
    if (!row) return
    if (!d.on) {
      if (Math.abs(e.clientX - d.x) < 3) return
      d.text = valueShown(row)
      d.token = numberAt(d.text, 0, { first: true })
      if (!d.token) return void scrubEnd(e) // no number: the click copies the line
      send({ type: "commit" }) // what was typed before is a step of its own
      d.on = true
      ;(e.currentTarget as HTMLElement).classList.add("scrubbing")
    }
    d.acc += (e.clientX - d.last) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
    d.last = e.clientX
    liveValue(row, d.text.slice(0, d.token!.start) + stepNumber(d.token, d.acc) + d.text.slice(d.token!.end), true)
  }
  function scrubEnd(e: PointerEvent) {
    const d = scrub
    if (!d || e.pointerId !== d.id) return
    scrub = null
    const btn = e.currentTarget as HTMLElement
    btn.classList.remove("scrubbing")
    if (btn.hasPointerCapture(d.id)) btn.releasePointerCapture(d.id)
    scrubbed = d.on
    if (!d.on) return
    send({ type: "commit" })
    const v = val()
    if (v) written(v.prop, v.text)
  }
  /** Esc during a scrub: the value from before it. */
  function cancelScrub(): boolean {
    const d = scrub
    if (!d || !d.on) return false
    scrub = null
    scrubbed = true
    document.querySelector(".cd-cp.scrubbing")?.classList.remove("scrubbing")
    send({ type: "revert" })
    setVal(null)
    return true
  }

  // ── suggestions ─────────────────────────────────────────────────────────────────────────────
  const [list, setList] = createSignal<List | null>(null)
  let rootEl!: HTMLDivElement
  let listEl: HTMLDivElement | undefined
  const isArea = (f: Element | null): f is HTMLTextAreaElement => f === els.css || f === els.sheet
  const rowProp = (f: Element | null) => (f instanceof HTMLInputElement && f.dataset.prop) || ""

  function contextOf(f: HTMLInputElement | HTMLTextAreaElement): Ctx {
    const p = rowProp(f)
    if (p) return valueContext(p, f.value, f.selectionEnd ?? f.value.length)
    if (f.selectionStart !== f.selectionEnd) return { kind: "none" }
    return caretContext(f.value, f.selectionStart ?? 0, f === els.sheet)
  }
  function varsFor(prop: string): Map<string, string> {
    const out = new Map<string, string>()
    for (const t of view()?.tokens ?? []) if (supports(prop, t.value)) out.set(`var(${t.name})`, t.value)
    return out
  }

  /** Open the list for what is at the caret, or change it; close it when there is nothing to offer. */
  function showList(f: HTMLInputElement | HTMLTextAreaElement, asked: boolean) {
    const ctx = contextOf(f)
    if (!wants(ctx, asked)) return closeList()
    let all: string[]
    let vars = new Map<string, string>()
    if (ctx.kind === "name") all = propertyNames()
    else {
      vars = varsFor(ctx.prop!)
      const names = [...vars.keys()]
      all = ctx.inVar || ctx.word!.startsWith("--") ? names : (withVars(valuesAt(valuesFor(ctx.prop!), f.value, ctx), names) as string[])
    }
    const items = matches(all, ctx.word!) as string[]
    if (!items.length || (!asked && items.length === 1 && items[0] === ctx.word)) return closeList()
    const was = list()
    if (was && was.field !== f) closeList()
    setList({
      field: f, row: rowProp(f), kind: ctx.kind as "name" | "value", prop: ctx.prop ?? "", items, on: 0, s: ctx.s!, e: ctx.e!, colon: !!ctx.colon, vars,
      live: false, typed: "", caret: 0, css: "", was: "", at: placeOf(f, ctx.s!),
    })
    if (listEl) listEl.scrollTop = 0
  }

  /** Where the list goes: under the caret (a text box: where the token starts) or the field, inside
   *  the inspector's box; above it when there is less room below. */
  function placeOf(f: HTMLInputElement | HTMLTextAreaElement, s: number): List["at"] {
    const box = rootEl.getBoundingClientRect()
    const fr = f.getBoundingClientRect()
    let left = fr.left, top = fr.top, bottom = fr.bottom
    const at = isArea(f) ? caretRect(f, s) : null
    if (at) {
      left = at.left
      top = Math.min(Math.max(at.top, fr.top), fr.bottom)
      bottom = Math.min(Math.max(at.bottom, fr.top), fr.bottom)
    }
    const below = box.bottom - bottom - 6, above = top - box.top - 6
    const up = below < 120 && above > below
    return {
      x: Math.max(4, Math.min(left - box.left - (at ? 9 : 5), box.width - 220)),
      y: up ? box.bottom - top + 3 : bottom - box.top + 3,
      up,
      max: Math.max(48, Math.min(LIST_ROWS * 22 + 8, up ? above : below)),
    }
  }
  /** Where the letter at `offset` of a text box is, from the layer under it that mirrors its text. */
  function caretRect(area: HTMLTextAreaElement, offset: number): DOMRect | null {
    const layer = area.previousElementSibling
    if (!layer || layer.textContent !== `${area.value}\n`) return null
    const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    let left = offset
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const len = n.nodeValue!.length
      if (left < len) {
        const r = document.createRange()
        r.setStart(n, left)
        r.setEnd(n, left + 1)
        const rect = r.getClientRects()[0] ?? r.getBoundingClientRect()
        return rect.height || rect.width ? rect : null
      }
      left -= len
    }
    return null
  }

  function closeList() {
    const l = list()
    if (!l) return
    setList(null)
    if (l.live) send({ type: "commit" }) // what was shown stays: one step
  }

  /** Text in place of a field's token, the caret after it, and the page told as typing tells it. */
  function put(f: HTMLInputElement | HTMLTextAreaElement, s: number, e: number, text: string, hold: boolean) {
    f.setRangeText(text, s, e, "end")
    const p = rowProp(f)
    if (p) {
      const row = rowOf(p)
      if (row) liveValue(row, f.value, hold)
    } else typed(f === els.sheet ? "sheet" : "css", hold)
  }

  function highlight(i: number) {
    const l = list()
    if (!l) return
    const n = l.items.length
    const to = ((i % n) + n) % n
    setList({ ...l, on: to })
    const row = listEl?.children[to] as HTMLElement | undefined
    if (row && listEl) {
      if (row.offsetTop < listEl.scrollTop + 4) listEl.scrollTop = row.offsetTop - 4
      else if (row.offsetTop + row.offsetHeight > listEl.scrollTop + listEl.clientHeight - 4) listEl.scrollTop = row.offsetTop + row.offsetHeight - listEl.clientHeight + 4
    }
    if (l.kind === "value") preview(l.items[to]!)
  }

  /** Show the highlighted value on the page in place of what was typed. Not an undo step until the list closes. */
  function preview(v: string) {
    const l = list()!
    const f = l.field
    const first = !l.live
    const next = { ...l, live: true }
    if (first) {
      next.typed = f.value.slice(l.s, l.e)
      next.caret = f.selectionEnd ?? 0
      next.css = view()?.css.text ?? ""
      next.was = l.row ? (rowOf(l.row)?.value ?? "") : ""
    }
    if (l.row) {
      f.setRangeText(v, l.s, l.e, "end")
      setVal({ prop: l.row, text: f.value })
      // A row's own value, come to on the way through the list, is not a change: nothing is declared for it.
      if (oneLine(f.value) === next.was) send({ type: "text", field: "css", id: sel()?.id ?? 0, text: next.css, hold: true })
      else liveValue(rowOf(l.row)!, f.value, true)
    } else put(f, l.s, l.e, v, true)
    next.e = l.s + v.length
    setList(next)
  }

  /** Escape: what was typed is back, in the field and on the page. */
  function revertList() {
    const l = list()
    if (!l || !l.live) return
    setList({ ...l, live: false })
    const f = l.field
    f.setRangeText(l.typed, l.s, l.e, "end")
    f.setSelectionRange(l.caret, l.caret)
    if (l.row) {
      setVal({ prop: l.row, text: f.value })
      send({ type: "text", field: "css", id: sel()?.id ?? 0, text: l.css })
    } else typed(f === els.sheet ? "sheet" : "css")
  }

  function accept(i: number) {
    const l = list()
    const item = l?.items[i]
    if (!l || item === undefined) return
    const f = l.field
    if (l.kind === "name") {
      setList(null)
      f.setRangeText(l.colon ? item : `${item}: `, l.s, l.e, "end")
      typed(f === els.sheet ? "sheet" : "css")
      if (!l.colon) showList(f, true) // its values, at once
      return
    }
    setList(null)
    f.setRangeText(item, l.s, l.e, "end")
    if (l.row) {
      const row = rowOf(l.row)
      if (row) setValue({ ...row, value: l.live ? l.was : row.value }, f.value)
      send({ type: "commit" })
    } else {
      typed(f === els.sheet ? "sheet" : "css")
      send({ type: "commit" })
    }
  }

  /** ↑/↓ with the list closed on a keyword (or a `var(--name)`): the next one, live. In a text box
   *  only one that is selected; in a computed row the one at the caret. */
  function cycle(f: HTMLInputElement | HTMLTextAreaElement, dir: 1 | -1): boolean {
    const area = isArea(f)
    const [a, b] = area ? picked(f) : [f.selectionEnd ?? f.value.length, f.selectionEnd ?? f.value.length]
    if (!area || a !== b) {
      const v = varToken(f.value, a, b)
      if (v) return walkScale(f, { s: v.s, e: v.e, name: v.name ?? "" }, -dir as 1 | -1, area) // (↑ is up the scale, as for a number; in a list it is back)
    }
    let ctx: Ctx
    if (area) {
      if (a === b) return false
      ctx = caretContext(f.value, b, f === els.sheet)
      if (ctx.kind !== "value" || a < ctx.s! || b > ctx.e!) return false
    } else ctx = contextOf(f)
    if (ctx.kind !== "value") return false
    const token = f.value.slice(ctx.s, ctx.e)
    if (!token || isNumber(token)) return false
    const next = stepKeyword(valuesAt(valuesFor(ctx.prop!), f.value, ctx), token, dir) as string | null
    if (!next) return false
    if (area) {
      f.setRangeText(next, ctx.s!, ctx.e!, "select")
      typed(f === els.sheet ? "sheet" : "css")
    } else put(f, ctx.s!, ctx.e!, next, false)
    return true
  }
  function walkScale(f: HTMLInputElement | HTMLTextAreaElement, v: { s: number; e: number; name: string }, dir: 1 | -1, area: boolean): boolean {
    const p = rowProp(f)
    const ctx = p ? caretContext(`${p}:${f.value}`, p.length + 1 + v.s, false) : caretContext(f.value, v.s, f === els.sheet)
    if (ctx.kind !== "value") return true
    const tokens = view()?.tokens ?? []
    const sizes = new Map(tokens.map((t) => [t.value, t.size ?? NaN]))
    const scale = scaleOf(tokens, v.name, (value: string) => supports(ctx.prop!, value), (value: string) => sizes.get(value) ?? NaN) as string[]
    const next = scale[scale.indexOf(v.name) + dir]
    if (!next) return true
    const text = `var(${next})`
    if (area) {
      f.setRangeText(text, v.s, v.e, "select")
      typed(f === els.sheet ? "sheet" : "css")
    } else {
      put(f, v.s, v.e, text, false)
      f.setSelectionRange(v.s, v.s + text.length)
    }
    return true
  }
  /** What is selected in a text box, less the spaces around it. */
  function picked(area: HTMLTextAreaElement): [number, number] {
    const text = area.value
    let a = area.selectionStart, b = area.selectionEnd
    while (a < b && /\s/.test(text[a]!)) a++
    while (b > a && /\s/.test(text[b - 1]!)) b--
    return [a, b]
  }
  /** ↑/↓ on a number: it moves by `delta`, its unit kept (in a text box only a selected one). */
  function stepField(f: HTMLInputElement | HTMLTextAreaElement, delta: number): boolean {
    const area = isArea(f)
    const text = f.value
    const [a, b] = area ? picked(f) : [f.selectionStart ?? 0, f.selectionEnd ?? 0]
    if (area && a === b) return false
    const t = numberAt(text, a, { to: b, context: f === els.sheet ? "sheet" : area ? "css" : "value", first: !area })
    if (!t) return false
    const next = stepNumber(t, delta)
    if (area) {
      f.setRangeText(next, t.start, t.end, "select")
      typed(f === els.sheet ? "sheet" : "css")
    } else {
      const row = rowOf(rowProp(f))
      if (row) liveValue(row, text.slice(0, t.start) + next + text.slice(t.end))
      f.value = text.slice(0, t.start) + next + text.slice(t.end)
      f.setSelectionRange(t.start, t.start + next.length)
    }
    return true
  }

  /** A key in a field that the list has the first say on. True when it was taken. */
  function listKey(e: KeyboardEvent, f: HTMLInputElement | HTMLTextAreaElement): boolean {
    if (e.isComposing) return false
    const k = e.key, plain = !e.ctrlKey && !e.metaKey && !e.altKey
    const arrow = k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0
    const l = list()
    if (l && l.field !== f) closeList()
    if (l && l.field === f) {
      if (arrow && plain && !e.shiftKey) {
        highlight(l.on + arrow)
        return true
      }
      if ((k === "PageDown" || k === "PageUp") && plain && !e.shiftKey) {
        highlight(Math.max(0, Math.min(l.items.length - 1, l.on + (k === "PageDown" ? LIST_ROWS : -LIST_ROWS))))
        return true
      }
      if ((k === "Enter" || k === "Tab") && plain && !e.shiftKey) {
        // Enter after a whole keyword that longer ones start with is the new line it is elsewhere.
        if (k === "Enter" && !l.row && l.kind === "value" && !l.live && l.on === 0 && f.value.slice(l.s, l.e).toLowerCase() === l.items[0]) {
          closeList()
          return false
        }
        accept(l.on)
        return true
      }
      if (k === "Escape") {
        revertList()
        closeList()
        return true
      }
      if ((!plain && !/^(Control|Meta|Alt|Shift)$/.test(k)) || /^(Enter|Tab|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(k)) closeList()
      return false
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Space" || k === " ")) {
      showList(f, true)
      return true
    }
    if (arrow && plain && !e.shiftKey && cycle(f, arrow as 1 | -1)) return true
    return false
  }

  /** Every key in the inspector: the fields', the tree's, and the inspector's own. */
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement
    const f = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ? t : null
    const valueRow = rowProp(f)
    const textField = f && (isArea(f) || valueRow) ? f : null
    if (textField && listKey(e, textField)) return void e.preventDefault()
    if (e.key === "Escape") {
      e.preventDefault()
      if (cancelScrub()) return
      if (valueRow && f) {
        setVal(null)
        setBad(valueRow, undefined as unknown as string)
        f.blur()
      } else if (f) f.blur()
      else if (t.closest(".cd-tree, .cd-tab, .cd-fold")) t.blur()
      else send({ type: "escape" })
      return
    }
    if (e.key === "Enter" && !e.isComposing) {
      // In a field Enter is a new line (in the class line and a value: "done"); mod+Enter sends.
      if (modKey(e)) {
        e.preventDefault()
        if (valueRow && f) {
          const row = rowOf(valueRow)
          if (row) setValue(row, f.value)
        }
        send({ type: "send", ...(e.altKey ? { bg: true } : {}) })
      } else if (f === els.classes) {
        e.preventDefault()
        send({ type: "commit" })
      } else if (valueRow && f) {
        e.preventDefault()
        const row = rowOf(valueRow)
        if (row) setValue(row, f.value)
      } else if (!f && !t.closest("button") && !e.shiftKey) {
        e.preventDefault()
        send({ type: "send", ...(e.altKey ? { bg: true } : {}) })
      }
      return
    }
    if (textField && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.isComposing) {
      // ↑/↓ step a number, as in DevTools: 1; shift 10; alt 0.1; mod 100.
      const by = stepSize({ shift: e.shiftKey, alt: e.altKey, mod: modKey(e) }) * (e.key === "ArrowUp" ? 1 : -1)
      if (stepField(textField, by) || valueRow) return void e.preventDefault()
    }
    if (modKey(e) && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault()
      send({ type: e.shiftKey ? "redo" : "undo" })
      if (valueRow) {
        // The field shows what the page has after it, not the text just taken back.
        setVal(null)
        setBad(valueRow, undefined as unknown as string)
      }
      return
    }
    if (isArea(f) && e.key === "Tab" && !e.shiftKey && !modKey(e)) {
      e.preventDefault()
      f.setRangeText("  ", f.selectionStart, f.selectionEnd, "end")
      typed(f === els.sheet ? "sheet" : "css")
      return
    }
    if (f) return
    if (t.classList.contains("cd-tree")) {
      if (/^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
        e.preventDefault()
        send({ type: "walk", key: e.key as "ArrowUp" })
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel()) {
        e.preventDefault()
        send({ type: "hide" })
      } else if (modKey(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "d" && sel()) {
        e.preventDefault()
        send({ type: "duplicate" })
      }
    }
  }
  function onInput(e: InputEvent) {
    const f = e.target as HTMLInputElement | HTMLTextAreaElement
    if (e.isComposing) return
    if (f === els.classes) return typed("classes")
    const p = rowProp(f)
    if (p) {
      setVal({ prop: p, text: f.value })
      setBad(p, undefined as unknown as string)
    } else if (isArea(f)) typed(f === els.sheet ? "sheet" : "css")
    else return
    // Typing opens the list; anything else that changes the text only changes a list that is open.
    const typing = e.inputType === "insertText" || e.inputType === "insertCompositionText" || e.inputType === "insertReplacementText"
    const l = list()
    if (!typing && l?.field !== f) return
    if (l?.live) setList({ ...l, live: false }) // typed over a value being shown: that is what was typed now
    showList(f, false)
  }

  // ── the tree ────────────────────────────────────────────────────────────────────────────────
  let treeEl!: HTMLDivElement
  let shownRows = { first: -1, count: 0 }
  let treeRaf = 0
  /** Tell the overlay which rows show: it sends those, and a screenful around them. */
  function reportRows(force = false) {
    treeRaf = 0
    if (!treeEl) return
    const first = Math.floor(treeEl.scrollTop / ROW), count = Math.max(1, Math.ceil(treeEl.clientHeight / ROW) + 1)
    if (!force && first === shownRows.first && count === shownRows.count) return
    shownRows = { first, count }
    send({ type: "tree", first, count })
  }
  const onTreeScroll = () => {
    if (!treeRaf) treeRaf = requestAnimationFrame(() => reportRows())
  }
  onMount(() => {
    const ro = new ResizeObserver(onTreeScroll)
    ro.observe(treeEl)
    reportRows(true) // (and the overlay sends the whole view again: this inspector may be new)
    onCleanup(() => {
      ro.disconnect()
      cancelAnimationFrame(treeRaf)
      send({ type: "hover", id: 0 })
    })
  })
  // A new selection out of view: its row to the middle (the overlay sent the rows for that).
  createEffect(on(() => sel()?.id, () => {
    const t = view()?.tree
    if (!t || t.sel < 0 || !treeEl) return
    const top = treeEl.scrollTop / ROW, rows = treeEl.clientHeight / ROW
    if (t.sel < top || t.sel + 1 > top + rows) treeEl.scrollTop = Math.max(0, t.sel - Math.floor(shownRows.count / 2)) * ROW
  }))
  let hoverId = 0
  const hoverRow = (id: number) => {
    if (id === hoverId) return
    hoverId = id
    send({ type: "hover", id })
  }

  // ── the inspector folded to its header (under the page only: beside a phone's it is the column) ──
  const [shut, setShut] = createSignal(recall("canvas.shut") === "1")
  const folded = () => shut() && state.page.device !== "phone"
  const fold = () => {
    setShut(!shut())
    remember("canvas.shut", shut() ? "1" : "0")
  }

  const sheetRules = () => !!view()?.sheet.text.trim()

  // ── the handle between the tree and the styles ─────────────────────────────────────────────
  // Above the styles (the column, a narrow dock) it sets the tree's height, beside them its width;
  // which is the shape the inspector's own size asks for (container queries in canvas-dock.css).
  // Unset, the tree takes its share (38% above, 44% or a third beside); CSS keeps a kept size
  // inside the body as it changes.
  let bodyEl!: HTMLDivElement
  const [stacked, setStacked] = createSignal(false)
  const [treeH, setTreeH] = createSignal<number | undefined>(Number(recall("canvas.tree.h")) || undefined)
  const [treeW, setTreeW] = createSignal<number | undefined>(Number(recall("canvas.tree.w")) || undefined)
  const axis = () => (stacked() ? ("h" as const) : ("w" as const))
  const limits = () => {
    const a = axis(), b = bodyEl.getBoundingClientRect()
    return { min: TREE_MIN[a], max: Math.max(TREE_MIN[a], (a === "h" ? b.height : b.width) - SIDE_MIN[a]) }
  }
  const treeSize = () => {
    const r = treeEl.getBoundingClientRect()
    return Math.round(axis() === "h" ? r.height : r.width)
  }
  const [gripNow, setGripNow] = createSignal(0)
  const setTree = (px: number | undefined, keep = true) => {
    const a = axis()
    const v = px === undefined ? undefined : Math.round(Math.min(limits().max, Math.max(limits().min, px)))
    ;(a === "h" ? setTreeH : setTreeW)(v)
    if (keep) remember(a === "h" ? "canvas.tree.h" : "canvas.tree.w", v === undefined ? "" : String(v))
    requestAnimationFrame(() => treeEl && setGripNow(treeSize()))
  }
  let gripFrom: { at: number; size: number; id: number } | undefined
  const [gripping, setGripping] = createSignal(false)
  const gripDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    gripFrom = { at: axis() === "h" ? e.clientY : e.clientX, size: treeSize(), id: e.pointerId }
    setGripping(true)
  }
  const gripMove = (e: PointerEvent) => {
    if (!gripFrom || e.pointerId !== gripFrom.id) return
    setTree(gripFrom.size + (axis() === "h" ? e.clientY : e.clientX) - gripFrom.at, false)
  }
  const gripEnd = () => {
    if (!gripFrom) return
    gripFrom = undefined
    setGripping(false)
    setTree(treeSize())
  }
  const gripKey = (e: KeyboardEvent) => {
    const fwd = axis() === "h" ? "ArrowDown" : "ArrowRight", back = axis() === "h" ? "ArrowUp" : "ArrowLeft"
    if (e.key === fwd) setTree(treeSize() + GRIP_STEP)
    else if (e.key === back) setTree(treeSize() - GRIP_STEP)
    else if (e.key === "Home") setTree(limits().min)
    else if (e.key === "End") setTree(limits().max)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  onMount(() => {
    const ro = new ResizeObserver(() => {
      setStacked(getComputedStyle(bodyEl).flexDirection === "column")
      setGripNow(treeSize())
    })
    ro.observe(rootEl)
    onCleanup(() => ro.disconnect())
  })

  // ── the footer: the bar's part ──────────────────────────────────────────────────────────────
  const batchV = () => view()?.batch
  const edits = () => batchV()?.edits ?? 0
  const [noteFocused, setNoteFocused] = createSignal(false)
  const [noteLocal, setNoteLocal] = createSignal<string | null>(null)
  const note = () => noteLocal() ?? batchV()?.note ?? ""
  createEffect(() => {
    const l = noteLocal()
    if (l !== null && !noteFocused() && l === (batchV()?.note ?? "")) setNoteLocal(null)
  })
  let noteEl: HTMLInputElement | undefined
  const sendBatch = (bg: boolean) => {
    const text = noteEl?.value ?? note()
    if (text !== (batchV()?.note ?? "")) send({ type: "note", text })
    send({ type: "send", ...(bg ? { bg: true } : {}) })
    // Sent, the words are gone; refused, the view brings them back.
    if (edits()) {
      setNoteLocal("")
      setTimeout(() => !noteFocused() && setNoteLocal(null), HOLD_MS)
      noteEl?.blur()
    }
  }
  /** In place of the note: a refusal (for a moment), or the state when the note is empty. */
  const line = () => {
    const b = batchV()
    if (!b || noteFocused()) return null
    if (b.msg) return { text: b.msg, warn: true }
    if (b.status && !note().trim()) return { text: b.status, warn: false }
    return null
  }
  const sendTitle = () => {
    const n = edits()
    return n ? `Send ${n === 1 ? "this edit" : `these ${n} edits`} as one note (${keys("enter")} in the note, ${keys("mod", "enter")} in a field)` : "Nothing to send yet"
  }

  // ── the keys list: from the "?", inside the inspector's box ──
  const [helpOpen, setHelpOpen] = createSignal(false)
  let helpBtn: HTMLButtonElement | undefined
  let helpEl: HTMLDivElement | undefined
  /** Above the footer, no taller than the inspector's box leaves it. */
  const helpAt = () => {
    if (!helpOpen() || !rootEl) return {}
    const foot = rootEl.querySelector(".cd-foot")?.getBoundingClientRect().height ?? 0
    return { bottom: `${foot + 4}px`, "max-height": `${Math.max(60, rootEl.getBoundingClientRect().height - foot - 12)}px` }
  }
  const outside = (e: PointerEvent) => {
    const t = e.target as Node
    if (helpOpen() && !helpEl?.contains(t) && !helpBtn?.contains(t)) setHelpOpen(false)
  }
  onMount(() => document.addEventListener("pointerdown", outside, true))
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  const KEYS = editKeys(mac())

  return (
    <div
      class="cd"
      classList={{ shut: folded() }}
      ref={rootEl}
      style={{ "--cd-tree-h": treeH() ? `${treeH()}px` : undefined, "--cd-tree-w": treeW() ? `${treeW()}px` : undefined }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && helpOpen()) {
          e.preventDefault()
          setHelpOpen(false)
          helpBtn?.focus()
          return
        }
        onKey(e)
      }}
      onInput={onInput}
    >
      <header class="cd-head">
        <span class="cd-title">Inspector</span>
        <span class="cd-path" title={sel() ? `${sel()!.label}${sel()!.tag !== sel()!.label ? ` · ${sel()!.tag}` : ""}` : ""}>
          {sel() ? `${sel()!.label}${sel()!.hidden ? " · hidden" : ""}` : "Nothing selected"}
        </span>
        <div class="cd-tabs" role="tablist" aria-label="What the styles are for">
          <button
            type="button"
            role="tab"
            class="cd-tab"
            aria-selected={!global()}
            disabled={!sel()}
            title={sel() ? "Classes, styles and computed values of the selection" : "Select an element"}
            onClick={() => send({ type: "global", on: false })}
          >
            Element
          </button>
          <button type="button" role="tab" class="cd-tab" aria-selected={global()} title="New rules for the page, sent with this batch" onClick={() => send({ type: "global", on: true })}>
            Global
            <Show when={sheetRules()}>
              <i class="cd-dot" aria-label="has rules" />
            </Show>
          </button>
        </div>
        <button type="button" class="icon-btn small cd-fold" aria-label={folded() ? "Open the inspector" : "Fold the inspector"} title={folded() ? "Open the inspector" : "Fold the inspector"} onClick={fold}>
          <Icon name={folded() ? "up" : "down"} />
        </button>
      </header>
      <div class="cd-body" ref={bodyEl}>
        <div
          class="cd-tree thin-scroll"
          ref={treeEl}
          tabindex="0"
          role="tree"
          aria-label="Page elements"
          onScroll={onTreeScroll}
          onMouseLeave={() => hoverRow(0)}
        >
          <div class="cd-tspace" style={{ height: `${(view()?.tree.total ?? 0) * ROW}px` }}>
            <div class="cd-trows" style={{ transform: `translateY(${(view()?.tree.first ?? 0) * ROW}px)` }}>
              <For each={view()?.tree.rows ?? []}>
                {(row) => (
                  <div
                    class="cd-trow"
                    role="treeitem"
                    aria-selected={row.id === sel()?.id}
                    aria-expanded={row.kids === "none" ? undefined : row.kids === "open"}
                    classList={{ on: row.id === sel()?.id, hov: row.id === view()?.tree.hover, ed: !!row.ed, hid: !!row.hid }}
                    style={{ "padding-left": `min(${4 + row.depth * 12}px, 45%)` }}
                    title={`${row.tag}${row.idName}${row.cls}`}
                    onMouseMove={() => hoverRow(row.id)}
                    onClick={(e) => {
                      if ((e.target as Element).closest(".cd-tw")) send({ type: "open", id: row.id })
                      else if (row.id !== sel()?.id) send({ type: "select", id: row.id })
                    }}
                    onDblClick={(e) => !(e.target as Element).closest(".cd-tw") && send({ type: "open", id: row.id })}
                  >
                    <span class="cd-tw" classList={{ open: row.kids === "open", none: row.kids === "none" }}>
                      <Icon name="right" />
                    </span>
                    <span class="cd-tt">{row.tag}</span>
                    <span class="cd-ti">{row.idName}</span>
                    <span class="cd-tc">{row.cls}</span>
                    <Show when={row.text}>
                      <span class="cd-tx">{row.text}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
        <div
          class="cd-grip"
          classList={{ active: gripping() }}
          role="separator"
          aria-orientation={stacked() ? "horizontal" : "vertical"}
          aria-label={stacked() ? "Resize the tree and the styles" : "Resize the tree"}
          aria-valuenow={gripNow()}
          title="Drag to resize · double-click: back to the default"
          tabindex="0"
          onPointerDown={gripDown}
          onPointerMove={gripMove}
          onPointerUp={gripEnd}
          onPointerCancel={gripEnd}
          onLostPointerCapture={gripEnd}
          onDblClick={() => setTree(undefined)}
          onKeyDown={gripKey}
        />
        <div class="cd-side">
          <div class="cd-pane cd-el thin-scroll" role="tabpanel" hidden={global()}>
            <div class="cd-col cd-in thin-scroll">
              <label class="cd-sec" for="cd-cls">
                Classes
              </label>
              <input
                id="cd-cls"
                class="cd-cls"
                classList={{ bad: !!view()?.classes.long }}
                ref={(el) => (els.classes = el)}
                type="text"
                spellcheck={false}
                autocomplete="off"
                disabled={!sel()}
                title={view()?.classes.long ? "Too long: more than 1000 characters. Not applied" : ""}
                placeholder={sel() ? "No classes · type to add" : "Select an element to edit its classes"}
                value={shown("classes")}
                onFocus={() => focusField("classes")}
                onBlur={() => leaveField("classes")}
              />
              <label class="cd-sec" for="cd-css">
                Element styles <i>only this element · & nests</i>
              </label>
              <CssBox
                id="cd-css"
                text={shown("css")}
                answer={view()?.css}
                disabled={!sel()}
                placeholder="Type CSS for this element, e.g. padding: 20px"
                ref={(el) => (els.css = el)}
                onFocus={() => focusField("css")}
                onBlur={() => leaveField("css")}
                onMouseDown={closeList}
              />
            </div>
            <div class="cd-col cd-comp thin-scroll">
              <div class="cd-sec">
                Computed <i>edit a value to add it to Element styles</i>
              </div>
              <Index each={view()?.computed ?? []}>
                {(row) => (
                  <div class="cd-crow" classList={{ mine: !!row().mine }}>
                    <button
                      type="button"
                      class="cd-cp"
                      tabindex="-1"
                      title="Click to copy into Element styles · drag to change the number"
                      onPointerDown={(e) => scrubDown(e, row())}
                      onPointerMove={scrubMove}
                      onPointerUp={scrubEnd}
                      onPointerCancel={scrubEnd}
                      onClick={() => {
                        if (scrubbed) return void (scrubbed = false)
                        if (setValue({ ...row(), value: "" }, row().value)) els.css?.focus({ preventScroll: true })
                      }}
                    >
                      {row().prop}
                    </button>
                    <input
                      class="cd-cval"
                      classList={{ bad: bad[row().prop] !== undefined }}
                      data-prop={row().prop}
                      type="text"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={list()?.row === row().prop}
                      aria-controls="cd-sug"
                      aria-label={row().prop}
                      spellcheck={false}
                      autocomplete="off"
                      title={bad[row().prop] !== undefined ? `invalid value for ${row().prop}: not written` : valueShown(row())}
                      value={valueShown(row())}
                      onMouseDown={closeList}
                      onBlur={(e) => {
                        if (list()?.field === e.currentTarget) {
                          const live = list()!.live
                          setList(null)
                          if (live) send({ type: "commit" })
                        }
                        const v = val()
                        if (v && v.prop === row().prop && !v.until) setValue(row(), e.currentTarget.value)
                      }}
                    />
                    <Show when={row().tokens}>
                      <button
                        type="button"
                        class="cd-ctok"
                        tabindex="-1"
                        title={row().tokenTitle ?? ""}
                        onClick={() => {
                          if (setValue({ ...row(), value: "" }, row().tokens!.map((n) => `var(${n})`).join(" "))) els.css?.focus({ preventScroll: true })
                        }}
                      >
                        {row().tokens!.join(" ")}
                      </button>
                    </Show>
                  </div>
                )}
              </Index>
            </div>
          </div>
          <div class="cd-pane cd-gl thin-scroll" role="tabpanel" hidden={!global()}>
            <label class="cd-sec" for="cd-free">
              Stylesheet <i>new rules, sent with this batch</i>
            </label>
            <CssBox
              id="cd-free"
              text={shown("sheet")}
              answer={view()?.sheet}
              disabled={false}
              placeholder="New rules, e.g. .name { … }"
              ref={(el) => (els.sheet = el)}
              onFocus={() => focusField("sheet")}
              onBlur={() => leaveField("sheet")}
              onMouseDown={closeList}
            />
          </div>
        </div>
      </div>
      <footer class="cd-foot" aria-label="This batch">
        <span class="cd-count" title={edits() ? "Unsent edits in this batch" : "Nothing edited yet"}>
          {edits() ? `${edits()} edit${edits() === 1 ? "" : "s"}` : "No edits"}
        </span>
        <span class="cd-acts">
          <button type="button" class="icon-btn cd-undo" aria-label="Undo" title={`Undo (${keys("mod", "Z")})`} disabled={!batchV()?.undo} onClick={() => send({ type: "undo" })}>
            <FIcon name="undo" />
          </button>
          <button type="button" class="icon-btn cd-redo" aria-label="Redo" title={`Redo (${keys("mod", "shift", "Z")})`} disabled={!batchV()?.redo} onClick={() => send({ type: "redo" })}>
            <FIcon name="redo" />
          </button>
          <button type="button" class="btn cd-reset" title="Remove every unsent edit (undoable)" disabled={!edits()} onClick={() => send({ type: "reset" })}>
            Reset
          </button>
        </span>
        <span class="cd-note-slot">
          <Show
            when={!line()}
            fallback={
              <span class="cd-msg" classList={{ warn: line()!.warn }} role="status" title={line()!.text}>
                {line()!.text}
              </span>
            }
          >
            <input
              ref={noteEl}
              class="input cd-note"
              type="text"
              spellcheck={false}
              autocomplete="off"
              aria-label="Note"
              placeholder="Add a note…"
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
                e.stopPropagation() // (not the inspector's fields' typing)
                setNoteLocal(e.currentTarget.value)
                send({ type: "note", text: e.currentTarget.value })
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter" && !e.isComposing && !e.shiftKey) {
                  e.preventDefault()
                  sendBatch(e.altKey)
                } else if (e.key === "Escape") noteEl!.blur()
              }}
            />
          </Show>
        </span>
        <button type="button" class="btn primary cd-send" disabled={!edits()} title={sendTitle()} onClick={(e) => sendBatch(e.altKey)}>
          Send
        </button>
        <button
          type="button"
          class="icon-btn cd-help"
          ref={helpBtn}
          aria-label="Keys and gestures"
          aria-expanded={helpOpen()}
          title="Keys and gestures"
          onClick={() => setHelpOpen(!helpOpen())}
        >
          <FIcon name="help" />
        </button>
      </footer>
      <Show when={helpOpen()}>
        <div class="cd-keys thin-scroll" ref={helpEl} role="dialog" aria-label="Keys and gestures" style={helpAt()}>
          <For each={KEYS}>
            {([k, v]) => (
              <div class="cd-krow">
                <span class="cd-kk">
                  <Kbd keys={k} />
                </span>
                <span class="cd-kv">{v}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={list()}>
        {(l) => (
          <div
            class="cd-sug thin-scroll"
            id="cd-sug"
            role="listbox"
            aria-label={l().kind === "name" ? "CSS properties" : `Values of ${l().prop}`}
            ref={listEl}
            style={{ left: `${l().at.x}px`, [l().at.up ? "bottom" : "top"]: `${l().at.y}px`, "max-height": `${l().at.max}px` }}
            onMouseDown={(e) => {
              e.preventDefault() // the field keeps the focus
              const row = (e.target as Element).closest(".cd-sg")
              if (row && e.button === 0) accept([...listEl!.children].indexOf(row))
            }}
          >
            <For each={l().items}>
              {(it, i) => {
                const v = l().vars.get(it)
                return (
                  <div class="cd-sg" classList={{ on: i() === l().on }} role="option" aria-selected={i() === l().on}>
                    <Show when={l().kind === "value" && isColour(v ?? it)}>
                      <i class="cd-swatch" style={{ background: v ?? it }} />
                    </Show>
                    <span class="cd-sgn">{it}</span>
                    <Show when={v !== undefined}>
                      <span class="cd-sgv">{v!.length > 40 ? `${v!.slice(0, 39)}…` : v}</span>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}

/** A CSS box: the text area, the layer under it that underlines what the page did not take, and
 *  the line under it that says why. The marks are the view's, for the text the view has: while
 *  newer typing is on its way, those before where the texts part stay. */
function CssBox(props: {
  id: string
  text: string
  answer: CanvasText | undefined
  disabled: boolean
  placeholder: string
  ref: (el: HTMLTextAreaElement) => void
  onFocus: () => void
  onBlur: () => void
  onMouseDown: () => void
}): JSX.Element {
  let area!: HTMLTextAreaElement
  let layer!: HTMLPreElement
  // The last answer that was for the text as it was then.
  const [seen, setSeen] = createSignal<CanvasText>({ text: "", marks: [], error: "" })
  createEffect(() => {
    const a = props.answer
    if (a && a.text === props.text) setSeen({ text: a.text, marks: a.marks.map((m) => ({ ...m })), error: a.error })
  })
  // The field's value is set only when it differs: setting it moves the caret to the end.
  createEffect(() => {
    if (area.value !== props.text) area.value = props.text
  })
  const parts = createMemo(() => {
    const text = props.text, a = seen()
    let same = 0
    while (same < text.length && same < a.text.length && text[same] === a.text[same]) same++
    const out: Array<{ t: string; why?: string }> = []
    let at = 0
    for (const m of a.marks) {
      if (m.s < at || m.e > same) continue
      out.push({ t: text.slice(at, m.s) }, { t: text.slice(m.s, m.e), why: m.why })
      at = m.e
    }
    out.push({ t: `${text.slice(at)}\n` })
    return out
  })
  return (
    <>
      <div class="cd-ed">
        <pre class="cd-hl" aria-hidden="true" ref={layer}>
          <For each={parts()}>{(p) => (p.why ? <u title={p.why}>{p.t}</u> : p.t)}</For>
        </pre>
        <textarea
          id={props.id}
          class="cd-css"
          ref={(el) => {
            area = el
            props.ref(el)
          }}
          spellcheck={false}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls="cd-sug"
          disabled={props.disabled}
          placeholder={props.placeholder}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          onMouseDown={props.onMouseDown}
          onScroll={() => (layer.scrollTop = area.scrollTop)}
        />
      </div>
      <Show when={seen().error}>
        <p class="cd-err">{seen().error}</p>
      </Show>
    </>
  )
}
