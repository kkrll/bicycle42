// Canvas mode's inspector, which the host draws (see Dock in protocol.ts): what the inspector
// shows, and what the reviewer can do in it. Types only.
//
// The overlay keeps everything that is the page's: the selection and its outlines, the handles
// and the drags, the batch, its undo and its previews, the note's words, sending the note. The
// batch's bar is the inspector's footer (`batch`, and the acts "note", "reset", "undo", "redo",
// "send", "edits", "unedit"): there is none on the page.
// The host's inspector is a drawing of `CanvasView` and a source of `CanvasAct`s; it keeps
// nothing the overlay does not also have, so a reload of either side loses nothing.
//
// One view is the whole inspector, sent whole whenever any of it changed (at most once a frame):
// the header, the three fields with what the page made of them, the computed values, the page's
// variables the suggestions offer, and the part of the tree around what the host shows. The tree
// is the one part that could be large, so it is never all of it: only the rows the host says it
// shows (the "tree" act), a screenful above and below them, and the selection's row; a view of a
// selection on a real page is 5 to 20 kB, most of it rows and variables.
//
// What is typed is the host's own while it is typed: a field being typed in keeps its text and
// sends it whole ("text"); the view answers with what the page made of it (the marks, the error
// line, the computed values) and with the text as the batch has it, which the host takes once
// the field is left, or at once when `force` changed (an undo, a value written elsewhere).

/** One row of the tree: an element of the page. Its words are the page's: drawn as text. */
export type CanvasRow = {
  /** The overlay's number for the element, the same while it is in this document: acts name it. */
  id: number
  /** How far in it is: body is 0. */
  depth: number
  /** "div", "#hero" or "", ".card.pro" (four names at most) or "", and a few of its own words. */
  tag: string
  idName: string
  cls: string
  text: string
  /** Whether it has children to show, and whether they are shown. */
  kids: "none" | "shut" | "open"
  /** The batch edits it (a dot), hides it (struck through). */
  ed?: true
  hid?: true
}

export type CanvasTree = {
  /** Every row that is open: the tree is this many rows tall. */
  total: number
  /** The index of `rows[0]`. */
  first: number
  rows: CanvasRow[]
  /** The selection's row, -1 for none. When the selection changes to a row out of view, the host
   *  brings it to the middle (first row shown: sel - half the rows it shows), as the overlay
   *  expects when it chooses which rows to send. */
  sel: number
  /** The element under the pointer (on the page, or a row the host said it is on); 0 for none. */
  hover: number
}

/** One of the two CSS boxes: its text as the batch has it, and what the browser would not take. */
export type CanvasText = {
  text: string
  /** Ranges of `text` to underline, each with why. */
  marks: Array<{ s: number; e: number; why: string }>
  /** The line under the box ("Not applied: …", "Too long: …"); "" for none. */
  error: string
}

/** A computed value of the selection, as a designer reads it (colours as hex, a tenth of a px). */
export type CanvasComputed = {
  prop: string
  value: string
  /** The page's variables the value is made of, when every part is one: a click writes them. */
  tokens?: string[]
  /** What the variables' button says when pointed at. */
  tokenTitle?: string
  /** This batch sets it on this element. */
  mine?: true
}

/** One of the page's variables, for the suggestions: `size` is its px (or plain number) for
 *  stepping along a scale, measured on the page; absent when it is no size. */
export type CanvasToken = { name: string; value: string; size?: number }

/** Everything the inspector shows. */
export type CanvasView = {
  /** Changes when the batch's text was changed by something else than the typing the view
   *  answers (undo, redo, a value set from the computed list, a drag on the page, a new
   *  selection): a field being typed in takes the view's text then. */
  force: number
  /** The selection: its id (the acts that edit it name it), what it is for the header (its
   *  component's name when the page says one, else `tag`; never its words), `tag` as the tree
   *  names it ("article.card.pro"), and whether this batch hides it. Null when nothing is selected. */
  sel: { id: number; label: string; tag: string; hidden: boolean } | null
  /** The stylesheet is shown (Global), not the selection's styles (Element): nothing is selected,
   *  or the reviewer chose Global. */
  global: boolean
  /** The selection's class attribute (as typed, while it is too long to apply). */
  classes: { text: string; long: boolean }
  /** Element styles: the selection's declarations. */
  css: CanvasText
  /** Global: the batch's own rules. */
  sheet: CanvasText
  computed: CanvasComputed[]
  /** The page's variables for the suggestions: those that reach the selection, or the page's
   *  root's while Global is shown. */
  tokens: CanvasToken[]
  tree: CanvasTree
  /** What the footer says: the batch's edits, undo and redo, the note, a refusal, the state. */
  batch: CanvasBatch
}

