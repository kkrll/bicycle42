// Assistant text → DOM. The only place in the app where a string becomes HTML, and it always goes
// through DOMPurify with a short allowlist: agent output is untrusted.
//
// Cost model, because replies stream in as thousands of small deltas:
//   · a delta only marks the part dirty; work happens at most once per animation frame
//   · while streaming, finished blocks (everything before the last blank line or opening code
//     fence) are parsed once and never touched again; only the open tail is re-parsed
//   · a tail that is an open code fence is not parsed at all: it is one <pre><code> holding one
//     text node, and each frame appends the new characters to it. (Re-parsing a growing 17 KB
//     block every frame is what a long code answer would otherwise cost.)
//   · when the step is done the whole text is parsed once more in one piece, so anything the
//     block split got slightly wrong (a loose list, a reference link) ends up exact
//   · a tail that is a tight list or a table is drawn item by item: finished items (rows) are
//     parsed once and moved into the open <ul>, <ol> or <tbody>, and only the last is parsed
//     again each frame. (Re-parsing a 150-item list whole every frame cost seconds.)
//   · nothing is written while the reader has text selected in this message; the pending paint
//     runs when the selection goes away. Whether anything is selected at all is kept by one
//     listener for the window, so a paint asks where (which costs a layout) only when it is
import { createEffect, onCleanup } from "solid-js"
import { Marked } from "marked"
import DOMPurify from "dompurify"
import { copiedElement, copyButtonElement, copyText } from "./copy"

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // The window's CSP blocks remote images; show what the image was instead of a broken box.
    image({ href, text }) {
      return `<span class="md-link" title="${escape(href)}">${escape(text || "image")}</span>`
    },
  },
})

const CLEAN = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote", "span",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "input", "a",
  ],
  ALLOWED_ATTR: ["class", "title", "start", "align", "type", "checked", "disabled", "href"],
  // Links are never followed in this window (main.tsx hands them to main); only web addresses
  // survive at all.
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  // DOMPurify tests every attribute value against the pattern above unless told the attribute
  // holds no address. Without this an ordered list loses its start, a table its alignment and a
  // task-list box its type.
  ADD_URI_SAFE_ATTR: ["start", "align", "type", "checked", "disabled"],
}

/** The only class names agent text may carry: marked's code language, and the image stand-in
 *  above. Anything else could put this app's own styles on agent content. */
const CLASS = /^(language-[\w-]+|md-link)$/

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.hasAttribute("class") && !CLASS.test(node.getAttribute("class")!)) node.removeAttribute("class")
  // The address a link leads to is always visible on hover.
  if (node.tagName === "A" && node.hasAttribute("href")) node.setAttribute("title", node.getAttribute("href")!)
  // The one input markdown produces is a task-list box. Whatever the text asked for, that is
  // what it gets: a checkbox nobody can use.
  if (node.tagName === "INPUT") {
    node.setAttribute("type", "checkbox")
    node.setAttribute("disabled", "")
  }
})

function html(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }), CLEAN)
}

// ── finished code blocks: a copy button, and long ones folded ───────────────────────────────────

/** Code longer than this many lines is folded until the reader asks for all of it. */
const FOLD = 20

function button(cls: string, text: string): HTMLButtonElement {
  const b = document.createElement("button")
  b.className = cls
  b.type = "button"
  b.textContent = text
  return b
}

/** Gives each finished <pre> under `container` a header strip (language left, Copy right, so
 *  Copy never covers code) and wraps its lines: each line hangs under its own indentation, so
 *  code keeps its shape at any width and never needs a sideways scroll. Built after sanitising,
 *  from the app's own elements; agent text never chooses these classes. */
