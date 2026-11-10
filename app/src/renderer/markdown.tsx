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
//   · nothing is written while the reader has text selected in this message; the pending paint
//     runs when the selection goes away
import { createEffect, onCleanup } from "solid-js"
import { Marked } from "marked"
import DOMPurify from "dompurify"
import { copyText } from "./copy"

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
    const copy = button("code-copy", "Copy")
    copy.setAttribute("aria-label", "Copy code")
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
      if (!ok) return
      copy.textContent = "Copied"
      copy.classList.add("copied")
      clearTimeout(Number(copy.dataset.timer))
      copy.dataset.timer = String(
        setTimeout(() => {
          copy.textContent = "Copy"
          copy.classList.remove("copied")
        }, 1500),
      )
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

export function Markdown(props: { text: string; streaming: boolean }) {
  let root!: HTMLDivElement
  let tail: HTMLDivElement | undefined
  let code: Text | undefined // set while the tail is an open code fence drawn as plain text
  let codeFrom = 0 // where that fence's content starts in the text
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
    const sel = getSelection()
    return !!sel && !sel.isCollapsed && !!sel.anchorNode && root.contains(sel.anchorNode)
  }
  const onSelection = () => {
    if (selecting()) return
    document.removeEventListener("selectionchange", onSelection)
    waiting = false
    schedule()
  }

  const paint = () => {
    frame = 0
    const text = props.text
    if (text === shown && (props.streaming || !tail)) return
    if (selecting()) {
      if (!waiting) document.addEventListener("selectionchange", onSelection)
      waiting = true
      return
    }
    if (!props.streaming) {
      root.innerHTML = html(text)
      enhance(root)
      tail = code = undefined
      done = 0
      shown = text
      return
    }
    // Deltas only append. Anything else (the part was replaced) starts over.
    if (text.length < shown.length || !text.startsWith(shown) || !tail) {
      root.textContent = ""
      tail = root.appendChild(document.createElement("div"))
      code = undefined
      done = 0
    }
    const { cut, fence } = splitTail(text, done)
    if (cut > done) {
      const block = document.createElement("div")
      block.innerHTML = html(text.slice(done, cut))
      enhance(block)
      root.insertBefore(block, tail)
      done = cut
      code = undefined
    }
    if (fence) {
      // An open fence: plain text in a <pre>, grown by appending. Parsed for real when it closes.
      if (!code) {
        const lang = /^[`~]+\s*([\w-]+)/.exec(fence)?.[1]
        const box = document.createElement("code")
        if (lang) box.className = `language-${lang}`
        code = box.appendChild(document.createTextNode(""))
        codeFrom = done + fence.length
        const pre = document.createElement("pre")
        pre.append(box)
        tail.replaceChildren(pre)
      }
      code.appendData(text.slice(codeFrom + code.length))
    } else {
      code = undefined
      tail.innerHTML = html(closeLinks(text.slice(done)))
    }
    placeCaret()
    shown = text
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint)
  }

  let mounted = false
  createEffect(() => {
    // Read both so either one changing schedules a paint; the paint reads them again itself.
    void props.text
    void props.streaming
    // The first paint is immediate, so a loaded conversation has its real height at once.
    if (!mounted) return (mounted = true), paint()
    schedule()
  })
  onCleanup(() => {
    cancelAnimationFrame(frame)
    document.removeEventListener("selectionchange", onSelection)
  })

  return <div class="md" ref={root} onClick={onCodeClick} />
}
