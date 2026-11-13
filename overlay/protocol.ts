// The protocol between the overlay and its host: every message either side sends, and what a
// note carries. Types only, nothing runs: the overlay's files name them in JSDoc (its `send`, its
// `receive`), the app imports them (app/src/main/page.ts, review.ts). The keys and the gestures
// are in src/protocol.js.
//
// The types say what a well-behaved overlay sends. A host still checks what arrives: a note
// becomes instructions to a coding agent (see `pageNote` in app/src/main/review.ts).

/** A rectangle: viewport CSS px. */
export type Box = { x: number; y: number; w: number; h: number }

/** The page's window when a message was made. */
export type Viewport = { w: number; h: number; dpr: number; scrollX: number; scrollY: number }

export type Mode = "notes" | "canvas" | "motion"

/** What the page's framework calls an element (React, Vue), with its dev source when present. */
export type Component = { /** "react" or "vue". */ framework?: string; name: string; stack: string[]; source?: string }

/** One element a note is about. */
export type Target = {
  selector: string
  tag: string
  text?: string
  rect: Box
  component?: Component
  /** More of the element's identity, for a host that wants it: its id, its classes, a few attributes. */
  id?: string
  classes?: string
  attrs?: Record<string, string>
}

/** One canvas-mode edit: something the reviewer did to a real element of the page by dragging,
 *  typing or deleting, or by writing CSS for it in the inspector. Absolute (a target value, not a
 *  delta). The agent makes it real in code. A note carries at most 40.
 *
 *  The inspector reports everything set on one element as a single "style" edit (`css` and
 *  `changes`), sizes and spacing set by dragging included; "resize", "gap", "padding" and "margin"
 *  are the older, one-property form of the same and are still read. The overlay sends "style",
 *  "class", "move", "text" and "hide". */
export type Edit = {
  kind: "move" | "resize" | "gap" | "padding" | "margin" | "text" | "hide" | "style" | "class"
  /** The edited element (for gap: the parent whose gap changed). */
  selector: string
  tag: string
  /** A plain name for it: "Button · Start free trial". */
  label: string
  component?: string
  /** The CSS property changed, when there is one: "width", "row-gap", "padding-top", … */
  prop?: string
  /** "16px", the old text, or (class) the original class attribute. */
  from?: string
  /** "32px", the new text, or (class) the edited class attribute. */
  to?: string
  /** style only: the declarations typed for this element (and written by gestures), verbatim. */
  css?: string
  /** style only: each property set, with its computed value before and after. */
  changes?: Array<{ prop: string; from: string; to: string }>
  /** move only. */
  parent?: { selector: string; label: string; layout: "flex-row" | "flex-column" | "grid" | "block" }
  /** 0-based among element siblings. */
  fromIndex?: number
  toIndex?: number
  /** The sibling it now sits before; null = it is the last one. */
  before?: { selector: string; label: string } | null
  /** How many siblings look like the same component. More than 1 means "repeated". */
  repeated?: number
}

/** One animation, changed in motion mode (or only talked about, for a transition or a script's
 *  animation, which the page can't edit). Everything in it ends up in the prompt or in the panel. */
export type Motion = {
  kind: "keyframes" | "transition" | "script"
  /** The keyframes' name (a script's animation id; "transition" for a transition). */
  name: string
  /** The element that plays it, and its plain name: "Heading · Ship calmer interfaces". */
  selector: string
  label: string
  /** keyframes: how many elements play these keyframes. More than 1: a change to them changes all. */
  shared?: number
  /** keyframes: a new animation on the element. */
  isNew?: true
  /** keyframes: the element got keyframes of its own (`name`), copied from these. */
  from?: string
  /** keyframes: the element's `animation` value now, and before. */
  animation?: { to: string; from?: string }
  /** keyframes: the @keyframes text now, and before. */
  keyframes?: { to: string; from?: string }
  /** keyframes: what changed in how it plays, each with its value before and after. */
  changes?: Array<{ prop: "duration" | "delay" | "easing" | "count" | "direction" | "fill"; from: string; to: string }>
  /** keyframes: what should start it, when that is not what starts it now. */
  starts?: "load" | "view" | "hover" | "click" | "appear" | "scroll"
  /** transition and script: what the page has, in one line. */
  current?: string
}