function enhance(container: Element): void {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("code")) continue
    const code = pre.querySelector("code") ?? pre
    const source = (code.textContent ?? "").replace(/\n+$/, "")
    const lines = source.split("\n")
    // One element per line, each keeping its own newline, so copying gives the code back as it was.
    code.replaceChildren(
      ...lines.map((line, i) => {
        const el = document.createElement("span")
        el.className = "cl"
        const indent = Math.min(24, (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "  ").length)
        if (indent) el.style.setProperty("--indent", String(indent))
        el.textContent = (line || " ") + (i < lines.length - 1 ? "\n" : "")
        return el
      }),
    )
    const wrap = document.createElement("div")
    wrap.className = "code"
    pre.replaceWith(wrap)
    const head = document.createElement("div")
    head.className = "code-head"
    const lang = document.createElement("span")
    lang.className = "code-lang"
    lang.textContent = /language-([\w-]+)/.exec(code.className)?.[1] ?? "code"
    const copy = copyButtonElement("Copy code", "code-copy")
    copy.dataset.source = source
    head.append(lang, copy)
    wrap.append(head, pre)
    if (lines.length > FOLD) {
      wrap.classList.add("folded")
      const more = button("more-btn code-more", `Show all ${lines.length} lines`)
      more.dataset.lines = String(lines.length)
      more.setAttribute("aria-expanded", "false")
      wrap.append(more)
    }
  }
}

/** The controls above, by delegation: one listener per message, nothing per block. */
function onCodeClick(e: MouseEvent): void {
  const target = e.target as Element
  const copy = target.closest<HTMLButtonElement>(".code-copy")
  if (copy) {
    const text = copy.dataset.source ?? ""
    void copyText(text).then((ok) => {
      if (ok) copiedElement(copy)
    })
    return
  }
  const more = target.closest<HTMLButtonElement>(".code-more")
  if (more) {
    const folded = more.parentElement!.classList.toggle("folded")
    more.setAttribute("aria-expanded", String(!folded))
    more.textContent = folded ? `Show all ${more.dataset.lines} lines` : "Show fewer lines"
  }
}

// ── the open tail while streaming ───────────────────────────────────────────────────────────────

/** A link still arriving shows as its words only: `[text](partial` and `[text]` become `text`,
 *  `[partial` becomes `partial`. The real link appears once its closing bracket does. */
export function closeLinks(tail: string): string {
  return tail
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*$/, "$1")
    .replace(/!?\[([^\]\n]*)\]$/, "$1")
    .replace(/!?\[([^\]\n]*)$/, "$1")
}

/** The last element that holds text at its end: where the streaming caret goes. */
function endOf(el: Element, skip: Node): Element {
  for (;;) {
    let last = el.lastChild
    while (last && (last === skip || (last.nodeType === 3 && !last.textContent!.trim()))) last = last.previousSibling
    if (!last || last.nodeType !== 1 || /^(BR|HR|INPUT)$/.test((last as Element).tagName)) return el
    el = last as Element
  }
}

const OPENER = /^(`{3,}|~{3,})([^\n`]*)$/

/** A fence line at column 0 that would close a block opened with `fence`. */
const closes = (line: string, fence: string) =>
  line.startsWith(fence) && line.trimEnd().split(fence[0]!).join("") === ""

/** Where the open tail starts, searching from `from` (itself a block start). A block ends at a
 *  blank line that is outside a code fence and followed by a line starting in column 0 (an
 *  indented line may still belong to the list item above it), at a code fence opening in
 *  column 0, which starts a block of its own, and after the line that closes one. `fence` is that tail's opening line when the tail
 *  is a fence still open at the end of the text, and "" otherwise. */
export function splitTail(text: string, from: number): { cut: number; fence: string } {
  let cut = from
  let open = "" // the opening marker of the fence we are inside, "" outside
  let openAt = -1
  let blank = false
  let at = from
  while (at < text.length) {
    let end = text.indexOf("\n", at)
    if (end < 0) end = text.length
    const first = text.charCodeAt(at)
    const empty = end === at || (first <= 32 && text.slice(at, end).trim() === "")
    if (!empty) {
      // Only fences in column 0 are tracked. An indented one belongs to a list item and stays
      // with it, on the ordinary re-parse path.
      const fenceLine = first === 96 || first === 126 ? text.slice(at, end) : ""
      if (open) {
        if (fenceLine && closes(fenceLine, open)) {
          open = ""
          // A closed fence is a finished block; what follows it starts the next one.
          if (end < text.length) cut = end + 1
        }
      } else {
        const m = fenceLine && OPENER.exec(fenceLine)
        if (m) {
          open = m[1]!
          openAt = at
          cut = at
        } else if (blank && first > 32) cut = at
      }
    }
    blank = empty
    at = end + 1
  }
  // Only once the opening line is complete: its language is part of it.
  const lineEnd = open && openAt === cut ? text.indexOf("\n", cut) : -1
  return { cut, fence: lineEnd < 0 ? "" : text.slice(cut, lineEnd + 1) }
}