export type CanvasBatch = {
  /** Unsent edits in this batch (the Global stylesheet with rules counts as one): "No edits",
   *  "3 edits". Send and Reset do nothing without one. */
  edits: number
  /** There is a step to undo, to redo. */
  undo: boolean
  redo: boolean
  /** The note's words as typed so far: they go with the batch ("Add a note…"). */
  note: string
  /** What could not be done, for a moment (a send refused, a value too long): a warning. "" for none. */
  msg: string
  /** What the line says in place of the note when it is empty and not typed in: "Editing text"
   *  (text edited in place on the page), the note sent last until the agent is done with it, a
   *  note done or failed and its preview gone. "" for nothing. */
  status: string
  /** The unsent edits, one row each, while the host's list of them is open ("edits"); absent
   *  while it is shut. It shuts by itself when the last edit goes, and on a press on the page. */
  list?: CanvasEdit[]
}

/** One unsent edit, in words: what it is on ("Card · Pro For small teams", "Stylesheet") and
 *  what it does ("padding 16 → 24", "hidden", "2 rules"). `key` names it for "unedit"; `id` is
 *  its element's while that is on the page (a click on the row selects it), absent for the
 *  stylesheet. */
export type CanvasEdit = { key: string; label: string; text: string; id?: number }

/** One thing done in the inspector. `id` is a row's or the selection's (CanvasRow.id). */
export type CanvasAct =
  /** The rows the host's tree shows: from `first`, `count` of them. Sent when it scrolls or
   *  changes size, and when it starts: then the whole view is sent again. */
  | { type: "tree"; first: number; count: number }
  /** A row's children shown or not; without `open`, the other way. */
  | { type: "open"; id: number; open?: boolean }
  /** `show`: and scrolled into view on the page (a row of the edits list). */
  | { type: "select"; id: number; show?: boolean }
  /** The pointer on a row (0: off the rows): its element is outlined on the page. */
  | { type: "hover"; id: number }
  /** An arrow on the tree: up and down the rows, right opens or goes in, left closes or goes out. */
  | { type: "walk"; key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" }
  /** Element | Global. */
  | { type: "global"; on: boolean }
  /** A field's whole text, as typed. The page follows within a frame; the undo step closes when
   *  the typing pauses, or with `hold` not until "commit" (a suggestion shown on the page). `id`:
   *  the selection it was typed for (the stylesheet has none): typing for another is dropped. */
  | { type: "text"; field: "classes" | "css" | "sheet"; text: string; id?: number; hold?: boolean }
  /** `prop: value` written into the selection's styles, if the browser takes it. An undo step at
   *  once; `live` as typing is (a step of ↑/↓), with `hold` until "commit" (a scrub). */
  | { type: "value"; id: number; prop: string; value: string; live?: boolean; hold?: boolean }
  /** Close the undo step now: a field left, a scrub ended, a suggestion taken. */
  | { type: "commit" }
  /** Back to the last undo step, dropping what came since (Esc during a scrub). */
  | { type: "revert" }
  | { type: "undo" }
  | { type: "redo" }
  /** Send the batch (mod+Enter, the footer's Send); `bg` to the background lane (alt). */
  | { type: "send"; bg?: boolean }
  /** Every unsent edit removed, as one undo step (the footer's Reset). */
  | { type: "reset" }
  /** The note's words as typed in the footer, whole. */
  | { type: "note"; text: string }
  /** The list of the unsent edits shown in the footer, or not (CanvasBatch.list). */
  | { type: "edits"; open: boolean }
  /** One unsent edit taken out of the batch (CanvasEdit.key), as an undo step. */
  | { type: "unedit"; key: string }
  /** Esc outside a field: the edits list closes, else the selection goes, else Annotate. */
  | { type: "escape" }
  /** Delete and mod+D on the tree: the selection hidden (a copy taken out), or duplicated. */
  | { type: "hide" }
  | { type: "duplicate" }
