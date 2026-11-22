import type { MotionAct, MotionView } from "./protocol-motion"
import type { CanvasAct, CanvasView } from "./protocol-canvas"
import type { FactsAct, FactsView } from "./protocol-facts"

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

/** A mode with a dock: canvas mode's inspector, motion mode's dock. The overlay draws neither: the
 *  host says which it draws itself ("docks"), and a host that does not say so for a dock has none.
 *  For a dock the host draws, the overlay tells the host what the dock shows ("panel", a view) and
 *  does what the host's dock asks of it ("panel", an act). What a view and an act carry is each
 *  dock's own: protocol-motion.ts, protocol-canvas.ts. */
export type Dock = Exclude<Mode, "notes">

/** A pane the host draws: a mode's dock, or "facts" ("This page on this phone", protocol-facts.ts),
 *  which is no mode's and which the overlay never draws itself. Every pane rides the same two
 *  messages ("docks" says which the host draws, "panel" carries views and acts). The facts are
 *  worked out only between the pane's "view" and "stop" acts; a new document, and one told
 *  "stop", sends the view null: nothing is being worked out. */
export type Pane = Dock | "facts"

/** What a hosted pane shows, as the overlay last knew it: the whole of it. Its strings are the
 *  page's (a class, a text, a keyframe's name): a host draws them as text, never as markup. */
export type PanelView = { panel: "motion"; view: MotionView } | { panel: "canvas"; view: CanvasView } | { panel: "facts"; view: FactsView | null }

/** The fields of a pane's view that are not what they were in the one before (a playhead's clock,
 *  sixty times a second, without the rest of the dock): each field whole, to put in place of the
 *  host's own; the fields not named stay. Only the view's own fields, one level: a change inside
 *  a field sends that field. The first view of a pane, a view with other fields than the last,
 *  and null always come whole (PanelView). A host that gets a part and has no view to put it in
 *  asks for the whole one (the "whole" act). */
export type PanelPart = { panel: Pane; part: Record<string, unknown> }

/** What the reviewer did in a hosted pane. Two are every pane's, and the overlay answers them
 *  itself: "ping", at once with a "panel" message carrying `pong: id` and no view (how long the
 *  way there and back takes); and "whole", with the pane's view as it last went, whole (nothing
 *  when none has gone). */
export type PanelAct =
  | { panel: Pane; act: { type: "ping"; id: number } }
  | { panel: Pane; act: { type: "whole" } }
  | { panel: "motion"; act: MotionAct }
  | { panel: "canvas"; act: CanvasAct }
  | { panel: "facts"; act: FactsAct }

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
  kind: "move" | "resize" | "gap" | "padding" | "margin" | "text" | "hide" | "style" | "class" | "duplicate"
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
  /** style only: each property set, with its computed value before and after, and the page's
   *  variables (design tokens) its value was set with: `["--space-4"]` for `gap: var(--space-4)`. */
  changes?: Array<{ prop: string; from: string; to: string; tokens?: string[] }>
  /** move only. */
  parent?: { selector: string; label: string; layout: "flex-row" | "flex-column" | "grid" | "block" }
  /** 0-based among element siblings. */
  fromIndex?: number
  toIndex?: number
  /** The sibling it now sits before; null = it is the last one. */
  before?: { selector: string; label: string } | null
  /** How many siblings look like the same component. More than 1 means "repeated". */
  repeated?: number
  /** The element is in a copy that the "duplicate" edit at this index (0-based, in the same
   *  note) made: it is not in the code yet. A duplicate edit names the element it copies. */
  copyOf?: number
  /** The element is in a copy that an earlier note asked for: the label of what it copies. */
  inCopy?: string
  /** text only, on an element with elements inside (`Read the <a>docs</a> first`): `from` and `to`
   *  are one run of its own words, the one right after the child with this label… */
  textAfter?: string
  /** …or, for the words before its first child, that child's label. */
  textBefore?: string
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
  /** "sending": not with the agent yet (being captured or sent); "asking": being worked on, and
   *  its conversation waits on the reviewer's answer; "stopped": stopped, or taken back. */
  status: "sending" | "queued" | "working" | "asking" | "done" | "failed" | "paused" | "stopped"
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

/** page → host: window.__review(JSON.stringify(msg)): the app's preload sends it over IPC, the harness has a shim. */
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
  /** Reply to "frame", two frames after it was done: the window as it is then; id as received. */
  | { type: "frame-shown"; id: string; viewport: Viewport }
  /** A hosted dock's view (see Dock), whenever what it shows changed, at most once a frame. */
  | ({ type: "panel" } & PanelView)
  | ({ type: "panel" } & PanelPart)
  /** The answer to a hosted dock's "ping". */
  | { type: "panel"; panel: Pane; pong: number }

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
  /** For a picture the host takes by itself (a note's place once the agent is done), and for
   *  asking how wide the window is. hold: true takes the layer out of the picture and, with
   *  `scroll`, puts the document there (CSS px, at once); hold: false gives both back as they
   *  were, and so do 5 s without it. With neither, nothing changes. Always answered with
   *  "frame-shown". */
  | { type: "frame"; id: string; hold?: boolean; scroll?: [number, number] }
  /** Bring the pin `id` into view: where its element is now (else where the note was made), a
   *  third of the window down, scrolled smoothly. Nothing happens for a pin with no place. */
  | { type: "show"; id: string }
  /** The panes the host draws itself (see Dock and Pane), all of them each time; none until it
   *  says so. Sent after "state", and again whenever the list changes. */
  | { type: "docks"; hosted: Pane[] }
  /** From a hosted pane: something the reviewer did there. Ignored for a pane that is not hosted. */
  | ({ type: "panel" } & PanelAct)
  /** The page is shown as a phone's (PhoneEdge: what of the phone to draw over it), or not (null:
   *  nothing). Sent after "ready" and whenever it changes. */
  | { type: "device"; phone: PhoneEdge | null }

/** What of a phone the overlay draws over its page, which the host shows running to the screen's
 *  bottom edge and cannot draw over: the home indicator, and the screen's two bottom corners.
 *  CSS px of the page. In every mode, Preview too (it is the phone, not a mark), and in no
 *  picture: hidden during a capture, a held "frame" and nothing else (not by the peek).
 *  - `radius` and `shape`: the screen's bottom corners, a CSS border-radius and corner-shape (the
 *    host's own, so the page's engine draws the very curve the host draws). Outside them, as far
 *    as the page goes, the layer paints what the host draws there: a ring `ring` px wide in
 *    `ringColour` and `around` beyond it ("#rrggbb"). 0: no corners.
 *  - `home`: the indicator, centred, its bottom edge `bottom` px above the screen's; dark on what
 *    is light under it and light on what is dark. Absent on a phone with a home button. */
export type PhoneEdge = {
  radius: number
  shape?: string
  ring?: number
  ringColour?: string
  around?: string
  home?: { width: number; height: number; bottom: number }
}

/** What the overlay puts on the page's window (in its own script world, when the host gives it one). */
export type OverlayApi = {
  version: string
  /** True while the reviewer is mid-note (card open, selection, drag, capture): a host that
   *  reloads the page waits for false. */
  busy(): boolean
  receive(msg: HostMessage | string): void
}