/** A note, as the overlay sends it. */
export type PageNote = {
  id: string
  text: string
  url: string
  /** The page's title, and when the note was made (ms since the epoch). */
  title?: string
  time?: number
  viewport: Viewport
  /** What the note is about. Canvas mode: the edited elements. Motion mode: the one that moves. */
  targets: Target[]
  area: Box | null
  strokes: number[][][]
  /** The targets, the area and the strokes, united. Canvas mode: the edited elements' rects
   *  before and after, united. */
  bounds: Box | null
  /** "bg" when sent with alt+Enter: to the host's background session. */
  lane?: "bg"
  /** A note template chosen with "/" in the note card ("variants", "grade", …). */
  template?: string
  /** Pictures the reviewer pasted into the note, as data URIs. Named here, not by the page. */
  images?: Array<{ name: string; uri: string }>
  /** Canvas mode: what the reviewer changed on the live page. Such a note may have no words. */
  edits?: Edit[]
  /** Canvas mode: new CSS rules the reviewer typed for the whole batch, verbatim. A note may be
   *  nothing but this. */
  css?: string
  /** Motion mode: the one animation the note is about. Its words may be empty when it changes
   *  something. */
  motion?: Motion
}

/** The unsent work, which the host keeps so a reload loses nothing: the note in progress, with
 *  canvas mode's unsent batch and motion mode's unsent animations beside it. The host does not
 *  look inside; it gives it back as it was. */
export type Draft = {
  text: string
  /** Selectors of what is selected for the note. */
  targets: string[]
  /** Both in document coordinates (a note's own are the viewport's). */
  area: Box | null
  strokes: number[][][]
  template: string | null
  /** Canvas mode's unsent batch (opaque: { els, sheet, ops }), where its elements were (to find
   *  them after a reload), and the words typed under it. */
  edits?: unknown
  paths?: unknown
  note?: string
  /** Motion mode's unsent edits (opaque: { kf, use, note? }). */
  motion?: unknown
}

/** A sent note's mark on the page. selector, tag, text and component are from the note's first
 *  target, for finding its element again; `at` is the last-resort position. */
export type Pin = {
  id: string
  n: number
  status: "queued" | "working" | "done" | "failed" | "paused" | "stopped"
  lane?: "bg"
  selector?: string
  tag?: string
  text?: string
  component?: string
  /** Document coordinates. */
  at?: [number, number]
  /** The reviewer's words, for the pin's tooltip. */
  note?: string
}

/** A note template, offered after "/" in the note card. */
export type Template = { name: string; hint: string }

/** page → host: window.__review(JSON.stringify(msg)), a CDP binding or a shim. */
export type PageMessage =
  /** The overlay is mounted; the host replies with "state". */
  | { type: "ready"; url: string; viewport: Viewport }
  /** mod+U (Preview: review off, or back on). enabled: false from Esc with nothing selected;
   *  enabled: true from mod+P/O/I or mod+shift+P while review is off (the mode follows once it
   *  is on). */
  | { type: "toggle"; enabled?: boolean }
  /** The mode or the brush changed (also sent after every "state"). The host has the switch for
   *  both; the layer has none. */
  | { type: "mode"; mode: Mode; brush: boolean }
  /** The current unsent work, debounced; null when there is none. */
  | { type: "draft"; draft: Draft | null }
  /** Submitted. The card is hidden; outlines and strokes stay drawn until "captured". */
  | { type: "note"; note: PageNote }
  /** Pins whose element can't be found (shown at their stored position, if any, dimmed). */
  | { type: "pins-placement"; unplaced: string[] }
  /** A pin was clicked. */
  | { type: "pin"; id: string }
  /** Reply to "edits", two frames after the page changed; id and show are echoed as received. */
  | { type: "edits-shown"; id: string; show: boolean }

/** host → page: window.__b42.receive(msg), the message or its JSON. */
export type HostMessage =
  /** The reply to "ready". `draft` is what the overlay last sent as its draft. */
  | { type: "state"; enabled: boolean; draft?: unknown; pins?: Pin[]; templates?: Template[] }
  | { type: "enabled"; enabled: boolean }
  /** The host's switch. brush: true goes to notes mode first: the brush belongs to it. */
  | { type: "mode"; mode?: Mode; brush?: boolean }
  | { type: "pins"; pins: Pin[] }
  /** The screenshot is taken: clear the selection. Clicks made before this are held, then
   *  applied. With ok: false the host did not take the note: nothing is cleared, the card (or the
   *  canvas batch) comes back and says why. A host answers every note one way or the other; with
   *  no answer in 2 s the note counts as taken (a slow screenshot). */
  | { type: "captured"; id: string; ok?: boolean; why?: string }
  /** Hide (show: false) or show again everything the sent canvas note `id` applied: styles,
   *  classes, text, order, its stylesheet. While any batch is hidden the layer's own chrome is
   *  hidden too, as during a capture. */
  | { type: "edits"; id: string; show: boolean }

/** What the overlay puts on the page's window (in its own script world, when the host gives it one). */
export type OverlayApi = {
  version: string
  /** True while the reviewer is mid-note (card open, selection, drag, capture): a host that
   *  reloads the page waits for false. */
  busy(): boolean
  receive(msg: HostMessage | string): void
}