// ── a tight list or a table, item by item ──────────────────────────────────────────────────────

const BULLET = /^([-+*])[ \t]/
const ORDERED = /^\d{1,9}([.)])[ \t]/
const BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/** A table's rule line, `|---|:--:|`. Only one with a pipe counts: `---` alone may be a heading's. */
const RULE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** What makes a line in column 0 an item of the same list: its bullet, or its number's
 *  delimiter ("1." stands for every number). "" for any other line. */
function itemMark(line: string): string {
  if (BREAK.test(line)) return ""
  const bullet = BULLET.exec(line)?.[1]
  if (bullet) return bullet
  const delimiter = ORDERED.exec(line)?.[1]
  return delimiter ? `1${delimiter}` : ""
}

/** The open tail (from `from`) as finished items and a live one, when it is one tight list or
 *  one table: a list whose every line in column 0 starts an item with the same bullet (anything
 *  else there ends the list or starts another), or a header, its rule and rows that each start
 *  with a pipe. A tight list's items parse alone as they do in the whole list, and so do a
 *  table's rows under their header, so the ones before `live` are finished: parsed once, while
 *  only the rest is parsed again as it grows. A list item's lines may go on (indented) after
 *  its first, so the last item with a whole line is still live; a row is finished at its
 *  newline. `head` is a table's header and rule, which every piece of it is parsed under (""
 *  for a list), and `body` is where the items start.
 *
 *  undefined when the tail is not that, or not yet. A blank line with more after it makes a list
 *  loose, which changes every item, or ends a table: such a tail is parsed whole, as before. */
export function splitItems(text: string, from: number): { kind: "list" | "table"; head: string; body: number; live: number } | undefined {
  const first = text.indexOf("\n", from)
  if (first < 0) return undefined
  const mark = itemMark(text.slice(from, first))
  let kind: "list" | "table" = "list"
  let body = from
  let at = first + 1
  if (!mark) {
    const second = text.indexOf("\n", first + 1)
    const rule = second < 0 ? "" : text.slice(first + 1, second)
    if (!text.slice(from, first).includes("|") || !rule.includes("|") || !RULE.test(rule)) return undefined
    kind = "table"
    body = at = second + 1
  }
  let live = body
  let blank = false
  while (at < text.length) {
    let end = text.indexOf("\n", at)
    const complete = end >= 0
    if (!complete) end = text.length
    const line = text.slice(at, end)
    if (!line.trim()) blank = true
    else if (blank) return undefined
    else if (complete) {
      if (kind === "table") {
        if (line[0] !== "|") return undefined
        live = end + 1
      } else if (line.charCodeAt(0) > 32) {
        if (itemMark(line) !== mark) return undefined
        live = at
      }
    }
    at = end + 1
  }
  return { kind, head: kind === "table" ? text.slice(from, body) : "", body, live }
}

// ── the reader's selection ──────────────────────────────────────────────────────────────────────

// Asking the selection where it is makes the browser lay the window out first. Right after a
// message wrote its HTML that is a whole layout for each paint, and for each message as a
// conversation opens. So one set of listeners for the window keeps whether anything may be
// selected at all, and a paint asks where only then. A selection about to begin (a drag, Shift
// and an arrow, select all) counts at once, before the browser says what it became, and so does a
// mouse button held down: the first frames of a drag.
let anySelected = false
let pressed = false
let watching = false
function watchSelection(): void {
  if (watching) return
  watching = true
  document.addEventListener("selectionchange", () => {
    const sel = getSelection()
    anySelected = !!sel && !sel.isCollapsed
  })
  document.addEventListener("selectstart", () => (anySelected = true), true)
  addEventListener("pointerdown", () => (pressed = true), true)
  for (const type of ["pointerup", "pointercancel", "blur"]) addEventListener(type, () => (pressed = false), true)
}

