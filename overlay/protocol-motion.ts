// Motion mode's dock, which only the host draws (see Dock in protocol.ts; the overlay has none of
// its own): what the dock shows, and what the reviewer can do in it. Types only.
//
// The overlay keeps everything that is the page's: finding what moves, the keyframes and the
// timing as the page has them, the edits and their undo, playing and seeking, sending the note.
// The host's dock is a drawing of `MotionView` and a source of `MotionAct`s; it keeps nothing
// the overlay does not also have, so a reload of either side loses nothing. (src/motion/host.js
// is the overlay's side.)
//
// Every string here is the page's or made from the page's (a keyframes' name, an element's
// words, a value as typed): a host draws it as text, never as markup.

/** How one element plays one animation. Durations and the delay in ms; the rest as CSS has them
 *  ("infinite", "alternate", "both", "cubic-bezier(…)"). */
export type MotionTiming = { duration: number; delay: number; easing: string; count: string; direction: string; fill: string }

/** What kind of motion a row is: keyframes an element plays, keyframes nothing plays (or, when the
 *  view is `partial`, nothing was seen to play), a transition, a script's animate(), or an inline
 *  style a script rewrites frame by frame. */
export type MotionKind = "css" | "unused" | "transition" | "script" | "frames"

/** One line of the list of what moves: a group's heading, or something that moves. A row under
 *  a row of keyframes several elements play (`sub`) is one of those elements. */
export type MotionRow =
  | { group: string }
  | {
      /** The same thing has the same id in every view (what a host keys its rows by, what "row"
       *  and "hover" name). */
      id: string
      kind: MotionKind
      /** An animation's name, or an element's words. */
      text: string
      /** Smaller, beside it: what plays it, or what moves. */
      aside: string
      /** ms; null when there is no one duration. */
      duration: number | null
      /** It is what is open. */
      on: boolean
      sub: boolean
      /** The last element under its animation. */
      last: boolean
      /** Nothing to open: listed so the reviewer knows it is there. */
      off: boolean
      running: boolean
      /** It has unsent edits. */
      dirty: boolean
    }

/** One property's lane: its keyframes in order, and between each two the easing of that stretch
 *  (`eases[i]` runs from `keys[i]` to `keys[i + 1]`). A key that is `implied` is not in the
 *  keyframes: they do not say where the property starts (or ends), so it starts from the
 *  element's own value, which is what the key says. It is drawn, not selected or dragged; a
 *  keyframe added there (addKey) makes it one. */
export type MotionLane = { prop: string; keys: Array<{ at: number; value: string; implied?: boolean }>; eases: string[] }

/** The selected keyframe: one property's (`prop`), or the whole keyframe (`prop` null, then
 *  `value` is null and `props` says how many properties it sets). `ease` is its own easing, ""
 *  for the animation's (`dflt`); the last keyframe has none (`last`). `at` in % of the keyframes.
 *  `editable`: its value may be changed (a transition's: where its state's lane ends). */
export type MotionKey = { at: number; prop: string | null; value: string | null; ease: string; dflt: string; last: boolean; editable: boolean; props: number }

