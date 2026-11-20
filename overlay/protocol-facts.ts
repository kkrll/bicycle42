// "This page on this phone": a pane the host draws beside a phone's page in a mode with no dock
// (Preview, Annotate); in Edit and Motion the column is the mode's dock and nothing is asked. See Pane in protocol.ts. Types only.
//
// What the page is at the size it is shown at, each fact tied to the element it is about: what
// sticks out past the screen's right edge, tap targets smaller than a finger, inputs a phone
// zooms into. The overlay works it out only while the host's pane asks for it ("view" until
// "stop"): after the page loads, on resize, after the page changed and when something of it
// stopped animating (debounced, in idle time, a few thousand elements at most). Scrolling only moves `scrollY`.
//
// As with a dock, the view is whole each time and its strings are the page's own text: the host
// draws them as text, never as markup.

/** One element a fact is about. */
export type FactItem = {
  /** The overlay's number for the element, the same while it is in this document: acts name it. */
  id: number
  /** A short name: the element's own words when they are few, else `tag.class`. */
  label: string
  /** The number that matters, units after a space: "32 × 28", "+130 px", "14 px". */
  detail: string
}

/** The three kinds of fact, as the view's lists are named. */
export type FactKind = "wide" | "taps" | "small"

/** Some of a kind of fact: the first few, and how many there are. */
export type FactList = { items: FactItem[]; total: number }

export type FactsView = {
  /** The layout viewport: documentElement.clientWidth, innerHeight. */
  viewport: { w: number; h: number }
  /** The document: scrollWidth, scrollHeight. Wider than the viewport: the page scrolls sideways. */
  doc: { w: number; h: number }
  scrollY: number
  /** The page has a `<meta name=viewport>`. Without one a phone lays it out about 980 wide and
   *  shows it zoomed out. */
  meta: boolean
  /** The scan stopped before the end of a very large page: the lists are of what it saw. */
  partial: boolean
  /** Every listed element is marked on the page, in its kind's tone ("marks"). */
  marks: boolean
  /** Elements that stick out past the viewport's right edge where they leave their container
   *  (not every box that holds one), up to 8. Detail: "+130 px". */
  wide: FactList
  /** Visible links, buttons, fields and the like smaller than 44 x 44 CSS px, a link inside a
   *  sentence excepted, up to 12. Detail: "32 x 28". */
  taps: FactList
  /** Text fields and selects whose text is under 16 px (iOS zooms the page to one that takes
   *  focus), up to 8. Detail: "14 px". */
  small: FactList
}

/** What the host's pane asks. "view": it is shown, work the facts out and keep them up to date
 *  until "stop" (with `marks`, as "marks" says); "refresh": again now. "marks": while the facts
 *  are worked out, draw a quiet outline on every listed element, in its kind's tone, or not (off
 *  until asked; the outlines follow scroll and layout, take no pointer, are in no screenshot and
 *  go with "stop"). An outline of an element that scrolls with the document is drawn in a
 *  layer that scrolls with it, so it never trails a scroll.
 *  "kind": while the pointer (or the focus) is on a kind's count, mark that kind's listed elements
 *  on the page, marks on or off (null: none). "hover": outline that element on the
 *  page, strongly (null: none); "show": scroll it into view and flash its outline; "note": in notes mode, make it the
 *  note's selection, as a click on it would. */
export type FactsAct =
  | { type: "view"; marks?: boolean }
  | { type: "marks"; on: boolean }
  | { type: "stop" }
  | { type: "refresh" }
  | { type: "kind"; kind: FactKind | null }
  | { type: "hover"; id: number | null }
  | { type: "show"; id: number }
  | { type: "note"; id: number }