// ── the view ────────────────────────────────────────────────────────────────────────────────────

/** A parsed piece, in an element of its own outside the document. */
function parsed(source: string): HTMLDivElement {
  const box = document.createElement("div")
  box.innerHTML = html(source)
  return box
}

/** Where a list or a table keeps its items: the list itself, or the table's body. */
const itemsOf = (el: Element | undefined): Element | undefined =>
  el?.tagName === "TABLE" ? (el as HTMLTableElement).tBodies[0] : el

/** The one element a parsed piece holds, when it is a `tag` and there is nothing else. */
function only(box: Element, tag: string): Element | undefined {
  const el = box.firstElementChild
  if (box.childElementCount !== 1 || el?.tagName !== tag) return undefined
  for (const node of box.childNodes) if (node.nodeType === 3 && node.textContent!.trim()) return undefined
  return el
}

/** The tail's list or table while it is drawn item by item (see splitItems). */
type Items = {
  /** UL, OL or TABLE: a piece joins only when it parses to one of these and nothing else. */
  tag: string
  head: string
  /** Where finished items go: the open list, or the table's body. */
  box: Element
  /** How far into the text the finished items go. */
  at: number
  /** What the live item drew, taken out again before the next frame draws it anew. */
  live: ChildNode[]
}

/** Draws `props.text` into `root`; plain DOM, so a test can drive it frame by frame. `paint`
 *  draws now, `schedule` on the next frame. */