/** What is open: one animation, as one element plays it. */
export type MotionOpen = {
  kind: "css" | "script" | "transition"
  /** The keyframes' name (a script's animation id; "transition"). */
  name: string
  /** A script's animation or a transition: its keyframes are looked at, not edited (but
   *  a transition's state, `editable` in MotionKey). */
  readOnly: boolean
  /** Its duration, delay and easing may be changed (a transition's too: of all its properties
   *  at once). */
  timed: boolean
  /** A transition: the states the page's CSS says change it ("hover", "active", ".open",
   *  "[data-open]", "hover on a parent"), and the one it is looked at in; none when no rule says
   *  what changes it. */
  states: string[]
  state: string | null
  /** Those of `states` that are triggers the reviewer named or recorded: they can be taken away. */
  triggers: string[]
  /** Where else than on the element a trigger may be: a few of its parents, nearest first, then
   *  the body and the root (its words, and the element as the code has it: "section.hero"). */
  above: Array<{ path: string; text: string; aside: string }>
  /** What starts the transition is being recorded: the page is used as it is meanwhile. */
  recording: boolean
  /** Keyframes made here: their name may be changed (the page's own keep theirs, the code uses it). */
  renamable: boolean
  /** A new animation on the element: "Remove" takes it off again. */
  removable: boolean
  /** How many elements play these keyframes. More than 1: a change to them changes all. */
  shared: number
  /** The element got keyframes of its own, copied from these. */
  from: string | null
  timing: MotionTiming
  /** What starts it, one of `choices.starts`; null when that is not this dock's to say. */
  starts: string | null
  /** The timeline's length in ms (the duration; a transition's longest stretch). At least 1. */
  T: number
  /** Where the whole keyframes are, in %: the marks under the ruler. */
  frames: number[]
  /** In the order they were first drawn: a lane keeps its place while keyframes are dragged. */
  lanes: MotionLane[]
  key: MotionKey | null
  /** What moves with it: the keyframe animations of the elements beside it (it among them,
   *  `on`), each with its row's `id`, when it starts and how long it lasts, in ms. Empty when it
   *  moves alone. */
  score: Array<{ id: string; text: string; name: string; delay: number; duration: number; on: boolean }>
  /** The keyframes as text (a transition: its rule; a script's animation: the call that would
   *  make it, written out from the animation as it runs). */
  css: string
  /** Why the text last typed is not keyframes; "" when it is. */
  cssError: string
  /** It has something to put back ("discard"). */
  dirty: boolean
}

/** The playhead: where the open animation is (0…1 along its keyframes; null when the page has no
 *  frame of it to show), whether it plays, for a transition whether its state is switched on, and
 *  while it waits out its delay how far through it is (`wait`, 0…1; null when it does not wait).
 *  The overlay sends a whole view whenever this changes, at most once a frame while it plays. */
export type MotionClock = { pos: number | null; playing: boolean; on: boolean; wait: number | null }

/** The words of the choices the dock offers, the overlay's (so the host never has a
 *  different list): `[value, label, what it means]`. */
export type MotionChoices = {
  easings: string[]
  /** Properties offered for a new lane (those that have one already are left out). */
  props: string[]
  starts: Array<[string, string]>
  count: Array<[string, string, string]>
  direction: Array<[string, string, string]>
  fill: Array<[string, string, string]>
  rates: Array<[number, string]>
}

/** Everything the dock shows. */
export type MotionView = {
  /** Motion mode is on (and review is). Off, the rest is empty. */
  on: boolean
  rows: MotionRow[]
  /** A very large page was looked at in part: the list has what its first few thousand elements
   *  play and what plays now anywhere, and its "unused" rows are keyframes not seen to play, which
   *  an element further down may still play. */
  partial: boolean
  /** The selected element's plain name ("Heading · Ship calmer interfaces"), or null. */
  sel: string | null
  open: MotionOpen | null
  /** Something is selected and nothing of it is open: the keyframes it could play. */
  names: string[]
  /** The timeline, or the keyframes as text. */
  view: "keys" | "css"
  rate: number
  loop: boolean
  isolate: boolean
  /** Behind the isolated element: a light colour or a dark one (the page's own, until the
   *  reviewer chooses). */
  backdrop: "light" | "dark"
  undo: boolean
  redo: boolean
  /** The words that go with the open animation, as typed so far. */
  note: string
  /** A message for a moment (what could not be done), over the note's field. */
  msg: string
  /** What the line says when there is nothing else: the last note sent, a sent preview gone. */
  status: string
  clock: MotionClock
  choices: MotionChoices
}