export function markdownView(root: HTMLElement, props: { readonly text: string; readonly streaming: boolean }) {
  watchSelection()
  let tail: HTMLDivElement | undefined
  let code: Text | undefined // set while the tail is an open code fence drawn as plain text
  let codeFrom = 0 // where that fence's content starts in the text
  let items: Items | undefined // set while the tail is a list or a table drawn item by item
  let whole = false // the tail does not split into items: it is parsed whole until it restarts
  let shown = "" // the text the DOM currently reflects
  let done = 0 // how much of it sits in finished, never-again-parsed blocks
  let frame = 0
  let waiting = false // a paint is held back by the reader's selection
  // Marks the end of a reply that is still arriving, so a cut-off sentence reads as "more to come".
  const caret = document.createElement("span")
  caret.className = "md-caret"
  caret.setAttribute("aria-hidden", "true")
  const placeCaret = () => {
    const host = tail?.textContent?.trim() ? tail : (tail?.previousElementSibling ?? null)
    if (host) endOf(host, caret).append(caret)
    else caret.remove()
  }

  /** The reader has text selected in this message: any write here would drop it. */
  const selecting = () => {
    if (!anySelected && !pressed) return false
    const sel = getSelection()
    return !!sel && !sel.isCollapsed && !!sel.anchorNode && root.contains(sel.anchorNode)
  }
  const onSelection = () => {
    if (selecting()) return
    document.removeEventListener("selectionchange", onSelection)
    waiting = false
    schedule()
  }
  /** The tail starts again, empty: nothing of it is a list or a fence yet. */
  const restart = () => {
    code = items = undefined
    whole = false
  }

  /** The open tail when it is not a code fence: item by item when it is a tight list or a table,
   *  otherwise parsed whole. */
  const drawTail = (tail: HTMLDivElement, text: string) => {
    const split = whole ? undefined : splitItems(text, done)
    if (split && split.live > split.body) {
      if (!items) {
        // The first finished items: their list (or table) becomes the tail's and stays open.
        const box = parsed(text.slice(done, split.live))
        const el = only(box, split.kind === "table" ? "TABLE" : (box.firstElementChild?.tagName ?? ""))
        const into = el && /^(UL|OL|TABLE)$/.test(el.tagName) ? itemsOf(el) : undefined
        if (el && into) {
          enhance(box)
          tail.replaceChildren(el)
          items = { tag: el.tagName, head: split.head, box: into, at: split.live, live: [] }
        } else whole = true
      } else if (split.live > items.at) {
        // More finished items: parsed once, alone (rows under their header), and moved in.
        const box = parsed(items.head + text.slice(items.at, split.live))
        const from = itemsOf(only(box, items.tag))
        if (from) {
          enhance(box)
          for (const node of items.live) node.remove()
          items.live = []
          items.box.append(...from.children)
          items.at = split.live
        } else whole = true
      }
    } else if (items) whole = true
    if (whole) items = undefined
    if (!items) {
      tail.innerHTML = html(closeLinks(text.slice(done)))
      return
    }
    // The live item, parsed again each frame. Its items join the open list; anything after it
    // (what the parse made of a line still arriving) follows the list.
    for (const node of items.live) node.remove()
    const live: ChildNode[] = []
    const rest = text.slice(items.at)
    if (rest.trim()) {
      const box = parsed(items.head + closeLinks(rest))
      const first = box.firstElementChild
      if (first?.tagName === items.tag) {
        const add = [...(itemsOf(first)?.children ?? [])]
        items.box.append(...add)
        live.push(...add)
        first.remove()
      }
      const after = [...box.childNodes].filter((node) => node.nodeType === 1 || node.textContent!.trim())
      tail.append(...after)
      live.push(...after)
    }
    items.live = live
  }

  /** `first`: the paint as the message mounts. A node just made cannot hold the selection, and
   *  asking would cost a layout for every message. */
  const paint = (first = false) => {
    frame = 0
    const text = props.text
    if (text === shown && (props.streaming || !tail)) return
    if (!first && selecting()) {
      if (!waiting) document.addEventListener("selectionchange", onSelection)
      waiting = true
      return
    }
    if (!props.streaming) {
      root.innerHTML = html(text)
      enhance(root)
      tail = undefined
      restart()
      done = 0
      shown = text
      return
    }
    // Deltas only append. Anything else (the part was replaced) starts over.
    if (text.length < shown.length || !text.startsWith(shown) || !tail) {
      root.textContent = ""
      tail = root.appendChild(document.createElement("div"))
      restart()
      done = 0
    }
    const { cut, fence } = splitTail(text, done)
    if (cut > done) {
      const block = document.createElement("div")
      block.innerHTML = html(text.slice(done, cut))
      enhance(block)
      root.insertBefore(block, tail)
      done = cut
      restart()
    }
    if (fence) {
      // An open fence: plain text in a <pre>, grown by appending. Parsed for real when it closes.
      if (!code) {
        const lang = /^[`~]+\s*([\w-]+)/.exec(fence)?.[1]
        const box = document.createElement("code")
        if (lang) box.className = `language-${lang}`
        restart()
        code = box.appendChild(document.createTextNode(""))
        codeFrom = done + fence.length
        const pre = document.createElement("pre")
        pre.append(box)
        tail.replaceChildren(pre)
      }
      code.appendData(text.slice(codeFrom + code.length))
    } else {
      code = undefined
      drawTail(tail, text)
    }
    placeCaret()
    shown = text
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => paint())
  }
  const dispose = () => {
    cancelAnimationFrame(frame)
    document.removeEventListener("selectionchange", onSelection)
  }
  return { paint, schedule, dispose }
}

export function Markdown(props: { text: string; streaming: boolean }) {
  let root!: HTMLDivElement
  let view: ReturnType<typeof markdownView> | undefined
  createEffect(() => {
    // Read both so either one changing schedules a paint; the paint reads them again itself.
    void props.text
    void props.streaming
    // The first paint is immediate, so a loaded conversation has its real height at once.
    if (!view) return (view = markdownView(root, props)), view.paint(true)
    view.schedule()
  })
  onCleanup(() => view?.dispose())

  return <div class="md" ref={root} onClick={onCodeClick} />
}