/** One thing done in the dock, and what the overlay does to the page for it. */
export type MotionAct =
  /** A row of the list opened (its `id`), or the pointer over one (its elements are outlined on
   *  the page) or over none. */
  | { type: "row"; id: string }
  | { type: "hover"; id: string | null }
  /** Esc: the keyframe let go, else what is open closed, else motion mode left. */
  | { type: "escape" }
  /** A narrow dock's way back to the list: nothing selected, nothing open. */
  | { type: "back" }
  | { type: "view"; view: "keys" | "css" }
  /** A field of the timing, or a choice of the "more" sheet: typed (done: false, the page shows
   *  it at once) or finished (done: true, one undo step). `how` is what starts it. */
  | { type: "timing"; what: "duration" | "delay" | "easing" | "count" | "direction" | "fill" | "how"; value: string; done: boolean }
  /** While looking: the speed, playing it again and again, and the element alone: everything
   *  else hidden, and it in the middle of the view, large enough to look at. */
  | { type: "rate"; rate: number }
  | { type: "loop"; on: boolean }
  | { type: "isolate"; on: boolean }
  /** Behind the isolated element, a light backdrop or a dark one in place of the page's own
   *  (until it is no longer isolated). */
  | { type: "backdrop"; value: "light" | "dark" }
  /** Everything in `score` starts again, each after its own delay. */
  | { type: "together" }
  /** A transition looked at in another of its `states`. */
  | { type: "state"; value: string }
  /** What switches a transition, as the reviewer names it: ".open", "[data-state=open]" or ":hover",
   *  on the element (`on` empty) or on one of the parents in `above` (its path). It is one of the
   *  states then; taken away by what it is called there. */
  | { type: "trigger"; text: string; on: string }
  | { type: "untrigger"; value: string }
  /** Recording what starts the transition: on, the pointer and the keys are the page's, and changes
   *  of classes, attributes and styles are noted; off, what started it is a trigger. */
  | { type: "record"; on: boolean }
  /** The next thing that moves (1) or the one before (-1), opened; round at the ends. */
  | { type: "go"; by: 1 | -1 }
  | { type: "undo" }
  | { type: "redo" }
  /** The open animation as the page has it (a new one: taken off the element). */
  | { type: "discard" }
  /** Play or pause (a transition: switch its state). */
  | { type: "play" }
  /** Stop at `p` (0…1 along the keyframes); or move from where it is by `by`. */
  | { type: "seek"; p: number }
  | { type: "step"; by: number }
  /** A keyframe pressed: selected, and the page shows that frame; `grab` starts a drag of it.
   *  null lets go of the selected one. */
  | { type: "select"; key: { at: number; prop: string | null } | null; grab?: boolean }
  /** The grabbed keyframe, dragged to `to` %, and let go (one undo step for the whole drag). */
  | { type: "drag"; to: number }
  | { type: "drop" }
  /** A keyframe where a lane (or the whole keyframes' row, prop null) was pressed twice. */
  | { type: "addKey"; prop: string | null; at: number }
  /** A field of the selected keyframe: its value, its easing, where it is (%). */
  | { type: "key"; what: "val" | "ease" | "at"; value: string; done: boolean }
  | { type: "removeKey" }
  | { type: "addLane"; prop: string }
  | { type: "removeLane"; prop: string }
  /** The keyframes as text, typed (done: false) or left (done: true, one undo step). */
  | { type: "css"; text: string; done: boolean }
  /** The name typed for keyframes made here. */
  | { type: "name"; value: string; done: boolean }
  /** For a selected element that does not move: new keyframes, or ones the page has. */
  | { type: "new" }
  | { type: "use"; name: string }
  /** Shared keyframes: this element gets a copy of its own. */
  | { type: "detach" }
  /** The note's words as typed so far. */
  | { type: "note"; text: string }
  /** The open animation as one note; background: to the host's background session. */
  | { type: "send"; background: boolean }
  /** Send the whole view again (a host that has none: a window that was reloaded). */
  | { type: "resend" }
